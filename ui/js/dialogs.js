/* Extension UI protocol handling.
 *
 * Dialog methods (select/confirm/input/editor) block the child until we send
 * back `extension_ui_response`; Esc / backdrop / explicit cancel sends
 * `{cancelled:true}`. If the request carries a `timeout`, we show a countdown
 * and silently close at zero (the agent auto-resolves server-side).
 *
 * Fire-and-forget methods (notify/setStatus/setWidget/setTitle/
 * set_editor_text) never get a response frame.
 */

import { el, qs , stripAnsi } from './util.js';

let app = null;
const statusEntries = new Map(); // statusKey -> text
let countdownTimers = new Set();

export function init(a) {
  app = a;
}

function respond(id, payload) {
  // Passthrough frame; correlation id comes from the request itself.
  app.socket.raw({ type: 'extension_ui_response', id, ...payload });
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function toast(message, type = 'info') {
  const box = qs('#toasts');
  const t = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    el('div', { class: 'toast-msg' }, stripAnsi(message)),
    el('button', {
      type: 'button', class: 'toast-x', 'aria-label': 'Dismiss',
      onclick: () => dismiss(),
    }, '\u00d7'));
  box.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  const timer = setTimeout(dismiss, type === 'error' ? 8000 : 4500);
  function dismiss() {
    clearTimeout(timer);
    t.classList.remove('in');
    setTimeout(() => t.remove(), 220);
  }
}

/* ------------------------------------------------------------------ */
/* Modal core (focus trap, Esc = cancel)                               */
/* ------------------------------------------------------------------ */

export function openModal({ title, body, actions = [], onCancel, wide }) {
  const root = qs('#modal-root');
  const prevFocus = document.activeElement;

  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', {
    class: 'modal' + (wide ? ' wide' : ''),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || 'Dialog',
  });
  if (title) box.append(el('h2', { class: 'modal-title' }, title));
  if (body) box.append(body);

  if (actions.length) {
    const row = el('div', { class: 'modal-actions' });
    for (const a of actions) {
      row.append(el('button', {
        type: a.attrs?.type || 'button',
        class: 'btn ' + (a.kind || ''),
        ...(a.attrs || {}),
        onclick: a.onClick,
      }, a.label));
    }
    box.append(row);
  }
  backdrop.append(box);
  root.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('in'));

  setTimeout(() => {
    const first = box.querySelector('.text-input') ||
      box.querySelector('button.select-item') ||
      box.querySelector('.btn.primary') || box.querySelector('button');
    if (first) first.focus();
  }, 40);

  let closed = false;
  const closeHooks = [];
  function closeFn() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', keydown, true);
    backdrop.classList.remove('in');
    setTimeout(() => backdrop.remove(), 170);
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    for (const hook of closeHooks.splice(0)) {
      try { hook(); } catch { /* never block teardown */ }
    }
  }
  function cancel() {
    closeFn();
    if (onCancel) onCancel();
  }

  function keydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Tab') {
      const focusables = [...box.querySelectorAll(
        'button:not([hidden]),input:not([hidden]),textarea:not([hidden]),select,[tabindex]:not([tabindex="-1"])'
      )].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!focusables.length) return;
      e.preventDefault();
      const idx = focusables.indexOf(document.activeElement);
      const next = e.shiftKey
        ? (idx <= 0 ? focusables.length - 1 : idx - 1)
        : (idx === focusables.length - 1 ? 0 : idx + 1);
      focusables[next].focus();
    }
  }
  document.addEventListener('keydown', keydown, true);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) cancel(); });

  return {
    close: closeFn,
    cancel,
    box,
    /** Register a cleanup hook run on any close (manual, cancel or expire). */
    onClose(hook) {
      if (closed) hook();
      else closeHooks.push(hook);
    },
    /** Silent close used by timeout expiry — no response is sent. */
    expire() {
      closeFn();
    },
  };
}

function attachCountdown(modal, ms) {
  if (!ms || ms <= 0) return null;
  const label = el('div', { class: 'modal-countdown' }, '');
  modal.box.append(label);
  const deadline = Date.now() + Number(ms);
  const timer = setInterval(() => {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(timer);
      countdownTimers.delete(timer);
      modal.expire(); // agent auto-resolves; do NOT send cancelled after this
      return;
    }
    label.textContent = `Auto-dismisses in ${left}s`;
  }, 250);
  countdownTimers.add(timer);
  // Clear the interval no matter how the modal is dismissed manually.
  modal.onClose(() => {
    clearInterval(timer);
    countdownTimers.delete(timer);
  });
  return label;
}

/* ------------------------------------------------------------------ */
/* Reusable input modal (used by sidebar rename, etc.)                 */
/* ------------------------------------------------------------------ */

export function inputModal({ title, placeholder = '', value = '', onSubmit }) {
  let m;
  const input = el('input', {
    class: 'text-input', type: 'text', placeholder, value,
    'aria-label': title || 'Input',
  });
  const form = el('form', { class: 'modal-form' }, input);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    m.close();
    if (onSubmit) onSubmit(input.value);
  });
  m = openModal({
    title,
    body: form,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => m.cancel() },
      { label: 'Save', kind: 'primary', attrs: { type: 'submit' }, onClick: () => form.requestSubmit() },
    ],
  });
  return m;
}

/* ------------------------------------------------------------------ */
/* extension_ui_request dispatch                                       */
/* ------------------------------------------------------------------ */

export function handleExtensionUI(req) {
  switch (req.method) {
    case 'select': dialogSelect(req); break;
    case 'confirm': dialogConfirm(req); break;
    case 'input': dialogInput(req); break;
    case 'editor': dialogEditor(req); break;
    case 'notify': toast(req.message, req.notifyType || 'info'); break;
    case 'setStatus': setStatus(req.statusKey, req.statusText); break;
    case 'setWidget': setWidget(req.widgetLines, req.widgetPlacement); break;
    case 'setTitle': setTitle(req.title); break;
    case 'set_editor_text': app.emit('editor-text', req.text ?? ''); break;
    default:
      // Unknown dialog method: respond cancelled so the child never hangs.
      respond(req.id, { cancelled: true });
  }
}

function dialogSelect(req) {
  let m;
  const list = el('div', { class: 'select-list' });
  for (const opt of req.options || []) {
    const isObj = opt != null && typeof opt === 'object';
    const label = isObj ? String(opt.label ?? opt.value ?? '') : String(opt);
    const value = isObj ? (opt.value ?? opt.label) : opt;
    list.append(el('button', {
      type: 'button',
      class: 'select-item',
      onclick: () => { m.close(); respond(req.id, { value }); },
    }, label));
  }
  m = openModal({
    title: req.title || 'Select an option',
    body: list,
    onCancel: () => respond(req.id, { cancelled: true }),
  });
  attachCountdown(m, req.timeout);
}

function dialogConfirm(req) {
  let m;
  const body = el('div', { class: 'modal-text' }, req.message || 'Are you sure?');
  m = openModal({
    title: req.title || 'Confirm',
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => { m.close(); respond(req.id, { confirmed: false }); } },
      { label: 'Confirm', kind: 'primary', onClick: () => { m.close(); respond(req.id, { confirmed: true }); } },
    ],
    onCancel: () => respond(req.id, { cancelled: true }),
  });
  attachCountdown(m, req.timeout);
}

function dialogInput(req) {
  let m;
  const input = el('input', {
    class: 'text-input', type: 'text',
    placeholder: req.placeholder || '',
    value: req.value ?? '',
    'aria-label': req.title || 'Input',
  });
  const form = el('form', { class: 'modal-form' }, input);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    m.close();
    respond(req.id, { value: input.value });
  });
  m = openModal({
    title: req.title || 'Input',
    body: form,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => { m.close(); respond(req.id, { cancelled: true }); } },
      { label: 'OK', kind: 'primary', attrs: { type: 'submit' }, onClick: () => form.requestSubmit() },
    ],
    onCancel: () => respond(req.id, { cancelled: true }),
  });
  attachCountdown(m, req.timeout);
}

function dialogEditor(req) {
  let m;
  const ta = el('textarea', {
    class: 'text-input editor-area',
    rows: 10,
    spellcheck: 'false',
    'aria-label': req.title || 'Editor',
  });
  ta.value = req.prefill ?? '';
  const hint = el('div', { class: 'modal-hint' }, 'Ctrl/\u2318+Enter to save');
  const form = el('form', { class: 'modal-form' }, ta, hint);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    m.close();
    respond(req.id, { value: ta.value });
  });
  form.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  m = openModal({
    title: req.title || 'Edit text',
    body: form,
    wide: true,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => { m.close(); respond(req.id, { cancelled: true }); } },
      { label: 'Save', kind: 'primary', attrs: { type: 'submit' }, onClick: () => form.requestSubmit() },
    ],
    onCancel: () => respond(req.id, { cancelled: true }),
  });
}

/* ------------------------------------------------------------------ */
/* Fire-and-forget                                                     */
/* ------------------------------------------------------------------ */

export function setStatus(key, text) {
  if (text == null || text === '') statusEntries.delete(key);
  else statusEntries.set(String(key), String(text));
  const node = qs('#status-text');
  node.textContent = [...statusEntries.values()].map(stripAnsi).join('   \u00b7   ');
  node.hidden = statusEntries.size === 0;
}

export function setWidget(lines, placement) {
  const target = placement === 'belowEditor' ? qs('#widget-below') : qs('#widget-above');
  target.textContent = '';
  if (Array.isArray(lines) && lines.length) {
    target.hidden = false;
    target.append(el('pre', { class: 'widget' }, lines.join('\n')));
  } else {
    target.hidden = true;
  }
}

export function setTitle(title) {
  document.title = title ? `${title} \u00b7 pi` : 'pi';
}
