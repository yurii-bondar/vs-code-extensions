// Runs in Penpot's plugin (the Penpot MCP server's execute_code): builds the screens capture.mjs wrote as boards, texts
// and icons on the page "Screens". Resumable: a board built whole carries the stamp of the capture it came from, so a
// call cut short (a plugin call has two minutes) is followed by another that builds only what is left.
// Load it as README.md shows; it evaluates to { run(budgetMs) }.
(() => {
  const BASE = 'http://127.0.0.1:4799/';
  const PAGE = 'Screens';
  const STAMP = 'designSync';
  const fill = (c) => (c ? [{ fillColor: c.c, fillOpacity: c.a }] : []);

  /** The tree as a list of steps, each naming its parent step, in paint order. */
  function flatten(screen) {
    const ops = [{ k: 'root', x: 0, y: 0, w: screen.w, h: screen.h, bg: screen.bg }];
    const add = (node, parent) => {
      const i = ops.length;
      const { kids, ...rest } = node;
      ops.push({ ...rest, p: parent });
      if (kids) for (const k of kids) add(k, i);
    };
    for (const k of screen.kids) add(k, 0);
    return ops;
  }

  function weightVariant(w) { return w === '400' ? 'regular' : w; }

  function makeText(op) {
    const t = penpot.createText(op.s);
    if (!t) return null;
    const f = op.f;
    t.fontFamily = f.fam;
    t.fontId = f.fam === 'Inter' ? 'gfont-inter' : 'gfont-jetbrains-mono';
    t.fontVariantId = weightVariant(f.weight);
    t.fontWeight = f.weight;
    t.fontSize = String(f.size);
    t.lineHeight = String(f.lh);
    t.letterSpacing = String(f.ls);
    t.fills = fill(f.color);
    if (f.u) t.textDecoration = 'underline';
    if (f.align !== 'left') t.align = f.align;
    return t;
  }

  function place(shape, op, parentShape) {
    parentShape.appendChild(shape);
    shape.x = op.x + storage.conv.ox;
    shape.y = op.y + storage.conv.oy;
  }

  function sideRect(parentShape, x, y, w, h, c) {
    const r = penpot.createRectangle();
    r.name = 'border';
    parentShape.appendChild(r);
    r.resize(Math.max(w, 1), Math.max(h, 1));
    r.x = x + storage.conv.ox;
    r.y = y + storage.conv.oy;
    r.fills = fill(c);
    return r;
  }

  function makeBox(op, parentShape) {
    const b = penpot.createBoard();
    b.name = op.n;
    parentShape.appendChild(b);
    b.resize(Math.max(op.w, 1), Math.max(op.h, 1));
    b.x = op.x + storage.conv.ox;
    b.y = op.y + storage.conv.oy;
    b.clipContent = Boolean(op.clip);
    // The board stands even when a style of it is refused: what is inside it still has its parent.
    const tryStyle = (what, fn) => { try { fn(); } catch (e) { const c = storage.conv; c.styleErrors = c.styleErrors || {}; c.styleErrors[what] = String(e).slice(0, 160); } };
    tryStyle('fills', () => { if (op.grad) {
      b.fills = [{ fillColorGradient: { type: 'linear', startX: 0, startY: 0, endX: 1, endY: 1, width: 1, stops: op.grad.map((g, i) => ({ color: g.c, opacity: g.a, offset: i / (op.grad.length - 1) })) } }];
    } else b.fills = fill(op.bg); });
    const [t, r, bt, l] = op.b;
    const same = t && r && bt && l && t.w === r.w && r.w === bt.w && bt.w === l.w && t.c === r.c && r.c === bt.c && bt.c === l.c && t.a === l.a;
    const strokes = [];
    if (same) strokes.push({ strokeColor: t.c, strokeOpacity: t.a, strokeWidth: t.w, strokeAlignment: 'inner', strokeStyle: 'solid' });
    if (op.inset) strokes.push({ strokeColor: op.inset.c, strokeOpacity: op.inset.a, strokeWidth: op.inset.spread, strokeAlignment: 'inner', strokeStyle: 'solid' });
    if (op.outline) strokes.push({ strokeColor: op.outline.c, strokeOpacity: op.outline.a, strokeWidth: op.outline.w, strokeAlignment: 'outer', strokeStyle: 'solid' });
    tryStyle('strokes', () => { b.strokes = strokes.filter((x) => x.strokeColor); });
    const [tl, tr, br, bl] = op.rad;
    if (tl || tr || br || bl) tryStyle('radius', () => { b.borderRadiusTopLeft = tl; b.borderRadiusTopRight = tr; b.borderRadiusBottomRight = br; b.borderRadiusBottomLeft = bl; });
    if (op.sh && op.sh.a) tryStyle('shadow', () => { b.shadows = [{ style: 'drop-shadow', offsetX: op.sh.x, offsetY: op.sh.y, blur: op.sh.blur, spread: op.sh.spread, hidden: false, color: { color: op.sh.c, opacity: op.sh.a } }]; });
    if (op.op) tryStyle('opacity', () => { b.opacity = op.op; });
    // Borders not alike on every side: a line per side (a row's divider, a header's rule).
    // A side whose colour is transparent (a tab's unselected underline) draws nothing.
    if (!same) {
      if (t && t.c) sideRect(b, op.x, op.y, op.w, t.w, t);
      if (bt && bt.c) sideRect(b, op.x, op.y + op.h - bt.w, op.w, bt.w, bt);
      if (l && l.c) sideRect(b, op.x, op.y, l.w, op.h, l);
      if (r && r.c) sideRect(b, op.x + op.w - r.w, op.y, r.w, op.h, r);
    }
    return b;
  }

  async function start({ file, name, x, y, h }) {
    const screen = await (await fetch(BASE + file + '?t=' + Date.now())).json();
    const ops = flatten(screen);
    const root = penpot.createBoard();
    root.name = name;
    root.resize(screen.w, h || screen.h);
    root.x = x;
    root.y = y;
    root.fills = fill(screen.bg);
    root.clipContent = true;
    storage.conv = { ops, i: 1, shapes: { 0: root }, ox: x, oy: y, name, root };
    return { total: ops.length };
  }

  async function step(budgetMs = 80000) {
    const c = storage.conv;
    const t0 = Date.now();
    const parentOf = (i) => c.shapes[i];
    while (c.i < c.ops.length && Date.now() - t0 < budgetMs) {
      const op = c.ops[c.i];
      const parent = parentOf(op.p);
      let made = null;
      try {
        if (op.k === 'box') made = makeBox(op, parent);
        else if (op.k === 'text') {
          made = makeText(op);
          if (made) {
            parent.appendChild(made);
            const lineH = op.f.lh * op.f.size;
            made.x = op.x + c.ox;
            // A text's box in the page is its glyphs (about 1.21em of Inter); Penpot's is its line, centred on them.
            const shift = op.fit ? 0 : (lineH - (op.lines > 1 ? 1.21 * op.f.size : op.h)) / 2;
            made.y = op.y + c.oy - shift;
            if (op.lines > 1 || op.pre) { made.growType = 'auto-height'; made.resize(op.w + 2, Math.max(op.h, lineH)); }
            else made.growType = 'auto-width';
            made.name = op.s.slice(0, 40);
          }
        } else if (op.k === 'svg') {
          made = penpot.createShapeFromSvg(op.svg);
          // Penpot sizes an SVG by its viewBox: scaled back to the size it is drawn at.
          if (made) { place(made, op, parent); made.resize(op.w, op.h); made.x = op.x + c.ox; made.y = op.y + c.oy; made.name = op.n; if (op.rot) made.rotate(op.rot); }
        }
      } catch (e) {
        c.errors = (c.errors || 0) + 1;
        c.firstError = c.firstError || `${op.k} ${op.n || op.s || ''}: ${String(e).slice(0, 200)}`;
      }
      if (made && op.k === 'box') c.shapes[c.i] = made;
      c.i++;
    }
    return { i: c.i, total: c.ops.length, done: c.i >= c.ops.length, errors: c.errors || 0, firstError: c.firstError, styleErrors: c.styleErrors, ms: Date.now() - t0 };
  }

  /** The page the screens go on, opened (a plugin changes only the page open), made when there is none. */
  function screensPage() {
    let page = penpot.currentFile.pages.find((p) => p.name === PAGE);
    if (!page) { page = penpot.createPage(); page.name = PAGE; }
    if (penpot.currentPage.id !== page.id) penpot.openPage(page);
    return page;
  }

  /**
   * Builds the boards of screens.json not built yet from this capture, for as long as the budget lasts. Call again
   * while `left` is above 0.
   */
  async function run(budgetMs = 40000) {
    const t0 = Date.now();
    const manifest = await (await fetch(BASE + 'screens.json?t=' + Date.now())).json();
    const page = screensPage();
    const done = (b) => page.root.children.some((s) => s.name === b.name && s.getPluginData(STAMP) === manifest.stamp);
    const built = [];
    for (const board of manifest.boards) {
      if (done(board)) continue;
      if (Date.now() - t0 > budgetMs - 5000) break;
      const going = storage.conv && storage.conv.name === board.name && storage.conv.stamp === manifest.stamp && !storage.conv.finished;
      if (!going) {
        // A board of an earlier capture, or one a cut-short call left half built.
        for (const o of page.root.children.filter((s) => s.name === board.name)) o.remove();
        await start(board);
        storage.conv.stamp = manifest.stamp;
      }
      const r = await step(budgetMs - (Date.now() - t0) - 3000);
      if (!r.done) break;
      storage.conv.finished = true;
      storage.conv.root.setPluginData(STAMP, manifest.stamp);
      built.push({ name: board.name, errors: r.errors, ...(r.firstError && { firstError: r.firstError }) });
    }
    const left = manifest.boards.filter((b) => !done(b)).map((b) => b.name);
    return { built, left: left.length, next: left[0] || null };
  }

  return { run };
})()
