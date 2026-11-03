/**
 * Build the Agentic Development Console React UI to fixed filenames next to
 * this config: index.html, console.js, console.css (+ PWA shell assets)
 *
 *   npm run build
 *   kusa serve --live   -> Vite dev server + React Fast Refresh (proxies API)
 */
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { packageJsonPath, pkgRoot } from '#shared/lib/pkg.mjs';

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

/** Copy Vite's .build/ output to stable console.* names in this folder. */
function publishConsoleAssets() {
  return {
    name: 'publish-console-assets',
    closeBundle() {
      const builtHtml = resolve(buildDir, 'index.html');
      if (!existsSync(builtHtml)) return;
      let html = readFileSync(builtHtml, 'utf8');
      // Vite may emit absolute or nested paths; normalize to ./console.*
      html = html
        .replace(/(?:\.\/)?assets\/console\.js|\/console\.js/g, './console.js')
        .replace(/(?:\.\/)?assets\/console\.css|\/console\.css/g, './console.css')
        .replace(/src="[^"]*console\.js"/, 'src="./console.js"')
        .replace(/href="[^"]*console\.css"/, 'href="./console.css"');
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
      writeFileSync(resolve(here, 'index.html'), html);
      for (const name of ['console.js', 'console.css', 'favicon.svg', 'manifest.webmanifest', 'sw.js']) {
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
      // Drop legacy dashboard.* names once console.* owns the shell.
      for (const name of ['dashboard.js', 'dashboard.css']) {
        try { rmSync(resolve(here, name), { force: true }); } catch { /* already gone */ }
      }
      try {
        rmSync(buildDir, { recursive: true, force: true });
      } catch { /* leave .build if busy */ }
    },
  };
}

/**
 * Backend origin for `vite` / `kusa serve --live`. The Node API listens here;
 * Vite owns the browser port and proxies these prefixes (incl. WebSockets).
 */
function apiProxy() {
  const target = process.env.KUSA_PROXY_TARGET || 'http://127.0.0.1:1424';
  return {
    target,
    changeOrigin: true,
    ws: true,
  };
}

/** API / auth / data routes — everything the React shell must not try to transform. */
const API_PROXY_PREFIXES = [
  '/kusa',
  '/auth',
  '/settings',
  '/sessions',
  '/health',
  '/ready',
  '/git',
  '/trail',
  '/files',
  '/search',
  '/skills',
  '/mcp',
  '/learnings',
  '/live-chat',
  '/cao',
  '/monitor-data.js',
  '/index.json',
];

export default defineConfig(({ command }) => {
  const proxy = apiProxy();
  const serverProxy = Object.fromEntries(
    API_PROXY_PREFIXES.map((prefix) => [prefix, proxy]),
  );

  return {
    root: uiRoot,
    // Absolute base for the dev server (HMR / module URLs). Relative for the
    // published production shell next to serve.mjs.
    base: command === 'serve' ? '/' : './',
    publicDir: 'public',
    define: {
      __KUSA_VERSION__: JSON.stringify(pkgVersion),
    },
    resolve: {
      alias: {
        '#ui': resolve(pkgRoot, 'src/app/console/ui'),
        '#features': resolve(pkgRoot, 'src/features'),
        '#shared': resolve(pkgRoot, 'src/shared'),
        '#app': resolve(pkgRoot, 'src/app'),
        '#extensions': resolve(pkgRoot, 'extensions'),
      },
    },
    plugins: [react(), tailwindcss(), publishConsoleAssets()],
    build: {
      outDir: buildDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: resolve(uiRoot, 'index.html'),
        output: {
          entryFileNames: 'console.js',
          chunkFileNames: 'console-[name].js',
          assetFileNames: (asset) => {
            if (asset.name && asset.name.endsWith('.css')) return 'console.css';
            return 'console-[name][extname]';
          },
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: 1237,
      strictPort: false,
      proxy: serverProxy,
    },
  };
});
