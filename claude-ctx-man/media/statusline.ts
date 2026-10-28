// Status line editor. The extension sends the config, the accounts and the presets once; every change goes
// back as a whole config, is saved to ~/.ctx-man/statusline.json, and comes back as a new preview.
// The page is built from HTML strings and handles input by event delegation on `data-*` attributes.
(() => {
  const api = acquireVsCodeApi();
  const $$ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] => Array.from(root.querySelectorAll<T>(selector));
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  // ---------- what the page knows about segments ----------

  type OptionKey = 'accountColor' | 'showAheadBehind' | 'showDirty' | 'colorByLevel' | 'thresholds' | 'showReset' | 'format' | 'text';
  type CheckOption = Exclude<OptionKey, 'format' | 'text'>;
  type Tab = 'layout' | 'style' | 'accounts' | 'install';

  const SEGMENTS: Record<SegmentId, { name: string; desc: string; opts: OptionKey[] }> = {
    profile: { name: 'Account', desc: 'Which Claude account is running', opts: ['accountColor'] },
    project: { name: 'Project', desc: 'Git repository or folder name', opts: [] },
    git: { name: 'Git branch', desc: 'Branch, commits ahead and behind, changed files', opts: ['showAheadBehind', 'showDirty'] },
    model: { name: 'Model', desc: 'For example Opus 5.5', opts: [] },
    effort: { name: 'Effort', desc: 'low, medium or high', opts: ['colorByLevel'] },
    context: { name: 'Context window', desc: 'How full the context is', opts: ['format', 'thresholds'] },
    tokens: { name: 'Tokens', desc: 'Total tokens used in this session', opts: [] },
    five_hour: { name: '5-hour limit', desc: 'Usage of the 5-hour window', opts: ['format', 'thresholds', 'showReset'] },
    seven_day: { name: 'Weekly limit', desc: 'Usage of the weekly window', opts: ['format', 'thresholds', 'showReset'] },
    cost: { name: 'Cost', desc: 'Session cost in USD at API prices', opts: [] },
    lines: { name: 'Lines changed', desc: '+added −removed in this session', opts: [] },
    duration: { name: 'Session time', desc: 'How long the session has run', opts: [] },
    clock: { name: 'Clock', desc: 'The current time', opts: [] },
    output_style: { name: 'Output style', desc: 'Shown when it is not the default', opts: [] },
    version: { name: 'Claude Code version', desc: 'The installed version', opts: [] },
    text: { name: 'Custom text', desc: 'Any fixed text', opts: ['text'] },
  };

  type OptionDef = { type: 'check'; label: string } | { type: 'select'; label: string; options: [BarFormat, string][] } | { type: 'text'; label: string };
  const OPTIONS: Record<OptionKey, OptionDef> = {
    accountColor: { type: 'check', label: "Use the account's color (set in Names)" },
    showAheadBehind: { type: 'check', label: 'Show commits ahead and behind (↑2 ↓1)' },
    showDirty: { type: 'check', label: 'Show changed and untracked files (!3 ?1)' },
    colorByLevel: { type: 'check', label: 'Color by level (low green, medium yellow, high red)' },
    thresholds: { type: 'check', label: 'Color by usage (warn and danger levels in Style)' },
    showReset: { type: 'check', label: 'Show the time until reset' },
    format: { type: 'select', label: 'Show as', options: [['pct', '77%'], ['bar', '▰▰▰▰▰▰▱▱'], ['both', '▰▰▰▰▰▰▱▱ 77%']] },
    text: { type: 'text', label: 'Text' },
  };

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'layout', label: 'Layout', icon: 'layout' },
    { id: 'style', label: 'Style', icon: 'palette' },
    { id: 'accounts', label: 'Names', icon: 'users' },
    { id: 'install', label: 'Install', icon: 'download' },
  ];

  // Approximate terminal palette, used for the preview and the swatches.
  const NAMED: Record<string, string> = {
    black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4', gray: '#7f848e',
    brightRed: '#ff7a85', brightGreen: '#a5e075', brightYellow: '#f0d38a', brightBlue: '#4dc4ff', brightMagenta: '#de73ff', brightCyan: '#4cd1e0', brightWhite: '#ffffff',
  };
  const SGR_NAMED: Record<number, string> = { 30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white', 90: 'gray', 91: 'brightRed', 92: 'brightGreen', 93: 'brightYellow', 94: 'brightBlue', 95: 'brightMagenta', 96: 'brightCyan', 97: 'brightWhite' };
  const EMOJI = ['👤', '📁', '🌿', '🧠', '⚡', '📊', '💰', '⏱', '🕐', '🔥', '✨', '🤖', '◆', '▸', '●'];

  const ICONS: Record<string, string> = {
    layout: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M9 10v10"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 1.6-2.1-.4-1.2.4-2.4 1.7-2.4H17a4 4 0 0 0 4-4C21 6.9 17 3 12 3Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3.5 5.5"/>',
    download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    terminal: '<path d="m5 8 4 4-4 4M12 16h7"/>',
  };
  const icon = (name: string): string => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

  // ---------- state ----------

  let config!: StatusLineConfig;
  let accounts: AccountView[] = [];
  let presets: PresetView[] = [];
  let configFile = '';
  let selected: SegmentId = 'profile';
  let tab: Tab = 'layout';
  /** The folders Apply and Restore act on. */
  const targets = new Set<string>();
  let dragId: SegmentId | null = null;

  const segById = (id: SegmentId): SegmentConfig | undefined => config.segments.find((s) => s.id === id);
  const current = (): SegmentConfig => segById(selected) ?? (config.segments[0] as SegmentConfig);
  const isSegmentId = (id: string | undefined): id is SegmentId => !!id && id in SEGMENTS;

  // ---------- helpers ----------

  function toast(message: string, kind: ToastKind = 'info'): void {
    const node = document.createElement('div');
    node.className = `toast toast-${kind}`;
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.innerHTML = `${icon(kind === 'error' ? 'close' : 'check')}<span>${esc(message)}</span>`;
    el('toasts').appendChild(node);
    setTimeout(() => node.classList.add('hide'), kind === 'error' ? 6000 : 3500);
    setTimeout(() => node.remove(), kind === 'error' ? 6500 : 4000);
  }

  let saveTimer: number | undefined;
  /** Saves after a short pause, and redraws the named sections now. */
  function changed(...sections: (keyof typeof RENDER)[]): void {
    clearTimeout(saveTimer);
    el('save-state').className = 'save saving';
    el('save-state').textContent = 'Saving…';
    saveTimer = window.setTimeout(() => {
      api.postMessage({ type: 'update', config });
      el('save-state').className = 'save';
      el('save-state').innerHTML = `${icon('check')}Saved`;
    }, 150);
    for (const section of sections) RENDER[section]();
  }

  const cssColor = (c: string): string => (!c ? '' : NAMED[c] ?? (/^#[0-9a-f]{6}$/i.test(c) ? c : /^\d+$/.test(c) ? xterm(Number(c)) : ''));

  function xterm(n: number): string {
    if (n < 16) return Object.values(NAMED)[n % 9] ?? '#ccc';
    if (n >= 232) {
      const v = 8 + (n - 232) * 10;
      return `rgb(${v},${v},${v})`;
    }
    const i = n - 16;
    const c = (x: number): number => (x ? 55 + x * 40 : 0);
    return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
  }

  function ansiToHtml(ansi: string): string {
    interface Style { color?: string; bold?: boolean; dim?: boolean }
    let html = '';
    let style: Style = {};
    const open = (): string => {
      const css: string[] = [];
      if (style.color) css.push(`color:${style.color}`);
      if (style.bold) css.push('font-weight:bold');
      if (style.dim) css.push('opacity:.6');
      return css.length ? `<span style="${css.join(';')}">` : '<span>';
    };
    // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC
    const parts = ansi.split(/\x1b\[([\d;]*)m/);
    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) html += `${open()}${esc(part)}</span>`;
        return;
      }
      const codes = part === '' ? [0] : part.split(';').map(Number);
      for (let j = 0; j < codes.length; j++) {
        const c = codes[j] ?? 0;
        const named = SGR_NAMED[c];
        if (c === 0) style = {};
        else if (c === 1) style.bold = true;
        else if (c === 2) style.dim = true;
        else if (c === 22) style.bold = style.dim = false;
        else if (c === 39) delete style.color;
        else if (named) style.color = NAMED[named] ?? '';
        else if (c === 38 && codes[j + 1] === 5) {
          style.color = xterm(codes[j + 2] ?? 0);
          j += 2;
        } else if (c === 38 && codes[j + 1] === 2) {
          style.color = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`;
          j += 4;
        }
      }
    });
    return html;
  }

  // ---------- color picker ----------

  const isHex = (c: string): boolean => /^#[0-9a-f]{6}$/i.test(c);

  function cssToHex(c: string): string {
    if (!c) return '';
    if (c.startsWith('#')) return c;
    const m = c.match(/\d+/g);
    return m ? `#${m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : '';
  }

  function colorPicker(key: string, value: string, allowDefault = true): string {
    const swatches = Object.entries(NAMED)
      .map(([name, hex]) => `<button class="sw${value === name ? ' on' : ''}" data-color-key="${esc(key)}" data-color="${name}" title="${name}" aria-label="${name}" style="background:${hex}"></button>`)
      .join('');
    const hex = isHex(value) ? value : cssToHex(cssColor(value)) || '#ffffff';
    return `<div class="color-picker">
      ${allowDefault ? `<button class="sw none${!value ? ' on' : ''}" data-color-key="${esc(key)}" data-color="" title="Terminal default" aria-label="Terminal default"></button>` : ''}
      ${swatches}
      <label class="sw custom${isHex(value) ? ' on' : ''}" title="Custom color"${isHex(value) ? ` style="background:${value}"` : ''}>
        <input type="color" data-color-key="${esc(key)}" value="${hex}" aria-label="Custom color">${icon('plus')}
      </label>
    </div>`;
  }

  /** `seg:<id>` | `sep` | `warn` | `danger` | `ok` | `acct:<key>` */
  function setColor(key: string, color: string): void {
    const [kind = '', id = ''] = key.split(/:(.*)/s);
    if (kind === 'seg') {
      const s = isSegmentId(id) ? segById(id) : undefined;
      if (s) s.color = color;
    } else if (kind === 'sep') config.separatorColor = color;
    else if (kind === 'warn') config.thresholds.warnColor = color;
    else if (kind === 'danger') config.thresholds.dangerColor = color;
    else if (kind === 'ok') config.thresholds.okColor = color;
    else if (kind === 'acct') {
      config.accounts[id] = { ...(config.accounts[id] ?? {}), color };
      cleanAccount(id);
    }
  }

  function cleanAccount(key: string): void {
    const a = config.accounts[key];
    if (a && !a.label && !a.color) delete config.accounts[key];
  }

  const sectionFor = (colorKey: string): (keyof typeof RENDER)[] => (colorKey.startsWith('seg:') ? ['lines', 'segment'] : colorKey.startsWith('acct:') ? ['accounts'] : ['style']);

  // ---------- rendering ----------

  function renderShell(): void {
    el('app').innerHTML = `
      <header class="top">
        <div class="brand">
          <div class="logo" aria-hidden="true">${icon('terminal')}</div>
          <div>
            <h1>Status line</h1>
            <p>Design the footer Claude Code shows under your prompt.</p>
          </div>
        </div>
        <div class="top-actions">
          <span id="save-state" class="save">${icon('check')}Saved</span>
          <span id="install-state"></span>
          <button class="btn ghost" data-action="open-json" title="${esc(configFile)}">${icon('file')}Open JSON</button>
          <button class="btn primary" id="apply-top" data-action="apply"></button>
        </div>
      </header>

      <section class="stage" aria-label="Preview">
        <div class="term">
          <div class="term-bar">
            <span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="term-title">claude</span>
            <label class="term-source">Data from
              <select id="preview-account"><option value="">latest session</option>${accounts.map((a) => `<option value="${esc(a.dir)}">${esc(a.label)}${a.email ? ` · ${esc(a.email)}` : ''}</option>`).join('')}</select>
            </label>
          </div>
          <div class="term-body">
            <pre id="preview" class="term-line"></pre>
            <pre class="term-line term-claude">▸▸ auto mode on <span class="dim">(shift+tab to cycle)</span></pre>
          </div>
        </div>
        <p class="stage-note"><span id="preview-source"></span> The last line is drawn by Claude Code itself.</p>
      </section>

      <nav class="tabs" role="tablist" aria-label="Sections">
        ${TABS.map((t) => `<button class="tab" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-controls="panel-${t.id}">${icon(t.icon)}${t.label}</button>`).join('')}
      </nav>

      <main>
        <section class="panel" role="tabpanel" id="panel-layout" aria-labelledby="tab-layout">
          <div id="presets"></div>
          <div class="cols">
            <div class="card">
              <div class="card-head"><h2>Layout</h2><p>Drag segments between lines, or click one to edit it.</p></div>
              <div id="lines"></div>
              <h3 class="tray-title">Not shown</h3>
              <div class="tray" data-line="0" id="tray"></div>
            </div>
            <div class="card" id="segment-card"></div>
          </div>
        </section>
        <section class="panel" role="tabpanel" id="panel-style" aria-labelledby="tab-style"><div class="card" id="style-card"></div></section>
        <section class="panel" role="tabpanel" id="panel-accounts" aria-labelledby="tab-accounts"><div class="card" id="accounts-card"></div></section>
        <section class="panel" role="tabpanel" id="panel-install" aria-labelledby="tab-install"><div class="card" id="install-card"></div></section>
      </main>`;
  }

  const chip = (s: SegmentConfig): string => {
    const dot = cssColor(s.color);
    return `<div class="chip${selected === s.id ? ' selected' : ''}${s.join ? ' joined' : ''}${s.enabled ? '' : ' off'}" draggable="true" tabindex="0" role="button" aria-pressed="${selected === s.id}" data-id="${s.id}" title="${esc(SEGMENTS[s.id].desc)}">
      <span class="chip-grip" aria-hidden="true">${icon('grip')}</span>
      ${s.icon ? `<span class="chip-icon">${esc(s.icon)}</span>` : ''}
      <span class="chip-dot${dot ? '' : ' empty'}"${dot ? ` style="background:${dot}"` : ''}></span>
      <span class="chip-name">${esc(SEGMENTS[s.id].name)}</span>
      ${s.enabled ? `<button class="chip-btn" data-remove="${s.id}" title="Hide this segment" aria-label="Hide ${esc(SEGMENTS[s.id].name)}">${icon('close')}</button>` : `<button class="chip-btn add" data-add="${s.id}" title="Show on line 1" aria-label="Show ${esc(SEGMENTS[s.id].name)}">${icon('plus')}</button>`}
    </div>`;
  };

  const switchControl = (attr: string, checked: boolean, label: string, hint = ''): string =>
    `<label class="switch"><input type="checkbox" ${attr} ${checked ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span class="switch-text"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</span></label>`;

  const fieldHtml = (label: string, control: string, hint = ''): string => `<div class="field"><label>${label}${hint ? `<i>${hint}</i>` : ''}</label>${control}</div>`;

  const RENDER = {
    header(): void {
      const usable = accounts.filter((a) => !a.hidden);
      const installed = usable.filter((a) => a.status.kind === 'ctxman').length;
      el('install-state').innerHTML = !usable.length
        ? ''
        : installed
          ? `<span class="pill ok">${icon('check')}Installed on ${installed} of ${usable.length}</span>`
          : '<button class="pill warn" data-tab="install" title="Open Install">Not installed yet</button>';
      const n = targets.size;
      const apply = el<HTMLButtonElement>('apply-top');
      apply.textContent = n ? `Apply to ${n} account${n === 1 ? '' : 's'}` : 'Apply';
      apply.disabled = !n;
    },
    tabs(): void {
      for (const t of TABS) {
        const on = t.id === tab;
        const button = el(`tab-${t.id}`);
        button.classList.toggle('on', on);
        button.setAttribute('aria-selected', String(on));
        el(`panel-${t.id}`).hidden = !on;
      }
    },
    presets(): void {
      el('presets').innerHTML = `<div class="presets">
        <div class="presets-head"><h2>Start from a preset</h2><p>Replaces the layout; your account names stay.</p></div>
        <div class="preset-grid">${presets
          .map((p) => `<button class="preset" data-preset="${esc(p.id)}"><strong>${esc(p.label)}</strong><span>${esc(p.hint)}</span></button>`)
          .join('')}</div>
      </div>`;
    },
    lines(): void {
      el('lines').innerHTML = [1, 2, 3]
        .map((n) => {
          const segs = config.segments.filter((s) => s.enabled && Number(s.line) === n);
          return `<div class="line" data-line="${n}"><span class="line-no">${n}</span><div class="line-chips">${segs.map(chip).join('') || '<span class="drop-hint">Drop segments here</span>'}</div></div>`;
        })
        .join('');
      const off = config.segments.filter((s) => !s.enabled);
      el('tray').innerHTML = off.map(chip).join('') || '<span class="drop-hint">Every segment is in use.</span>';
    },
    segment(): void {
      const s = current();
      const meta = SEGMENTS[s.id];
      const options = meta.opts
        .map((key) => {
          const def = OPTIONS[key];
          if (def.type === 'check') return switchControl(`data-opt="${key}"`, s[key as CheckOption] === true, esc(def.label));
          if (def.type === 'select') return fieldHtml(esc(def.label), `<div class="select"><select data-opt="${key}">${def.options.map(([v, l]) => `<option value="${v}"${s.format === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${icon('chevron')}</div>`);
          return fieldHtml(esc(def.label), `<input type="text" data-opt="${key}" value="${esc(s.text ?? '')}" placeholder="Any text">`);
        })
        .join('');
      el('segment-card').innerHTML = `
        <div class="seg-head">
          <div><h2>${esc(meta.name)}</h2><p>${esc(meta.desc)}</p></div>
          ${switchControl('data-seg="enabled"', s.enabled, 'Shown')}
        </div>
        ${s.enabled ? '' : '<div class="notice">This segment is hidden. Turn it on to show it in the footer.</div>'}
        <div class="group-title">Appearance</div>
        <div class="grid2">
          ${fieldHtml('Icon', `<input type="text" data-seg="icon" value="${esc(s.icon)}" placeholder="none" maxlength="4">`)}
          ${fieldHtml('Label', `<input type="text" data-seg="label" value="${esc(s.label)}" placeholder="none">`, 'before the value')}
        </div>
        <div class="emoji">${EMOJI.map((i) => `<button class="emoji-pick" data-icon="${i}" aria-label="Icon ${i}">${i}</button>`).join('')}<button class="emoji-pick" data-icon="" title="No icon" aria-label="No icon">∅</button></div>
        ${fieldHtml('Color', colorPicker(`seg:${s.id}`, s.color))}
        ${switchControl('data-seg="bold"', s.bold, 'Bold')}
        ${options ? `<div class="group-title">Options</div>${options}` : ''}
        <div class="group-title">Placement</div>
        <div class="grid2">
          ${fieldHtml('Line', `<div class="select"><select data-seg="line">${[1, 2, 3].map((n) => `<option value="${n}"${Number(s.line) === n ? ' selected' : ''}>Line ${n}</option>`).join('')}</select>${icon('chevron')}</div>`)}
        </div>
        ${switchControl('data-seg="join"', s.join, 'Attach to the previous segment', 'No separator between them')}`;
    },
    style(): void {
      const t = config.thresholds;
      const sample = (color: string, pct: number): string => `<span style="color:${cssColor(color) || 'inherit'}">${'▰'.repeat(Math.round(pct / 12.5))}${'▱'.repeat(8 - Math.round(pct / 12.5))} ${pct}%</span>`;
      el('style-card').innerHTML = `
        <div class="card-head"><h2>Style</h2><p>How segments are joined, and how usage is colored.</p></div>
        <div class="group-title">Separator</div>
        <div class="grid2">
          ${fieldHtml('Text between segments', `<input type="text" class="mono" data-cfg="separator" value="${esc(config.separator)}">`)}
          ${fieldHtml('Bar width', `<input type="number" data-cfg="barWidth" min="3" max="30" value="${config.barWidth}">`, 'cells')}
        </div>
        ${fieldHtml('Separator color', colorPicker('sep', config.separatorColor))}
        <div class="group-title">Usage colors</div>
        <p class="muted">Used by segments with <b>Color by usage</b> turned on, such as the context window and the limits.</p>
        <div class="usage-sample mono" aria-hidden="true">${sample(t.okColor || 'green', 40)} ${sample(t.warnColor, 70)} ${sample(t.dangerColor, 95)}</div>
        <div class="grid2">
          ${fieldHtml('Warn from', `<input type="number" data-thr="warn" min="1" max="100" value="${t.warn}">`, '%')}
          ${fieldHtml('Danger from', `<input type="number" data-thr="danger" min="1" max="100" value="${t.danger}">`, '%')}
        </div>
        ${fieldHtml('Below warn', colorPicker('ok', t.okColor), "default: the segment's own color")}
        ${fieldHtml('Warn', colorPicker('warn', t.warnColor, false))}
        ${fieldHtml('Danger', colorPicker('danger', t.dangerColor, false))}`;
    },
    accounts(): void {
      // One row per real account: folders logged into the same email share a name.
      const rows = new Map<string, { key: string; email: string; folders: string[] }>();
      for (const a of accounts) {
        const key = a.email || a.dir;
        const row = rows.get(key) ?? { key, email: a.email, folders: [] };
        row.folders.push(a.label);
        rows.set(key, row);
      }
      el('accounts-card').innerHTML = `
        <div class="card-head"><h2>Names and colors</h2><p>Shown by the Account segment. Matched by email, so every folder logged into the same account has the same name.</p></div>
        ${
          rows.size
            ? [...rows.values()]
                .map((r) => {
                  const a = config.accounts[r.key] ?? {};
                  const placeholder = r.email ? r.email.split('@')[0] ?? r.email : (r.folders[0] ?? '');
                  const shown = a.label || placeholder;
                  const tint = cssColor(a.color ?? '');
                  return `<div class="acct-row">
                    <div class="avatar"${tint ? ` style="background:${tint}"` : ''} aria-hidden="true">${esc((shown[0] ?? '?').toUpperCase())}</div>
                    <div class="acct-who"><b>${esc(r.email || r.key)}</b><span>folders: ${esc(r.folders.join(', '))}</span></div>
                    <input type="text" data-acct="${esc(r.key)}" value="${esc(a.label ?? '')}" placeholder="${esc(placeholder)}" aria-label="Name for ${esc(r.email || r.key)}">
                    <div class="acct-colors">${colorPicker(`acct:${r.key}`, a.color ?? '')}</div>
                  </div>`;
                })
                .join('')
            : '<div class="notice">No accounts found yet.</div>'
        }`;
    },
    install(): void {
      const c = config.compat;
      const badge = (st: InstallStatus): string =>
        st.kind === 'ctxman' ? `<span class="pill ok">${icon('check')}Installed</span>` : st.kind === 'custom' ? '<span class="pill">Another status line</span>' : '<span class="pill">Not installed</span>';
      const custom = (st: InstallStatus): string => (st.kind === 'custom' ? `<code class="cmd">${esc(st.command)}</code>` : '');
      el('install-card').innerHTML = `
        <div class="card-head"><h2>Install</h2><p>Turns the status line on for the accounts you tick. Your design is saved as you edit, so you install only once.</p></div>
        <div class="acct-list">${
          accounts.length
            ? accounts
                .map(
                  (a) => `<label class="acct-item">
                    <input type="checkbox" data-target="${esc(a.dir)}" ${targets.has(a.dir) ? 'checked' : ''}>
                    <span class="acct-main"><span class="acct-name"><b>${esc(a.label)}</b>${a.hidden ? '<small>hidden</small>' : ''}</span>${a.email ? `<small>${esc(a.email)}</small>` : ''}${custom(a.status)}</span>
                    ${badge(a.status)}
                  </label>`
                )
                .join('')
            : '<div class="notice">No accounts found yet.</div>'
        }</div>
        <p class="muted small">It sets <code>statusLine</code> in each account's <code>settings.json</code>. What was there is remembered, so Restore puts it back, and a copy <code>settings.json.ctx-man-backup</code> is kept too.</p>
        <div class="actions">
          <button class="btn primary" data-action="apply" ${targets.size ? '' : 'disabled'}>${targets.size ? `Apply to ${targets.size} account${targets.size === 1 ? '' : 's'}` : 'Apply'}</button>
          <button class="btn ghost" data-action="restore" ${accounts.some((a) => a.canRestore) ? '' : 'disabled'}>${icon('undo')}Restore previous</button>
        </div>
        <div class="group-title">Keep working with your other tools</div>
        ${switchControl('data-compat="tmuxStateFile"', c.tmuxStateFile, 'Write <code>/tmp/claude_state</code>', 'For the tmux status bar')}
        ${switchControl('data-compat="sessionSnapshots"', c.sessionSnapshots, 'Write session snapshots', 'To <code>&lt;account&gt;/statusline/</code>; the preview and Ctx Man read them')}
        ${switchControl('data-compat="disableFile"', c.disableFile, 'Hide when <code>~/.claude/statusline_disabled</code> exists', 'Your <code>claude-statusline</code> toggle')}`;
    },
  };

  const renderAll = (): void => {
    for (const render of Object.values(RENDER)) render();
  };

  // ---------- actions ----------

  function moveSegment(id: SegmentId, line: number, beforeId: SegmentId | null): void {
    const list = config.segments;
    const at = list.findIndex((s) => s.id === id);
    const seg = list.splice(at, 1)[0];
    if (!seg) return;
    seg.enabled = line > 0;
    if (line > 0) seg.line = line;
    let index = beforeId ? list.findIndex((s) => s.id === beforeId) : -1;
    if (index < 0) {
      // After the last segment of that line, or at the end.
      const last = list.map((s, i) => (s.enabled && Number(s.line) === line ? i : -1)).filter((i) => i >= 0).pop();
      index = last === undefined ? list.length : last + 1;
    }
    list.splice(index, 0, seg);
    selected = id;
    changed('lines', 'segment');
  }

  function setTab(next: Tab): void {
    tab = next;
    RENDER.tabs();
  }

  function loadPreset(id: string): void {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const keep = config.accounts;
    config = clone(preset.config);
    config.accounts = keep;
    changed('lines', 'segment', 'style', 'install');
    toast(`${preset.label} loaded. It is saved; install it once if you have not yet.`, 'success');
  }

  const targetDirs = (): string[] => [...targets];

  function apply(): void {
    if (!targets.size) return toast('Tick at least one account in Install.', 'error');
    api.postMessage({ type: 'apply', dirs: targetDirs() });
  }

  function restore(): void {
    const dirs = targetDirs().filter((d) => accounts.find((a) => a.dir === d)?.canRestore);
    if (!dirs.length) return toast('Nothing to restore for the ticked accounts.', 'error');
    api.postMessage({ type: 'restore', dirs });
  }

  // ---------- events ----------

  const closest = <T extends HTMLElement>(e: Event, selector: string): T | null => (e.target instanceof Element ? e.target.closest<T>(selector) : null);

  function onClick(e: MouseEvent): void {
    const swatch = closest<HTMLButtonElement>(e, 'button.sw');
    if (swatch?.dataset['colorKey'] !== undefined) {
      const key = swatch.dataset['colorKey'];
      setColor(key, swatch.dataset['color'] ?? '');
      return changed(...sectionFor(key));
    }
    const emoji = closest(e, '[data-icon]');
    if (emoji) {
      current().icon = emoji.dataset['icon'] ?? '';
      return changed('lines', 'segment');
    }
    const remove = closest(e, '[data-remove]')?.dataset['remove'];
    if (isSegmentId(remove)) return moveSegment(remove, 0, null);
    const add = closest(e, '[data-add]')?.dataset['add'];
    if (isSegmentId(add)) return moveSegment(add, 1, null);
    const preset = closest(e, '[data-preset]')?.dataset['preset'];
    if (preset) return loadPreset(preset);
    const tabId = closest(e, '[data-tab]')?.dataset['tab'];
    const known = TABS.find((t) => t.id === tabId);
    if (known) return setTab(known.id);
    const chipId = closest(e, '.chip')?.dataset['id'];
    if (isSegmentId(chipId)) {
      selected = chipId;
      RENDER.lines();
      return RENDER.segment();
    }
    switch (closest(e, '[data-action]')?.dataset['action']) {
      case 'apply':
        return apply();
      case 'restore':
        return restore();
      case 'open-json':
        return api.postMessage({ type: 'openConfig' });
    }
  }

  function onInput(e: Event): void {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
    const committed = e.type === 'change';
    const checkbox = t instanceof HTMLInputElement && t.type === 'checkbox';
    const checked = t instanceof HTMLInputElement && t.checked;

    if (t instanceof HTMLInputElement && t.type === 'color' && t.dataset['colorKey'] !== undefined) {
      setColor(t.dataset['colorKey'], t.value);
      return changed(...(committed ? sectionFor(t.dataset['colorKey']) : []));
    }
    const seg = t.dataset['seg'];
    if (seg) {
      const s = current();
      switch (seg) {
        case 'enabled':
          s.enabled = checked;
          return changed('lines', 'segment');
        case 'bold':
          s.bold = checked;
          return changed();
        case 'join':
          s.join = checked;
          return changed('lines');
        case 'line':
          s.line = Number(t.value);
          return changed('lines');
        case 'icon':
          s.icon = t.value;
          return changed(...(committed ? (['lines'] as const) : []));
        case 'label':
          s.label = t.value;
          return changed();
      }
      return;
    }
    const opt = t.dataset['opt'] as OptionKey | undefined;
    if (opt && opt in OPTIONS) {
      const s = current();
      if (opt === 'format') s.format = OPTIONS.format.type === 'select' ? (OPTIONS.format.options.find(([v]) => v === t.value)?.[0] ?? 'pct') : 'pct';
      else if (opt === 'text') s.text = t.value;
      else s[opt] = checked;
      return changed();
    }
    if (t.dataset['cfg'] === 'separator') {
      config.separator = t.value;
      return changed();
    }
    if (t.dataset['cfg'] === 'barWidth') {
      config.barWidth = Math.min(30, Math.max(3, Math.round(Number(t.value)) || 8));
      return changed();
    }
    const thr = t.dataset['thr'];
    if (thr === 'warn' || thr === 'danger') {
      config.thresholds[thr] = Number(t.value) || 0;
      return changed(...(committed ? (['style'] as const) : []));
    }
    const acct = t.dataset['acct'];
    if (acct !== undefined) {
      config.accounts[acct] = { ...(config.accounts[acct] ?? {}), label: t.value.trim() };
      cleanAccount(acct);
      return changed();
    }
    const compat = t.dataset['compat'];
    if (compat === 'tmuxStateFile' || compat === 'sessionSnapshots' || compat === 'disableFile') {
      config.compat[compat] = checked;
      return changed();
    }
    const target = t.dataset['target'];
    if (target !== undefined && checkbox) {
      if (checked) targets.add(target);
      else targets.delete(target);
      RENDER.header();
      return RENDER.install();
    }
    if (t.id === 'preview-account' && committed) api.postMessage({ type: 'previewAccount', dir: t.value });
  }

  function wireDragAndDrop(app: HTMLElement): void {
    app.addEventListener('dragstart', (e) => {
      const chipEl = closest(e, '.chip');
      const id = chipEl?.dataset['id'];
      if (!chipEl || !isSegmentId(id) || !e.dataTransfer) return;
      dragId = id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      chipEl.classList.add('dragging');
    });
    app.addEventListener('dragend', () => {
      dragId = null;
      $$('.drop-over').forEach((n) => n.classList.remove('drop-over'));
      $$('.dragging').forEach((n) => n.classList.remove('dragging'));
    });
    app.addEventListener('dragover', (e) => {
      const zone = closest(e, '[data-line]');
      if (!zone || !dragId) return;
      e.preventDefault();
      $$('.drop-over').forEach((n) => n.classList.remove('drop-over'));
      (closest(e, '.chip') ?? zone).classList.add('drop-over');
    });
    app.addEventListener('drop', (e) => {
      const zone = closest(e, '[data-line]');
      if (!zone || !dragId) return;
      e.preventDefault();
      const over = closest(e, '.chip')?.dataset['id'];
      moveSegment(dragId, Number(zone.dataset['line']), isSegmentId(over) && over !== dragId ? over : null);
    });
  }

  document.addEventListener('keydown', (e) => {
    const chipEl = closest(e, '.chip');
    const id = chipEl?.dataset['id'];
    if ((e.key === 'Enter' || e.key === ' ') && e.target === chipEl && isSegmentId(id)) {
      e.preventDefault();
      selected = id;
      RENDER.lines();
      RENDER.segment();
    }
  });

  window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        config = m.config;
        accounts = m.accounts;
        presets = m.presets;
        configFile = m.configFile;
        targets.clear();
        for (const a of accounts) if (!a.hidden) targets.add(a.dir);
        renderShell();
        renderAll();
        wireDragAndDrop(el('app'));
        return;
      case 'preview':
        el('preview').innerHTML = ansiToHtml(m.ansi) || '<span class="muted">Nothing to show yet. Add a segment.</span>';
        el('preview-source').textContent = `Showing ${m.source}.`;
        return;
      case 'accounts':
        accounts = m.accounts;
        RENDER.header();
        RENDER.install();
        return;
      case 'toast':
        return toast(m.text, m.kind);
      default: {
        const unreachable: never = m;
        return unreachable;
      }
    }
  });

  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  api.postMessage({ type: 'ready' });
})();
