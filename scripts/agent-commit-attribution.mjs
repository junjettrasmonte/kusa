#!/usr/bin/env node
/**
 * Strip / reject Cursor and GitHub Copilot git attribution.
 *
 *   filter <commit-msg-file>   Rewrite message in place (fail-safe: never empties a commit)
 *   check-identity             Exit 1 if author/committer looks like an automated agent
 *
 * Used by .githooks/commit-msg and .githooks/pre-commit.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact / near-exact agent display names (case-insensitive). */
const AGENT_NAME =
  /^(cursor(\s+agent)?|github\s*copilot|copilot(\s+(agent|swe(\s*agent)?))?)$/i;

/** @param {string} name @param {string} email */
export function isAgentIdentity(name, email) {
  const n = String(name || '').trim();
  const e = String(email || '').trim();
  if (n && AGENT_NAME.test(n)) return true;
  if (!e) return false;
  // Human GitHub noreply is fine unless the local-part or name says Copilot/Cursor Agent
  if (/@users\.noreply\.github\.com$/i.test(e) && !/copilot/i.test(e) && !AGENT_NAME.test(n)) {
    return false;
  }
  if (/cursoragent@/i.test(e) || /copilot/i.test(e)) return true;
  if (/\bcursor\s*agent\b/i.test(n) || /\bgithub\s*copilot\b/i.test(n)) return true;
  return false;
}

/** @param {string} line */
export function isAgentCoAuthorTrailer(line) {
  const m = String(line).match(/^Co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/i);
  if (!m) {
    // Line-start agent stamps only (do not strip quoted examples in the body)
    if (/^(Made-with|Generated-by):\s*Cursor\b/i.test(line)) return true;
    return false;
  }
  return isAgentIdentity(m[1], m[2]);
}

/** @param {string} text */
export function filterCommitMessage(text) {
  const lines = String(text).split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (isAgentCoAuthorTrailer(line)) continue;
    kept.push(line);
  }
  // Collapse runs of blank lines to a single blank; drop leading/trailing blanks
  const out = [];
  let blank = false;
  for (const line of kept) {
    if (line.trim() === '') {
      if (out.length === 0) continue;
      blank = true;
      continue;
    }
    if (blank) {
      out.push('');
      blank = false;
    }
    out.push(line);
  }
  let result = out.join('\n');
  if (result.length && !result.endsWith('\n')) result += '\n';
  return result;
}

/** First non-empty, non-comment line — used as a fail-safe subject check. */
export function subjectLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    return line.trim();
  }
  return '';
}

export function filterCommitMessageFile(path) {
  let original;
  try {
    original = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
  let filtered;
  try {
    filtered = filterCommitMessage(original);
  } catch {
    return { ok: false, reason: 'filter-failed' };
  }
  // Never replace with an empty/subject-less message if the original had a subject
  if (subjectLine(original) && !subjectLine(filtered)) {
    return { ok: false, reason: 'would-empty-subject', original };
  }
  try {
    writeFileSync(path, filtered, 'utf8');
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true, filtered };
}

function parseIdent(raw) {
  // "Name <email> timestamp tz"
  const m = String(raw || '').match(/^(.*?)\s*<([^>]+)>/);
  if (!m) return { name: '', email: '' };
  return { name: m[1].trim(), email: m[2].trim() };
}

function gitVar(name) {
  const r = spawnSync('git', ['var', name], { encoding: 'utf8' });
  if (r.status !== 0) return '';
  return (r.stdout || '').trim();
}

export function checkAgentGitIdentity() {
  if (process.env.SKIP_AGENT_ATTRIBUTION_CHECK) {
    return { blocked: false, skipped: true };
  }
  const author = parseIdent(gitVar('GIT_AUTHOR_IDENT'));
  const committer = parseIdent(gitVar('GIT_COMMITTER_IDENT'));
  const hits = [];
  if (isAgentIdentity(author.name, author.email)) {
    hits.push(`author ${author.name} <${author.email}>`);
  }
  if (isAgentIdentity(committer.name, committer.email)) {
    hits.push(`committer ${committer.name} <${committer.email}>`);
  }
  if (!hits.length) return { blocked: false, hits };
  return {
    blocked: true,
    hits,
    message:
      `kusa: refusing commit — automated agent identity detected (${hits.join('; ')}).\n`
      + 'Set a human user.name / user.email (or unset GIT_AUTHOR_* / GIT_COMMITTER_*),\n'
      + 'or SKIP_AGENT_ATTRIBUTION_CHECK=1 to bypass.',
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'filter') {
    const file = rest[0];
    if (!file) process.exit(0);
    filterCommitMessageFile(file);
    process.exit(0);
  }
  if (cmd === 'check-identity') {
    const result = checkAgentGitIdentity();
    if (result.blocked) {
      console.error(result.message);
      process.exit(1);
    }
    process.exit(0);
  }
  console.error('Usage: agent-commit-attribution.mjs filter <file> | check-identity');
  process.exit(2);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2));
}
