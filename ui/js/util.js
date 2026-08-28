/* Shared helpers: DOM construction, escaping, formatting. */

export function qs(sel, root = document) {
  return root.querySelector(sel);
}

export function qsa(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

/** Strip ANSI escape sequences (extensions send colored TUI status text). */
export function stripAnsi(s) {
  return String(s ?? '')
    .replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

/** Escape a string for safe interpolation into HTML. */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Small DOM builder. Attrs: class, dataset, on* listeners, boolean attrs,
 * anything else goes through setAttribute. Children flattened; null/false skipped.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '\u2026';
}

/** 1234 -> "1,234"; 105000 -> "105k" */
export function fmtTokens(n) {
  if (n == null || isNaN(n)) return '\u2014';
  n = Number(n);
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'k';
  return n.toLocaleString('en-US');
}

/** 0.45 -> "$0.45"; 0.0003 -> "$0.0003" */
export function fmtCost(n) {
  if (n == null || isNaN(n)) return '\u2014';
  n = Number(n);
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

/** Relative time for a millisecond timestamp. */
export function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - Number(ms);
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const dt = new Date(Number(ms));
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    (dt.getFullYear() !== new Date().getFullYear() ? ' ' + dt.getFullYear() : '');
}

export function basename(p) {
  if (!p) return '';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || p;
}
