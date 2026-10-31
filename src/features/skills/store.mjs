/**
 * Canonical skill repository under `.kusa/skills/`.
 * Agent copies are never treated as the source of truth.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  applyFrontmatterEdits,
  buildSkillMarkdown,
  contentHash,
  emptySkillRecord,
  hashSkillPayload,
  parseSkillMarkdown,
  skillSummary,
} from './model.mjs';
import { validateResourcePath, validateSkillMarkdown } from './validate.mjs';

const REGISTRY_FILE = 'registry.json';
const META_FILE = '.kusa-skill.json';

export function skillsRoot(monitorDir) {
  return join(monitorDir, 'skills');
}

function atomicWriteFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function safeResolveUnder(root, rel) {
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, rel);
  const relToRoot = relative(rootAbs, target);
  if (relToRoot.startsWith('..') || relToRoot.includes(`..${sep}`) || resolve(rootAbs, relToRoot) !== target) {
    const err = new Error(`Path escapes skills root: ${rel}`);
    err.code = 'EPATH';
    throw err;
  }
  return target;
}

function fileHash(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function readRegistry(root) {
  const path = join(root, REGISTRY_FILE);
  if (!existsSync(path)) {
    return { version: 1, seededAtWall: null, skills: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return { version: 1, seededAtWall: null, skills: {} };
    return {
      version: 1,
      seededAtWall: raw.seededAtWall ?? null,
      skills: raw.skills && typeof raw.skills === 'object' ? raw.skills : {},
    };
  } catch {
    return { version: 1, seededAtWall: null, skills: {} };
  }
}

function writeRegistry(root, registry) {
  atomicWriteFile(join(root, REGISTRY_FILE), `${JSON.stringify(registry, null, 2)}\n`);
}

function listResourceFiles(skillDir) {
  const out = [];
  function walk(dir, prefix = '') {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === 'SKILL.md' || name === META_FILE || name === REGISTRY_FILE) continue;
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) {
        const buf = readFileSync(abs);
        out.push({
          rel: rel.replace(/\\/g, '/'),
          size: st.size,
          hash: fileHash(buf),
          contentBase64: buf.toString('base64'),
        });
      }
    }
  }
  walk(skillDir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function loadMeta(skillDir) {
  const path = join(skillDir, META_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeMeta(skillDir, meta) {
  atomicWriteFile(join(skillDir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
}

export function ensureSkillsStore(monitorDir) {
  const root = skillsRoot(monitorDir);
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, REGISTRY_FILE))) {
    writeRegistry(root, { version: 1, seededAtWall: null, skills: {} });
  }
  return root;
}

export function readSkill(monitorDir, id) {
  const root = skillsRoot(monitorDir);
  const skillDir = safeResolveUnder(root, id);
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    const err = new Error(`Skill not found: ${id}`);
    err.code = 'ENOENT';
    throw err;
  }
  const skillMd = readFileSync(skillMdPath, 'utf8');
  const parsed = parseSkillMarkdown(skillMd);
  const resources = listResourceFiles(skillDir);
  const meta = loadMeta(skillDir);
  const registry = readRegistry(root);
  const reg = registry.skills[id] || {};
  const hash = hashSkillPayload({
    skillMd,
    resources: resources.map((r) => ({ rel: r.rel, hash: r.hash })),
  });
  const validation = validateSkillMarkdown(skillMd, { directoryName: id });
  const record = emptySkillRecord({
    id,
    name: parsed.frontmatter?.name || id,
    description: parsed.frontmatter?.description || '',
    category: meta.category || reg.category || 'general',
    frontmatter: parsed.frontmatter || {},
    body: parsed.body || '',
    skillMd,
    resources: resources.map(({ rel, size, hash: h }) => ({ rel, size, hash: h })),
    contentHash: hash,
    createdAtWall: meta.createdAtWall || reg.createdAtWall || null,
    updatedAtWall: meta.updatedAtWall || reg.updatedAtWall || null,
    starterId: meta.starterId ?? reg.starterId ?? null,
    starterCustomized: Boolean(meta.starterCustomized ?? reg.starterCustomized),
    publications: meta.publications || reg.publications || {},
    validation: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
    },
  });
  // Attach content for API consumers that need resource bodies (optional, large).
  record._resourcesFull = resources;
  return record;
}

export function listSkills(monitorDir) {
  const root = ensureSkillsStore(monitorDir);
  const registry = readRegistry(root);
  const ids = new Set([
    ...Object.keys(registry.skills),
    ...readdirSync(root).filter((name) => {
      if (name === REGISTRY_FILE || name.startsWith('.')) return false;
      try {
        return statSync(join(root, name)).isDirectory() && existsSync(join(root, name, 'SKILL.md'));
      } catch {
        return false;
      }
    }),
  ]);
  const skills = [];
  for (const id of [...ids].sort()) {
    try {
      skills.push(skillSummary(readSkill(monitorDir, id)));
    } catch {
      /* skip broken */
    }
  }
  return { skills, seededAtWall: registry.seededAtWall };
}

function persistSkillDir(skillDir, { skillMd, resources = [], meta }) {
  mkdirSync(skillDir, { recursive: true });
  atomicWriteFile(join(skillDir, 'SKILL.md'), skillMd.endsWith('\n') ? skillMd : `${skillMd}\n`);

  // Remove resources not present in the new set (only under known relative paths).
  const keep = new Set(resources.map((r) => r.rel.replace(/\\/g, '/')));
  function prune(dir, prefix = '') {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!prefix && (name === 'SKILL.md' || name === META_FILE)) continue;
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) {
        prune(abs, rel);
        try {
          if (!readdirSync(abs).length) rmSync(abs, { recursive: true, force: true });
        } catch { /* ignore */ }
      } else if (!keep.has(rel.replace(/\\/g, '/'))) {
        rmSync(abs, { force: true });
      }
    }
  }
  prune(skillDir);

  for (const res of resources) {
    const check = validateResourcePath(res.rel);
    if (!check.ok) {
      const err = new Error(check.errors.join('; '));
      err.code = 'EINVAL';
      throw err;
    }
    const abs = safeResolveUnder(skillDir, check.path);
    mkdirSync(dirname(abs), { recursive: true });
    let buf;
    if (res.contentBase64 != null) buf = Buffer.from(res.contentBase64, 'base64');
    else if (res.content != null) buf = Buffer.from(String(res.content), 'utf8');
    else if (res.sourcePath) {
      copyFileSync(res.sourcePath, abs);
      continue;
    } else continue;
    atomicWriteFile(abs, buf);
  }

  writeMeta(skillDir, meta);
}

function syncRegistryEntry(root, id, meta, contentHash) {
  const registry = readRegistry(root);
  registry.skills[id] = {
    id,
    name: meta.name || id,
    description: meta.description || '',
    category: meta.category || 'general',
    contentHash,
    createdAtWall: meta.createdAtWall,
    updatedAtWall: meta.updatedAtWall,
    starterId: meta.starterId ?? null,
    starterCustomized: Boolean(meta.starterCustomized),
    publications: meta.publications || {},
  };
  writeRegistry(root, registry);
}

export function createSkill(monitorDir, input = {}) {
  const root = ensureSkillsStore(monitorDir);
  let name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  const body = String(input.body || '# Instructions\n\n');
  const category = String(input.category || 'general').trim() || 'general';

  let skillMd;
  let frontmatter;
  if (input.skillMd) {
    skillMd = String(input.skillMd);
    const validation = validateSkillMarkdown(skillMd);
    if (!validation.ok) {
      const err = new Error(validation.errors.join('; '));
      err.code = 'EINVAL';
      err.validation = validation;
      throw err;
    }
    name = String(validation.parsed.frontmatter.name).trim();
    frontmatter = validation.parsed.frontmatter;
  } else {
    frontmatter = applyFrontmatterEdits({}, {
      name,
      description,
      ...(input.frontmatter || {}),
    });
    skillMd = buildSkillMarkdown(frontmatter, body);
    const validation = validateSkillMarkdown(skillMd, {
      directoryName: name,
      existingNames: listSkills(monitorDir).skills.map((s) => s.name),
    });
    if (!validation.ok) {
      const err = new Error(validation.errors.join('; '));
      err.code = 'EINVAL';
      err.validation = validation;
      throw err;
    }
  }

  if (existsSync(join(root, name, 'SKILL.md'))) {
    const err = new Error(`Skill already exists: ${name}`);
    err.code = 'EEXIST';
    throw err;
  }

  const now = Date.now();
  const resources = input.resources || [];
  const hash = hashSkillPayload({
    skillMd,
    resources: resources.map((r) => ({
      rel: r.rel,
      hash: r.hash || contentHash([r.contentBase64 || r.content || '']),
    })),
  });
  const meta = {
    name,
    description: frontmatter.description || description,
    category,
    createdAtWall: now,
    updatedAtWall: now,
    starterId: input.starterId ?? null,
    starterCustomized: Boolean(input.starterCustomized),
    publications: {},
  };
  persistSkillDir(join(root, name), { skillMd, resources, meta });
  syncRegistryEntry(root, name, meta, hash);
  return readSkill(monitorDir, name);
}

export function updateSkill(monitorDir, id, patch = {}) {
  const root = skillsRoot(monitorDir);
  const current = readSkill(monitorDir, id);
  const skillDir = safeResolveUnder(root, id);

  let skillMd = current.skillMd;
  let frontmatter = { ...current.frontmatter };
  let body = current.body;

  if (patch.skillMd != null) {
    skillMd = String(patch.skillMd);
    const parsed = parseSkillMarkdown(skillMd);
    if (!parsed.ok) {
      const err = new Error(parsed.error);
      err.code = 'EINVAL';
      throw err;
    }
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } else {
    if (patch.frontmatter) {
      frontmatter = applyFrontmatterEdits(frontmatter, patch.frontmatter);
    }
    if (patch.name != null) frontmatter = applyFrontmatterEdits(frontmatter, { name: patch.name });
    if (patch.description != null) {
      frontmatter = applyFrontmatterEdits(frontmatter, { description: patch.description });
    }
    if (patch.body != null) body = String(patch.body);
    skillMd = buildSkillMarkdown(frontmatter, body);
  }

  const newName = String(frontmatter.name || id).trim();
  const validation = validateSkillMarkdown(skillMd, {
    directoryName: newName === id ? id : newName,
    existingNames: listSkills(monitorDir).skills.filter((s) => s.id !== id).map((s) => s.name),
  });
  if (!validation.ok) {
    const err = new Error(validation.errors.join('; '));
    err.code = 'EINVAL';
    err.validation = validation;
    throw err;
  }

  // Rename directory if name changed.
  let targetId = id;
  let targetDir = skillDir;
  if (newName !== id) {
    targetDir = safeResolveUnder(root, newName);
    if (existsSync(join(targetDir, 'SKILL.md'))) {
      const err = new Error(`Skill already exists: ${newName}`);
      err.code = 'EEXIST';
      throw err;
    }
    renameSync(skillDir, targetDir);
    targetId = newName;
    const registry = readRegistry(root);
    delete registry.skills[id];
    writeRegistry(root, registry);
  }

  const resources = patch.resources !== undefined ? patch.resources : (current._resourcesFull || []);
  const now = Date.now();
  const starterCustomized = current.starterId
    ? (patch.starterCustomized !== undefined ? Boolean(patch.starterCustomized) : true)
    : Boolean(current.starterCustomized);

  const meta = {
    name: newName,
    description: String(frontmatter.description || ''),
    category: patch.category != null ? String(patch.category) : current.category,
    createdAtWall: current.createdAtWall || now,
    updatedAtWall: now,
    starterId: current.starterId,
    starterCustomized,
    publications: current.publications || {},
  };

  const hash = hashSkillPayload({
    skillMd,
    resources: resources.map((r) => ({
      rel: r.rel,
      hash: r.hash || contentHash([r.contentBase64 || r.content || '']),
    })),
  });
  persistSkillDir(targetDir, { skillMd, resources, meta });
  syncRegistryEntry(root, targetId, meta, hash);
  return readSkill(monitorDir, targetId);
}

export function deleteSkill(monitorDir, id) {
  const root = skillsRoot(monitorDir);
  const skillDir = safeResolveUnder(root, id);
  if (!existsSync(join(skillDir, 'SKILL.md'))) {
    const err = new Error(`Skill not found: ${id}`);
    err.code = 'ENOENT';
    throw err;
  }
  rmSync(skillDir, { recursive: true, force: true });
  const registry = readRegistry(root);
  delete registry.skills[id];
  writeRegistry(root, registry);
  return { deleted: id };
}

export function duplicateSkill(monitorDir, id, { name } = {}) {
  const current = readSkill(monitorDir, id);
  const base = name || `${current.name}-copy`;
  let candidate = base;
  let n = 2;
  const existing = new Set(listSkills(monitorDir).skills.map((s) => s.id));
  while (existing.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  const frontmatter = applyFrontmatterEdits(current.frontmatter, { name: candidate });
  const skillMd = buildSkillMarkdown(frontmatter, current.body);
  return createSkill(monitorDir, {
    skillMd,
    resources: current._resourcesFull || [],
    category: current.category,
    starterId: null,
    starterCustomized: false,
  });
}

export function updatePublications(monitorDir, id, publicationsPatch) {
  const root = skillsRoot(monitorDir);
  const record = readSkill(monitorDir, id);
  const skillDir = safeResolveUnder(root, id);
  const meta = loadMeta(skillDir);
  const publications = { ...(meta.publications || record.publications || {}) };
  for (const [key, value] of Object.entries(publicationsPatch || {})) {
    if (value == null) delete publications[key];
    else publications[key] = { ...(publications[key] || {}), ...value };
  }
  const nextMeta = {
    name: record.name,
    description: record.description,
    category: record.category,
    createdAtWall: record.createdAtWall,
    updatedAtWall: record.updatedAtWall,
    starterId: record.starterId,
    starterCustomized: record.starterCustomized,
    publications,
  };
  writeMeta(skillDir, nextMeta);
  syncRegistryEntry(root, id, nextMeta, record.contentHash);
  return readSkill(monitorDir, id);
}

export function markRegistrySeeded(monitorDir, atWall = Date.now()) {
  const root = ensureSkillsStore(monitorDir);
  const registry = readRegistry(root);
  registry.seededAtWall = atWall;
  writeRegistry(root, registry);
  return registry;
}

export function getRegistry(monitorDir) {
  return readRegistry(ensureSkillsStore(monitorDir));
}

export function skillDirPath(monitorDir, id) {
  return safeResolveUnder(skillsRoot(monitorDir), id);
}

export { safeResolveUnder, atomicWriteFile, fileHash };
