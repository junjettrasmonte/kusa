/**
 * 16×16 stroke icons for the sidebar Explorer tree.
 *
 * Same visual language as RightRail.jsx / SubTabIcons.jsx / IconButton.jsx: no
 * fill, currentColor stroke, strokeWidth 1.5, round caps + joins, aria-hidden —
 * the file name next to the glyph carries the accessible name.
 *
 * Keys are the file-type ids emitted by collectWorkspaceTree
 * (src/features/explorer/tree.mjs): folder, file, code, doc, data, image,
 * script, binary, config.
 */
export const FILE_ICONS = {
  /** Folder — the same tabbed folder the sidebar Explorer icon uses. */
  folder: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 4h3.5l1.5 1.5h6v7h-11z" />
    </svg>
  ),
  /** Plain file — page with a folded corner. */
  file: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 2.5h4l2.5 2.5v7.5h-6.5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 2.5v2.5h2.5" />
    </svg>
  ),
  /** Source code — angle brackets. */
  code: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.2 5.5 4.2 8 6.2 10.5M9.8 5.5 11.8 8 9.8 10.5" />
    </svg>
  ),
  /** Markdown / prose — page with text lines. */
  doc: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 2.5h4l2.5 2.5v7.5h-6.5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 2.5v2.5h2.5" />
      <path strokeLinecap="round" d="M6.5 7h3M6.5 9.5h3" />
    </svg>
  ),
  /** Data / config manifests — brackets. */
  data: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 2.5h4l2.5 2.5v7.5h-6.5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 2.5v2.5h2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.2 6.2h1.2M8.6 6.2h1.2M6.2 10.2h1.2M8.6 10.2h1.2M6.2 6.2v4M9.8 6.2v4" />
    </svg>
  ),
  /** Images — frame with a horizon. */
  image: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5h10v7h-10z" />
      <circle cx="5.6" cy="7" r="1" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 11.5 6.5 8.5 8.5 11.5M8 11.5 10 9.5 12 11.5" />
    </svg>
  ),
  /** Shell / scripts — terminal window. */
  script: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h10v8h-10z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 6.5 7.5 8.5 5.5 10.5" />
      <path strokeLinecap="round" d="M8.5 10.5h2.5" />
    </svg>
  ),
  /** Binaries / archives — crate. */
  binary: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 5.5h9v6h-9z" />
      <path strokeLinecap="round" d="M3.5 8.5h9M8 5.5v6" />
    </svg>
  ),
  /** Dotfiles and project manifests — gear. */
  config: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path strokeLinecap="round" d="M8 3.5v1.5M8 11v1.5M3.5 8h1.5M11 8h1.5M5.2 5.2l1 1M9.8 9.8l1 1M10.8 5.2l-1 1M5.2 10.8l1-1" />
    </svg>
  ),
};
