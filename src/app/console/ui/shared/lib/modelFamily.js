/**
 * Model family labels for the composer Model picker.
 *
 * Provider/endpoint headings already partition the catalog. Within each
 * provider, effort/context variants of the same product line (Claude Opus 5.5
 * High/Medium, GPT-5.5, …) collapse into a selectable family submenu. A
 * one-model “family” stays a direct pick — no empty drill-in.
 */

const BRACKET_RE = /\[[^\]]*\]/g;
const CONTEXT_RE = /\b\d+(\.\d+)?\s*[mk]b?\b/gi;
const EFFORT_TAIL_RE = /(?:^|[\s\-_.])((?:extra[-\s_]?)?(?:high|medium|low|fast|max|thinking|reasoning))$/i;

const VENDOR_RULES = [
  { family: 'Composer', test: (s) => /\bcomposer\b/.test(s) },
  { family: 'Claude', test: (s) => /\b(claude|anthropic|sonnet|opus|haiku)\b/.test(s) },
  { family: 'Gemini', test: (s) => /\b(gemini|gemma)\b/.test(s) },
  { family: 'Grok', test: (s) => /\b(grok|xai)\b/.test(s) },
  { family: 'DeepSeek', test: (s) => /\bdeepseek\b/.test(s) },
  { family: 'Qwen', test: (s) => /\b(qwen|qwq)\b/.test(s) },
  { family: 'Mistral', test: (s) => /\b(mistral|mixtral|codestral|pixtral|devstral)\b/.test(s) },
  { family: 'Llama', test: (s) => /\b(llama|codellama|meta-llama)\b/.test(s) },
  { family: 'Nova', test: (s) => /\bnova\b/.test(s) },
  {
    family: 'GPT',
    test: (s) => /\b(gpt|chatgpt|openai)\b/.test(s) || /(^|[^a-z])o[1-9]([^a-z]|$)/.test(s),
  },
];

/**
 * Strip context windows and trailing effort tokens so High/Medium/Low share a
 * family key. Works on both display labels and hyphenated ids.
 * @param {string} text
 */
function cleanFamilyStem(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  s = s.replace(BRACKET_RE, ' ');
  s = s.replace(/\s*\(default\)\s*/gi, ' ');
  s = s.replace(CONTEXT_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(EFFORT_TAIL_RE, '').replace(/[\s\-_.]+$/g, '').trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Hyphenated id stem → readable family ("claude-opus-5-5" → "Claude Opus 5.5").
 * Digit-digit pairs become dotted versions when they look like “5-5”.
 * @param {string} stem
 */
function prettyIdStem(stem) {
  const raw = String(stem || '').trim();
  if (!raw) return '';
  if (/\s/.test(raw)) return raw;
  // Turn id version pairs into dotted form before splitting so "5-5" survives
  // as "5.5" instead of two title-cased tokens.
  const dotted = raw.replace(/(\d)-(\d)(?!\d)/g, '$1.$2');
  return dotted
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((tok) => {
      if (/^\d+(\.\d+)?$/.test(tok)) return tok;
      if (/^[a-z]/.test(tok)) return tok.charAt(0).toUpperCase() + tok.slice(1);
      return tok;
    })
    .join(' ');
}

function vendorFamily(id, label) {
  const blob = `${String(id || '').toLowerCase()} ${String(label || '').toLowerCase()}`;
  for (const rule of VENDOR_RULES) {
    if (rule.test(blob)) return rule.family;
  }
  return 'Other';
}

/**
 * @param {string} id
 * @param {string} [label]
 * @returns {string}
 */
export function modelFamilyName(id, label = '') {
  const rawId = String(id || '').trim();
  if (!rawId) return 'Other';
  if (rawId.toLowerCase() === 'auto') return 'Auto';

  const fromLabel = cleanFamilyStem(label);
  if (fromLabel && fromLabel.toLowerCase() !== 'auto') return fromLabel;

  const fromId = prettyIdStem(cleanFamilyStem(rawId));
  if (fromId && fromId.toLowerCase() !== 'auto') return fromId;

  return vendorFamily(rawId, label);
}

/**
 * Stable key for a family drill-in under a provider heading.
 * @param {string} group
 * @param {string} family
 */
export function modelFamilyKey(group, family) {
  return `${String(group || '')}\u0000${String(family || '')}`;
}

/**
 * Build Model menu rows: provider headings, family drill-ins (2+ models in the
 * same provider), and singleton options left selectable beside them.
 *
 * @param {Array<{ id: string, label?: string, group?: string, blurb?: string }>} options
 * @param {string} [selectedId]
 * @returns {Array<
 *   | { heading: string }
 *   | { family: string, group: string, key: string, options: object[], selected: boolean }
 *   | { option: object }
 * >}
 */
export function modelMenuRows(options, selectedId = '') {
  const list = Array.isArray(options) ? options : [];
  /** @type {Array<{ group: string, family: string, options: object[] }>} */
  const buckets = [];
  /** @type {Map<string, { group: string, family: string, options: object[] }>} */
  const byKey = new Map();

  for (const option of list) {
    if (!option?.id) continue;
    const group = String(option.group || '');
    const family = modelFamilyName(option.id, option.label);
    const key = modelFamilyKey(group, family);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { group, family, options: [] };
      byKey.set(key, bucket);
      buckets.push(bucket);
    }
    bucket.options.push(option);
  }

  const rows = [];
  let lastGroup = null;
  for (const bucket of buckets) {
    if (bucket.group && bucket.group !== lastGroup) {
      rows.push({ heading: bucket.group });
      lastGroup = bucket.group;
    }
    if (bucket.options.length >= 2) {
      rows.push({
        family: bucket.family,
        group: bucket.group,
        key: modelFamilyKey(bucket.group, bucket.family),
        options: bucket.options,
        selected: bucket.options.some((option) => option.id === selectedId),
      });
    } else {
      rows.push({ option: bucket.options[0] });
    }
  }
  return rows;
}

/**
 * Resolve the options list for an open family drill-in.
 * @param {Array<{ id: string, label?: string, group?: string }>} options
 * @param {string | null} familyKey
 */
export function modelFamilyOptions(options, familyKey) {
  if (!familyKey) return [];
  const rows = modelMenuRows(options);
  const hit = rows.find((row) => row.family && row.key === familyKey);
  return hit?.options || [];
}

/**
 * Back-button label while drilled into a family under an optional provider.
 * @param {string | null} familyKey
 */
export function modelFamilyBackLabel(familyKey) {
  if (!familyKey) return 'Model';
  const sep = familyKey.indexOf('\u0000');
  if (sep < 0) return familyKey || 'Model';
  const group = familyKey.slice(0, sep);
  const family = familyKey.slice(sep + 1);
  return group ? `${group} · ${family}` : family;
}
