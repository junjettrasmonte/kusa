/**
 * Copilot SDK session listener for the Agentic Development Console.
 *
 * Attaches to a session-like object that exposes `on(type, handler)` /
 * `on(handler)` as documented for `@github/copilot-sdk` CopilotSession.
 *
 * Live attachment uses Copilot CLI extensions:
 *   import { joinSession } from "@github/copilot-sdk/extension";
 *   const session = await joinSession({}); // requires SESSION_ID from CLI
 *
 * VS Code Copilot Chat, VS Code Local, and Cursor cannot be joined through
 * this public API — start() records an unsupported/disconnected status and
 * leaves hooks-only monitoring in place.
 */
import {
  DEFAULT_SDK_SETTINGS,
  SDK_JOIN_TARGETS,
  SDK_MONITOR_TYPES,
  normalizeSdkEvent,
  sdkDedupeKey,
} from './sdk-normalize.mjs';
import {
  defaultMonitorDir,
  loadMonitorSettings,
  readMonoClock,
  runSdkEvent,
  updateSdkListenerStatus,
} from './lib.mjs';

export {
  DEFAULT_SDK_SETTINGS,
  SDK_JOIN_TARGETS,
  SDK_MONITOR_TYPES,
  normalizeSdkEvent,
  sdkDedupeKey,
};

/**
 * @typedef {'idle'|'connecting'|'connected'|'disconnected'|'unsupported'|'error'} ListenerStatus
 */

export class SessionListener {
  /**
   * @param {object} [options]
   * @param {string} [options.dir] monitor data directory
   * @param {string} [options.target] key in SDK_JOIN_TARGETS
   * @param {string} [options.sessionId]
   * @param {object} [settings] overrides for collectReasoning* / enabled
   * @param {(event: object) => void} [options.onEvent] test hook after apply
   * @param {(err: Error) => void} [options.onError]
   */
  constructor(options = {}) {
    this.dir = options.dir || defaultMonitorDir();
    this.target = options.target || 'copilot-cli';
    this.sessionId = options.sessionId || process.env.SESSION_ID || null;
    this.settings = { ...DEFAULT_SDK_SETTINGS, ...(options.settings || {}) };
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this.onError = typeof options.onError === 'function' ? options.onError : null;
    this._unsubscribes = [];
    this._queue = Promise.resolve();
    this._status = 'idle';
    this._lastEventAtWall = null;
    this._lastEventType = null;
    this._startedAtWall = null;
    this._session = null;
  }

  get status() {
    return this._status;
  }

  get lastEventAtWall() {
    return this._lastEventAtWall;
  }

  /** Refresh settings from disk (and optional overrides). */
  refreshSettings(overrides = {}) {
    const disk = loadMonitorSettings(this.dir);
    this.settings = { ...DEFAULT_SDK_SETTINGS, ...disk, ...overrides };
    return this.settings;
  }

  /**
   * Attach to a session-like object. Does not call joinSession itself — the
   * Copilot CLI extension entrypoint obtains the session and passes it here.
   *
   * @param {{ on: Function, sessionId?: string }|null} session
   * @param {object} [meta]
   */
  start(session, meta = {}) {
    this.stop({ silent: true });
    this.refreshSettings(meta.settings || {});

    const targetInfo = SDK_JOIN_TARGETS[this.target] || {
      supported: false,
      label: this.target,
      note: 'Unknown session target.',
    };

    if (!this.settings.sdkListenerEnabled) {
      this._setStatus('disconnected', {
        reason: 'disabled',
        detail: 'SDK listener disabled in monitor settings.',
        target: this.target,
      });
      return this;
    }

    if (!targetInfo.supported) {
      this._setStatus('unsupported', {
        reason: 'unsupported-target',
        detail: targetInfo.note,
        target: this.target,
        label: targetInfo.label,
      });
      return this;
    }

    if (!session || typeof session.on !== 'function') {
      this._setStatus('error', {
        reason: 'no-session',
        detail: 'joinSession() did not yield a session with on(). Hooks-only monitoring remains active.',
        target: this.target,
      });
      return this;
    }

    if (meta.sessionId) this.sessionId = meta.sessionId;
    else if (session.sessionId) this.sessionId = session.sessionId;
    else if (process.env.SESSION_ID) this.sessionId = process.env.SESSION_ID;

    this._session = session;
    this._startedAtWall = Date.now();
    this._setStatus('connecting', {
      reason: 'attaching',
      detail: 'Subscribing to Copilot SDK session events.',
      target: this.target,
      sessionId: this.sessionId,
    });

    const handler = (event) => {
      this._enqueue(() => this._handleRaw(event));
    };

    try {
      // Prefer a single catch-all subscription so each event is delivered once.
      // Fall back to per-type subscriptions only when catch-all is unavailable.
      let subscribed = false;
      try {
        const unsubAll = session.on(handler);
        if (typeof unsubAll === 'function') this._unsubscribes.push(unsubAll);
        subscribed = true;
      } catch (err) {
        this._reportError(err);
      }
      if (!subscribed) {
        for (const type of SDK_MONITOR_TYPES) {
          try {
            const unsub = session.on(type, handler);
            if (typeof unsub === 'function') this._unsubscribes.push(unsub);
            subscribed = true;
          } catch {
            /* typed on() may throw for unknown types on older SDKs — ignore */
          }
        }
      }
      if (!subscribed) {
        this._setStatus('error', {
          reason: 'subscribe-failed',
          detail: 'session.on() did not accept a handler.',
          target: this.target,
        });
        return this;
      }

      this._setStatus('connected', {
        reason: 'joined',
        detail: targetInfo.note,
        target: this.target,
        sessionId: this.sessionId,
      });
    } catch (err) {
      this._reportError(err);
      this._setStatus('error', {
        reason: 'subscribe-failed',
        detail: err?.message || String(err),
        target: this.target,
      });
    }

    return this;
  }

  /**
   * Mark disconnected / unsupported without a session object.
   * Used by the extension when joinSession cannot run (missing SESSION_ID).
   */
  markUnavailable(reason, detail) {
    const targetInfo = SDK_JOIN_TARGETS[this.target];
    const unsupported = targetInfo && !targetInfo.supported;
    this._setStatus(unsupported ? 'unsupported' : 'disconnected', {
      reason: reason || (unsupported ? 'unsupported-target' : 'unavailable'),
      detail: detail || (targetInfo?.note ?? 'SDK listener not attached.'),
      target: this.target,
    });
    return this;
  }

  stop(options = {}) {
    for (const unsub of this._unsubscribes) {
      try { unsub(); } catch { /* ignore */ }
    }
    this._unsubscribes = [];
    this._session = null;
    if (!options.silent) {
      this._setStatus('disconnected', {
        reason: options.reason || 'stopped',
        detail: options.detail || 'SDK session listener stopped.',
        target: this.target,
        sessionId: this.sessionId,
      });
    }
    return this;
  }

  /** Feed one raw or already-normalized event (tests / reconnect replay). */
  ingest(rawOrNormalized, options = {}) {
    return this._enqueue(() => this._handleRaw(rawOrNormalized, options));
  }

  _enqueue(fn) {
    this._queue = this._queue.then(fn, fn);
    return this._queue;
  }

  async _handleRaw(raw, options = {}) {
    try {
      if (!this.settings.sdkListenerEnabled) return null;

      const normalized = raw && raw.source === 'sdk' && raw.type && raw.wall != null
        ? raw
        : normalizeSdkEvent(raw, {
          sessionId: this.sessionId,
          nowWall: options.nowWall ?? Date.now(),
          collectReasoningEvents: this.settings.collectReasoningEvents,
          persistReasoningText: this.settings.persistReasoningText,
        });
      if (!normalized) return null;

      // Duplicate protection lives in runSdkEvent / applySdkMonitorEvent (seen[]).
      const clock = readMonoClock();
      const state = runSdkEvent({
        dir: this.dir,
        event: normalized,
        nowWall: options.nowWall ?? normalized.wall ?? Date.now(),
        nowMono: options.nowMono ?? clock.mono,
        bootId: options.bootId ?? clock.bootId,
        listenerStatus: {
          status: this._status,
          target: this.target,
          sessionId: this.sessionId,
          lastEventAtWall: normalized.wall,
          lastEventType: normalized.type,
          startedAtWall: this._startedAtWall,
        },
      });

      this._lastEventAtWall = normalized.wall;
      this._lastEventType = normalized.type;
      if (this.onEvent) this.onEvent(normalized, state);
      return state;
    } catch (err) {
      this._reportError(err);
      this._setStatus('error', {
        reason: 'apply-failed',
        detail: err?.message || String(err),
        target: this.target,
      });
      return null;
    }
  }

  _setStatus(status, extra = {}) {
    this._status = status;
    try {
      updateSdkListenerStatus(this.dir, {
        status,
        target: this.target,
        sessionId: this.sessionId,
        lastEventAtWall: this._lastEventAtWall,
        lastEventType: this._lastEventType,
        startedAtWall: this._startedAtWall,
        updatedAtWall: Date.now(),
        ...extra,
      });
    } catch (err) {
      this._reportError(err);
    }
  }

  _reportError(err) {
    if (this.onError) {
      try { this.onError(err instanceof Error ? err : new Error(String(err))); } catch { /* ignore */ }
    } else if (err) {
      try { process.stderr.write(`kusa sdk-listener: ${err?.message || err}\n`); } catch { /* ignore */ }
    }
  }
}

/** Lightweight in-memory session for unit tests (mirrors CopilotSession.on). */
export class SimulatedSdkSession {
  constructor(sessionId = 'sim-session') {
    this.sessionId = sessionId;
    /** @type {{ type: string|null, handler: Function }[]} */
    this._handlers = [];
  }

  on(typeOrHandler, maybeHandler) {
    const typed = typeof typeOrHandler === 'string';
    const type = typed ? typeOrHandler : null;
    const handler = typed ? maybeHandler : typeOrHandler;
    if (typeof handler !== 'function') throw new TypeError('handler required');
    const entry = { type, handler };
    this._handlers.push(entry);
    return () => {
      this._handlers = this._handlers.filter((h) => h !== entry);
    };
  }

  emit(event) {
    for (const { type, handler } of this._handlers) {
      if (!type || type === event.type) handler(event);
    }
  }
}
