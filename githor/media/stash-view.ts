// The Stash tab (design `09`): the stashes, the selected one opened with its files, Apply, Rename and Delete; and the
// dialogs to stash changes and to rename a stash (not drawn in the design, built like the branch dialogs).
import type { StashView } from '../src/core/types.js';
import { icon } from './icons.js';
import { age, esc, plural } from './text.js';

export interface StashState {
  list: StashView[] | null;
  /** The stash opened in the list. */
  selected: string | null;
  /** The file of it open on the right. */
  file: string | null;
}

export const emptyStash = (): StashState => ({ list: null, selected: null, file: null });

export type StashDialog =
  | { kind: 'push'; message: string; includeUntracked: boolean; paths: string[] | null; busy: boolean }
  | { kind: 'rename'; sha: string; message: string; busy: boolean };

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

function itemHtml(s: StashView, st: StashState): string {
  const open = st.selected === s.sha;
  const head = `<button class="gt-stash${open ? ' is-selected' : ''}" data-action="selectStash" data-sha="${esc(s.sha)}">
  <span class="gt-stash__name">${esc(s.message)}</span>
  <span class="gt-detail__meta">On ${esc(s.branch || 'no branch')} · ${age(s.createdAt)} ago · ${plural(s.files.length, 'file', 'files')}</span>
</button>`;
  if (!open) return head;
  const files = s.files
    .map((f) => {
      const st2 = f.status === 'A' || f.status === 'D' ? f.status : 'M';
      const stat = f.binary ? '' : `<span class="gt-file__stat"><span class="gt-plus">+${f.add}</span> <span class="gt-minus">−${f.del}</span></span>`;
      return `<button class="gt-file gt-file--nested${st.file === f.path ? ' is-selected' : ''}" data-action="stashFile" data-sha="${esc(s.sha)}" data-path="${esc(f.path)}"><span class="gt-file__st gt-file__st--${st2}">${f.status}</span><span class="gt-file__path" title="${esc(f.path)}">${esc(nameOf(f.path))} <span class="gt-file__dir">${esc(dirOf(f.path))}</span></span>${stat}</button>`;
    })
    .join('');
  return `${head}${files}
<div class="gt-stash__actions">
  <p class="gt-muted">Apply puts these changes back into your working copy on the checked-out branch and keeps the stash.</p>
  <div class="gt-pane__row">
    <button class="gt-btn gt-btn--primary" data-action="stashApply" data-sha="${esc(s.sha)}">Apply</button>
    <button class="gt-btn" data-action="stashRename" data-sha="${esc(s.sha)}">Rename</button>
    <button class="gt-btn gt-btn--danger" data-action="stashDrop" data-sha="${esc(s.sha)}">Delete</button>
  </div>
</div>`;
}

export function stashRailHtml(st: StashState, { changes }: { changes: number }): string {
  const list = st.list;
  if (!list) return `<div class="gt-empty"><span class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Reading the stashes…</span></div>`;
  const head = `<div class="gt-pane__head gt-commit-head"><span class="gt-section-title">${plural(list.length, 'stash', 'stashes')}</span><span class="gt-spacer"></span>
  <button class="gt-btn" data-action="stashChanges"${changes ? '' : ' disabled title="Nothing to stash: the working tree is clean."'}>${icon('folder', 'gt-i--sm')}Stash changes…</button></div>`;
  if (!list.length) return `${head}<div class="gt-empty">${icon('folder')}<span class="gt-empty__title">No stashes</span><span>Stash changes to put them aside and get a clean working copy.</span></div>`;
  return `${head}<div class="gt-scroll">${list.map((s) => itemHtml(s, st)).join('')}</div>`;
}

export function stashDialogHtml(d: StashDialog): string {
  const isPush = d.kind === 'push';
  const title = isPush ? (d.paths ? `Stash ${plural(d.paths.length, 'file', 'files')}` : 'Stash changes') : 'Rename stash';
  const untracked = isPush && !d.paths
    ? `<label class="gt-check"><input type="checkbox" data-action="toggleStashUntracked"${d.includeUntracked ? ' checked' : ''}><span>Include unversioned files<span class="gt-check__note">New files git does not track yet are put aside too.</span></span></label>`
    : '';
  const note = isPush ? '<p class="gt-muted">The changes leave the working copy and wait in the Stash tab until you apply them.</p>' : '';
  const ok = !d.busy && (isPush || d.message.trim() !== '');
  return `<div class="gt-backdrop" data-action="closeStashDialog">
  <div class="gt-dialog" role="dialog" aria-modal="true" aria-labelledby="gt-stash-title" data-stop>
    <div class="gt-dialog__title"><h2 id="gt-stash-title">${title}</h2></div>
    <label class="gt-field"><span class="gt-section-title">${isPush ? 'Name (optional)' : 'New name'}</span>
      <span class="gt-input"><input data-role="stashName" value="${esc(d.message)}" spellcheck="false" placeholder="${isPush ? 'What these changes are' : ''}"></span></label>
    ${untracked}${note}
    <div class="gt-dialog__foot">
      <button class="gt-btn gt-btn--ghost" data-action="closeStashDialog">Cancel</button>
      <button class="gt-btn gt-btn--primary" data-action="stashDialogDo" data-role="submit"${ok ? '' : ' disabled'}>${d.busy ? '…' : isPush ? 'Stash' : 'Rename'}</button>
    </div>
  </div>
</div>`;
}
