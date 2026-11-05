// The dialogs of one branch: New branch (`43`), Rename (`33`, `35`), Delete (`34`, `35`) and Delete on origin (`35`).
import type { Branch, CommitLine } from '../src/core/types.js';
import { icon } from './icons.js';
import { esc, listing, plural } from './text.js';

export type BranchDialog =
  | { kind: 'new'; name: string; start: string; switchTo: boolean; problem: string | null; busy: boolean }
  | { kind: 'rename'; ref: string; name: string; onRemote: boolean; problem: string | null; busy: boolean }
  | { kind: 'delete'; ref: string; info: DeleteInfo | null; onRemote: boolean; busy: boolean };

export interface DeleteInfo {
  mergedInto: string | null;
  local: CommitLine[];
  remote: CommitLine[];
}

/** The name a new branch starts with: the start branch's prefix, `feat/` from `feat/side-by-side-diff`. */
export const namePrefix = (name: string): string => name.slice(0, name.lastIndexOf('/') + 1);

const commits = (n: number): string => plural(n, 'commit', 'commits');
const MAX_LISTED = 5;

function frame({ title, body, foot }: { title: string; body: string; foot: string }): string {
  return `<div class="gt-backdrop" data-action="closeBranchDialog">
  <div class="gt-dialog" role="dialog" aria-modal="true" aria-labelledby="gt-branch-title" data-stop>
    <div class="gt-dialog__title"><h2 id="gt-branch-title">${title}</h2></div>
    ${body}
    <div class="gt-dialog__foot">${foot}</div>
  </div>
</div>`;
}

const cancel = '<button class="gt-btn gt-btn--ghost" data-action="closeBranchDialog">Cancel</button>';
const nameField = ({ label, value, problem }: { label: string; value: string; problem: string | null }): string => `<label class="gt-field"><span class="gt-section-title">${label}</span>
  <span class="gt-input${problem ? ' is-invalid' : ''}"><input data-role="branchName" value="${esc(value)}" spellcheck="false" aria-invalid="${problem !== null}"></span>
  <span class="gt-field__problem" data-role="nameProblem">${esc(problem ?? '')}</span></label>`;

function newBranchHtml(d: Extract<BranchDialog, { kind: 'new' }>, branches: readonly Branch[]): string {
  const options = branches.map((b) => `<option value="${esc(b.ref)}"${b.ref === d.start ? ' selected' : ''}>${esc(b.local ? b.name : (b.upstream ?? b.name))}</option>`).join('');
  const body = `${nameField({ label: 'Name', value: d.name, problem: d.problem })}
  <label class="gt-field"><span class="gt-section-title">Start from</span><span class="gt-select gt-select--wide">${icon('chevDown', 'gt-i--sm')}<select data-action="pickStart">${options}</select></span></label>
  <label class="gt-check"><input type="checkbox" data-action="toggleSwitchTo"${d.switchTo ? ' checked' : ''}><span>Switch to it now</span></label>`;
  const ok = !d.problem && d.name.trim() && !d.busy;
  return frame({ title: 'New branch', body, foot: `${cancel}<button class="gt-btn gt-btn--primary" data-action="createBranch" data-role="submit"${ok ? '' : ' disabled'}>${d.busy ? 'Creating…' : 'Create branch'}</button>` });
}

function renameHtml(d: Extract<BranchDialog, { kind: 'rename' }>, branch: Branch): string {
  const upstream = branch.upstream && branch.sync !== 'gone' ? branch.upstream : null;
  const origin = upstream
    ? `<label class="gt-check"><input type="checkbox" data-action="toggleRenameRemote"${d.onRemote ? ' checked' : ''}><span>Also rename on origin<span class="gt-check__note">Pushes the new name and removes ${esc(upstream)}. Anyone using the old name has to switch.</span></span></label>`
    : '';
  const same = d.name === branch.name;
  const ok = !d.problem && !same && d.name.trim() && !d.busy;
  return frame({
    title: 'Rename branch',
    body: `${nameField({ label: 'New name', value: d.name, problem: d.problem })}${origin}`,
    foot: `${cancel}<button class="gt-btn gt-btn--primary" data-action="renameBranchDo" data-role="submit"${ok ? '' : ' disabled'}>${d.busy ? 'Renaming…' : 'Rename'}</button>`,
  });
}

const commitList = (lines: readonly CommitLine[]): string =>
  `<ul class="gt-commit-list">${lines
    .slice(0, MAX_LISTED)
    .map((c) => `<li><span class="gt-mono gt-muted">${esc(c.sha)}</span> ${esc(c.subject)}</li>`)
    .join('')}${lines.length > MAX_LISTED ? `<li class="gt-muted">and ${lines.length - MAX_LISTED} more</li>` : ''}</ul>`;

/** Who loses commits on origin, as the design says it: `Marek's 2 commits`, or `2 commits by Marek and Olena`. */
function whose(lines: readonly CommitLine[]): string {
  const authors = [...new Set(lines.map((c) => c.author))];
  return authors.length === 1 ? `${esc(authors[0] ?? '')}'s ${commits(lines.length)}` : `${commits(lines.length)} by ${esc(listing(authors))}`;
}

function deleteHtml(d: Extract<BranchDialog, { kind: 'delete' }>, branch: Branch): string {
  if (!branch.local) {
    const name = esc(branch.upstream ?? branch.name);
    const body = `<div class="gt-banner gt-banner--danger"><span class="gt-banner__icon">${icon('warn')}</span><span>This removes it for everyone</span></div>
  <p class="gt-muted">Nobody can fetch this branch from origin afterwards. Undo can't restore it.</p>`;
    return frame({ title: `Delete ${name}?`, body, foot: `${cancel}<button class="gt-btn gt-btn--danger" data-action="deleteBranchDo"${d.busy ? ' disabled' : ''}>${d.busy ? 'Deleting…' : 'Delete on origin'}</button>` });
  }
  const info = d.info;
  const upstream = branch.upstream && branch.sync !== 'gone' ? branch.upstream : null;
  let loss: string;
  if (!info) loss = `<p class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Checking what only this branch has…</p>`;
  else if (info.mergedInto) loss = `<p>It is fully merged into ${esc(info.mergedInto)}, so no commit is lost.</p>`;
  else if (info.local.length) loss = `<div class="gt-banner"><span class="gt-banner__icon">${icon('warn')}</span><span>${plural(info.local.length, 'commit exists', 'commits exist')} only on this branch</span></div>${commitList(info.local)}`;
  else loss = '<p>Every commit of it is on another branch too, so none is lost.</p>';

  const remoteLoss = info?.remote.length ?? 0;
  const originNote = remoteLoss && info ? `Removes ${whose(info.remote)} from origin for everyone. Undo can't bring them back.` : "Removes it from origin for everyone. Undo can't bring it back.";
  const origin = upstream
    ? `<label class="gt-check"><input type="checkbox" data-action="toggleDeleteRemote"${d.onRemote ? ' checked' : ''}><span>Also delete ${esc(upstream)}<span class="gt-check__note">${originNote}</span></span></label>`
    : '';
  const label = d.busy ? 'Deleting…' : d.onRemote && upstream ? 'Delete branch and remote' : 'Delete branch';
  return frame({ title: `Delete ${esc(branch.name)}?`, body: `${loss}${origin}`, foot: `${cancel}<button class="gt-btn gt-btn--danger" data-action="deleteBranchDo"${info && !d.busy ? '' : ' disabled'}>${label}</button>` });
}

export function branchDialogHtml(dialog: BranchDialog, branches: readonly Branch[]): string {
  if (dialog.kind === 'new') return newBranchHtml(dialog, branches);
  const branch = branches.find((b) => b.ref === dialog.ref);
  if (!branch) return '';
  return dialog.kind === 'rename' ? renameHtml(dialog, branch) : deleteHtml(dialog, branch);
}
