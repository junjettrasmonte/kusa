/**
 * Stitch an orchestrated parent + its Subagent sessions into one chronological
 * transcript for the group-chat view. Child sessions stay on disk; this is a
 * render-time merge only.
 */

export function isOrchestratedChatSession(session) {
  if (!session) return false;
  if (session.parentId || session.options?.parentId) return false;
  const kind = String(session.kind || session.options?.kind || '').toLowerCase();
  return kind === 'orchestrated' || Boolean(session.options?.workflowId || session.workflowId);
}

/** Lane identity for a merged transcript row (session key / speaker). */
export function transcriptLaneKey(msg) {
  if (!msg) return '';
  return String(
    msg._queueKey
    || msg.speaker?.queueKey
    || msg.speaker?.agentId
    || '',
  ).trim();
}

/** One fine-print stub describing a handoff that belongs on the caller turn. */
export function delegateStubFromMessage(msg) {
  if (!msg) return null;
  const roleLabel = String(
    msg.roleLabel
    || msg.speaker?.role
    || 'agent',
  ).trim() || 'agent';
  return {
    id: msg.id || '',
    roleLabel,
    text: typeof msg.text === 'string' ? msg.text : '',
    speaker: msg.speaker || null,
  };
}

/**
 * Fold standalone `delegate` / `meta` rows into the prior caller assistant turn
 * as `delegates: […]` fine-print stubs. Leftovers (no host yet — e.g. parent
 * still streaming) stay as `role: 'delegate'` for the live turn to peel.
 */
export function foldDelegatesIntoTurns(messages = []) {
  const out = [];
  for (const msg of messages || []) {
    if (!msg || (msg.role !== 'delegate' && msg.role !== 'meta')) {
      if (msg) out.push(msg);
      continue;
    }
    const stub = delegateStubFromMessage(msg);
    if (!stub) continue;
    const childLane = transcriptLaneKey(msg);
    let host = -1;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const row = out[i];
      if (row?.role !== 'assistant') continue;
      const lane = transcriptLaneKey(row);
      // Attach to the agent who handed off — never onto the child's own lane.
      if (childLane && lane && lane === childLane) continue;
      host = i;
      break;
    }
    if (host < 0) {
      out.push(msg);
      continue;
    }
    const target = out[host];
    const delegates = [...(Array.isArray(target.delegates) ? target.delegates : []), stub];
    out[host] = { ...target, delegates };
  }
  return out;
}

/**
 * Peel trailing unhosted delegate rows (parent still streaming when assign
 * fired). Caller attaches them to the live orchestrator ChatTurn.
 */
export function peelTrailingDelegates(messages = []) {
  const rest = Array.isArray(messages) ? messages.slice() : [];
  const trailing = [];
  while (rest.length) {
    const last = rest[rest.length - 1];
    if (last?.role !== 'delegate' && last?.role !== 'meta') break;
    rest.pop();
    const stub = delegateStubFromMessage(last);
    if (stub) trailing.unshift(stub);
  }
  return { messages: rest, delegates: trailing };
}

export function speakerFromSession(session) {
  if (!session) return null;
  const opts = session.options || {};
  const parented = Boolean(session.parentId || opts.parentId);
  const kind = String(session.kind || opts.kind || '').toLowerCase();
  const orchestratedRoot = !parented && (
    kind === 'orchestrated' || Boolean(opts.workflowId || session.workflowId)
  );
  const role = session.role || opts.role || (orchestratedRoot ? 'orchestrator' : '');
  // Prefer the session pick; else the latest assistant turn that recorded one
  // (Cursor/Copilot often only learn the model mid-stream).
  let model = String(opts.model || session.model || '').trim();
  if (!model && Array.isArray(session.messages)) {
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const msg = session.messages[i];
      if (msg?.role !== 'assistant') continue;
      const fromMsg = String(msg.model || '').trim();
      if (fromMsg) {
        model = fromMsg;
        break;
      }
    }
  }
  return {
    agentId: session.id || null,
    role,
    provider: session.provider || opts.provider || 'kusa',
    harness: session.harness
      || (typeof session.key === 'string' && session.key.includes(':')
        ? session.key.slice(0, session.key.indexOf(':'))
        : 'kusa'),
    model,
    queueKey: session.key || null,
  };
}

function isRelayOnlyAssistant(msg) {
  if (!msg || msg.role !== 'assistant') return false;
  if (msg.relayOnly === true) return true;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  // Parent relay shell completions (legacy + role-attributed).
  if (
    text === 'Subagent asked for your input.'
    || text === 'A subagent asked for your input.'
    || /agent asked for your input\.?$/i.test(text)
  ) {
    return true;
  }
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  if (!parts.length) return false;
  // Parent relay shells are approval/ask parts stamped relayed — drop them so
  // the same gates are not shown twice next to the child's own segment.
  return parts.every((p) => (
    (p?.type === 'approval' && p.approval?.relayed)
    || (p?.type === 'ask' && p.ask?.relayed)
  ));
}

function stripRelayedParts(msg) {
  const parts = Array.isArray(msg?.parts) ? msg.parts : null;
  if (!parts?.length) return msg;
  const next = parts.filter((p) => !(
    (p?.type === 'approval' && p.approval?.relayed)
    || (p?.type === 'ask' && p.ask?.relayed)
  ));
  if (next.length === parts.length) return msg;
  return { ...msg, parts: next };
}

function messageSortAt(msg) {
  const at = Number(msg?.at);
  if (Number.isFinite(at) && at > 0) return at;
  return 0;
}

/**
 * @param {object} parent
 * @param {object[]} children
 * @returns {object[]}
 */
export function mergeOrchestratedMessages(parent, children = []) {
  const items = [];
  const parentSpeaker = speakerFromSession(parent);

  for (const msg of parent?.messages || []) {
    if (!msg || typeof msg !== 'object') continue;
    if (isRelayOnlyAssistant(msg)) continue;
    const cleaned = msg.role === 'assistant' ? stripRelayedParts(msg) : msg;
    items.push({
      ...cleaned,
      id: cleaned.id || `parent-${items.length}`,
      speaker: parentSpeaker,
      _queueKey: parent.key,
      _sortAt: messageSortAt(cleaned),
    });
  }

  for (const child of children || []) {
    if (!child?.id) continue;
    const speaker = speakerFromSession(child);
    const roleLabel = speaker?.role || 'agent';
    let pendingBrief = null;
    let pendingBriefAt = 0;
    for (const msg of child.messages || []) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'user') {
        pendingBrief = typeof msg.text === 'string' ? msg.text : '';
        pendingBriefAt = messageSortAt(msg);
        continue;
      }
      if (pendingBrief != null) {
        items.push({
          id: `delegate-${child.id}-${pendingBriefAt || items.length}`,
          role: 'delegate',
          text: pendingBrief,
          at: pendingBriefAt || messageSortAt(msg),
          speaker,
          roleLabel,
          _queueKey: child.key,
          _sortAt: pendingBriefAt || messageSortAt(msg),
        });
        pendingBrief = null;
        pendingBriefAt = 0;
      }
      items.push({
        ...msg,
        id: `${child.id}:${msg.id || items.length}`,
        speaker,
        _queueKey: child.key,
        _sortAt: messageSortAt(msg),
      });
    }
    // Assign kicked off but the child has not answered yet — still show the brief.
    if (pendingBrief != null && String(pendingBrief).trim()) {
      items.push({
        id: `delegate-${child.id}-pending`,
        role: 'delegate',
        text: pendingBrief,
        at: pendingBriefAt || Date.now(),
        speaker,
        roleLabel,
        _queueKey: child.key,
        _sortAt: pendingBriefAt || Date.now(),
      });
    }
  }

  items.sort((a, b) => {
    const diff = (a._sortAt || 0) - (b._sortAt || 0);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
  // Delegated briefs belong on the orchestrator turn as fine print — not as
  // their own transcript sections (those start at the child's reply).
  return foldDelegatesIntoTurns(items);
}

/**
 * Live (streaming) assistant rows for parent + busy children.
 * Skips parent relay-only shells when children are present.
 */
export function mergeOrchestratedLiveTurns(parent, children = []) {
  const lives = [];
  const parentBusy = parent?.status === 'busy' || parent?.status === 'thinking';
  const parentLive = parent?.live;
  const parentRelayOnly = Boolean(parentLive?.relayOnly || parent?.relayOnly);
  if (parentBusy && parentLive && !parentRelayOnly) {
    lives.push({
      id: 'live-parent',
      role: 'assistant',
      text: parentLive.text || '',
      thinking: parentLive.thinking || '',
      tools: parentLive.tools || [],
      parts: (parentLive.parts || []).filter((p) => !(
        (p?.type === 'approval' && p.approval?.relayed)
        || (p?.type === 'ask' && p.ask?.relayed)
      )),
      streaming: true,
      speaker: speakerFromSession(parent),
      _queueKey: parent.key,
    });
  } else if (parentBusy && parentLive && parentRelayOnly && !(children || []).length) {
    // No children hydrated yet — keep relay gates visible on the parent.
    lives.push({
      id: 'live-parent-relay',
      role: 'assistant',
      text: parentLive.text || '',
      thinking: parentLive.thinking || '',
      tools: parentLive.tools || [],
      parts: parentLive.parts || [],
      streaming: true,
      speaker: speakerFromSession(parent),
      _queueKey: parent.key,
    });
  }

  for (const child of children || []) {
    const busy = child?.status === 'busy' || child?.status === 'thinking';
    if (!busy) continue;
    const live = child.live;
    if (!live) {
      lives.push({
        id: `live-${child.id}-thinking`,
        role: 'assistant',
        text: '',
        parts: [],
        streaming: true,
        speaker: speakerFromSession(child),
        _queueKey: child.key,
        _placeholder: true,
      });
      continue;
    }
    lives.push({
      id: `live-${child.id}`,
      role: 'assistant',
      text: live.text || '',
      thinking: live.thinking || '',
      tools: live.tools || [],
      parts: live.parts || [],
      streaming: true,
      speaker: speakerFromSession(child),
      _queueKey: child.key,
    });
  }
  return lives;
}
