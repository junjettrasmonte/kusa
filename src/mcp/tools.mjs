/**
 * Tool handlers for the Kusă MCP server. Built-ins + user-defined custom tools.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultMonitorDir } from '../lib.mjs';
import { ensureSkillsInitialized, listSkills, readSkill } from '../skills/index.mjs';
import { addLearning, listLearnings } from './learnings.mjs';
import { loadMcpState } from './config.mjs';
import { createFileTools } from '../agent/files.mjs';
import { TOOL_CATALOG } from './catalog.mjs';
import {
  advertisedCustomTools,
  isBuiltinToolName,
  runCustomTool,
} from './custom-tools.mjs';

export { TOOL_CATALOG, defaultToolFlags } from './catalog.mjs';

const FILE_TOOL_NAMES = new Set([
  'kusa_read_file',
  'kusa_write_file',
  'kusa_list_dir',
  'kusa_grep',
  'kusa_delete_file',
]);

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { text, isError };
}

/** Prefer the explicit workspace root (MCP cwd) over KUSA_WORKSPACE env. */
function resolveDirs(cwd = process.cwd()) {
  const workspaceRoot = resolve(cwd);
  const dataDir = defaultMonitorDir(workspaceRoot);
  return { workspaceRoot, dataDir };
}

function getSessionSummary(dataDir) {
  const indexPath = join(dataDir, 'index.json');
  if (!existsSync(indexPath)) {
    return { focus: null, message: 'No monitor data yet under .kusa/' };
  }
  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return { focus: null, message: 'Could not parse .kusa/index.json' };
  }
  const focus = index.focus || null;
  if (!focus) return { focus: null, message: 'No focused session' };
  const rel = index.sessionFiles?.[focus];
  if (!rel) return { focus, message: 'Focus set but session file missing', session: null };
  const sessionPath = join(dataDir, rel);
  if (!existsSync(sessionPath)) {
    return { focus, message: 'Session file not found', session: null };
  }
  try {
    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    return {
      focus,
      session: {
        id: session.id || session.sessionId || focus,
        harness: session.harness,
        status: session.status,
        intent: session.intent || session.currentIntent || null,
        tools: session.totals || session.toolsSummary || null,
        promptCount: Array.isArray(session.prompts) ? session.prompts.length : null,
        warningCount: Array.isArray(session.warnings) ? session.warnings.length : null,
      },
    };
  } catch {
    return { focus, message: 'Could not parse session file', session: null };
  }
}

export function advertisedTools(monitorDir) {
  const state = loadMcpState(monitorDir);
  const builtins = TOOL_CATALOG.filter((t) => state.tools[t.name] !== false);
  const custom = advertisedCustomTools(monitorDir);
  return [...builtins, ...custom];
}

export async function callTool(name, args = {}, cwd = process.cwd()) {
  const { workspaceRoot, dataDir } = resolveDirs(cwd);
  try {
    if (!isBuiltinToolName(name)) {
      return runCustomTool(dataDir, name, args);
    }
    switch (name) {
      case 'kusa_list_skills': {
        ensureSkillsInitialized(dataDir);
        const { skills } = listSkills(dataDir);
        return textResult({
          skills: skills.map((s) => ({
            id: s.id || s.name,
            name: s.name,
            description: s.description,
            category: s.category,
            publicationStatus: s.publicationStatus,
          })),
        });
      }
      case 'kusa_get_skill': {
        const id = String(args.id || '').trim();
        if (!id) return textResult({ error: 'id is required' }, true);
        ensureSkillsInitialized(dataDir);
        const skill = readSkill(dataDir, id);
        return textResult({
          id: skill.id || skill.name,
          name: skill.name,
          description: skill.description,
          category: skill.category,
          skillMd: skill.skillMd,
          body: skill.body,
          publicationStatus: skill.publicationStatus,
        });
      }
      case 'kusa_list_learnings': {
        return textResult(listLearnings(workspaceRoot, { personal: Boolean(args.personal) }));
      }
      case 'kusa_add_learning': {
        const result = addLearning(workspaceRoot, {
          title: args.title,
          body: args.body,
          personal: Boolean(args.personal),
        });
        return textResult(result);
      }
      case 'kusa_get_session': {
        return textResult(getSessionSummary(dataDir));
      }
      case 'kusa_read_file':
      case 'kusa_write_file':
      case 'kusa_list_dir':
      case 'kusa_grep':
      case 'kusa_delete_file': {
        if (!FILE_TOOL_NAMES.has(name)) {
          return textResult({ error: `unknown tool: ${name}` }, true);
        }
        const files = createFileTools(workspaceRoot);
        const result = await files.call(name, args);
        return textResult(result, result?.ok === false);
      }
      default:
        return textResult({ error: `unknown tool: ${name}` }, true);
    }
  } catch (err) {
    return textResult({ error: err?.message || String(err) }, true);
  }
}
