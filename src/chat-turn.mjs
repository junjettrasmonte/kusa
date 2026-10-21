/**
 * In-memory live state for a running Kusă chat turn.
 *
 * The agent loop outlives any single browser SSE connection: listeners
 * subscribe/unsubscribe freely, and the final assistant message is written to
 * the chat sidecar so a refresh can resume or see the completed reply.
 */
import { randomUUID } from 'node:crypto';
import { readChatSession, writeChatSession } from './chat-store.mjs';

function newMessageId() {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function emptyLive() {
  return { text: '', thinking: '', tools: [], parts: [] };
}

export function mirrorsFromParts(parts) {
  const thinking = (parts || [])
    .filter((p) => p.type === 'thinking' && p.text)
    .map((p) => p.text)
    .join('\n\n');
  const tools = (parts || [])
    .filter((p) => p.type === 'tool' && p.tool)
    .map((p) => p.tool);
  return { thinking, tools };
}

function applyThinkingToParts(parts, ev) {
  const next = [...(parts || [])];
  const chunk = typeof ev.text === 'string' ? ev.text : '';
  const delta = typeof ev.delta === 'string' ? ev.delta : '';
  const last = next[next.length - 1];
  if (last?.type === 'thinking') {
    const text = chunk || `${last.text || ''}${delta}`;
    next[next.length - 1] = { type: 'thinking', text };
  } else {
    next.push({ type: 'thinking', text: chunk || delta || '' });
  }
  return next;
}

function applyToolToParts(parts, tool) {
  const next = [...(parts || [])];
  const idx = next.findIndex((p) => p.type === 'tool' && p.tool?.id === tool.id);
  if (idx >= 0) {
    next[idx] = { type: 'tool', tool: { ...next[idx].tool, ...tool } };
    return next;
  }
  next.push({ type: 'tool', tool });
  return next;
}

function applyApprovalToParts(parts, approval) {
  const next = [...(parts || [])];
  const idx = next.findIndex((p) => p.type === 'approval' && p.approval?.id === approval.id);
  if (idx >= 0) {
    next[idx] = { type: 'approval', approval: { ...next[idx].approval, ...approval } };
    return next;
  }
  next.push({ type: 'approval', approval });
  return next;
}

/** Merge one kusa_ask frame into the transcript by id (pending → answered). */
function applyAskToParts(parts, ask) {
  const next = [...(parts || [])];
  const idx = next.findIndex((p) => p.type === 'ask' && p.ask?.id === ask.id);
  if (idx >= 0) {
    next[idx] = { type: 'ask', ask: { ...next[idx].ask, ...ask } };
    return next;
  }
  next.push({ type: 'ask', ask });
  return next;
}

export function cloneLive(live) {
  const parts = (live?.parts || []).map((p) => {
    if (p.type === 'tool') return { type: 'tool', tool: { ...p.tool } };
    if (p.type === 'approval') return { type: 'approval', approval: { ...p.approval } };
    if (p.type === 'ask') {
      return {
        type: 'ask',
        ask: {
          ...p.ask,
          options: (Array.isArray(p.ask?.options) ? p.ask.options : []).map((o) => ({ ...o })),
          answer: p.ask?.answer ? { ...p.ask.answer } : p.ask?.answer,
        },
      };
    }
    return { ...p };
  });
  const mirrors = mirrorsFromParts(parts);
  return {
    text: live?.text || '',
    thinking: mirrors.thinking,
    tools: mirrors.tools.map((t) => ({ ...t })),
    parts,
  };
}

/** Apply one agent stream event onto a turn job's live snapshot. */
export function ingestTurnEvent(job, ev) {
  if (!job?.live || !ev || typeof ev !== 'object') return;
  const type = ev.type || 'message';
  if (type === 'thinking') {
    job.live.parts = applyThinkingToParts(job.live.parts, ev);
    const mirrors = mirrorsFromParts(job.live.parts);
    job.live.thinking = mirrors.thinking;
    job.live.tools = mirrors.tools;
    return;
  }
  if (type === 'content') {
    job.live.text = typeof ev.text === 'string'
      ? ev.text
      : `${job.live.text || ''}${ev.delta || ''}`;
    return;
  }
  if (type === 'tool_start') {
    const tool = {
      id: ev.id,
      name: ev.name,
      args: ev.args,
      status: 'running',
    };
    job.live.parts = applyToolToParts(job.live.parts, tool);
    const mirrors = mirrorsFromParts(job.live.parts);
    job.live.thinking = mirrors.thinking;
    job.live.tools = mirrors.tools;
    return;
  }
  if (type === 'tool_result') {
    const tool = {
      id: ev.id,
      name: ev.name,
      args: ev.args,
      result: ev.result,
      summary: ev.summary,
      ok: ev.ok !== false,
      status: ev.ok === false ? 'error' : 'done',
    };
    job.live.parts = applyToolToParts(job.live.parts, tool);
    const mirrors = mirrorsFromParts(job.live.parts);
    job.live.thinking = mirrors.thinking;
    job.live.tools = mirrors.tools;
    return;
  }
  if (type === 'approval_request') {
    const approval = {
      id: ev.id,
      toolId: ev.callId || null,
      name: ev.name,
      args: ev.args,
      summary: ev.summary || '',
      message: ev.message || `Allow ${ev.name} — ${ev.summary || ''}?`,
      status: ev.status || 'pending',
      decision: ev.decision || null,
      timeoutMs: Number(ev.timeoutMs) > 0 ? Number(ev.timeoutMs) : null,
      timeoutStartsAt: Number(ev.timeoutStartsAt) > 0 ? Number(ev.timeoutStartsAt) : null,
      timeoutDecision: ev.timeoutDecision || null,
      timeoutDefaultAllowed: ev.timeoutDefaultAllowed === true,
      autoSettled: ev.autoSettled === true,
      reason: ev.reason || null,
    };
    job.live.parts = applyApprovalToParts(job.live.parts, approval);
    const mirrors = mirrorsFromParts(job.live.parts);
    job.live.thinking = mirrors.thinking;
    job.live.tools = mirrors.tools;
    return;
  }
  if (type === 'ask_request') {
    const ask = {
      id: ev.id,
      callId: ev.callId || null,
      question: ev.question || '',
      options: Array.isArray(ev.options)
        ? ev.options.map((option, index) => ({
            index,
            label: String(option?.label ?? ''),
            detail: String(option?.detail ?? ''),
          }))
        : [],
      allowFreeText: ev.allowFreeText !== false,
      status: ev.status || 'pending',
      answer: ev.answer && typeof ev.answer === 'object' ? ev.answer : null,
      timeoutMs: Number(ev.timeoutMs) > 0 ? Number(ev.timeoutMs) : null,
      timeoutStartsAt: Number(ev.timeoutStartsAt) > 0 ? Number(ev.timeoutStartsAt) : null,
      reason: ev.reason || null,
    };
    job.live.parts = applyAskToParts(job.live.parts, ask);
    const mirrors = mirrorsFromParts(job.live.parts);
    job.live.thinking = mirrors.thinking;
    job.live.tools = mirrors.tools;
    return;
  }
  if (type === 'steer' && typeof ev.text === 'string' && ev.text.trim()) {
    job.steered = Array.isArray(job.steered) ? job.steered : [];
    job.steered.push({
      id: `steer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text: ev.text,
      at: Date.now(),
      steered: true,
    });
  }
}

export function createTurnJob({
  queueKey,
  sessionId,
  turnId = null,
  prompt = '',
  promptMessageId = null,
  mode = '',
  approvalMode = '',
} = {}) {
  const startedAt = Date.now();
  return {
    queueKey: String(queueKey || ''),
    sessionId: String(sessionId || ''),
    turnId: turnId || randomUUID(),
    prompt: String(prompt || ''),
    promptMessageId: promptMessageId || newMessageId(),
    startedAt,
    live: emptyLive(),
    steered: [],
    // Live composer Mode / Rules for this turn. POST /kusa/chat/options
    // mutates these; the agent loop reads them at each step boundary so a
    // mid-turn picker change takes effect on the very next step.
    options: {
      mode: String(mode || ''),
      approvalMode: String(approvalMode || ''),
    },
    /** @type {Set<(type: string, data: object) => void>} */
    listeners: new Set(),
    terminal: null,
  };
}

/** User row for the prompt that started this turn (for snapshot / sessions overlay). */
export function turnUserMessage(job) {
  if (!job?.prompt) return null;
  return {
    id: job.promptMessageId || newMessageId(),
    role: 'user',
    text: String(job.prompt),
    at: Number.isFinite(job.startedAt) ? job.startedAt : Date.now(),
    turnId: job.turnId,
  };
}

function messagesHaveUserPrompt(messages, userMsg) {
  if (!userMsg?.text) return true;
  const list = Array.isArray(messages) ? messages : [];
  return list.some((m) => {
    if (m?.role !== 'user') return false;
    if (userMsg.id && m.id === userMsg.id) return true;
    if (userMsg.turnId && m.turnId === userMsg.turnId) return true;
    return m.text === userMsg.text && !m.steered;
  });
}

/**
 * Ensure the turn's user prompt is on disk. The browser may refresh before its
 * own PUT lands; the server owns this write when POST /kusa/chat starts.
 */
export function persistTurnPrompt(dataDir, job) {
  const sessionId = String(job?.sessionId || '').trim();
  const userMsg = turnUserMessage(job);
  if (!sessionId || !dataDir || !userMsg) return null;
  const session = readChatSession(dataDir, sessionId);
  if (!session) return null;
  if (messagesHaveUserPrompt(session.messages, userMsg)) return session;
  return writeChatSession(dataDir, {
    ...session,
    messages: [...(session.messages || []), userMsg],
  });
}

export function broadcastTurn(job, type, data) {
  if (!job?.listeners?.size) return;
  for (const listener of [...job.listeners]) {
    try {
      listener(type, data);
    } catch {
      // A dead SSE client must not break the turn.
    }
  }
}

/**
 * Subscribe a writer to a turn. Immediately sends a `snapshot` of live state
 * (and the terminal payload if the turn already finished).
 * @returns {() => void} unsubscribe
 */
export function subscribeTurn(job, listener) {
  if (!job || typeof listener !== 'function') return () => {};
  job.listeners.add(listener);
  try {
    listener('snapshot', {
      type: 'snapshot',
      status: job.terminal ? 'idle' : 'busy',
      turnId: job.turnId,
      live: cloneLive(job.live),
      userMessage: turnUserMessage(job),
      steered: Array.isArray(job.steered) ? job.steered.map((s) => ({ ...s })) : [],
      terminal: job.terminal ? { ...job.terminal } : null,
    });
  } catch {
    /* ignore */
  }
  if (job.terminal) {
    try {
      listener(job.terminal.type || 'done', job.terminal);
    } catch {
      /* ignore */
    }
  }
  return () => {
    job.listeners.delete(listener);
  };
}

/**
 * Append steered user rows + the assistant reply to the chat sidecar.
 * Idempotent on `turnId` so a reconnecting client and the server can both persist.
 */
export function persistTurnCompletion(dataDir, job, terminal) {
  const sessionId = String(job?.sessionId || '').trim();
  if (!sessionId || !dataDir) return null;
  // Make sure the opening user prompt is present even if the client never PUT it.
  persistTurnPrompt(dataDir, job);
  const session = readChatSession(dataDir, sessionId);
  if (!session) return null;

  const parts = Array.isArray(job.live?.parts) ? job.live.parts : [];
  const mirrors = mirrorsFromParts(parts);
  let tools = mirrors.tools;
  if (Array.isArray(terminal?.toolTrace) && terminal.toolTrace.length && !tools.length) {
    tools = terminal.toolTrace.map((t) => ({
      id: t.id || t.name,
      name: t.name,
      args: t.args,
      result: t.result,
      summary: t.summary,
      ok: t.ok !== false,
      status: t.ok === false ? 'error' : 'done',
    }));
  }

  const rawText = typeof terminal?.text === 'string' ? terminal.text : '';
  const textOut = (rawText && rawText !== '(empty response)')
    ? rawText
    : (job.live?.text || rawText || '');
  const thinkingOut = mirrors.thinking
    || ((typeof terminal?.thinking === 'string' && terminal.thinking) ? terminal.thinking : '')
    || job.live?.thinking
    || '';

  const assistantMsg = {
    id: newMessageId(),
    role: 'assistant',
    text: textOut || (thinkingOut || tools.length ? '' : '(empty response)'),
    thinking: thinkingOut || '',
    tools,
    parts: parts.length ? parts : undefined,
    at: Date.now(),
    turnId: job.turnId,
    backend: terminal?.backend || null,
    ...(terminal?.type === 'stopped' || terminal?.stopped ? { stopped: true } : {}),
    ...(terminal?.type === 'error' ? { error: true } : {}),
  };

  let messages = Array.isArray(session.messages) ? [...session.messages] : [];

  // Steered prompts that landed mid-turn (skip if already present by id/text).
  for (const steered of job.steered || []) {
    if (!steered?.text) continue;
    const exists = messages.some(
      (m) => m.id === steered.id
        || (m.role === 'user' && m.steered && m.text === steered.text),
    );
    if (!exists) {
      messages.push({
        id: steered.id || newMessageId(),
        role: 'user',
        text: String(steered.text),
        at: steered.at || Date.now(),
        steered: true,
      });
    }
  }

  const existingIdx = messages.findIndex((m) => m.role === 'assistant' && m.turnId === job.turnId);
  if (existingIdx >= 0) {
    messages[existingIdx] = { ...messages[existingIdx], ...assistantMsg, id: messages[existingIdx].id };
  } else {
    messages.push(assistantMsg);
  }

  return writeChatSession(dataDir, {
    ...session,
    status: 'idle',
    live: null,
    opencodeSessionId: terminal?.opencodeSessionId || session.opencodeSessionId || null,
    messages,
  });
}

/** Overlay in-memory busy/live (+ opening prompt) onto disk sessions. */
export function sessionsWithActiveTurns(sessions, turnJobs) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!turnJobs?.size) return list;
  return list.map((session) => {
    if (!session?.key) return session;
    const job = turnJobs.get(session.key);
    if (!job || job.terminal) return session;
    const userMsg = turnUserMessage(job);
    let messages = Array.isArray(session.messages) ? session.messages : [];
    if (userMsg && !messagesHaveUserPrompt(messages, userMsg)) {
      messages = [...messages, userMsg];
    }
    return {
      ...session,
      status: 'busy',
      live: cloneLive(job.live),
      turnId: job.turnId,
      messages,
    };
  });
}
