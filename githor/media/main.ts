// Githor page. The host sends the whole state; this module keeps the page's own state (filter, menu, dialog,
// toast), renders each region from HTML strings, and handles clicks by delegation on `data-action`. The filter input
// is built once and never re-rendered, so typing keeps its focus.
import type { BranchFilter } from '../src/core/marks.js';
import { BRANCH_FILTERS } from '../src/core/marks.js';
import type { HostMessage, StateView } from '../src/protocol.js';
import { filtersHtml, listHtml } from './branch-list.js';
import { fetchBannerHtml, sidebarFooterHtml, sidebarHeaderHtml, toastHtml, toolbarHtml } from './chrome.js';
import type { Toast } from './chrome.js';
import { icon } from './icons.js';
import { dialogHtml, openDialog, remoteCopies, withView } from './merged-dialog.js';
import type { MergedDialog } from './merged-dialog.js';
import { persist, post, restore } from './vscode.js';

const TOAST_MS = 10_000;
const place = document.body.dataset['place'] === 'sidebar' ? 'sidebar' : 'editor';

// ---------- state ----------

const saved = restore();
let state: StateView = { repo: null, branches: [], loaded: false, fetchedAt: null, fetching: false, fetchError: null, defaultBranch: null };
let filter: BranchFilter = BRANCH_FILTERS.includes(saved.filter ?? 'all') ? (saved.filter ?? 'all') : 'all';
let query = saved.query ?? '';
let menuOpen = false;
let dialog: MergedDialog | null = null;
let toast: Toast | null = null;
let toastTimer: number | undefined;

const keep = (): void => persist({ filter, query });

// ---------- layout ----------

const app = document.getElementById('app') as HTMLElement;
app.innerHTML = `
  <div data-region="top"></div>
  <div class="gt-list-pane">
    <div data-region="banner"></div>
    <div class="gt-pane__head">
      <label class="gt-input">${icon('search', 'gt-i--sm')}<input data-role="query" placeholder="Filter branches" aria-label="Filter branches" spellcheck="false"></label>
      <div class="gt-filters" data-region="filters"></div>
    </div>
    <div class="gt-scroll" data-region="list"></div>
    ${place === 'sidebar' ? `<div class="gt-side-foot">${sidebarFooterHtml()}</div>` : ''}
  </div>
  <div data-region="overlay"></div>
  <div data-region="toast"></div>`;

const region = (name: string): HTMLElement => app.querySelector(`[data-region="${name}"]`) as HTMLElement;
const input = app.querySelector('[data-role="query"]') as HTMLInputElement;
input.value = query;

function render(): void {
  region('top').innerHTML = place === 'sidebar' ? sidebarHeaderHtml(state) : toolbarHtml(state, menuOpen);
  region('banner').innerHTML = fetchBannerHtml(state);
  region('filters').innerHTML = state.repo && state.branches.length ? filtersHtml(state.branches, filter) : '';
  region('list').innerHTML = listHtml({ loaded: state.loaded, hasRepo: state.repo !== null, branches: state.branches, filter, query });
  region('overlay').innerHTML = dialog ? dialogHtml(dialog) : '';
  region('toast').innerHTML = toastHtml(toast);
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
  dialog = openDialog(null);
  post({ type: 'scanMerged', target: null });
}

// ---------- events ----------

input.addEventListener('input', () => {
  query = input.value;
  keep();
  render();
});

document.addEventListener('click', (event) => {
  const target = event.target as Element | null;
  const el = target?.closest<HTMLElement>('[data-action]');
  const action = el?.dataset['action'];
  // a click inside the dialog box never reaches the backdrop's close
  if (action === 'closeDialog' && el?.classList.contains('gt-backdrop') && target?.closest('[data-stop]')) return;
  const menuWasOpen = menuOpen;
  if (menuOpen && action !== 'menu') menuOpen = false;
  switch (action) {
    case 'filter':
      filter = (el?.dataset['filter'] as BranchFilter | undefined) ?? 'all';
      keep();
      break;
    case 'clearQuery':
      query = input.value = '';
      keep();
      break;
    case 'switch':
      if (el?.dataset['ref']) post({ type: 'switch', ref: el.dataset['ref'] });
      break;
    case 'fetch':
      post({ type: 'fetch', all: false });
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
      if (!dialog?.deleting) dialog = null;
      break;
    case 'deleteMerged':
      if (dialog?.view && dialog.checked.size) {
        post({ type: 'deleteMerged', target: dialog.view.target, names: [...dialog.checked], onRemote: dialog.onRemote && remoteCopies(dialog).length > 0 });
        dialog = { ...dialog, deleting: true };
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
      // Checkboxes and the select are handled on change. Re-rendering here would replace them before their change
      // event fires, so only a click that closed the menu renders.
      if (menuWasOpen) break;
      return;
  }
  render();
});

document.addEventListener('change', (event) => {
  const el = event.target as HTMLInputElement | HTMLSelectElement;
  if (!dialog) return;
  switch (el.dataset['action']) {
    case 'toggleMerged': {
      const checked = new Set(dialog.checked);
      const name = el.dataset['name'] ?? '';
      if ((el as HTMLInputElement).checked) checked.add(name);
      else checked.delete(name);
      dialog = { ...dialog, checked };
      break;
    }
    case 'toggleRemote':
      dialog = { ...dialog, onRemote: (el as HTMLInputElement).checked };
      break;
    case 'pickTarget':
      dialog = openDialog(el.value);
      post({ type: 'scanMerged', target: el.value });
      break;
    default:
      return;
  }
  render();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (dialog && !dialog.deleting) dialog = null;
  else if (menuOpen) menuOpen = false;
  else return;
  render();
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'state':
      state = message.state;
      break;
    case 'openDeleteMerged':
      openMerged();
      break;
    case 'merged':
      // an answer for a target the person has since moved away from is dropped
      if (dialog && (dialog.target === null || dialog.target === message.view.target)) dialog = withView(dialog, message.view);
      break;
    case 'mergedDone':
      dialog = null;
      break;
    case 'toast':
      showToast({ text: message.text, undo: message.undo, error: false });
      break;
    case 'error':
      // a failed check or delete leaves the dialog: it cannot go on
      dialog = null;
      showToast({ text: message.text, undo: null, error: true });
      break;
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
  render();
});

render();
post({ type: 'ready' });
