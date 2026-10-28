// Set Up AI Config Files. The extension says what the preset would put where and what is already there; the page lets
// the person untick what they do not want and sends the rest back. Drawn from HTML strings, handled by `data-act`.
(() => {
  type Item = import('../src/aiWire').ItemView;
  type Root = import('../src/aiWire').RootView;
  type Result = import('../src/aiWire').ResultView;
  type PresetId = import('../src/aiWire').PresetId;
  type ToolId = import('../src/aiWire').ToolId;
  type Message = import('../src/aiWire').ClientMessage;
  type Incoming = import('../src/aiWire').HostMessage;

  const api = acquireVsCodeApi();
  const send = (message: Message): void => api.postMessage(message);
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const TOOLS: { id: ToolId; name: string; note: string; tone: string }[] = [
    { id: 'claude', name: 'Claude Code', note: '.claude/ links to the shared folders', tone: 'claude' },
    { id: 'cursor', name: 'Cursor', note: '.cursor/ links to the shared folders', tone: 'cursor' },
    { id: 'agents', name: 'Codex and others', note: 'AGENTS.md is a link to CLAUDE.md', tone: 'agents' },
  ];

  const ICONS: Record<string, string> = {
    dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4.5M12 17.5v.1"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  const icon = (name: string): string => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

  // ---------- what the page knows ----------

  let roots: Root[] = [];
  let platform = '';
  let root = '';
  let preset: PresetId = 'several';
  const tools = new Set<ToolId>(['claude', 'cursor', 'agents']);
  /** Paths the person unticked. */
  const skip = new Set<string>();
  let items: Item[] = [];
  let results: Result[] | undefined;
  let loaded = false;

  const request = (): void => {
    if (root) send({ type: 'plan', root, preset, tools: [...tools] });
  };

  const byPath = (path: string): Item | undefined => items.find((i) => i.path === path);

  /** Will this be created if the person presses Create: new, not unticked, and its target will exist. */
  function on(item: Item): boolean {
    if (item.status !== 'create' || skip.has(item.path)) return false;
    if (!item.needs || item.needsOk) return true;
    const need = byPath(item.needs);
    return !need || on(need);
  }

  const tone = (path: string): string => {
    if (path.startsWith('.aiassistant')) return 'shared';
    if (path.startsWith('.cursor')) return 'cursor';
    if (path === 'AGENTS.md') return 'agents';
    return 'claude';
  };

  const groupOf = (path: string): string => (path.includes('/') ? `${path.split('/')[0] ?? ''}/` : 'Project root');

  // ---------- drawing ----------

  function itemHtml(item: Item): string {
    const checked = on(item);
    const blocked = item.status === 'create' && !checked && !skip.has(item.path);
    const disabled = item.status !== 'create' || blocked;
    const name = item.path.includes('/') ? item.path.slice(item.path.indexOf('/') + 1) : item.path;
    const badge =
      item.status === 'exists'
        ? `<span class="badge there">${icon('check')}Already there</span>`
        : item.status === 'conflict'
          ? `<span class="badge conflict">${icon('warn')}Different one exists</span>`
          : blocked
            ? '<span class="badge off">Needs ' + esc(item.needs) + '</span>'
            : checked
              ? '<span class="badge new">New</span>'
              : '<span class="badge off">Skipped</span>';
    const target = item.kind === 'link' ? `<span class="arrow">${icon('link')}<code>${esc(item.target)}</code></span>` : '';
    const note = item.status === 'conflict' ? 'Left as it is: this tool will not overwrite it.' : item.hint;
    return `<li class="item t-${tone(item.path)}${checked ? ' on' : ''}${disabled ? ' locked' : ''}${item.status === 'exists' ? ' exists' : ''}">
      <label class="pick">
        <input type="checkbox" data-act="item" data-path="${esc(item.path)}" ${checked || item.status === 'exists' ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span class="box">${icon('check')}</span>
        <span class="glyph">${icon(item.kind === 'dir' ? 'dir' : item.kind === 'file' ? 'file' : 'link')}</span>
        <span class="text">
          <span class="line"><span class="name">${esc(name)}${item.kind === 'dir' ? '/' : ''}</span>${target}</span>
          <span class="hint">${esc(note)}</span>
        </span>
        ${badge}
      </label>
    </li>`;
  }

  function groupsHtml(): string {
    const groups = new Map<string, Item[]>();
    for (const item of items) groups.set(groupOf(item.path), [...(groups.get(groupOf(item.path)) ?? []), item]);
    return [...groups]
      .map(([name, list]) => {
        const open = list.filter((i) => i.status === 'create');
        const onCount = open.filter(on).length;
        const all = open.length > 0 && onCount === open.length;
        const some = onCount > 0 && !all;
        const toggle = open.length
          ? `<label class="gpick"><input type="checkbox" data-act="group" data-group="${esc(name)}" ${all ? 'checked' : ''} ${some ? 'data-mixed="1"' : ''}><span class="box${some ? ' mixed' : ''}">${icon(some ? 'x' : 'check')}</span><span class="gname">${esc(name)}</span></label>`
          : `<span class="gpick static"><span class="gname">${esc(name)}</span></span>`;
        return `<section class="group t-${tone(list[0]?.path ?? '')}"><header>${toggle}</header><ul>${list.map(itemHtml).join('')}</ul></section>`;
      })
      .join('');
  }

  function resultHtml(): string {
    if (!results) return '';
    const made = results.filter((r) => r.status === 'created').length;
    const failed = results.filter((r) => r.status === 'failed');
    const claude = results.some((r) => r.path === 'CLAUDE.md' && (r.status === 'created' || r.status === 'exists'));
    if (failed.length) {
      return `<div class="banner bad">${icon('warn')}<div><strong>Created ${made}, ${failed.length} failed.</strong>
        <ul>${failed.map((f) => `<li><code>${esc(f.path)}</code> ${esc(f.error)}</li>`).join('')}</ul>
        ${platform === 'win32' ? '<p>Windows may need Developer Mode to create links.</p>' : ''}</div></div>`;
    }
    return `<div class="banner good">${icon('check')}<div><strong>${made ? `Created ${made} item${made === 1 ? '' : 's'}.` : 'Nothing new to create.'}</strong></div>
      ${claude ? '<button class="btn ghost" data-act="open">Open CLAUDE.md</button>' : ''}</div>`;
  }

  function render(): void {
    const app = document.getElementById('app');
    if (!app) return;
    if (loaded && !roots.length) {
      app.innerHTML = `<main><div class="empty">${icon('spark')}<h2>Open a folder first</h2><p>AI config files go into the project.</p></div></main>`;
      return;
    }
    const creating = items.filter(on).length;
    const skipped = items.filter((i) => i.status === 'create' && !on(i)).length;
    const there = items.filter((i) => i.status === 'exists').length;
    const conflicts = items.filter((i) => i.status === 'conflict').length;
    const summary = [
      `<strong>${creating}</strong> to create`,
      skipped ? `${skipped} skipped` : '',
      there ? `${there} already there` : '',
      conflicts ? `<span class="warn-text">${conflicts} left alone</span>` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    app.innerHTML = `
      <div class="glow" aria-hidden="true"></div>
      <main>
        <header class="top">
          <span class="logo">${icon('layers')}</span>
          <div>
            <h1>Set up AI config files</h1>
            <p class="muted">Pick a setup, untick what you do not want, and nothing is written until you press Create. Existing files are never overwritten.</p>
          </div>
        </header>
        ${
          roots.length > 1
            ? `<label class="rootpick">Project <select data-act="root">${roots.map((r) => `<option value="${esc(r.path)}"${r.path === root ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>`
            : `<p class="rootline">${icon('dir')}<code>${esc(root)}</code></p>`
        }
        <div class="presets" role="radiogroup" aria-label="Setup">
          <button class="preset claude${preset === 'claude-only' ? ' sel' : ''}" role="radio" aria-checked="${preset === 'claude-only'}" data-act="preset" data-preset="claude-only">
            <span class="pi">${icon('spark')}</span>
            <strong>Claude Code only</strong>
            <span class="muted">CLAUDE.md with its own .claude/rules and .claude/skills.</span>
          </button>
          <button class="preset multi${preset === 'several' ? ' sel' : ''}" role="radio" aria-checked="${preset === 'several'}" data-act="preset" data-preset="several">
            <span class="pi">${icon('layers')}</span>
            <strong>Several AI tools</strong>
            <span class="muted">One shared .aiassistant/ folder, linked for each tool you pick.</span>
          </button>
        </div>
        ${
          preset === 'several'
            ? `<div class="tools" role="group" aria-label="Link for">
                <span class="label">Link it for</span>
                ${TOOLS.map((t) => `<button class="tool t-${t.tone}${tools.has(t.id) ? ' sel' : ''}" aria-pressed="${tools.has(t.id)}" data-act="tool" data-tool="${t.id}" title="${esc(t.note)}"><span class="tick">${icon('check')}</span>${t.name}</button>`).join('')}
                <span class="tool static t-shared" title="Always created">JetBrains AI Assistant</span>
              </div>`
            : ''
        }
        ${resultHtml()}
        <div class="list">${groupsHtml() || '<p class="muted">Loading…</p>'}</div>
        ${platform === 'win32' ? '<p class="note">On Windows, folders are linked with junctions; the AGENTS.md link may need Developer Mode.</p>' : ''}
      </main>
      <footer class="bar"><div class="bar-in">
        <span class="summary">${summary}</span>
        <button class="btn primary" data-act="create" ${creating ? '' : 'disabled'}>Create ${creating || ''}</button>
      </div></footer>`;
    for (const box of Array.from(document.querySelectorAll<HTMLInputElement>('input[data-mixed]'))) box.indeterminate = true;
  }

  // ---------- input ----------

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button[data-act]') : null;
    if (!target) return;
    switch (target.dataset['act']) {
      case 'preset': {
        const next = target.dataset['preset'] === 'claude-only' ? 'claude-only' : 'several';
        if (next === preset) return;
        preset = next;
        results = undefined;
        request();
        render();
        return;
      }
      case 'tool': {
        const id = target.dataset['tool'] as ToolId;
        if (tools.has(id)) tools.delete(id);
        else tools.add(id);
        results = undefined;
        request();
        render();
        return;
      }
      case 'create':
        send({ type: 'create', root, preset, tools: [...tools], skip: items.filter((i) => i.status === 'create' && !on(i)).map((i) => i.path) });
        return;
      case 'open':
        send({ type: 'open', root, path: 'CLAUDE.md' });
        return;
      default:
        return;
    }
  });

  document.addEventListener('change', (event) => {
    const el = event.target;
    if (el instanceof HTMLSelectElement && el.dataset['act'] === 'root') {
      root = el.value;
      skip.clear();
      results = undefined;
      request();
      return;
    }
    if (!(el instanceof HTMLInputElement)) return;
    results = undefined;
    if (el.dataset['act'] === 'item') {
      const path = el.dataset['path'] ?? '';
      if (el.checked) skip.delete(path);
      else skip.add(path);
    } else if (el.dataset['act'] === 'group') {
      const open = items.filter((i) => i.status === 'create' && groupOf(i.path) === el.dataset['group']);
      for (const i of open) {
        if (el.checked) skip.delete(i.path);
        else skip.add(i.path);
      }
    } else {
      return;
    }
    render();
  });

  window.addEventListener('message', (event: MessageEvent<Incoming>) => {
    const m = event.data;
    switch (m.type) {
      case 'init':
        roots = m.roots;
        platform = m.platform;
        root = roots[0]?.path ?? '';
        loaded = true;
        request();
        render();
        return;
      case 'plan':
        if (m.root !== root) return;
        items = m.items;
        render();
        return;
      case 'result':
        results = m.results;
        render();
        return;
      default: {
        const unreachable: never = m;
        return unreachable;
      }
    }
  });

  render();
  send({ type: 'ready' });
})();
