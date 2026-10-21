/**
 * Build the Agentic Development Console React UI to fixed filenames next to
 * this config: dashboard.html, dashboard.js, dashboard.css
 *
 *   npm run build
 */
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, 'ui');
const buildDir = resolve(here, '.build');
const pkgVersion = (() => {
  try {
    return JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')).version || '0';
  } catch {
    return '0';
  }
})();

/** Copy Vite's .build/ output to stable dashboard.* names in this folder. */
function publishDashboardAssets() {
  return {
    name: 'publish-dashboard-assets',
    closeBundle() {
      const builtHtml = resolve(buildDir, 'index.html');
      if (!existsSync(builtHtml)) return;
      let html = readFileSync(builtHtml, 'utf8');
      // Vite may emit absolute or nested paths; normalize to ./dashboard.*
      html = html
        .replace(/(?:\.\/)?assets\/dashboard\.js|\/dashboard\.js/g, './dashboard.js')
        .replace(/(?:\.\/)?assets\/dashboard\.css|\/dashboard\.css/g, './dashboard.css')
        .replace(/src="[^"]*dashboard\.js"/, 'src="./dashboard.js"')
        .replace(/href="[^"]*dashboard\.css"/, 'href="./dashboard.css"');
      writeFileSync(resolve(here, 'dashboard.html'), html);
      for (const name of ['dashboard.js', 'dashboard.css', 'favicon.svg']) {
        const from = resolve(buildDir, name);
        if (existsSync(from)) copyFileSync(from, resolve(here, name));
      }
      // Also pick up hashed names if rollup ignored our assetFileNames somehow.
      try {
        rmSync(buildDir, { recursive: true, force: true });
      } catch { /* leave .build if busy */ }
    },
  };
}

export default defineConfig({
  root: uiRoot,
  base: './',
  define: {
    __KUSA_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [react(), tailwindcss(), publishDashboardAssets()],
  build: {
    outDir: buildDir,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(uiRoot, 'index.html'),
      output: {
        entryFileNames: 'dashboard.js',
        chunkFileNames: 'dashboard-[name].js',
        assetFileNames: (asset) => {
          if (asset.name && asset.name.endsWith('.css')) return 'dashboard.css';
          return 'dashboard-[name][extname]';
        },
      },
    },
  },
  server: {
    port: 1237,
    proxy: {
      '/monitor-data.js': 'http://127.0.0.1:1424',
      '/index.json': 'http://127.0.0.1:1424',
      '/sessions': {
        target: 'http://127.0.0.1:1424',
        changeOrigin: true,
      },
    },
  },
});
