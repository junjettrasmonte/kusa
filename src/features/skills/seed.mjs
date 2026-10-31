/**
 * Non-destructive starter seeding and restore-default.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildSkillMarkdown } from './model.mjs';
import { STARTER_SKILLS, starterById } from './starters.mjs';
import {
  createSkill,
  ensureSkillsStore,
  getRegistry,
  markRegistrySeeded,
  readSkill,
  skillsRoot,
  updateSkill,
} from './store.mjs';

function starterMarkdown(starter) {
  return buildSkillMarkdown(
    {
      name: starter.name,
      description: starter.description,
      metadata: {
        kusaStarter: starter.starterId,
        category: starter.category,
      },
    },
    starter.body,
  );
}

/**
 * Seed missing starters. Never overwrites user-created or user-modified skills.
 * Repeatable across upgrades.
 */
export function seedStarterSkills(monitorDir, { forceMissingOnly = true } = {}) {
  ensureSkillsStore(monitorDir);
  const root = skillsRoot(monitorDir);
  const created = [];
  const skipped = [];

  for (const starter of STARTER_SKILLS) {
    const dir = join(root, starter.name);
    const exists = existsSync(join(dir, 'SKILL.md'));
    if (exists) {
      skipped.push({ id: starter.name, reason: 'already-exists' });
      continue;
    }
    if (!forceMissingOnly && exists) {
      skipped.push({ id: starter.name, reason: 'already-exists' });
      continue;
    }
    createSkill(monitorDir, {
      skillMd: starterMarkdown(starter),
      category: starter.category,
      starterId: starter.starterId,
      starterCustomized: false,
    });
    created.push(starter.name);
  }

  const registry = markRegistrySeeded(monitorDir);
  return {
    created,
    skipped,
    seededAtWall: registry.seededAtWall,
    starters: STARTER_SKILLS.map((s) => s.starterId),
  };
}

/**
 * Restore a starter to its default content.
 * Refuses to silently destroy customized content unless confirmCustomized is true.
 */
export function restoreStarterSkill(monitorDir, skillId, { confirmCustomized = false } = {}) {
  const record = readSkill(monitorDir, skillId);
  const starterId = record.starterId || skillId;
  const starter = starterById(starterId);
  if (!starter) {
    const err = new Error(`Not a known starter skill: ${skillId}`);
    err.code = 'EINVAL';
    throw err;
  }
  if (record.starterCustomized && !confirmCustomized) {
    const err = new Error(
      'Starter has been customized. Pass confirmCustomized to restore the default and discard local edits.',
    );
    err.code = 'ECONFIRM';
    throw err;
  }

  const skillMd = starterMarkdown(starter);
  // Keep the directory / id as the starter name.
  return updateSkill(monitorDir, skillId, {
    skillMd,
    category: starter.category,
    resources: [],
    starterCustomized: false,
  });
}

export function listStarterCatalog() {
  return STARTER_SKILLS.map((s) => ({
    starterId: s.starterId,
    name: s.name,
    description: s.description,
    category: s.category,
  }));
}

export function ensureSkillsInitialized(monitorDir) {
  ensureSkillsStore(monitorDir);
  const registry = getRegistry(monitorDir);
  // Always try to fill any missing starters (non-destructive).
  return seedStarterSkills(monitorDir);
}
