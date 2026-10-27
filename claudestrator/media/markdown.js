// A small, safe Markdown renderer for plans, reviews and agent replies. Everything is escaped first;
// only the constructs below become HTML. Exposes window.renderMarkdown(text) → html.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url}" data-href="${url}">${label}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, url) => `${pre}<a href="${url}" data-href="${url}">${url}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  }

  const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function render(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const listStack = [];
    const closeLists = (depth = 0) => {
      while (listStack.length > depth) out.push(`</${listStack.pop().tag}>`);
    };
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    };

    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
      if (fence) {
        flush();
        closeLists();
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
        i++;
        const lang = fence[2] || '';
        out.push(`<div class="code"><div class="code-head"><span>${esc(lang || 'text')}</span><button class="copy" data-action="copy-code" title="Copy">Copy</button></div><pre><code>${esc(body.join('\n'))}</code></pre></div>`);
        continue;
      }
      if (!line.trim()) {
        flush();
        if (!(lines[i + 1] && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1]))) closeLists();
        i++;
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        flush();
        closeLists();
        const level = Math.min(6, h[1].length + 1);
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        i++;
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        flush();
        closeLists();
        out.push('<hr>');
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        closeLists();
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(body.join('\n'))}</blockquote>`);
        continue;
      }
      if (line.includes('|') && lines[i + 1] && isTableSep(lines[i + 1])) {
        flush();
        closeLists();
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (item) {
        flush();
        const depth = Math.floor(item[1].replace(/\t/g, '  ').length / 2) + 1;
        const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
        while (listStack.length > depth) out.push(`</${listStack.pop().tag}>`);
        while (listStack.length < depth) {
          listStack.push({ tag });
          out.push(`<${tag}>`);
        }
        let text = item[3];
        const task = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) text = `<span class="check ${task[1] === ' ' ? '' : 'on'}"></span>${inline(task[2])}`;
        else text = inline(text);
        i++;
        // Lazy continuation lines belong to the item.
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i]) && !/^\s*```/.test(lines[i])) text += ` ${inline(lines[i++].trim())}`;
        out.push(`<li>${text}</li>`);
        continue;
      }
      closeLists();
      para.push(line.trim());
      i++;
    }
    flush();
    closeLists();
    return out.join('\n');
  }

  window.renderMarkdown = render;
  window.escapeHtml = esc;
})();
