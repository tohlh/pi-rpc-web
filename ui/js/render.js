/* Message stream rendering + live delta assembly.
 *
 * Snapshot path: renderAll(messages) rebuilds the whole list from
 * get_messages data (AgentMessage[]).
 *
 * Live path (rpc.md "message_update"):
 *   message_start  -> begin assembling a shell element keyed by contentIndex
 *   message_update.assistantMessageEvent:
 *     text_start/text_delta/text_end        {contentIndex, delta?/content?}
 *     thinking_start/thinking_delta/thinking_end
 *     toolcall_start/toolcall_delta/toolcall_end {toolCall}
 *   -> buffer per contentIndex; text blocks re-render markdown throttled;
 *      toolcall arguments JSON buffered until toolcall_end.
 *   message_end.message is the authoritative replacement for the message.
 *
 * Tool execution events correlate by toolCallId and stream partialResult
 * content arrays into open tool cards (partialResult is cumulative: replace).
 */

import { el, qs, truncate } from './util.js';
import { renderMarkdown } from './markdown.js';

let app = null;
let scroller = null;
let streamEl = null;
let jumpBtn = null;

let pinned = true;
let scrollScheduled = false;
let emptyEl = null;

// Streaming assembler for the in-flight assistant message.
let assembler = null; // {role, mode:'stream'|'static', li, inner, blocks:Map, dirty:Set}

const toolCards = new Map(); // toolCallId -> card api
const resultIndex = new Map(); // toolCallId -> final result content/isError
let noticeCount = 0;

export function init(a) {
  app = a;
  scroller = qs('#chat-scroll');
  streamEl = qs('#stream');
  jumpBtn = qs('#jump-latest');
  emptyEl = qs('#chat-empty');

  // Keep the jump pill above the composer however tall it grows.
  const composerArea = qs('#composer-area');
  if (composerArea && typeof ResizeObserver === 'function') {
    new ResizeObserver(positionJump).observe(composerArea);
  }
  positionJump();

  scroller.addEventListener('scroll', onScroll, { passive: true });
  jumpBtn.addEventListener('click', () => {
    pinned = true;
    jumpBtn.classList.remove('show');
    scrollNow(true);
  });
}

/* ------------------------------------------------------------------ */
/* Scrolling                                                           */
/* ------------------------------------------------------------------ */

function onScroll() {
  const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  pinned = dist < 80;
  jumpBtn.classList.toggle(
    'show',
    !pinned && dist > 240 && scroller.scrollHeight > scroller.clientHeight + 200
  );
}

function maybeScroll() {
  if (!pinned) return;
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    if (pinned) scroller.scrollTop = scroller.scrollHeight;
    onScroll();
  });
}

function scrollNow(smooth) {
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function positionJump() {
  const area = document.getElementById('composer-area');
  if (area) jumpBtn.style.bottom = (area.offsetHeight + 12) + 'px';
}

/** Show/hide the centered chat placeholder ('connecting…' / empty state). */
export function chatPlaceholder(text) {
  if (!emptyEl) return;
  if (!text) {
    emptyEl.hidden = true;
    return;
  }
  const spinner = emptyEl.querySelector('.mini-spinner');
  if (spinner) spinner.hidden = !text.includes('Connecting');
  const label = emptyEl.querySelector('.chat-empty-text');
  if (label) label.textContent = text;
  emptyEl.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Snapshot rendering                                                  */
/* ------------------------------------------------------------------ */

export function renderAll(messages) {
  assembler = null;
  toolCards.clear();
  resultIndex.clear();
  noticeCount = 0;
  streamEl.textContent = '';

  for (const m of messages || []) {
    if (m && m.role === 'toolResult' && m.toolCallId) {
      resultIndex.set(m.toolCallId, m);
    }
  }
  for (const m of messages || []) {
    if (!m || !m.role || m.role === 'toolResult') continue;
    streamEl.append(buildMessage(m));
  }
  pinned = true;
  jumpBtn.classList.remove('show');
  chatPlaceholder(messages && messages.length ? null : 'No messages yet \u2014 say hello');
  requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; onScroll(); });
}

function buildMessage(m) {
  switch (m.role) {
    case 'user': return buildUserMessage(m);
    case 'assistant': return buildAssistantMessage(m);
    case 'bashExecution': return buildBashMessage(m);
    default: {
      // Unknown roles: best-effort text dump so nothing is silently dropped.
      return el('li', { class: 'msg system' },
        el('div', { class: 'notice' }, truncate(JSON.stringify(m), 400)));
    }
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
    .map((c) => c.text)
    .join('\n');
}

function buildUserMessage(m) {
  const bubble = el('div', { class: 'bubble' });
  if (typeof m.content === 'string') {
    if (m.content.trim()) bubble.append(el('div', { class: 'user-text' }, m.content));
  } else if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (!block) continue;
      if (block.type === 'text' && block.text) {
        bubble.append(el('div', { class: 'user-text' }, block.text));
      } else if (block.type === 'image' && block.data) {
        bubble.append(el('img', {
          class: 'attach-img',
          src: `data:${block.mimeType || 'image/png'};base64,${block.data}`,
          alt: 'attached image',
        }));
      }
    }
  }
  for (const att of m.attachments || []) {
    if (att && att.type === 'image' && att.content) {
      bubble.append(el('img', {
        class: 'attach-img',
        src: `data:${att.mimeType || 'image/png'};base64,${att.content}`,
        alt: att.fileName || 'attachment',
      }));
    }
  }
  if (!bubble.childNodes.length) bubble.append('(empty)');
  return el('li', { class: 'msg user' }, el('div', { class: 'msg-inner' }, bubble));
}

function buildAssistantMessage(m) {
  const inner = el('div', { class: 'msg-inner assistant-body' });

  let usageBits = [];
  if (m.model) usageBits.push(m.model);
  if (m.stopReason && m.stopReason !== 'stop') usageBits.push(m.stopReason);
  if (usageBits.length) {
    inner.append(el('div', { class: 'msg-meta' }, usageBits.join(' \u00b7 ')));
  }

  const content = Array.isArray(m.content) ? m.content : [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'thinking') {
      inner.append(buildThinkingBlock(block.thinking || ''));
    } else if (block.type === 'text') {
      if (block.text && block.text.trim()) {
        const mdNode = el('div', { class: 'md' });
        mdNode.innerHTML = renderMarkdown(block.text);
        inner.append(mdNode);
      }
    } else if (block.type === 'toolCall') {
      const result = resultIndex.get(block.id) || null;
      inner.append(makeToolCard(block.id, block.name, block.arguments, result).root);
    }
  }

  if (m.stopReason === 'error') {
    inner.append(el('div', { class: 'notice error' },
      'The model returned an error' + (m.errorMessage ? `: ${truncate(m.errorMessage, 300)}` : '.')));
  }
  if (!inner.querySelector('.md, .thinking, .tool-card')) {
    // Assistant message with no visible content (e.g. pure toolUse turn).
    if (!content.some((b) => b && b.type === 'toolCall')) {
      inner.append(el('div', { class: 'msg-meta empty-note' }, '(no text output)'));
    }
  }
  return el('li', { class: 'msg assistant' }, inner);
}

function buildBashMessage(m) {
  const body = el('div', { class: 'bash-exec' });
  const head = el('div', { class: 'bash-head' },
    el('span', { class: 'bash-cmd' }, '$ ' + (m.command || '')));
  const badges = [];
  if (m.exitCode != null) badges.push(`exit ${m.exitCode}`);
  if (m.cancelled) badges.push('cancelled');
  if (m.truncated) badges.push('truncated');
  if (badges.length) {
    head.append(el('span', {
      class: 'bash-badge ' + ((m.exitCode || 0) === 0 && !m.cancelled ? 'ok' : 'err'),
    }, badges.join(' \u00b7 ')));
  }
  body.append(head);
  if (m.output) body.append(el('pre', { class: 'bash-output' }, m.output));
  return el('li', { class: 'msg bash' }, el('div', { class: 'msg-inner' }, body));
}

function buildThinkingBlock(text, label) {
  const details = el('details', { class: 'thinking' });
  details.append(
    el('summary', null,
      el('span', { class: 'think-glyph', 'aria-hidden': 'true' }, '\u2726'),
      el('span', { class: 'think-label' }, label || 'Thinking')),
    el('div', { class: 'thinking-body' }, text)
  );
  return details;
}

/* ------------------------------------------------------------------ */
/* Tool cards                                                          */
/* ------------------------------------------------------------------ */

const ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url',
  'description', 'skill', 'name', 'title', 'cmd', 'file'];

export function summarizeArgs(args) {
  if (args == null) return '';
  if (typeof args === 'string') return truncate(args, 90);
  for (const k of ARG_KEYS) {
    if (args[k] != null) {
      const v = typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k]);
      return `${k}: ${truncate(v, 80)}`;
    }
  }
  try { return truncate(JSON.stringify(args), 90); } catch { return ''; }
}

function fillOutput(pre, contentArr) {
  if (!Array.isArray(contentArr)) { pre.textContent = ''; return; }
  const parts = contentArr.map((c) => {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (typeof c.text === 'string') return c.text;
    try { return JSON.stringify(c); } catch { return String(c); }
  });
  pre.textContent = parts.join('\n');
}

function makeToolCard(toolCallId, toolName, args, result) {
  const card = el('div', { class: 'tool-card', dataset: { state: 'pending' } });
  const head = el('button', {
    type: 'button',
    class: 'tool-head',
    'aria-expanded': 'false',
  });
  const statusSpan = el('span', { class: 'tool-status', 'aria-hidden': 'true' });
  const nameSpan = el('span', { class: 'tool-name' }, toolName || 'tool');
  const sumSpan = el('span', { class: 'tool-summary' }, summarizeArgs(args));
  const chevron = el('span', { class: 'tool-chevron', 'aria-hidden': 'true' });
  chevron.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  head.append(statusSpan, nameSpan, sumSpan, chevron);

  const out = el('pre', { class: 'tool-output' });
  const bodyWrap = el('div', { class: 'tool-body' }, out);
  bodyWrap.hidden = true;
  head.addEventListener('click', () => {
    bodyWrap.hidden = !bodyWrap.hidden;
    head.setAttribute('aria-expanded', String(!bodyWrap.hidden));
    card.classList.toggle('open', !bodyWrap.hidden);
  });
  card.append(head, bodyWrap);

  const api = {
    root: card,
    setState(s) { card.dataset.state = s; },
    setOutput(content) { fillOutput(out, content); },
    setArgs(a) { sumSpan.textContent = summarizeArgs(a); },
  };
  if (result) {
    api.setOutput(result.content);
    api.setState(result.isError ? 'error' : 'ok');
  }
  if (toolCallId != null) toolCards.set(toolCallId, api);
  return api;
}

/* ------------------------------------------------------------------ */
/* Live streaming assembly                                             */
/* ------------------------------------------------------------------ */

export function beginMessage(message) {
  finishAssembler();
  const msg = message || { role: 'assistant', content: [] };
  const role = msg.role || 'assistant';

  if (role !== 'assistant') {
    // e.g. echoed user message — static element; endMessage replaces it.
    const li = buildMessage(msg);
    streamEl.append(li);
    assembler = { role, mode: 'static', li };
    maybeScroll();
    return;
  }

  const li = el('li', { class: 'msg assistant streaming' });
  const inner = el('div', { class: 'msg-inner assistant-body' });
  li.append(inner);
  streamEl.append(li);
  assembler = {
    role,
    mode: 'stream',
    li,
    inner,
    startedAt: Date.now(),
    blocks: new Map(), // contentIndex -> block record
    order: [],
  };
  maybeScroll();
}

function ensureBlock(idx, kind) {
  const b = assembler.blocks.get(idx);
  if (b) return b;
  const rec = { idx, kind, text: '', argsJson: '', node: null, t0: null, dirty: false };
  assembler.blocks.set(idx, rec);

  if (kind === 'thinking') {
    rec.node = buildThinkingBlock('');
    rec.labelNode = rec.node.querySelector('.think-label');
    rec.bodyNode = rec.node.querySelector('.thinking-body');
  } else if (kind === 'text') {
    rec.node = el('div', { class: 'md' });
  } else if (kind === 'toolcall') {
    rec.node = el('div', { class: 'tool-placeholder' },
      el('span', { class: 'mini-spinner', 'aria-hidden': 'true' }), 'preparing tool call\u2026');
  }

  // Insert maintaining ascending contentIndex order.
  const later = assembler.order.find((j) => j > idx);
  if (later == null) {
    assembler.inner.append(rec.node);
    assembler.order.push(idx);
  } else {
    const refBlock = assembler.blocks.get(later);
    refBlock.node.parentNode.insertBefore(rec.node, refBlock.node);
    assembler.order.splice(assembler.order.indexOf(later), 0, idx);
  }
  return rec;
}

let rafHandle = 0;
function scheduleFlush() {
  if (rafHandle) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0;
    flushDirty();
  });
}

function flushDirty() {
  if (!assembler) return;
  for (const b of assembler.blocks.values()) {
    if (!b.dirty) continue;
    b.dirty = false;
    if (b.kind === 'text' && b.node) {
      b.node.innerHTML = renderMarkdown(b.text);
    }
  }
  maybeScroll();
}

export function applyDelta(ev) {
  if (!assembler || assembler.mode !== 'stream') {
    if (ev && ev.assistantMessageEvent) beginMessage(ev.message);
    if (!assembler || assembler.mode !== 'stream') return;
  }
  const d = ev.assistantMessageEvent;
  if (!d) return;
  const idx = d.contentIndex ?? 0;

  switch (d.type) {
    case 'text_start':
      ensureBlock(idx, 'text');
      break;

    case 'text_delta': {
      const b = ensureBlock(idx, 'text');
      b.text += d.delta ?? '';
      b.dirty = true;
      scheduleFlush();
      break;
    }

    case 'text_end': {
      const b = ensureBlock(idx, 'text');
      if (typeof d.content === 'string') b.text = d.content;
      b.node.innerHTML = renderMarkdown(b.text);
      b.dirty = false;
      break;
    }

    case 'thinking_start':
      ensureBlock(idx, 'thinking').t0 = Date.now();
      break;

    case 'thinking_delta': {
      const b = ensureBlock(idx, 'thinking');
      b.text += d.delta ?? '';
      b.bodyNode.textContent = b.text;
      b.node.open = true; // auto-expand while actively thinking
      break;
    }

    case 'thinking_end': {
      const b = ensureBlock(idx, 'thinking');
      if (typeof d.content === 'string') b.text = d.content;
      b.bodyNode.textContent = b.text;
      const secs = b.t0 ? Math.max(1, Math.round((Date.now() - b.t0) / 1000)) : null;
      b.labelNode.textContent = secs
        ? `Thought for ${secs}s`
        : 'Thinking';
      b.node.open = false; // collapse when done
      break;
    }

    case 'toolcall_start':
      ensureBlock(idx, 'toolcall');
      break;

    case 'toolcall_delta': {
      const b = ensureBlock(idx, 'toolcall');
      b.argsJson += d.delta ?? '';
      break;
    }

    case 'toolcall_end': {
      const b = ensureBlock(idx, 'toolcall');
      b.toolCall = d.toolCall || {};
      let args = {};
      try { args = JSON.parse(b.argsJson || '{}'); } catch { /* tolerate */ }
      if (b.toolCall.arguments != null) args = b.toolCall.arguments;
      const card = makeToolCard(
        b.toolCall.id ?? `live-${idx}-${assembler.startedAt}`,
        b.toolCall.name ?? 'tool',
        args,
        null
      );
      b.node.replaceWith(card.root);
      b.node = card.root;
      break;
    }

    default:
      break;
  }
  maybeScroll();
}

function finishAssembler() {
  // If a stream ended without message_end, keep whatever was assembled but
  // stop tracking it so a new message can assemble cleanly.
  if (assembler && assembler.mode === 'stream') {
    assembler.li.classList.remove('streaming');
  }
  assembler = null;
}

export function endMessage(message) {
  const msg = message || { role: 'assistant', content: [] };

  if (msg.role === 'toolResult') {
    // Never render a raw toolResult dump; fold it into its tool card.
    if (msg.toolCallId) {
      resultIndex.set(msg.toolCallId, msg);
      const card = toolCards.get(msg.toolCallId);
      if (card) {
        card.setOutput(msg.content);
        card.setState(msg.isError ? 'error' : 'ok');
      }
      maybeScroll();
    }
    assembler = null;
    return;
  }

  const fresh = buildMessage(msg);

  if (assembler && assembler.li) {
    assembler.li.replaceWith(fresh);
  } else {
    // message_end without prior start: append authoritatively unless an
    // identical trailing element already exists (defensive against dupes).
    streamEl.append(fresh);
  }
  if (
    (msg.role === 'assistant' || msg.role === 'user' || msg.role === 'bashExecution') &&
    !state_messagesHas(msg)
  ) {
    app.state.messages.push(msg);
  }
  assembler = null;
  maybeScroll();
}

function state_messagesHas(msg) {
  return (app.state.messages || []).some((m) => m === msg);
}

/* ------------------------------------------------------------------ */
/* Tool execution events                                               */
/* ------------------------------------------------------------------ */

export function toolEvent(ev) {
  switch (ev.type) {
    case 'tool_execution_start': {
      let card = toolCards.get(ev.toolCallId);
      if (!card) {
        // A card may exist under a live- placeholder key (streamed before the
        // real toolCallId was known): re-key it instead of appending a second.
        for (const [key, candidate] of toolCards) {
          if (typeof key === 'string' && key.startsWith('live-')) {
            toolCards.delete(key);
            toolCards.set(ev.toolCallId, candidate);
            card = candidate;
            break;
          }
        }
      }
      if (!card) {
        // Started without a matching toolcall_end in view — standalone card.
        card = makeToolCard(ev.toolCallId, ev.toolName || 'tool', ev.args, null);
        streamEl.append(card.root);
      } else {
        if (ev.args != null) card.setArgs(ev.args);
      }
      card.setState('running');
      maybeScroll();
      break;
    }
    case 'tool_execution_update': {
      const card = toolCards.get(ev.toolCallId);
      if (card && ev.partialResult) card.setOutput(ev.partialResult.content);
      break;
    }
    case 'tool_execution_end': {
      const card = toolCards.get(ev.toolCallId);
      const result = ev.result || {};
      resultIndex.set(ev.toolCallId, {
        toolCallId: ev.toolCallId,
        content: result.content || [],
        isError: !!ev.isError,
      });
      if (card) {
        card.setOutput(result.content || []);
        card.setState(ev.isError ? 'error' : 'ok');
      }
      maybeScroll();
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Inline system notices                                               */
/* ------------------------------------------------------------------ */

export function systemNotice(text, kind = 'info', actions = []) {
  const box = el('div', { class: `notice ${kind}` }, text);
  for (const a of actions || []) {
    box.append(
      el('button', {
        type: 'button',
        class: 'notice-action',
        onclick: () => { try { a.onClick(); } catch (err) { console.error('[notice action]', err); } },
      }, a.label),
    );
  }
  const li = el('li', { class: 'msg system' }, box);
  // Keep notices after the live element positionally correct.
  if (assembler && assembler.li && assembler.li.parentNode === streamEl) {
    assembler.li.before(li);
  } else {
    streamEl.append(li);
  }
  noticeCount++;
  while (noticeCount > 30) {
    const first = streamEl.querySelector('.msg.system');
    if (!first) break;
    first.remove();
    noticeCount--;
  }
  maybeScroll();
}

/** Drop ephemeral state on resnapshot. */
export function resetLive() {
  assembler = null;
  toolCards.clear();
  resultIndex.clear();
  noticeCount = 0;
}
