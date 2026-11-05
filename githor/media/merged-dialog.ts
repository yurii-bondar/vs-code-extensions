// "Delete all merged branches in [target]" (design `39`–`42`).
import type { MergedBranch } from '../src/core/types.js';
import type { MergedView } from '../src/protocol.js';
import { icon } from './icons.js';
import { age, esc, listing, plural } from './text.js';

export interface MergedDialog {
  /** The target being checked; null while the default branch is being picked. */
  target: string | null;
  /** The last answer from the host; null while a check runs. */
  view: MergedView | null;
  /** Names ticked for deletion. */
  checked: Set<string>;
  onRemote: boolean;
  deleting: boolean;
}

export const openDialog = (target: string | null): MergedDialog => ({ target, view: null, checked: new Set(), onRemote: false, deleting: false });

/** Every merged branch starts ticked: the dialog is the review step. */
export const withView = (dialog: MergedDialog, view: MergedView): MergedDialog => ({ ...dialog, target: view.target, view, checked: new Set(view.merged.map((b) => b.name)) });

/** The ticked branches whose copy on origin goes too, when that is asked for. */
export const remoteCopies = (dialog: MergedDialog): MergedBranch[] => (dialog.view?.merged ?? []).filter((b) => dialog.checked.has(b.name) && b.upstreamMerged);

function rowHtml(b: MergedBranch, checked: boolean): string {
  return `<label class="gt-check-row">
  <input type="checkbox" data-action="toggleMerged" data-name="${esc(b.name)}"${checked ? ' checked' : ''}>
  <span class="gt-check-row__name" title="${esc(b.name)}">${esc(b.name)}</span>
  <span class="gt-chip">${icon('laptop', 'gt-i--sm')}local</span>
  ${b.upstreamMerged ? `<span class="gt-chip" title="${esc(b.upstream ?? '')}">${icon('cloud', 'gt-i--sm')}remote</span>` : ''}
  <span class="gt-check-row__age">${age(b.committedAt)}</span>
</label>`;
}

function targetPicker(dialog: MergedDialog): string {
  const targets = dialog.view?.targets ?? (dialog.target ? [dialog.target] : []);
  const options = targets.map((t) => `<option value="${esc(t)}"${t === dialog.target ? ' selected' : ''}>${esc(t)}</option>`).join('');
  return `<span class="gt-select">${icon('chevDown', 'gt-i--sm')}<select data-action="pickTarget" aria-label="Target branch"${dialog.view ? '' : ' disabled'}>${options}</select></span>`;
}

function bodyHtml(dialog: MergedDialog, view: MergedView): string {
  const target = esc(view.target);
  const notListed = `<p class="gt-muted">Not listed: ${target}, your current branch and branches with commits that are not in ${target}.</p>`;
  const kept = view.kept.length
    ? `<p class="gt-muted">Merged but kept: ${view.kept.map((k) => `${esc(k.name)} (${esc(k.reason)})`).join('; ')}.</p>`
    : '';
  if (!view.merged.length) return `<p>No branch is fully merged into ${target}.</p>${notListed}${kept}`;

  const copies = remoteCopies(dialog).map((b) => b.name);
  const originNote = copies.length
    ? `Removes ${esc(listing(copies))} for everyone. Undo can't bring them back.`
    : 'None of the ticked branches has a merged copy on origin.';
  return `<p>These branches are fully merged into ${target}, so no commit is lost.</p>
  <div class="gt-dialog__list">${view.merged.map((b) => rowHtml(b, dialog.checked.has(b.name))).join('')}</div>
  ${notListed}${kept}
  <label class="gt-check">
    <input type="checkbox" data-action="toggleRemote"${dialog.onRemote && copies.length ? ' checked' : ''}${copies.length ? '' : ' disabled'}>
    <span>Also delete them on origin<span class="gt-check__note">${originNote}</span></span>
  </label>`;
}

export function dialogHtml(dialog: MergedDialog): string {
  const { view } = dialog;
  const n = dialog.checked.size;
  const loading = `<p class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Checking which branches are merged…</p>`;
  const deleteButton = view?.merged.length
    ? `<button class="gt-btn gt-btn--danger" data-action="deleteMerged"${n && !dialog.deleting ? '' : ' disabled'}>${dialog.deleting ? 'Deleting…' : `Delete ${plural(n, 'branch')}`}</button>`
    : '';
  return `<div class="gt-backdrop" data-action="closeDialog">
  <div class="gt-dialog" role="dialog" aria-modal="true" aria-labelledby="gt-merged-title" data-stop>
    <div class="gt-dialog__title"><h2 id="gt-merged-title">Delete all merged branches in</h2>${targetPicker(dialog)}</div>
    ${view ? bodyHtml(dialog, view) : loading}
    <div class="gt-dialog__foot">
      <button class="gt-btn gt-btn--ghost" data-action="closeDialog">${view?.merged.length ? 'Cancel' : 'Close'}</button>
      ${deleteButton}
    </div>
  </div>
</div>`;
}
