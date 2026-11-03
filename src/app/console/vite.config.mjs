/**
 * Build the Agentic Development Console React UI to fixed filenames next to
 * this config: dashboard.html, dashboard.js, dashboard.css (+ PWA shell assets)
 *
 *   npm run build
 */
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { packageJsonPath } from '#shared/lib/pkg.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, 'ui');
const buildDir = resolve(here, '.build');
const pkgVersion = (() => {
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version || '0';
  } catch {
    return '0';
  }
})();

function copyIfExists(from, to) {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  return true;
}

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
      // Keep a single manifest link after Vite rewrites the HTML.
      html = html.replace(/<link rel="manifest"[^>]*>\s*/g, '');
      if (!html.includes('name="theme-color"')) {
        html = html.replace(
          '</head>',
          '  <link rel="manifest" href="/manifest.webmanifest">\n  <meta name="theme-color" content="#030712">\n</head>',
        );
      } else {
        html = html.replace(
          '</head>',
          '  <link rel="manifest" href="/manifest.webmanifest">\n</head>',
        );
      }
      writeFileSync(resolve(here, 'dashboard.html'), html);
      for (const name of ['dashboard.js', 'dashboard.css', 'favicon.svg', 'manifest.webmanifest', 'sw.js']) {
        copyIfExists(resolve(buildDir, name), resolve(here, name));
      }
      // Shell SW + manifest live in ui/public (copied into .build by Vite).
      copyIfExists(resolve(uiRoot, 'public', 'sw.js'), resolve(here, 'sw.js'));
      copyIfExists(resolve(uiRoot, 'public', 'manifest.webmanifest'), resolve(here, 'manifest.webmanifest'));
      const iconsSrc = existsSync(resolve(buildDir, 'icons'))
        ? resolve(buildDir, 'icons')
        : resolve(uiRoot, 'public', 'icons');
      const iconsDest = resolve(here, 'icons');
      if (existsSync(iconsSrc)) {
        mkdirSync(iconsDest, { recursive: true });
        for (const name of readdirSync(iconsSrc)) {
          copyIfExists(join(iconsSrc, name), join(iconsDest, name));
        }
      }
      try {
        rmSync(buildDir, { recursive: true, force: true });
      } catch { /* leave .build if busy */ }
    },
  };
}

export default defineConfig({
  root: uiRoot,
  base: './',
  publicDir: 'public',
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
      '/health': 'http://127.0.0.1:1424',
      '/auth': 'http://127.0.0.1:1424',
      '/settings': 'http://127.0.0.1:1424',
      '/sessions': {
        target: 'http://127.0.0.1:1424',
        changeOrigin: true,
      },
    },
  },
});
