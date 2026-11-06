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

  const TABS: readonly { id: Tab; label: string; icon: string }[] = [
    { id: 'hotkeys', label: 'Hotkeys', icon: '⌘' },
    { id: 'appearance', label: 'Appearance', icon: 'Aa' },
    { id: 'syntax', label: 'Syntax colors', icon: '{}' },
    { id: 'profiles', label: 'Profiles & backup', icon: '↕' },
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

  /** A shortcut being changed in its row. */
  interface KbEdit {
    rowId: string;
    chords: string[];
    when: string;
    /** The first key pressed replaces the old shortcut instead of extending it into a chord. */
    fresh: boolean;
  }

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
    /** The shortcut being changed in its row; null when none is. */
    kbEdit: KbEdit | null;
    snapshots: readonly SnapshotInfo[];
    /** When the panel opened, in epoch milliseconds; 0 until the host says. */
    sessionStart: number;
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
    kbEdit: null,
    snapshots: [],
    sessionStart: 0,
    filters: { appearance: '', syntax: '' },
    pending: new Set(),
  };
  const persist = (): void => vscode.setState({ tab: S.tab, area: S.area, lang: S.lang });
  const isMac = (): boolean => S.platform === 'darwin';

  // ---------- small helpers ----------

  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();
  function debounce(key: string, fn: () => void, ms = 180): void {
    const old = timers.get(key);
    if (old) clearTimeout(old.timer);
    const run = (): void => {
      timers.delete(key);
      fn();
    };
    timers.set(key, { timer: setTimeout(run, ms), run });
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
  /** Sends every queued write now: the host writes it to the target it has when the message arrives. */
  function flushPending(): void {
    for (const key of [...S.pending]) {
      const t = timers.get(key);
      if (!t) continue;
      clearTimeout(t.timer);
      t.run();
    }
  }
  /** Drops a queued write; true when there was one. */
  function cancelPending(key: string): boolean {
    const t = timers.get(key);
    if (t) clearTimeout(t.timer);
    timers.delete(key);
    return S.pending.delete(key);
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

  // A copy of normalizeKey in src/core/keybindings.ts (the webview loads no host module); keep the two the same.
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

  /** Every TextMate scope the catalog knows, bare and inside its language, for the custom scope field. */
  function catalogScopes(): string[] {
    const all = S.catalog.languages.flatMap((lang) => lang.groups.flatMap((g) => g.items.flatMap((i) => i.scopes.flatMap((s) => [s, ...lang.roots.map((r) => `${r} ${s}`)]))));
    return [...new Set(all)].sort();
  }

  /** One rail entry; a group with sub-pages opens a flyout when the rail is collapsed. */
  function navGroupHtml(tab: Tab, subs: readonly (readonly [string, string])[]): string {
    const t = TABS.find((x) => x.id === tab);
    if (!t) return '';
    const kids = subs
      .map(([id, label]) => `<button class="nav-sub-item" data-nav="${tab}" data-sub="${esc(id)}"><span>${esc(label)}</span><span class="nav-count" data-count="${tab}:${esc(id)}"></span></button>`)
      .join('');
    return `<div class="nav-group" data-group="${tab}">
      <button class="nav-item" data-nav="${tab}" title="${esc(t.label)}"><span class="nav-icon">${esc(t.icon)}</span><span class="nav-text">${esc(t.label)}</span><span class="nav-badge" data-count="${tab}"></span></button>
      ${kids ? `<div class="nav-sub"><div class="flyout-title">${esc(t.label)}</div>${kids}</div>` : ''}
    </div>`;
  }

  function renderShell(): void {
    const areas = S.catalog.areas.map((a) => [a.id, a.title] as const);
    const langs = [...S.catalog.languages.map((l) => [l.id, l.title] as const), ['custom', 'Custom scopes'] as const];
    app.innerHTML = `
      <div class="layout">
        <aside class="rail">
          <div class="brand"><div class="logo">P</div><div class="brand-text"><b>Personify</b><small>Make VS Code yours</small></div></div>
          <div class="nav-label">Customize</div>
          <nav class="nav">
            ${navGroupHtml('hotkeys', [])}
            ${navGroupHtml('appearance', areas)}
            ${navGroupHtml('syntax', langs)}
            ${navGroupHtml('profiles', [])}
          </nav>
          <div class="session" id="session" title="Everything Personify has set">
            <div class="session-head"><span class="session-dot"></span><span id="session-title">Theme defaults</span></div>
            <div class="session-line" id="session-count"></div>
            <div class="session-sub" id="session-target"></div>
            <button class="btn secondary" data-session="revert" title="Undo every change made since this panel was opened">↺ Revert session</button>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <div class="crumbs" id="crumbs"></div>
            <div class="scope-bar">
              <div class="scope-field" title="Where settings are written">
                <span>Save to</span>
                <div class="seg" id="scope"><button data-val="user">User</button><button data-val="workspace">Workspace</button></div>
              </div>
              <div class="scope-field" title="Colors can apply to every theme or only to the active one">
                <span>Apply to</span>
                <div class="seg" id="themeMode"><button data-val="all">All themes</button><button data-val="current">Current theme</button></div>
              </div>
              <span class="scope-note">ⓘ Shortcuts always save to user keybindings.json</span>
            </div>
          </header>
          <main>
            ${TABS.map((t) => `<section class="tab-panel" id="tab-${t.id}" role="tabpanel"></section>`).join('')}
          </main>
        </div>
      </div>
      <datalist id="font-list">${FONTS.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
      <datalist id="when-list">${WHEN.map((w) => `<option value="${esc(w)}">`).join('')}</datalist>
      <datalist id="scope-list">${catalogScopes().map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      <datalist id="cmd-list"></datalist>`;

    $('.rail', app).addEventListener('click', (e) => {
      const t = targetOf(e);
      if (t?.closest('[data-session="revert"]')) return send({ type: 'revertSession' });
      const item = t?.closest<HTMLElement>('[data-nav]');
      if (item) navigate(toTab(item.dataset.nav), item.dataset.sub);
    });
    $('.scope-bar', app).addEventListener('click', (e) => {
      const b = targetOf(e)?.closest<HTMLButtonElement>('.seg button');
      const p = S.prefs;
      if (!b || b.disabled || !p) return;
      if (b.closest('#scope')) sendPrefs({ scope: b.dataset.val === 'workspace' ? 'workspace' : 'user', themeMode: p.themeMode });
      else sendPrefs({ scope: p.scope, themeMode: b.dataset.val === 'current' ? 'current' : 'all' });
    });
    wireAppearance();
    wireSyntax();
    wireHotkeys();
    wireProfiles();
    showTab(S.tab);
  }

  /** Opens a page; `sub` picks an appearance area or a syntax language. */
  function navigate(tab: Tab, sub?: string): void {
    if (tab === 'appearance' && sub && sub !== S.area) {
      S.area = sub;
      S.filters.appearance = '';
      renderAppearance();
    } else if (tab === 'syntax' && sub && sub !== S.lang) {
      S.lang = sub;
      S.filters.syntax = '';
      renderSyntax();
    }
    showTab(tab);
    window.scrollTo(0, 0);
  }

  function showTab(tab: string | undefined): void {
    S.tab = toTab(tab);
    persist();
    $$('.tab-panel', app).forEach((p) => p.classList.toggle('active', p.id === `tab-${S.tab}`));
    app.classList.toggle('hotkeys-mode', S.tab === 'hotkeys');
    const sub = S.tab === 'appearance' ? S.area : S.tab === 'syntax' ? S.lang : '';
    for (const g of $$('.nav-group', app)) {
      const on = g.dataset.group === S.tab;
      g.classList.toggle('open', on);
      $('.nav-item', g).classList.toggle('active', on && !$opt('.nav-sub', g));
      $$('.nav-sub-item', g).forEach((b) => b.classList.toggle('active', on && b.dataset.sub === sub));
    }
    const tabLabel = TABS.find((t) => t.id === S.tab)?.label ?? '';
    const subLabel = S.tab === 'appearance' ? S.catalog.areas.find((a) => a.id === S.area)?.title : S.tab === 'syntax' ? (S.lang === 'custom' ? 'Custom scopes' : currentLang()?.title) : undefined;
    $('#crumbs').innerHTML = subLabel ? `<span>${esc(tabLabel)}</span><span class="crumb-sep">/</span><b>${esc(subLabel)}</b>` : `<b>${esc(tabLabel)}</b>`;
  }

  function sendPrefs(prefs: { scope: Scope; themeMode: ThemeMode }): void {
    const p = S.prefs;
    if (p && p.scope === prefs.scope && p.themeMode === prefs.themeMode) return;
    // Writes still queued belong to the old target, so they go out before the switch.
    flushPending();
    S.custom = [];
    send({ type: 'prefs', ...prefs });
  }

  function syncPrefs(): void {
    const p = S.prefs;
    if (!p) return;
    const scope = $('#scope');
    $$('button', scope).forEach((b) => b.classList.toggle('active', b.dataset.val === p.scope));
    const workspace = $<HTMLButtonElement>('[data-val="workspace"]', scope);
    workspace.disabled = !p.hasWorkspace && p.scope !== 'workspace';
    workspace.title = p.hasWorkspace ? 'This workspace only (.vscode/settings.json)' : 'Open a folder first: workspace settings live in its .vscode/settings.json';
    const tm = $('#themeMode');
    $$('button', tm).forEach((b) => b.classList.toggle('active', b.dataset.val === p.themeMode));
    const current = $('[data-val="current"]', tm);
    current.textContent = p.theme;
    current.title = `Only "${p.theme}"`;
    $$('.target-chip', app).forEach((el) => (el.innerHTML = targetChip()));
    $$('.theme-note', app).forEach((el) => el.classList.toggle('hidden', p.themeMode !== 'current'));
    $('#session-target').textContent = `${p.scope === 'workspace' ? 'Workspace' : 'User'} settings · ${p.themeMode === 'current' ? p.theme : 'All themes'}`;
  }

  const targetChip = (): string =>
    S.prefs
      ? `<span class="meta-chip">Writes to <b>${S.prefs.scope === 'workspace' ? 'workspace' : 'user'} settings.json</b></span><span class="meta-chip">Colors <b>${S.prefs.themeMode === 'current' ? esc(S.prefs.theme) : 'all themes'}</b></span>`
      : '';

  /** Customized items per page, shown in the rail, the page heads, the session card and the Profiles summary. */
  function updateCounts(): void {
    const set = (sel: string, text: string): void => {
      for (const el of $$(sel, app)) el.textContent = text;
    };
    const totals: SetupCounts = { hotkeys: kbView.counts.changed, appearance: 0, syntax: 0 };
    const appearance = S.appearance;
    if (appearance) {
      for (const area of S.catalog.areas) {
        const items = area.groups.flatMap((g) => g.items).filter((i) => i.kind !== 'note');
        const n = items.filter((i) => (i.kind === 'color' ? Boolean(appearance.colors[i.key]) : i.kind === 'setting' && (appearance.settings[i.key]?.value ?? null) !== null)).length;
        totals.appearance += n;
        set(`[data-count="appearance:${area.id}"]`, n ? String(n) : '');
        if (area.id === S.area) set('[data-changed="appearance"]', `${n} of ${items.length}`);
      }
    }
    const syntax = S.syntax;
    if (syntax) {
      for (const lang of S.catalog.languages) {
        const items = lang.groups.flatMap((g) => g.items);
        const n = items.filter((i) => hasStyle(syntax.items[styleKey(lang.id, i.id)])).length;
        totals.syntax += n;
        set(`[data-count="syntax:${lang.id}"]`, n ? String(n) : '');
        if (lang.id === S.lang) set('[data-changed="syntax"]', `${n} of ${items.length}`);
      }
      const rules = S.custom.filter((c) => c.scope.trim() && hasStyle(c)).length;
      totals.syntax += rules;
      set('[data-count="syntax:custom"]', rules ? String(rules) : '');
      set('[data-changed="custom"]', String(rules));
    }
    set('[data-count="hotkeys"]', totals.hotkeys ? String(totals.hotkeys) : '');
    const total = totals.hotkeys + totals.appearance + totals.syntax;
    $('#session').classList.toggle('live', total > 0);
    $('#session-title').textContent = total ? 'Applied live' : 'Theme defaults';
    $('#session-count').textContent = total ? `${total} customization${total === 1 ? '' : 's'}` : 'Edits apply instantly and can be undone.';
    renderSetup(totals);
  }

  // ---------- appearance ----------

  // VS Code nests only color customizations under "[Theme]"; fonts and sizes are plain settings.
  const themeNote = (area: Area): string =>
    area.groups.some((g) => g.items.some((i) => i.kind === 'setting'))
      ? `<div class="theme-note muted small ${S.prefs?.themeMode === 'current' ? '' : 'hidden'}">Fonts, sizes and other settings here apply to every theme: VS Code keeps only colors per theme.</div>`
      : '';

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
        <div class="desc"><code class="key">${esc(item.key)}</code>${hint ? ` · ${esc(hint)}` : ''}</div>
      </div>
      <div class="row-control">${item.kind === 'color' ? colorControl() : settingControl(item)}</div>
      <button class="icon-btn reset" data-action="reset-item" title="Reset to default">↺</button>
    </div>`;
  }

  // ---------- appearance preview ----------
  // Each preview element names what drives it: data-pv="bg:editor.background fg:editor.foreground".
  // A customized color is used as is, anything else reads the live theme variable, so the preview is the user's real setup.
  // `~:key` only marks the element as where that setting shows up.

  const PV_PROPS: Record<string, string> = {
    bg: 'background-color',
    fg: 'color',
    bc: 'border-color',
    bt: 'border-top-color',
    bb: 'border-bottom-color',
    bl: 'border-left-color',
    br: 'border-right-color',
    ol: 'outline-color',
  };
  const themeVar = (key: string, fallback: string): string => `var(--vscode-${key.replace(/\./g, '-')}${fallback})`;
  const pvTok = (itemId: string, text: string): string => `<span class="pt" data-item="${itemId}">${esc(text)}</span>`;
  interface PvOpts {
    /** What drives the element, e.g. `bg:editor.background fg:editor.foreground`. */
    spec: string;
    cls?: string;
    tag?: 'div' | 'span';
  }
  const pv = ({ spec, cls = '', tag = 'div' }: PvOpts, html: string): string => `<${tag} class="${cls}" data-pv="${spec}">${html}</${tag}>`;

  function editorPreview(): string {
    const ln = (n: number, active = false): string => pv({ spec: active ? 'fg:editorLineNumber.activeForeground' : 'fg:editorLineNumber.foreground', cls: 'pv-ln', tag: 'span' }, String(n));
    const guide = (active = false): string => pv({ spec: active ? 'bl:editorIndentGuide.activeBackground1' : 'bl:editorIndentGuide.background1', cls: 'pv-guide', tag: 'span' }, '  ');
    const lines: readonly string[] = [
      `${pvTok('kw.import', 'import')} { createServer } ${pvTok('kw.import', 'from')} ${pvTok('lit.string', "'node:http'")};`,
      '',
      `${pvTok('kw.decl', 'const')} ${pvTok('id.const', 'PORT')} = ${pvTok('lit.number', '8080')};`,
      '',
      `${pvTok('kw.import', 'export')} ${pvTok('kw.func', 'function')} ${pvTok('fn.decl', 'start')}(${pvTok('id.param', 'name')}: ${pvTok('type.primitive', 'string')}) ${pv({ spec: 'bg:editorBracketMatch.background', cls: 'pv-mark', tag: 'span' }, '{')}`,
      `${guide(true)}${pvTok('kw.decl', 'const')} ${pvTok('id.var', 'server')} = ${pvTok('fn.call', 'createServer')}((req, res) ${pvTok('kw.arrow', '=>')} {${pv({ spec: 'bg:editorCursor.foreground', cls: 'pv-cursor', tag: 'span' }, '')}`,
      `${guide(true)}${guide()}res.${pvTok('fn.call', 'end')}(\`${pv({ spec: 'bg:editor.selectionBackground', cls: 'pv-mark', tag: 'span' }, 'Hello')}, \${${pv({ spec: 'bg:editor.wordHighlightBackground', cls: 'pv-mark', tag: 'span' }, 'name')}}\`);`,
      `${guide(true)}});`,
      `${guide(true)}${pv({ spec: 'fg:editorWhitespace.foreground', cls: 'pv-ws', tag: 'span' }, '··')}${pvTok('cmt', '// listen on the shared port')}`,
      `${guide(true)}${pvTok('id.var', 'server')}.${pvTok('fn.call', 'listen')}(${pv({ spec: 'bg:editor.findMatchBackground', cls: 'pv-mark', tag: 'span' }, 'PORT')});`,
      `${pv({ spec: 'bg:editorBracketMatch.background', cls: 'pv-mark', tag: 'span' }, '}')}`,
    ];
    const CURRENT = 5;
    const body = lines
      .map((html, i) => {
        const cls = i === CURRENT ? 'pv-line pv-current' : 'pv-line';
        const spec = i === CURRENT ? 'bg:editor.lineHighlightBackground ol:editor.lineHighlightBorder ~:editor.renderLineHighlight' : '';
        return `<div class="${cls}" data-pv="${spec}">${html || ' '}</div>`;
      })
      .join('')
      // The other match of the search for PORT.
      .replace(`${pvTok('id.const', 'PORT')}`, pv({ spec: 'bg:editor.findMatchHighlightBackground', cls: 'pv-mark', tag: 'span' }, 'PORT'));
    return pv({ spec: 'bg:editor.background fg:editor.foreground', cls: 'pv pv-editor' }, `${pv({ spec: 'bg:editorGroupHeader.tabsBackground bb:tab.border', cls: 'pv-tabs' }, `${pv({ spec: 'bg:tab.activeBackground fg:tab.activeForeground bt:tab.activeBorderTop br:tab.border', cls: 'pv-tab active' }, 'server.ts')}${pv({ spec: 'bg:tab.inactiveBackground fg:tab.inactiveForeground br:tab.border', cls: 'pv-tab' }, 'routes.ts')}`)}
      <div class="pv-body">
        ${pv({ spec: 'bg:editorGutter.background', cls: 'pv-gutter' }, lines.map((_, i) => ln(i + 1, i === CURRENT)).join(''))}
        ${pv({ spec: '~:editor.fontFamily ~:editor.fontSize ~:editor.fontWeight ~:editor.lineHeight ~:editor.letterSpacing ~:editor.fontLigatures ~:editor.cursorStyle ~:editor.cursorBlinking ~:editor.bracketPairColorization.enabled', cls: 'pv-code' }, body)}
        ${pv({ spec: 'bl:editorRuler.foreground', cls: 'pv-ruler', tag: 'span' }, '')}
        ${pv({ spec: 'bg:minimap.background ~:editor.minimap.enabled', cls: 'pv-minimap' }, '<i></i><i></i><i></i><i></i><i></i><i></i>')}
      </div>
      ${pv({ spec: 'bg:editorSuggestWidget.background ~:editorWidget.background', cls: 'pv-widget' }, `${pv({ spec: 'bg:editorSuggestWidget.selectedBackground', cls: 'pv-suggest active' }, 'createServer')}<div class="pv-suggest">createSecureServer</div>`)}
      ${pv({ spec: 'bg:editorHoverWidget.background', cls: 'pv-hover' }, '<b>function</b> createServer(): Server')}`);
  }

  function sidebarPreview(): string {
    interface TreeNode {
      depth: number;
      label: string;
      spec?: string;
      cls?: string;
      /** The git status letter shown on the right. */
      git?: string;
    }
    const GUIDE = '<span class="pv-tguide" data-pv="bc:tree.indentGuidesStroke ~:workbench.tree.renderIndentGuides ~:workbench.tree.indent"></span>';
    const node = ({ depth, label, spec = '', cls = '', git = '' }: TreeNode): string =>
      `<div class="pv-node d${depth} ${cls}" data-pv="${spec}">${GUIDE.repeat(depth)}<span class="pv-label">${esc(label)}</span>${git ? `<span class="pv-git">${esc(git)}</span>` : ''}</div>`;
    const status = (name: string): string => `fg:gitDecoration.${name}ResourceForeground`;
    const tree = [
      node({ depth: 0, label: '▾ src', cls: 'pv-expanded' }),
      node({ depth: 1, label: '▾ core', cls: 'pv-expanded' }),
      node({ depth: 0, label: '▾ src/core', cls: 'pv-compact', spec: '~:explorer.compactFolders' }),
      node({ depth: 2, label: 'customizations.ts', spec: status('modified'), git: 'M' }),
      node({ depth: 2, label: 'profile.ts', spec: status('untracked'), git: 'U' }),
      node({ depth: 2, label: 'merge.ts', spec: status('conflicting'), git: '!' }),
      node({ depth: 1, label: 'panel.ts', spec: `${status('modified')} bg:list.hoverBackground`, git: 'M' }),
      node({ depth: 0, label: '▾ media' }),
      node({ depth: 1, label: 'main.ts', spec: 'bg:list.activeSelectionBackground fg:list.activeSelectionForeground ol:list.focusOutline ~:list.inactiveSelectionBackground', cls: 'pv-selected' }),
      node({ depth: 1, label: 'theme.css', spec: status('added'), git: 'A' }),
      node({ depth: 0, label: '▸ dist', spec: status('ignored') }),
      node({ depth: 0, label: 'CHANGELOG.md', spec: status('deleted'), cls: 'pv-deleted', git: 'D' }),
    ].join('');
    const act = (glyph: string, spec: string, extra = ''): string => `<span class="pv-act ${extra}" data-pv="${spec}">${glyph}</span>`;
    return pv({ spec: '~:workbench.sideBar.location ~:window.zoomLevel', cls: 'pv pv-workbench' }, `${pv({ spec: 'bg:activityBar.background', cls: 'pv-activity' }, `${act('⧉', 'fg:activityBar.foreground bl:activityBar.activeBorder', 'active')}${act('⌕', 'fg:activityBar.inactiveForeground')}${act('⑂', 'fg:activityBar.inactiveForeground', 'with-badge')}${pv({ spec: 'bg:activityBarBadge.background fg:activityBarBadge.foreground', cls: 'pv-badge', tag: 'span' }, '3')}${act('▷', 'fg:activityBar.inactiveForeground')}`)}
      ${pv({ spec: 'bg:sideBar.background fg:sideBar.foreground br:sideBar.border', cls: 'pv-side' }, `${pv({ spec: 'fg:sideBarTitle.foreground', cls: 'pv-side-title' }, 'EXPLORER')}${pv({ spec: 'bg:sideBarSectionHeader.background fg:sideBarSectionHeader.foreground', cls: 'pv-section' }, '▾ PERSONIFY')}<div class="pv-tree">${tree}</div>`)}
      <div class="pv-editor-stub"></div>`);
  }

  function terminalPreview(): string {
    const a = (color: string, text: string): string => pv({ spec: `fg:terminal.ansi${color}`, tag: 'span' }, esc(text));
    const prompt = `${a('Green', 'you')} ${a('Blue', '~/project')} ${a('Magenta', 'main')} $ `;
    const lines = [
      `${prompt}git status -s`,
      `${a('Yellow', ' M')} src/panel.ts`,
      `${a('Red', ' D')} CHANGELOG.md`,
      `${a('BrightGreen', '??')} src/core/profile.ts`,
      `${prompt}npm test`,
      `${a('BrightBlack', '> personify@0.1.0 test')}`,
      `${a('Green', '  ✔')} parses keybindings.json`,
      `${a('Red', '  ✖')} exports a profile ${a('Cyan', '(3 ≠ 4)')}`,
      `${a('BrightYellow', '  ⚠')} 1 test skipped`,
      `${prompt}${pv({ spec: 'bg:terminal.selectionBackground', cls: 'pv-mark', tag: 'span' }, 'npm run build')}${pv({ spec: 'bg:terminalCursor.foreground fg:terminalCursor.background ~:terminal.integrated.cursorStyle ~:terminal.integrated.cursorBlinking', cls: 'pv-tcursor', tag: 'span' }, ' ')}`,
    ];
    const names = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
    const palette = ['', 'Bright']
      .map((b) => `<div class="pv-palette">${names.map((n) => pv({ spec: `bg:terminal.ansi${b}${n}`, cls: 'pv-chip', tag: 'span' }, '')).join('')}</div>`)
      .join('');
    return pv({ spec: 'bg:panel.background bt:panel.border', cls: 'pv pv-panel' }, `<div class="pv-ptabs">${pv({ spec: 'fg:panelTitle.inactiveForeground', cls: 'pv-ptab', tag: 'span' }, 'PROBLEMS')}${pv({ spec: 'fg:panelTitle.inactiveForeground', cls: 'pv-ptab', tag: 'span' }, 'OUTPUT')}${pv({ spec: 'fg:panelTitle.activeForeground bb:panelTitle.activeBorder', cls: 'pv-ptab active', tag: 'span' }, 'TERMINAL')}</div>
      <div class="pv-term-wrap">
        ${pv({ spec: 'bg:terminal.background fg:terminal.foreground ~:terminal.integrated.fontFamily ~:terminal.integrated.fontSize ~:terminal.integrated.fontWeight ~:terminal.integrated.fontWeightBold ~:terminal.integrated.lineHeight ~:terminal.integrated.letterSpacing ~:terminal.integrated.minimumContrastRatio', cls: 'pv-term' }, `${lines.map((l) => `<div class="pv-tline">${l}</div>`).join('')}${palette}`)}
        ${pv({ spec: 'bg:terminal.background fg:terminal.foreground bl:terminal.border', cls: 'pv-term pv-split' }, `<div class="pv-tline">${a('BrightBlack', 'zsh')}</div>`)}
      </div>
      ${pv({ spec: 'bg:statusBar.background fg:statusBar.foreground', cls: 'pv-status' }, '⎇ main  ✖ 1  ⚠ 1')}`);
  }

  const PREVIEWS: Record<string, () => string> = { editor: editorPreview, sidebar: sidebarPreview, terminal: terminalPreview };

  /** The effective value of a setting: what is set here, else what applies, else the default. */
  function settingNow(key: string): SettingValue | null {
    const st = S.appearance?.settings[key];
    return st ? (st.value ?? st.effective ?? st.def) : null;
  }

  function applyFont(el: HTMLElement, prefix: 'editor' | 'terminal.integrated'): void {
    const fallback = (key: string): SettingValue | null => settingNow(`${prefix}.${key}`) ?? (prefix === 'terminal.integrated' ? settingNow(`editor.${key}`) : null);
    const family = fallback('fontFamily');
    const size = Number(fallback('fontSize')) || 13;
    const lh = Number(settingNow(`${prefix}.lineHeight`)) || 0;
    // The editor takes pixels (0 = automatic, under 8 = a factor); the terminal takes a factor.
    const lineHeight = prefix === 'editor' ? (lh === 0 ? '1.5' : lh < 8 ? String(lh) : `${lh}px`) : String(lh || 1.2);
    el.style.fontFamily = family ? String(family) : '';
    el.style.fontSize = `${size}px`;
    el.style.lineHeight = lineHeight;
    el.style.letterSpacing = `${Number(settingNow(`${prefix}.letterSpacing`)) || 0}px`;
    el.style.fontWeight = String(settingNow(`${prefix}.fontWeight`) ?? 'normal');
    if (prefix === 'editor') el.style.fontVariantLigatures = settingNow('editor.fontLigatures') === true ? 'normal' : 'none';
  }

  function syncPreview(): void {
    const root = $opt('#tab-appearance .pv');
    const state = S.appearance;
    if (!root || !state) return;
    for (const el of [root, ...$$<HTMLElement>('[data-pv]', root)]) {
      for (const part of (el.dataset.pv ?? '').split(/\s+/)) {
        const [kind, key] = part.split(':');
        const prop = kind ? PV_PROPS[kind] : undefined;
        if (!prop || !key) continue;
        // Borders and outlines must not fall back to the text color when the theme leaves them unset.
        el.style.setProperty(prop, state.colors[key] ?? themeVar(key, kind === 'fg' ? '' : ', transparent'));
      }
    }
    const code = $opt('.pv-code', root);
    if (code) {
      // Line numbers share the editor font, so they stay level with their lines.
      applyFont($('.pv-body', root), 'editor');
      root.classList.toggle('cursor-block', String(settingNow('editor.cursorStyle')).startsWith('block'));
      root.classList.toggle('cursor-underline', String(settingNow('editor.cursorStyle')).startsWith('underline'));
      root.dataset.lineHighlight = String(settingNow('editor.renderLineHighlight') ?? 'line');
      root.classList.toggle('no-minimap', settingNow('editor.minimap.enabled') === false);
      const items = S.syntax?.items ?? {};
      for (const span of $$('.pt', code)) span.style.cssText = cssFor(items[styleKey('jsts', span.dataset.item ?? '')]);
    }
    const term = $$('.pv-term', root);
    for (const t of term) applyFont(t, 'terminal.integrated');
    if (term.length) root.classList.toggle('cursor-line', String(settingNow('terminal.integrated.cursorStyle')) === 'line');
    if (term.length) root.classList.toggle('cursor-underline', String(settingNow('terminal.integrated.cursorStyle')) === 'underline');
    if ($opt('.pv-tree', root)) {
      root.style.setProperty('--pv-indent', `${Number(settingNow('workbench.tree.indent')) || 8}px`);
      root.dataset.guides = String(settingNow('workbench.tree.renderIndentGuides') ?? 'onHover');
      root.classList.toggle('compact', settingNow('explorer.compactFolders') !== false);
      root.classList.toggle('side-right', settingNow('workbench.sideBar.location') === 'right');
    }
  }

  /** What changed in the open area, with where it came from. */
  function renderChanges(): void {
    const box = $opt('#pv-changes');
    const area = S.catalog.areas.find((a) => a.id === S.area);
    const state = S.appearance;
    if (!box || !area || !state) return;
    const shown = (v: SettingValue | null): string => (v === null || v === '' ? 'default' : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));
    const rows = area.groups
      .flatMap((g) => g.items)
      .flatMap((item) => {
        if (item.kind === 'color') {
          const value = state.colors[item.key];
          if (!value) return [];
          return [`<div class="change" data-key="${esc(item.key)}"><span class="change-label">${esc(item.label)}</span><span class="change-value"><span class="muted">theme</span> → <span class="mini-swatch" data-swatch="${esc(value)}"></span><code>${esc(value)}</code></span><button class="icon-btn" data-action="reset-key" data-kind="color" data-key="${esc(item.key)}" title="Back to the theme color">↺</button></div>`];
        }
        if (item.kind !== 'setting') return [];
        const st = state.settings[item.key];
        if (!st || st.value === null) return [];
        return [`<div class="change" data-key="${esc(item.key)}"><span class="change-label">${esc(item.label)}</span><span class="change-value"><span class="muted">${esc(shown(st.def))}</span> → <code>${esc(shown(st.value))}${item.type === 'number' && item.unit ? ` ${esc(item.unit)}` : ''}</code></span><button class="icon-btn" data-action="reset-key" data-kind="setting" data-key="${esc(item.key)}" title="Back to the default">↺</button></div>`];
      });
    $('#pv-changes-count').textContent = String(rows.length);
    box.innerHTML = rows.length ? rows.join('') : '<div class="change-empty">Nothing changed here yet. Every edit applies instantly and shows up here, ready to undo.</div>';
    for (const sw of $$('.mini-swatch', box)) sw.style.background = sw.dataset.swatch ?? '';
  }

  /** Outlines where a setting shows up in the preview, and says so under it. */
  function highlightPreview(key: string): void {
    const root = $opt('#tab-appearance .pv');
    if (!root) return;
    let hits = 0;
    for (const el of [root, ...$$('[data-pv]', root)]) {
      const on = Boolean(key) && (el.dataset.pv ?? '').split(/\s+/).some((p) => p.endsWith(`:${key}`));
      el.classList.toggle('pv-hl', on && el !== root);
      if (on) hits++;
    }
    const item = S.catalog.areas.flatMap((a) => a.groups.flatMap((g) => g.items)).find((i) => i.kind !== 'note' && i.key === key);
    const label = item && item.kind !== 'note' ? item.label : '';
    $('#pv-caption').innerHTML = !key
      ? 'Hover a setting to see where it lands. Click the preview to find its setting.'
      : hits
        ? `<b>${esc(label)}</b> · <code class="key">${esc(key)}</code>`
        : `<b>${esc(label)}</b> is not shown in the preview.`;
  }

  function renderAppearance(): void {
    const areas = S.catalog.areas;
    const area = areas.find((a) => a.id === S.area) ?? areas[0];
    if (!area) return;
    S.area = area.id;
    $('#tab-appearance').innerHTML = `
      <div class="content">
        <div class="content-head">
          <div>
            <h2>${esc(area.title)}</h2><p>${esc(area.desc)}</p>
            <div class="chip-row"><span class="target-chip">${targetChip()}</span><span class="meta-chip">Changed <b data-changed="appearance"></b></span></div>
            ${themeNote(area)}
          </div>
          <div class="actions">
            <button class="btn secondary" data-action="open-settings-json">Open settings.json</button>
            <button class="btn ghost" data-action="reset-area">Reset ${esc(area.title.toLowerCase())}</button>
          </div>
        </div>
        <div class="toolbar">
          <input type="search" class="search" data-filter="appearance" placeholder="Filter ${esc(area.title.toLowerCase())} settings…" value="${esc(S.filters.appearance)}">
          <div class="jump">${area.groups.map((g, i) => `<button class="chip" data-jump="${i}">${esc(g.title)}</button>`).join('')}</div>
        </div>
        <div class="appearance-layout">
          <div class="settings-col">
            ${area.groups.map((g, i) => `<section class="card" data-group="${i}"><h3>${esc(g.title)}<small data-group-count></small></h3><div class="rows">${g.items.map(appearanceRow).join('')}</div></section>`).join('')}
            <div class="empty-state hidden">Nothing matches this filter.</div>
          </div>
          <aside class="preview-col">
            <details class="pv-card" open>
              <summary><b>Live preview</b><span class="muted">Your theme plus your changes</span></summary>
              ${PREVIEWS[area.id]?.() ?? ''}
              <div class="pv-caption" id="pv-caption"></div>
            </details>
            <section class="card changes-card">
              <h3>Changed in ${esc(area.title)}<small id="pv-changes-count"></small></h3>
              <div id="pv-changes"></div>
            </section>
          </aside>
        </div>
      </div>`;
    highlightPreview('');
    applyFilter('appearance');
    syncAppearance();
  }

  function syncAppearance(): void {
    if (!S.appearance || !$opt('#tab-appearance .content')) return;
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
    for (const card of $$('#tab-appearance .settings-col .card')) {
      const rows = $$('.row', card);
      const n = rows.filter((r) => r.classList.contains('modified')).length;
      $('[data-group-count]', card).textContent = n ? `${n} of ${rows.length} changed` : String(rows.length);
    }
    syncPreview();
    renderChanges();
    updateCounts();
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
    // Hovering or focusing a setting outlines where it shows up in the preview.
    const onPoint = (e: Event): void => {
      const key = targetOf(e)?.closest<HTMLElement>('.row[data-key], .change[data-key]')?.dataset.key ?? '';
      if (root.dataset.hover === key) return;
      root.dataset.hover = key;
      highlightPreview(key);
    };
    root.addEventListener('mouseover', onPoint);
    root.addEventListener('focusin', onPoint);
    root.addEventListener('click', (e) => {
      const t = targetOf(e);
      if (!t) return;
      const jump = t.closest<HTMLElement>('[data-jump]');
      if (jump) {
        $opt(`#tab-appearance .card[data-group="${jump.dataset.jump ?? ''}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      const resetKey = t.closest<HTMLElement>('[data-action="reset-key"]');
      if (resetKey) {
        const key = resetKey.dataset.key ?? '';
        return resetKey.dataset.kind === 'color' ? setColor(key, null) : setSetting(key, null, 0);
      }
      // A click in the preview finds the setting behind it.
      const shown = t.closest<HTMLElement>('.pv [data-pv], .change[data-key]');
      if (shown) {
        const key = shown.dataset.key ?? (shown.dataset.pv ?? '').split(/\s+/).find((p) => p.includes(':'))?.split(':')[1];
        const row = key ? $opt(`#tab-appearance .row[data-key="${key}"]`) : null;
        if (!row) return;
        if (row.classList.contains('hidden')) {
          S.filters.appearance = '';
          $<HTMLInputElement>('#tab-appearance [data-filter]').value = '';
          applyFilter('appearance');
        }
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(row);
        return;
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
    // A queued write would land after the reset and bring the value back, so it is dropped and its key reset too.
    for (const item of area.groups.flatMap((g) => g.items)) {
      if (item.kind === 'color') {
        if (cancelPending(`c:${item.key}`) || state.colors[item.key]) colors[item.key] = null;
        delete state.colors[item.key];
      } else if (item.kind === 'setting') {
        const st = state.settings[item.key];
        if (cancelPending(`s:${item.key}`) || (st && st.value !== null)) settings[item.key] = null;
        if (st) st.value = null;
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
    for (const card of $$('.card', root).filter((c) => !c.classList.contains('changes-card'))) {
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
  // The same test as hasStyle in src/core/customizations.ts.
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
    const labels = new Map(lang.groups.flatMap((g) => g.items.map((i) => [i.id, i.label] as const)));
    return lang.sample
      .map((line) => {
        const html = line.replace(/⟦([^¦]*)¦([^⟧]*)⟧|([^⟦]+)/g, (_: string, id: string | undefined, text: string | undefined, plain: string | undefined) =>
          plain !== undefined ? esc(plain) : `<span class="tok" data-item="${esc(id ?? '')}" title="${esc(labels.get(id ?? '') ?? '')} · click to style">${esc(text ?? '')}</span>`
        );
        return `<div class="pl">${html || ' '}</div>`;
      })
      .join('');
  }

  // ---------- token popover ----------

  const PRESETS = ['#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#7dcfff', '#ff9e64', '#c0caf5'];

  /** Colors the user already picked come first, so their palette stays consistent. */
  function presetColors(): string[] {
    const used = [...Object.values(S.syntax?.items ?? {}).map((s) => s.fg), ...S.custom.map((c) => c.fg)].flatMap((c) => (c && HEX_RE.test(c) ? [c.toLowerCase()] : []));
    return [...new Set([...used, ...PRESETS])].slice(0, 10);
  }

  /** Styles one kind of token right where it is clicked in the sample. */
  function openTokenPopover(tok: HTMLElement): void {
    closeTokenPopover();
    const lang = currentLang();
    const id = tok.dataset.item ?? '';
    const item = lang?.groups.flatMap((g) => g.items).find((i) => i.id === id);
    const wrap = tok.closest<HTMLElement>('.preview-wrap');
    if (!lang || !item || !wrap) return;
    const count = $$(`.tok[data-item="${id}"]`, wrap).length;
    const pop = document.createElement('div');
    pop.className = 'tok-pop';
    pop.id = 'tok-pop';
    pop.dataset.item = id;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Style of ${item.label}`);
    pop.innerHTML = `
      <div class="tp-head">
        <div class="tp-title"><b>${esc(item.label)}</b><code class="key">${esc(item.scopes.join(' · ') || item.semantic.join(' · '))}</code></div>
        <button class="icon-btn" data-tp="close" title="Close (Esc)">×</button>
      </div>
      <div class="tp-presets">${presetColors().map((c) => `<button class="tp-preset" data-color="${c}" title="${c}" aria-label="${c}"></button>`).join('')}</div>
      <div class="tp-row">${colorControl()}${styleToggles()}</div>
      <div class="tp-foot">
        <span class="muted small">${count} in sample</span>
        <span class="tp-actions"><button class="btn ghost" data-tp="list">Show in list</button><button class="btn ghost" data-tp="reset">Reset</button><button class="btn" data-tp="close">Done</button></span>
      </div>`;
    wrap.appendChild(pop);
    for (const b of $$('.tp-preset', pop)) b.style.background = b.dataset.color ?? '';
    // Under the token, kept inside the preview column.
    const box = wrap.getBoundingClientRect();
    const at = tok.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(at.left - box.left - 16, box.width - pop.offsetWidth - 8))}px`;
    pop.style.top = `${at.bottom - box.top + 8}px`;
    $$('.tok', wrap).forEach((s) => s.classList.toggle('hl', s.dataset.item === id));
    syncSyntax();
    $opt<HTMLElement>('.tp-preset', pop)?.focus();
  }

  function closeTokenPopover(): void {
    const pop = $opt('#tok-pop');
    if (!pop) return;
    pop.remove();
    $$('#tab-syntax .tok.hl').forEach((s) => s.classList.remove('hl'));
  }

  /** Scrolls the token list to a token's row and flashes it. */
  function showTokenRow(itemId: string): void {
    const row = $opt(`#tab-syntax .token-row[data-item="${itemId}"]`);
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
    const lang = currentLang();
    const content = S.lang === 'custom' ? customHtml() : lang ? languageHtml(lang) : '';
    $('#tab-syntax').innerHTML = `<div class="content">${content}</div>`;
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
        <div>
          <h2>${esc(lang.title)}</h2><p>Click a token in the code to find its setting. Unset tokens keep your theme's colors.</p>
          <div class="chip-row"><span class="meta-chip">Writes to <b>editor.tokenColorCustomizations</b></span><span class="meta-chip">Changed <b data-changed="syntax"></b></span></div>
        </div>
        <div class="actions">
          <button class="btn secondary" data-action="open-sample">Open sample in editor</button>
          <button class="btn secondary" data-action="inspect">⌖ Inspect token</button>
          <button class="btn ghost" data-action="reset-lang">Reset ${esc(lang.short)}</button>
        </div>
      </div>
      ${semanticBar()}
      <div class="syntax-layout">
        <div class="preview-wrap">
          <div class="preview-head"><b>${esc(lang.short)} sample</b><span class="muted">Dimmed tokens keep your theme's colors</span></div>
          <div class="preview"><pre>${previewHtml(lang)}</pre></div>
        </div>
        <div class="token-list">
          <input type="search" class="search" data-filter="syntax" placeholder="Filter tokens (e.g. string, async, scope)…" value="${esc(S.filters.syntax)}">
          ${groups}
          <div class="empty-state hidden">No tokens match this filter.</div>
        </div>
      </div>`;
  }

  function customHtml(): string {
    return `
      <div class="content-head">
        <div>
          <h2>Custom scopes</h2><p>Style any TextMate scope, in any language. The inspector shows the scopes of the token under your cursor.</p>
          <div class="chip-row"><span class="meta-chip">Writes to <b>editor.tokenColorCustomizations › textMateRules</b></span><span class="meta-chip">Rules <b data-changed="custom"></b></span></div>
        </div>
        <div class="actions">
          <button class="btn secondary" data-action="inspect">⌖ Inspect token</button>
          <button class="btn" data-action="add-custom">+ Add rule</button>
        </div>
      </div>
      <section class="card"><h3>Rules</h3><div class="rows" id="custom-rows"></div></section>
      <section class="card help">
        <h3>How scopes match</h3>
        <ul class="scope-help">
          <li><span class="scope-chip">comment</span> every comment, in any language</li>
          <li><span class="scope-chip">comment</span><span class="scope-chip">string</span> written <code>comment, string</code>: a comma means “or”</li>
          <li><span class="scope-chip">source.go<i> › </i>comment</span> written <code>source.go comment</code>: a space means “inside”, here comments in Go files only</li>
        </ul>
        <h3>How to find a scope</h3>
        <ol>
          <li>Put the cursor on a token in any file and click <b>⌖ Inspect token</b>: VS Code opens its scope inspector.</li>
          <li>Copy a line from its <b>textmate scopes</b> list, e.g. <code>keyword.control.flow.ts</code>, and paste it here.</li>
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
              <div class="row-label">
                <input type="text" class="text scope-input" list="scope-list" placeholder="e.g. source.go comment, markup.heading" spellcheck="false" value="${esc(c.scope)}" aria-label="TextMate scopes">
                <div class="scope-line"><span class="scope-chips"></span><span class="scope-hint"></span></div>
              </div>
              <div class="row-control">${colorControl()}${styleToggles()}</div>
              <button class="icon-btn reset" data-action="delete-custom" title="Delete rule">✕</button>
            </div>`
          )
          .join('')
      : `<div class="empty-state">
          <div class="empty-title">No custom rules yet</div>
          <div class="actions center"><button class="btn" data-action="add-custom">+ Add rule</button><button class="btn secondary" data-action="inspect">⌖ Inspect a token first</button></div>
        </div>`;
    syncCustom();
  }

  /** A rule's scopes as chips: a comma starts another scope, a space means "inside". */
  const scopeChips = (scope: string): string =>
    scope
      .split(',')
      .map((s) => s.trim().split(/\s+/).filter(Boolean))
      .filter((parts) => parts.length)
      .map((parts) => `<span class="scope-chip">${parts.map(esc).join('<i> › </i>')}</span>`)
      .join('');

  function syncCustom(): void {
    for (const row of $$('#custom-rows .custom-row')) {
      const c = S.custom.find((x) => x.id === row.dataset.id);
      if (!c) continue;
      setColorCtl($opt('.color-ctl', row), c.fg);
      syncStyleButtons(row, c.fontStyle);
      row.classList.toggle('modified', hasStyle(c));
      row.classList.toggle('incomplete', !c.scope.trim() || !hasStyle(c));
      $('.scope-chips', row).innerHTML = scopeChips(c.scope);
      // Rules without a scope or a style are not written, so say which part is missing.
      $('.scope-hint', row).textContent = !c.scope.trim() ? 'Type a scope, or pick one from the list' : !hasStyle(c) ? 'Pick a color or a style to save this rule' : '';
    }
  }

  function syncSyntax(): void {
    if (!S.syntax || !$opt('#tab-syntax .content')) return;
    const items = S.syntax.items;
    updateCounts();
    // The editor preview on the Appearance page colors its code with these rules.
    syncPreview();

    const sem = $opt('#tab-syntax [data-semantic]');
    if (sem) {
      const { value, effective } = S.syntax.semanticHighlighting;
      const val = value === null ? '' : String(value);
      $$('button', sem).forEach((b) => b.classList.toggle('active', b.dataset.val === val));
      $('[data-val=""]', sem).textContent = `Default (${effective === null ? 'theme' : effective ? 'on' : 'off'})`;
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
      $('[data-group-count]', card).textContent = n ? `${n} of ${rows.length} changed` : String(rows.length);
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
    const pop = $opt('#tok-pop');
    if (pop) {
      const st = items[styleKey(lang.id, pop.dataset.item ?? '')];
      setColorCtl($opt('.color-ctl', pop), st?.fg ?? null);
      syncStyleButtons(pop, st?.fontStyle ?? null);
      const fg = (st?.fg ?? '').toLowerCase();
      $$('.tp-preset', pop).forEach((b) => b.classList.toggle('active', b.dataset.color === fg));
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
      const pop = ctl.closest<HTMLElement>('#tok-pop');
      if (pop) return setTokenStyle(pop.dataset.item ?? '', { fg: value || null });
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
      const semBtn = t.closest<HTMLElement>('[data-semantic] button');
      if (semBtn) {
        if (!S.syntax) return;
        const v = semBtn.dataset.val;
        const value = v === '' ? null : v === 'true';
        S.syntax.semanticHighlighting.value = value;
        if (value !== null) S.syntax.semanticHighlighting.effective = value;
        syncSyntax();
        return send({ type: 'setSemanticHighlighting', value });
      }
      const styleBtn = t.closest<HTMLElement>('.style-btn');
      if (styleBtn) {
        const row = styleBtn.closest<HTMLElement>('.row, #tok-pop');
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
      if (tok) return openTokenPopover(tok);
      const pop = t.closest<HTMLElement>('#tok-pop');
      if (pop) {
        const itemId = pop.dataset.item ?? '';
        const preset = t.closest<HTMLElement>('.tp-preset');
        if (preset) return setTokenStyle(itemId, { fg: preset.dataset.color ?? null });
        switch (t.closest<HTMLElement>('[data-tp]')?.dataset.tp) {
          case 'close':
            return closeTokenPopover();
          case 'reset':
            return setTokenStyle(itemId, null);
          case 'list':
            closeTokenPopover();
            return showTokenRow(itemId);
        }
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
            .filter((i) => {
              const key = styleKey(lang.id, i.id);
              const pending = cancelPending(`t:${key}`);
              return pending || hasStyle(syntax.items[key]);
            })
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
    // An open popover keeps its own tokens highlighted.
    root.addEventListener('mouseover', (e) => {
      const row = targetOf(e)?.closest<HTMLElement>('.token-row');
      const id = row?.dataset.item ?? $opt('#tok-pop')?.dataset.item ?? '';
      if (root.dataset.hover === id) return;
      root.dataset.hover = id;
      $$('.tok', root).forEach((s) => s.classList.toggle('hl', s.dataset.item === id));
    });
    // The popover closes on Esc or a click anywhere outside it (a click on another token opens that one).
    document.addEventListener('mousedown', (e) => {
      const t = targetOf(e);
      if ($opt('#tok-pop') && !t?.closest('#tok-pop, .tok')) closeTokenPopover();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $opt('#tok-pop')) closeTokenPopover();
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

  const commandRow = (command: string, title: string): CommandRow => ({ source: 'unbound', id: `c:${command}`, command, title, key: '', when: '', args: undefined });

  let kbView: { rows: ViewRow[]; bound: Set<string>; withDefault: Set<string>; counts: Record<KbFilter, number> } = {
    rows: [],
    bound: new Set(),
    withDefault: new Set(),
    counts: { all: 0, changed: 0, conflicts: 0, removed: 0, unbound: 0 },
  };

  let cmdListHtml = '';

  function computeKb(kb: KeybindingsState): void {
    const rows = kb.rows
      .map((r): ViewRow => ({ ...r, nk: normKey(r.key), removed: r.removalIndex !== null, conflicts: [] }))
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
    // Thousands of options: rebuilt only when the commands change, not on every edit.
    const options = kb.commands.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
    if (options !== cmdListHtml) {
      cmdListHtml = options;
      $('#cmd-list').innerHTML = options;
    }
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

  // ---------- recording a shortcut (the row editor and the Add dialog) ----------

  type RecordStep = { kind: 'stop' } | { kind: 'clear' } | { kind: 'key'; key: string } | { kind: 'none' };

  /** What a key press means while a shortcut is being recorded: plain Esc stops, plain Backspace clears. */
  function recordStep(e: KeyboardEvent): RecordStep {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (plain && e.key === 'Escape') return { kind: 'stop' };
    if (plain && e.key === 'Backspace') return { kind: 'clear' };
    const key = keyFromEvent(e);
    return key ? { kind: 'key', key } : { kind: 'none' };
  }

  /** The chords after a key press: a fresh recording or a finished two-step chord starts over. */
  const addChord = (chords: readonly string[], key: string, fresh: boolean): string[] => (fresh || chords.length >= 2 ? [key] : [...chords, key]);

  /** Active shortcuts of other commands on the same keys. */
  function sameKeys(key: string, command: string, self: ListRow | null): ViewRow[] {
    if (!key) return [];
    const nk = normKey(key);
    return kbView.rows.filter((r) => !r.removed && r.nk === nk && r.command !== command && r !== self);
  }

  const alsoRuns = (others: readonly ViewRow[]): string =>
    others.length
      ? `⚠ Also runs ${others
          .slice(0, 2)
          .map((o) => `<b>${esc(o.title)}</b>${o.when ? ` <span class="muted">(when ${esc(o.when)})</span>` : ''}`)
          .join(', ')}${others.length > 2 ? ` and ${others.length - 2} more` : ''}`
      : '';

  // ---------- rows ----------

  function badgeFor(r: ListRow): string {
    if (r.source === 'unbound') return '<span class="badge">No shortcut</span>';
    if (r.removed) return '<span class="badge badge-removed">Removed</span>';
    return r.source === 'user' ? '<span class="badge badge-user">Yours</span>' : '<span class="badge">Default</span>';
  }

  /** A row whose shortcut can be changed in place. */
  const editable = (r: ListRow): boolean => r.source === 'unbound' || !r.removed;

  function kbRowHtml(r: ListRow): string {
    if (S.kbEdit?.rowId === r.id) return kbEditHtml(r, S.kbEdit);
    const btn = (action: string, label: string, title: string, cls = ''): string => `<button class="icon-btn ${cls}" data-kb="${action}" data-id="${esc(r.id)}" title="${esc(title)}">${label}</button>`;
    let actions: string;
    if (r.source === 'unbound') {
      actions = btn('edit', '+ Assign', 'Assign a shortcut', 'text-btn');
    } else if (r.removed) {
      actions =
        r.source === 'user'
          ? btn('restore', '↺ Restore', 'Delete the entry that switches this shortcut off', 'text-btn') + btn('remove', '🗑', 'Delete this shortcut')
          : btn('restore', '↺ Restore', 'Bring this default shortcut back', 'text-btn');
    } else if (r.source === 'user') {
      actions = btn('edit', '✎', 'Change shortcut') + btn('add', '＋', 'Add another shortcut for this command') + btn('remove', '🗑', 'Delete this shortcut') + (kbView.withDefault.has(r.command) ? btn('reset', '↺', 'Reset command to defaults') : '');
    } else {
      actions = btn('edit', '✎', 'Change shortcut') + btn('add', '＋', 'Add another shortcut for this command') + btn('remove', '⊘', 'Remove this default shortcut');
    }
    const conflicts = r.source === 'unbound' ? [] : r.conflicts;
    const removed = r.source !== 'unbound' && r.removed;
    const key = editable(r) && r.source !== 'unbound' ? `<button class="kb-keys" data-kb="edit" data-id="${esc(r.id)}" title="Click to change">${keyHtml(r.key)}</button>` : keyHtml(r.key);
    return `<div class="kb-row ${removed ? 'removed' : ''} ${r.source === 'user' ? 'user' : ''}">
      <div class="kb-cmd"><div class="kb-title">${esc(r.title)}</div><div class="kb-id">${esc(r.command)}</div></div>
      <div class="kb-key">${key}${conflicts.length ? `<div class="conflict">${alsoRuns(conflicts)}</div>` : ''}</div>
      <div class="kb-when">${r.when ? `<code>${esc(r.when)}</code>` : '<span class="muted">everywhere</span>'}</div>
      <div class="kb-src">${badgeFor(r)}</div>
      <div class="kb-actions">${actions}</div>
    </div>`;
  }

  /** The row while its shortcut is recorded: keys, when, Cancel and Save. */
  function kbEditHtml(r: ListRow, edit: KbEdit): string {
    return `<div class="kb-row editing" data-edit="${esc(r.id)}">
      <div class="kb-cmd"><div class="kb-title">${esc(r.title)}</div><div class="kb-id">${esc(r.command)}</div></div>
      <div class="kb-key">
        <div class="recorder inline recording" tabindex="0" id="kb-rec" aria-label="Press the new shortcut"><span class="rec-keys"></span><span class="rec-hint">press a key…</span><span class="rec-help">Esc cancels · ⌫ clears</span></div>
        <div class="conflict" id="kb-rec-conflicts"></div>
      </div>
      <div class="kb-when"><input type="text" class="text" id="kb-rec-when" list="when-list" placeholder="everywhere" spellcheck="false" value="${esc(edit.when)}" aria-label="When"></div>
      <div class="kb-src">${badgeFor(r)}</div>
      <div class="kb-actions"><button class="btn ghost" data-kb-edit="cancel">Cancel</button><button class="btn" data-kb-edit="save">Save</button></div>
    </div>`;
  }

  /** Shows the recorded keys and their conflicts without re-rendering the table. */
  function syncEdit(): void {
    const edit = S.kbEdit;
    const box = $opt('#kb-rec');
    if (!edit || !box) return;
    const key = edit.chords.join(' ');
    $('.rec-keys', box).innerHTML = key ? keyHtml(key) : '';
    box.classList.toggle('has-keys', Boolean(key));
    const row = findKbRow(edit.rowId) ?? null;
    $('#kb-rec-conflicts').innerHTML = row ? alsoRuns(sameKeys(key, row.command, row)) : '';
  }

  function startEdit(row: ListRow): void {
    flushEditWhen();
    S.kbEdit = { rowId: row.id, chords: row.key ? row.key.trim().split(/\s+/) : [], when: row.when, fresh: true };
    renderKbRows();
    $opt('#kb-rec')?.focus();
  }

  /** Keeps what was typed in the when field of the row being edited. */
  function flushEditWhen(): void {
    const input = $opt<HTMLInputElement>('#kb-rec-when');
    if (S.kbEdit && input && input.closest<HTMLElement>('[data-edit]')?.dataset.edit === S.kbEdit.rowId) S.kbEdit.when = input.value;
  }

  function endEdit(): void {
    S.kbEdit = null;
    renderKbRows();
  }

  function saveEdit(): void {
    flushEditWhen();
    const edit = S.kbEdit;
    const row = edit ? findKbRow(edit.rowId) : undefined;
    if (!edit || !row) return endEdit();
    const key = edit.chords.join(' ');
    const when = edit.when.trim();
    if (!key) return toast('Press the new shortcut first', 'error');
    // The host confirms the save, or reports why it failed.
    if (row.source === 'unbound') kbOp({ op: 'add', command: row.command, key, when, args: undefined });
    else if (row.source === 'user') kbOp({ op: 'update', index: row.index, command: row.command, key, when });
    else if (key !== row.key || when !== row.when) kbOp({ op: 'replaceDefault', command: row.command, oldKey: row.key, oldWhen: row.when, key, when, args: row.args });
    else toast('Nothing changed');
    endEdit();
  }

  function renderHotkeysShell(): void {
    $('#tab-hotkeys').innerHTML = `
      <div class="content wide">
        <div class="content-head">
          <div><h2>Keyboard shortcuts</h2><p id="kb-file" class="muted"></p></div>
          <div class="actions">
            <button class="btn secondary" data-kbtool="json">Open keybindings.json</button>
            <button class="btn secondary" data-kbtool="refresh" title="Reload the list (e.g. after installing an extension)">Reload</button>
            <button class="btn" data-kbtool="add">+ Add shortcut</button>
          </div>
        </div>
        <div id="kb-error" class="banner error hidden"></div>
        <div class="kb-toolbar">
          <div class="search-wrap">
            <input type="search" id="kb-search" class="search" placeholder="Search command, key (cmd+p) or when…" value="${esc(S.kbQuery)}">
            <button class="record-btn ${S.kbRecordSearch ? 'active' : ''}" id="kb-record-search" title="Press keys to search by shortcut"><span class="rec-dot"></span>Record keys</button>
          </div>
          <div class="chips">${KB_FILTERS.map(([id, label]) => `<button class="chip ${S.kbFilter === id ? 'active' : ''}" data-filter-kb="${id}">${label} <span data-kbcount="${id}"></span></button>`).join('')}</div>
        </div>
        <div id="kb-conflicts" class="banner warn conflicts-banner hidden"></div>
        <div class="kb-table">
          <div class="kb-row kb-head"><div>Command</div><div>Shortcut</div><div>When</div><div>Source</div><div></div></div>
          <div id="kb-body"><div class="empty-state">Loading shortcuts…</div></div>
        </div>
        <div class="kb-foot"><span class="muted small" id="kb-shown"></span><div class="kb-more"></div><span class="muted small">Click a shortcut to change it.</span></div>
      </div>`;
  }

  function renderKbRows(): void {
    if (!S.kb) return;
    const list = kbFiltered(S.kb);
    const shown = list.slice(0, S.kbLimit);
    // An edit whose row is gone (filtered out, or the file changed under it) is dropped.
    if (S.kbEdit && !shown.some((r) => r.id === S.kbEdit?.rowId)) S.kbEdit = null;
    const whenFocused = document.activeElement?.id === 'kb-rec-when';
    flushEditWhen();
    $('#kb-body').innerHTML = shown.length ? shown.map(kbRowHtml).join('') : '<div class="empty-state">No shortcuts match.</div>';
    if (S.kbEdit) {
      syncEdit();
      $opt(whenFocused ? '#kb-rec-when' : '#kb-rec')?.focus();
    }
    const more = list.length - shown.length;
    $('#tab-hotkeys .kb-more').innerHTML = more > 0 ? `<button class="btn secondary" data-kbtool="more">Show ${Math.min(more, 200)} more</button>` : '';
    $('#kb-shown').textContent = `Showing ${shown.length} of ${list.length}`;
    const conflicts = kbView.counts.conflicts;
    const banner = $('#kb-conflicts');
    banner.classList.toggle('hidden', !conflicts || S.kbFilter === 'conflicts');
    banner.innerHTML = conflicts
      ? `<span>⚠ <b>${conflicts} shortcut${conflicts === 1 ? '' : 's'} share${conflicts === 1 ? 's' : ''} keys with another command in an overlapping context.</b> <span class="muted">Only one of them runs.</span></span><button class="link-btn" data-filter-kb="conflicts">Show conflicts →</button>`
      : '';
    for (const [id, n] of Object.entries(kbView.counts)) {
      const el = $opt(`[data-kbcount="${id}"]`);
      if (el) el.textContent = String(n);
    }
    $$('#tab-hotkeys .chip').forEach((c) => c.classList.toggle('active', c.dataset.filterKb === S.kbFilter));
    updateCounts();
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
      const edit = S.kbEdit;
      if (edit && t instanceof HTMLElement && t.id === 'kb-rec') {
        const step = recordStep(e);
        if (step.kind === 'none') return;
        e.preventDefault();
        e.stopPropagation();
        if (step.kind === 'stop') return endEdit();
        edit.chords = step.kind === 'clear' ? [] : addChord(edit.chords, step.key, edit.fresh);
        edit.fresh = step.kind === 'clear';
        return syncEdit();
      }
      if (edit && t instanceof HTMLInputElement && t.id === 'kb-rec-when' && (e.key === 'Enter' || e.key === 'Escape')) {
        e.preventDefault();
        return e.key === 'Enter' ? saveEdit() : endEdit();
      }
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
      const editBtn = t.closest<HTMLElement>('[data-kb-edit]');
      if (editBtn) return editBtn.dataset.kbEdit === 'save' ? saveEdit() : endEdit();
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
            return openRecorder(null);
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
          if (editable(row)) startEdit(row);
          return;
        case 'add':
          return openRecorder({ command: row.command, title: row.title, when: row.source === 'unbound' ? '' : row.when, args: row.args });
        case 'remove':
          if (row.source === 'user') kbOp({ op: 'remove', index: row.index, command: row.command });
          else if (row.source === 'default') kbOp({ op: 'disableDefault', command: row.command, key: row.key, when: row.when });
          return;
        case 'restore':
          if (row.source !== 'unbound' && row.removalIndex !== null) kbOp({ op: 'restore', index: row.removalIndex, command: row.command });
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
  /**
   * Dialog to add a shortcut: for a command the user picks, or (with a seed) another one for a known command.
   * Changing an existing shortcut happens in its row.
   */
  function openRecorder(seed: AddSeed | null): void {
    let chords: string[] = [];
    // The first key pressed replaces what is there instead of extending it into a chord.
    let fresh = true;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>Add shortcut</h3>
        ${!seed
          ? `<label class="field"><span>Command</span><input type="text" class="text" id="rec-command" list="cmd-list" placeholder="Start typing a command id, e.g. workbench.action.files.save" spellcheck="false"></label>`
          : `<div class="field"><span>Command</span><div class="cmd-display"><b>${esc(seed.title)}</b><code>${esc(seed.command)}</code></div></div>`}
        <div class="field">
          <span>Shortcut</span>
          <div class="recorder" tabindex="0" id="rec-box"><span class="rec-keys"></span><span class="rec-hint">Click here and press keys</span></div>
          <small class="muted">Press a combination. Press a second one to make a chord (e.g. ${isMac() ? '⌘K ⌘S' : 'Ctrl+K Ctrl+S'}). Backspace clears, Esc stops recording.</small>
          <input type="text" class="text" id="rec-manual" placeholder="…or type it, e.g. ${isMac() ? 'cmd+shift+k' : 'ctrl+shift+k'}" spellcheck="false">
        </div>
        <label class="field"><span>When <small class="muted">(optional context, e.g. editorTextFocus)</small></span><input type="text" class="text" id="rec-when" list="when-list" spellcheck="false"></label>
        <div class="rec-conflicts"></div>
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
    when.value = seed?.when ?? '';
    const command = (): string => (cmdInput ? cmdInput.value.trim() : (seed?.command ?? ''));

    const update = (): void => {
      const key = chords.join(' ');
      $('.rec-keys', box).innerHTML = key ? keyHtml(key) : '';
      box.classList.toggle('has-keys', Boolean(key));
      if (document.activeElement !== manual) manual.value = key;
      const others = alsoRuns(sameKeys(key, command(), null));
      $('.rec-conflicts', wrap).innerHTML = others ? `<div class="banner warn">${others}</div>` : '';
    };

    box.addEventListener('focus', () => {
      fresh = true;
      box.classList.add('recording');
    });
    box.addEventListener('blur', () => box.classList.remove('recording'));
    box.addEventListener('keydown', (e) => {
      const step = recordStep(e);
      if (step.kind === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      if (step.kind === 'stop') return box.blur();
      chords = step.kind === 'clear' ? [] : addChord(chords, step.key, fresh);
      fresh = step.kind === 'clear';
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
      // The host confirms the save, or reports why it failed.
      kbOp({ op: 'add', command: cmd, key, when: w, args: seed?.args });
      close();
    });

    update();
    (cmdInput ?? box).focus();
  }

  // ---------- profiles ----------

  interface SetupCounts {
    hotkeys: number;
    appearance: number;
    syntax: number;
  }
  let setup: SetupCounts = { hotkeys: 0, appearance: 0, syntax: 0 };

  function wireProfiles(): void {
    const root = $('#tab-profiles');
    root.innerHTML = `
      <div class="content wide">
        <div class="content-head">
          <div><h2>Profiles & backup</h2><p>Save your setup to a file, move it to another machine, or roll back.</p></div>
          <div class="actions"><button class="btn secondary" data-p="import">Import…</button><button class="btn" data-p="export">Export profile…</button></div>
        </div>
        <section class="card setup-card">
          <h3>Your setup</h3>
          <p class="muted" id="setup-line"></p>
          <div class="setup-bar" id="setup-bar"><span class="seg-hotkeys"></span><span class="seg-appearance"></span><span class="seg-syntax"></span></div>
          <div class="setup-foot">
            <div class="setup-legend" id="setup-legend"></div>
            <label class="check"><input type="checkbox" id="exp-kb" checked> Export includes keybindings.json</label>
          </div>
        </section>
        <div class="profiles-grid">
          <section class="card">
            <h3>Snapshots <small>Taken before anything that changes a lot, so it can be undone.</small></h3>
            <div class="timeline" id="snap-list"></div>
          </section>
          <div class="profiles-side">
            <section class="card files-card">
              <h3>Where things are stored</h3>
              <div class="file-row"><div><code>settings.json</code><small>Colors, fonts and syntax colors. Save to picks user settings or this workspace's <code>.vscode/settings.json</code>.</small></div><button class="btn ghost" data-p="settings">Open ↗</button></div>
              <div class="file-row"><div><code>keybindings.json</code><small>Hotkeys, always user-wide. A copy is kept next to it as <code>keybindings.json.personify-backup</code> before the first change of a session.</small></div><button class="btn ghost" data-p="keybindings">Open ↗</button></div>
            </section>
            <section class="card danger-card">
              <h3>Reset Personify customizations</h3>
              <p>Removes every color, font and syntax rule Personify wrote to the target in the top bar. A snapshot is taken first, so this can be undone.</p>
              <button class="btn danger" data-p="reset">Reset…</button>
            </section>
          </div>
        </div>
      </div>`;
    root.addEventListener('click', (e) => {
      const t = targetOf(e);
      const restore = t?.closest<HTMLElement>('[data-restore]');
      if (restore) {
        const snap = S.snapshots.find((s) => s.id === restore.dataset.restore);
        return snap && send({ type: 'restoreSnapshot', id: snap.id });
      }
      const b = t?.closest<HTMLElement>('[data-p]');
      if (!b) return;
      switch (b.dataset.p) {
        case 'export':
          return send({ type: 'export', includeKeybindings: $<HTMLInputElement>('#exp-kb').checked });
        case 'import':
          return send({ type: 'import' });
        case 'revert':
          return send({ type: 'revertSession' });
        case 'reset':
          return openResetDialog();
        case 'settings':
          return send({ type: 'openSettingsJson' });
        case 'keybindings':
          return send({ type: 'openKeybindingsJson' });
      }
    });
    renderSnapshots();
  }

  function renderSetup(counts: SetupCounts): void {
    setup = counts;
    const line = $opt('#setup-line');
    if (!line) return;
    const total = counts.hotkeys + counts.appearance + counts.syntax;
    const parts: readonly (readonly [keyof SetupCounts, string])[] = [
      ['hotkeys', 'Hotkeys'],
      ['appearance', 'Appearance'],
      ['syntax', 'Syntax colors'],
    ];
    line.textContent = total ? `${total} customization${total === 1 ? '' : 's'} across ${parts.filter(([k]) => counts[k]).length} area${parts.filter(([k]) => counts[k]).length === 1 ? '' : 's'}` : 'Nothing customized yet: your theme decides everything.';
    for (const [key] of parts) $(`#setup-bar .seg-${key}`).style.flexGrow = String(counts[key]);
    $('#setup-bar').classList.toggle('empty', !total);
    $('#setup-legend').innerHTML = parts.map(([key, label]) => `<span class="legend-item"><i class="dot-${key}"></i>${label} <b>${counts[key]}</b></span>`).join('');
  }

  const DAY = 86_400_000;
  /** "Today, 09:14", "Yesterday, 18:40" or "Oct 24". */
  function when(at: number): string {
    const d = new Date(at);
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (at >= today.getTime()) return `Today, ${time}`;
    if (at >= today.getTime() - DAY) return `Yesterday, ${time}`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderSnapshots(): void {
    const box = $opt('#snap-list');
    if (!box) return;
    type Entry = { at: number; html: string };
    const entries: Entry[] = S.snapshots.map((s) => ({
      at: s.at,
      html: `<div class="tl-item"><span class="tl-dot"></span><div class="tl-text"><b>${esc(when(s.at))}</b><small>${esc(s.reason)}</small></div><button class="btn secondary" data-restore="${esc(s.id)}">Restore</button></div>`,
    }));
    if (S.sessionStart) {
      entries.push({
        at: S.sessionStart,
        html: `<div class="tl-item"><span class="tl-dot"></span><div class="tl-text"><b>${esc(when(S.sessionStart))}</b><small>This session started</small></div><button class="btn secondary" data-p="revert">Revert to this</button></div>`,
      });
    }
    entries.sort((a, b) => b.at - a.at);
    box.innerHTML = `<div class="tl-item now"><span class="tl-dot"></span><div class="tl-text"><b>Now</b><small>Your current setup</small></div><span class="badge badge-live">Live</span></div>${entries.map((e) => e.html).join('')}${S.snapshots.length ? '' : '<div class="tl-note muted small">Snapshots appear here before an import, a reset, a revert or a restore.</div>'}`;
  }

  // ---------- dialogs ----------

  interface DialogOpts {
    title: string;
    body: string;
    /** Called with the data-d value of the button pressed; return false to keep the dialog open. */
    onAction: (action: string, dialog: HTMLElement) => boolean | void;
    onClose?: () => void;
    tone?: 'danger';
  }

  /** A dialog over the panel: Esc and a click on the backdrop cancel; buttons carry data-d. */
  function openDialog({ title, body, onAction, onClose, tone }: DialogOpts): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal ${tone ?? ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${body}</div>`;
    document.body.appendChild(wrap);
    const dialog = $('.modal', wrap);
    const close = (): void => {
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      onClose?.();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) close();
    });
    wrap.addEventListener('click', (e) => {
      const b = targetOf(e)?.closest<HTMLElement>('[data-d]');
      if (!b) return;
      if (b.dataset.d === 'cancel' || onAction(b.dataset.d ?? '', dialog) !== false) close();
    });
    $opt<HTMLElement>('[data-d="cancel"]', dialog)?.focus();
    return dialog;
  }

  function openResetDialog(): void {
    const n = setup.appearance + setup.syntax;
    if (!n) return toast('Nothing to reset: Personify has not changed anything here');
    const p = S.prefs;
    const target = p ? `${p.scope === 'workspace' ? 'workspace' : 'user'} settings${p.themeMode === 'current' ? ` for “${p.theme}”` : ''}` : 'settings';
    openDialog({
      title: 'Reset Personify customizations?',
      tone: 'danger',
      body: `<p class="muted">This removes what Personify wrote to ${esc(target)}.</p>
        <div class="dlg-list">
          <div class="dlg-row"><span>Appearance<small>colors and fonts</small></span><b class="err-text">${setup.appearance}</b></div>
          <div class="dlg-row"><span>Syntax colors<small>tokens and custom scopes</small></span><b class="err-text">${setup.syntax}</b></div>
          <div class="dlg-row"><span>Shortcuts<small>keybindings.json is not touched</small></span><b class="muted">0</b></div>
        </div>
        <div class="dlg-note ok">↺ <b>A snapshot is taken first.</b> Undo it any time from Profiles & backup → Snapshots.</div>
        <div class="modal-actions"><button class="btn secondary" data-d="cancel">Cancel</button><button class="btn danger" data-d="reset">Reset ${n} customization${n === 1 ? '' : 's'}</button></div>`,
      onAction: (action) => {
        if (action === 'reset') send({ type: 'resetAll' });
      },
    });
  }

  function openImportDialog(preview: ImportPreview): void {
    let replace = false;
    let applied = false;
    const icon: Record<string, string> = { added: '+', changed: '~', removed: '−' };
    const listHtml = (diff: ProfileDiff): string => {
      const shown = diff.entries.slice(0, 12);
      const rows = shown
        .map((e) => `<div class="diff-row ${e.kind}"><i>${icon[e.kind] ?? ''}</i><span class="diff-label">${esc(e.label)}</span><span class="diff-value">${e.from === null ? '' : `<code>${esc(e.from)}</code>`}${e.from !== null && e.to !== null ? ' → ' : ''}${e.to === null ? '' : `<code>${esc(e.to)}</code>`}</span></div>`)
        .join('');
      const more = diff.entries.length - shown.length;
      return `${rows}${more > 0 ? `<div class="diff-row muted"><i></i>and ${more} more</div>` : ''}${diff.same ? `<div class="diff-row same"><i>=</i>${diff.same} item${diff.same === 1 ? '' : 's'} already match</div>` : ''}${!diff.entries.length && !diff.same ? '<div class="diff-row muted">The file has no colors, fonts or syntax rules.</div>' : ''}`;
    };
    const summary = (diff: ProfileDiff): string => {
      const by = (k: string): number => diff.entries.filter((e) => e.kind === k).length;
      return `${by('added')} added · ${by('changed')} changed · ${by('removed')} removed`;
    };
    const kb = preview.keybindingCount
      ? `<label class="check dlg-kb"><input type="checkbox" id="imp-kb"> Also add the file's ${preview.keybindingCount} shortcut${preview.keybindingCount === 1 ? '' : 's'} that are missing</label>
         <details class="dlg-kb-list"><summary>Show them</summary><pre>${preview.keybindings.map(esc).join('\n')}${preview.keybindingCount > preview.keybindings.length ? `\n…and ${preview.keybindingCount - preview.keybindings.length} more` : ''}</pre></details>
         <div class="dlg-note warn">A shortcut can run any command. Add them only from a file you trust.</div>`
      : '';
    const dialog = openDialog({
      title: `Import ${preview.file}`,
      body: `<div class="dlg-mode"><span class="muted">How</span><div class="seg" id="imp-mode"><button data-mode="merge" class="active">Merge with mine</button><button data-mode="replace">Replace mine</button></div></div>
        <div class="dlg-sub">What changes</div>
        <div class="diff-list" id="imp-list"></div>
        <div class="dlg-summary"><b id="imp-summary"></b><span class="muted">A snapshot of your current setup is taken first.</span></div>
        ${kb}
        <div class="modal-actions"><button class="btn secondary" data-d="cancel">Cancel</button><button class="btn" data-d="import" id="imp-go"></button></div>`,
      onAction: (action, d) => {
        if (action !== 'import') return;
        applied = true;
        send({ type: 'importApply', replace, keybindings: $opt<HTMLInputElement>('#imp-kb', d)?.checked === true });
      },
      onClose: () => {
        if (!applied) send({ type: 'importCancel' });
      },
    });
    const sync = (): void => {
      const diff = replace ? preview.replace : preview.merge;
      $('#imp-list', dialog).innerHTML = listHtml(diff);
      $('#imp-summary', dialog).textContent = summary(diff);
      $$('#imp-mode button', dialog).forEach((b) => b.classList.toggle('active', (b.dataset.mode === 'replace') === replace));
      const withKb = $opt<HTMLInputElement>('#imp-kb', dialog)?.checked === true;
      const n = diff.entries.length;
      const go = $<HTMLButtonElement>('#imp-go', dialog);
      go.disabled = !n && !withKb;
      go.textContent = n ? `Import ${n} change${n === 1 ? '' : 's'}${withKb ? ' and shortcuts' : ''}` : withKb ? 'Add shortcuts' : 'Nothing to import';
    };
    dialog.addEventListener('click', (e) => {
      const mode = targetOf(e)?.closest<HTMLElement>('[data-mode]');
      if (!mode) return;
      replace = mode.dataset.mode === 'replace';
      sync();
    });
    dialog.addEventListener('change', sync);
    sync();
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
      case 'snapshots':
        S.snapshots = msg.list;
        S.sessionStart = msg.sessionStart;
        return renderSnapshots();
      case 'importPreview':
        return openImportDialog(msg.preview);
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
