import { useEffect, useRef, useState } from 'react';

/**
 * Height-capped transcript blocks.
 *
 * A block that outgrows its cap clips (top/bottom vignette) rather than nesting
 * a scrollbar, so ClippedGrow is the single place that rule lives — thinking
 * blocks, tool rows, and agent segments all clip identically. lastPendingGate
 * answers "which row can the user still act on": the NEWEST open Approval/Ask,
 * not the first match in document order.
 */
// Matches .chat-clip-vignette h-10 — keep Allow/Deny clear of the bottom fade.
export const CLIP_VIGNETTE_PX = 40;

/**
 * The newest card still waiting on the user — an open Approval or Ask.
 *
 * `querySelector` hands back the FIRST match in document order, and that is the
 * wrong row here for two reasons: a settled Approval/Ask stays rendered as a
 * transcript record (so old rows are on screen long after they were answered),
 * and one turn can hold several gates open at once — parallel gated tool calls
 * each get their own row, and answering one does not settle the others. The row
 * the user can still act on is the NEWEST pending one, so "first match" scrolls
 * to a card whose Allow/Deny buttons are already dead and leaves the live one
 * off screen. Transcript order is document order, so the last match is the
 * newest gate.
 * @param {object} [root] subtree to search (defaults to the whole document)
 * @returns {object | null} the live CTA when it has one, else the row itself
 */
export function lastPendingGate(root = document) {
  const open = root.querySelectorAll('[data-kusa-approval="pending"], [data-kusa-ask="pending"]');
  const row = open.length ? open[open.length - 1] : null;
  if (!row) return null;
  return row.querySelector('[data-kusa-approval-cta]') || row.querySelector('[data-kusa-ask-cta]') || row;
}

/**
 * Height-capped region with no nested scrollbar. Content clips; while
 * `follow` is on the viewport pins to the bottom (programmatic scrollTop).
 * A pending approval inside the clip wins over follow: scrollTop moves so the
 * Allow/Deny CTA clears the bottom fade (vignette stays on; bottom edge is
 * suppressed while the ask is pinned). Show all / Show less toggles growth
 * into the parent transcript scroll.
 */
export function ClippedGrow({
  maxHeightPx = null,
  follow = false,
  followKey = '',
  className = '',
  children,
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [approvalCtaPinned, setApprovalCtaPinned] = useState(false);
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const cap = Number.isFinite(maxHeightPx) && maxHeightPx > 0 ? maxHeightPx : null;
  const grown = !cap || expanded;

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !cap) {
      setOverflows(false);
      return undefined;
    }
    const measure = () => {
      setOverflows(content.scrollHeight > cap + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    return () => ro.disconnect();
  }, [cap, followKey, grown]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || grown || !cap) {
      setApprovalCtaPinned(false);
      return;
    }
    // overflow:hidden still accepts scrollTop. Prefer the NEWEST open gate (ask
    // or approval) so its CTA stays clear of the bottom fade and remains
    // clickable; else pin to latest while following, or show the start of the
    // clipped region. Newest, not first: earlier rows in this clipped block are
    // settled records, and several gates can be open at once.
    const cta = lastPendingGate(content);
    if (cta) {
      const clearBottom = viewport.getBoundingClientRect().bottom - CLIP_VIGNETTE_PX;
      viewport.scrollTop += cta.getBoundingClientRect().bottom - clearBottom;
      setApprovalCtaPinned(true);
      return;
    }
    setApprovalCtaPinned(false);
    viewport.scrollTop = follow ? viewport.scrollHeight : 0;
  }, [follow, followKey, grown, cap, overflows]);

  const showVignette = Boolean(!grown && overflows);
  const showToggle = Boolean(overflows && (showVignette || (grown && expanded)));

  return (
    <div className={className}>
      <div className="relative">
        <div
          ref={viewportRef}
          className={grown ? undefined : 'overflow-hidden'}
          style={grown || !cap ? undefined : { maxHeight: cap }}
        >
          <div ref={contentRef}>{children}</div>
        </div>
        {showVignette ? (
          <>
            <div
              data-edge="top"
              className="chat-clip-vignette absolute inset-x-0 top-0 h-10"
              aria-hidden="true"
            />
            {/* Bottom fade would wash out Allow/Deny while the ask is pinned. */}
            {!approvalCtaPinned ? (
              <div
                data-edge="bottom"
                className="chat-clip-vignette absolute inset-x-0 bottom-0 h-10"
                aria-hidden="true"
              />
            ) : null}
          </>
        ) : null}
      </div>
      {showToggle ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-gray-600 hover:text-gray-400"
          aria-expanded={grown}
        >
          {grown ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  );
}
