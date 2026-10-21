/** Injected at build time from package.json (see vite.config.mjs). */
export const KUSA_VERSION =
  typeof __KUSA_VERSION__ !== 'undefined' ? String(__KUSA_VERSION__) : '0';
