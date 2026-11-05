// Scriptor dashboard. The host sends the whole state; this page renders it from HTML strings and handles clicks
// by event delegation on `data-action`. The search box and the modal live outside the list, so re-rendering
// the list never steals focus.
(() => {
  const api = acquireVsCodeApi();
  const HUES: readonly Hue[] = ['violet', 'blue', 'cyan', 'green', 'amber', 'orange', 'rose', 'pink'];

  let groups: GroupView[] = [];
  let scripts: ScriptView[] = [];
  let loaded = false;
  let query = '';
  const collapsed = new Set<string>(api.getState()?.collapsed ?? []);

  /** What the script dialog holds; kept across a switch between a file and a command. */
  type ScriptForm = Omit<ScriptDraft, 'id'>;
  type Modal = { kind: 'script'; script: ScriptView | null; form: ScriptForm } | { kind: 'group'; group: GroupView | null };
  let modal: Modal | null = null;

  // ---------- helpers ----------

  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const basename = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

  function ago(ms: number): string {
    if (!ms) return 'Never run';
    const s = (Date.now() - ms) / 1000;
    if (s < 45) return 'Ran just now';
    if (s < 3600) return `Ran ${Math.round(s / 60)} min ago`;
    if (s < 86400) return `Ran ${Math.round(s / 3600)} h ago`;
    if (s < 7 * 86400) return `Ran ${Math.round(s / 86400)} d ago`;
    return `Ran ${new Date(ms).toLocaleDateString()}`;
  }

  const ICONS: Record<string, string> = {
    play: '<polygon points="7 4 20 12 7 20 7 4"/>',
    all: '<polygon points="4 5 11 12 4 19"/><polygon points="12 5 19 12 12 19"/>',
    script: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><polygon points="10.5 12.4 15 15.1 10.5 17.8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v4M10 13h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
    open: '<path d="M14 3h7v7M21 3l-9 9M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
    reveal: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/><path d="M3 11h18l-2 8H5Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    terminal: '<path d="m5 8 4 4-4 4M12 16h7"/>',
  };
  const icon = (name: string): string => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  const iconButton = (action: string, id: string, name: string, label: string, extra = ''): string =>
    `<button class="icon-btn ${extra}" data-action="${action}" data-id="${esc(id)}" title="${label}" aria-label="${label}">${icon(name)}</button>`;

  const persist = (): void => api.setState({ collapsed: [...collapsed] });

  // ---------- list ----------

  function matches(s: ScriptView): boolean {
    const q = query.trim().toLowerCase();
    return !q || `${s.name} ${s.description} ${s.path} ${s.command} ${s.cwd} ${s.kind.label}`.toLowerCase().includes(q);
  }

  function cardHtml(s: ScriptView): string {
    const isFile = s.type === 'file';
    const run = s.missing
      ? `<button class="run" disabled title="${isFile ? 'The file is not on disk' : 'The folder is not on disk'}">${icon('play')}Run</button>`
      : `<button class="run" data-action="run" data-id="${esc(s.id)}" title="Run in a terminal">${icon('play')}Run</button>`;
    return `<article class="card h-${s.kind.hue}${s.missing ? ' missing' : ''}">
  <div class="card-top">
    <div class="badge" aria-hidden="true">${esc(s.kind.short)}</div>
    <div class="meta">
      <h3 tabindex="0">${esc(s.name)}</h3>
      <div class="tip" role="tooltip">
        <strong>${esc(s.name)}</strong>
        ${s.description ? `<p class="tip-desc">${esc(s.description)}</p>` : ''}
        ${isFile ? `<code>${esc(s.path)}</code>` : `<code class="cmd">$ ${esc(s.command)}</code><code>${esc(s.cwd)}</code>`}
      </div>
    </div>
    <div class="tools">
      ${isFile ? iconButton('open-file', s.id, 'open', 'Open the file') : ''}
      ${iconButton('reveal', s.id, 'reveal', isFile ? 'Reveal in file manager' : 'Reveal the folder in file manager')}
      ${iconButton('edit-script', s.id, 'edit', 'Edit')}
      ${iconButton('remove-script', s.id, 'trash', 'Remove from Scriptor', 'danger')}
    </div>
  </div>
  <div class="card-foot">
    <div class="facts">
      <span class="chip">${esc(s.kind.label)}</span>
      ${s.missing ? `<span class="chip warn">${icon('alert')}Not found</span>` : `<span class="when">${esc(ago(s.lastRunAt))}</span>`}
    </div>
    ${run}
  </div>
</article>`;
  }

  function sectionHtml(opts: { id: string; title: string; hue: Hue | null; items: ScriptView[]; total: number; group: GroupView | null }): string {
    const { group, items } = opts;
    const open = !collapsed.has(opts.id) || !!query.trim();
    const head = group
      ? `<button class="fold${open ? ' open' : ''}" data-action="fold" data-id="${esc(opts.id)}" aria-expanded="${open}" aria-label="Toggle ${esc(group.name)}">${icon('chevron')}</button>
    <span class="dot"></span><h2>${esc(group.name)}</h2><span class="count">${opts.total}</span>
    <span class="spacer"></span>
    ${opts.total ? `<button class="btn tint" data-action="run-group" data-id="${esc(group.id)}" title="Open every script of the group, each in its own terminal">${icon('all')}Run all</button>` : ''}
    ${iconButton('add-script', group.id, 'plus', 'Add a script to this group')}
    ${iconButton('edit-group', group.id, 'edit', 'Edit the group')}
    ${iconButton('remove-group', group.id, 'trash', 'Remove the group', 'danger')}`
      : `<span class="dot plain"></span><h2>${esc(opts.title)}</h2><span class="count">${opts.total}</span>`;
    const body = items.length
      ? `<div class="cards">${items.map(cardHtml).join('')}</div>`
      : `<div class="hint">${group ? `No scripts in this group yet. <button class="link" data-action="add-script" data-id="${esc(group.id)}">Add one</button>` : ''}</div>`;
    return `<section class="group h-${opts.hue ?? 'slate'}">
  <div class="group-head">${head}</div>
  ${open ? body : ''}
</section>`;
  }

  function emptyHtml(): string {
    return `<div class="empty">
  <div class="empty-art" aria-hidden="true">
    <svg viewBox="0 0 220 150" width="220" height="150">
      <defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b7cf6"/><stop offset="1" stop-color="#4c9aff"/></linearGradient></defs>
      <rect x="14" y="22" width="150" height="96" rx="14" fill="url(#g1)" opacity=".16"/>
      <rect x="14" y="22" width="150" height="96" rx="14" fill="none" stroke="url(#g1)" stroke-width="2"/>
      <circle cx="30" cy="38" r="4" fill="#ef5b6b"/><circle cx="44" cy="38" r="4" fill="#e5a93d"/><circle cx="58" cy="38" r="4" fill="#3fb97a"/>
      <path d="M32 62l12 10-12 10" fill="none" stroke="url(#g1)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="54" y="78" width="46" height="5" rx="2.5" fill="url(#g1)"/><rect x="32" y="96" width="86" height="5" rx="2.5" fill="currentColor" opacity=".18"/>
      <circle cx="160" cy="104" r="30" fill="#3fb97a"/><polygon points="151 90 177 104 151 118" fill="#fff"/>
    </svg>
  </div>
  <h2>Your scripts, one click away</h2>
  <p>Add any <code>.sh</code>, <code>.js</code>, <code>.py</code> or other script, or a command like <code>npm run dev</code> in a folder, put related ones in a group, and run them in a terminal as if you had typed them yourself.</p>
  <div class="empty-actions">
    <button class="btn primary lg" data-action="add-script">${icon('plus')}Add script</button>
    <button class="btn ghost lg" data-action="add-group">${icon('folderPlus')}New group</button>
  </div>
</div>`;
  }

  function renderList(): void {
    const list = el('list');
    if (!loaded) {
      list.innerHTML = '';
      return;
    }
    el('stats').textContent = scripts.length || groups.length ? `${plural(scripts.length, 'script')} · ${plural(groups.length, 'group')}` : '';
    el('top-tools').classList.toggle('hidden', !scripts.length && !groups.length);
    if (!scripts.length && !groups.length) {
      list.innerHTML = emptyHtml();
      return;
    }
    const searching = !!query.trim();
    const parts: string[] = [];
    for (const group of groups) {
      const all = scripts.filter((s) => s.groupId === group.id);
      const items = all.filter(matches);
      if (searching && !items.length) continue;
      parts.push(sectionHtml({ id: group.id, title: group.name, hue: group.hue, items, total: all.length, group }));
    }
    const loose = scripts.filter((s) => !s.groupId);
    const looseItems = loose.filter(matches);
    if (looseItems.length) parts.push(sectionHtml({ id: '_loose', title: groups.length ? 'Ungrouped' : 'Scripts', hue: null, items: looseItems, total: loose.length, group: null }));
    list.innerHTML = parts.length ? parts.join('') : `<div class="empty small">${icon('search')}<p>Nothing matches “${esc(query.trim())}”.</p></div>`;
  }

  // ---------- modal ----------

  function field(label: string, control: string, note = ''): string {
    return `<div class="field"><label>${label}${note ? `<i>${note}</i>` : ''}</label>${control}</div>`;
  }

  function formOf(script: ScriptView | null, groupId: string | null): ScriptForm {
    if (!script) return { type: 'file', name: '', path: '', command: '', description: '', groupId, interpreter: '', args: '', cwd: '' };
    const { type, name, path, command, description, interpreter, args, cwd } = script;
    return { type, name, path, command, description, groupId: script.groupId, interpreter, args, cwd };
  }

  /** The dialog as filled in; fields the current layout does not show keep what the form had. */
  function readForm(form: ScriptForm): ScriptForm {
    const read = (id: string, fallback: string): string => document.getElementById(id) instanceof HTMLInputElement ? value(id) : fallback;
    return {
      type: form.type,
      name: value('f-name'),
      path: read('f-path', form.path),
      command: read('f-command', form.command),
      description: el<HTMLTextAreaElement>('f-description').value,
      groupId: value('f-group') || null,
      interpreter: read('f-interpreter', form.interpreter),
      args: read('f-args', form.args),
      cwd: value('f-cwd'),
    };
  }

  const namePlaceholder = (form: Pick<ScriptForm, 'type' | 'path' | 'command'>): string =>
    form.type === 'file' ? basename(form.path) || 'Defaults to the file name' : form.command.trim() || 'Defaults to the command';

  const folderField = (form: ScriptForm, label: string, placeholder: string, note: string): string =>
    field(label, `<div class="row"><input id="f-cwd" type="text" spellcheck="false" autocomplete="off" placeholder="${placeholder}" value="${esc(form.cwd)}"><button class="btn ghost" data-action="browse-folder">${icon('folder')}Browse…</button></div>`, note);

  function scriptModalHtml(script: ScriptView | null, form: ScriptForm): string {
    const isFile = form.type === 'file';
    const detected = script?.type === 'file' && script.path === form.path ? (script.detected ? `Detected: ${esc(script.detected)}` : 'Runs the file itself') : 'Picked by the file extension';
    const groupOptions = [`<option value="">No group</option>`, ...groups.map((g) => `<option value="${esc(g.id)}"${g.id === form.groupId ? ' selected' : ''}>${esc(g.name)}</option>`)].join('');
    const advanced = !!(form.interpreter || form.args || form.cwd);
    const tab = (type: ScriptType, label: string, name: string): string =>
      `<button class="${form.type === type ? 'on' : ''}" data-action="set-type" data-id="${type}" aria-pressed="${form.type === type}">${icon(name)}${label}</button>`;
    const what = isFile
      ? field('Script file', `<div class="row"><input id="f-path" type="text" spellcheck="false" autocomplete="off" placeholder="/path/to/script.sh   or   ~/bin/backup.py" value="${esc(form.path)}"><button class="btn ghost" data-action="browse-file">${icon('folder')}Browse…</button></div>`)
      : `${field('Command', `<input id="f-command" class="mono" type="text" spellcheck="false" autocomplete="off" placeholder="npm run dev   or   docker compose up -d" value="${esc(form.command)}">`)}
  ${folderField(form, 'Folder', '/path/to/project   or   ~/code/app', 'runs here')}`;
    const subtitle = isFile ? 'Choose a file on this computer, or type its path.' : 'Any command line, run in the folder you choose.';
    return `<div class="modal-head">
  <div class="modal-ico">${icon(script ? 'edit' : 'plus')}</div>
  <div><h2 id="modal-title">${script ? 'Edit script' : 'Add script'}</h2><p>${script ? 'Change how this script is shown and run.' : subtitle}</p></div>
  <button class="icon-btn" data-action="close" aria-label="Close">${icon('close')}</button>
</div>
<div class="modal-body">
  <div class="seg" role="group" aria-label="What to run">${tab('file', 'Script file', 'script')}${tab('command', 'Command', 'terminal')}</div>
  ${what}
  ${field('Name', `<input id="f-name" type="text" autocomplete="off" placeholder="${esc(namePlaceholder(form))}" value="${esc(form.name)}">`, 'optional')}
  ${field('Description', `<textarea id="f-description" rows="2" placeholder="What does this script do?">${esc(form.description)}</textarea>`, 'optional')}
  ${field('Group', `<div class="select"><select id="f-group">${groupOptions}</select>${icon('chevron')}</div>`)}
  ${
    isFile
      ? `<details class="adv"${advanced ? ' open' : ''}>
    <summary>${icon('chevron')}Advanced</summary>
    ${field('Interpreter', `<input id="f-interpreter" type="text" spellcheck="false" autocomplete="off" placeholder="${detected}" value="${esc(form.interpreter)}">`, 'optional')}
    ${field('Arguments', `<input id="f-args" type="text" spellcheck="false" autocomplete="off" placeholder="--env prod --verbose" value="${esc(form.args)}">`, 'optional')}
    ${folderField(form, 'Working directory', 'The folder of the script', 'optional')}
  </details>`
      : ''
  }
</div>
<div class="modal-foot">
  <button class="btn ghost" data-action="close">Cancel</button>
  <button class="btn primary" data-action="save">${icon('check')}${script ? 'Save changes' : 'Save script'}</button>
</div>`;
  }

  function groupModalHtml(group: GroupView | null): string {
    const hue = group?.hue ?? HUES[groups.length % HUES.length] ?? 'violet';
    const swatches = HUES.map((h) => `<label class="swatch h-${h}" title="${h}"><input type="radio" name="hue" value="${h}"${h === hue ? ' checked' : ''}><span>${icon('check')}</span></label>`).join('');
    return `<div class="modal-head">
  <div class="modal-ico">${icon(group ? 'edit' : 'folderPlus')}</div>
  <div><h2 id="modal-title">${group ? 'Edit group' : 'New group'}</h2><p>Keep related scripts together and run them all at once.</p></div>
  <button class="icon-btn" data-action="close" aria-label="Close">${icon('close')}</button>
</div>
<div class="modal-body">
  ${field('Name', `<input id="f-name" type="text" autocomplete="off" placeholder="Deploy, Backups, Dev stack…" value="${esc(group?.name ?? '')}">`)}
  ${field('Color', `<div class="swatches">${swatches}</div>`)}
</div>
<div class="modal-foot">
  <button class="btn ghost" data-action="close">Cancel</button>
  <button class="btn primary" data-action="save">${icon('check')}${group ? 'Save changes' : 'Create group'}</button>
</div>`;
  }

  function openModal(next: Modal): void {
    modal = next;
    const root = el('modal-root');
    root.innerHTML = `<div class="overlay" data-action="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">${
      next.kind === 'script' ? scriptModalHtml(next.script, next.form) : groupModalHtml(next.group)
    }</div></div>`;
    const first = el<HTMLInputElement>(next.kind === 'group' ? 'f-name' : next.form.type === 'file' ? 'f-path' : 'f-command');
    first.focus();
    first.select();
  }

  function closeModal(): void {
    modal = null;
    el('modal-root').innerHTML = '';
  }

  const value = (id: string): string => el<HTMLInputElement>(id).value;

  function save(): void {
    if (!modal) return;
    if (modal.kind === 'script') {
      api.postMessage({ type: 'saveScript', draft: { id: modal.script?.id ?? null, ...readForm(modal.form) } });
    } else {
      const hue = HUES.find((h) => h === document.querySelector<HTMLInputElement>('input[name="hue"]:checked')?.value) ?? 'violet';
      api.postMessage({ type: 'saveGroup', draft: { id: modal.group?.id ?? null, name: value('f-name'), hue } });
    }
  }

  // ---------- toasts ----------

  function toast(kind: 'ok' | 'error', text: string): void {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.innerHTML = `${icon(kind === 'error' ? 'alert' : 'check')}<span>${esc(text)}</span>`;
    el('toasts').appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  // ---------- events ----------

  const actions: Record<string, (target: HTMLElement) => void> = {
    'add-script': (t) => openModal({ kind: 'script', script: null, form: formOf(null, t.dataset['id'] ?? null) }),
    'add-group': () => openModal({ kind: 'group', group: null }),
    'edit-script': (t) => {
      const script = scripts.find((s) => s.id === t.dataset['id']);
      if (script) openModal({ kind: 'script', script, form: formOf(script, null) });
    },
    'edit-group': (t) => {
      const group = groups.find((g) => g.id === t.dataset['id']);
      if (group) openModal({ kind: 'group', group });
    },
    run: (t) => api.postMessage({ type: 'run', id: t.dataset['id'] ?? '' }),
    'run-group': (t) => api.postMessage({ type: 'runGroup', id: t.dataset['id'] ?? '' }),
    'open-file': (t) => api.postMessage({ type: 'openFile', id: t.dataset['id'] ?? '' }),
    reveal: (t) => api.postMessage({ type: 'reveal', id: t.dataset['id'] ?? '' }),
    'remove-script': (t) => api.postMessage({ type: 'removeScript', id: t.dataset['id'] ?? '' }),
    'remove-group': (t) => api.postMessage({ type: 'removeGroup', id: t.dataset['id'] ?? '' }),
    'browse-file': () => api.postMessage({ type: 'pick', target: 'file' }),
    'browse-folder': () => api.postMessage({ type: 'pick', target: 'folder' }),
    'set-type': (t) => {
      const type = t.dataset['id'] === 'command' ? 'command' : 'file';
      if (modal?.kind === 'script' && modal.form.type !== type) openModal({ ...modal, form: { ...readForm(modal.form), type } });
    },
    fold: (t) => {
      const id = t.dataset['id'] ?? '';
      if (!collapsed.delete(id)) collapsed.add(id);
      persist();
      renderList();
    },
    save,
    close: closeModal,
  };

  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-action]') : null;
    if (!target) return;
    const action = target.dataset['action'] ?? '';
    // The backdrop closes the dialog only when it is itself what was clicked, not something inside it.
    if (action === 'backdrop') {
      if (e.target === target) closeModal();
      return;
    }
    actions[action]?.(target);
  });

  document.addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.id === 'f-path') el<HTMLInputElement>('f-name').placeholder = namePlaceholder({ type: 'file', path: e.target.value, command: '' });
    if (e.target instanceof HTMLInputElement && e.target.id === 'f-command') el<HTMLInputElement>('f-name').placeholder = namePlaceholder({ type: 'command', path: '', command: e.target.value });
    if (e.target instanceof HTMLInputElement && e.target.id === 'q') {
      query = e.target.value;
      renderList();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal) closeModal();
    else if (e.key === 'Enter' && modal && e.target instanceof HTMLInputElement && e.target.type === 'text') save();
    else if (e.key === '/' && !modal && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      el('q').focus();
    }
  });

  window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
    const m = e.data;
    switch (m.type) {
      case 'state':
        groups = m.groups;
        scripts = m.scripts;
        loaded = true;
        renderList();
        return;
      case 'picked':
        if (m.target === 'file') {
          el<HTMLInputElement>('f-path').value = m.path;
          el<HTMLInputElement>('f-name').placeholder = basename(m.path);
        } else {
          el<HTMLInputElement>('f-cwd').value = m.path;
        }
        return;
      case 'addScript':
        return openModal({ kind: 'script', script: null, form: formOf(null, m.groupId) });
      case 'addGroup':
        return openModal({ kind: 'group', group: null });
      case 'editScript': {
        const script = scripts.find((s) => s.id === m.id);
        return script ? openModal({ kind: 'script', script, form: formOf(script, null) }) : undefined;
      }
      case 'editGroup': {
        const group = groups.find((g) => g.id === m.id);
        return group ? openModal({ kind: 'group', group }) : undefined;
      }
      case 'saved':
        closeModal();
        return;
      case 'toast':
        toast(m.kind, m.text);
        return;
      default: {
        const unreachable: never = m;
        return unreachable;
      }
    }
  });

  // ---------- boot ----------

  el('app').innerHTML = `<header class="top">
  <div class="brand">
    <div class="logo" aria-hidden="true">${icon('script')}</div>
    <div><h1>Scriptor</h1><p id="stats">Your scripts, one click away</p></div>
  </div>
  <div id="top-tools" class="top-tools hidden">
    <label class="search">${icon('search')}<input id="q" type="text" placeholder="Search scripts   ( / )" autocomplete="off" spellcheck="false" aria-label="Search scripts"></label>
    <button class="btn ghost" data-action="add-group">${icon('folderPlus')}New group</button>
    <button class="btn primary" data-action="add-script">${icon('plus')}Add script</button>
  </div>
</header>
<main id="list"></main>
<div id="modal-root"></div>
<div id="toasts" aria-live="polite"></div>`;

  // "Ran 5 min ago" ages while the page stays open; skip it while something in the list has focus.
  setInterval(() => !modal && !el('list').contains(document.activeElement) && renderList(), 30000);
  api.postMessage({ type: 'ready' });
})();
