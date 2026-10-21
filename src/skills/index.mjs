/**
 * Public Skills API for Kusă (editor, store, publish, import/export).
 */
export {
  parseSkillMarkdown,
  buildSkillMarkdown,
  applyFrontmatterEdits,
  normalizeSkillName,
  skillSummary,
  SKILL_NAME_RE,
  RESOURCE_DIRS,
} from './model.mjs';

export {
  validateSkillName,
  validateSkillMarkdown,
  validateResourcePath,
  validateImportRoot,
} from './validate.mjs';

export {
  AGENT_CAPABILITIES,
  detectAgentCapabilities,
  destinationKey,
  resolveDestination,
  groupDestinationsByPath,
  preferredDestinationKeys,
} from './agents.mjs';

export {
  skillsRoot,
  ensureSkillsStore,
  listSkills,
  readSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  duplicateSkill,
  updatePublications,
  getRegistry,
  skillDirPath,
} from './store.mjs';

export {
  publishSkill,
  compareSkillPublications,
  importFromDestination,
} from './publish.mjs';

export {
  importSkillFromDirectory,
  importSkillFromFiles,
  exportSkillToDirectory,
  exportSkillFiles,
} from './io.mjs';

export {
  seedStarterSkills,
  restoreStarterSkill,
  listStarterCatalog,
  ensureSkillsInitialized,
} from './seed.mjs';

export { STARTER_SKILLS, starterById } from './starters.mjs';
