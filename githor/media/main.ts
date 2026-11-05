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
import { commitListHtml, emptyCommit } from './commit-view.js';
import type { CommitState } from './commit-view.js';
import { diffFilesHtml, diffPaneHtml } from './diff-view.js';
import { pushReviewHtml } from './push-review.js';
import type { PushReview } from './push-review.js';
import { nextTicked } from '../src/core/commit-groups.js';
import type { Resolution } from '../src/core/conflict.js';
import { compareHtml } from './compare-view.js';
import { defaultMessage, squashRailHtml } from './squash-view.js';
import { emptyStash, stashDialogHtml, stashRailHtml } from './stash-view.js';
import type { StashDialog, StashState } from './stash-view.js';
import type { SquashState } from './squash-view.js';
import type { CompareState } from './compare-view.js';
import { conflictPaneHtml, conflictRailHtml, emptyConflict } from './conflict-view.js';
import type { ConflictState } from './conflict-view.js';
import type { DiffState } from './diff-view.js';
import { emptyLog, LOG_PAGE, logHeadHtml, logRowsHtml } from './commit-log.js';
import type { LogState } from './commit-log.js';
import { fetchBannerHtml, sidebarFooterHtml, sidebarHeaderHtml, toastHtml, toolbarHtml } from './chrome.js';
import type { Tab, Toast } from './chrome.js';
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
let state: StateView = { repo: null, branches: [], loaded: false, fetchedAt: null, fetching: false, fetchError: null, defaultBranch: null, busy: null, head: null, working: [], grouping: 'none', operation: null, stashes: 0 };
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
/** The side-by-side diff (`02`) that replaces the log while a file is open. */
let diffView: DiffState | null = null;
let tab: Tab = 'log';
let commit: CommitState = emptyCommit();
/** The working-copy file open beside the commit list. */
let commitDiff: DiffState | null = null;
/** The push screen (`10`), over the tabs while open. */
let pushReview: PushReview | null = null;
let pushDiff: DiffState | null = null;
const WORKTREE = 'WORKTREE';
/** The compare screen (`03`), over the log and details while open. */
let compare: CompareState | null = null;
/** The conflict screens (`23`–`29`): the editor tab shows them while a merge or rebase is paused. */
let conflict: ConflictState = emptyConflict();
/** After Edit again on a resolved file: reopen it, then edit this conflict with this text. */
/** The squash screen (`12`), over the tabs while open. */
let squashView: SquashState | null = null;
let squashDiff: DiffState | null = null;
/** The Stash tab (`09`) and its dialogs. */
let stash: StashState = emptyStash();
let stashDiff: DiffState | null = null;
let stashDialog: StashDialog | null = null;
let pendingEdit: { path: string; index: number; text: string } | null = null;

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
    <section class="gt-pane gt-compare-pane" aria-label="Compare with remote" data-region="compare" hidden></section>
  </div>
  <div class="gt-body gt-body--diff gt-body--conflict" hidden>
    <section class="gt-pane gt-pane--rail" aria-label="Files of the merge" data-region="conflictRail"></section>
    <section class="gt-pane" aria-label="Conflict" data-region="conflictPane"></section>
  </div>
  <div class="gt-body gt-body--diff" hidden>
    <section class="gt-pane gt-pane--rail" aria-label="Changed files" data-region="diffFiles"></section>
    <section class="gt-pane" aria-label="Diff" data-region="diffPane"></section>
  </div>
  <div class="gt-body gt-body--diff gt-body--commit" hidden>
    <section class="gt-pane gt-pane--rail" aria-label="Changes to commit" data-region="commitList"></section>
    <section class="gt-pane" aria-label="Diff" data-region="commitDiff"></section>
  </div>
  <div class="gt-body gt-body--diff gt-body--stash" hidden>
    <section class="gt-pane gt-pane--rail" aria-label="Stashes" data-region="stashRail"></section>
    <section class="gt-pane" aria-label="Diff" data-region="stashDiff"></section>
  </div>
  <div class="gt-body gt-body--diff gt-body--squash" hidden>
    <section class="gt-pane gt-pane--rail" aria-label="Commits to squash" data-region="squashRail"></section>
    <section class="gt-pane" aria-label="Diff" data-region="squashDiff"></section>
  </div>
  <div class="gt-body gt-body--diff gt-body--push" hidden>
    <section class="gt-pane gt-pane--rail" aria-label="Commits to push" data-region="pushList"></section>
    <section class="gt-pane" aria-label="Diff" data-region="pushDiff"></section>
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
  if (stashDialog) return stashDialogHtml(stashDialog);
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

  fill('top', place === 'sidebar' ? sidebarHeaderHtml(state, popover) : toolbarHtml(state, { menuOpen, popover, tab }));
  fill('banner', fetchBannerHtml(state, place));
  fill('filters', state.repo && state.branches.length ? filtersHtml(state.branches, filter) : '');
  const selectedRef = place === 'editor' ? (highlighted()?.ref ?? null) : undefined;
  fill('list', listHtml({ loaded: state.loaded, hasRepo: state.repo !== null, branches: state.branches, filter, query, busy: state.busy, menuRef: branchMenu?.ref ?? null, ...(selectedRef === undefined ? {} : { selectedRef }) }));
  if (place === 'editor') {
    renderLog();
    renderBodies();
  }
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

/** Which set of panes the editor tab shows: the push screen over everything, else the tab, the log's diff inside Log. */
function renderBodies(): void {
  const view = state.operation ? 'conflict' : squashView ? 'squash' : pushReview ? 'push' : tab === 'commit' ? 'commit' : tab === 'stash' ? 'stash' : diffView ? 'diff' : 'log';
  // the commit and push bodies share the diff body's grid class, so the plain diff body is matched as the first one
  const show = (cls: string, on: boolean): void => {
    const body = app.querySelector<HTMLElement>(`.gt-body--${cls}`);
    if (body) body.hidden = !on;
  };
  show('log', view === 'log');
  show('diff', view === 'diff');
  show('commit', view === 'commit');
  show('push', view === 'push');
  show('conflict', view === 'conflict');
  show('squash', view === 'squash');
  show('stash', view === 'stash');
  if (view === 'stash') {
    fill('stashRail', stashRailHtml(stash, { changes: state.working.filter((f) => !f.conflicted).length }));
    fill('stashDiff', stashDiff ? diffPaneHtml(stashDiff, { before: 'Last commit (HEAD)', after: 'Stashed version' }) : '<div class="gt-empty"><span>Pick a stash and one of its files.</span></div>');
  }
  if (view === 'squash' && squashView) {
    fill('squashRail', squashRailHtml(squashView, { branch: state.branches.find((b) => b.current)?.name ?? 'HEAD', me: log.me }));
    const base = squashView.plan?.baseShort;
    fill('squashDiff', squashDiff ? diffPaneHtml(squashDiff, { before: base ? `Before: ${base}` : 'Before: nothing (the first commit)', after: 'After squash' }) : '<div class="gt-empty"><span>Pick a file to see the squashed change.</span></div>');
  }
  // the compare screen takes the log's and details' place, beside the branch list
  for (const name of ['log', 'logHead', 'details']) {
    const el = region(name)?.closest<HTMLElement>('.gt-pane');
    if (el) el.hidden = compare !== null;
  }
  const comparePane = region('compare');
  if (comparePane) comparePane.hidden = compare === null;
  if (compare) fill('compare', compareHtml(compare, { me: log.me, current: state.branches.find((b) => b.current)?.name ?? null, defaultBranch: state.defaultBranch, busy: state.busy !== null }));
  if (view === 'conflict' && state.operation) {
    fill('conflictRail', conflictRailHtml(state.operation, conflict));
    fill('conflictPane', conflictPaneHtml(state.operation, conflict));
  }
  if (view === 'diff' && diffView) {
    fill('diffFiles', diffFilesHtml(diffView, details.get(diffView.sha)));
    fill('diffPane', diffPaneHtml(diffView));
  }
  if (view === 'commit') {
    fill('commitList', commitListHtml(state, commit));
    fill('commitDiff', commitDiff ? diffPaneHtml(commitDiff, { before: 'Last commit (HEAD)', after: 'Your working copy' }) : '<div class="gt-empty"><span>Pick a file to see its changes.</span></div>');
  }
  if (view === 'push' && pushReview) {
    const branch = branchOf(pushReview.ref)?.name ?? '';
    fill('pushList', pushReviewHtml(pushReview, { branch, me: log.me, busy: state.busy !== null }));
    fill('pushDiff', pushDiff ? diffPaneHtml(pushDiff) : '<div class="gt-empty"><span>Pick a file to see what it changes.</span></div>');
  }
  // HTML has no attribute for a half-ticked box
  for (const el of app.querySelectorAll<HTMLInputElement>('input[data-mixed]')) el.indeterminate = true;
}

function openCompare(ref: string): void {
  compare = { ref, view: null, confirmForce: false };
  diffView = null;
  tab = 'log';
  post({ type: 'compare', ref });
}

function selectConflictFile(path: string): void {
  conflict = { ...conflict, path, parts: null, choices: [], editing: null, draft: '' };
  if (state.operation?.conflicted.includes(path)) post({ type: 'conflictFile', path });
}

/** Records a choice; when every conflict of the file has one, the file is written and marked resolved. */
function choose(index: number, resolution: Resolution): void {
  const choices = [...conflict.choices];
  choices[index] = resolution;
  conflict = { ...conflict, choices, editing: null };
  const parts = conflict.parts;
  const path = conflict.path;
  if (!parts || !path || choices.length < parts.filter((p) => p.kind === 'conflict').length || choices.some((c) => !c)) return;
  const all = choices as Resolution[];
  const resolved = new Map(conflict.resolved).set(path, { parts, choices: all });
  conflict = { ...conflict, resolved };
  post({ type: 'resolveConflict', path, resolutions: all });
}

/** Back to choosing one conflict of a file: a resolved file is put back in conflict first. */
function reopen(index: number, edit: string | null): void {
  const path = conflict.path;
  if (!path) return;
  const kept = conflict.resolved.get(path);
  if (kept && !state.operation?.conflicted.includes(path)) {
    const resolved = new Map(conflict.resolved);
    resolved.delete(path);
    const choices: (Resolution | null)[] = [...kept.choices];
    choices[index] = null;
    conflict = { ...conflict, resolved, parts: null, choices };
    if (edit !== null) pendingEdit = { path, index, text: edit };
    post({ type: 'reopenConflict', path });
    return;
  }
  const choices = [...conflict.choices];
  choices[index] = null;
  conflict = { ...conflict, choices, editing: edit === null ? null : index, draft: edit ?? '' };
}

function selectStashFile(sha: string, path: string): void {
  const file = stash.list?.find((s) => s.sha === sha)?.files.find((f) => f.path === path);
  if (!file) return;
  stash = { ...stash, file: path };
  stashDiff = { sha, path, diff: null };
  post({ type: 'stashDiff', sha, file });
}

function selectStash(sha: string): void {
  stash = { ...stash, selected: sha, file: null };
  stashDiff = null;
  const first = stash.list?.find((s) => s.sha === sha)?.files[0];
  if (first) selectStashFile(sha, first.path);
}

function openSquash(): void {
  // the branch's order, oldest last in the list: the host sorts them, the page only passes the selection
  squashView = { shas: [...log.selected], plan: null, message: '', selected: null, busy: false };
  squashDiff = null;
  post({ type: 'squashPlan', shas: squashView.shas });
}

function selectSquashFile(path: string): void {
  const plan = squashView?.plan;
  const newest = plan?.commits[0];
  const file = plan?.files.find((f) => f.path === path);
  if (!squashView || !plan || !newest || !file) return;
  squashView = { ...squashView, selected: path };
  squashDiff = { sha: newest.sha, path, diff: null };
  post({ type: 'fileDiff', sha: newest.sha, parent: plan.base, file });
}

function openPushReview(ref: string): void {
  pushReview = { ref, commits: null, to: '', creates: false, selected: null };
  pushDiff = null;
  post({ type: 'pushReview', ref });
}

function selectWorking(path: string): void {
  commit = { ...commit, selected: path };
  commitDiff = { sha: WORKTREE, path, diff: null };
  post({ type: 'workingDiff', path });
}

/** Opens one file of a commit side by side and asks for it. */
function openFile(sha: string, path: string): void {
  const d = details.get(sha);
  const file = d?.files.find((f) => f.path === path);
  if (!d || !file) return;
  diffView = { sha, path, diff: null };
  post({ type: 'fileDiff', sha, parent: d.parent, file });
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

/** Keeps the conflict screens on a file of the operation, and reads its conflicts when they are not read yet. */
function followOperation(): void {
  const op = state.operation;
  if (!op) {
    if (conflict.path) conflict = emptyConflict();
    return;
  }
  const files = [...op.conflicted, ...op.staged];
  if (!conflict.path || !files.includes(conflict.path)) {
    const first = op.conflicted[0] ?? op.staged[0];
    if (first) selectConflictFile(first);
    return;
  }
  if (op.conflicted.includes(conflict.path) && conflict.parts === null) post({ type: 'conflictFile', path: conflict.path });
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

/** A stash's name: kept as typed; Rename follows whether it is empty. */
app.addEventListener('input', (event) => {
  const field = event.target as HTMLInputElement;
  if (field.dataset['role'] !== 'stashName' || !stashDialog) return;
  const was = stashDialog.message.trim() === '';
  stashDialog = { ...stashDialog, message: field.value };
  if (stashDialog.kind === 'rename' && was !== (field.value.trim() === '')) render();
});

/** The squash's message: kept as typed; the button follows whether it is empty. */
app.addEventListener('input', (event) => {
  const field = event.target as HTMLTextAreaElement;
  if (field.dataset['role'] !== 'squashMessage' || !squashView) return;
  const was = squashView.message.trim() === '';
  squashView = { ...squashView, message: field.value };
  if (was !== (field.value.trim() === '')) render();
});

/** A conflict's result written by hand: kept as typed; the Reset button shows once it differs. */
app.addEventListener('input', (event) => {
  const field = event.target as HTMLTextAreaElement;
  if (field.dataset['role'] !== 'conflictDraft') return;
  conflict = { ...conflict, draft: field.value };
});

/** The commit message: kept as typed, and the buttons follow whether it is empty. */
app.addEventListener('input', (event) => {
  const field = event.target as HTMLTextAreaElement;
  if (field.dataset['role'] !== 'commitMessage') return;
  const was = commit.message.trim() === '';
  commit = { ...commit, message: field.value };
  if (was !== (field.value.trim() === '')) render();
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
  if ((action === 'closeDialog' || action === 'closeBranchDialog' || action === 'closeStashDialog') && el?.classList.contains('gt-backdrop') && target?.closest('[data-stop]')) return;
  const closedSomething = menuOpen || branchMenu !== null || popover !== null || commit.groupMenu;
  if (commit.groupMenu && action !== 'groupMenu' && !target?.closest('[data-stop]')) commit = { ...commit, groupMenu: false };
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
    case 'openDiff':
    case 'openFileDiff':
      openFile(el?.dataset['sha'] ?? '', el?.dataset['path'] ?? '');
      break;
    case 'openInEditorDiff': {
      const d = diffView && details.get(diffView.sha);
      const file = d?.files.find((f) => f.path === diffView?.path);
      if (d && file) post({ type: 'openDiff', sha: d.sha, parent: d.parent, file });
      return;
    }
    case 'backToLog':
      diffView = null;
      break;
    case 'tabLog':
      tab = 'log';
      break;
    case 'tabStash':
      tab = 'stash';
      post({ type: 'stashes' });
      break;
    case 'selectStash':
      selectStash(el?.dataset['sha'] ?? '');
      break;
    case 'stashFile':
      selectStashFile(el?.dataset['sha'] ?? '', el?.dataset['path'] ?? '');
      break;
    case 'stashApply':
      post({ type: 'stashApply', sha: el?.dataset['sha'] ?? '' });
      break;
    case 'stashDrop':
      post({ type: 'stashDrop', sha: el?.dataset['sha'] ?? '' });
      break;
    case 'stashRename': {
      const s0 = stash.list?.find((s) => s.sha === el?.dataset['sha']);
      if (s0) stashDialog = { kind: 'rename', sha: s0.sha, message: s0.message, busy: false };
      break;
    }
    case 'stashChanges':
      menuOpen = false;
      stashDialog = { kind: 'push', message: '', includeUntracked: false, paths: null, busy: false };
      break;
    case 'stashTicked': {
      const paths = state.working.filter((f) => commit.ticked.has(f.path) && !f.conflicted).map((f) => f.path);
      if (paths.length) stashDialog = { kind: 'push', message: '', includeUntracked: true, paths, busy: false };
      break;
    }
    case 'stashDialogDo':
      if (stashDialog?.kind === 'push') post({ type: 'stashPush', message: stashDialog.message.trim(), paths: stashDialog.paths, includeUntracked: stashDialog.includeUntracked });
      else if (stashDialog?.kind === 'rename' && stashDialog.message.trim()) post({ type: 'stashRename', sha: stashDialog.sha, message: stashDialog.message.trim() });
      if (stashDialog) stashDialog = { ...stashDialog, busy: true };
      break;
    case 'closeStashDialog':
      if (!stashDialog?.busy) stashDialog = null;
      break;
    case 'openSquash':
      openSquash();
      break;
    case 'squashFile':
      selectSquashFile(el?.dataset['path'] ?? '');
      break;
    case 'squashNow':
      if (squashView?.plan && !squashView.plan.problem && squashView.message.trim()) {
        post({ type: 'squash', shas: squashView.shas, message: squashView.message.trim() });
        squashView = { ...squashView, busy: true };
      }
      break;
    case 'closeSquash':
      if (!squashView?.busy) {
        squashView = null;
        squashDiff = null;
      }
      break;
    case 'compare':
      if (place === 'editor') openCompare(ref);
      else post({ type: 'compare', ref });
      break;
    case 'closeCompare':
      compare = null;
      break;
    case 'rebaseRemote':
    case 'mergeRemote':
      post({ type: 'bringTogether', ref, how: action === 'rebaseRemote' ? 'rebase' : 'merge' });
      compare = null;
      break;
    case 'askForceCompare':
      if (compare) compare = { ...compare, confirmForce: true };
      break;
    case 'cancelForceCompare':
      if (compare) compare = { ...compare, confirmForce: false };
      break;
    case 'forcePushCompare':
      post({ type: 'push', ref, force: true, tags: false });
      compare = null;
      break;
    case 'selectConflictFile':
      selectConflictFile(el?.dataset['path'] ?? '');
      break;
    case 'accept': {
      const take = el?.dataset['take'];
      if (take === 'local' || take === 'remote' || take === 'both') choose(Number(el?.dataset['index']), { take });
      break;
    }
    case 'editResult': {
      const index = Number(el?.dataset['index']);
      const part = conflict.parts?.filter((p) => p.kind === 'conflict')[index];
      conflict = { ...conflict, editing: index, draft: part && part.kind === 'conflict' ? part.local.join('\n') : '' };
      break;
    }
    case 'cancelEdit':
      conflict = { ...conflict, editing: null };
      break;
    case 'resetEdit': {
      const part = conflict.editing === null ? undefined : conflict.parts?.filter((p) => p.kind === 'conflict')[conflict.editing];
      conflict = { ...conflict, draft: part && part.kind === 'conflict' ? part.local.join('\n') : '' };
      break;
    }
    case 'saveEdit':
      choose(Number(el?.dataset['index']), { take: 'edit', text: conflict.draft });
      break;
    case 'changeChoice':
      reopen(Number(el?.dataset['index']), null);
      break;
    case 'editAgain': {
      const index = Number(el?.dataset['index']);
      const kept = conflict.path ? conflict.resolved.get(conflict.path)?.choices[index] : conflict.choices[index];
      reopen(index, kept?.take === 'edit' ? kept.text : '');
      break;
    }
    case 'continueOperation':
      post({ type: 'continueOperation' });
      break;
    case 'abortOperation':
      post({ type: 'abortOperation' });
      break;
    case 'tabCommit': {
      tab = 'commit';
      const first = state.working.find((f) => !f.conflicted);
      if (!commit.selected && first) selectWorking(first.path);
      break;
    }
    case 'selectWorking':
      selectWorking(el?.dataset['path'] ?? '');
      break;
    case 'groupMenu':
      commit = { ...commit, groupMenu: !commit.groupMenu };
      break;
    case 'groupDirectory':
    case 'ungroup':
      commit = { ...commit, groupMenu: false };
      post({ type: 'setGrouping', grouping: action === 'groupDirectory' ? 'directory' : 'none' });
      break;
    case 'commitNow':
    case 'commitAndPush': {
      const paths = state.working.filter((f) => commit.ticked.has(f.path) && !f.conflicted).map((f) => f.path);
      if (paths.length && commit.message.trim()) {
        post({ type: 'commit', paths, message: commit.message.trim(), push: action === 'commitAndPush' });
        commit = { ...commit, committing: true };
      }
      break;
    }
    case 'reviewFile': {
      const c = pushReview?.commits?.find((x) => x.sha === el?.dataset['sha']);
      const file = c?.files.find((f) => f.path === el?.dataset['path']);
      if (pushReview && c && file) {
        pushReview = { ...pushReview, selected: { sha: c.sha, path: file.path } };
        pushDiff = { sha: c.sha, path: file.path, diff: null };
        post({ type: 'fileDiff', sha: c.sha, parent: c.parent, file });
      }
      break;
    }
    case 'pushReviewed':
      if (pushReview) post(pushReview.creates ? { type: 'publish', ref: pushReview.ref } : { type: 'push', ref: pushReview.ref, force: false, tags: false });
      pushReview = null;
      pushDiff = null;
      break;
    case 'closePushReview':
      pushReview = null;
      pushDiff = null;
      break;
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
    case 'pushNow':
      // the editor tab reviews first (design `10`); the sidebar has no room for that and pushes
      if (place === 'editor') openPushReview(ref);
      else post({ type: 'push', ref, force: false, tags: false });
      break;
    case 'push':
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
    case 'toggleStashUntracked':
      if (stashDialog?.kind === 'push') stashDialog = { ...stashDialog, includeUntracked: checked };
      return;
    case 'tickFile':
    case 'tickGroup': {
      const paths: unknown = el.dataset['action'] === 'tickFile' ? [el.dataset['path']] : JSON.parse(el.dataset['paths'] ?? '[]');
      const ticked = new Set(commit.ticked);
      for (const p of Array.isArray(paths) ? paths : []) {
        if (typeof p !== 'string') continue;
        if (checked) ticked.add(p);
        else ticked.delete(p);
      }
      commit = { ...commit, ticked };
      break;
    }
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
  if (event.key === 'Enter' && ['branchName', 'stashName'].includes((event.target as HTMLElement).dataset['role'] ?? '')) {
    app.querySelector<HTMLButtonElement>('[data-role="submit"]:not(:disabled)')?.click();
    return;
  }
  if (event.key !== 'Escape') return;
  if (stashDialog && !stashDialog.busy) stashDialog = null;
  else if (mergedDialog && !mergedDialog.deleting) mergedDialog = null;
  else if (branchDialog && !branchDialog.busy) branchDialog = null;
  else if (commit.groupMenu) commit = { ...commit, groupMenu: false };
  else if (conflict.editing !== null) conflict = { ...conflict, editing: null };
  else if (compare && !popover && !branchMenu && !menuOpen) compare = null;
  else if (squashView && !squashView.busy && !popover && !branchMenu && !menuOpen) squashView = null;
  else if (pushReview && !popover && !branchMenu && !menuOpen) pushReview = null;
  else if (diffView && !popover && !branchMenu && !menuOpen) diffView = null;
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
      if (place === 'editor' && tab === 'stash' && (stash.list?.length ?? -1) !== message.state.stashes) post({ type: 'stashes' });
      refreshLog();
      followOperation();
      commit = { ...commit, ticked: nextTicked({ files: state.working, ticked: commit.ticked, known: commit.known }), known: new Set(state.working.map((f) => f.path)) };
      if (commit.selected && !state.working.some((f) => f.path === commit.selected)) {
        commit = { ...commit, selected: null };
        commitDiff = null;
      } else if (commit.selected && tab === 'commit') {
        // the file may have changed since its diff was read
        post({ type: 'workingDiff', path: commit.selected });
      }
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
    case 'fileDiff': {
      const { diff } = message;
      const matches = (v: DiffState | null): v is DiffState => v !== null && v.sha === diff.sha && v.path === diff.path;
      if (matches(diffView)) diffView = { ...diffView, diff };
      if (matches(commitDiff)) commitDiff = { ...commitDiff, diff };
      if (matches(pushDiff)) pushDiff = { ...pushDiff, diff };
      if (matches(squashDiff)) squashDiff = { ...squashDiff, diff };
      if (matches(stashDiff)) stashDiff = { ...stashDiff, diff };
      break;
    }
    case 'squashPlan':
      if (squashView && squashView.shas.join() === message.shas.join()) {
        squashView = { ...squashView, plan: message.plan, message: squashView.message || defaultMessage(message.plan) };
        const first = message.plan.files[0];
        if (first && !message.plan.problem) selectSquashFile(first.path);
      }
      break;
    case 'stashes': {
      stash = { ...stash, list: message.stashes };
      const still = message.stashes.some((s) => s.sha === stash.selected);
      if (!still) {
        stash = { ...stash, selected: null, file: null };
        stashDiff = null;
        const first = message.stashes[0];
        if (first) selectStash(first.sha);
      }
      break;
    }
    case 'stashDone':
      stashDialog = null;
      break;
    case 'squashDone':
      squashView = null;
      squashDiff = null;
      log = { ...log, selected: [] };
      break;
    case 'openCompare':
      openCompare(message.ref);
      break;
    case 'compare':
      if (compare?.ref === message.view.ref) compare = { ...compare, view: message.view };
      break;
    case 'conflictFile':
      if (conflict.path === message.path) {
        const count = message.parts.filter((p) => p.kind === 'conflict').length;
        const choices = conflict.choices.length === count ? conflict.choices : new Array<Resolution | null>(count).fill(null);
        conflict = { ...conflict, parts: message.parts, choices };
        if (pendingEdit?.path === message.path) {
          conflict = { ...conflict, editing: pendingEdit.index, draft: pendingEdit.text };
          pendingEdit = null;
        }
      }
      break;
    case 'committed':
      commit = { ...commit, committing: false, message: '', selected: null };
      commitDiff = null;
      if (message.push && message.ref) openPushReview(message.ref);
      break;
    case 'pushReview':
      if (pushReview?.ref === message.ref) {
        pushReview = { ...pushReview, commits: message.commits, to: message.to, creates: message.creates };
        const first = message.commits[0];
        const file = first?.files[0];
        if (first && file) {
          pushReview = { ...pushReview, selected: { sha: first.sha, path: file.path } };
          pushDiff = { sha: first.sha, path: file.path, diff: null };
          post({ type: 'fileDiff', sha: first.sha, parent: first.parent, file });
        }
      }
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
      commit = { ...commit, committing: false };
      if (squashView) squashView = { ...squashView, busy: false };
      if (stashDialog) stashDialog = { ...stashDialog, busy: false };
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
