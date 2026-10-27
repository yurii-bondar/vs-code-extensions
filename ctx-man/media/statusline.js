(function () {
  const vscode = acquireVsCodeApi();
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const send = (type, payload = {}) => vscode.postMessage({ type, ...payload });

  const SEGMENTS = {
    profile: { name: 'Account', desc: 'Which Claude account is running', opts: ['accountColor'] },
    project: { name: 'Project', desc: 'Git repository or folder name' },
    git: { name: 'Git branch', desc: 'Branch, commits ahead/behind, changed files', opts: ['showAheadBehind', 'showDirty'] },
    model: { name: 'Model', desc: 'e.g. Opus 5.5' },
    effort: { name: 'Effort', desc: 'low / medium / high', opts: ['colorByLevel'] },
    context: { name: 'Context window', desc: 'How full the context is', opts: ['format', 'thresholds'] },
    tokens: { name: 'Tokens', desc: 'Total tokens used in this session' },
    five_hour: { name: '5-hour limit', desc: 'Usage of the 5-hour window', opts: ['format', 'thresholds', 'showReset'] },
    seven_day: { name: 'Weekly limit', desc: 'Usage of the weekly window', opts: ['format', 'thresholds', 'showReset'] },
    cost: { name: 'Cost', desc: 'Session cost in USD (API pricing)' },
    lines: { name: 'Lines changed', desc: '+added −removed this session' },
    duration: { name: 'Session time', desc: 'How long the session has run' },
    clock: { name: 'Clock', desc: 'Current time' },
    output_style: { name: 'Output style', desc: 'Shown when not default' },
    version: { name: 'Claude Code version', desc: '' },
    text: { name: 'Custom text', desc: 'Any fixed text', opts: ['text'] },
  };
  const OPTIONS = {
    accountColor: { type: 'check', label: "Use each account's color (set below in Account names)" },
    showAheadBehind: { type: 'check', label: 'Show commits ahead / behind (↑2 ↓1)' },
    showDirty: { type: 'check', label: 'Show changed / untracked files (!3 ?1)' },
    colorByLevel: { type: 'check', label: 'Color by level (low green, medium yellow, high red)' },
    thresholds: { type: 'check', label: 'Color by usage (warn / danger levels below)' },
    showReset: { type: 'check', label: 'Show time until reset' },
    format: { type: 'select', label: 'Show as', options: [['pct', '77%'], ['bar', '▰▰▰▰▰▰▱▱'], ['both', '▰▰▰▰▰▰▱▱ 77%']] },
    text: { type: 'text', label: 'Text' },
  };
  // Approximate terminal palette, used for the preview and the swatches.
  const NAMED = {
    black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4', gray: '#7f848e',
    brightRed: '#ff7a85', brightGreen: '#a5e075', brightYellow: '#f0d38a', brightBlue: '#4dc4ff', brightMagenta: '#de73ff', brightCyan: '#4cd1e0', brightWhite: '#ffffff',
  };
  const SGR_NAMED = { 30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white', 90: 'gray', 91: 'brightRed', 92: 'brightGreen', 93: 'brightYellow', 94: 'brightBlue', 95: 'brightMagenta', 96: 'brightCyan', 97: 'brightWhite' };
  const ICONS = ['👤', '📁', '🌿', '🧠', '⚡', '📊', '💰', '⏱', '🕐', '🔥', '✨', '🤖', '◆', '▸', '●'];

  const S = { config: null, accounts: [], presets: {}, selected: 'profile', dragId: null };

  // ---------- helpers ----------

  function toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('hide'), kind === 'error' ? 6000 : 3500);
    setTimeout(() => el.remove(), kind === 'error' ? 6500 : 4000);
  }

  let timer;
  function changed(renderWhat = []) {
    clearTimeout(timer);
    timer = setTimeout(() => send('update', { config: S.config }), 120);
    for (const what of renderWhat) RENDER[what]();
  }

  const segById = (id) => S.config.segments.find((s) => s.id === id);
  const cssColor = (c) => (!c ? '' : NAMED[c] || (/^#[0-9a-f]{6}$/i.test(c) ? c : /^\d+$/.test(c) ? xterm(Number(c)) : ''));

  function xterm(n) {
    if (n < 16) return Object.values(NAMED)[n % 9] || '#ccc';
    if (n >= 232) {
      const v = 8 + (n - 232) * 10;
      return `rgb(${v},${v},${v})`;
    }
    const i = n - 16;
    const c = (x) => (x ? 55 + x * 40 : 0);
    return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
  }

  function ansiToHtml(ansi) {
    let html = '';
    let style = {};
    const open = () => {
      const css = [];
      if (style.color) css.push(`color:${style.color}`);
      if (style.bold) css.push('font-weight:bold');
      if (style.dim) css.push('opacity:.6');
      return css.length ? `<span style="${css.join(';')}">` : '<span>';
    };
    const parts = ansi.split(/\x1b\[([\d;]*)m/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        if (parts[i]) html += `${open()}${esc(parts[i])}</span>`;
        continue;
      }
      const codes = parts[i] === '' ? [0] : parts[i].split(';').map(Number);
      for (let j = 0; j < codes.length; j++) {
        const c = codes[j];
        if (c === 0) style = {};
        else if (c === 1) style.bold = true;
        else if (c === 2) style.dim = true;
        else if (c === 22) style.bold = style.dim = false;
        else if (c === 39) style.color = '';
        else if (SGR_NAMED[c]) style.color = NAMED[SGR_NAMED[c]];
        else if (c === 38 && codes[j + 1] === 5) {
          style.color = xterm(codes[j + 2]);
          j += 2;
        } else if (c === 38 && codes[j + 1] === 2) {
          style.color = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`;
          j += 4;
        }
      }
    }
    return html;
  }

  // ---------- color picker ----------

  function colorPicker(key, value, allowDefault = true) {
    const swatches = Object.entries(NAMED)
      .map(([name, hex]) => `<button class="sw ${value === name ? 'on' : ''}" data-color-key="${key}" data-color="${name}" title="${name}" style="background:${hex}"></button>`)
      .join('');
    const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value : cssColorToHex(cssColor(value)) || '#ffffff';
    return `<div class="color-picker">
      ${allowDefault ? `<button class="sw none ${!value ? 'on' : ''}" data-color-key="${key}" data-color="" title="Terminal default"></button>` : ''}
      ${swatches}
      <label class="sw custom ${/^#/.test(value || '') ? 'on' : ''}" title="Custom color" style="${/^#/.test(value || '') ? `background:${value}` : ''}">
        <input type="color" data-color-key="${key}" value="${hex}">＋
      </label>
    </div>`;
  }

  function cssColorToHex(c) {
    if (!c) return '';
    if (c.startsWith('#')) return c;
    const m = c.match(/\d+/g);
    return m ? `#${m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : '';
  }

  // key: "seg:<id>" | "sep" | "warn" | "danger" | "ok" | "acct:<key>"
  function setColor(key, color) {
    const [kind, id] = key.split(/:(.*)/s);
    if (kind === 'seg') segById(id).color = color;
    else if (kind === 'sep') S.config.separatorColor = color;
    else if (kind === 'warn') S.config.thresholds.warnColor = color;
    else if (kind === 'danger') S.config.thresholds.dangerColor = color;
    else if (kind === 'ok') S.config.thresholds.okColor = color;
    else if (kind === 'acct') {
      S.config.accounts[id] = { ...(S.config.accounts[id] || {}), color };
      cleanAccount(id);
    }
  }

  function cleanAccount(key) {
    const a = S.config.accounts[key];
    if (a && !a.label && !a.color) delete S.config.accounts[key];
  }

  // ---------- rendering ----------

  function renderShell() {
    document.getElementById('app').innerHTML = `
      <header class="top">
        <div>
          <h1>Claude Code status line</h1>
          <p class="muted">The footer Claude Code shows under the prompt. Changes are saved to <code>${esc(S.configFile)}</code> and show up on the next render.</p>
        </div>
        <div class="actions">
          <select id="preset"><option value="">Load a preset…</option>${Object.entries(S.presets).map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`).join('')}</select>
          <button class="btn secondary" id="open-json">Open JSON</button>
        </div>
      </header>
      <section class="card preview-card">
        <div class="preview-head">
          <b>Preview</b>
          <span class="muted" id="preview-source"></span>
          <label class="muted">Data from <select id="preview-account"><option value="">latest session</option>${S.accounts.map((a) => `<option value="${esc(a.dir)}">${esc(a.label)}${a.email ? ` · ${esc(a.email)}` : ''}</option>`).join('')}</select></label>
        </div>
        <div class="term"><pre id="preview"></pre><pre class="term-claude">▸▸ auto mode on <span class="dim">(shift+tab to cycle)</span></pre></div>
        <div class="muted small">The last line is drawn by Claude Code itself and cannot be changed from here.</div>
      </section>
      <div class="cols">
        <div class="col">
          <section class="card">
            <h3>Layout</h3>
            <p class="muted small">Drag segments between lines to arrange them. Click one to edit it.</p>
            <div id="lines"></div>
            <h4>Available segments</h4>
            <div class="tray" data-line="0" id="tray"></div>
          </section>
          <section class="card" id="style-card"></section>
          <section class="card" id="accounts-card"></section>
        </div>
        <div class="col">
          <section class="card sticky" id="segment-card"></section>
          <section class="card" id="install-card"></section>
        </div>
      </div>`;
    wire();
  }

  const chip = (s) => `<div class="chip ${S.selected === s.id ? 'selected' : ''} ${s.join ? 'joined' : ''}" draggable="true" data-id="${s.id}" title="${esc(SEGMENTS[s.id].desc)}">
      <span class="chip-icon">${esc(s.icon || '')}</span>
      <span class="chip-dot" style="background:${cssColor(s.color) || 'transparent'}"></span>
      ${esc(SEGMENTS[s.id].name)}
      ${s.enabled ? `<button class="chip-x" data-remove="${s.id}" title="Remove from line">×</button>` : `<button class="chip-add" data-add="${s.id}" title="Add to line 1">＋</button>`}
    </div>`;

  const RENDER = {
    lines() {
      const lines = [1, 2, 3]
        .map((n) => {
          const segs = S.config.segments.filter((s) => s.enabled && Number(s.line) === n);
          return `<div class="line" data-line="${n}"><span class="line-no">Line ${n}</span>${segs.map(chip).join('') || '<span class="muted small drop-hint">Drop segments here</span>'}</div>`;
        })
        .join('');
      $('#lines').innerHTML = lines;
      const off = S.config.segments.filter((s) => !s.enabled);
      $('#tray').innerHTML = off.map(chip).join('') || '<span class="muted small">All segments are in use.</span>';
    },
    segment() {
      const s = segById(S.selected);
      if (!s) return ($('#segment-card').innerHTML = '<p class="muted">Select a segment.</p>');
      const meta = SEGMENTS[s.id];
      const opts = (meta.opts || [])
        .map((o) => {
          const def = OPTIONS[o];
          if (def.type === 'check') return `<label class="check"><input type="checkbox" data-opt="${o}" ${s[o] ? 'checked' : ''}> ${esc(def.label)}</label>`;
          if (def.type === 'select') return `<label class="field"><span>${esc(def.label)}</span><select data-opt="${o}">${def.options.map(([v, l]) => `<option value="${v}" ${s[o] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
          return `<label class="field"><span>${esc(def.label)}</span><input type="text" class="text" data-opt="${o}" value="${esc(s[o] || '')}"></label>`;
        })
        .join('');
      $('#segment-card').innerHTML = `
        <div class="seg-head">
          <div><h3>${esc(meta.name)}</h3><div class="muted small">${esc(meta.desc)}</div></div>
          <label class="switch"><input type="checkbox" data-seg="enabled" ${s.enabled ? 'checked' : ''}><span>Shown</span></label>
        </div>
        <div class="grid2">
          <label class="field"><span>Icon</span><input type="text" class="text" data-seg="icon" value="${esc(s.icon)}" placeholder="none" maxlength="4"></label>
          <label class="field"><span>Label before value</span><input type="text" class="text" data-seg="label" value="${esc(s.label)}" placeholder="none"></label>
        </div>
        <div class="icons">${ICONS.map((i) => `<button class="icon-pick" data-icon="${i}">${i}</button>`).join('')}<button class="icon-pick" data-icon="">∅</button></div>
        <div class="field"><span>Color</span>${colorPicker(`seg:${s.id}`, s.color)}</div>
        <div class="row-checks">
          <label class="check"><input type="checkbox" data-seg="bold" ${s.bold ? 'checked' : ''}> Bold</label>
          <label class="check" title="Put this right after the previous segment, without the separator"><input type="checkbox" data-seg="join" ${s.join ? 'checked' : ''}> Attach to previous (no separator)</label>
        </div>
        <label class="field"><span>Line</span><select data-seg="line">${[1, 2, 3].map((n) => `<option value="${n}" ${Number(s.line) === n ? 'selected' : ''}>Line ${n}</option>`).join('')}</select></label>
        ${opts ? `<div class="opts">${opts}</div>` : ''}`;
    },
    style() {
      const c = S.config;
      $('#style-card').innerHTML = `
        <h3>Style</h3>
        <div class="grid2">
          <label class="field"><span>Separator</span><input type="text" class="text mono" data-cfg="separator" value="${esc(c.separator)}"></label>
          <label class="field"><span>Bar width</span><input type="number" class="text" data-cfg="barWidth" min="3" max="30" value="${c.barWidth}"></label>
        </div>
        <div class="field"><span>Separator color</span>${colorPicker('sep', c.separatorColor)}</div>
        <h4>Usage colors <span class="muted small">(for segments with "Color by usage")</span></h4>
        <div class="grid2">
          <label class="field"><span>Warn from %</span><input type="number" class="text" data-thr="warn" min="1" max="100" value="${c.thresholds.warn}"></label>
          <label class="field"><span>Danger from %</span><input type="number" class="text" data-thr="danger" min="1" max="100" value="${c.thresholds.danger}"></label>
        </div>
        <div class="field"><span>Below warn <span class="muted">(default: the segment's own color)</span></span>${colorPicker('ok', c.thresholds.okColor)}</div>
        <div class="field"><span>Warn</span>${colorPicker('warn', c.thresholds.warnColor, false)}</div>
        <div class="field"><span>Danger</span>${colorPicker('danger', c.thresholds.dangerColor, false)}</div>`;
    },
    accounts() {
      // One row per real account: folders logged into the same email share a name.
      const rows = new Map();
      for (const a of S.accounts) {
        const key = a.email || a.dir;
        if (!rows.has(key)) rows.set(key, { key, email: a.email, folders: [] });
        rows.get(key).folders.push(a.label);
      }
      $('#accounts-card').innerHTML = `
        <h3>Account names & colors</h3>
        <p class="muted small">Used by the Account segment. Matched by email, so every folder logged into the same account shows the same name.</p>
        ${[...rows.values()]
          .map((r) => {
            const a = S.config.accounts[r.key] || {};
            const placeholder = r.email ? r.email.split('@')[0] : r.folders[0];
            return `<div class="acct-row">
              <div class="acct-who"><b>${esc(r.email || r.key)}</b><div class="muted small">folders: ${esc(r.folders.join(', '))}</div></div>
              <input type="text" class="text" data-acct="${esc(r.key)}" value="${esc(a.label || '')}" placeholder="${esc(placeholder)}">
              ${colorPicker(`acct:${r.key}`, a.color)}
            </div>`;
          })
          .join('')}`;
    },
    install() {
      const c = S.config.compat;
      const status = (st) =>
        st.kind === 'ctxman' ? '<span class="badge ok">Ctx Man ✓</span>' : st.kind === 'custom' ? `<span class="badge">custom</span> <code class="small">${esc(st.command)}</code>` : '<span class="badge">none</span>';
      $('#install-card').innerHTML = `
        <h3>Install</h3>
        <p class="muted small">Sets <code>statusLine</code> in each selected account's <code>settings.json</code>. The previous value is remembered, so Restore puts it back. A copy <code>settings.json.ctx-man-backup</code> is kept too.</p>
        <div class="acct-list">${S.accounts
          .map((a) => `<label class="acct-item"><input type="checkbox" data-target="${esc(a.dir)}" ${a.hidden ? '' : 'checked'}>
            <div><b>${esc(a.label)}</b>${a.hidden ? ' <span class="muted small">(hidden)</span>' : ''} <span class="muted small">${esc(a.email)}</span><div>${status(a.status)}</div></div></label>`)
          .join('')}</div>
        <h4>Keep working with your other tools</h4>
        <label class="check"><input type="checkbox" data-compat="tmuxStateFile" ${c.tmuxStateFile ? 'checked' : ''}> Write <code>/tmp/claude_state</code> for the tmux status bar</label>
        <label class="check"><input type="checkbox" data-compat="sessionSnapshots" ${c.sessionSnapshots ? 'checked' : ''}> Write per-session snapshots to <code>&lt;account&gt;/statusline/</code></label>
        <label class="check"><input type="checkbox" data-compat="disableFile" ${c.disableFile ? 'checked' : ''}> Hide when <code>~/.claude/statusline_disabled</code> exists (your <code>claude-statusline</code> toggle)</label>
        <div class="actions">
          <button class="btn" id="apply">Apply to selected</button>
          <button class="btn secondary" id="restore" ${S.accounts.some((a) => a.canRestore) ? '' : 'disabled'}>Restore previous</button>
        </div>`;
    },
  };

  function renderAll() {
    Object.values(RENDER).forEach((r) => r());
  }

  // ---------- events ----------

  function moveSegment(id, line, beforeId) {
    const list = S.config.segments;
    const seg = list.splice(list.findIndex((s) => s.id === id), 1)[0];
    seg.enabled = line > 0;
    if (line > 0) seg.line = line;
    let index = beforeId ? list.findIndex((s) => s.id === beforeId) : -1;
    if (index < 0) {
      // After the last segment of that line, or at the end.
      const last = list.map((s, i) => (s.enabled && Number(s.line) === line ? i : -1)).filter((i) => i >= 0).pop();
      index = last === undefined ? list.length : last + 1;
    }
    list.splice(index, 0, seg);
    S.selected = id;
    changed(['lines', 'segment']);
  }

  function wire() {
    const app = document.getElementById('app');

    app.addEventListener('click', (e) => {
      const t = e.target;
      const sw = t.closest('button.sw');
      if (sw) {
        setColor(sw.dataset.colorKey, sw.dataset.color);
        return changed(sectionFor(sw.dataset.colorKey));
      }
      const icon = t.closest('[data-icon]');
      if (icon) {
        segById(S.selected).icon = icon.dataset.icon;
        return changed(['lines', 'segment']);
      }
      if (t.closest('[data-remove]')) return moveSegment(t.closest('[data-remove]').dataset.remove, 0);
      if (t.closest('[data-add]')) return moveSegment(t.closest('[data-add]').dataset.add, 1);
      const c = t.closest('.chip');
      if (c) {
        S.selected = c.dataset.id;
        RENDER.lines();
        return RENDER.segment();
      }
      if (t.id === 'apply') {
        const dirs = $$('[data-target]:checked').map((i) => i.dataset.target);
        if (!dirs.length) return toast('Select at least one account', 'error');
        return send('apply', { dirs });
      }
      if (t.id === 'restore') {
        const dirs = $$('[data-target]:checked').map((i) => i.dataset.target).filter((d) => (S.accounts.find((a) => a.dir === d) || {}).canRestore);
        if (!dirs.length) return toast('Nothing to restore for the selected accounts', 'error');
        return send('restore', { dirs });
      }
      if (t.id === 'open-json') return send('openConfig');
    });

    const onInput = (e) => {
      const t = e.target;
      if (t.type === 'color' && t.dataset.colorKey) {
        setColor(t.dataset.colorKey, t.value);
        return changed(e.type === 'change' ? sectionFor(t.dataset.colorKey) : []);
      }
      const s = segById(S.selected);
      if (t.dataset.seg) {
        const k = t.dataset.seg;
        s[k] = t.type === 'checkbox' ? t.checked : k === 'line' ? Number(t.value) : t.value;
        return changed(k === 'enabled' || k === 'line' || k === 'join' || (k === 'icon' && e.type === 'change') ? ['lines'] : []);
      }
      if (t.dataset.opt) {
        s[t.dataset.opt] = t.type === 'checkbox' ? t.checked : t.value;
        return changed();
      }
      if (t.dataset.cfg) {
        S.config[t.dataset.cfg] = t.type === 'number' ? Number(t.value) || 8 : t.value;
        return changed();
      }
      if (t.dataset.thr) {
        S.config.thresholds[t.dataset.thr] = Number(t.value) || 0;
        return changed();
      }
      if (t.dataset.acct !== undefined) {
        const key = t.dataset.acct;
        S.config.accounts[key] = { ...(S.config.accounts[key] || {}), label: t.value.trim() };
        cleanAccount(key);
        return changed();
      }
      if (t.dataset.compat) {
        S.config.compat[t.dataset.compat] = t.checked;
        return changed();
      }
      if (t.id === 'preview-account' && e.type === 'change') return send('previewAccount', { dir: t.value });
      if (t.id === 'preset' && e.type === 'change' && t.value) {
        const keepAccounts = S.config.accounts;
        S.config = JSON.parse(JSON.stringify(S.presets[t.value].config));
        S.config.accounts = keepAccounts;
        t.value = '';
        changed(['lines', 'segment', 'style', 'install']);
        toast('Preset loaded. Tweak it, then Apply if it is not installed yet.', 'success');
      }
    };
    app.addEventListener('input', onInput);
    app.addEventListener('change', onInput);

    app.addEventListener('dragstart', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      S.dragId = c.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.dataset.id);
      c.classList.add('dragging');
    });
    app.addEventListener('dragend', () => {
      S.dragId = null;
      $$('.drop-over').forEach((el) => el.classList.remove('drop-over'));
      $$('.dragging').forEach((el) => el.classList.remove('dragging'));
    });
    app.addEventListener('dragover', (e) => {
      const zone = e.target.closest('[data-line]');
      if (!zone || !S.dragId) return;
      e.preventDefault();
      $$('.drop-over').forEach((el) => el.classList.remove('drop-over'));
      (e.target.closest('.chip') || zone).classList.add('drop-over');
    });
    app.addEventListener('drop', (e) => {
      const zone = e.target.closest('[data-line]');
      if (!zone || !S.dragId) return;
      e.preventDefault();
      const target = e.target.closest('.chip');
      const before = target && target.dataset.id !== S.dragId ? target.dataset.id : null;
      moveSegment(S.dragId, Number(zone.dataset.line), before);
    });
  }

  function sectionFor(colorKey) {
    if (colorKey.startsWith('seg:')) return ['lines', 'segment'];
    if (colorKey.startsWith('acct:')) return ['accounts'];
    return ['style'];
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        S.config = m.config;
        S.config.accounts = S.config.accounts || {};
        S.accounts = m.accounts;
        S.presets = m.presets;
        S.configFile = m.configFile;
        renderShell();
        renderAll();
        return;
      case 'preview':
        $('#preview').innerHTML = ansiToHtml(m.ansi);
        $('#preview-source').textContent = `· ${m.source}`;
        return;
      case 'accounts':
        S.accounts = m.accounts;
        return RENDER.install();
      case 'toast':
        return toast(m.text, m.kind);
    }
  });

  send('ready');
})();
