// What frames the list: the editor toolbar and its Git menu (design `01`, `38`), the sidebar header (`05`), the fetch
// banner (`08`) and the toast.
import type { StateView } from '../src/protocol.js';
import { icon } from './icons.js';
import { syncButtonsHtml } from './sync-controls.js';
import type { PushPopover } from './sync-controls.js';
import { esc, fetchedAgo } from './text.js';

const fetchButton = (fetching: boolean): string =>
  `<button class="gt-icon-btn" data-action="fetch" title="Fetch" aria-label="Fetch"${fetching ? ' disabled' : ''}>${icon('refresh', fetching ? 'gt-spin' : '')}</button>`;

export function toolbarHtml(state: StateView, { menuOpen, popover }: { menuOpen: boolean; popover: PushPopover | null }): string {
  return `<div class="gt-toolbar">
  <span class="gt-toolbar__repo">${icon('folder')}${esc(state.repo?.name ?? 'Githor')}</span>
  <span class="gt-spacer"></span>
  ${state.repo ? `<span class="gt-toolbar__meta">${fetchedAgo(state.fetchedAt)}</span>${fetchButton(state.fetching)}` : ''}
  <span class="gt-menu-anchor">
    <button class="gt-icon-btn" data-action="menu" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="${menuOpen}"${state.repo ? '' : ' disabled'}>${icon('more')}</button>
    ${menuOpen ? menuHtml() : ''}
  </span>
  ${syncButtonsHtml({ state, popover, compact: false })}
</div>`;
}

/** The Git menu. Items whose screens are not built yet are left out rather than shown dead. */
function menuHtml(): string {
  const item = (action: string, glyph: string, label: string): string => `<button class="gt-menu__item" role="menuitem" data-action="${action}">${glyph}${label}</button>`;
  return `<div class="gt-menu" role="menu">
  ${item('fetchAll', icon('refresh', 'gt-i--sm'), 'Fetch all')}
  ${item('pickBranch', icon('branch', 'gt-i--sm'), 'Switch branch…')}
  ${item('newBranch', '<span class="gt-option__tick"></span>', 'New branch…')}
  <div class="gt-menu__sep" role="separator"></div>
  ${item('openMerged', icon('trash', 'gt-i--sm'), 'Delete all merged branches…')}
</div>`;
}

export function sidebarHeaderHtml(state: StateView, popover: PushPopover | null): string {
  const current = state.branches.find((b) => b.current);
  return `<div class="gt-side-head">
  <span class="gt-side-head__branch">${icon('branch')}<span>${esc(current?.name ?? state.repo?.name ?? 'No repository')}</span></span>
  ${state.repo ? fetchButton(state.fetching) : ''}
</div>
${syncButtonsHtml({ state, popover, compact: true })}`;
}

export const sidebarFooterHtml = (): string => `<button class="gt-footer-link" data-action="openEditor">${icon('file')}Open in editor</button>`;

/** Shown while the last fetch failed: the list may be behind origin. */
export function fetchBannerHtml(state: StateView): string {
  if (!state.fetchError) return '';
  const since = state.fetchedAt === null ? 'never fetched' : fetchedAgo(state.fetchedAt).replace(/^Fetched /, 'from ');
  return `<div class="gt-fetch-failed">
  <div class="gt-banner gt-banner--danger" role="alert"><span class="gt-banner__icon">${icon('warn')}</span>Could not reach origin.</div>
  <p class="gt-muted">The list below is ${since}. Sync marks may be out of date until a fetch succeeds.</p>
  <div class="gt-pane__row">
    <button class="gt-btn gt-btn--primary" data-action="fetch"${state.fetching ? ' disabled' : ''}>${icon('refresh', state.fetching ? 'gt-spin' : '')}Try again</button>
    <button class="gt-btn" data-action="showOutput">Show git output</button>
  </div>
</div>`;
}

export interface Toast {
  text: string;
  undo: number | null;
  error: boolean;
}

export function toastHtml(toast: Toast | null): string {
  if (!toast) return '';
  return `<div class="gt-toast${toast.error ? ' gt-toast--error' : ''}" role="${toast.error ? 'alert' : 'status'}">
  ${toast.error ? `<span class="gt-banner__icon">${icon('warn')}</span>` : ''}<span class="gt-toast__text">${esc(toast.text)}</span>
  ${toast.undo !== null ? `<button class="gt-link-btn" data-action="undo" data-id="${toast.undo}">Undo</button>` : ''}
  ${toast.error ? '<button class="gt-link-btn" data-action="showOutput">Show git output</button>' : ''}
  <button class="gt-icon-btn" data-action="dismissToast" title="Dismiss" aria-label="Dismiss">${icon('close', 'gt-i--sm')}</button>
</div>`;
}
