/**
 * Trail learnings as team memory — list and add under `.trail/learnings/`.
 * Format matches `trail note` (YAML frontmatter + body). Prefer the Trail CLI
 * when available; otherwise write the markdown file directly.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const LEARNINGS_DIR = '.trail/learnings';

function learningsRoot(workspaceRoot) {
  return join(resolve(workspaceRoot || process.cwd()), LEARNINGS_DIR);
}

function slug(s, words = 6) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, words)
    .join('-');
}

function parseFrontmatter(raw) {
  const text = String(raw || '');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { meta: {}, body: text.trim() };
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text.trim() };
  const fm = text.slice(4, end).replace(/\r/g, '');
  const body = text.slice(end + 4).replace(/^\r?\n/, '').trim();
  const meta = {};
  let listKey = null;
  for (const line of fm.split('\n')) {
    if (/^\s+-\s+/.test(line) && listKey) {
      if (!Array.isArray(meta[listKey])) meta[listKey] = [];
      meta[listKey].push(line.replace(/^\s+-\s+/, '').trim());
      continue;
    }
    listKey = null;
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (val === '') {
      listKey = key;
      meta[key] = [];
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body };
}

function authorName() {
  try {
    const r = spawnSync('git', ['config', 'user.name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const name = (r.stdout || '').trim().split(/\s+/)[0];
    if (name) return name;
  } catch { /* fall through */ }
  return process.env.USER || process.env.USERNAME || 'agent';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * List repo learnings (and optionally personal ~/.trail notes). Newest first.
 */
export function listLearnings(workspaceRoot, { personal = false } = {}) {
  const out = [];
  const roots = [{ scope: 'repo', dir: learningsRoot(workspaceRoot) }];
  if (personal) {
    roots.push({ scope: 'personal', dir: join(homedir(), '.trail', 'notes') });
  }
  for (const { scope, dir } of roots) {
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md');
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      let raw;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(raw);
      out.push({
        id: name,
        path,
        scope,
        title: meta.title || name.replace(/\.md$/, ''),
        author: meta.author || null,
        date: meta.date || null,
        branch: meta.branch || null,
        touches: Array.isArray(meta.touches) ? meta.touches : [],
        body,
        preview: body.split(/\r?\n/).find((l) => l.trim()) || '',
      });
    }
  }
  out.sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da !== db) return db.localeCompare(da);
    return String(b.id).localeCompare(String(a.id));
  });
  return { learnings: out, dir: learningsRoot(workspaceRoot) };
}

/**
 * Add a learning. Uses `trail note` when the CLI is on PATH; otherwise writes
 * a compatible markdown file under `.trail/learnings/`.
 */
export function addLearning(workspaceRoot, { title, body, personal = false } = {}) {
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  if (!t) {
    const err = new Error('title is required');
    err.code = 'EINVAL';
    throw err;
  }
  if (!b) {
    const err = new Error('body is required');
    err.code = 'EINVAL';
    throw err;
  }

  const root = resolve(workspaceRoot || process.cwd());
  const rootLearnings = learningsRoot(root);
  // Only call `trail note` when this folder is its own git checkout. Otherwise
  // Trail walks up to a parent repo and writes outside the intended workspace.
  const ownGit = existsSync(join(root, '.git'));

  if (ownGit || personal) {
    const trail = spawnSync(
      'trail',
      [
        'note',
        ...(personal ? ['--personal'] : []),
        '--title', t,
        '-m', b,
        '--json',
        root,
      ],
      {
        encoding: 'utf8',
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        env: process.env,
      },
    );

    if (trail.status === 0 && trail.stdout?.trim()) {
      try {
        const saved = JSON.parse(trail.stdout.trim());
        const savedPath = resolve(String(saved.path || ''));
        const inRepo = !personal
          && (savedPath === rootLearnings || savedPath.startsWith(`${rootLearnings}/`));
        if (personal || inRepo) {
          return {
            ok: true,
            via: 'trail',
            learning: {
              id: basename(saved.path || ''),
              path: saved.path,
              scope: saved.scope || (personal ? 'personal' : 'repo'),
              title: saved.title || t,
              author: saved.author || null,
              date: saved.date || today(),
              branch: saved.branch || null,
              touches: saved.touches || [],
              body: saved.body || b,
              preview: (saved.body || b).split(/\r?\n/).find((l) => l.trim()) || '',
            },
          };
        }
      } catch { /* fall through to direct write */ }
    }

    if (personal) {
      const err = new Error(
        trail.stderr?.trim()
          || 'trail note failed; personal learnings require the Trail CLI',
      );
      err.code = 'ETRAIL';
      throw err;
    }
  }

  const dir = learningsRoot(root);
  mkdirSync(dir, { recursive: true });
  const author = authorName();
  const date = today();
  const base = [date, slug(t) || 'note', slug(author, 1)].filter(Boolean).join('-');
  let name = `${base}.md`;
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}-${i}.md`;
  const path = join(dir, name);
  const md = [
    '---',
    `title: ${t}`,
    `author: ${author}`,
    `date: ${date}`,
    '---',
    '',
    b,
    '',
  ].join('\n');
  writeFileSync(path, md);
  return {
    ok: true,
    via: 'file',
    learning: {
      id: name,
      path,
      scope: 'repo',
      title: t,
      author,
      date,
      branch: null,
      touches: [],
      body: b,
      preview: b.split(/\r?\n/).find((l) => l.trim()) || '',
    },
  };
}
