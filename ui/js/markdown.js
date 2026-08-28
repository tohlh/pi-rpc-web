/* Escape-first markdown renderer.
 *
 * All input HTML is escaped before any formatting is applied, so arbitrary
 * model/tool output can never inject markup. Supported block syntax:
 * headings, fenced code (language label + copy button), unordered/ordered
 * lists (with nesting + task checkboxes), blockquotes, pipe tables, hr, and
 * paragraphs. Inline: bold, italic, strikethrough, inline code, links
 * (http/https/mailto only).
 */

import { esc } from './util.js';

function renderInline(raw) {
  let s = esc(raw);

  // Protect inline code spans first.
  const codes = [];
  s = s.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, code) => {
    codes.push(`<code>${code.replace(/^ | $/g, '')}</code>`);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // Links [text](url) — scheme allowlist.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, text, url) => {
    if (!/^(https?:\/\/|mailto:|\/|#)/i.test(url)) return m;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  s = s.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w\\])\*([^*\n]+)\*(?=[^\w]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w\\])__([^_\n]+)__(?=[^\w]|$)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?;:)])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  s = s.replace(/\u0000C(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
  return s;
}

export function renderMarkdown(src) {
  if (typeof src !== 'string' || !src) return '';
  let text = src.replace(/\r\n?/g, '\n');

  // Pull out fenced code blocks first (including an unterminated tail).
  const codeBlocks = [];
  text = text.replace(/```([^\n]*)\n([\s\S]*?)(?:```|$)/g, (_m, info, code) => {
    const lang = esc(info.trim().split(/\s+/)[0] || '');
    codeBlocks.push(
      `<div class="code-block"><div class="code-head"><span class="code-lang">${lang}</span>` +
      `<button type="button" class="copy-btn" aria-label="Copy code">Copy</button></div>` +
      `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre></div>`
    );
    return `\u0000B${codeBlocks.length - 1}\u0000`;
  });

  const lines = text.split('\n');
  const out = [];
  let para = [];
  let i = 0;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const ph = line.match(/^\s*\u0000B(\d+)\u0000\s*$/);
    if (ph) { flushPara(); out.push(codeBlocks[Number(ph[1])]); i++; continue; }

    if (!line.trim()) { flushPara(); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    if (/^\s*(?:([-*_])\s*)(?:\1\s*){2,}$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (
      /^\s*\|.*\|/.test(line) && i + 1 < lines.length &&
      lines[i + 1].includes('-') && /^\s*\|?[\s:|-]*-[-\s:|]*\|?\s*$/.test(lines[i + 1])
    ) {
      flushPara();
      const parseRow = (l) =>
        l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const rows = [parseRow(line)];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      const [head, ...body] = rows;
      let t = '<div class="table-wrap"><table><thead><tr>' +
        head.map((c) => `<th>${renderInline(c)}</th>`).join('') +
        '</tr></thead>';
      if (body.length) {
        t += '<tbody>' + body.map((r) =>
          '<tr>' + r.map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>'
        ).join('') + '</tbody>';
      }
      out.push(t + '</table></div>');
      continue;
    }

    if (/^(\s*)([-*+]|\d{1,9}[.)])\s+/.test(line)) {
      flushPara();
      i = parseList(lines, i, out);
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}

function parseList(lines, start, out) {
  const root = [];
  const stack = []; // open items by indent depth
  let i = start;
  let baseOrdered = null;

  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
    if (!m) {
      // Lazily-indented continuation line attaches to the deepest open item.
      if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && stack.length) {
        stack[stack.length - 1].parts.push(lines[i].trim());
        i++;
        continue;
      }
      break;
    }
    const indent = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
    const ordered = /\d/.test(m[2]);
    if (baseOrdered === null) {
      baseOrdered = ordered;
    } else if (ordered !== baseOrdered && indent === 0) {
      // Different marker type at base indent -> a separate list starts here.
      break;
    }
    const item = { indent, ordered, parts: [m[3]], children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      const done = stack.pop();
      (stack.length ? stack[stack.length - 1].children : root).push(done);
    }
    stack.push(item);
    i++;
  }
  while (stack.length) {
    const done = stack.pop();
    (stack.length ? stack[stack.length - 1].children : root).push(done);
  }

  const renderList = (items) => {
    const ordered = items[0] && items[0].ordered;
    return `<${ordered ? 'ol' : 'ul'}>` + items.map(renderItem).join('') + `</${ordered ? 'ol' : 'ul'}>`;
  };

  function renderItem(it) {
    let inner;
    const task = it.parts[0] && it.parts[0].match(/^\[( |x|X)\]\s+(.*)$/);
    if (task) {
      const done = task[1].toLowerCase() === 'x';
      inner =
        `<span class="task${done ? ' done' : ''}" role="checkbox" aria-checked="${done}">` +
        `${done ? '\u2611' : '\u2610'}</span> ` +
        it.parts.map((p, idx) => renderInline(idx === 0 ? task[2] : p)).join('<br>');
    } else {
      inner = it.parts.map((p) => renderInline(p)).join('<br>');
    }
    const kids = it.children.length ? renderList(it.children) : '';
    return `<li>${inner}${kids}</li>`;
  }

  if (root.length) out.push(renderList(root));
  return i;
}
