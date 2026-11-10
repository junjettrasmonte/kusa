/**
 * Atlassian Adapter — built-in Kusă extension.
 *
 * Owns Jira Cloud credentials (encrypted API token), `/adapters/atlassian/*`,
 * and the console UI under `ui/` (settings + ticket views). Core only imports
 * this package — it does not keep an Atlassian feature folder of its own.
 *
 * Catalog id: `atlassian-adapter` · Folder: `extensions/atlassian-adapter/`
 */
export { handleAtlassianHttp } from './http.mjs';
export {
  addComment,
  adfToText,
  createAgileClient,
  createJiraClient,
  getIssue,
  listAssignedIssues,
  listComments,
  listLabels,
  listMyIssues,
  listProjectMembers,
  listProjects,
  listProjectSprints,
  listProjectStatuses,
  listSprintIssues,
  listTransitions,
  probeAtlassian,
  textToAdf,
  transitionIssue,
  updateIssue,
} from './client.mjs';
export {
  ATLASSIAN_SETTINGS_DEFAULTS,
  mergeAtlassianSettingsPatch,
  normalizeAtlassianSettings,
  publicAtlassianSettings,
} from './settings.mjs';

export const ADAPTER_ID = 'atlassian';
export const ADAPTER_NAME = 'Atlassian Adapter';
