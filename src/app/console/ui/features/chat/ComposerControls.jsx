import { useState } from 'react';

/**
 * Composer pickers + action icons — Mode / Rules / Model dropdowns above the
 * input; context ring, attach, dictate, and live/send sit in the composer
 * footer. Values live in ChatHarness state; these components only render and
 * route a selection back through onSelect.
 */
export const AGENT_MODE_OPTIONS = [
  {
    id: 'ask',
    label: 'Ask',
    blurb: 'Read-only — search and read, no edits, no commands.',
  },
  {
    id: 'plan',
    label: 'Plan',
    blurb: 'Read-only — answers with a numbered plan.',
  },
  {
    id: 'agent',
    label: 'Agent',
    blurb: 'Read and write files; commands follow the rules.',
  },
];

/**
 * Composer Rules picker options. The ask timeout comes from Settings so the
 * blurbs match the live gate (default: 2m ask-wait). Allow / Deny are sticky:
 * the pick holds for the rest of the session, so no revert window is advertised.
 * @param {{ approvalTimeoutMinutes?: number }} [timing]
 */
export function ruleOptions(timing = {}) {
  const askMins = Math.min(60, Math.max(1, Math.floor(Number(timing.approvalTimeoutMinutes) || 2)));
  const askLabel = askMins === 1 ? '1m' : `${askMins}m`;
  return [
    {
      id: 'ask-deny',
      label: 'Ask · deny on timeout',
      blurb: `Terminal and browser calls need a yes first; no answer within ${askLabel} denies.`,
    },
    {
      id: 'ask-allow',
      label: 'Ask · allow on timeout',
      blurb: `Terminal and browser calls need a yes first; no answer within ${askLabel} allows.`,
    },
    {
      id: 'allow',
      label: 'Allow',
      blurb: 'Terminal and browser calls run as-is; the pick holds for the rest of this session.',
    },
    {
      id: 'deny',
      label: 'Deny',
      blurb: 'Terminal and browser calls are blocked; the pick holds for the rest of this session.',
    },
  ];
}

/** Static snapshot for callers that only need ids (initial rule hydrate). */
export const RULE_OPTIONS = ruleOptions();

/** Rough token budget for the context ring when the endpoint says nothing. */
export const DEFAULT_CONTEXT_LIMIT = 128_000;

function Chevron({ open }) {
  return (
    <svg
      className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 4 10 8 6 12" />
    </svg>
  );
}

/**
 * A picker: shows the current value, and clicking it opens a menu above the
 * composer (the composer sits at the bottom of the panel, so menus open up).
 * @param {string} title
 * @param {Array<{ id: string, label: string, blurb?: string }>} options
 * @param {string} value
 * @param {(id) => void} [onSelect]
 *
 * The menu is open only while the trigger button holds focus: clicking it focuses the
 * button, and any blur (selecting an option, typing in the composer, tabbing away)
 * closes it automatically — so a picker can never get stuck expanded.
 */
export function ComposerDropdown({ title, options, value, onSelect }) {
  // Focus-driven, not a toggle: blur is the only way the menu closes itself.
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.id === value) || options[0];
  const label = current?.label || value || '—';

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onClick={(e) => {
          setOpen(true);
          // Focus it explicitly: browsers are inconsistent about moving focus on a
          // mouse click, and without focus there is no blur event to close the menu.
          e.currentTarget.focus();
        }}
        onBlur={() => {
          // Deferred, never synchronous: selecting an option moves focus to that
          // option, which blurs THIS trigger first. Closing here would take the
          // menu out of the DOM before the option's own handler runs, and the
          // selection would be silently dropped. A queued task still runs before
          // the next input event is dispatched, so the menu stays reachable for
          // the rest of the click, and it still self-closes when the user types
          // in the composer or tabs away.
          if (open) setTimeout(() => setOpen(false), 0);
        }}
        title={`${title}: ${label}`}
        aria-label={title}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-gray-500 hover:text-gray-200 hover:bg-gray-800/70"
      >
        <span className="text-gray-600">{title}</span>
        <span className="text-gray-200">{label}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div
          className={`absolute left-0 bottom-[100%] w-[16rem] rounded-lg border border-gray-700 bg-gray-950 shadow-lg ${
            title === 'Model' ? 'divide-y divide-gray-800' : ''
          }`}
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onMouseDown={(e) => {
                // Press, not release: the trigger's blur can close the menu before
                // `click` is dispatched, and a released click would then land on
                // whatever sits behind the removed menu. mousedown always fires
                // while the option is still in the DOM, so the selection cannot
                // be lost. Left button only (right-click is a context menu).
                if (e && typeof e.button === 'number' && e.button !== 0) return;
                setOpen(false);
                onSelect?.(option.id);
              }}
              className={`block w-full px-2.5 py-1.5 text-[11px] leading-snug text-left ${
                option.id === value
                  ? 'bg-gray-800/70 font-medium text-emerald-300'
                  : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
              }`}
            >
              <span className="font-medium">{option.label}</span>
              {option.blurb ? (
                <span className="ml-1.5 text-gray-500">· {option.blurb}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * Estimated context window usage as a ring; counts live in the tooltip.
 * Deliberately neutral: the meter is a readout, not an alert, so it uses the
 * gray ramp (track = the same gray at low opacity, arc = the full gray) instead
 * of the kusa-blue brand accent. Only real pressure escalates.
 */
export function ContextRing({ used, limit = DEFAULT_CONTEXT_LIMIT }) {
  const max = Number(limit) > 0 ? Number(limit) : DEFAULT_CONTEXT_LIMIT;
  const usedN = Math.max(0, Math.round(Number(used) || 0));
  const ratio = Math.min(1, Math.max(0, usedN / max));
  const pct = Math.round(ratio * 100);
  const circumference = 2 * Math.PI * 6.5;
  const arc = ratio * circumference;
  // Neutral by default — gray-400 arc over a 22%-opacity gray-400 track reads as
  // light gray on dark gray, and the gray ramp is remapped by
  // html[data-theme="light"] so this follows the theme with no extra classes.
  const tone = ratio >= 0.9 ? 'text-rose-400' : ratio >= 0.7 ? 'text-amber-400' : 'text-gray-400';
  const tip = `Context ${formatTokens(usedN)} / ${formatTokens(max)} (${pct}%)`;
  return (
    <span
      className={`inline-flex h-8 w-8 items-center justify-center ${tone}`}
      title={tip}
      aria-label={tip}
    >
      <svg className="h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
        <circle cx="10" cy="10" r="6.5" strokeWidth="2.25" opacity="0.22" />
        <circle
          cx="10"
          cy="10"
          r="6.5"
          strokeWidth="2.25"
          strokeDasharray={`${arc} ${circumference - arc}`}
          strokeDashoffset={circumference / 4}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** Shared stroke wrapper for composer footer icons. */
function ComposerSvg({ children }) {
  return (
    <svg
      className="h-[18px] w-[18px]"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * Attachment — classic diagonal paperclip (the usual “attach file” glyph).
 * Own viewBox so the long open wire stays legible at 18px; stroke weight is
 * matched to the other composer footer icons.
 */
export function AttachmentIcon() {
  return (
    <svg
      className="h-[18px] w-[18px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

/**
 * What the paperclip's context menu offers. Two ways a file can enter a
 * message, and only these two: the OS file dialog hands over a real file the
 * browser can read, and the clipboard hands over what the user just cut or
 * screenshotted. Everything else (drag-and-drop, a typed path) the browser
 * cannot see as a file, so it is not offered.
 */
export const ATTACHMENT_ACTIONS = [
  {
    id: 'files',
    label: 'Add Files',
    hint: 'Choose a file from your computer — the operating system opens its own dialog.',
    icon: FileChooseIcon,
  },
  {
    id: 'clipboard',
    label: 'Paste From Clipboard',
    hint: 'Take the image or text the clipboard is holding now — where the browser cannot read it without asking, paste it and this takes that paste.',
    icon: ClipboardIcon,
  },
];

/** A sheet of paper — the OS file dialog. */
function FileChooseIcon() {
  return (
    <ComposerSvg>
      <path strokeLinejoin="round" d="M4 2.5h5.5l2.5 2.5v10h-8v-12.5z" />
      <path strokeLinejoin="round" d="M9.5 2.5l2.5 2.5M9.5 2.5v2.5h2.5" />
      <path strokeLinecap="round" d="M5.5 7h4M5.5 9.5h4" />
    </ComposerSvg>
  );
}

/** A clipboard with a clipped sheet — the clipboard paste. */
function ClipboardIcon() {
  return (
    <ComposerSvg>
      <rect x="3.5" y="3.5" width="9" height="11" rx="1.5" />
      <path strokeLinejoin="round" d="M6 2.5h4v1.5h-4z" />
      <path strokeLinecap="round" d="M6 7h4M6 9.5h4" />
    </ComposerSvg>
  );
}

/**
 * The paperclip and its context menu. Hovering the paperclip (or tabbing to
 * one of its options) reveals the two ways a file can enter this message; the
 * menu itself is always in the DOM and only hidden by CSS (.chat-attach-menu /
 * .chat-attach-group in index.css), the same mechanism the rail submenus use,
 * so a screenshot script or a keyboard user can still reach an option they
 * have not hovered yet. It opens UPWARD and hangs to the LEFT of the paperclip
 * (`right-0 bottom-[100%]`): the composer sits against the bottom-right of the
 * panel, so a menu that grew down or to the right would always run past the
 * viewport.
 *
 * State stays with ChatHarness — this component only routes which action the
 * user picked, exactly like ComposerDropdown routes a picker selection.
 * @param {Array<{ id, label, hint, icon }>} actions
 * @param {(id: string) => void} onAction
 */
export function AttachmentPicker({ actions = ATTACHMENT_ACTIONS, onAction }) {
  return (
    <div className="chat-attach-group relative inline-flex h-8 w-8 items-center justify-center">
      <span
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400"
        title="Attach a file to this message — hover for its options"
      >
        <AttachmentIcon />
      </span>
      <div
        role="menu"
        aria-label="Attach a file to this message"
        className="chat-attach-menu absolute right-0 bottom-[100%] z-30 w-[15rem] rounded-lg border border-gray-700 bg-gray-950 shadow-lg divide-y divide-gray-800"
      >
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            title={action.hint}
            aria-label={action.label}
            onClick={() => onAction?.(action.id)}
            className="flex w-full h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-left transition-colors text-gray-400 hover:bg-gray-800 hover:text-gray-100"
          >
            {action.icon}
            <span className="whitespace-nowrap">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Dictation placeholder — microphone, no speech capture yet. */
export function DictateIcon() {
  return (
    <ComposerSvg>
      <rect x="6" y="1.75" width="4" height="7" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7.75a4 4 0 0 0 8 0M8 11.75v2.5" />
    </ComposerSvg>
  );
}

/** Live voice — waveform bars for the empty-composer primary action. */
export function VoiceIcon() {
  return (
    <ComposerSvg>
      <path strokeLinecap="round" d="M3 6.5v3M5.5 4.5v7M8 3v10M10.5 5.5v5M13 7v2" />
    </ComposerSvg>
  );
}
