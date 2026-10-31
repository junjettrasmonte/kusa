// Approval glyph: the Lucide `message-circle-check` glyph — a speech bubble
// carrying a check, "this step needs your yes/no". It is the shape the approval
// row wears while it is undecided, and the shape the sidebar borrows for a
// session stopped at that row; the colour is the caller's, never baked in.
//
// Path data is upstream's own, verbatim (Lucide v1.64.0, ISC License,
// lucide.dev/license), kept on lucide's native 24-unit grid and stroke 2 so the
// artwork cannot drift from the file it came from — the same rule AskIcon.jsx
// follows for its shipped glyph. Verified against
// https://lucide.dev/icons/message-circle-check.
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
      <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
      <path d="m16 9-5.5 5.5L8 12" />
    </svg>
  );
}
