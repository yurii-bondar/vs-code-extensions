// Sidebar: the accounts as cards with their sessions. The extension sends the whole state whenever something changes;
// the page keeps only what is its own: the search text, which cards are collapsed and which session is open.
// Everything is drawn from HTML strings and handled by event delegation on `data-act`.
(() => {
  type State = import('../src/sidebarWire').SidebarState;
  type Card = import('../src/sidebarWire').AccountCard;
  type Row = import('../src/sidebarWire').SessionRow;
  type Message = import('../src/sidebarWire').ClientMessage;
  type Incoming = import('../src/sidebarWire').HostMessage;

  const api = acquireVsCodeApi();
  const send = (message: Message): void => api.postMessage(message);
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // ---------- what the page remembers ----------

  /** `true` or `false` once the person toggled a card; before that the active account is open and the rest are closed. */
  let expanded: Record<string, boolean> = {};
  try {
    const saved = api.getState();
    if (saved && typeof saved === 'object' && 'expanded' in saved && saved.expanded && typeof saved.expanded === 'object') expanded = { ...saved.expanded } as Record<string, boolean>;
  } catch {
    // no saved state
  }
  let state: State | undefined;
  let query = '';
  let openKey = '';

  const remember = (): void => api.setState({ expanded });
  const isOpen = (card: Card): boolean => (query ? true : (expanded[card.dir] ?? card.active));

  // ---------- small things ----------

  const ICONS: Record<string, string> = {
    chevron: '<path d="m9 6 6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
    handoff: '<path d="M12 3v12m0-12L8 7m4-4 4 4M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    hide: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a15 15 0 0 1-3 3.4M6.5 7.6A15 15 0 0 0 3 12s4 6 9 6a9 9 0 0 0 3.5-.7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    brush: '<path d="M4 20c4 0 6-2 6-5l7-9a2 2 0 0 0-3-3L5 10c-3 0-3 3-3 6s0 4 2 4z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M19 3v4M17 5h4"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4L3 9.5M3 4v5.5h5.5M4 13a8 8 0 0 0 14.5 4l2.5-2.5M21 20v-5.5h-5.5"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 5-8 3-12 7"/>',
    warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4.5M12 17.5v.1"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  };
  const icon = (name: string): string => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

  function ago(ms: number, now = Date.now()): string {
    const s = Math.max(0, (now - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ms).toLocaleDateString();
  }

  const mb = (bytes: number): string => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  const button = (act: string, label: string, ico: string, extra = '', cls = ''): string =>
    `<button class="btn ${cls}" data-act="${act}" ${extra} title="${esc(label)}" aria-label="${esc(label)}">${icon(ico)}</button>`;

  // ---------- drawing ----------

  const matches = (row: Row): boolean => {
    if (!query) return true;
    const q = query.toLowerCase();
    return [row.title, row.branch, row.project, row.lastPrompt].some((t) => t.toLowerCase().includes(q));
  };

  function sessionHtml(row: Row, card: Card): string {
    const open = openKey === row.key;
    const meta = [
      `<span>${ago(row.mtime)}</span>`,
      row.big ? `<span class="big" title="Large session: its whole context is sent again on another account">${icon('warn')}${mb(row.bytes)}</span>` : '',
      row.project && state?.allProjects ? `<span class="chip">${esc(row.project)}</span>` : '',
      row.branch ? `<span class="chip br">${icon('branch')}${esc(row.branch)}</span>` : '',
    ].join('');
    const detail = open
      ? `<div class="detail">
          ${row.lastPrompt ? `<p class="quote">${esc(row.lastPrompt)}</p>` : ''}
          <div class="actions">
            <button class="act primary" data-act="session:resume" data-key="${esc(row.key)}">${icon('play')}Resume</button>
            <button class="act" data-act="session:continue" data-key="${esc(row.key)}">${icon('swap')}Another account…</button>
            <button class="act" data-act="session:handoff" data-key="${esc(row.key)}">${icon('handoff')}Hand off</button>
            <button class="act ghost" data-act="session:copy" data-key="${esc(row.key)}">${icon('copy')}Copy ID</button>
            <button class="act ghost" data-act="session:reveal" data-key="${esc(row.key)}">${icon('file')}Reveal file</button>
          </div>
        </div>`
      : '';
    return `<li class="session${open ? ' open' : ''}">
      <button class="row" data-act="open" data-key="${esc(row.key)}" aria-expanded="${open}">
        <span class="s-title">${esc(row.title)}</span>
        <span class="s-meta">${meta}</span>
      </button>
      ${open ? '' : `<span class="quick">${button('session:resume', `Resume on ${card.label}`, 'play', `data-key="${esc(row.key)}"`, 'solid')}</span>`}
      ${detail}
    </li>`;
  }

  function cardHtml(card: Card, hasWorkspace: boolean, allProjects: boolean): string {
    const open = isOpen(card);
    const rows = card.sessions.filter(matches);
    if (query && !rows.length) return '';
    const who = [card.email, card.org].filter(Boolean).join(' · ') || (card.loggedIn ? 'signed in' : 'not logged in');
    const count = card.total ? `<span class="count" title="${card.total} session${card.total === 1 ? '' : 's'}">${card.total}</span>` : '';
    const status = card.active
      ? '<span class="pill ok">Active</span>'
      : card.loggedIn
        ? ''
        : `<span class="pill warn">${icon('warn')}Log in</span>`;
    const emptyText = allProjects || !hasWorkspace ? 'No sessions yet.' : 'No sessions in this workspace yet.';
    const body = open
      ? rows.length
        ? `<ul class="sessions">${rows.map((r) => sessionHtml(r, card)).join('')}</ul>${card.total > card.sessions.length ? `<p class="more">+ ${card.total - card.sessions.length} older</p>` : ''}`
        : `<div class="empty-row"><span>${emptyText}</span><button class="act primary" data-act="account:new" data-dir="${esc(card.dir)}">${icon('plus')}Start one</button></div>`
      : '';
    return `<section class="card h${card.hue}${card.active ? ' active' : ''}${open ? ' open' : ''}">
      <header class="head">
        <button class="toggle" data-act="toggle" data-dir="${esc(card.dir)}" aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'}">
          ${icon('chevron')}
          <span class="avatar" aria-hidden="true">${esc(card.initials)}<i class="dot ${card.active ? 'ok' : card.loggedIn ? 'idle' : 'warn'}"></i></span>
          <span class="who">
            <span class="name">${esc(card.label)}${status}${count}</span>
            <span class="mail" title="${esc(who)}">${esc(who)}</span>
          </span>
        </button>
        <span class="head-actions">
          ${card.active ? '' : `<button class="act primary sm" data-act="account:use" data-dir="${esc(card.dir)}" title="Use this account for new terminals and the Claude Code extension">Use</button>`}
          ${button('account:new', `New Claude session on ${card.label}`, 'plus', `data-dir="${esc(card.dir)}"`)}
          ${button('account:hide', `Hide ${card.label}`, 'hide', `data-dir="${esc(card.dir)}"`, 'hover')}
        </span>
      </header>
      ${body}
    </section>`;
  }

  function listHtml(): string {
    if (!state) return '<p class="loading">Loading…</p>';
    if (!state.accounts.length) {
      return `<div class="empty">
        <span class="empty-ico">${icon('spark')}</span>
        <h2>${state.hidden ? 'All accounts are hidden' : 'No Claude accounts yet'}</h2>
        <p>${state.hidden ? `${state.hidden} hidden. Show them again to see their sessions.` : 'Sign in with Claude Code once, or point this panel at a config folder.'}</p>
        ${state.hidden ? `<button class="act primary" data-act="tool:showHidden">${icon('hide')}Show hidden accounts</button>` : `<button class="act primary" data-act="tool:addAccount">${icon('user')}Add account folder</button>`}
      </div>`;
    }
    const cards = state.accounts.map((c) => cardHtml(c, state?.hasWorkspace ?? false, state?.allProjects ?? false)).join('');
    return cards || `<div class="empty"><h2>Nothing matches</h2><p>No session has “${esc(query)}”.</p></div>`;
  }

  function mount(): void {
    const app = document.getElementById('app');
    if (!app) return;
    app.innerHTML = `
      <div class="top">
        <div class="seg" role="group" aria-label="Which sessions to list">
          <button data-act="scope:workspace" aria-pressed="true">This workspace</button>
          <button data-act="scope:all" aria-pressed="false">All projects</button>
        </div>
        <div class="find">
          <label class="search">${icon('search')}<input id="q" type="search" placeholder="Search sessions" aria-label="Search sessions" autocomplete="off" spellcheck="false"></label>
          <button class="btn boxed" data-act="tool:refresh" title="Refresh" aria-label="Refresh">${icon('refresh')}</button>
        </div>
      </div>
      <main id="list"></main>
      <footer class="tools">
        <button class="tool" data-act="tool:statusline">${icon('brush')}Status line</button>
        <button class="tool" data-act="tool:aiFiles">${icon('folder')}AI files</button>
        <button class="tool" data-act="tool:addAccount">${icon('user')}Add account</button>
        <button class="tool" id="hidden" data-act="tool:showHidden" hidden>${icon('hide')}<span></span></button>
      </footer>`;
  }

  function render(): void {
    const list = document.getElementById('list');
    if (list) list.innerHTML = listHtml();
    const hiddenButton = document.getElementById('hidden');
    const hiddenCount = state?.hidden ?? 0;
    if (hiddenButton) {
      hiddenButton.hidden = !hiddenCount;
      const label = hiddenButton.querySelector('span');
      if (label) label.textContent = `${hiddenCount} hidden`;
    }
    const all = state?.allProjects ?? false;
    document.querySelector('[data-act="scope:workspace"]')?.setAttribute('aria-pressed', String(!all));
    document.querySelector('[data-act="scope:all"]')?.setAttribute('aria-pressed', String(all));
  }

  // ---------- input ----------

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-act]') : null;
    if (!target) return;
    const act = target.dataset['act'] ?? '';
    const dir = target.dataset['dir'] ?? '';
    const key = target.dataset['key'] ?? '';
    switch (act) {
      case 'toggle': {
        const card = state?.accounts.find((c) => c.dir === dir);
        if (card) expanded[dir] = !isOpen(card);
        remember();
        render();
        return;
      }
      case 'open':
        openKey = openKey === key ? '' : key;
        render();
        return;
      case 'scope:all':
      case 'scope:workspace':
        send({ type: 'scope', all: act === 'scope:all' });
        return;
      case 'account:use':
      case 'account:new':
      case 'account:hide':
        send({ type: 'account', action: act.slice('account:'.length) as 'use' | 'new' | 'hide', dir });
        return;
      case 'session:resume':
      case 'session:continue':
      case 'session:handoff':
      case 'session:copy':
      case 'session:reveal':
        send({ type: 'session', action: act.slice('session:'.length) as 'resume' | 'continue' | 'handoff' | 'copy' | 'reveal', key });
        return;
      case 'tool:statusline':
      case 'tool:aiFiles':
      case 'tool:addAccount':
      case 'tool:showHidden':
      case 'tool:refresh':
        send({ type: 'tool', tool: act.slice('tool:'.length) as 'statusline' | 'aiFiles' | 'addAccount' | 'showHidden' | 'refresh' });
        return;
      default:
        return;
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.id === 'q') {
      query = event.target.value.trim();
      render();
    }
  });

  document.addEventListener('keydown', (event) => {
    const input = document.getElementById('q');
    if (!(input instanceof HTMLInputElement)) return;
    if (event.key === '/' && document.activeElement !== input) {
      event.preventDefault();
      input.focus();
    } else if (event.key === 'Escape' && input.value) {
      input.value = '';
      query = '';
      render();
    }
  });

  window.addEventListener('message', (event: MessageEvent<Incoming>) => {
    if (event.data.type !== 'state') return;
    state = event.data.state;
    render();
  });

  mount();
  render();
  // "17m ago" goes stale while the panel sits open.
  setInterval(() => {
    if (state && !document.hidden) render();
  }, 60_000);
  send({ type: 'ready' });
})();
