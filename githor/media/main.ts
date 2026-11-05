// Githor page. The host sends the whole state; this module keeps the page's own state (filter, menus, dialogs,
// toast), renders each region from HTML strings, and handles clicks by delegation on `data-action`. The filter input
// is built once and never re-rendered; a dialog's name field gets its focus and caret back after a render.
import type { BranchFilter } from '../src/core/marks.js';
import { BRANCH_FILTERS } from '../src/core/marks.js';
import { reachable } from '../src/core/graph.js';
import type { CommitDetails } from '../src/core/types.js';
import type { HostMessage, StateView } from '../src/protocol.js';
import { branchDialogHtml, namePrefix } from './branch-dialogs.js';
import type { BranchDialog } from './branch-dialogs.js';
import { filtersHtml, listHtml } from './branch-list.js';
import { branchMenuHtml } from './branch-menu.js';
import type { BranchMenu } from './branch-menu.js';
import { detailsHtml } from './commit-details.js';
import { emptyLog, LOG_PAGE, logHeadHtml, logRowsHtml } from './commit-log.js';
import type { LogState } from './commit-log.js';
import { fetchBannerHtml, sidebarFooterHtml, sidebarHeaderHtml, toastHtml, toolbarHtml } from './chrome.js';
import type { Toast } from './chrome.js';
import { icon } from './icons.js';
import { dialogHtml, openDialog, remoteCopies, withView } from './merged-dialog.js';
import type { MergedDialog } from './merged-dialog.js';
import type { PushPopover } from './sync-controls.js';
import { persist, post, restore } from './vscode.js';

const TOAST_MS = 10_000;
const NAME_CHECK_MS = 150;
const place = document.body.dataset['place'] === 'sidebar' ? 'sidebar' : 'editor';

// ---------- state ----------

const saved = restore();
let state: StateView = { repo: null, branches: [], loaded: false, fetchedAt: null, fetching: false, fetchError: null, defaultBranch: null, busy: null, head: null };
let filter: BranchFilter = BRANCH_FILTERS.includes(saved.filter ?? 'all') ? (saved.filter ?? 'all') : 'all';
let query = saved.query ?? '';
/** The Git menu under `⋯` in the toolbar. */
let menuOpen = false;
let branchMenu: BranchMenu | null = null;
let popover: PushPopover | null = null;
let mergedDialog: MergedDialog | null = null;
let branchDialog: BranchDialog | null = null;
let toast: Toast | null = null;
let toastTimer: number | undefined;
let nameTimer: number | undefined;
/** The editor tab's log and details (`01`); the sidebar has neither. */
let log: LogState = emptyLog();
const details = new Map<string, CommitDetails>();
/** The branch highlighted in the log; null means the current branch. */
let highlightRef: string | null = null;
/** What the loaded log was read for: HEAD and every branch tip. A change asks for the log again. */
let logFor = '';

const keep = (): void => persist({ filter, query });
const branchOf = (ref: string): StateView['branches'][number] | undefined => state.branches.find((b) => b.ref === ref);

// ---------- layout ----------

const app = document.getElementById('app') as HTMLElement;
const listPane = `
    <div data-region="banner"></div>
    <div class="gt-pane__head">
      <label class="gt-input">${icon('search', 'gt-i--sm')}<input data-role="query" placeholder="Filter or create a branch" aria-label="Filter or create a branch" spellcheck="false"></label>
      <div class="gt-filters" data-region="filters"></div>
    </div>
    <div class="gt-scroll" data-region="list"></div>`;
app.innerHTML =
  place === 'sidebar'
    ? `<div data-region="top"></div>
  <div class="gt-list-pane">${listPane}<div class="gt-side-foot">${sidebarFooterHtml()}</div></div>
  <div data-region="overlay"></div>
  <div data-region="toast"></div>`
    : `<div data-region="top"></div>
  <div class="gt-body gt-body--log">
    <section class="gt-pane gt-pane--rail gt-list-pane" aria-label="Branches">${listPane}</section>
    <section class="gt-pane" aria-label="Commits"><div class="gt-pane__head" data-region="logHead"></div><div class="gt-scroll" data-region="log"></div></section>
    <section class="gt-pane gt-details" aria-label="Commit details" data-region="details"></section>
  </div>
  <div data-region="overlay"></div>
  <div data-region="toast"></div>`;

const region = (name: string): HTMLElement | null => app.querySelector(`[data-region="${name}"]`);
const fill = (name: string, html: string): void => {
  const el = region(name);
  if (el) el.innerHTML = html;
};
const input = app.querySelector('[data-role="query"]') as HTMLInputElement;
input.value = query;

function overlayHtml(): string {
  if (mergedDialog) return dialogHtml(mergedDialog);
  if (branchDialog) return branchDialogHtml(branchDialog, state.branches);
  const branch = branchMenu && branchOf(branchMenu.ref);
  return branch ? branchMenuHtml(branch, { defaultBranch: state.defaultBranch }) : '';
}

function render(): void {
  // a field inside a re-rendered region keeps its focus and caret
  const active = document.activeElement as HTMLInputElement | null;
  const role = active?.dataset?.['role'] && active.dataset['role'] !== 'query' ? active.dataset['role'] : null;
  const caret = role ? [active?.selectionStart ?? null, active?.selectionEnd ?? null] : null;

  fill('top', place === 'sidebar' ? sidebarHeaderHtml(state, popover) : toolbarHtml(state, { menuOpen, popover }));
  fill('banner', fetchBannerHtml(state));
  fill('filters', state.repo && state.branches.length ? filtersHtml(state.branches, filter) : '');
  const selectedRef = place === 'editor' ? (highlighted()?.ref ?? null) : undefined;
  fill('list', listHtml({ loaded: state.loaded, hasRepo: state.repo !== null, branches: state.branches, filter, query, busy: state.busy, menuRef: branchMenu?.ref ?? null, ...(selectedRef === undefined ? {} : { selectedRef }) }));
  if (place === 'editor') renderLog();
  fill('overlay', overlayHtml());
  fill('toast', toastHtml(toast));

  placeBranchMenu();
  if (role) {
    const field = app.querySelector<HTMLInputElement>(`[data-role="${role}"]`);
    field?.focus();
    if (field && caret?.[0] != null && caret[1] != null) field.setSelectionRange(caret[0], caret[1]);
  }
}

/** The branch highlighted in the log: the one picked in the list, else the current one. */
function highlighted(): StateView['branches'][number] | undefined {
  return (highlightRef ? branchOf(highlightRef) : undefined) ?? state.branches.find((b) => b.current);
}

function renderLog(): void {
  const commits = log.commits ?? [];
  const branch = highlighted();
  const highlight = branch ? { name: branch.name, reach: reachable(commits, branch.sha) } : null;
  fill('logHead', state.repo ? logHeadHtml({ log, highlight }) : '');
  fill('log', state.repo ? logRowsHtml({ log, head: state.head, highlight }) : '');
  const onHead = state.head ? reachable(commits, state.head) : new Set<string>();
  fill('details', state.repo ? detailsHtml({ selected: log.selected, commits, details, me: log.me, head: state.head, onHead, current: state.branches.find((b) => b.current)?.name ?? null }) : '');
}

/** Asks for the log again when HEAD or a branch tip moved since it was read. */
function refreshLog(): void {
  if (place !== 'editor' || !state.repo) return;
  const key = [state.head ?? '', ...state.branches.map((b) => `${b.ref}=${b.sha}`)].join(' ');
  if (key === logFor) return;
  logFor = key;
  post({ type: 'log', limit: log.limit });
}

/** Asks for the details of selected commits not read yet. */
function loadDetails(): void {
  const missing = log.selected.filter((sha) => !details.has(sha));
  if (missing.length) post({ type: 'commitDetails', shas: missing });
}

/** The branch menu sits under its `⋯`, inside the window. Set through the CSSOM: the page allows no inline styles. */
function placeBranchMenu(): void {
  const menu = app.querySelector<HTMLElement>('[data-role="branchMenu"]');
  if (!menu || !branchMenu) return;
  const left = Math.max(8, Math.min(branchMenu.x - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8));
  const below = branchMenu.y + 4;
  const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, branchMenu.y - 28 - menu.offsetHeight) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function showToast(next: Toast): void {
  toast = next;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast = null;
    render();
  }, TOAST_MS);
}

function openMerged(): void {
  menuOpen = false;
  mergedDialog = openDialog(null);
  post({ type: 'scanMerged', target: null });
}

function openNewBranch({ start, name }: { start: string; name?: string }): void {
  const from = branchOf(start);
  branchDialog = { kind: 'new', name: name ?? namePrefix(from?.name ?? ''), start, switchTo: true, problem: null, busy: false };
  if (name) post({ type: 'checkName', name });
}

function checkNameSoon(name: string): void {
  clearTimeout(nameTimer);
  nameTimer = window.setTimeout(() => post({ type: 'checkName', name }), NAME_CHECK_MS);
}

// ---------- events ----------

input.addEventListener('input', () => {
  query = input.value;
  keep();
  render();
});

/** Searching the log re-renders the rows; the field keeps its focus and caret. */
app.addEventListener('input', (event) => {
  const field = event.target as HTMLInputElement;
  if (field.dataset['role'] !== 'logQuery') return;
  log = { ...log, query: field.value };
  render();
});

/** Typing a branch name: the state follows the field without a render, the check answers later. */
app.addEventListener('input', (event) => {
  const field = event.target as HTMLInputElement;
  if (field.dataset['role'] !== 'branchName' || !branchDialog || branchDialog.kind === 'delete') return;
  branchDialog = { ...branchDialog, name: field.value };
  checkNameSoon(field.value);
});

/** Clicks that act on one branch: from its row, its menu or one of its dialogs. Returns false for anything else. */
function branchClick(action: string, ref: string, el: HTMLElement): boolean {
  const branch = branchOf(ref);
  switch (action) {
    case 'branchMenu': {
      if (branchMenu?.ref === ref) {
        branchMenu = null;
        return true;
      }
      const rect = el.getBoundingClientRect();
      branchMenu = { ref, x: rect.right, y: rect.bottom };
      return true;
    }
    case 'newBranchFrom':
      openNewBranch({ start: ref });
      return true;
    case 'newBranch':
      menuOpen = false;
      openNewBranch({ start: state.branches.find((b) => b.current)?.ref ?? state.branches[0]?.ref ?? '' });
      return true;
    case 'createFromQuery':
      openNewBranch({ start: state.branches.find((b) => b.current)?.ref ?? '', name: query.trim() });
      return true;
    case 'renameBranch':
      if (branch) branchDialog = { kind: 'rename', ref, name: branch.name, onRemote: Boolean(branch.upstream && branch.sync !== 'gone'), problem: null, busy: false };
      return true;
    case 'deleteBranchAsk':
      if (branch) {
        branchDialog = { kind: 'delete', ref, info: branch.local ? null : { mergedInto: null, local: [], remote: [] }, onRemote: false, busy: false };
        if (branch.local) post({ type: 'deleteInfo', ref });
      }
      return true;
    case 'pin':
    case 'unpin':
      post({ type: 'pin', ref, pinned: action === 'pin' });
      return true;
    case 'copyName':
      if (branch) post({ type: 'copyName', name: branch.local ? branch.name : (branch.upstream ?? branch.name) });
      return true;
    case 'syncBranch':
      post({ type: 'sync', ref });
      return true;
    case 'createBranch':
      if (branchDialog?.kind === 'new') {
        post({ type: 'newBranch', name: branchDialog.name.trim(), start: branchDialog.start, switchTo: branchDialog.switchTo });
        branchDialog = { ...branchDialog, busy: true };
      }
      return true;
    case 'renameBranchDo':
      if (branchDialog?.kind === 'rename') {
        post({ type: 'rename', ref: branchDialog.ref, to: branchDialog.name.trim(), onRemote: branchDialog.onRemote });
        branchDialog = { ...branchDialog, busy: true };
      }
      return true;
    case 'deleteBranchDo':
      if (branchDialog?.kind === 'delete') {
        post({ type: 'deleteBranch', ref: branchDialog.ref, onRemote: branchDialog.onRemote });
        branchDialog = { ...branchDialog, busy: true };
      }
      return true;
    case 'closeBranchDialog':
      if (!branchDialog?.busy) branchDialog = null;
      return true;
    default:
      return false;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target as Element | null;
  const el = target?.closest<HTMLElement>('[data-action]');
  const action = el?.dataset['action'] ?? '';
  // a click inside a dialog box never reaches its backdrop's close
  if ((action === 'closeDialog' || action === 'closeBranchDialog') && el?.classList.contains('gt-backdrop') && target?.closest('[data-stop]')) return;
  const closedSomething = menuOpen || branchMenu !== null || popover !== null;
  if (menuOpen && action !== 'menu') menuOpen = false;
  if (branchMenu && action !== 'branchMenu') branchMenu = null;
  if (popover && !target?.closest('[data-stop]') && action !== 'pushMenu' && action !== 'publishCard') popover = null;
  const ref = el?.dataset['ref'] ?? '';
  if (el && branchClick(action, ref, el)) {
    render();
    return;
  }
  switch (action) {
    case 'selectCommit': {
      const sha = el?.dataset['sha'] ?? '';
      const adding = event.metaKey || event.ctrlKey;
      const selected = adding ? (log.selected.includes(sha) ? log.selected.filter((s) => s !== sha) : [...log.selected, sha]) : [sha];
      log = { ...log, selected };
      loadDetails();
      break;
    }
    case 'selectBranch':
      highlightRef = ref;
      break;
    case 'onlyMine':
      log = { ...log, onlyMine: !log.onlyMine };
      break;
    case 'moreCommits':
      log = { ...log, limit: log.limit + LOG_PAGE };
      post({ type: 'log', limit: log.limit });
      break;
    case 'switchCommit':
      post({ type: 'switchCommit', sha: el?.dataset['sha'] ?? '' });
      break;
    case 'cherryPick':
      post({ type: 'cherryPick', shas: [el?.dataset['sha'] ?? ''] });
      break;
    case 'cherryPickAll':
      post({ type: 'cherryPick', shas: log.selected });
      break;
    case 'revert':
      post({ type: 'revert', sha: el?.dataset['sha'] ?? '' });
      break;
    case 'copySha':
      post({ type: 'copyName', name: el?.dataset['sha'] ?? '' });
      break;
    case 'openDiff': {
      const d = details.get(el?.dataset['sha'] ?? '');
      const file = d?.files.find((f) => f.path === el?.dataset['path']);
      if (d && file) post({ type: 'openDiff', sha: d.sha, parent: d.parent, file });
      return;
    }
    case 'filter':
      filter = (el?.dataset['filter'] as BranchFilter | undefined) ?? 'all';
      keep();
      break;
    case 'clearQuery':
      query = input.value = '';
      keep();
      break;
    case 'switch':
      post({ type: 'switch', ref });
      break;
    case 'fetch':
      post({ type: 'fetch', all: false });
      break;
    case 'pull':
      post({ type: 'pull', ref });
      break;
    case 'sync':
      post({ type: 'sync', ref: null });
      break;
    case 'push':
    case 'pushNow':
      post({ type: 'push', ref, force: false, tags: false });
      break;
    case 'publish':
      popover = null;
      post({ type: 'publish', ref });
      break;
    case 'pushMenu':
      popover = popover?.ref === ref && popover.mode === 'menu' ? null : { ref, mode: 'menu', force: false, tags: false, removes: null };
      break;
    case 'publishCard':
      popover = popover?.ref === ref && popover.mode === 'publish' ? null : { ref, mode: 'publish', force: false, tags: false, removes: null };
      break;
    case 'pushOption':
      if (popover) popover = { ...popover, force: el?.dataset['force'] === 'true' };
      break;
    case 'pushChosen':
      if (popover) post({ type: 'push', ref, force: false, tags: popover.tags });
      popover = null;
      break;
    case 'confirmForce':
      if (popover) {
        popover = { ...popover, mode: 'confirm', removes: null };
        post({ type: 'forceInfo', ref });
      }
      break;
    case 'forcePush':
      if (popover) post({ type: 'push', ref, force: true, tags: popover.tags });
      popover = null;
      break;
    case 'closePopover':
      popover = null;
      break;
    case 'fetchAll':
      post({ type: 'fetch', all: true });
      break;
    case 'pickBranch':
      post({ type: 'pickBranch' });
      break;
    case 'openEditor':
      post({ type: 'openEditor' });
      break;
    case 'showOutput':
      post({ type: 'showOutput' });
      break;
    case 'menu':
      menuOpen = !menuOpen;
      break;
    case 'openMerged':
      openMerged();
      break;
    case 'closeDialog':
      if (!mergedDialog?.deleting) mergedDialog = null;
      break;
    case 'deleteMerged':
      if (mergedDialog?.view && mergedDialog.checked.size) {
        post({ type: 'deleteMerged', target: mergedDialog.view.target, names: [...mergedDialog.checked], onRemote: mergedDialog.onRemote && remoteCopies(mergedDialog).length > 0 });
        mergedDialog = { ...mergedDialog, deleting: true };
      }
      break;
    case 'undo':
      if (el?.dataset['id']) post({ type: 'undo', id: Number(el.dataset['id']) });
      toast = null;
      break;
    case 'dismissToast':
      toast = null;
      break;
    default:
      // Checkboxes and selects are handled on change. Re-rendering here would replace them before their change event
      // fires, so only a click that closed a menu renders.
      if (closedSomething) break;
      return;
  }
  render();
});

document.addEventListener('change', (event) => {
  const el = event.target as HTMLInputElement | HTMLSelectElement;
  const checked = (el as HTMLInputElement).checked;
  switch (el.dataset['action']) {
    case 'toggleTags':
      if (popover) popover = { ...popover, tags: checked };
      return;
    case 'pickStart':
      if (branchDialog?.kind === 'new') branchDialog = { ...branchDialog, start: el.value };
      return;
    case 'toggleSwitchTo':
      if (branchDialog?.kind === 'new') branchDialog = { ...branchDialog, switchTo: checked };
      return;
    case 'toggleRenameRemote':
      if (branchDialog?.kind === 'rename') branchDialog = { ...branchDialog, onRemote: checked };
      return;
    case 'toggleDeleteRemote':
      if (branchDialog?.kind === 'delete') branchDialog = { ...branchDialog, onRemote: checked };
      break;
    case 'toggleMerged':
      if (mergedDialog) {
        const names = new Set(mergedDialog.checked);
        if (checked) names.add(el.dataset['name'] ?? '');
        else names.delete(el.dataset['name'] ?? '');
        mergedDialog = { ...mergedDialog, checked: names };
      }
      break;
    case 'toggleRemote':
      if (mergedDialog) mergedDialog = { ...mergedDialog, onRemote: checked };
      break;
    case 'pickTarget':
      mergedDialog = openDialog(el.value);
      post({ type: 'scanMerged', target: el.value });
      break;
    default:
      return;
  }
  render();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.target as HTMLElement).dataset['role'] === 'branchName') {
    app.querySelector<HTMLButtonElement>('[data-role="submit"]:not(:disabled)')?.click();
    return;
  }
  if (event.key !== 'Escape') return;
  if (mergedDialog && !mergedDialog.deleting) mergedDialog = null;
  else if (branchDialog && !branchDialog.busy) branchDialog = null;
  else if (popover) popover = null;
  else if (branchMenu) branchMenu = null;
  else if (menuOpen) menuOpen = false;
  else return;
  render();
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'state':
      state = message.state;
      if (branchMenu && !branchOf(branchMenu.ref)) branchMenu = null;
      if (highlightRef && !branchOf(highlightRef)) highlightRef = null;
      refreshLog();
      break;
    case 'log': {
      const known = new Set(message.commits.map((c) => c.sha));
      const kept = log.selected.filter((sha) => known.has(sha));
      // the first read selects the commit checked out, as the design opens
      const selected = log.commits === null && !kept.length && state.head && known.has(state.head) ? [state.head] : kept;
      log = { ...log, commits: message.commits, hasMore: message.hasMore, me: message.me, selected };
      loadDetails();
      break;
    }
    case 'commitDetails':
      for (const d of message.details) details.set(d.sha, d);
      break;
    case 'openDeleteMerged':
      openMerged();
      break;
    case 'merged':
      // an answer for a target the person has since moved away from is dropped
      if (mergedDialog && (mergedDialog.target === null || mergedDialog.target === message.view.target)) mergedDialog = withView(mergedDialog, message.view);
      break;
    case 'mergedDone':
      mergedDialog = null;
      break;
    case 'branchDone':
      branchDialog = null;
      break;
    case 'nameCheck':
      if (branchDialog && branchDialog.kind !== 'delete' && branchDialog.name === message.name) branchDialog = { ...branchDialog, problem: message.problem };
      else return;
      break;
    case 'deleteInfo':
      if (branchDialog?.kind === 'delete' && branchDialog.ref === message.ref) branchDialog = { ...branchDialog, info: { mergedInto: message.mergedInto, local: message.local, remote: message.remote } };
      break;
    case 'toast':
      showToast({ text: message.text, undo: message.undo, error: false });
      break;
    case 'forceInfo':
      if (popover?.ref === message.ref && popover.mode === 'confirm') popover = { ...popover, removes: { count: message.count, authors: message.authors } };
      break;
    case 'error':
      // the merged dialog cannot go on after a failed check; a branch dialog stays, to be corrected or cancelled
      mergedDialog = null;
      if (branchDialog) branchDialog = { ...branchDialog, busy: false };
      showToast({ text: message.text, undo: null, error: true });
      break;
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
  render();
});

window.addEventListener('resize', () => {
  if (branchMenu) {
    branchMenu = null;
    render();
  }
});

render();
post({ type: 'ready' });
