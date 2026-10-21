/**
 * Cross-agent skill publisher with dry-run, conflict detection, and per-destination results.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  detectAgentCapabilities,
  groupDestinationsByPath,
  preferredDestinationKeys,
  resolveDestination,
} from './agents.mjs';
import { contentHash } from './model.mjs';
import {
  atomicWriteFile,
  fileHash,
  readSkill,
  updatePublications,
} from './store.mjs';

function hashFile(path) {
  return fileHash(readFileSync(path));
}

function listPublishedTree(destSkillDir) {
  const out = [];
  if (!existsSync(destSkillDir)) return out;
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) {
        out.push({ rel: rel.replace(/\\/g, '/'), hash: hashFile(abs), size: st.size });
      }
    }
  }
  walk(destSkillDir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function canonicalFiles(record) {
  const files = [{ rel: 'SKILL.md', hash: contentHash([record.skillMd]), content: record.skillMd }];
  for (const r of record._resourcesFull || []) {
    files.push({
      rel: r.rel,
      hash: r.hash,
      contentBase64: r.contentBase64,
    });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function compareTrees(canonical, published) {
  const pubMap = new Map(published.map((f) => [f.rel, f]));
  const canMap = new Map(canonical.map((f) => [f.rel, f]));
  const identical = [];
  const changed = [];
  const missing = [];
  const extra = [];
  for (const f of canonical) {
    const p = pubMap.get(f.rel);
    if (!p) missing.push(f.rel);
    else if (p.hash === f.hash) identical.push(f.rel);
    else changed.push(f.rel);
  }
  for (const f of published) {
    if (!canMap.has(f.rel)) extra.push(f.rel);
  }
  return {
    inSync: changed.length === 0 && missing.length === 0,
    diverged: changed.length > 0 || (extra.length > 0 && identical.length + changed.length > 0),
    identical,
    changed,
    missing,
    extra,
  };
}

function planWrite(group, record, { overwrite = false } = {}) {
  const destSkillDir = join(group.absoluteRoot, record.name);
  const exists = existsSync(join(destSkillDir, 'SKILL.md'));
  const published = exists ? listPublishedTree(destSkillDir) : [];
  const canonical = canonicalFiles(record);
  // Fix SKILL.md hash to match file content hash used on disk after write.
  const skillMdHash = createHash('sha256').update(record.skillMd.endsWith('\n') ? record.skillMd : `${record.skillMd}\n`).digest('hex');
  for (const f of canonical) {
    if (f.rel === 'SKILL.md') f.hash = skillMdHash;
  }
  const comparison = compareTrees(canonical, published);

  const actions = [];
  if (!exists) {
    for (const f of canonical) {
      actions.push({ op: 'create', rel: f.rel });
    }
  } else if (comparison.inSync && comparison.extra.length === 0) {
    for (const f of canonical) {
      actions.push({ op: 'skip', rel: f.rel, reason: 'identical' });
    }
  } else if (comparison.diverged && !overwrite) {
    for (const rel of comparison.changed) {
      actions.push({ op: 'conflict', rel, reason: 'destination differs from canonical' });
    }
    for (const rel of comparison.missing) {
      actions.push({ op: 'create', rel });
    }
    for (const rel of comparison.identical) {
      actions.push({ op: 'skip', rel, reason: 'identical' });
    }
    for (const rel of comparison.extra) {
      actions.push({ op: 'skip', rel, reason: 'extra file left untouched' });
    }
  } else {
    for (const f of canonical) {
      const p = published.find((x) => x.rel === f.rel);
      if (!p) actions.push({ op: 'create', rel: f.rel });
      else if (p.hash === f.hash) actions.push({ op: 'skip', rel: f.rel, reason: 'identical' });
      else actions.push({ op: 'update', rel: f.rel });
    }
    for (const rel of comparison.extra) {
      actions.push({ op: 'skip', rel, reason: 'extra file left untouched' });
    }
  }

  const blocked = actions.some((a) => a.op === 'conflict');
  return {
    relRoot: group.relRoot,
    absoluteRoot: group.absoluteRoot,
    skillDir: destSkillDir,
    portable: group.portable,
    destinations: group.destinations.map((d) => ({
      key: d.key,
      agentId: d.agentId,
      agentLabel: d.agentLabel,
      label: d.label,
    })),
    exists,
    comparison,
    actions,
    blocked,
    wouldWrite: !blocked && actions.some((a) => a.op === 'create' || a.op === 'update'),
  };
}

function applyPlan(plan, record, { dryRun = false } = {}) {
  if (plan.blocked) {
    return {
      ...plan,
      status: 'conflict',
      error: 'Destination has modifications; confirm overwrite to replace',
      dryRun,
    };
  }
  if (!plan.wouldWrite && plan.exists) {
    return {
      ...plan,
      status: 'skipped',
      error: null,
      dryRun,
      message: 'Already in sync',
    };
  }
  if (dryRun) {
    return {
      ...plan,
      status: 'dry-run',
      error: null,
      dryRun: true,
    };
  }

  try {
    mkdirSync(plan.skillDir, { recursive: true });
    const skillMd = record.skillMd.endsWith('\n') ? record.skillMd : `${record.skillMd}\n`;
    atomicWriteFile(join(plan.skillDir, 'SKILL.md'), skillMd);

    for (const res of record._resourcesFull || []) {
      const abs = resolve(plan.skillDir, res.rel);
      if (!abs.startsWith(resolve(plan.skillDir))) {
        throw Object.assign(new Error(`Unsafe resource path: ${res.rel}`), { code: 'EPATH' });
      }
      mkdirSync(dirname(abs), { recursive: true });
      const buf = Buffer.from(res.contentBase64, 'base64');
      atomicWriteFile(abs, buf);
    }

    // Verify
    const published = listPublishedTree(plan.skillDir);
    const canonical = canonicalFiles(record);
    const skillMdHash = createHash('sha256').update(skillMd).digest('hex');
    for (const f of canonical) {
      if (f.rel === 'SKILL.md') f.hash = skillMdHash;
    }
    const comparison = compareTrees(canonical, published);
    return {
      ...plan,
      comparison,
      status: comparison.inSync ? 'published' : 'failed',
      error: comparison.inSync ? null : 'Post-write verification mismatch',
      dryRun: false,
      publishedAtWall: Date.now(),
    };
  } catch (err) {
    return {
      ...plan,
      status: 'failed',
      error: err?.message || String(err),
      dryRun: false,
    };
  }
}

/**
 * Preview or execute a publish.
 * @param {object} opts
 * @param {string[]} opts.keys destination keys (agentId:destId)
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.overwrite] replace diverged destinations
 * @param {string[]} [opts.retryKeys] only these destinations (for retry)
 */
export function publishSkill(monitorDir, workspaceRoot, skillId, opts = {}) {
  const {
    keys = preferredDestinationKeys(workspaceRoot, { onlyDetected: true }),
    dryRun = false,
    overwrite = false,
    retryKeys = null,
  } = opts;

  const record = readSkill(monitorDir, skillId);
  const selected = retryKeys && retryKeys.length ? retryKeys : keys;
  const unknown = selected.filter((k) => !resolveDestination(workspaceRoot, k));
  if (unknown.length) {
    const err = new Error(`Unknown destination(s): ${unknown.join(', ')}`);
    err.code = 'EINVAL';
    throw err;
  }

  const groups = groupDestinationsByPath(workspaceRoot, selected);
  const plans = groups.map((g) => planWrite(g, record, { overwrite }));
  const results = plans.map((p) => applyPlan(p, record, { dryRun }));

  // Flatten per-destination outcomes (shared path → same result for each agent key).
  const byDestination = [];
  for (const result of results) {
    for (const dest of result.destinations) {
      byDestination.push({
        key: dest.key,
        agentId: dest.agentId,
        agentLabel: dest.agentLabel,
        label: dest.label,
        relRoot: result.relRoot,
        skillDir: relative(workspaceRoot, result.skillDir).split('\\').join('/'),
        status: result.status,
        error: result.error,
        actions: result.actions,
        comparison: result.comparison,
        dryRun: result.dryRun,
        publishedAtWall: result.publishedAtWall || null,
      });
    }
  }

  if (!dryRun) {
    const patch = {};
    const now = Date.now();
    for (const row of byDestination) {
      if (row.status === 'published' || row.status === 'skipped') {
        patch[row.key] = {
          status: row.status === 'skipped' ? 'published' : 'published',
          relRoot: row.relRoot,
          skillDir: row.skillDir,
          contentHash: record.contentHash,
          lastPublishedAtWall: now,
          lastError: null,
          diverged: false,
        };
      } else if (row.status === 'conflict') {
        patch[row.key] = {
          status: 'diverged',
          relRoot: row.relRoot,
          skillDir: row.skillDir,
          lastError: row.error,
          diverged: true,
          lastCheckedAtWall: now,
        };
      } else if (row.status === 'failed') {
        patch[row.key] = {
          status: 'failed',
          relRoot: row.relRoot,
          skillDir: row.skillDir,
          lastError: row.error,
          lastCheckedAtWall: now,
        };
      }
    }
    updatePublications(monitorDir, skillId, patch);
  }

  const summary = {
    published: byDestination.filter((d) => d.status === 'published').length,
    skipped: byDestination.filter((d) => d.status === 'skipped').length,
    conflict: byDestination.filter((d) => d.status === 'conflict').length,
    failed: byDestination.filter((d) => d.status === 'failed').length,
    dryRun: byDestination.filter((d) => d.status === 'dry-run').length,
  };

  return {
    skillId: record.id,
    skillName: record.name,
    contentHash: record.contentHash,
    dryRun,
    overwrite,
    results: byDestination,
    pathGroups: results,
    summary,
    agents: detectAgentCapabilities(workspaceRoot),
  };
}

export function compareSkillPublications(monitorDir, workspaceRoot, skillId) {
  const record = readSkill(monitorDir, skillId);
  const pubs = record.publications || {};
  const comparisons = [];
  const seenRoots = new Set();

  for (const [key, pub] of Object.entries(pubs)) {
    const dest = resolveDestination(workspaceRoot, key);
    const relRoot = pub.relRoot || dest?.relRoot;
    if (!relRoot || seenRoots.has(relRoot)) continue;
    seenRoots.add(relRoot);
    const destSkillDir = join(workspaceRoot, relRoot, record.name);
    const published = listPublishedTree(destSkillDir);
    const canonical = canonicalFiles(record);
    const skillMd = record.skillMd.endsWith('\n') ? record.skillMd : `${record.skillMd}\n`;
    const skillMdHash = createHash('sha256').update(skillMd).digest('hex');
    for (const f of canonical) {
      if (f.rel === 'SKILL.md') f.hash = skillMdHash;
    }
    const comparison = compareTrees(canonical, published);
    comparisons.push({
      key,
      relRoot,
      skillDir: relative(workspaceRoot, destSkillDir).split('\\').join('/'),
      exists: existsSync(join(destSkillDir, 'SKILL.md')),
      comparison,
      publication: pub,
    });
  }

  // Also check preferred destinations even if never published.
  for (const key of preferredDestinationKeys(workspaceRoot, { onlyDetected: false })) {
    const dest = resolveDestination(workspaceRoot, key);
    if (!dest || seenRoots.has(dest.relRoot)) continue;
    const destSkillDir = join(dest.absoluteRoot, record.name);
    if (!existsSync(join(destSkillDir, 'SKILL.md'))) continue;
    seenRoots.add(dest.relRoot);
    const published = listPublishedTree(destSkillDir);
    const canonical = canonicalFiles(record);
    const skillMd = record.skillMd.endsWith('\n') ? record.skillMd : `${record.skillMd}\n`;
    const skillMdHash = createHash('sha256').update(skillMd).digest('hex');
    for (const f of canonical) {
      if (f.rel === 'SKILL.md') f.hash = skillMdHash;
    }
    comparisons.push({
      key,
      relRoot: dest.relRoot,
      skillDir: relative(workspaceRoot, destSkillDir).split('\\').join('/'),
      exists: true,
      comparison: compareTrees(canonical, published),
      publication: pubs[key] || null,
    });
  }

  return { skillId: record.id, contentHash: record.contentHash, comparisons };
}

/**
 * Import a diverged published copy back into the canonical store.
 */
export function importFromDestination(monitorDir, workspaceRoot, skillId, destinationKey) {
  const dest = resolveDestination(workspaceRoot, destinationKey);
  if (!dest) {
    const err = new Error(`Unknown destination: ${destinationKey}`);
    err.code = 'EINVAL';
    throw err;
  }
  const record = readSkill(monitorDir, skillId);
  const destSkillDir = join(dest.absoluteRoot, record.name);
  if (!existsSync(join(destSkillDir, 'SKILL.md'))) {
    const err = new Error(`No published skill at ${dest.relRoot}/${record.name}`);
    err.code = 'ENOENT';
    throw err;
  }

  const skillMd = readFileSync(join(destSkillDir, 'SKILL.md'), 'utf8');
  const resources = [];
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'SKILL.md') continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else {
        const buf = readFileSync(abs);
        resources.push({
          rel: rel.replace(/\\/g, '/'),
          contentBase64: buf.toString('base64'),
          hash: fileHash(buf),
        });
      }
    }
  }
  walk(destSkillDir);

  // Dynamic import of updateSkill to avoid circular init issues in some runners.
  return { skillMd, resources, from: relative(workspaceRoot, destSkillDir).split('\\').join('/') };
}

export { listPublishedTree, compareTrees, canonicalFiles };
