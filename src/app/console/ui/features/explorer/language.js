/**
 * Map a workspace file path to a Monaco language id.
 * Unknown extensions fall back to plaintext.
 */
const BY_EXT = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  txt: 'plaintext',
  log: 'plaintext',
};

const BY_NAME = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  gemfile: 'ruby',
  rakefile: 'ruby',
  'cmakelists.txt': 'plaintext',
};

export function languageOfPath(path) {
  const base = String(path || '').split('/').pop() || '';
  const lower = base.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  return BY_EXT[lower.slice(dot + 1)] || 'plaintext';
}

export function basenameOfPath(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || path || 'file';
}

/**
 * Map a path to a FileTypeIcon / Explorer TONES id (code, doc, data, …).
 * Mirrors the spirit of server-side fileTypeOf without pulling node:fs into the UI.
 */
export function fileTypeOfPath(path) {
  const base = String(path || '').replace(/\\/g, '/').split('/').pop() || '';
  const lower = base.toLowerCase();
  if (lower.startsWith('.') && !lower.slice(1).includes('.')) return 'config';
  if (/^(package\.json|tsconfig.*\.json|jsconfig\.json|makefile|dockerfile|readme(\.md)?|license|changelog|contributing|todo|notes)(\.|$)/i.test(lower)) {
    return 'config';
  }
  const lang = languageOfPath(path);
  if (
    lang === 'javascript'
    || lang === 'typescript'
    || lang === 'python'
    || lang === 'go'
    || lang === 'rust'
    || lang === 'ruby'
    || lang === 'java'
    || lang === 'kotlin'
    || lang === 'c'
    || lang === 'cpp'
    || lang === 'csharp'
    || lang === 'php'
    || lang === 'css'
    || lang === 'scss'
    || lang === 'less'
    || lang === 'html'
    || lang === 'xml'
  ) {
    return 'code';
  }
  if (lang === 'json' || lang === 'yaml' || lang === 'sql' || lang === 'graphql' || lang === 'ini') {
    return 'data';
  }
  if (lang === 'markdown' || lang === 'plaintext') return 'doc';
  if (lang === 'shell' || lang === 'powershell') return 'script';
  if (lang === 'dockerfile') return 'config';
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'bmp', 'avif'].includes(ext)) return 'image';
  if (['wasm', 'pdf', 'zip', 'gz', 'tgz', 'woff', 'woff2', 'ttf'].includes(ext)) return 'binary';
  if (!ext || ext === 'env' || ext === 'properties') return 'config';
  return 'file';
}
