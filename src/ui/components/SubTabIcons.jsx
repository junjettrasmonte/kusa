/**
 * 16×16 stroke icons for the main pane topbar sub-tabs.
 * Same visual language as RightRail.jsx / IconButton.jsx: no fill, currentColor
 * stroke, strokeWidth 1.5, round caps + joins, aria-hidden (the label carries the
 * accessible name).
 *
 * Keys are the sub-tab ids declared in lib/format.js (MONITOR_SUBTAB_IDS,
 * SESSION_SUBTAB_IDS, DEVTOOLS_SUBTAB_IDS, HARNESS_SUBTAB_IDS,
 * SETTINGS_SUBTAB_IDS).
 */
export const SUBTAB_ICONS = {
  /** Monitors › Counters — bar chart on a baseline. */
  counters: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 13.5h11M5 13.5V8.5M8 13.5V4M11 13.5V10.5" />
    </svg>
  ),
  /** Monitors › Tokens — hash glyph (token counts). */
  tokens: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" d="M6.5 3.5 5.2 12.5M11 3.5 9.7 12.5M3.5 6.2h9.5M2.8 9.8h9.5" />
    </svg>
  ),
  /** Monitors › Events — activity pulse. */
  events: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 8h2.5l1.5-4.5 2.5 9 1.5-4.5H14" />
    </svg>
  ),
  /** Monitors › Warnings — triangle with an exclamation. */
  warnings: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 2.5 3 13.5h10z" />
      <path strokeLinecap="round" d="M8 6.5v3.5M8 11.6v.2" />
    </svg>
  ),
  /** Monitors › Quality — check inside a badge. */
  quality: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.3 8.2 7.2 10.2 10.8 5.8" />
    </svg>
  ),

  /** Chat Session › Kusă Chat — speech bubble. */
  chat: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 3.5h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-2.5 2v-2h-1a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" />
    </svg>
  ),
  /** Chat Session › Prompt History — bulleted list. */
  prompts: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" d="M3 4.5h1.5M6 4.5h7M3 8h1.5M6 8h7M3 11.5h1.5M6 11.5h7" />
    </svg>
  ),
  /** Chat Session › Tool Call Viewer — adjustment sliders. */
  tools: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" d="M2.5 5h11M2.5 11h11" />
      <circle cx="5.5" cy="5" r="1.6" />
      <circle cx="10.5" cy="11" r="1.6" />
    </svg>
  ),

  /** Developer Tools › Git — branch graph. */
  git: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="4.5" cy="4.5" r="1.8" />
      <circle cx="4.5" cy="11.5" r="1.8" />
      <circle cx="11.5" cy="8" r="1.8" />
      <path strokeLinecap="round" d="M4.5 6.3v3.4M6.3 8h3.4" />
    </svg>
  ),
  /** Developer Tools › Trail — dotted route between two nodes. */
  trail: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="4" cy="12" r="1.8" />
      <circle cx="12" cy="4" r="1.8" />
      <path strokeDasharray="1.5 2" strokeLinecap="round" d="M5.5 10.5C7 8 9 8 10.5 5.5" />
    </svg>
  ),

  /** Harness › MCP Server — plug / connection node. */
  mcp: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" d="M8 2.5v3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 5.5h5v2.5a2.5 2.5 0 0 1-5 0v-2.5z" />
      <path strokeLinecap="round" d="M8 10.5v3" />
    </svg>
  ),
  /** Harness › Skills — award ribbon. */
  skills: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="6" r="3.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.3 8.7 5.5 14 8 12.3 10.5 14 9.7 8.7" />
    </svg>
  ),
  /** Harness › Knowledgebase — stacked books. */
  knowledgebase: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3.5h4.5v9h-4.5zM8.5 5h4.5v7.5h-4.5z" />
      <path strokeLinecap="round" d="M4.2 6h2M10 7.5h1.6" />
    </svg>
  ),

  /** Settings › Agent — robot head. */
  agent: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 5.5h8v6h-8z" />
      <path strokeLinecap="round" d="M8 3v2.5M6 8v1.5M10 8v1.5M6.5 11.5h3" />
    </svg>
  ),
  /** Settings › Playback — play triangle. */
  playback: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 3.5 12.5 8 5.5 12.5z" />
    </svg>
  ),
  /** Settings › Workspace — folder. */
  workspace: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 4h3.5l1.5 1.5h6v7h-11z" />
    </svg>
  ),
  /** Settings › SDK listener — radio waves (listening). */
  sdk: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="1.5" />
      <path strokeLinecap="round" d="M5 11a4.2 4.2 0 0 1 6-6M3 13a7 7 0 0 1 10-10" />
    </svg>
  ),
};
