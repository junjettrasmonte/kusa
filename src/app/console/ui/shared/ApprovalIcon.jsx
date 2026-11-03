// Approval glyph: the Lucide `shield-check` glyph — a shield carrying a check,
// "this step needs your yes/no". It is the shape the approval row wears while
// it is undecided, and the shape the sidebar borrows for a session stopped at
// that row; the colour is the caller's, never baked in.
//
// Path data is upstream's own, verbatim (Lucide, ISC License,
// lucide.dev/license), kept on lucide's native 24-unit grid and stroke 2 so the
// artwork cannot drift from the file it came from — the same rule AskIcon.jsx
// follows for its shipped glyph. Verified against
// https://lucide.dev/icons/shield-check.
export function ApprovalIcon({ className = 'text-gray-500', size = 'h-4.5 w-4.5', title = null }) {
  return (
    <svg
      className={`shrink-0 ${size} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? null : 'true'}
    >
      {title ? <title>{title}</title> : null}
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
