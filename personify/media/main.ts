// Personify webview. Structure is rendered once per view; incoming state only syncs values in place
// so typing and color dragging never lose focus.
(() => {
  // ---------- dom helpers ----------

  /** An element the page itself rendered, so it is there. */
  function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`Personify: ${sel} is missing`);
    return el;
  }
  const $opt = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);
  const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] => Array.from(root.querySelectorAll<T>(sel));
  const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s: string | number): string => String(s).replace(/[&<>"']/g, (c) => ESC[c] ?? c);
  /** The element an event happened on, when it is one. */
  const targetOf = (e: Event): Element | null => (e.target instanceof Element ? e.target : null);

  const vscode = acquireVsCodeApi();
  const app = $('#app');
  const send = (msg: ClientMessage): void => vscode.postMessage(msg);

  const SEMANTIC_KEY = 'editor.semanticHighlighting.enabled';
  const TABS: readonly { id: Tab; label: string; icon: string }[] = [
    { id: 'hotkeys', label: 'Hotkeys', icon: '⌨' },
    { id: 'appearance', label: 'Appearance', icon: '◐' },
    { id: 'syntax', label: 'Syntax colors', icon: '{ }' },
    { id: 'profiles', label: 'Profiles & backup', icon: '⇅' },
  ];
  const FONTS = ['Menlo', 'Monaco', 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro', 'Hack', 'IBM Plex Mono', 'Roboto Mono', 'Ubuntu Mono', 'Iosevka', 'Victor Mono', 'Consolas', 'Courier New', 'monospace'];
  const WHEN = ['editorTextFocus', 'editorFocus', '!editorReadonly', 'editorHasSelection', 'terminalFocus', 'explorerViewletFocus', 'filesExplorerFocus', 'sideBarFocus', 'panelFocus', 'inputFocus', 'textInputFocus', 'inQuickOpen', 'suggestWidgetVisible', 'findWidgetVisible', "editorLangId == 'typescript'", "editorLangId == 'javascript'", "editorLangId == 'go'"];

  type KbFilter = 'all' | 'changed' | 'conflicts' | 'removed' | 'unbound';
  const KB_FILTERS: readonly (readonly [KbFilter, string])[] = [
    ['all', 'All'],
    ['changed', 'Changed by me'],
    ['conflicts', 'Conflicts'],
    ['removed', 'Removed'],
    ['unbound', 'Without shortcut'],
  ];
  type FilterTab = 'appearance' | 'syntax';

  const toTab = (v: string | undefined): Tab => TABS.find((t) => t.id === v)?.id ?? 'appearance';

  interface State {
    tab: Tab;
    area: string;
    /** A language id, or `custom`. */
    lang: string;
    catalog: { areas: readonly Area[]; languages: readonly Language[] };
    platform: string;
    prefs: PrefsView | null;
    appearance: AppearanceState | null;
    syntax: SyntaxState | null;
    custom: CustomRule[];
    kb: KeybindingsState | null;
    kbFilter: KbFilter;
    kbQuery: string;
    kbLimit: number;
    kbRecordSearch: boolean;
    filters: Record<FilterTab, string>;
    /** Debounce keys whose write is still queued. */
    pending: Set<string>;
  }

  const saved = vscode.getState() ?? {};
  const S: State = {
    tab: toTab(saved.tab),
    area: saved.area ?? 'sidebar',
    lang: saved.lang ?? 'jsts',
    catalog: { areas: [], languages: [] },
    platform: 'darwin',
    prefs: null,
    appearance: null,
    syntax: null,
    custom: [],
    kb: null,
    kbFilter: 'all',
    kbQuery: '',
    kbLimit: 200,
    kbRecordSearch: false,
    filters: { appearance: '', syntax: '' },
    pending: new Set(),
  };
  const persist = (): void => vscode.setState({ tab: S.tab, area: S.area, lang: S.lang });
  const isMac = (): boolean => S.platform === 'darwin';

  // ---------- small helpers ----------

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  function debounce(key: string, fn: () => void, ms = 180): void {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn();
      }, ms)
    );
  }
  // Like debounce, but the key stays "pending" so stale state echoes don't overwrite local edits.
  function queueSend(key: string, fn: () => void, ms?: number): void {
    S.pending.add(key);
    debounce(
      key,
      () => {
        S.pending.delete(key);
        fn();
      },
      ms
    );
  }

  function toast(text: string, kind: ToastKind = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('hide'), kind === 'error' ? 6000 : 3000);
    setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
  }

  // ---------- color control ----------

  const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  function splitHex(h: string): { rgb: string; alpha: string } {
    let x = h.slice(1);
    if (x.length <= 4)
      x = x
        .split('')
        .map((c) => c + c)
        .join('');
    return { rgb: `#${x.slice(0, 6).toLowerCase()}`, alpha: x.slice(6) };
  }
  function normalizeHex(raw: string): string | null {
    let v = raw.trim();
    if (/^[0-9a-f]{3,8}$/i.test(v)) v = `#${v}`;
    return HEX_RE.test(v) ? v.toLowerCase() : null;
  }

  const colorControl = (attrs = ''): string => `
    <div class="color-ctl empty" ${attrs}>
      <label class="swatch" title="Pick a color"><input type="color" class="color-picker" tabindex="-1"><span class="swatch-fill"></span></label>
      <input type="text" class="hex" placeholder="theme" spellcheck="false" maxlength="9" aria-label="Hex color">
    </div>`;

  function setColorCtl(ctl: HTMLElement | null, value: string | null): void {
    if (!ctl) return;
    ctl.dataset.value = value || '';
    const hex = $<HTMLInputElement>('.hex', ctl);
    if (document.activeElement !== hex) {
      hex.value = value || '';
      hex.classList.remove('invalid');
    }
    ctl.classList.toggle('empty', !value);
    $('.swatch-fill', ctl).style.background = value || '';
    if (value && HEX_RE.test(value)) $<HTMLInputElement>('.color-picker', ctl).value = splitHex(value).rgb;
  }

  // Shared input handling for every .color-ctl; calls onColor(ctl, value|null).
  function handleColorEvent(e: Event, onColor: (ctl: HTMLElement, value: string | null) => void): boolean {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return false;
    const ctl = t.closest<HTMLElement>('.color-ctl');
    if (!ctl) return false;
    if (t.classList.contains('color-picker') && e.type === 'input') {
      const old = ctl.dataset.value;
      const alpha = old && HEX_RE.test(old) ? splitHex(old).alpha : '';
      const value = t.value + alpha;
      $<HTMLInputElement>('.hex', ctl).value = value;
      setColorCtl(ctl, value);
      onColor(ctl, value);
      return true;
    }
    if (t.classList.contains('hex')) {
      const raw = t.value.trim();
      if (!raw) {
        t.classList.remove('invalid');
        setColorCtl(ctl, null);
        onColor(ctl, null);
        return true;
      }
      const value = normalizeHex(raw);
      if (value) {
        t.classList.remove('invalid');
        ctl.dataset.value = value;
        ctl.classList.remove('empty');
        $('.swatch-fill', ctl).style.background = value;
        $<HTMLInputElement>('.color-picker', ctl).value = splitHex(value).rgb;
        onColor(ctl, value);
      } else if (e.type === 'change') {
        t.classList.add('invalid');
      }
      return true;
    }
    return false;
  }

  // ---------- key helpers ----------

  const CODE_MAP: Record<string, string> = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', NumpadEnter: 'enter',
    Escape: 'escape', Backspace: 'backspace', Tab: 'tab', Space: 'space', Delete: 'delete', Insert: 'insert',
    Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backquote: '`', IntlBackslash: 'oem_102', NumpadAdd: 'numpad_add', NumpadSubtract: 'numpad_subtract',
    NumpadMultiply: 'numpad_multiply', NumpadDivide: 'numpad_divide', NumpadDecimal: 'numpad_decimal',
    Pause: 'pausebreak', ContextMenu: 'contextmenu',
  };
  const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/;

  function keyFromEvent(e: KeyboardEvent): string | null {
    if (MODIFIER_CODES.test(e.code) || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
    let k = CODE_MAP[e.code];
    if (!k) {
      if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
      else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
      else if (/^F\d{1,2}$/.test(e.code)) k = e.code.toLowerCase();
      else if (/^Numpad\d$/.test(e.code)) k = `numpad${e.code.slice(6)}`;
      else k = (e.key || '').toLowerCase();
    }
    if (!k) return null;
    const mods: string[] = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.shiftKey) mods.push('shift');
    if (e.altKey) mods.push('alt');
    if (e.metaKey) mods.push(isMac() ? 'cmd' : S.platform === 'win32' ? 'win' : 'meta');
    return [...mods, k].join('+');
  }

  function normKey(key: string): string {
    return key
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .map((chord) => {
        const parts = chord.split('+');
        const last = parts.pop() ?? '';
        return [...parts.sort(), last].join('+');
      })
      .join(' ');
  }

  const MAC_SYMBOLS: Record<string, string> = { cmd: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
  const KEY_NAMES: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→', enter: '↵', escape: 'Esc', backspace: '⌫', delete: 'Del', space: 'Space', tab: 'Tab', pageup: 'PgUp', pagedown: 'PgDn', meta: 'Meta', win: 'Win' };
  function prettyPart(p: string): string {
    const symbol = isMac() ? MAC_SYMBOLS[p] : undefined;
    if (symbol) return symbol;
    const name = KEY_NAMES[p];
    if (name) return name;
    return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
  }
  function keyHtml(key: string): string {
    if (!key) return '<span class="muted">—</span>';
    return key
      .trim()
      .split(/\s+/)
      .map((chord) => `<span class="chord">${chord.split('+').map((p) => `<kbd>${esc(prettyPart(p))}</kbd>`).join('')}</span>`)
      .join('<span class="chord-sep">then</span>');
  }

  // ---------- shell ----------

  function renderShell(): void {
    app.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="logo">P</div>
          <div><div class="brand-name">Personify</div><div class="brand-sub">Make VS Code yours</div></div>
        </div>
        <nav class="tabs" role="tablist">
          ${TABS.map((t) => `<button class="tab" role="tab" data-tab="${t.id}"><span class="tab-icon">${esc(t.icon)}</span>${esc(t.label)}</button>`).join('')}
        </nav>
        <div class="scope-bar">
          <label class="scope-field" title="Where settings are written">
            <span>Save to</span>
            <select id="scope">
              <option value="user">User · all projects</option>
              <option value="workspace">This workspace only</option>
            </select>
          </label>
          <label class="scope-field" title="Colors can apply to every theme or only to the active one">
            <span>Apply to</span>
            <select id="themeMode">
              <option value="all">All themes</option>
              <option value="current">Current theme</option>
            </select>
          </label>
          <span class="scope-note">Hotkeys are always saved to your user keybindings.json</span>
        </div>
      </header>
      <main>
        ${TABS.map((t) => `<section class="tab-panel" id="tab-${t.id}" role="tabpanel"></section>`).join('')}
      </main>
      <datalist id="font-list">${FONTS.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
      <datalist id="when-list">${WHEN.map((w) => `<option value="${esc(w)}">`).join('')}</datalist>
      <datalist id="cmd-list"></datalist>`;

    $$('.tab', app).forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('#scope').addEventListener('change', sendPrefs);
    $('#themeMode').addEventListener('change', sendPrefs);
    wireAppearance();
    wireSyntax();
    wireHotkeys();
    wireProfiles();
    showTab(S.tab);
  }

  function showTab(tab: string | undefined): void {
    S.tab = toTab(tab);
    persist();
    $$('.tab', app).forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
    $$('.tab-panel', app).forEach((p) => p.classList.toggle('active', p.id === `tab-${S.tab}`));
    app.classList.toggle('hotkeys-mode', S.tab === 'hotkeys');
  }

  function sendPrefs(): void {
    S.custom = [];
    send({
      type: 'prefs',
      scope: $<HTMLSelectElement>('#scope').value === 'workspace' ? 'workspace' : 'user',
      themeMode: $<HTMLSelectElement>('#themeMode').value === 'current' ? 'current' : 'all',
    });
  }

  function syncPrefs(): void {
    const p = S.prefs;
    if (!p) return;
    const scope = $<HTMLSelectElement>('#scope');
    scope.value = p.scope;
    const workspace = $<HTMLOptionElement>('option[value="workspace"]', scope);
    workspace.disabled = !p.hasWorkspace;
    workspace.textContent = p.hasWorkspace ? 'This workspace only' : 'This workspace (open a folder first)';
    const tm = $<HTMLSelectElement>('#themeMode');
    tm.value = p.themeMode;
    $('option[value="current"]', tm).textContent = `Only "${p.theme}"`;
    $$('.target-chip', app).forEach((el) => (el.innerHTML = targetChip()));
  }

  const targetChip = (): string =>
    S.prefs
      ? `Saving to <b>${S.prefs.scope === 'workspace' ? 'workspace' : 'user'}</b> settings · <b>${S.prefs.themeMode === 'current' ? esc(S.prefs.theme) : 'all themes'}</b>`
      : '';

  // ---------- appearance ----------

  function settingControl(item: SettingItem): string {
    switch (item.type) {
      case 'number':
        return `<div class="num-ctl">
          <input type="range" class="range" min="${item.min}" max="${item.max}" step="${item.step}">
          <input type="number" class="num" min="${item.min}" max="${item.max}" step="${item.step}">
          ${item.unit ? `<span class="unit">${esc(item.unit)}</span>` : ''}
        </div>`;
      case 'font':
        return `<div class="font-ctl">
          <input type="text" class="text font-input" list="font-list" spellcheck="false">
          <div class="font-sample">Aa Bb 0O il1 {} =&gt; !=</div>
        </div>`;
      case 'enum':
        return `<select class="select"><option value="">Default</option>${item.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
      case 'boolean':
        return `<div class="seg"><button data-val="">Default</button><button data-val="true">On</button><button data-val="false">Off</button></div>`;
      default: {
        const unknownItem: never = item;
        return unknownItem;
      }
    }
  }

  function appearanceRow(item: AreaItem): string {
    if (item.kind === 'note') return `<div class="note">ⓘ ${esc(item.text)}</div>`;
    const hint = item.kind === 'color' ? item.desc : item.hint;
    const search = `${item.label} ${item.key} ${hint}`.toLowerCase();
    return `<div class="row" data-kind="${item.kind}" data-key="${esc(item.key)}" data-search="${esc(search)}">
      <div class="row-label">
        <div class="label">${esc(item.label)}<span class="dot" title="Customized"></span></div>
        <div class="desc">${hint ? `${esc(hint)} · ` : ''}<code>${esc(item.key)}</code></div>
      </div>
      <div class="row-control">${item.kind === 'color' ? colorControl() : settingControl(item)}</div>
      <button class="icon-btn reset" data-action="reset-item" title="Reset to default">↺</button>
    </div>`;
  }

  function renderAppearance(): void {
    const areas = S.catalog.areas;
    const area = areas.find((a) => a.id === S.area) ?? areas[0];
    if (!area) return;
    S.area = area.id;
    $('#tab-appearance').innerHTML = `
      <div class="split">
        <aside class="subnav">
          ${areas.map((a) => `<button class="subnav-item" data-area="${a.id}"><span class="subnav-icon">${esc(a.icon)}</span><span class="subnav-text"><b>${esc(a.title)}</b><small data-count="${a.id}"></small></span></button>`).join('')}
          <div class="subnav-tip">Changes apply instantly. Not happy? <b>Profiles → Revert session</b> undoes everything.</div>
        </aside>
        <div class="content">
          <div class="content-head">
            <div><h2>${esc(area.title)}</h2><p>${esc(area.desc)}</p><div class="target-chip">${targetChip()}</div></div>
            <div class="actions">
              <button class="btn secondary" data-action="open-settings-json">Open settings.json</button>
              <button class="btn secondary" data-action="reset-area">Reset ${esc(area.title.toLowerCase())}</button>
            </div>
          </div>
          <input type="search" class="search" data-filter="appearance" placeholder="Filter ${esc(area.title.toLowerCase())} settings…" value="${esc(S.filters.appearance)}">
          ${area.groups.map((g) => `<section class="card"><h3>${esc(g.title)}</h3><div class="rows">${g.items.map(appearanceRow).join('')}</div></section>`).join('')}
          <div class="empty-state hidden">Nothing matches this filter.</div>
        </div>
      </div>`;
    $$('.subnav-item', $('#tab-appearance')).forEach((b) => b.classList.toggle('active', b.dataset.area === S.area));
    applyFilter('appearance');
    syncAppearance();
  }

  function syncAppearance(): void {
    if (!S.appearance || !$opt('#tab-appearance .split')) return;
    const { colors, settings } = S.appearance;
    for (const row of $$('#tab-appearance .row')) {
      const key = row.dataset.key ?? '';
      if (row.dataset.kind === 'color') {
        setColorCtl($opt('.color-ctl', row), colors[key] ?? null);
        row.classList.toggle('modified', Boolean(colors[key]));
        continue;
      }
      const st = settings[key] ?? { value: null, effective: null, def: null };
      const shown = st.effective ?? st.def;
      const own = st.value === null ? '' : String(st.value);
      row.classList.toggle('modified', st.value !== null);
      const range = $opt<HTMLInputElement>('.range', row);
      if (range) {
        const num = $<HTMLInputElement>('.num', row);
        if (document.activeElement !== range) range.value = String(st.value ?? shown ?? '');
        if (document.activeElement !== num) num.value = own;
        num.placeholder = shown === null ? '' : String(shown);
      }
      const font = $opt<HTMLInputElement>('.font-input', row);
      if (font) {
        if (document.activeElement !== font) font.value = own;
        font.placeholder = shown ? String(shown) : 'Same as editor';
        $('.font-sample', row).style.fontFamily = font.value || (shown ? String(shown) : '');
      }
      const select = $opt<HTMLSelectElement>('.select', row);
      if (select) {
        if (document.activeElement !== select) select.value = own;
        const first = select.options[0];
        if (first) first.textContent = `Default (${shown ?? ''})`;
      }
      const seg = $opt('.seg', row);
      if (seg) {
        $$('button', seg).forEach((b) => b.classList.toggle('active', b.dataset.val === own));
        $('[data-val=""]', seg).textContent = `Default (${shown ? 'on' : 'off'})`;
      }
    }
    for (const area of S.catalog.areas) {
      const n = area.groups
        .flatMap((g) => g.items)
        .filter((i) => (i.kind === 'color' ? Boolean(colors[i.key]) : i.kind === 'setting' && (settings[i.key]?.value ?? null) !== null)).length;
      const el = $opt(`#tab-appearance [data-count="${area.id}"]`);
      if (el) el.textContent = n ? `${n} customized` : 'Theme defaults';
    }
  }

  function setColor(key: string, value: string | null): void {
    if (!S.appearance) return;
    if (value) S.appearance.colors[key] = value;
    else delete S.appearance.colors[key];
    syncAppearance();
    queueSend(`c:${key}`, () => send({ type: 'setColors', changes: { [key]: value } }));
  }

  function setSetting(key: string, value: SettingValue | null, ms?: number): void {
    if (!S.appearance) return;
    const st = S.appearance.settings[key] ?? (S.appearance.settings[key] = { value: null, effective: null, def: null });
    st.value = value;
    if (value !== null) st.effective = value;
    syncAppearance();
    queueSend(`s:${key}`, () => send({ type: 'setSettings', changes: { [key]: value } }), ms);
  }

  function wireAppearance(): void {
    const root = $('#tab-appearance');
    const onColor = (ctl: HTMLElement, value: string | null): void => setColor(ctl.closest<HTMLElement>('.row')?.dataset.key ?? '', value);
    const onInput = (e: Event): void => {
      if (handleColorEvent(e, onColor)) return;
      const t = e.target;
      if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
      if (t.dataset.filter) {
        S.filters.appearance = t.value;
        return applyFilter('appearance');
      }
      const row = t.closest<HTMLElement>('.row');
      if (!row) return;
      const key = row.dataset.key ?? '';
      if (t.classList.contains('range')) {
        $<HTMLInputElement>('.num', row).value = t.value;
        setSetting(key, Number(t.value));
      } else if (t.classList.contains('num')) {
        if (t.value === '') setSetting(key, null, 600);
        else if (!Number.isNaN(Number(t.value))) {
          $<HTMLInputElement>('.range', row).value = t.value;
          setSetting(key, Number(t.value), 400);
        }
      } else if (t.classList.contains('font-input')) {
        $('.font-sample', row).style.fontFamily = t.value;
        setSetting(key, t.value.trim() || null, 600);
      } else if (t.classList.contains('select') && e.type === 'change') {
        setSetting(key, t.value === '' ? null : t.value, 0);
      }
    };
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
    root.addEventListener('click', (e) => {
      const t = targetOf(e);
      if (!t) return;
      const areaBtn = t.closest<HTMLElement>('[data-area]');
      if (areaBtn) {
        S.area = areaBtn.dataset.area ?? S.area;
        S.filters.appearance = '';
        persist();
        return renderAppearance();
      }
      const segBtn = t.closest<HTMLElement>('.seg button');
      if (segBtn) {
        const v = segBtn.dataset.val;
        return setSetting(segBtn.closest<HTMLElement>('.row')?.dataset.key ?? '', v === '' ? null : v === 'true', 0);
      }
      const action = t.closest<HTMLElement>('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'reset-item') {
        const row = action.closest<HTMLElement>('.row');
        if (!row) return;
        if (row.dataset.kind === 'color') setColor(row.dataset.key ?? '', null);
        else setSetting(row.dataset.key ?? '', null, 0);
      } else if (action.dataset.action === 'reset-area') {
        resetArea();
      } else if (action.dataset.action === 'open-settings-json') {
        send({ type: 'openSettingsJson' });
      }
    });
  }

  function resetArea(): void {
    const area = S.catalog.areas.find((a) => a.id === S.area);
    const state = S.appearance;
    if (!area || !state) return;
    const colors: Record<string, string | null> = {};
    const settings: Record<string, SettingValue | null> = {};
    for (const item of area.groups.flatMap((g) => g.items)) {
      if (item.kind === 'color' && state.colors[item.key]) {
        colors[item.key] = null;
        delete state.colors[item.key];
      } else if (item.kind === 'setting') {
        const st = state.settings[item.key];
        if (st && st.value !== null) {
          settings[item.key] = null;
          st.value = null;
        }
      }
    }
    if (!Object.keys(colors).length && !Object.keys(settings).length) return toast('Nothing to reset here');
    if (Object.keys(colors).length) send({ type: 'setColors', changes: colors });
    if (Object.keys(settings).length) send({ type: 'setSettings', changes: settings });
    syncAppearance();
    toast(`${area.title} reset to defaults`, 'success');
  }

  function applyFilter(tab: FilterTab): void {
    const root = $(`#tab-${tab}`);
    const q = S.filters[tab].trim().toLowerCase();
    let visible = 0;
    for (const card of $$('.card', root)) {
      let any = false;
      for (const row of $$('[data-search]', card)) {
        const show = !q || (row.dataset.search ?? '').includes(q);
        row.classList.toggle('hidden', !show);
        any = any || show;
      }
      const note = $opt('.note', card);
      if (note) note.classList.toggle('hidden', Boolean(q));
      card.classList.toggle('hidden', !any);
      if (any) visible++;
    }
    const empty = $opt('.empty-state', root);
    if (empty) empty.classList.toggle('hidden', visible > 0);
  }

  // ---------- syntax ----------

  const currentLang = (): Language | undefined => S.catalog.languages.find((l) => l.id === S.lang);
  const styleKey = (langId: string, itemId: string): string => `${langId}/${itemId}`;
  const hasStyle = (st: TokenStyle | null | undefined): boolean => Boolean(st && (st.fg || st.fontStyle !== null));
  const STYLE_BUTTONS: readonly (readonly [string, string, string])[] = [
    ['bold', '<b>B</b>', 'Bold'],
    ['italic', '<i>I</i>', 'Italic'],
    ['underline', '<u>U</u>', 'Underline'],
    ['strikethrough', '<s>S</s>', 'Strikethrough'],
  ];
  const styleToggles = (): string => `<div class="styles">${STYLE_BUTTONS.map(([s, html, title]) => `<button class="style-btn" data-style="${s}" title="${title}">${html}</button>`).join('')}</div>`;

  function syncStyleButtons(row: HTMLElement, fontStyle: string | null): void {
    const set = (fontStyle ?? '').split(/\s+/);
    $$('.style-btn', row).forEach((b) => b.classList.toggle('active', set.includes(b.dataset.style ?? '')));
  }

  function cssFor(st: TokenStyle | undefined): string {
    const parts: string[] = [];
    if (st?.fg) parts.push(`color:${st.fg}`);
    const fs = st?.fontStyle ? st.fontStyle.split(/\s+/) : [];
    if (fs.includes('bold')) parts.push('font-weight:bold');
    if (fs.includes('italic')) parts.push('font-style:italic');
    const deco = ['underline', 'strikethrough'].filter((d) => fs.includes(d)).map((d) => (d === 'strikethrough' ? 'line-through' : d));
    if (deco.length) parts.push(`text-decoration:${deco.join(' ')}`);
    return parts.join(';');
  }

  function previewHtml(lang: Language): string {
    return lang.sample
      .map((line) => {
        const html = line.replace(/⟦([^¦]*)¦([^⟧]*)⟧|([^⟦]+)/g, (_: string, id: string | undefined, text: string | undefined, plain: string | undefined) =>
          plain !== undefined ? esc(plain) : `<span class="tok" data-item="${esc(id ?? '')}">${esc(text ?? '')}</span>`
        );
        return `<div class="pl">${html || ' '}</div>`;
      })
      .join('');
  }

  function semanticBar(): string {
    return `<div class="semantic-bar">
      <div><b>Semantic highlighting</b><span class="muted"> · language servers can recolor names (variables, types, functions) on top of the grammar. Personify writes both, so your colors win either way.</span></div>
      <div class="seg" data-semantic><button data-val="">Theme default</button><button data-val="true">On</button><button data-val="false">Off</button></div>
    </div>`;
  }

  function renderSyntax(): void {
    const langs = S.catalog.languages;
    const first = langs[0];
    if (S.lang !== 'custom' && !langs.some((l) => l.id === S.lang) && first) S.lang = first.id;
    const nav = `<aside class="subnav">
      ${langs.map((l) => `<button class="subnav-item" data-lang="${l.id}"><span class="subnav-icon">${l.id === 'go' ? 'Go' : 'JS'}</span><span class="subnav-text"><b>${esc(l.title)}</b><small data-count="${l.id}"></small></span></button>`).join('')}
      <button class="subnav-item" data-lang="custom"><span class="subnav-icon">✱</span><span class="subnav-text"><b>Custom scopes</b><small data-count="custom"></small></span></button>
      <div class="subnav-tip">Click any token in the preview to jump to its setting.</div>
    </aside>`;
    const lang = currentLang();
    const content = S.lang === 'custom' ? customHtml() : lang ? languageHtml(lang) : '';
    $('#tab-syntax').innerHTML = `<div class="split">${nav}<div class="content">${content}</div></div>`;
    $$('#tab-syntax .subnav-item').forEach((b) => b.classList.toggle('active', b.dataset.lang === S.lang));
    if (S.lang === 'custom') renderCustomRows();
    else applyFilter('syntax');
    syncSyntax();
  }

  function languageHtml(lang: Language): string {
    const groups = lang.groups
      .map(
        (g) => `<details class="card" open>
          <summary><span>${esc(g.title)}</span><small class="muted" data-group-count></small></summary>
          <div class="rows">${g.items
            .map((item) => {
              const search = `${item.label} ${item.example} ${item.scopes.join(' ')}`.toLowerCase();
              return `<div class="row token-row" data-item="${esc(item.id)}" data-search="${esc(search)}">
                <div class="row-label">
                  <div class="label">${esc(item.label)}<span class="dot" title="Customized"></span></div>
                  <div class="desc"><code class="example">${esc(item.example)}</code>${item.hint ? `<div class="hint">ⓘ ${esc(item.hint)}</div>` : ''}</div>
                </div>
                <div class="row-control">${colorControl()}${styleToggles()}</div>
                <button class="icon-btn reset" data-action="reset-token" title="Reset to theme">↺</button>
              </div>`;
            })
            .join('')}</div>
        </details>`
      )
      .join('');
    return `
      <div class="content-head">
        <div><h2>${esc(lang.title)}</h2><p>Color and style every kind of token. Unset tokens keep your theme's colors.</p><div class="target-chip">${targetChip()}</div></div>
        <div class="actions">
          <button class="btn secondary" data-action="open-sample">Open sample in editor</button>
          <button class="btn secondary" data-action="inspect">Inspect token under cursor</button>
          <button class="btn secondary" data-action="reset-lang">Reset ${esc(lang.short)}</button>
        </div>
      </div>
      ${semanticBar()}
      <div class="syntax-layout">
        <div class="token-list">
          <input type="search" class="search" data-filter="syntax" placeholder="Filter tokens (e.g. string, async, scope)…" value="${esc(S.filters.syntax)}">
          ${groups}
          <div class="empty-state hidden">No tokens match this filter.</div>
        </div>
        <div class="preview-wrap">
          <div class="preview-head"><b>Live preview</b><span class="muted">Dimmed tokens use your theme's colors in the editor</span></div>
          <div class="preview"><pre>${previewHtml(lang)}</pre></div>
        </div>
      </div>`;
  }

  function customHtml(): string {
    return `
      <div class="content-head">
        <div><h2>Custom scopes</h2><p>Style any TextMate scope, in any language. Use the inspector to find the scope of a token under your cursor.</p><div class="target-chip">${targetChip()}</div></div>
        <div class="actions">
          <button class="btn secondary" data-action="inspect">Inspect token under cursor</button>
          <button class="btn" data-action="add-custom">＋ Add rule</button>
        </div>
      </div>
      <section class="card"><h3>Rules</h3><div class="rows" id="custom-rows"></div></section>
      <section class="card help">
        <h3>How to find a scope</h3>
        <ol>
          <li>Put the cursor on a token in any file and click <b>Inspect token under cursor</b>.</li>
          <li>Copy a line from the <b>textmate scopes</b> list, e.g. <code>keyword.control.flow.ts</code>.</li>
          <li>Paste it here. Several scopes can be comma-separated; space-separated parts mean "inside", e.g. <code>source.go comment</code>.</li>
        </ol>
      </section>`;
  }

  function renderCustomRows(): void {
    const box = $opt('#custom-rows');
    if (!box) return;
    box.innerHTML = S.custom.length
      ? S.custom
          .map(
            (c) => `<div class="row custom-row" data-id="${esc(c.id)}">
              <div class="row-label"><input type="text" class="text scope-input" placeholder="e.g. source.ts keyword.control, comment.line" spellcheck="false" value="${esc(c.scope)}"></div>
              <div class="row-control">${colorControl()}${styleToggles()}</div>
              <button class="icon-btn reset" data-action="delete-custom" title="Delete rule">✕</button>
            </div>`
          )
          .join('')
      : '<div class="empty-state">No custom rules yet. Click <b>＋ Add rule</b>.</div>';
    syncCustom();
  }

  function syncCustom(): void {
    for (const row of $$('#custom-rows .custom-row')) {
      const c = S.custom.find((x) => x.id === row.dataset.id);
      if (!c) continue;
      setColorCtl($opt('.color-ctl', row), c.fg);
      syncStyleButtons(row, c.fontStyle);
      row.classList.toggle('modified', hasStyle(c));
      row.classList.toggle('incomplete', !c.scope.trim() || !hasStyle(c));
    }
  }

  function syncSyntax(): void {
    if (!S.syntax || !$opt('#tab-syntax .split')) return;
    const items = S.syntax.items;
    for (const lang of S.catalog.languages) {
      const n = lang.groups.flatMap((g) => g.items).filter((i) => hasStyle(items[styleKey(lang.id, i.id)])).length;
      const el = $opt(`#tab-syntax [data-count="${lang.id}"]`);
      if (el) el.textContent = n ? `${n} customized` : 'Theme colors';
    }
    const customCount = $opt('#tab-syntax [data-count="custom"]');
    if (customCount) customCount.textContent = S.custom.length ? `${S.custom.length} rule${S.custom.length > 1 ? 's' : ''}` : 'Any scope';

    const sem = $opt('#tab-syntax [data-semantic]');
    if (sem) {
      const v = S.syntax.semanticHighlighting;
      const val = v === true ? 'true' : v === false ? 'false' : '';
      $$('button', sem).forEach((b) => b.classList.toggle('active', b.dataset.val === val));
    }

    if (S.lang === 'custom') return syncCustom();
    const lang = currentLang();
    if (!lang) return;
    for (const row of $$('#tab-syntax .token-row')) {
      const st = items[styleKey(lang.id, row.dataset.item ?? '')];
      setColorCtl($opt('.color-ctl', row), st?.fg ?? null);
      syncStyleButtons(row, st?.fontStyle ?? null);
      row.classList.toggle('modified', hasStyle(st));
    }
    for (const card of $$('#tab-syntax details.card')) {
      const rows = $$('.token-row', card);
      const n = rows.filter((r) => r.classList.contains('modified')).length;
      $('[data-group-count]', card).textContent = n ? `${n} / ${rows.length} customized` : `${rows.length} tokens`;
    }
    const bg = S.appearance?.colors['editor.background'];
    const fg = S.appearance?.colors['editor.foreground'];
    const preview = $opt('#tab-syntax .preview');
    if (preview) {
      preview.style.background = bg || '';
      preview.style.color = fg || '';
    }
    for (const span of $$('#tab-syntax .tok')) {
      const st = items[styleKey(lang.id, span.dataset.item ?? '')];
      span.style.cssText = cssFor(st);
      span.classList.toggle('dim', !st?.fg);
    }
  }

  function setTokenStyle(itemId: string, patch: Partial<TokenStyle> | null): void {
    const lang = currentLang();
    const syntax = S.syntax;
    if (!lang || !syntax) return;
    const key = styleKey(lang.id, itemId);
    let next: TokenStyle | null = patch === null ? null : { ...(syntax.items[key] ?? { fg: null, fontStyle: null }), ...patch };
    if (next && !hasStyle(next)) next = null;
    if (next) syntax.items[key] = next;
    else delete syntax.items[key];
    syncSyntax();
    const style = next;
    queueSend(`t:${key}`, () => send({ type: 'setSyntax', changes: [{ langId: lang.id, itemId, style }] }));
  }

  function toggleStyle(fontStyle: string | null, style: string): string {
    const set = new Set((fontStyle ?? '').split(/\s+/).filter(Boolean));
    if (set.has(style)) set.delete(style);
    else set.add(style);
    return [...set].join(' ');
  }

  function updateCustom(id: string, patch: Partial<CustomRule>): void {
    const c = S.custom.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, patch);
    syncCustom();
    queueSend('custom', sendCustom, 400);
  }
  const sendCustom = (): void => send({ type: 'setCustom', list: S.custom.map(({ id, scope, fg, fontStyle }) => ({ id, scope, fg, fontStyle })) });

  function mergeCustom(server: CustomRule[]): void {
    if (S.pending.has('custom')) return;
    const ids = new Set(server.map((c) => c.id));
    const drafts = S.custom.filter((c) => !ids.has(c.id) && (!c.scope.trim() || !hasStyle(c)));
    S.custom = [...server, ...drafts];
  }

  function flash(el: HTMLElement): void {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  function wireSyntax(): void {
    const root = $('#tab-syntax');
    const onColor = (ctl: HTMLElement, value: string | null): void => {
      const row = ctl.closest<HTMLElement>('.row');
      if (!row) return;
      if (row.classList.contains('custom-row')) updateCustom(row.dataset.id ?? '', { fg: value || null });
      else setTokenStyle(row.dataset.item ?? '', { fg: value || null });
    };
    const onInput = (e: Event): void => {
      if (handleColorEvent(e, onColor)) return;
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.dataset.filter) {
        S.filters.syntax = t.value;
        return applyFilter('syntax');
      }
      if (t.classList.contains('scope-input')) updateCustom(t.closest<HTMLElement>('.row')?.dataset.id ?? '', { scope: t.value });
    };
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);

    root.addEventListener('click', (e) => {
      const t = targetOf(e);
      if (!t) return;
      const langBtn = t.closest<HTMLElement>('[data-lang]');
      if (langBtn) {
        S.lang = langBtn.dataset.lang ?? S.lang;
        S.filters.syntax = '';
        persist();
        return renderSyntax();
      }
      const semBtn = t.closest<HTMLElement>('[data-semantic] button');
      if (semBtn) {
        if (!S.syntax) return;
        const v = semBtn.dataset.val;
        const value = v === '' ? null : v === 'true';
        S.syntax.semanticHighlighting = value;
        syncSyntax();
        return send({ type: 'setSettings', changes: { [SEMANTIC_KEY]: value } });
      }
      const styleBtn = t.closest<HTMLElement>('.style-btn');
      if (styleBtn) {
        const row = styleBtn.closest<HTMLElement>('.row');
        const style = styleBtn.dataset.style ?? '';
        if (!row) return;
        if (row.classList.contains('custom-row')) {
          const c = S.custom.find((x) => x.id === row.dataset.id);
          return c && updateCustom(c.id, { fontStyle: toggleStyle(c.fontStyle, style) });
        }
        const itemId = row.dataset.item ?? '';
        const st = S.syntax?.items[styleKey(S.lang, itemId)];
        return setTokenStyle(itemId, { fontStyle: toggleStyle(st?.fontStyle ?? null, style) });
      }
      const tok = t.closest<HTMLElement>('.tok');
      if (tok) {
        const row = $opt(`#tab-syntax .token-row[data-item="${tok.dataset.item ?? ''}"]`);
        if (!row) return;
        if (row.classList.contains('hidden')) {
          S.filters.syntax = '';
          $<HTMLInputElement>('#tab-syntax [data-filter]').value = '';
          applyFilter('syntax');
        }
        const details = row.closest<HTMLDetailsElement>('details');
        if (details) details.open = true;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(row);
        return;
      }
      const action = t.closest<HTMLElement>('[data-action]');
      if (!action) return;
      const lang = currentLang();
      switch (action.dataset.action) {
        case 'reset-token':
          return setTokenStyle(action.closest<HTMLElement>('.row')?.dataset.item ?? '', null);
        case 'reset-lang': {
          const syntax = S.syntax;
          if (!lang || !syntax) return;
          const changes = lang.groups
            .flatMap((g) => g.items)
            .filter((i) => hasStyle(syntax.items[styleKey(lang.id, i.id)]))
            .map((i) => {
              delete syntax.items[styleKey(lang.id, i.id)];
              return { langId: lang.id, itemId: i.id, style: null };
            });
          if (!changes.length) return toast('Nothing to reset here');
          send({ type: 'setSyntax', changes });
          syncSyntax();
          return toast(`${lang.title} reset to theme colors`, 'success');
        }
        case 'open-sample':
          if (lang) send({ type: 'openSample', langId: lang.id });
          return;
        case 'inspect': {
          const langId = lang?.id ?? S.catalog.languages[0]?.id;
          if (langId) send({ type: 'inspectScope', langId });
          return;
        }
        case 'add-custom': {
          const id = Date.now().toString(36);
          S.custom.push({ id, scope: '', fg: null, fontStyle: null });
          renderCustomRows();
          syncSyntax();
          $opt<HTMLInputElement>(`#custom-rows .custom-row[data-id="${id}"] .scope-input`)?.focus();
          return;
        }
        case 'delete-custom': {
          const id = action.closest<HTMLElement>('.row')?.dataset.id;
          S.custom = S.custom.filter((c) => c.id !== id);
          renderCustomRows();
          syncSyntax();
          return queueSend('custom', sendCustom, 0);
        }
      }
    });

    // Hovering a token row highlights its tokens in the preview.
    root.addEventListener('mouseover', (e) => {
      const row = targetOf(e)?.closest<HTMLElement>('.token-row');
      const id = row?.dataset.item ?? '';
      if (root.dataset.hover === id) return;
      root.dataset.hover = id;
      $$('.tok', root).forEach((s) => s.classList.toggle('hl', s.dataset.item === id));
    });
  }

  // ---------- hotkeys ----------

  /** A keybinding row with what the table derives from it. */
  type ViewRow = KeybindingRow & { nk: string; removed: boolean; conflicts: ViewRow[] };
  /** A command without a shortcut, shown under "Without shortcut". */
  interface CommandRow {
    source: 'unbound';
    id: string;
    command: string;
    title: string;
    key: '';
    when: '';
    args: undefined;
  }
  type ListRow = ViewRow | CommandRow;
  type UserViewRow = Extract<ViewRow, { source: 'user' }>;
  type DefaultViewRow = Extract<ViewRow, { source: 'default' }>;

  const commandRow = (command: string, title: string): CommandRow => ({ source: 'unbound', id: `c:${command}`, command, title, key: '', when: '', args: undefined });

  let kbView: { rows: ViewRow[]; bound: Set<string>; withDefault: Set<string>; counts: Record<KbFilter, number> } = {
    rows: [],
    bound: new Set(),
    withDefault: new Set(),
    counts: { all: 0, changed: 0, conflicts: 0, removed: 0, unbound: 0 },
  };

  function computeKb(kb: KeybindingsState): void {
    const rows = kb.rows
      .map((r): ViewRow => ({ ...r, nk: normKey(r.key), removed: r.source === 'default' && r.removalIndex !== null, conflicts: [] }))
      .sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
    const groups = new Map<string, ViewRow[]>();
    for (const r of rows) {
      if (r.removed) continue;
      const group = groups.get(r.nk);
      if (group) group.push(r);
      else groups.set(r.nk, [r]);
    }
    for (const r of rows) {
      r.conflicts = r.removed ? [] : (groups.get(r.nk) ?? []).filter((o) => o !== r && o.command !== r.command && (o.when === r.when || !o.when || !r.when));
    }
    const bound = new Set(rows.filter((r) => !r.removed).map((r) => r.command));
    kbView = {
      rows,
      bound,
      withDefault: new Set(rows.filter((r) => r.source === 'default').map((r) => r.command)),
      counts: {
        all: rows.length,
        changed: rows.filter((r) => r.source === 'user' || r.removed).length,
        conflicts: rows.filter((r) => r.conflicts.length).length,
        removed: rows.filter((r) => r.removed).length,
        unbound: kb.commands.filter((c) => !bound.has(c.id)).length,
      },
    };
    $('#cmd-list').innerHTML = kb.commands.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
  }

  function kbFiltered(kb: KeybindingsState): ListRow[] {
    const raw = S.kbQuery.trim().toLowerCase();
    const looksLikeKey = /[+]/.test(raw) || S.kbRecordSearch;
    const nq = normKey(raw);
    const matches = (r: ListRow): boolean => {
      if (!raw) return true;
      if (looksLikeKey && r.source !== 'unbound' && r.nk && r.nk.includes(nq)) return true;
      return r.title.toLowerCase().includes(raw) || r.command.toLowerCase().includes(raw) || r.key.toLowerCase().includes(raw) || r.when.toLowerCase().includes(raw);
    };
    const filter = S.kbFilter;
    if (filter === 'unbound') {
      return kb.commands
        .filter((c) => !kbView.bound.has(c.id))
        .map((c) => commandRow(c.id, c.title))
        .filter(matches);
    }
    const pick: Record<Exclude<KbFilter, 'unbound'>, (r: ViewRow) => boolean> = {
      all: () => true,
      changed: (r) => r.source === 'user' || r.removed,
      conflicts: (r) => r.conflicts.length > 0,
      removed: (r) => r.removed,
    };
    return kbView.rows.filter((r) => pick[filter](r) && matches(r));
  }

  function kbRowHtml(r: ListRow): string {
    const btn = (action: string, label: string, title: string, cls = ''): string => `<button class="icon-btn ${cls}" data-kb="${action}" data-id="${esc(r.id)}" title="${esc(title)}">${label}</button>`;
    let badge: string;
    let actions: string;
    if (r.source === 'unbound') {
      badge = '<span class="badge">No shortcut</span>';
      actions = btn('add', '＋ Assign', 'Assign a shortcut', 'text-btn');
    } else if (r.removed) {
      badge = '<span class="badge badge-removed">Removed</span>';
      actions = btn('restore', '↺ Restore', 'Bring this default shortcut back', 'text-btn');
    } else if (r.source === 'user') {
      badge = '<span class="badge badge-user">Custom</span>';
      actions = btn('edit', '✎', 'Edit shortcut') + btn('add', '＋', 'Add another shortcut for this command') + btn('remove', '🗑', 'Delete this shortcut') + (kbView.withDefault.has(r.command) ? btn('reset', '↺', 'Reset command to defaults') : '');
    } else {
      badge = '<span class="badge">Default</span>';
      actions = btn('edit', '✎', 'Change shortcut') + btn('add', '＋', 'Add another shortcut for this command') + btn('remove', '⊘', 'Remove this default shortcut');
    }
    const conflicts = r.source === 'unbound' ? [] : r.conflicts;
    const conflict = conflicts.length
      ? `<span class="conflict" title="Same key also runs:\n${esc(conflicts.slice(0, 6).map((c) => `• ${c.title}${c.when ? ` (when ${c.when})` : ''}`).join('\n'))}">⚠ ${conflicts.length}</span>`
      : '';
    const removed = r.source !== 'unbound' && r.removed;
    return `<div class="kb-row ${removed ? 'removed' : ''} ${r.source === 'user' ? 'user' : ''}">
      <div class="kb-cmd"><div class="kb-title">${esc(r.title)}</div><div class="kb-id">${esc(r.command)}</div></div>
      <div class="kb-key">${keyHtml(r.key)}${conflict}</div>
      <div class="kb-when">${r.when ? `<code>${esc(r.when)}</code>` : '<span class="muted">always</span>'}</div>
      <div class="kb-src">${badge}</div>
      <div class="kb-actions">${actions}</div>
    </div>`;
  }

  function renderHotkeysShell(): void {
    $('#tab-hotkeys').innerHTML = `
      <div class="content wide">
        <div class="content-head">
          <div><h2>Keyboard shortcuts</h2><p id="kb-file" class="muted"></p></div>
          <div class="actions">
            <button class="btn" data-kbtool="add">＋ Add shortcut</button>
            <button class="btn secondary" data-kbtool="json">Open keybindings.json</button>
            <button class="btn secondary" data-kbtool="refresh" title="Reload the list (e.g. after installing an extension)">↻</button>
          </div>
        </div>
        <div id="kb-error" class="banner error hidden"></div>
        <div class="kb-toolbar">
          <div class="search-wrap">
            <input type="search" id="kb-search" class="search" placeholder="Search command, key (cmd+p) or when…" value="${esc(S.kbQuery)}">
            <button class="btn secondary ${S.kbRecordSearch ? 'active' : ''}" id="kb-record-search" title="Press keys to search by shortcut">⌨ Search by keys</button>
          </div>
          <div class="chips">${KB_FILTERS.map(([id, label]) => `<button class="chip ${S.kbFilter === id ? 'active' : ''}" data-filter-kb="${id}">${label} <span data-kbcount="${id}"></span></button>`).join('')}</div>
        </div>
        <div class="kb-table">
          <div class="kb-row kb-head"><div>Command</div><div>Shortcut</div><div>When</div><div>Source</div><div></div></div>
          <div id="kb-body"><div class="empty-state">Loading shortcuts…</div></div>
        </div>
        <div class="kb-more"></div>
      </div>`;
  }

  function renderKbRows(): void {
    if (!S.kb) return;
    const list = kbFiltered(S.kb);
    const shown = list.slice(0, S.kbLimit);
    $('#kb-body').innerHTML = shown.length ? shown.map(kbRowHtml).join('') : '<div class="empty-state">No shortcuts match.</div>';
    const more = list.length - shown.length;
    $('#tab-hotkeys .kb-more').innerHTML = more > 0 ? `<button class="btn secondary" data-kbtool="more">Show ${Math.min(more, 200)} more (${more} hidden)</button>` : '';
    for (const [id, n] of Object.entries(kbView.counts)) {
      const el = $opt(`[data-kbcount="${id}"]`);
      if (el) el.textContent = String(n);
    }
    $$('#tab-hotkeys .chip').forEach((c) => c.classList.toggle('active', c.dataset.filterKb === S.kbFilter));
  }

  function findKbRow(id: string): ListRow | undefined {
    if (id.startsWith('c:')) {
      const cmd = id.slice(2);
      const c = S.kb?.commands.find((x) => x.id === cmd);
      return commandRow(cmd, c ? c.title : cmd);
    }
    return kbView.rows.find((r) => r.id === id);
  }

  const kbOp = (edit: KeybindingEdit): void => send({ type: 'kb', edit });

  function wireHotkeys(): void {
    renderHotkeysShell();
    const root = $('#tab-hotkeys');
    root.addEventListener('input', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.id !== 'kb-search') return;
      S.kbQuery = t.value;
      S.kbLimit = 200;
      debounce('kb-search', renderKbRows, 120);
    });
    root.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.id !== 'kb-search' || !S.kbRecordSearch) return;
      const key = keyFromEvent(e);
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      t.value = key;
      S.kbQuery = key;
      renderKbRows();
    });
    root.addEventListener('click', (e) => {
      const t = targetOf(e);
      if (!t) return;
      const recordSearch = t.closest('#kb-record-search');
      if (recordSearch) {
        S.kbRecordSearch = !S.kbRecordSearch;
        recordSearch.classList.toggle('active', S.kbRecordSearch);
        const input = $<HTMLInputElement>('#kb-search');
        input.placeholder = S.kbRecordSearch ? 'Press a key combination…' : 'Search command, key (cmd+p) or when…';
        input.focus();
        return;
      }
      const chip = t.closest<HTMLElement>('[data-filter-kb]');
      if (chip) {
        S.kbFilter = KB_FILTERS.find(([id]) => id === chip.dataset.filterKb)?.[0] ?? 'all';
        S.kbLimit = 200;
        return renderKbRows();
      }
      const tool = t.closest<HTMLElement>('[data-kbtool]');
      if (tool) {
        switch (tool.dataset.kbtool) {
          case 'add':
            return openRecorder({ mode: 'add', seed: null });
          case 'json':
            return send({ type: 'openKeybindingsJson' });
          case 'refresh':
            return send({ type: 'kbRefresh' });
          case 'more':
            S.kbLimit += 200;
            return renderKbRows();
        }
      }
      const b = t.closest<HTMLElement>('[data-kb]');
      if (!b) return;
      const row = findKbRow(b.dataset.id ?? '');
      if (!row) return;
      switch (b.dataset.kb) {
        case 'edit':
          if (row.source === 'user') openRecorder({ mode: 'update', row });
          else if (row.source === 'default') openRecorder({ mode: 'replace', row });
          return;
        case 'add':
          return openRecorder({ mode: 'add', seed: { command: row.command, title: row.title, when: row.source === 'unbound' ? '' : row.when, args: row.args } });
        case 'remove':
          if (row.source === 'user') kbOp({ op: 'remove', index: row.index, command: row.command });
          else if (row.source === 'default') kbOp({ op: 'disableDefault', command: row.command, key: row.key, when: row.when });
          return;
        case 'restore':
          if (row.source === 'default' && row.removalIndex !== null) kbOp({ op: 'restoreDefault', index: row.removalIndex, command: row.command });
          return;
        case 'reset':
          return kbOp({ op: 'resetCommand', command: row.command });
      }
    });
  }

  /** The command a new shortcut is for; null lets the user type it. */
  interface AddSeed {
    command: string;
    title: string;
    when: string;
    args: unknown;
  }
  type RecorderOpts = { mode: 'add'; seed: AddSeed | null } | { mode: 'update'; row: UserViewRow } | { mode: 'replace'; row: DefaultViewRow };

  // Modal to record / edit a shortcut.
  function openRecorder(opts: RecorderOpts): void {
    const titles: Record<RecorderOpts['mode'], string> = { add: 'Add shortcut', update: 'Edit shortcut', replace: 'Change default shortcut' };
    const row = opts.mode === 'add' ? opts.seed : opts.row;
    const editableCommand = !row;
    let chords = opts.mode !== 'add' && opts.row.key ? opts.row.key.trim().split(/\s+/) : [];
    // The first key pressed replaces an existing shortcut instead of extending it into a chord.
    let fresh = true;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${titles[opts.mode]}</h3>
        ${editableCommand
          ? `<label class="field"><span>Command</span><input type="text" class="text" id="rec-command" list="cmd-list" placeholder="Start typing a command id, e.g. workbench.action.files.save" spellcheck="false"></label>`
          : `<div class="field"><span>Command</span><div class="cmd-display"><b>${esc(row.title)}</b><code>${esc(row.command)}</code></div></div>`}
        <div class="field">
          <span>Shortcut</span>
          <div class="recorder" tabindex="0" id="rec-box"><span class="rec-keys"></span><span class="rec-hint">Click here and press keys</span></div>
          <small class="muted">Press a combination. Press a second one to make a chord (e.g. ${isMac() ? '⌘K ⌘S' : 'Ctrl+K Ctrl+S'}). Backspace clears, Esc stops recording.</small>
          <input type="text" class="text" id="rec-manual" placeholder="…or type it, e.g. ${isMac() ? 'cmd+shift+k' : 'ctrl+shift+k'}" spellcheck="false">
        </div>
        <label class="field"><span>When <small class="muted">(optional context, e.g. editorTextFocus)</small></span><input type="text" class="text" id="rec-when" list="when-list" spellcheck="false"></label>
        <div class="rec-conflicts"></div>
        ${opts.mode === 'replace' ? '<div class="muted small">The default shortcut is switched off and your new one is added to keybindings.json. You can restore it any time.</div>' : ''}
        <div class="modal-actions">
          <button class="btn secondary" data-m="cancel">Cancel</button>
          <button class="btn" data-m="save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const box = $('#rec-box', wrap);
    const manual = $<HTMLInputElement>('#rec-manual', wrap);
    const when = $<HTMLInputElement>('#rec-when', wrap);
    const cmdInput = $opt<HTMLInputElement>('#rec-command', wrap);
    when.value = row?.when ?? '';
    const command = (): string => (cmdInput ? cmdInput.value.trim() : (row?.command ?? ''));

    const update = (): void => {
      const key = chords.join(' ');
      $('.rec-keys', box).innerHTML = key ? keyHtml(key) : '';
      box.classList.toggle('has-keys', Boolean(key));
      if (document.activeElement !== manual) manual.value = key;
      const nk = normKey(key);
      const others = key && S.kb ? kbView.rows.filter((r) => !r.removed && r.nk === nk && r.command !== command() && r !== row) : [];
      $('.rec-conflicts', wrap).innerHTML = others.length
        ? `<div class="banner warn">⚠ Also used by ${others
            .slice(0, 4)
            .map((o) => `<b>${esc(o.title)}</b>${o.when ? ` <span class="muted">(when ${esc(o.when)})</span>` : ''}`)
            .join(', ')}${others.length > 4 ? ` and ${others.length - 4} more` : ''}</div>`
        : '';
    };

    box.addEventListener('focus', () => {
      fresh = true;
      box.classList.add('recording');
    });
    box.addEventListener('blur', () => box.classList.remove('recording'));
    box.addEventListener('keydown', (e) => {
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (plain && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return box.blur();
      }
      if (plain && e.key === 'Backspace') {
        e.preventDefault();
        chords = [];
        return update();
      }
      const key = keyFromEvent(e);
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      chords = fresh || chords.length >= 2 ? [key] : [...chords, key];
      fresh = false;
      update();
    });
    manual.addEventListener('input', () => {
      chords = manual.value.trim() ? manual.value.trim().toLowerCase().split(/\s+/) : [];
      update();
    });
    if (cmdInput) cmdInput.addEventListener('input', update);

    const close = (): void => {
      wrap.remove();
      document.removeEventListener('keydown', onDocKey, true);
    };
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && document.activeElement !== box) close();
    };
    document.addEventListener('keydown', onDocKey, true);
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) close();
    });
    wrap.addEventListener('click', (e) => {
      const m = targetOf(e)?.closest<HTMLElement>('[data-m]');
      if (!m) return;
      if (m.dataset.m === 'cancel') return close();
      const key = chords.join(' ');
      const cmd = command();
      const w = when.value.trim();
      if (!cmd) return toast('Choose a command first', 'error');
      if (!key) return toast('Record or type a shortcut first', 'error');
      if (opts.mode === 'add') kbOp({ op: 'add', command: cmd, key, when: w, args: opts.seed?.args });
      else if (opts.mode === 'update') kbOp({ op: 'update', index: opts.row.index, command: opts.row.command, key, when: w });
      else if (key !== opts.row.key || w !== opts.row.when) kbOp({ op: 'replaceDefault', command: opts.row.command, oldKey: opts.row.key, oldWhen: opts.row.when, key, when: w, args: opts.row.args });
      toast('Shortcut saved', 'success');
      close();
    });

    update();
    (cmdInput ?? box).focus();
  }

  // ---------- profiles ----------

  function wireProfiles(): void {
    const root = $('#tab-profiles');
    root.innerHTML = `
      <div class="content wide">
        <div class="content-head"><div><h2>Profiles & backup</h2><p>Save your setup to a file, move it to another machine, or roll back.</p><div class="target-chip">${targetChip()}</div></div></div>
        <div class="grid">
          <section class="card action-card">
            <div class="ac-icon">⇪</div>
            <h3>Export profile</h3>
            <p>Writes your Personify colors, fonts and syntax rules (for the scope above) to a JSON file.</p>
            <label class="check"><input type="checkbox" id="exp-kb" checked> Include keybindings.json</label>
            <button class="btn" data-p="export">Export…</button>
          </section>
          <section class="card action-card">
            <div class="ac-icon">⇩</div>
            <h3>Import profile</h3>
            <p>Load a profile exported by Personify. You choose whether to replace or merge with what you have.</p>
            <button class="btn" data-p="import">Import…</button>
          </section>
          <section class="card action-card">
            <div class="ac-icon">↶</div>
            <h3>Revert this session</h3>
            <p>Undo every change made since this panel was opened: settings in both scopes and keybindings.json.</p>
            <button class="btn secondary" data-p="revert">Revert session</button>
          </section>
          <section class="card action-card danger">
            <div class="ac-icon">⟲</div>
            <h3>Reset Personify customizations</h3>
            <p>Removes everything Personify wrote for the scope above. Your hand-written settings and keybindings stay.</p>
            <button class="btn danger" data-p="reset">Reset…</button>
          </section>
        </div>
        <section class="card help">
          <h3>Where things are stored</h3>
          <ul>
            <li><b>Colors</b> → <code>workbench.colorCustomizations</code>, <b>syntax</b> → <code>editor.tokenColorCustomizations</code> + <code>editor.semanticTokenColorCustomizations</code>, <b>fonts</b> → regular settings.</li>
            <li><b>Save to</b> picks user settings (every project) or this workspace's <code>.vscode/settings.json</code>.</li>
            <li><b>Apply to → Current theme</b> nests values under <code>"[Theme name]"</code>, so other themes stay untouched.</li>
            <li><b>Hotkeys</b> go to <code>keybindings.json</code>. Before the first change in a session Personify saves a copy next to it: <code>keybindings.json.personify-backup</code>.</li>
          </ul>
          <div class="actions"><button class="btn secondary" data-p="settings">Open settings.json</button><button class="btn secondary" data-p="keybindings">Open keybindings.json</button></div>
        </section>
      </div>`;
    root.addEventListener('click', (e) => {
      const b = targetOf(e)?.closest<HTMLElement>('[data-p]');
      if (!b) return;
      switch (b.dataset.p) {
        case 'export':
          return send({ type: 'export', includeKeybindings: $<HTMLInputElement>('#exp-kb').checked });
        case 'import':
          return send({ type: 'import' });
        case 'revert':
          return send({ type: 'revertSession' });
        case 'reset':
          return send({ type: 'resetAll' });
        case 'settings':
          return send({ type: 'openSettingsJson' });
        case 'keybindings':
          return send({ type: 'openKeybindingsJson' });
      }
    });
  }

  // ---------- messages ----------

  // Keep local values for keys whose write is still queued.
  function keepPending<T extends string | TokenStyle>(prefix: string, local: Record<string, T>, incoming: Record<string, T>): void {
    for (const key of S.pending) {
      if (!key.startsWith(prefix)) continue;
      const k = key.slice(prefix.length);
      const value = local[k];
      if (value === undefined) delete incoming[k];
      else incoming[k] = value;
    }
  }

  window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        S.catalog = msg.catalog;
        S.platform = msg.platform;
        if (msg.tab) S.tab = msg.tab;
        renderShell();
        return;
      case 'focusTab':
        return showTab(msg.tab);
      case 'state': {
        const first = !S.appearance;
        if (S.appearance) {
          keepPending('c:', S.appearance.colors, msg.appearance.colors);
          for (const key of S.pending) {
            if (!key.startsWith('s:')) continue;
            const local = S.appearance.settings[key.slice(2)];
            if (local) msg.appearance.settings[key.slice(2)] = local;
          }
        }
        if (S.syntax) keepPending('t:', S.syntax.items, msg.syntax.items);
        S.prefs = msg.prefs;
        S.appearance = msg.appearance;
        S.syntax = msg.syntax;
        const customBefore = S.custom.map((c) => c.id).join();
        mergeCustom(msg.syntax.custom);
        syncPrefs();
        if (first) {
          renderAppearance();
          renderSyntax();
        } else {
          syncAppearance();
          if (S.lang === 'custom' && customBefore !== S.custom.map((c) => c.id).join()) renderCustomRows();
          syncSyntax();
        }
        return;
      }
      case 'keybindings':
        S.kb = msg;
        $('#kb-file').innerHTML = `Saved to <code>${esc(msg.file)}</code>${msg.defaultsFromVscode ? '' : ' · <span class="warn-text">built-in defaults unavailable, showing extension shortcuts only</span>'}`;
        $('#kb-error').classList.toggle('hidden', !msg.error);
        $('#kb-error').textContent = msg.error ?? '';
        computeKb(msg);
        renderKbRows();
        return;
      case 'toast':
        return toast(msg.text, msg.kind);
      default: {
        const unknownMessage: never = msg;
        return unknownMessage;
      }
    }
  });

  send({ type: 'ready' });
})();
