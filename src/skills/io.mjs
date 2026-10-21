/**
 * Import / export skill directories with path-traversal protection.
 * Imported scripts are never executed.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createSkill, readSkill, updateSkill } from './store.mjs';
import { validateImportRoot, validateResourcePath, validateSkillMarkdown } from './validate.mjs';
import { parseSkillMarkdown } from './model.mjs';
import { fileHash } from './store.mjs';

function assertUnder(root, target) {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(rootAbs, rel) !== targetAbs) {
    const err = new Error('Path escapes authorized directory');
    err.code = 'EPATH';
    throw err;
  }
  return targetAbs;
}

function collectDirFiles(dir) {
  const files = [];
  function walk(current, prefix = '') {
    for (const name of readdirSync(current)) {
      if (name.startsWith('.')) continue;
      const abs = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) {
        const buf = readFileSync(abs);
        files.push({
          rel: rel.replace(/\\/g, '/'),
          contentBase64: buf.toString('base64'),
          hash: fileHash(buf),
          size: st.size,
        });
      }
    }
  }
  walk(dir);
  return files;
}

/**
 * Import from an on-disk skill directory (must contain SKILL.md).
 */
export function importSkillFromDirectory(monitorDir, sourceDir, { overwrite = false } = {}) {
  const abs = resolve(sourceDir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    const err = new Error(`Import path is not a directory: ${sourceDir}`);
    err.code = 'ENOENT';
    throw err;
  }
  const skillMdPath = join(abs, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    const err = new Error('Imported skill must include SKILL.md');
    err.code = 'EINVAL';
    throw err;
  }

  const files = collectDirFiles(abs);
  const check = validateImportRoot(files);
  if (!check.ok) {
    const err = new Error(check.errors.join('; '));
    err.code = 'EINVAL';
    err.validation = check;
    throw err;
  }

  const skillMd = readFileSync(skillMdPath, 'utf8');
  const validation = validateSkillMarkdown(skillMd);
  if (!validation.ok) {
    const err = new Error(validation.errors.join('; '));
    err.code = 'EINVAL';
    err.validation = validation;
    throw err;
  }

  const name = String(validation.parsed.frontmatter.name).trim();
  const resources = files
    .filter((f) => f.rel !== 'SKILL.md')
    .map((f) => {
      const v = validateResourcePath(f.rel);
      if (!v.ok) {
        const err = new Error(`${f.rel}: ${v.errors.join('; ')}`);
        err.code = 'EPATH';
        throw err;
      }
      return f;
    });

  try {
    return createSkill(monitorDir, { skillMd, resources, category: 'imported' });
  } catch (err) {
    if (err.code === 'EEXIST' && overwrite) {
      return updateSkill(monitorDir, name, { skillMd, resources });
    }
    throw err;
  }
}

/**
 * Import from an in-memory file list (API / UI paste).
 * @param {{ rel: string, content?: string, contentBase64?: string }[]} files
 */
export function importSkillFromFiles(monitorDir, files, { overwrite = false } = {}) {
  const normalized = [];
  for (const file of files || []) {
    const rel = String(file.rel || '').replace(/\\/g, '/');
    if (rel !== 'SKILL.md') {
      const v = validateResourcePath(rel);
      if (!v.ok) {
        const err = new Error(`${rel}: ${v.errors.join('; ')}`);
        err.code = 'EPATH';
        throw err;
      }
    } else if (rel.includes('..')) {
      const err = new Error('Invalid SKILL.md path');
      err.code = 'EPATH';
      throw err;
    }
    let contentBase64 = file.contentBase64;
    if (contentBase64 == null && file.content != null) {
      contentBase64 = Buffer.from(String(file.content), 'utf8').toString('base64');
    }
    if (contentBase64 == null) {
      const err = new Error(`Missing content for ${rel}`);
      err.code = 'EINVAL';
      throw err;
    }
    normalized.push({
      rel,
      contentBase64,
      hash: fileHash(Buffer.from(contentBase64, 'base64')),
    });
  }

  const check = validateImportRoot(normalized);
  if (!check.ok) {
    const err = new Error(check.errors.join('; '));
    err.code = 'EINVAL';
    err.validation = check;
    throw err;
  }

  const skillEntry = normalized.find((f) => f.rel === 'SKILL.md');
  const skillMd = Buffer.from(skillEntry.contentBase64, 'base64').toString('utf8');
  const validation = validateSkillMarkdown(skillMd);
  if (!validation.ok) {
    const err = new Error(validation.errors.join('; '));
    err.code = 'EINVAL';
    err.validation = validation;
    throw err;
  }

  const name = String(validation.parsed.frontmatter.name).trim();
  const resources = normalized.filter((f) => f.rel !== 'SKILL.md');
  try {
    return createSkill(monitorDir, { skillMd, resources, category: 'imported' });
  } catch (err) {
    if (err.code === 'EEXIST' && overwrite) {
      return updateSkill(monitorDir, name, { skillMd, resources });
    }
    throw err;
  }
}

/**
 * Export a skill into a destination directory as `<name>/SKILL.md` + resources.
 */
export function exportSkillToDirectory(monitorDir, skillId, destParentDir) {
  const record = readSkill(monitorDir, skillId);
  const parent = resolve(destParentDir);
  mkdirSync(parent, { recursive: true });
  const outDir = join(parent, record.name);
  assertUnder(parent, outDir);
  mkdirSync(outDir, { recursive: true });

  const skillMd = record.skillMd.endsWith('\n') ? record.skillMd : `${record.skillMd}\n`;
  writeFileSync(join(outDir, 'SKILL.md'), skillMd, { mode: 0o600 });

  for (const res of record._resourcesFull || []) {
    const v = validateResourcePath(res.rel);
    if (!v.ok) continue;
    const abs = assertUnder(outDir, join(outDir, v.path));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(res.contentBase64, 'base64'), { mode: 0o600 });
  }

  return {
    path: outDir,
    name: record.name,
    files: ['SKILL.md', ...(record.resources || []).map((r) => r.rel)],
  };
}

/**
 * Export as an in-memory file list for download / sharing.
 */
export function exportSkillFiles(monitorDir, skillId) {
  const record = readSkill(monitorDir, skillId);
  const skillMd = record.skillMd.endsWith('\n') ? record.skillMd : `${record.skillMd}\n`;
  const files = [
    {
      rel: 'SKILL.md',
      content: skillMd,
      contentBase64: Buffer.from(skillMd, 'utf8').toString('base64'),
    },
  ];
  for (const res of record._resourcesFull || []) {
    files.push({
      rel: res.rel,
      contentBase64: res.contentBase64,
      content: undefined,
    });
  }
  return {
    name: record.name,
    description: record.description,
    files,
  };
}

export function parseImportedSkillMd(skillMd) {
  return parseSkillMarkdown(skillMd);
}
