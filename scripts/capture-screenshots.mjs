#!/usr/bin/env node
/**
 * Capture light-mode README screenshots of the real Kusă Console.
 *
 * Prerequisites:
 *   - `kusa serve` (or `npm run serve`) listening on :1424
 *   - Google Chrome / Chromium available
 *   - `puppeteer-core` installed (dev-only; not a runtime dependency)
 *
 * Usage:
 *   node scripts/capture-screenshots.mjs
 *   KUSA_SHOT_CHAT_ONLY=1 node scripts/capture-screenshots.mjs
 *
 * Env:
 *   KUSA_SHOT_URL       Dashboard URL (default http://127.0.0.1:1424/dashboard.html)
 *   CHROME_PATH         Chrome/Chromium binary (default /usr/bin/google-chrome)
 *   KUSA_SHOT_CHAT_ONLY When "1", only rewrite kusa-overview.png + chat-harness.png
 *                       (does not delete other screenshots)
 */
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'docs', 'screenshots');
const baseUrl = process.env.KUSA_SHOT_URL || 'http://127.0.0.1:1424/dashboard.html';
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';

/** Persisted transcript (idle). Live approval turn is injected in the browser. */
const DEMO_SESSION = {
  key: 'kusa:shot-demo',
  id: 'shot-demo',
  status: 'idle',
  attempts: 2,
  createdAt: Date.now() - 120_000,
  messages: [
    {
      id: 'm1',
      role: 'user',
      text: 'Run the package tests and summarize any failures.',
      at: Date.now() - 45_000,
    },
  ],
};

/** In-flight Kusă Chat turn: thinking → tools → pending approval gate. */
function buildDemoLive() {
  const timeoutStartsAt = Date.now() - 15_000;
  const thinking =
    'The user wants npm test results. I will inspect package.json for the test script, '
    + 'then run it through kusa_terminal. Terminal tools are approval-gated under ask-deny, '
    + 'so the console should pause for Allow / Deny before the command executes.';
  const tools = [
    {
      id: 't1',
      name: 'kusa_read_file',
      args: { path: 'package.json', limit: 45 },
      summary: 'scripts.test → node --test test/*.test.mjs',
      result: '{\n  "name": "kusa",\n  "scripts": {\n    "test": "node --test test/*.test.mjs"\n  }\n}',
      ok: true,
      status: 'done',
    },
    {
      id: 't2',
      name: 'kusa_grep',
      args: { pattern: '"test":', path: 'package.json' },
      summary: 'package.json: "test": "node --test …"',
      result: 'package.json:36:    "test": "node --test test/*.test.mjs",',
      ok: true,
      status: 'done',
    },
  ];
  const approval = {
    id: 'appr-terminal-1',
    toolId: 't3',
    name: 'kusa_terminal',
    args: { command: 'npm test' },
    summary: 'npm test',
    message: 'Allow kusa_terminal to run `npm test` in the workspace?',
    status: 'pending',
    decision: null,
    timeoutMs: 120_000,
    timeoutStartsAt,
    timeoutDecision: null,
    timeoutDefaultAllowed: false,
    autoSettled: false,
    reason: null,
  };
  const parts = [
    { type: 'thinking', text: thinking },
    ...tools.map((tool) => ({ type: 'tool', tool })),
    { type: 'approval', approval },
  ];
  return {
    text: '',
    thinking,
    tools,
    parts,
  };
}

async function forceLight(page) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluate(() => {
    localStorage.setItem('monitor.theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });
}

async function clickSessionByTitle(page, needle) {
  return page.evaluate((want) => {
    const buttons = [...document.querySelectorAll('button')];
    const hit = buttons.find((b) => {
      const title = b.getAttribute('title') || '';
      const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
      return title.includes(want) || text.includes(want);
    });
    if (!hit) return false;
    hit.click();
    return true;
  }, needle);
}

/** Select the seeded demo chat by id, title, or session label. */
async function selectShotDemo(page) {
  // Wait until the seeded row is mounted (sessions load async after boot).
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')]
      .some((b) => /shot-demo/i.test(b.getAttribute('title') || '')),
    { timeout: 10_000 },
  ).catch(() => {});

  const ok = await page.evaluate(() => {
    const isDemoButton = (b) => {
      const title = b.getAttribute('title') || '';
      const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
      return /shot-demo/i.test(title) || /Run the package tests/i.test(text);
    };

    let hit = [...document.querySelectorAll('button')].find(isDemoButton);
    if (!hit) {
      // Harness header text is like "Kusă2" (count glued on) — match title instead.
      const expand = [...document.querySelectorAll('button')].find((b) => {
        const title = b.getAttribute('title') || '';
        return /^Kus[aă]/i.test(title) && /session/i.test(title);
      });
      expand?.click();
      hit = [...document.querySelectorAll('button')].find(isDemoButton);
    }
    hit?.click();
    return Boolean(hit);
  });
  await new Promise((r) => setTimeout(r, 500));
  return ok;
}

async function clickLatestCursorSession(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const latest = buttons.find((b) => /LATEST/i.test(b.textContent || ''));
    if (latest) {
      latest.click();
      return 'latest';
    }
    const sess = buttons.find((b) => {
      const title = b.getAttribute('title') || '';
      return /^[0-9a-f-]{8,}$/i.test(title) && !title.includes('shot-demo');
    });
    if (sess) {
      sess.click();
      return sess.getAttribute('title') || true;
    }
    return false;
  });
}

async function prepare(page) {
  await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 30_000 });
  await page.evaluate(async (session) => {
    localStorage.setItem('monitor.theme', 'light');
    localStorage.setItem('monitor.sidebar', 'open');
    localStorage.setItem('monitor.tab', 'session');
    localStorage.setItem('monitor.sessionSubTab', 'chat');
    localStorage.setItem('monitor.sessionFilter', 'all');
    localStorage.setItem('monitor.sidebarView', 'sessions');
    localStorage.removeItem('monitor.kusaSessions');
    document.documentElement.dataset.theme = 'light';
    const res = await fetch('/kusa/sessions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ session }),
    });
    if (!res.ok) throw new Error(`seed chat failed: HTTP ${res.status}`);
  }, DEMO_SESSION);
  await page.reload({ waitUntil: 'networkidle0', timeout: 30_000 });
  await forceLight(page);
  await page.waitForSelector('#sidebar', { timeout: 15_000 });
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'light') {
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label*="light" i], button[title*="light" i]');
      btn?.click();
    });
    await forceLight(page);
  }
  await selectShotDemo(page);
}

async function setRailTab(page, tabId) {
  await page.evaluate((id) => {
    localStorage.setItem('monitor.tab', id);
    document.getElementById(`tab-${id}`)?.click();
  }, tabId);
  await new Promise((r) => setTimeout(r, 500));
}

async function setSessionSubTab(page, subId) {
  await page.evaluate((id) => {
    localStorage.setItem('monitor.sessionSubTab', id);
    document.getElementById(`session-tab-${id}`)?.click();
  }, subId);
  await new Promise((r) => setTimeout(r, 400));
}

async function setMonitorsSubTab(page, subId) {
  await page.evaluate((id) => {
    localStorage.setItem('monitor.monitorsSubTab', id);
    document.getElementById(`monitors-tab-${id}`)?.click();
  }, subId);
  await new Promise((r) => setTimeout(r, 400));
}

async function setHarnessSubTab(page, subId) {
  await page.evaluate((id) => {
    localStorage.setItem('monitor.harnessSubTab', id);
    document.getElementById(`harness-tab-${id}`)?.click();
  }, subId);
  await new Promise((r) => setTimeout(r, 700));
}

async function setSettingsSubTab(page, subId) {
  await page.evaluate((id) => {
    localStorage.setItem('monitor.settingsSubTab', id);
    document.getElementById(`settings-tab-${id}`)?.click();
  }, subId);
  await new Promise((r) => setTimeout(r, 500));
}

async function shot(page, name) {
  const path = join(outDir, name);
  await page.screenshot({ path, type: 'png', fullPage: false });
  console.log(`wrote ${path}`);
}

/**
 * Demo a live approval turn without a real agent job:
 * 1) GET /kusa/sessions marks shot-demo busy + live
 * 2) GET /kusa/chat/live returns a held-open SSE snapshot (resume would otherwise
 *    404 and clear the busy overlay)
 */
async function enableLiveDemoOverlay(page, live) {
  await page.evaluate((livePayload) => {
    window.__kusaShotLive = livePayload;
    if (window.__kusaShotFetchPatched) return;
    window.__kusaShotFetchPatched = true;
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init = undefined) => {
      const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
      const url = typeof input === 'string' ? input : (req?.url || input?.url || '');
      const method = String(init?.method || req?.method || 'GET').toUpperCase();
      const path = (() => {
        try {
          return new URL(url, window.location.origin).pathname;
        } catch {
          return url;
        }
      })();

      if (window.__kusaShotLive && path === '/kusa/chat/live' && method === 'GET') {
        const body = [
          `data: ${JSON.stringify({
            type: 'snapshot',
            turnId: 'shot-turn',
            live: window.__kusaShotLive,
          })}`,
          '',
          '',
        ].join('\n');
        // Keep the stream open so attachKusaTurn stays subscribed (no done frame).
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            window.__kusaShotSse = controller;
          },
          cancel() {
            window.__kusaShotSse = null;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      }

      const res = await orig(input, init);
      // Only rewrite the list endpoint — never PUT/POST bodies (those omit `sessions`
      // and would wipe the sidebar if we returned `{ sessions: [] }`).
      if (!window.__kusaShotLive || path !== '/kusa/sessions' || method !== 'GET') {
        return res;
      }
      try {
        const data = await res.clone().json();
        if (!Array.isArray(data?.sessions)) return res;
        const next = data.sessions.map((s) => {
          if (s?.id !== 'shot-demo' && s?.key !== 'kusa:shot-demo') return s;
          return {
            ...s,
            status: 'busy',
            live: window.__kusaShotLive,
          };
        });
        return new Response(JSON.stringify({ ...data, sessions: next }), {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch {
        return res;
      }
    };
  }, live);
}

async function clearLiveDemoOverlay(page) {
  await page.evaluate(() => {
    window.__kusaShotLive = null;
    try {
      window.__kusaShotSse?.close?.();
    } catch { /* ignore */ }
    window.__kusaShotSse = null;
  });
}

/**
 * Kusă chats re-sync from GET /kusa/sessions only when monitor `generatedAtWall`
 * changes — not on a fixed timer. Bump it once so the busy/live overlay applies
 * and resume attaches to the mocked SSE snapshot.
 */
async function triggerSessionsResync(page) {
  await page.evaluate(async () => {
    const push = window.kusaUpdate;
    if (typeof push !== 'function') return;
    let last = null;
    window.kusaUpdate = (next) => {
      last = next;
      push(next);
    };
    await new Promise((resolve, reject) => {
      document.getElementById('monitor-data')?.remove();
      const script = document.createElement('script');
      script.id = 'monitor-data';
      script.src = `/monitor-data.js?t=${Date.now()}`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('monitor-data load failed'));
      document.head.appendChild(script);
    });
    window.kusaUpdate = push;
    if (last && typeof last === 'object') {
      push({ ...last, generatedAtWall: Date.now() });
    }
  });
  await new Promise((r) => setTimeout(r, 400));
}

async function expandChatDetails(page) {
  // Finished thinking / tool rows collapse once the turn is no longer "thinking";
  // expand them so the README shot shows the full observability surface.
  await page.evaluate(() => {
    const clickIfCollapsed = (re) => {
      for (const b of document.querySelectorAll('button')) {
        const label = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (!re.test(label)) continue;
        // Prefer expanding (aria-expanded=false); skip already-open rows.
        if (b.getAttribute('aria-expanded') === 'true') continue;
        b.click();
      }
    };
    clickIfCollapsed(/^(Thought|Thinking)\b/i);
    // Tool groups often render as "2 tools" — force-open even if aria state is stale.
    for (const b of document.querySelectorAll('button')) {
      const label = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^\d+\s+tools?\b/i.test(label) || /^Tool\b/i.test(label)) b.click();
    }
    clickIfCollapsed(/\b(kusa_read_file|kusa_grep|kusa_list_dir)\b/i);
  });
  await new Promise((r) => setTimeout(r, 500));
  // Frame the turn so thought + tools stay above the approval CTA.
  await page.evaluate(() => {
    const thought = [...document.querySelectorAll('button')]
      .find((b) => /^(Thought|Thinking)\b/i.test((b.textContent || '').trim()));
    thought?.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  await new Promise((r) => setTimeout(r, 200));
}

async function focusKusaDemo(page) {
  await selectShotDemo(page);
}

async function selectFirstSkill(page) {
  // Wait for the list API to populate before clicking.
  await page.waitForFunction(
    () => [...document.querySelectorAll('button[role="option"]')]
      .some((b) => /agentic-coding|codebase-exploration/i.test(b.textContent || '')),
    { timeout: 10_000 },
  ).catch(() => {});
  const ok = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('button[role="option"]')]
      .find((b) => /agentic-coding-workflow/i.test(b.textContent || ''));
    hit?.click();
    return Boolean(hit);
  });
  if (!ok) console.warn('skill select: no list row matched');
  await new Promise((r) => setTimeout(r, 900));
}

async function selectFirstTool(page) {
  await page.waitForFunction(
    () => [...document.querySelectorAll('button[role="option"]')]
      .some((b) => /kusa_/i.test(b.textContent || '')),
    { timeout: 10_000 },
  ).catch(() => {});
  const ok = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('button[role="option"]')]
      .find((b) => /kusa_list_skills/i.test(b.textContent || ''));
    hit?.click();
    return Boolean(hit);
  });
  if (!ok) console.warn('tool select: no list row matched');
  await new Promise((r) => setTimeout(r, 700));
}

async function expandFirstLearning(page) {
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const show = buttons.find((b) => /^(Show|Hide)$/i.test((b.textContent || '').trim()));
    show?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const chatOnly = process.env.KUSA_SHOT_CHAT_ONLY === '1';
  // Full runs replace the whole set. Chat-only overwrites just the two chat PNGs.
  if (!chatOnly) {
    for (const name of readdirSync(outDir)) {
      if (name.endsWith('.png')) unlinkSync(join(outDir, name));
    }
  }

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 2 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  try {
    await prepare(page);
    const assertLight = async () => {
      await forceLight(page);
      const t = await page.evaluate(() => document.documentElement.dataset.theme);
      if (t !== 'light') throw new Error(`expected light theme, got ${t}`);
    };

    // 01 — Hero / chat: expanded thinking, tool calls, pending approval gate
    await assertLight();
    await page.evaluate(() => {
      localStorage.setItem('monitor.composerMode', 'agent');
      localStorage.setItem('monitor.composerRule', 'ask-deny');
    });
    // Select the idle demo chat first, then overlay the live approval turn.
    await setRailTab(page, 'session');
    await setSessionSubTab(page, 'chat');
    const selected = await selectShotDemo(page);
    if (!selected) throw new Error('could not select shot-demo session in sidebar');
    await enableLiveDemoOverlay(page, buildDemoLive());
    await triggerSessionsResync(page);
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-kusa-approval="pending"]')),
      { timeout: 15_000 },
    );
    // Re-assert chat tab — expand clicks must not leave us on Tool Call Viewer.
    await setSessionSubTab(page, 'chat');
    await selectShotDemo(page);
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-kusa-approval="pending"]'))
        && /Awaiting approval/i.test(document.body.innerText)
        && Boolean(document.querySelector('[data-kusa-approval-cta]')),
      { timeout: 10_000 },
    );
    await expandChatDetails(page);
    await setSessionSubTab(page, 'chat');
    const chatOk = await page.evaluate(() => ({
      pending: Boolean(document.querySelector('[data-kusa-approval="pending"]')),
      cta: Boolean(document.querySelector('[data-kusa-approval-cta]')),
      chatTab: Boolean(document.querySelector('#session-tab-chat[aria-selected="true"]')),
      thought: /Need to run npm test|approval-gated/i.test(document.body.innerText),
      tools: /kusa_read_file/.test(document.body.innerText) && /kusa_grep/.test(document.body.innerText),
    }));
    if (!chatOk.pending || !chatOk.cta || !chatOk.chatTab) {
      throw new Error(`chat shot not ready: ${JSON.stringify(chatOk)}`);
    }
    await assertLight();
    await shot(page, 'kusa-overview.png');
    await shot(page, 'chat-harness.png');
    await clearLiveDemoOverlay(page);

    if (chatOnly) return;

    // 02 — Workflow: prompt history / plan context from a live Cursor lane when present
    await clickLatestCursorSession(page);
    await new Promise((r) => setTimeout(r, 400));
    await assertLight();
    await setRailTab(page, 'session');
    await setSessionSubTab(page, 'prompts');
    await shot(page, 'workflow-management.png');

    // 03 — Execution monitoring (counters + tool stats)
    await assertLight();
    await setRailTab(page, 'monitors');
    await setMonitorsSubTab(page, 'counters');
    await shot(page, 'execution-monitor.png');

    await assertLight();
    await setRailTab(page, 'session');
    await setSessionSubTab(page, 'tools');
    await shot(page, 'tool-call-viewer.png');

    await assertLight();
    await setRailTab(page, 'monitors');
    await setMonitorsSubTab(page, 'events');
    await shot(page, 'events-timeline.png');

    // Harness screenshots use the Kusă demo session so the Agents sidebar
    // highlights the first-party harness rather than a Cursor hook lane.
    await focusKusaDemo(page);

    // 04 — MCP server
    await assertLight();
    await setRailTab(page, 'harness');
    await setHarnessSubTab(page, 'mcp');
    await new Promise((r) => setTimeout(r, 500));
    await shot(page, 'mcp-server.png');

    // 05 — MCP / tools management
    await assertLight();
    await setHarnessSubTab(page, 'tools');
    await selectFirstTool(page);
    await shot(page, 'mcp-tools.png');

    // 06 — Skills editor
    await assertLight();
    await setHarnessSubTab(page, 'skills');
    await selectFirstSkill(page);
    await shot(page, 'skills-editor.png');

    // 07 — Knowledge / learnings
    await assertLight();
    await setHarnessSubTab(page, 'knowledgebase');
    await new Promise((r) => setTimeout(r, 900));
    await expandFirstLearning(page);
    await shot(page, 'knowledge-learnings.png');

    // 08 — Model / agent configuration (use public example endpoint text in the
    // UI for the shot — do not leak local/private base URLs into the README).
    await assertLight();
    await focusKusaDemo(page);
    const priorAgent = await page.evaluate(async () => {
      const res = await fetch('/settings', { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const s = await res.json();
      const prev = {
        agentBaseUrl: s.agentBaseUrl || '',
        agentModel: s.agentModel || '',
        agentBackend: s.agentBackend || 'native',
      };
      await fetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          agentBaseUrl: 'http://127.0.0.1:11434/v1',
          agentModel: 'gpt-4o-mini',
          agentBackend: 'native',
        }),
      });
      return prev;
    });
    await setRailTab(page, 'settings');
    await setSettingsSubTab(page, 'agent');
    await page.reload({ waitUntil: 'networkidle0', timeout: 30_000 });
    await forceLight(page);
    await focusKusaDemo(page);
    await setRailTab(page, 'settings');
    await setSettingsSubTab(page, 'agent');
    await new Promise((r) => setTimeout(r, 500));
    await shot(page, 'model-configuration.png');
    if (priorAgent) {
      await page.evaluate(async (prev) => {
        await fetch('/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(prev),
        });
      }, priorAgent);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
