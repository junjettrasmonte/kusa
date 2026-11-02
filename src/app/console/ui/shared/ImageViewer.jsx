import { useEffect, useRef, useState } from 'react';

/**
 * Full-screen image popup for an attached picture.
 *
 * Fit-to-screen is the default so a large screenshot is readable the moment the
 * popup opens; Actual size and Zoom in/out live behind the context-menu icon in
 * the header so the image itself stays the focus. Escape / backdrop click /
 * Close all dismiss the same way — nothing about the attachment list changes
 * from viewing.
 */
export function ImageViewer({
  open = false,
  src = '',
  name = 'image',
  onClose,
}) {
  const [mode, setMode] = useState('fit'); // 'fit' | 'actual'
  const [zoom, setZoom] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setMode('fit');
    setZoom(1);
    setMenuOpen(false);
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, src, onClose]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [menuOpen]);

  if (!open || !src) return null;

  const scale = mode === 'actual' ? zoom : 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${name}`}
      className="fixed inset-0 z-[80] flex flex-col bg-black/80 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-800 bg-gray-950/90 px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-gray-200">{name}</p>
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            title="View options"
            aria-label="View options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((openNow) => !openNow)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-800 hover:text-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
          >
            <ContextMenuIcon />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              aria-label="Image view options"
              className="absolute right-0 top-[100%] z-10 mt-1 w-44 rounded-lg border border-gray-700 bg-gray-950 py-1 shadow-lg"
            >
              <MenuItem
                label="Zoom in"
                onSelect={() => {
                  setMode('actual');
                  setZoom((value) => Math.min(4, Math.round((value + 0.25) * 100) / 100));
                  setMenuOpen(false);
                }}
              />
              <MenuItem
                label="Zoom out"
                onSelect={() => {
                  setMode('actual');
                  setZoom((value) => Math.max(0.25, Math.round((value - 0.25) * 100) / 100));
                  setMenuOpen(false);
                }}
              />
              <MenuItem
                label="Fit to screen"
                active={mode === 'fit'}
                onSelect={() => {
                  setMode('fit');
                  setZoom(1);
                  setMenuOpen(false);
                }}
              />
              <MenuItem
                label="Actual size"
                active={mode === 'actual' && zoom === 1}
                onSelect={() => {
                  setMode('actual');
                  setZoom(1);
                  setMenuOpen(false);
                }}
              />
            </div>
          ) : null}
        </div>
        <button
          type="button"
          title="Close"
          aria-label="Close image viewer"
          onClick={() => onClose?.()}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-800 hover:text-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
        >
          <CloseIcon />
        </button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose?.();
        }}
      >
        <div className={`flex min-h-full min-w-full items-center justify-center p-4 ${
          mode === 'fit' ? '' : ''
        }`}
        >
          <img
            src={src}
            alt={name}
            draggable={false}
            className={
              mode === 'fit'
                ? 'max-h-[calc(100vh-4.5rem)] max-w-full object-contain select-none'
                : 'max-w-none select-none'
            }
            style={mode === 'actual' ? { transform: `scale(${scale})`, transformOrigin: 'center center' } : undefined}
          />
        </div>
      </div>
    </div>
  );
}

function MenuItem({ label, onSelect, active = false }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`flex w-full items-center px-3 py-1.5 text-left text-[12px] ${
        active
          ? 'bg-emerald-500/15 text-emerald-300'
          : 'text-gray-300 hover:bg-gray-800 hover:text-gray-100'
      }`}
    >
      {label}
    </button>
  );
}

/** Three-dot vertical context-menu glyph. */
function ContextMenuIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="3" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="8" cy="13" r="1.25" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path strokeLinecap="round" d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
