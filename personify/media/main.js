// Personify webview. Structure is rendered once per view; incoming state only syncs values in place
// so typing and color dragging never lose focus.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const send = (type, payload = {}) => vscode.postMessage({ type, ...payload });

  const SEMANTIC_KEY = 'editor.semanticHighlighting.enabled';
  const TABS = [
    { id: 'hotkeys', label: 'Hotkeys', icon: '⌨' },
    { id: 'appearance', label: 'Appearance', icon: '◐' },
    { id: 'syntax', label: 'Syntax colors', icon: '{ }' },
    { id: 'profiles', label: 'Profiles & backup', icon: '⇅' },
  ];
  const FONTS = ['Menlo', 'Monaco', 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro', 'Hack', 'IBM Plex Mono', 'Roboto Mono', 'Ubuntu Mono', 'Iosevka', 'Victor Mono', 'Consolas', 'Courier New', 'monospace'];
  const WHEN = ['editorTextFocus', 'editorFocus', '!editorReadonly', 'editorHasSelection', 'terminalFocus', 'explorerViewletFocus', 'filesExplorerFocus', 'sideBarFocus', 'panelFocus', 'inputFocus', 'textInputFocus', 'inQuickOpen', 'suggestWidgetVisible', 'findWidgetVisible', "editorLangId == 'typescript'", "editorLangId == 'javascript'", "editorLangId == 'go'"];

  const saved = vscode.getState() || {};
  const S = {
    tab: saved.tab || 'appearance',
    area: saved.area || 'sidebar',
    lang: saved.lang || 'jsts',
    catalog: null,
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
  const persist = () => vscode.setState({ tab: S.tab, area: S.area, lang: S.lang });
  const isMac = () => S.platform === 'darwin';

  // ---------- small helpers ----------

  const timers = new Map();
  function debounce(key, fn, ms = 180) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      fn();
    }, ms));
  }
  // Like debounce, but the key stays "pending" so stale state echoes don't overwrite local edits.
  function queueSend(key, fn, ms) {
    S.pending.add(key);
    debounce(key, () => {
      S.pending.delete(key);
      fn();
    }, ms);
  }

  function toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('hide'), kind === 'error' ? 6000 : 3000);
    setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
  }

  // ---------- color control ----------

  const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  function splitHex(h) {
    let x = h.slice(1);
    if (x.length <= 4) x = x.split('').map((c) => c + c).join('');
    return { rgb: `#${x.slice(0, 6).toLowerCase()}`, alpha: x.slice(6) };
  }
  function normalizeHex(raw) {
    let v = String(raw || '').trim();
    if (/^[0-9a-f]{3,8}$/i.test(v)) v = `#${v}`;
    return HEX_RE.test(v) ? v.toLowerCase() : null;
  }

  const colorControl = (attrs = '') => `
    <div class="color-ctl empty" ${attrs}>
      <label class="swatch" title="Pick a color"><input type="color" class="color-picker" tabindex="-1"><span class="swatch-fill"></span></label>
      <input type="text" class="hex" placeholder="theme" spellcheck="false" maxlength="9" aria-label="Hex color">
    </div>`;

  function setColorCtl(ctl, value) {
    if (!ctl) return;
    ctl.dataset.value = value || '';
    const hex = $('.hex', ctl);
    if (document.activeElement !== hex) {
      hex.value = value || '';
      hex.classList.remove('invalid');
    }
    ctl.classList.toggle('empty', !value);
    $('.swatch-fill', ctl).style.background = value || '';
    if (value && HEX_RE.test(value)) $('.color-picker', ctl).value = splitHex(value).rgb;
  }

  // Shared input handling for every .color-ctl; calls onColor(ctl, value|null).
  function handleColorEvent(e, onColor) {
    const t = e.target;
    const ctl = t.closest && t.closest('.color-ctl');
    if (!ctl) return false;
    if (t.classList.contains('color-picker') && e.type === 'input') {
      const old = ctl.dataset.value;
      const alpha = old && HEX_RE.test(old) ? splitHex(old).alpha : '';
      const value = t.value + alpha;
      $('.hex', ctl).value = value;
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
        $('.color-picker', ctl).value = splitHex(value).rgb;
        onColor(ctl, value);
      } else if (e.type === 'change') {
        t.classList.add('invalid');
      }
      return true;
    }
    return false;
  }

  // ---------- key helpers ----------

  const CODE_MAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', NumpadEnter: 'enter',
    Escape: 'escape', Backspace: 'backspace', Tab: 'tab', Space: 'space', Delete: 'delete', Insert: 'insert',
    Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backquote: '`', IntlBackslash: 'oem_102', NumpadAdd: 'numpad_add', NumpadSubtract: 'numpad_subtract',
    NumpadMultiply: 'numpad_multiply', NumpadDivide: 'numpad_divide', NumpadDecimal: 'numpad_decimal',
    Pause: 'pausebreak', ContextMenu: 'contextmenu',
  };
  const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/;

  function keyFromEvent(e) {
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
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.shiftKey) mods.push('shift');
    if (e.altKey) mods.push('alt');
    if (e.metaKey) mods.push(isMac() ? 'cmd' : S.platform === 'win32' ? 'win' : 'meta');
    return [...mods, k].join('+');
  }

  function normKey(key) {
    return String(key || '')
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .map((chord) => {
        const parts = chord.split('+');
        const last = parts.pop();
        return [...parts.sort(), last].join('+');
      })
      .join(' ');
  }

  const MAC_SYMBOLS = { cmd: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
  const KEY_NAMES = { up: '↑', down: '↓', left: '←', right: '→', enter: '↵', escape: 'Esc', backspace: '⌫', delete: 'Del', space: 'Space', tab: 'Tab', pageup: 'PgUp', pagedown: 'PgDn', meta: 'Meta', win: 'Win' };
  function prettyPart(p) {
    if (isMac() && MAC_SYMBOLS[p]) return MAC_SYMBOLS[p];
    if (KEY_NAMES[p]) return KEY_NAMES[p];
    return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
  }
  function keyHtml(key) {
    if (!key) return '<span class="muted">—</span>';
    return String(key)
      .trim()
      .split(/\s+/)
      .map((chord) => `<span class="chord">${chord.split('+').map((p) => `<kbd>${esc(prettyPart(p))}</kbd>`).join('')}</span>`)
      .join('<span class="chord-sep">then</span>');
  }

  // ---------- shell ----------

  function renderShell() {
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

  function showTab(tab) {
    S.tab = TABS.some((t) => t.id === tab) ? tab : 'appearance';
    persist();
    $$('.tab', app).forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
    $$('.tab-panel', app).forEach((p) => p.classList.toggle('active', p.id === `tab-${S.tab}`));
    app.classList.toggle('hotkeys-mode', S.tab === 'hotkeys');
  }

  function sendPrefs() {
    S.custom = [];
    send('prefs', { scope: $('#scope').value, themeMode: $('#themeMode').value });
  }

  function syncPrefs() {
    const p = S.prefs;
    const scope = $('#scope');
    scope.value = p.scope;
    scope.querySelector('option[value="workspace"]').disabled = !p.hasWorkspace;
    scope.querySelector('option[value="workspace"]').textContent = p.hasWorkspace ? 'This workspace only' : 'This workspace (open a folder first)';
    const tm = $('#themeMode');
    tm.value = p.themeMode;
    tm.querySelector('option[value="current"]').textContent = `Only "${p.theme}"`;
    $$('.target-chip', app).forEach((el) => (el.innerHTML = targetChip()));
  }

  const targetChip = () =>
    S.prefs
      ? `Saving to <b>${S.prefs.scope === 'workspace' ? 'workspace' : 'user'}</b> settings · <b>${S.prefs.themeMode === 'current' ? esc(S.prefs.theme) : 'all themes'}</b>`
      : '';

  // ---------- appearance ----------

  function settingControl(item) {
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
      default:
        return `<input type="text" class="text">`;
    }
  }

  function appearanceRow(item) {
    if (item.kind === 'note') return `<div class="note">ⓘ ${esc(item.text)}</div>`;
    const hint = item.desc || item.hint;
    const search = `${item.label} ${item.key} ${hint || ''}`.toLowerCase();
    return `<div class="row" data-kind="${item.kind}" data-key="${esc(item.key)}" data-search="${esc(search)}">
      <div class="row-label">
        <div class="label">${esc(item.label)}<span class="dot" title="Customized"></span></div>
        <div class="desc">${hint ? `${esc(hint)} · ` : ''}<code>${esc(item.key)}</code></div>
      </div>
      <div class="row-control">${item.kind === 'color' ? colorControl() : settingControl(item)}</div>
      <button class="icon-btn reset" data-action="reset-item" title="Reset to default">↺</button>
    </div>`;
  }

  function renderAppearance() {
    const areas = S.catalog.areas;
    const area = areas.find((a) => a.id === S.area) || areas[0];
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

  function syncAppearance() {
    if (!S.appearance || !$('#tab-appearance .split')) return;
    const { colors, settings } = S.appearance;
    for (const row of $$('#tab-appearance .row')) {
      const key = row.dataset.key;
      if (row.dataset.kind === 'color') {
        setColorCtl($('.color-ctl', row), colors[key]);
        row.classList.toggle('modified', Boolean(colors[key]));
        continue;
      }
      const st = settings[key] || {};
      const shown = st.effective !== undefined ? st.effective : st.def;
      row.classList.toggle('modified', st.value !== undefined);
      const range = $('.range', row);
      if (range) {
        const num = $('.num', row);
        if (document.activeElement !== range) range.value = st.value !== undefined ? st.value : shown;
        if (document.activeElement !== num) num.value = st.value !== undefined ? st.value : '';
        num.placeholder = shown === undefined ? '' : String(shown);
      }
      const font = $('.font-input', row);
      if (font) {
        if (document.activeElement !== font) font.value = st.value || '';
        font.placeholder = shown || 'Same as editor';
        $('.font-sample', row).style.fontFamily = font.value || shown || '';
      }
      const select = $('.select', row);
      if (select) {
        if (document.activeElement !== select) select.value = st.value !== undefined ? String(st.value) : '';
        select.options[0].textContent = `Default (${shown})`;
      }
      const seg = $('.seg', row);
      if (seg) {
        const val = st.value === undefined ? '' : String(st.value);
        $$('button', seg).forEach((b) => b.classList.toggle('active', b.dataset.val === val));
        seg.querySelector('[data-val=""]').textContent = `Default (${shown ? 'on' : 'off'})`;
      }
    }
    for (const area of S.catalog.areas) {
      const n = area.groups.flatMap((g) => g.items).filter((i) => (i.kind === 'color' ? colors[i.key] : i.kind === 'setting' && settings[i.key] && settings[i.key].value !== undefined)).length;
      const el = $(`#tab-appearance [data-count="${area.id}"]`);
      if (el) el.textContent = n ? `${n} customized` : 'Theme defaults';
    }
  }

  function setColor(key, value) {
    if (value) S.appearance.colors[key] = value;
    else delete S.appearance.colors[key];
    syncAppearance();
    queueSend(`c:${key}`, () => send('setColors', { changes: { [key]: value } }));
  }

  function setSetting(key, value, ms) {
    const st = S.appearance.settings[key] || (S.appearance.settings[key] = {});
    st.value = value === null ? undefined : value;
    if (value !== null) st.effective = value;
    syncAppearance();
    queueSend(`s:${key}`, () => send('setSettings', { changes: { [key]: value } }), ms);
  }

  function wireAppearance() {
    const root = $('#tab-appearance');
    const onColor = (ctl, value) => setColor(ctl.closest('.row').dataset.key, value);
    const onInput = (e) => {
      if (handleColorEvent(e, onColor)) return;
      const t = e.target;
      if (t.dataset.filter) {
        S.filters.appearance = t.value;
        return applyFilter('appearance');
      }
      const row = t.closest('.row');
      if (!row) return;
      const key = row.dataset.key;
      if (t.classList.contains('range')) {
        $('.num', row).value = t.value;
        setSetting(key, Number(t.value));
      } else if (t.classList.contains('num')) {
        if (t.value === '') setSetting(key, null, 600);
        else if (!Number.isNaN(Number(t.value))) {
          $('.range', row).value = t.value;
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
      const t = e.target;
      const areaBtn = t.closest('[data-area]');
      if (areaBtn) {
        S.area = areaBtn.dataset.area;
        S.filters.appearance = '';
        persist();
        return renderAppearance();
      }
      const segBtn = t.closest('.seg button');
      if (segBtn) {
        const v = segBtn.dataset.val;
        return setSetting(segBtn.closest('.row').dataset.key, v === '' ? null : v === 'true', 0);
      }
      const action = t.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'reset-item') {
        const row = action.closest('.row');
        if (row.dataset.kind === 'color') setColor(row.dataset.key, null);
        else setSetting(row.dataset.key, null, 0);
      } else if (action.dataset.action === 'reset-area') {
        resetArea();
      } else if (action.dataset.action === 'open-settings-json') {
        send('openSettingsJson');
      }
    });
  }

  function resetArea() {
    const area = S.catalog.areas.find((a) => a.id === S.area);
    const colors = {};
    const settings = {};
    for (const item of area.groups.flatMap((g) => g.items)) {
      if (item.kind === 'color' && S.appearance.colors[item.key]) {
        colors[item.key] = null;
        delete S.appearance.colors[item.key];
      } else if (item.kind === 'setting' && S.appearance.settings[item.key] && S.appearance.settings[item.key].value !== undefined) {
        settings[item.key] = null;
        S.appearance.settings[item.key].value = undefined;
      }
    }
    if (!Object.keys(colors).length && !Object.keys(settings).length) return toast('Nothing to reset here');
    if (Object.keys(colors).length) send('setColors', { changes: colors });
    if (Object.keys(settings).length) send('setSettings', { changes: settings });
    syncAppearance();
    toast(`${area.title} reset to defaults`, 'success');
  }

  function applyFilter(tab) {
    const root = $(`#tab-${tab}`);
    const q = S.filters[tab].trim().toLowerCase();
    let visible = 0;
    for (const card of $$('.card', root)) {
      let any = false;
      for (const row of $$('[data-search]', card)) {
        const show = !q || row.dataset.search.includes(q);
        row.classList.toggle('hidden', !show);
        any = any || show;
      }
      const note = $('.note', card);
      if (note) note.classList.toggle('hidden', Boolean(q));
      card.classList.toggle('hidden', !any);
      if (any) visible++;
    }
    const empty = $('.empty-state', root);
    if (empty) empty.classList.toggle('hidden', visible > 0);
  }

  // ---------- syntax ----------

  const currentLang = () => S.catalog.languages.find((l) => l.id === S.lang);
  const styleKey = (langId, itemId) => `${langId}/${itemId}`;
  const hasStyle = (st) => Boolean(st && (st.fg || typeof st.fontStyle === 'string'));
  const STYLE_BUTTONS = [
    ['bold', '<b>B</b>', 'Bold'],
    ['italic', '<i>I</i>', 'Italic'],
    ['underline', '<u>U</u>', 'Underline'],
    ['strikethrough', '<s>S</s>', 'Strikethrough'],
  ];
  const styleToggles = () => `<div class="styles">${STYLE_BUTTONS.map(([s, html, title]) => `<button class="style-btn" data-style="${s}" title="${title}">${html}</button>`).join('')}</div>`;

  function syncStyleButtons(row, fontStyle) {
    const set = (fontStyle || '').split(/\s+/);
    $$('.style-btn', row).forEach((b) => b.classList.toggle('active', set.includes(b.dataset.style)));
  }

  function cssFor(st) {
    const parts = [];
    if (st && st.fg) parts.push(`color:${st.fg}`);
    const fs = st && typeof st.fontStyle === 'string' ? st.fontStyle.split(/\s+/) : [];
    if (fs.includes('bold')) parts.push('font-weight:bold');
    if (fs.includes('italic')) parts.push('font-style:italic');
    const deco = ['underline', 'strikethrough'].filter((d) => fs.includes(d)).map((d) => (d === 'strikethrough' ? 'line-through' : d));
    if (deco.length) parts.push(`text-decoration:${deco.join(' ')}`);
    return parts.join(';');
  }

  function previewHtml(lang) {
    return lang.sample
      .map((line) => {
        const html = line.replace(/⟦([^¦]*)¦([^⟧]*)⟧|([^⟦]+)/g, (_, id, text, plain) =>
          plain !== undefined ? esc(plain) : `<span class="tok" data-item="${esc(id)}">${esc(text)}</span>`
        );
        return `<div class="pl">${html || ' '}</div>`;
      })
      .join('');
  }

  function semanticBar() {
    return `<div class="semantic-bar">
      <div><b>Semantic highlighting</b><span class="muted"> · language servers can recolor names (variables, types, functions) on top of the grammar. Personify writes both, so your colors win either way.</span></div>
      <div class="seg" data-semantic><button data-val="">Theme default</button><button data-val="true">On</button><button data-val="false">Off</button></div>
    </div>`;
  }

  function renderSyntax() {
    const langs = S.catalog.languages;
    if (S.lang !== 'custom' && !langs.some((l) => l.id === S.lang)) S.lang = langs[0].id;
    const nav = `<aside class="subnav">
      ${langs.map((l) => `<button class="subnav-item" data-lang="${l.id}"><span class="subnav-icon">${l.id === 'go' ? 'Go' : 'JS'}</span><span class="subnav-text"><b>${esc(l.title)}</b><small data-count="${l.id}"></small></span></button>`).join('')}
      <button class="subnav-item" data-lang="custom"><span class="subnav-icon">✱</span><span class="subnav-text"><b>Custom scopes</b><small data-count="custom"></small></span></button>
      <div class="subnav-tip">Click any token in the preview to jump to its setting.</div>
    </aside>`;
    $('#tab-syntax').innerHTML = `<div class="split">${nav}<div class="content">${S.lang === 'custom' ? customHtml() : languageHtml(currentLang())}</div></div>`;
    $$('#tab-syntax .subnav-item').forEach((b) => b.classList.toggle('active', b.dataset.lang === S.lang));
    if (S.lang === 'custom') renderCustomRows();
    else applyFilter('syntax');
    syncSyntax();
  }

  function languageHtml(lang) {
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

  function customHtml() {
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

  function renderCustomRows() {
    const box = $('#custom-rows');
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

  function syncCustom() {
    for (const row of $$('#custom-rows .custom-row')) {
      const c = S.custom.find((x) => x.id === row.dataset.id);
      if (!c) continue;
      setColorCtl($('.color-ctl', row), c.fg);
      syncStyleButtons(row, c.fontStyle);
      row.classList.toggle('modified', hasStyle(c));
      row.classList.toggle('incomplete', !c.scope.trim() || !hasStyle(c));
    }
  }

  function syncSyntax() {
    if (!S.syntax || !$('#tab-syntax .split')) return;
    const items = S.syntax.items;
    for (const lang of S.catalog.languages) {
      const n = lang.groups.flatMap((g) => g.items).filter((i) => hasStyle(items[styleKey(lang.id, i.id)])).length;
      const el = $(`#tab-syntax [data-count="${lang.id}"]`);
      if (el) el.textContent = n ? `${n} customized` : 'Theme colors';
    }
    const customCount = $('#tab-syntax [data-count="custom"]');
    if (customCount) customCount.textContent = S.custom.length ? `${S.custom.length} rule${S.custom.length > 1 ? 's' : ''}` : 'Any scope';

    const sem = $('#tab-syntax [data-semantic]');
    if (sem) {
      const v = S.syntax.semanticHighlighting;
      const val = v === true ? 'true' : v === false ? 'false' : '';
      $$('button', sem).forEach((b) => b.classList.toggle('active', b.dataset.val === val));
    }

    if (S.lang === 'custom') return syncCustom();
    const lang = currentLang();
    for (const row of $$('#tab-syntax .token-row')) {
      const st = items[styleKey(lang.id, row.dataset.item)];
      setColorCtl($('.color-ctl', row), st && st.fg);
      syncStyleButtons(row, st && st.fontStyle);
      row.classList.toggle('modified', hasStyle(st));
    }
    for (const card of $$('#tab-syntax details.card')) {
      const rows = $$('.token-row', card);
      const n = rows.filter((r) => r.classList.contains('modified')).length;
      $('[data-group-count]', card).textContent = n ? `${n} / ${rows.length} customized` : `${rows.length} tokens`;
    }
    const bg = S.appearance && S.appearance.colors['editor.background'];
    const fg = S.appearance && S.appearance.colors['editor.foreground'];
    const preview = $('#tab-syntax .preview');
    if (preview) {
      preview.style.background = bg || '';
      preview.style.color = fg || '';
    }
    for (const span of $$('#tab-syntax .tok')) {
      const st = items[styleKey(lang.id, span.dataset.item)];
      span.style.cssText = cssFor(st);
      span.classList.toggle('dim', !(st && st.fg));
    }
  }

  function setTokenStyle(itemId, patch) {
    const lang = currentLang();
    const key = styleKey(lang.id, itemId);
    let next = patch === null ? null : { ...(S.syntax.items[key] || {}), ...patch };
    if (next && !hasStyle(next)) next = null;
    if (next) S.syntax.items[key] = next;
    else delete S.syntax.items[key];
    syncSyntax();
    queueSend(`t:${key}`, () => send('setSyntax', { changes: [{ langId: lang.id, itemId, style: next }] }));
  }

  function toggleStyle(fontStyle, style) {
    const set = new Set((fontStyle || '').split(/\s+/).filter(Boolean));
    if (set.has(style)) set.delete(style);
    else set.add(style);
    return [...set].join(' ');
  }

  function updateCustom(id, patch) {
    const c = S.custom.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, patch);
    syncCustom();
    queueSend('custom', sendCustom, 400);
  }
  const sendCustom = () => send('setCustom', { list: S.custom.map(({ id, scope, fg, fontStyle }) => ({ id, scope, fg, fontStyle })) });

  function mergeCustom(server) {
    if (S.pending.has('custom')) return;
    const ids = new Set(server.map((c) => c.id));
    const drafts = S.custom.filter((c) => !ids.has(c.id) && (!c.scope.trim() || !hasStyle(c)));
    S.custom = [...server, ...drafts];
  }

  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  function wireSyntax() {
    const root = $('#tab-syntax');
    const onColor = (ctl, value) => {
      const row = ctl.closest('.row');
      if (row.classList.contains('custom-row')) updateCustom(row.dataset.id, { fg: value || undefined });
      else setTokenStyle(row.dataset.item, { fg: value || undefined });
    };
    const onInput = (e) => {
      if (handleColorEvent(e, onColor)) return;
      const t = e.target;
      if (t.dataset.filter) {
        S.filters.syntax = t.value;
        return applyFilter('syntax');
      }
      if (t.classList.contains('scope-input')) updateCustom(t.closest('.row').dataset.id, { scope: t.value });
    };
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);

    root.addEventListener('click', (e) => {
      const t = e.target;
      const langBtn = t.closest('[data-lang]');
      if (langBtn) {
        S.lang = langBtn.dataset.lang;
        S.filters.syntax = '';
        persist();
        return renderSyntax();
      }
      const semBtn = t.closest('[data-semantic] button');
      if (semBtn) {
        const v = semBtn.dataset.val;
        S.syntax.semanticHighlighting = v === '' ? 'configuredByTheme' : v === 'true';
        syncSyntax();
        return send('setSettings', { changes: { [SEMANTIC_KEY]: v === '' ? null : v === 'true' } });
      }
      const styleBtn = t.closest('.style-btn');
      if (styleBtn) {
        const row = styleBtn.closest('.row');
        if (row.classList.contains('custom-row')) {
          const c = S.custom.find((x) => x.id === row.dataset.id);
          return updateCustom(c.id, { fontStyle: toggleStyle(c.fontStyle, styleBtn.dataset.style) });
        }
        const st = S.syntax.items[styleKey(S.lang, row.dataset.item)] || {};
        return setTokenStyle(row.dataset.item, { fontStyle: toggleStyle(st.fontStyle, styleBtn.dataset.style) });
      }
      const tok = t.closest('.tok');
      if (tok) {
        const row = $(`#tab-syntax .token-row[data-item="${tok.dataset.item}"]`);
        if (!row) return;
        if (row.classList.contains('hidden')) {
          S.filters.syntax = '';
          $('#tab-syntax [data-filter]').value = '';
          applyFilter('syntax');
        }
        const details = row.closest('details');
        if (details) details.open = true;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(row);
        return;
      }
      const action = t.closest('[data-action]');
      if (!action) return;
      const lang = currentLang();
      switch (action.dataset.action) {
        case 'reset-token':
          return setTokenStyle(action.closest('.row').dataset.item, null);
        case 'reset-lang': {
          const changes = lang.groups
            .flatMap((g) => g.items)
            .filter((i) => hasStyle(S.syntax.items[styleKey(lang.id, i.id)]))
            .map((i) => {
              delete S.syntax.items[styleKey(lang.id, i.id)];
              return { langId: lang.id, itemId: i.id, style: null };
            });
          if (!changes.length) return toast('Nothing to reset here');
          send('setSyntax', { changes });
          syncSyntax();
          return toast(`${lang.title} reset to theme colors`, 'success');
        }
        case 'open-sample':
          return send('openSample', { langId: lang.id });
        case 'inspect':
          return send('inspectScope', { langId: lang ? lang.id : S.catalog.languages[0].id });
        case 'add-custom': {
          const id = Date.now().toString(36);
          S.custom.push({ id, scope: '', fg: undefined, fontStyle: undefined });
          renderCustomRows();
          syncSyntax();
          const input = $(`#custom-rows .custom-row[data-id="${id}"] .scope-input`);
          if (input) input.focus();
          return;
        }
        case 'delete-custom': {
          const id = action.closest('.row').dataset.id;
          S.custom = S.custom.filter((c) => c.id !== id);
          renderCustomRows();
          syncSyntax();
          return queueSend('custom', sendCustom, 0);
        }
      }
    });

    // Hovering a token row highlights its tokens in the preview.
    root.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.token-row');
      const id = row ? row.dataset.item : '';
      if (root.dataset.hover === id) return;
      root.dataset.hover = id;
      $$('.tok', root).forEach((s) => s.classList.toggle('hl', s.dataset.item === id));
    });
  }

  // ---------- hotkeys ----------

  let kbView = { rows: [], bound: new Set(), withDefault: new Set(), counts: {} };

  function computeKb() {
    const rows = S.kb.rows.slice().sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
    const groups = new Map();
    for (const r of rows) {
      r.nk = normKey(r.key);
      if (r.removed) continue;
      if (!groups.has(r.nk)) groups.set(r.nk, []);
      groups.get(r.nk).push(r);
    }
    for (const r of rows) {
      r.conflicts = r.removed ? [] : groups.get(r.nk).filter((o) => o !== r && o.command !== r.command && (o.when === r.when || !o.when || !r.when));
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
        unbound: S.kb.commands.filter((c) => !bound.has(c.id)).length,
      },
    };
    $('#cmd-list').innerHTML = S.kb.commands.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
  }

  function kbFiltered() {
    const raw = S.kbQuery.trim().toLowerCase();
    const looksLikeKey = /[+]/.test(raw) || S.kbRecordSearch;
    const nq = normKey(raw);
    const matches = (r) => {
      if (!raw) return true;
      if (looksLikeKey && r.nk && r.nk.includes(nq)) return true;
      return r.title.toLowerCase().includes(raw) || r.command.toLowerCase().includes(raw) || (r.key || '').toLowerCase().includes(raw) || (r.when || '').toLowerCase().includes(raw);
    };
    if (S.kbFilter === 'unbound') {
      return S.kb.commands.filter((c) => !kbView.bound.has(c.id)).map((c) => ({ id: `c:${c.id}`, unbound: true, command: c.id, title: c.title, key: '', when: '' })).filter(matches);
    }
    const pick = {
      all: () => true,
      changed: (r) => r.source === 'user' || r.removed,
      conflicts: (r) => r.conflicts.length > 0,
      removed: (r) => r.removed,
    }[S.kbFilter];
    return kbView.rows.filter((r) => pick(r) && matches(r));
  }

  function kbRowHtml(r) {
    const btn = (action, label, title, cls = '') => `<button class="icon-btn ${cls}" data-kb="${action}" data-id="${esc(r.id)}" title="${esc(title)}">${label}</button>`;
    let badge;
    let actions;
    if (r.unbound) {
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
    const conflict = r.conflicts && r.conflicts.length
      ? `<span class="conflict" title="Same key also runs:\n${esc(r.conflicts.slice(0, 6).map((c) => `• ${c.title}${c.when ? ` (when ${c.when})` : ''}`).join('\n'))}">⚠ ${r.conflicts.length}</span>`
      : '';
    return `<div class="kb-row ${r.removed ? 'removed' : ''} ${r.source === 'user' ? 'user' : ''}">
      <div class="kb-cmd"><div class="kb-title">${esc(r.title)}</div><div class="kb-id">${esc(r.command)}</div></div>
      <div class="kb-key">${keyHtml(r.key)}${conflict}</div>
      <div class="kb-when">${r.when ? `<code>${esc(r.when)}</code>` : '<span class="muted">always</span>'}</div>
      <div class="kb-src">${badge}</div>
      <div class="kb-actions">${actions}</div>
    </div>`;
  }

  function renderHotkeysShell() {
    const filters = [
      ['all', 'All'],
      ['changed', 'Changed by me'],
      ['conflicts', 'Conflicts'],
      ['removed', 'Removed'],
      ['unbound', 'Without shortcut'],
    ];
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
          <div class="chips">${filters.map(([id, label]) => `<button class="chip ${S.kbFilter === id ? 'active' : ''}" data-filter-kb="${id}">${label} <span data-kbcount="${id}"></span></button>`).join('')}</div>
        </div>
        <div class="kb-table">
          <div class="kb-row kb-head"><div>Command</div><div>Shortcut</div><div>When</div><div>Source</div><div></div></div>
          <div id="kb-body"><div class="empty-state">Loading shortcuts…</div></div>
        </div>
        <div class="kb-more"></div>
      </div>`;
  }

  function renderKbRows() {
    if (!S.kb) return;
    const list = kbFiltered();
    const shown = list.slice(0, S.kbLimit);
    $('#kb-body').innerHTML = shown.length ? shown.map(kbRowHtml).join('') : '<div class="empty-state">No shortcuts match.</div>';
    const more = list.length - shown.length;
    $('#tab-hotkeys .kb-more').innerHTML = more > 0 ? `<button class="btn secondary" data-kbtool="more">Show ${Math.min(more, 200)} more (${more} hidden)</button>` : '';
    for (const [id, n] of Object.entries(kbView.counts)) {
      const el = $(`[data-kbcount="${id}"]`);
      if (el) el.textContent = n;
    }
    $$('#tab-hotkeys .chip').forEach((c) => c.classList.toggle('active', c.dataset.filterKb === S.kbFilter));
  }

  function findKbRow(id) {
    if (id.startsWith('c:')) {
      const cmd = id.slice(2);
      const c = S.kb.commands.find((x) => x.id === cmd);
      return { id, unbound: true, command: cmd, title: c ? c.title : cmd, key: '', when: '' };
    }
    return kbView.rows.find((r) => r.id === id);
  }

  const kbOp = (op, payload) => send('kb', { op, payload });

  function wireHotkeys() {
    renderHotkeysShell();
    const root = $('#tab-hotkeys');
    root.addEventListener('input', (e) => {
      if (e.target.id !== 'kb-search') return;
      S.kbQuery = e.target.value;
      S.kbLimit = 200;
      debounce('kb-search', renderKbRows, 120);
    });
    root.addEventListener('keydown', (e) => {
      if (e.target.id !== 'kb-search' || !S.kbRecordSearch) return;
      const key = keyFromEvent(e);
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      e.target.value = key;
      S.kbQuery = key;
      renderKbRows();
    });
    root.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('#kb-record-search')) {
        S.kbRecordSearch = !S.kbRecordSearch;
        t.closest('#kb-record-search').classList.toggle('active', S.kbRecordSearch);
        const input = $('#kb-search');
        input.placeholder = S.kbRecordSearch ? 'Press a key combination…' : 'Search command, key (cmd+p) or when…';
        input.focus();
        return;
      }
      const chip = t.closest('[data-filter-kb]');
      if (chip) {
        S.kbFilter = chip.dataset.filterKb;
        S.kbLimit = 200;
        return renderKbRows();
      }
      const tool = t.closest('[data-kbtool]');
      if (tool) {
        switch (tool.dataset.kbtool) {
          case 'add':
            return openRecorder({ mode: 'add', editableCommand: true });
          case 'json':
            return send('openKeybindingsJson');
          case 'refresh':
            return send('kbRefresh');
          case 'more':
            S.kbLimit += 200;
            return renderKbRows();
        }
      }
      const b = t.closest('[data-kb]');
      if (!b) return;
      const row = findKbRow(b.dataset.id);
      if (!row) return;
      switch (b.dataset.kb) {
        case 'edit':
          return openRecorder({ mode: row.source === 'user' ? 'update' : 'replace', row });
        case 'add':
          return openRecorder({ mode: 'add', row: { ...row, key: '', when: row.unbound ? '' : row.when } });
        case 'remove':
          return row.source === 'user'
            ? kbOp('remove', { index: row.index, command: row.command })
            : kbOp('disableDefault', { command: row.command, key: row.key, when: row.when });
        case 'restore':
          return kbOp('restoreDefault', { index: row.removalIndex, command: row.command });
        case 'reset':
          return kbOp('resetCommand', { command: row.command });
      }
    });
  }

  // Modal to record / edit a shortcut.
  function openRecorder({ mode, row, editableCommand }) {
    const titles = { add: 'Add shortcut', update: 'Edit shortcut', replace: 'Change default shortcut' };
    let chords = row && row.key ? row.key.trim().split(/\s+/) : [];
    // The first key pressed replaces an existing shortcut instead of extending it into a chord.
    let fresh = true;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${titles[mode]}</h3>
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
        ${mode === 'replace' ? '<div class="muted small">The default shortcut is switched off and your new one is added to keybindings.json. You can restore it any time.</div>' : ''}
        <div class="modal-actions">
          <button class="btn secondary" data-m="cancel">Cancel</button>
          <button class="btn" data-m="save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const box = $('#rec-box', wrap);
    const manual = $('#rec-manual', wrap);
    const when = $('#rec-when', wrap);
    const cmdInput = $('#rec-command', wrap);
    when.value = (row && row.when) || '';
    const command = () => (cmdInput ? cmdInput.value.trim() : row.command);

    const update = () => {
      const key = chords.join(' ');
      $('.rec-keys', box).innerHTML = key ? keyHtml(key) : '';
      box.classList.toggle('has-keys', Boolean(key));
      if (document.activeElement !== manual) manual.value = key;
      const nk = normKey(key);
      const others = key && S.kb ? kbView.rows.filter((r) => !r.removed && r.nk === nk && r.command !== command() && r !== row) : [];
      $('.rec-conflicts', wrap).innerHTML = others.length
        ? `<div class="banner warn">⚠ Also used by ${others.slice(0, 4).map((o) => `<b>${esc(o.title)}</b>${o.when ? ` <span class="muted">(when ${esc(o.when)})</span>` : ''}`).join(', ')}${others.length > 4 ? ` and ${others.length - 4} more` : ''}</div>`
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

    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', onDocKey, true);
    };
    const onDocKey = (e) => {
      if (e.key === 'Escape' && document.activeElement !== box) close();
    };
    document.addEventListener('keydown', onDocKey, true);
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) close();
    });
    wrap.addEventListener('click', (e) => {
      const m = e.target.closest('[data-m]');
      if (!m) return;
      if (m.dataset.m === 'cancel') return close();
      const key = chords.join(' ');
      const cmd = command();
      const w = when.value.trim();
      if (!cmd) return toast('Choose a command first', 'error');
      if (!key) return toast('Record or type a shortcut first', 'error');
      if (mode === 'add') kbOp('add', { command: cmd, key, when: w, args: row ? row.args : undefined });
      else if (mode === 'update') kbOp('update', { index: row.index, command: row.command, key, when: w });
      else if (key !== row.key || w !== row.when) kbOp('replaceDefault', { command: row.command, oldKey: row.key, oldWhen: row.when, key, when: w, args: row.args });
      toast('Shortcut saved', 'success');
      close();
    });

    update();
    (cmdInput || box).focus();
  }

  // ---------- profiles ----------

  function wireProfiles() {
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
      const b = e.target.closest('[data-p]');
      if (!b) return;
      switch (b.dataset.p) {
        case 'export':
          return send('export', { includeKeybindings: $('#exp-kb').checked });
        case 'import':
          return send('import');
        case 'revert':
          return send('revertSession');
        case 'reset':
          return send('resetAll');
        case 'settings':
          return send('openSettingsJson');
        case 'keybindings':
          return send('openKeybindingsJson');
      }
    });
  }

  // ---------- messages ----------

  // Keep local values for keys whose write is still queued.
  function keepPending(prefix, local, incoming) {
    for (const key of S.pending) {
      if (!key.startsWith(prefix)) continue;
      const k = key.slice(prefix.length);
      if (local[k] === undefined) delete incoming[k];
      else incoming[k] = local[k];
    }
  }

  window.addEventListener('message', (event) => {
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
            if (key.startsWith('s:')) msg.appearance.settings[key.slice(2)] = S.appearance.settings[key.slice(2)];
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
        $('#kb-error').textContent = msg.error || '';
        computeKb();
        renderKbRows();
        return;
      case 'toast':
        return toast(msg.text, msg.kind);
    }
  });

  send('ready');
})();
