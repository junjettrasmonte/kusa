/**
 * Agent Skills model: SKILL.md frontmatter + Markdown body.
 * Preserves unknown frontmatter fields when round-tripping form edits.
 */
import { createHash } from 'node:crypto';

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LEN = 64;
export const RESOURCE_DIRS = ['scripts', 'references', 'assets'];

/**
 * Minimal YAML subset for Agent Skills frontmatter (scalars, lists, shallow maps).
 * Unknown / complex values are kept via line-oriented extras when possible.
 */
export function parseYamlFrontmatter(block) {
  const result = {};
  const lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  function parseScalar(raw) {
    const t = raw.trim();
    if (t === '') return '';
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || t === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    return t;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const rest = m[2];
    if (rest === '|' || rest === '>') {
      const folded = rest === '>';
      const chunks = [];
      i += 1;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].startsWith('\t') || lines[i] === '')) {
        const chunk = lines[i].startsWith('  ') ? lines[i].slice(2) : lines[i].startsWith('\t') ? lines[i].slice(1) : '';
        chunks.push(chunk);
        i += 1;
      }
      result[key] = folded ? chunks.join(' ').replace(/\s+/g, ' ').trim() : chunks.join('\n').replace(/\n+$/, '');
      continue;
    }
    if (rest === '') {
      // list or nested map
      i += 1;
      const list = [];
      const map = {};
      let mode = null;
      while (i < lines.length) {
        const nested = lines[i];
        if (!nested.trim()) {
          i += 1;
          continue;
        }
        if (/^[A-Za-z0-9_-]+\s*:/.test(nested) && !nested.startsWith(' ') && !nested.startsWith('\t')) break;
        const listItem = nested.match(/^\s*-\s+(.*)$/);
        if (listItem) {
          mode = 'list';
          list.push(parseScalar(listItem[1]));
          i += 1;
          continue;
        }
        const mapItem = nested.match(/^\s{2,}([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (mapItem) {
          mode = 'map';
          map[mapItem[1]] = parseScalar(mapItem[2]);
          i += 1;
          continue;
        }
        break;
      }
      if (mode === 'list') result[key] = list;
      else if (mode === 'map') result[key] = map;
      else result[key] = '';
      continue;
    }
    result[key] = parseScalar(rest);
    i += 1;
  }
  return result;
}

export function serializeYamlFrontmatter(fields) {
  const lines = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    if (value === null) {
      lines.push(`${key}: null`);
      continue;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.length) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) {
        const s = String(item);
        lines.push(s.includes('\n') || /[:#]/.test(s) ? `  - ${JSON.stringify(s)}` : `  - ${s}`);
      }
      continue;
    }
    if (typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === 'string' && (v.includes('\n') || /[:#]/.test(v))) {
          lines.push(`  ${k}: ${JSON.stringify(v)}`);
        } else if (typeof v === 'boolean' || typeof v === 'number' || v === null) {
          lines.push(`  ${k}: ${v}`);
        } else {
          lines.push(`  ${k}: ${v}`);
        }
      }
      continue;
    }
    const s = String(value);
    if (s.includes('\n')) {
      lines.push(`${key}: |`);
      for (const row of s.split('\n')) lines.push(`  ${row}`);
    } else if (s === '' || /[:#]/.test(s) || /^\s|\s$/.test(s)) {
      lines.push(`${key}: ${JSON.stringify(s)}`);
    } else {
      lines.push(`${key}: ${s}`);
    }
  }
  return lines.join('\n');
}

export function parseSkillMarkdown(text) {
  const raw = String(text ?? '');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      ok: false,
      error: 'Missing YAML frontmatter (expected --- ... ---)',
      frontmatter: {},
      body: raw,
      raw,
    };
  }
  try {
    const frontmatter = parseYamlFrontmatter(match[1]);
    return {
      ok: true,
      error: null,
      frontmatter,
      body: match[2].replace(/^\r?\n/, ''),
      raw,
      frontmatterRaw: match[1],
    };
  } catch (err) {
    return {
      ok: false,
      error: `Malformed YAML frontmatter: ${err?.message || err}`,
      frontmatter: {},
      body: match[2] || '',
      raw,
    };
  }
}

export function buildSkillMarkdown(frontmatter, body) {
  const yaml = serializeYamlFrontmatter(frontmatter);
  const md = String(body ?? '').replace(/^\r?\n/, '');
  return `---\n${yaml}\n---\n\n${md.replace(/^\n+/, '')}`.replace(/\n+$/, '\n');
}

/** Merge form edits into existing frontmatter without dropping unknown keys. */
export function applyFrontmatterEdits(existing, edits = {}) {
  const next = { ...(existing && typeof existing === 'object' ? existing : {}) };
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) continue;
    if (value === null || value === '') {
      delete next[key];
      continue;
    }
    next[key] = value;
  }
  // Keep name/description first for readability.
  const ordered = {};
  if (next.name !== undefined) ordered.name = next.name;
  if (next.description !== undefined) ordered.description = next.description;
  for (const [k, v] of Object.entries(next)) {
    if (k === 'name' || k === 'description') continue;
    ordered[k] = v;
  }
  return ordered;
}

export function contentHash(parts) {
  const h = createHash('sha256');
  for (const part of parts) {
    h.update(String(part ?? ''));
    h.update('\0');
  }
  return h.digest('hex');
}

export function hashSkillPayload({ skillMd, resources = [] }) {
  const sorted = [...resources].sort((a, b) => a.rel.localeCompare(b.rel));
  return contentHash([
    skillMd,
    ...sorted.flatMap((r) => [r.rel, r.hash || r.content || '']),
  ]);
}

export function normalizeSkillName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SKILL_NAME_LEN);
}

export function emptySkillRecord(overrides = {}) {
  const now = Date.now();
  return {
    id: '',
    name: '',
    description: '',
    category: 'general',
    frontmatter: {},
    body: '',
    skillMd: '',
    resources: [],
    contentHash: '',
    createdAtWall: now,
    updatedAtWall: now,
    starterId: null,
    starterCustomized: false,
    publications: {},
    ...overrides,
  };
}

export function skillSummary(record) {
  const pubs = Object.values(record.publications || {});
  const published = pubs.some((p) => p.status === 'published');
  const diverged = pubs.some((p) => p.status === 'diverged');
  const failed = pubs.some((p) => p.status === 'failed');
  let publicationStatus = 'unpublished';
  if (diverged) publicationStatus = 'diverged';
  else if (failed && published) publicationStatus = 'partial';
  else if (failed) publicationStatus = 'failed';
  else if (published) publicationStatus = 'published';

  return {
    id: record.id,
    name: record.name,
    description: record.description,
    category: record.category || 'general',
    contentHash: record.contentHash,
    createdAtWall: record.createdAtWall,
    updatedAtWall: record.updatedAtWall,
    starterId: record.starterId || null,
    starterCustomized: Boolean(record.starterCustomized),
    publicationStatus,
    publications: record.publications || {},
    resourceCount: (record.resources || []).length,
    validation: record.validation || null,
  };
}
