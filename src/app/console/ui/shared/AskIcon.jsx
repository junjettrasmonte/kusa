/**
 * Ask icon: the Lucide `message-circle-question-mark` glyph — a speech bubble
 * carrying a question mark — the set's shipped SVG copied verbatim into a data
 * URI, not drawn here. Lucide v1.64.0, ISC License (lucide.dev/license); the markup is upstream's own
 * attributes and path data, reflowed onto one line and percent-encoded at module
 * load so the URI cannot drift from the file it came from. Verified against
 * https://lucide.dev/icons/message-circle-question-mark.
 *
 * It is the plain reading of "the model is asking": a question mark inside the
 * speech bubble the model actually spoke in, so the glyph and the transcript row
 * it marks agree on where the question came from — and it pairs with ApprovalIcon
 * as the same bubble with a check.
 *
 * The URI is painted through a CSS mask rather than an <img src> for one reason:
 * the card tints this glyph by state — violet while asking, emerald once
 * answered, gray when nobody answered — and an <img> cannot follow currentColor
 * across those states. Masking keeps the shipped artwork untouched while the
 * colour still comes from the className the call sites pass.
 *
 * Stroke is Lucide's own 2 on its native 24-unit grid, so at the chat's 18px box
 * it renders 1.5px — exactly the ink weight the hand-drawn glyphs in ui/shared/
 * carry. The artwork is never rescaled, only the box: 18px is the smallest size
 * at which lucide's own stroke still lands on 1.5px, so the glyph needs no
 * compensation at all. The paired ApprovalIcon.jsx sits on the same grid at the
 * same weight in the same box.
 *
 * It lives in its own module because two views need it: the chat transcript draws
 * it on the question card, and the sidebar draws it in place of a session's
 * status dot while that session is waiting for an answer. `size` is a prop
 * rather than a fixed class so the same artwork can wear the chat's 18px and the
 * sidebar's smaller row without fighting Tailwind's stylesheet order.
 */
const ASK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>'
  + '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';
const ASK_ICON_URI = `data:image/svg+xml,${encodeURIComponent(ASK_ICON_SVG)}`;

export function AskIcon({ className = 'text-gray-500', size = 'h-4.5 w-4.5', title = null }) {
  return (
    <span
      className={`inline-block shrink-0 ${size} ${className}`}
      style={{
        backgroundColor: 'currentColor',
        maskImage: `url("${ASK_ICON_URI}")`,
        maskSize: 'contain',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskImage: `url("${ASK_ICON_URI}")`,
        WebkitMaskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
      }}
      title={title || undefined}
      aria-hidden={title ? null : 'true'}
    />
  );
}
