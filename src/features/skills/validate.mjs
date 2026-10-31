import { parseSkillMarkdown, SKILL_NAME_RE, MAX_SKILL_NAME_LEN } from './model.mjs';

/**
 * Validate a skill name / directory / SKILL.md payload.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], parsed?: object }}
 */
export function validateSkillName(name, { directoryName = null } = {}) {
  const errors = [];
  const warnings = [];
  const n = String(name || '').trim();
  if (!n) errors.push('Skill name is required');
  else if (n.length > MAX_SKILL_NAME_LEN) errors.push(`Skill name must be ≤${MAX_SKILL_NAME_LEN} characters`);
  else if (!SKILL_NAME_RE.test(n)) {
    errors.push('Skill name must use lowercase letters, numbers, and hyphens only');
  }
  if (directoryName != null && n && directoryName !== n) {
    errors.push(`Skill name "${n}" must match its directory name "${directoryName}"`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function validateSkillMarkdown(text, { directoryName = null, existingNames = [] } = {}) {
  const errors = [];
  const warnings = [];
  const parsed = parseSkillMarkdown(text);
  if (!parsed.ok) {
    errors.push(parsed.error || 'Invalid SKILL.md');
    return { ok: false, errors, warnings, parsed };
  }
  const fm = parsed.frontmatter || {};
  if (fm.name == null || String(fm.name).trim() === '') {
    errors.push('Frontmatter "name" is required');
  } else {
    const nameCheck = validateSkillName(fm.name, { directoryName });
    errors.push(...nameCheck.errors);
    warnings.push(...nameCheck.warnings);
  }
  if (fm.description == null || String(fm.description).trim() === '') {
    errors.push('Frontmatter "description" is required');
  } else if (String(fm.description).trim().length < 10) {
    warnings.push('Description is very short; agents use it to decide when to activate the skill');
  }
  if (!String(parsed.body || '').trim()) {
    warnings.push('Skill body is empty; add Markdown instructions');
  }
  const name = String(fm.name || '').trim();
  if (name && existingNames.includes(name) && directoryName !== name) {
    errors.push(`Duplicate skill identifier "${name}"`);
  }
  return { ok: errors.length === 0, errors, warnings, parsed };
}

export function validateResourcePath(rel) {
  const errors = [];
  const path = String(rel || '').replace(/\\/g, '/');
  if (!path) errors.push('Resource path is empty');
  if (path.includes('\0')) errors.push('Resource path contains a null byte');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) errors.push('Resource path must be relative');
  const parts = path.split('/');
  if (parts.some((p) => p === '..' || p === '')) {
    errors.push('Resource path must not contain ".." or empty segments');
  }
  if (path === 'SKILL.md' || path.endsWith('/SKILL.md')) {
    errors.push('SKILL.md is not a supporting resource');
  }
  return { ok: errors.length === 0, errors, path };
}

export function validateImportRoot(files) {
  const errors = [];
  const warnings = [];
  const names = new Set();
  let hasSkillMd = false;
  for (const file of files || []) {
    const check = validateResourcePath(file.rel === 'SKILL.md' ? 'scripts/x' : file.rel);
    // SKILL.md is allowed at root only
    if (file.rel === 'SKILL.md') {
      hasSkillMd = true;
      continue;
    }
    const v = validateResourcePath(file.rel);
    if (!v.ok) errors.push(...v.errors.map((e) => `${file.rel}: ${e}`));
    if (names.has(file.rel)) errors.push(`Duplicate file in import: ${file.rel}`);
    names.add(file.rel);
  }
  if (!hasSkillMd) errors.push('Imported skill must include SKILL.md');
  return { ok: errors.length === 0, errors, warnings };
}
