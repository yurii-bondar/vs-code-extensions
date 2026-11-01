// A small, safe Markdown renderer for plans, reviews and agent replies. Everything is escaped first;
// only the constructs below become HTML. Exposes window.renderMarkdown(text) → html.
(function () {
  const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);

  /** Bold, italics and strikethrough, in escaped text. */
  const emphasis = (s: string) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  /**
   * Code spans and links become placeholders (NUL, number, NUL) as soon as they are made: no later step reads their
   * HTML again. An autolink found inside a link's address, or an `_` of an address made into <em>, would otherwise end
   * the href attribute early and let the text add attributes of its own (a style laying a link over the whole screen).
   */
  function inline(text: string) {
    const held: string[] = [];
    const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
    // eslint-disable-next-line no-control-regex -- NUL marks the placeholders; the text brings none of its own
    let s = String(text).replace(/\u0000/g, '');
    s = s.replace(/`([^`\n]+)`/g, (_, c: string) => hold(`<code>${esc(c)}</code>`));
    s = esc(s);
    // A label is one line of at most 300 characters: an unbounded one was read to the end from every `[` of a line
    // without `]`, which took seconds on a long one.
    // eslint-disable-next-line no-control-regex -- an address never takes in a placeholder
    s = s.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s\u0000]+)\)/g, (_, label: string, url: string) => hold(`<a href="${url}" data-href="${url}">${emphasis(label)}</a>`));
    // eslint-disable-next-line no-control-regex -- an address never takes in a placeholder
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)\u0000]+[^\s<).,;:!?\u0000])/g, (_, pre: string, url: string) => `${pre}${hold(`<a href="${url}" data-href="${url}">${url}</a>`)}`);
    s = emphasis(s);
    // eslint-disable-next-line no-control-regex -- NUL marks the placeholders
    const restore = (x: string): string => x.replace(/\u0000(\d+)\u0000/g, (_, i: string) => restore(held[Number(i)] ?? ''));
    return restore(s);
  }

  // Each test reads the line trimmed: `\s*` on both sides of an optional `|` took seconds on a line of spaces.
  const isTableSep = (l: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(l.trim());
  /** How deep blockquotes nest before the rest reads as plain text: a line of a thousand `>` is not a thousand frames. */
  const MAX_QUOTE_DEPTH = 8;
  /** A heading's text without its closing `#`s, read without a regex that backtracks over a long run of spaces. */
  const headingText = (t: string) => {
    let end = t.trimEnd();
    let hashes = end.length;
    while (hashes > 0 && end[hashes - 1] === '#') hashes--;
    if (hashes < end.length && (hashes === 0 || /\s/.test(end[hashes - 1]!))) end = end.slice(0, hashes).trimEnd();
    return end;
  };
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function render(src: string, depth = 0): string {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    let i = 0;
    const listStack: { tag: string }[] = [];
    const closeLists = (depth = 0) => {
      while (listStack.length > depth) out.push(`</${listStack.pop()!.tag}>`);
    };
    let para: string[] = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    };

    while (i < lines.length) {
      const line = lines[i];
      const fence = line!.match(/^\s*(```|~~~)\s*([\w+-]*)/);
      if (fence) {
        flush();
        closeLists();
        const body: string[] = [];
        i++;
        while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
        i++;
        const lang = fence[2] || '';
        out.push(`<div class="code"><div class="code-head"><span>${esc(lang || 'text')}</span><button class="copy" data-action="copy-code" title="Copy">Copy</button></div><pre><code>${esc(body.join('\n'))}</code></pre></div>`);
        continue;
      }
      if (!line!.trim()) {
        flush();
        if (!(lines[i + 1] && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1]!))) closeLists();
        i++;
        continue;
      }
      const h = line!.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flush();
        closeLists();
        const level = Math.min(6, h[1]!.length + 1);
        out.push(`<h${level}>${inline(headingText(h[2]!))}</h${level}>`);
        i++;
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line!)) {
        flush();
        closeLists();
        out.push('<hr>');
        i++;
        continue;
      }
      if (/^\s*>/.test(line!)) {
        flush();
        closeLists();
        const body: string[] = [];
        while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${depth < MAX_QUOTE_DEPTH ? render(body.join('\n'), depth + 1) : `<p>${inline(body.join(' '))}</p>`}</blockquote>`);
        continue;
      }
      if (line!.includes('|') && lines[i + 1] && isTableSep(lines[i + 1]!)) {
        flush();
        closeLists();
        const head = cells(line!);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const item = line!.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (item) {
        flush();
        const depth = Math.floor(item[1]!.replace(/\t/g, '  ').length / 2) + 1;
        const tag = /\d/.test(item[2]!) ? 'ol' : 'ul';
        while (listStack.length > depth) out.push(`</${listStack.pop()!.tag}>`);
        while (listStack.length < depth) {
          listStack.push({ tag });
          out.push(`<${tag}>`);
        }
        let text = item[3]!;
        const task = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) text = `<span class="check ${task[1] === ' ' ? '' : 'on'}"></span>${inline(task[2]!)}`;
        else text = inline(text);
        i++;
        // Lazy continuation lines belong to the item.
        while (i < lines.length && lines[i]!.trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!) && /^\s{2,}/.test(lines[i]!) && !/^\s*```/.test(lines[i]!)) text += ` ${inline(lines[i++]!.trim())}`;
        out.push(`<li>${text}</li>`);
        continue;
      }
      closeLists();
      para.push(line!.trim());
      i++;
    }
    flush();
    closeLists();
    return out.join('\n');
  }

  /**
   * The report without the json block at its end (the data a program read): found from its last ```json, which a
   * regular expression tried from every blank line of a long report, in time growing with its square.
   */
  function stripJsonBlock(text: string): string {
    const at = text.lastIndexOf('```json');
    if (at === -1) return text.trim();
    const block = text.slice(at).trimEnd();
    const open = block.indexOf('\n');
    const body = block.slice(0, -3);
    return open !== -1 && block.endsWith('```') && body.length > open && /\n[ \t]*$/.test(body) ? text.slice(0, at).trim() : text.trim();
  }

  window.renderMarkdown = render;
  window.stripJsonBlock = stripJsonBlock;
  window.escapeHtml = esc;
})();
