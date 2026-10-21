import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFrontmatterEdits,
  buildSkillMarkdown,
  compareSkillPublications,
  createSkill,
  deleteSkill,
  detectAgentCapabilities,
  duplicateSkill,
  ensureSkillsInitialized,
  exportSkillFiles,
  exportSkillToDirectory,
  groupDestinationsByPath,
  importSkillFromDirectory,
  importSkillFromFiles,
  listSkills,
  parseSkillMarkdown,
  publishSkill,
  readSkill,
  restoreStarterSkill,
  seedStarterSkills,
  updateSkill,
  validateResourcePath,
  validateSkillMarkdown,
} from '../src/skills/index.mjs';
import { createMonitorServer } from '../src/serve.mjs';

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-skills-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('skill model + validation', () => {
  it('parses and round-trips frontmatter while preserving unknown fields', () => {
    const md = `---
name: demo-skill
description: A demo skill for tests.
license: MIT
paths:
  - "**/*.ts"
custom-flag: true
metadata:
  team: platform
---

# Demo

Do the thing.
`;
    const parsed = parseSkillMarkdown(md);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.frontmatter.name, 'demo-skill');
    assert.equal(parsed.frontmatter.license, 'MIT');
    assert.deepEqual(parsed.frontmatter.paths, ['**/*.ts']);
    assert.equal(parsed.frontmatter['custom-flag'], true);
    assert.equal(parsed.frontmatter.metadata.team, 'platform');

    const edited = applyFrontmatterEdits(parsed.frontmatter, {
      description: 'Updated description for the demo skill.',
    });
    assert.equal(edited.license, 'MIT');
    assert.equal(edited['custom-flag'], true);
    const rebuilt = buildSkillMarkdown(edited, parsed.body);
    const again = parseSkillMarkdown(rebuilt);
    assert.equal(again.frontmatter.license, 'MIT');
    assert.equal(again.frontmatter.description, 'Updated description for the demo skill.');
  });

  it('rejects invalid names and missing metadata', () => {
    const bad = validateSkillMarkdown(`---
name: Bad_Name
description: x
---
body
`);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /lowercase|hyphen/i.test(e) || /name/i.test(e)));

    const mismatch = validateSkillMarkdown(`---
name: alpha
description: Long enough description here.
---
body
`, { directoryName: 'beta' });
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.errors.some((e) => /match its directory/i.test(e)));
  });

  it('rejects path traversal in resources', () => {
    assert.equal(validateResourcePath('../etc/passwd').ok, false);
    assert.equal(validateResourcePath('/abs/path').ok, false);
    assert.equal(validateResourcePath('scripts/ok.sh').ok, true);
  });
});

describe('skill store + seeding', () => {
  it('seeds five starters without overwriting customized skills', () => {
    const dir = tempDir();
    const first = seedStarterSkills(dir);
    assert.equal(first.created.length, 5);
    assert.equal(listSkills(dir).skills.length, 5);

    updateSkill(dir, 'agentic-coding-workflow', {
      body: '# Customized\n\nUser edits.\n',
    });
    const customized = readSkill(dir, 'agentic-coding-workflow');
    assert.equal(customized.starterCustomized, true);

    const second = seedStarterSkills(dir);
    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, 5);
    const still = readSkill(dir, 'agentic-coding-workflow');
    assert.match(still.body, /Customized/);
  });

  it('restore default refuses customized content unless confirmed', () => {
    const dir = tempDir();
    seedStarterSkills(dir);
    updateSkill(dir, 'debugging-root-cause', { body: '# Edited\n' });
    assert.throws(
      () => restoreStarterSkill(dir, 'debugging-root-cause'),
      (err) => err.code === 'ECONFIRM',
    );
    const restored = restoreStarterSkill(dir, 'debugging-root-cause', { confirmCustomized: true });
    assert.match(restored.body, /Root-Cause Analysis/);
    assert.equal(restored.starterCustomized, false);
  });

  it('supports create, duplicate, delete, and validation', () => {
    const dir = tempDir();
    ensureSkillsInitialized(dir);
    const created = createSkill(dir, {
      name: 'my-helper',
      description: 'Helps with a specific repository workflow when asked.',
      body: '# Helper\n\nSteps here.\n',
      resources: [
        { rel: 'references/notes.md', content: '# Notes\n' },
      ],
    });
    assert.equal(created.name, 'my-helper');
    assert.equal(created.resources.length, 1);

    const copy = duplicateSkill(dir, 'my-helper');
    assert.match(copy.name, /^my-helper-copy/);

    deleteSkill(dir, copy.id);
    assert.throws(() => readSkill(dir, copy.id), (err) => err.code === 'ENOENT');
  });
});

describe('import / export', () => {
  it('imports and exports a skill directory safely', () => {
    const monitor = tempDir();
    const source = tempDir();
    const skillDir = join(source, 'import-me');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: import-me
description: Imported skill used in automated tests for Kusă.
---

# Import me
`,
    );
    writeFileSync(join(skillDir, 'scripts', 'noop.sh'), '#!/bin/sh\necho ok\n');

    const imported = importSkillFromDirectory(monitor, skillDir);
    assert.equal(imported.name, 'import-me');
    assert.equal(imported.resources.some((r) => r.rel === 'scripts/noop.sh'), true);

    const outParent = tempDir();
    const exported = exportSkillToDirectory(monitor, 'import-me', outParent);
    assert.equal(existsSync(join(exported.path, 'SKILL.md')), true);
    assert.equal(existsSync(join(exported.path, 'scripts', 'noop.sh')), true);

    const mem = exportSkillFiles(monitor, 'import-me');
    assert.equal(mem.files[0].rel, 'SKILL.md');

    assert.throws(
      () => importSkillFromFiles(monitor, [{ rel: '../evil.md', content: 'x' }]),
      (err) => err.code === 'EPATH',
    );
  });
});

describe('publisher', () => {
  it('dry-runs, publishes idempotently, detects conflicts, and retries', () => {
    const monitor = tempDir();
    const workspace = tempDir();
    mkdirSync(join(workspace, '.cursor'), { recursive: true });
    mkdirSync(join(workspace, '.github', 'hooks'), { recursive: true });
    mkdirSync(join(workspace, '.claude'), { recursive: true });

    ensureSkillsInitialized(monitor);
    createSkill(monitor, {
      name: 'publish-demo',
      description: 'Skill used to exercise the cross-agent publisher.',
      body: '# Publish demo\n\nBody v1\n',
      resources: [{ rel: 'assets/note.txt', content: 'note-v1\n' }],
    });

    const agents = detectAgentCapabilities(workspace);
    assert.equal(agents.find((a) => a.id === 'cursor').detected, true);
    assert.equal(agents.find((a) => a.id === 'copilot').detected, true);
    assert.equal(agents.find((a) => a.id === 'claude').detected, true);

    const keys = ['cursor:agents', 'copilot:agents', 'claude:claude', 'copilot:github'];
    const groups = groupDestinationsByPath(workspace, keys);
    // cursor+copilot share .agents/skills → one filesystem group
    assert.ok(groups.length <= 3);

    const dry = publishSkill(monitor, workspace, 'publish-demo', { keys, dryRun: true });
    assert.ok(dry.summary.dryRun > 0);
    assert.equal(existsSync(join(workspace, '.agents', 'skills', 'publish-demo', 'SKILL.md')), false);

    const first = publishSkill(monitor, workspace, 'publish-demo', { keys, dryRun: false });
    assert.ok(first.summary.published >= 1);
    assert.equal(existsSync(join(workspace, '.agents', 'skills', 'publish-demo', 'SKILL.md')), true);
    assert.equal(existsSync(join(workspace, '.claude', 'skills', 'publish-demo', 'SKILL.md')), true);
    assert.equal(existsSync(join(workspace, '.github', 'skills', 'publish-demo', 'assets', 'note.txt')), true);

    const second = publishSkill(monitor, workspace, 'publish-demo', { keys, dryRun: false });
    assert.ok(second.summary.skipped + second.summary.published >= second.results.length);

    // Diverge a published copy
    writeFileSync(
      join(workspace, '.agents', 'skills', 'publish-demo', 'SKILL.md'),
      `---
name: publish-demo
description: Skill used to exercise the cross-agent publisher.
---

# Externally edited
`,
    );

    const conflicted = publishSkill(monitor, workspace, 'publish-demo', {
      keys: ['cursor:agents'],
      dryRun: false,
      overwrite: false,
    });
    assert.ok(conflicted.summary.conflict >= 1);

    const overwritten = publishSkill(monitor, workspace, 'publish-demo', {
      keys: ['cursor:agents'],
      dryRun: false,
      overwrite: true,
    });
    assert.ok(overwritten.summary.published >= 1);
    const body = readFileSync(join(workspace, '.agents', 'skills', 'publish-demo', 'SKILL.md'), 'utf8');
    assert.match(body, /Body v1/);

    const comparison = compareSkillPublications(monitor, workspace, 'publish-demo');
    assert.ok(comparison.comparisons.length >= 1);
  });
});

describe('skills HTTP API', () => {
  it('lists, creates, validates, and publishes via serve routes', async () => {
    const monitor = tempDir();
    const workspace = tempDir();
    mkdirSync(join(workspace, '.cursor'), { recursive: true });
    const server = createMonitorServer({ dataDir: monitor, workspaceRoot: workspace });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    try {
      const listRes = await fetch(`${base}/skills`);
      assert.equal(listRes.status, 200);
      const list = await listRes.json();
      assert.equal(list.skills.length, 5);

      const createRes = await fetch(`${base}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'api-skill',
          description: 'Created through the HTTP skills API during tests.',
          body: '# API\n',
        }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();
      assert.equal(created.id, 'api-skill');

      const pubRes = await fetch(`${base}/skills/api-skill/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: ['cursor:agents'], dryRun: false }),
      });
      assert.equal(pubRes.status, 200);
      const pub = await pubRes.json();
      assert.ok(pub.summary.published >= 1);
      assert.equal(existsSync(join(workspace, '.agents', 'skills', 'api-skill', 'SKILL.md')), true);

      const delRes = await fetch(`${base}/skills/api-skill`, { method: 'DELETE' });
      assert.equal(delRes.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
