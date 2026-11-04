// In-page: the rendered dashboard as a tree of boxes, texts and icons, in page coordinates, for building in Penpot.
(() => {
  const canvas = document.createElement('canvas').getContext('2d');
  const color = (c) => {
    if (!c || c === 'transparent') return null;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      const a = p[3] === undefined ? 1 : p[3];
      if (a === 0) return null;
      return { c: '#' + p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''), a: +a.toFixed(3) };
    }
    const n = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
    if (n) {
      const a = n[4] === undefined ? 1 : +n[4];
      if (a === 0) return null;
      return { c: '#' + [n[1], n[2], n[3]].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''), a: +a.toFixed(3) };
    }
    return null;
  };
  const fam = (f) => (/mono|menlo|monaco|courier|jetbrains/i.test(f) ? 'JetBrains Mono' : 'Inter');
  const px = (v) => parseFloat(v) || 0;
  const R = (r) => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  const name = (el) => (el.classList.length ? `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join('.')}` : el.dataset.region ? `${el.tagName.toLowerCase()}[${el.dataset.region}]` : el.tagName.toLowerCase());

  const font = (cs) => {
    const size = px(cs.fontSize);
    const lh = cs.lineHeight === 'normal' ? 1.25 : px(cs.lineHeight) / size;
    return { fam: fam(cs.fontFamily), size, weight: String(Math.min(700, Math.max(400, Math.round(+cs.fontWeight / 100) * 100))), color: color(cs.color) || { c: '#000000', a: 1 }, ls: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing), lh: +lh.toFixed(3), italic: cs.fontStyle === 'italic', u: /underline/.test(cs.textDecorationLine), align: cs.textAlign === 'center' ? 'center' : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'right' : 'left' };
  };
  /** A field's placeholder colour, from the page's own `::placeholder` rule (computed styles do not give it). */
  const placeholder = (el) => {
    const rules = [];
    const collect = (list) => { for (const r of list) { if (r.cssRules && !r.selectorText) collect(r.cssRules); else if (r.selectorText && r.selectorText.includes('::placeholder')) rules.push(r); } };
    for (const sh of document.styleSheets) { try { collect(sh.cssRules); } catch { /* another origin's sheet */ } }
    let col = null, op = 1;
    for (const r of rules) for (const sel of r.selectorText.split(',')) {
      if (!sel.includes('::placeholder')) continue;
      const base = sel.replace(/::placeholder/g, '').trim() || '*';
      try { if (!el.matches(base)) continue; } catch { continue; }
      if (r.style.color) { const tmp = document.createElement('span'); tmp.style.color = r.style.color; el.parentElement.appendChild(tmp); col = color(getComputedStyle(tmp).color); tmp.remove(); }
      if (r.style.opacity) op = +r.style.opacity;
    }
    if (!col) { const tmp = document.createElement('span'); tmp.style.color = 'var(--cs-text-secondary)'; el.parentElement.appendChild(tmp); col = color(getComputedStyle(tmp).color); tmp.remove(); }
    return col && { c: col.c, a: +(col.a * op).toFixed(3) };
  };
  const transform = (s, cs) => (cs.textTransform === 'uppercase' ? s.toUpperCase() : cs.textTransform === 'capitalize' ? s.replace(/\b\w/g, (x) => x.toUpperCase()) : s);

  /** The text as shown: cut with an ellipsis to the room its element has when the element cuts it. */
  const shown = (s, el, cs) => {
    if (cs.textOverflow !== 'ellipsis' || el.scrollWidth <= el.clientWidth + 1) return s;
    canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const room = el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (canvas.measureText(s.slice(0, mid).trimEnd() + '…').width <= room) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo).trimEnd() + '…';
  };

  function textNode(tn, el, cs) {
    const pre = /pre/.test(cs.whiteSpace);
    let s = pre ? tn.nodeValue.replace(/\n$/, '') : tn.nodeValue.replace(/\s+/g, ' ');
    if (!s.trim()) return null;
    const range = document.createRange();
    range.selectNodeContents(tn);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    // A space at a block's edge is not drawn; one beside an inline element (`what it <b>produces</b> decides`) is.
    if (!pre) {
      const prev = tn.previousSibling, next = tn.nextSibling;
      s = prev && prev.nodeType === 1 ? s.replace(/^\s+/, ' ') : s.trimStart();
      s = next && next.nodeType === 1 ? s.replace(/\s+$/, ' ') : s.trimEnd();
    }
    const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
    const lines = new Set(rects.map((r) => Math.round(r.top))).size;
    const box = R({ left, top, width: right - left, height: bottom - top });
    return { k: 'text', s: transform(lines > 1 ? s : shown(s, el, cs), cs), ...box, lines, f: font(cs), ...(pre && { pre: true }) };
  }

  function svgNode(el, cs) {
    const r = R(el.getBoundingClientRect());
    if (!r.w || !r.h) return null;
    const c = color(cs.color);
    const clone = el.cloneNode(true);
    clone.setAttribute('width', r.w);
    clone.setAttribute('height', r.h);
    clone.removeAttribute('class');
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // Each part's own computed paint: currentColor and inherited stroke widths, as drawn.
    const src = [el, ...el.querySelectorAll('*')], dst = [clone, ...clone.querySelectorAll('*')];
    src.forEach((s, i) => {
      const scs = getComputedStyle(s), d = dst[i];
      for (const p of ['fill', 'stroke']) {
        const v = scs[p];
        if (!v || v === 'none') d.setAttribute(p, 'none');
        else { const cc = color(v); if (cc) { d.setAttribute(p, cc.c); if (cc.a < 1) d.setAttribute(`${p}-opacity`, cc.a); } else if (/url/.test(v)) d.setAttribute(p, v); }
      }
      if (scs.stroke && scs.stroke !== 'none') d.setAttribute('stroke-width', scs.strokeWidth);
    });
    // A turned icon (an open section's chevron): its turn, as CSS gives it.
    let rot = 0;
    if (cs.transform && cs.transform !== 'none') { const m = new DOMMatrix(cs.transform); rot = Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI); }
    return { k: 'svg', ...r, svg: clone.outerHTML, n: el.getAttribute('class') || 'icon', ...(c && { col: c }), ...(rot && { rot }) };
  }

  function boxOf(el, cs) {
    const bg = color(cs.backgroundColor);
    const grad = /linear-gradient/.test(cs.backgroundImage) ? (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(color).filter(Boolean) : null;
    const side = (s) => (cs[`border${s}Style`] !== 'none' && px(cs[`border${s}Width`]) > 0 && color(cs[`border${s}Color`]) ? { w: px(cs[`border${s}Width`]), ...color(cs[`border${s}Color`]) } : null);
    const b = ['Top', 'Right', 'Bottom', 'Left'].map(side);
    const rad = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((c) => px(cs[`border${c}Radius`]));
    let sh = null;
    if (cs.boxShadow && cs.boxShadow !== 'none' && !/inset/.test(cs.boxShadow)) {
      const col = cs.boxShadow.match(/rgba?\([^)]+\)/);
      const nums = cs.boxShadow.replace(/rgba?\([^)]+\)/, '').trim().split(/\s+/).map(px);
      if (col) sh = { ...color(col[0]), x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0 };
    }
    let inset = null;
    if (cs.boxShadow && /inset/.test(cs.boxShadow)) {
      const col = cs.boxShadow.match(/rgba?\([^)]+\)/);
      const nums = cs.boxShadow.replace(/rgba?\([^)]+\)/, '').replace('inset', '').trim().split(/\s+/).map(px);
      if (col && color(col[0])) inset = { ...color(col[0]), spread: nums[3] || nums[2] || 1 };
    }
    const outline = cs.outlineStyle !== 'none' && px(cs.outlineWidth) > 0 ? { w: px(cs.outlineWidth), ...color(cs.outlineColor) } : null;
    const clip = /hidden|auto|scroll|clip/.test(cs.overflow);
    const visual = bg || (grad && grad.length) || b.some(Boolean) || sh || inset || outline;
    return { visual, bg, grad: grad && grad.length > 1 ? grad : null, b, rad, sh, inset, outline, clip };
  }

  /** A ::before or ::after drawn as a box at a set place (a switch's knob): page coordinates from its offsets. */
  function pseudoBox(el, which, cs, r) {
    const ps = getComputedStyle(el, which);
    if (!ps.content || ps.content === 'none' || ps.display === 'none' || ps.position !== 'absolute') return null;
    const w = px(ps.width), h = px(ps.height);
    if (!w || !h) return null;
    const bx = boxOf(el, ps);
    if (!bx.visual) return null;
    let tx = 0, ty = 0;
    if (ps.transform && ps.transform !== 'none') { const m = new DOMMatrix(ps.transform); tx = m.e; ty = m.f; }
    const left = ps.left === 'auto' ? (ps.right === 'auto' ? 0 : r.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - w - px(ps.right)) : px(ps.left);
    const top = ps.top === 'auto' ? (ps.bottom === 'auto' ? 0 : r.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - h - px(ps.bottom)) : px(ps.top);
    const x = r.left + scrollX + px(cs.borderLeftWidth) + left + tx, y = r.top + scrollY + px(cs.borderTopWidth) + top + ty;
    return { k: 'box', n: `${name(el)}${which}`, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), ...(bx.bg && { bg: bx.bg }), b: bx.b, rad: bx.rad, ...(bx.sh && { sh: bx.sh }), kids: [] };
  }

  /** Where a child paints among its siblings: by its z-index when it is positioned (the rail's sheet over the page). */
  const zOf = (node) => {
    if (node.nodeType !== 1 || node instanceof SVGElement) return 0;
    const c = getComputedStyle(node);
    return c.position !== 'static' && c.zIndex !== 'auto' ? +c.zIndex : 0;
  };

  function walk(el, out) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (el.id === 'toasts' || el.classList.contains('sr-only')) return;
    // Not drawn: the inside of a closed <details>, and the like.
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) return;
    const r = el.getBoundingClientRect();
    if (el instanceof SVGElement) { if (el.tagName.toLowerCase() === 'svg') { const s = svgNode(el, cs); if (s) out.push(s); } return; }
    const op = +cs.opacity;
    if (op === 0) return;
    const bx = boxOf(el, cs);
    // Inside a box that clips, what lies outside it is not drawn.
    const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    let node = null, kids = out;
    if ((bx.visual || op < 1 || isField) && r.width > 0 && r.height > 0) {
      node = { k: 'box', n: name(el), ...R(r), ...(bx.bg && { bg: bx.bg }), ...(bx.grad && { grad: bx.grad }), b: bx.b, rad: bx.rad, ...(bx.sh && { sh: bx.sh }), ...(bx.inset && { inset: bx.inset }), ...(bx.outline && { outline: bx.outline }), ...(bx.clip && { clip: true }), ...(op < 1 && { op }), kids: [] };
      out.push(node);
      kids = node.kids;
    }
    if (isField) {
      if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'hidden') return;
      const v = el.tagName === 'SELECT' ? (el.selectedOptions[0] || {}).text || '' : el.value;
      const ph = !v && el.placeholder;
      const s = v || el.placeholder || '';
      if (!s) return;
      const f = font(cs);
      if (ph) f.color = placeholder(el) || f.color;
      const pl = px(cs.paddingLeft) + px(cs.borderLeftWidth), pt = px(cs.paddingTop) + px(cs.borderTopWidth);
      const multi = el.tagName === 'TEXTAREA';
      const lineH = f.lh * f.size;
      const w = r.width - pl - px(cs.paddingRight) - px(cs.borderRightWidth);
      kids.push({ k: 'text', s: multi ? s : s.replace(/\s+/g, ' '), x: Math.round(r.left + scrollX + pl), y: Math.round(r.top + scrollY + (multi ? pt : (r.height - lineH) / 2)), w: Math.round(w), h: Math.round(lineH), lines: multi ? 2 : 1, f, ...(multi ? {} : { fit: true }) });
      return;
    }
    // A list item's bullet or number, which is a marker, not text: drawn left of the item, as `outside` places it.
    if (el.tagName === 'LI' && cs.display === 'list-item' && cs.listStyleType !== 'none') {
      const f = font(cs);
      const ordered = /decimal/.test(cs.listStyleType);
      const mark = ordered ? `${[...el.parentElement.children].indexOf(el) + 1}.` : cs.listStyleType === 'circle' ? '◦' : '•';
      kids.push({ k: 'text', s: mark, x: Math.round(r.left + scrollX - (ordered ? 1.4 : 0.9) * f.size), y: Math.round(r.top + scrollY + px(cs.paddingTop)), w: 12, h: Math.round(f.lh * f.size), lines: 1, f, fit: true });
    }
    // A <summary>'s disclosure triangle, which is a marker, not text.
    if (el.tagName === 'SUMMARY' && cs.display === 'list-item') {
      const f = font(cs);
      kids.push({ k: 'text', s: el.parentElement && el.parentElement.open ? '▾' : '▸', x: Math.round(r.left + scrollX + px(cs.paddingLeft)), y: Math.round(r.top + scrollY + (r.height - f.lh * f.size) / 2), w: 10, h: Math.round(f.lh * f.size), lines: 1, f: { ...f, size: Math.round(f.size * 0.8) }, fit: true });
    }
    const before = pseudoBox(el, '::before', cs, r);
    if (before) kids.push(before);
    const parts = [];
    for (const ch of el.childNodes) {
      const part = [];
      if (ch.nodeType === 3) { const t = textNode(ch, el, cs); if (t) part.push(t); }
      else if (ch.nodeType === 1) walk(ch, part);
      if (part.length) parts.push({ z: zOf(ch), part });
    }
    // Stable: siblings of one z-index keep the order of the page.
    parts.sort((a, b) => a.z - b.z);
    for (const p of parts) kids.push(...p.part);
    const after = pseudoBox(el, '::after', cs, r);
    if (after) kids.push(after);
  }

  const root = document.querySelector('#app');
  const out = [];
  walk(root, out);
  const W = document.documentElement.clientWidth;
  const H = Math.max(innerHeight, document.documentElement.scrollHeight);
  const bodyBg = color(getComputedStyle(document.body).backgroundColor);
  return JSON.stringify({ w: W, h: H, bg: bodyBg, kids: out });
})()
