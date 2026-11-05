// The Commit tab (design `04`, `49`–`52`): the working copy's files in sections, flat or grouped by directory, ticked
// for the commit, and the composer.
import { commitTree } from '../src/core/commit-groups.js';
import type { CommitNode, Grouping, Tick } from '../src/core/commit-groups.js';
import type { StateView } from '../src/protocol.js';
import { icon } from './icons.js';
import { esc, plural } from './text.js';

export interface CommitState {
  ticked: Set<string>;
  /** Paths seen before, so a new file is ticked by its kind and an old one keeps its tick. */
  known: Set<string>;
  message: string;
  /** The file whose diff is open on the right. */
  selected: string | null;
  groupMenu: boolean;
  committing: boolean;
}

export const emptyCommit = (): CommitState => ({ ticked: new Set(), known: new Set(), message: '', selected: null, groupMenu: false, committing: false });

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** A three-state box: `some` is set as indeterminate after render, since HTML has no attribute for it. */
const box = (tick: Tick, paths: readonly string[], label: string): string =>
  `<input type="checkbox" data-action="tickGroup" data-paths="${esc(JSON.stringify(paths))}"${tick === 'all' ? ' checked' : ''}${tick === 'some' ? ' data-mixed' : ''} aria-label="${esc(label)}">`;

function nodeHtml(node: CommitNode, c: CommitState, grouped: boolean): string {
  const pad = ` gt-stage--d${node.depth}`;
  if (node.kind !== 'file') {
    const glyph = node.kind === 'directory' ? icon('folder', 'gt-i--sm') : '';
    return `<div class="gt-stage gt-stage--group${pad}">${icon('chevDown', 'gt-i--sm')}${box(node.tick, node.paths, `Include everything in ${node.label}`)}${glyph}<span class="${node.kind === 'section' ? 'gt-stage__section' : ''}">${esc(node.label)}</span><span class="gt-count">${node.paths.length}</span></div>`;
  }
  const f = node.file;
  const stat = f.status === 'U' || f.binary ? '' : `<span class="gt-file__stat"><span class="gt-plus">+${f.add}</span> <span class="gt-minus">−${f.del}</span></span>`;
  const st = f.status === 'U' ? 'U' : f.status === 'A' || f.status === 'D' ? f.status : 'M';
  return `<div class="gt-stage${pad}${c.selected === f.path ? ' is-selected' : ''}">
  <input type="checkbox" data-action="tickFile" data-path="${esc(f.path)}"${c.ticked.has(f.path) ? ' checked' : ''} aria-label="Include ${esc(f.path)} in the commit">
  <button class="gt-file" data-action="selectWorking" data-path="${esc(f.path)}">
    <span class="gt-file__st gt-file__st--${st}">${f.status}</span>
    <span class="gt-file__path" title="${esc(f.path)}">${esc(grouped ? nameOf(f.path) : nameOf(f.path))}${grouped ? '' : ` <span class="gt-file__dir">${esc(dirOf(f.path))}</span>`}${f.oldPath ? ` <span class="gt-file__dir">from ${esc(f.oldPath)}</span>` : ''}</span>
    ${stat}
  </button>
</div>`;
}

function groupMenuHtml(grouping: Grouping): string {
  const item = (action: string, label: string, on: boolean): string =>
    `<button class="gt-menu__item" role="menuitemcheckbox" aria-checked="${on}" data-action="${action}">${on ? icon('check', 'gt-i--sm') : '<span class="gt-option__tick"></span>'}${label}</button>`;
  // Repository is offered only with several repositories open (design `52`); Githor shows one at a time for now.
  return `<div class="gt-menu gt-menu--group" role="menu" data-stop>
  <div class="gt-menu__title">Group by</div>
  ${item('groupDirectory', 'Directory', grouping === 'directory')}
  <div class="gt-menu__sep" role="separator"></div>
  ${item('ungroup', 'Ungroup', grouping === 'none')}
</div>`;
}

/** `notice`: HTML shown above the files, such as the no-account notice. */
export function commitListHtml(state: StateView, c: CommitState, notice = ''): string {
  const files = state.working;
  const conflicts = files.filter((f) => f.conflicted);
  const committable = files.filter((f) => !f.conflicted);
  const ticked = committable.filter((f) => c.ticked.has(f.path)).length;
  const tree = commitTree(files, { grouping: state.grouping, ticked: c.ticked });
  const current = state.branches.find((b) => b.current);
  const target = current ? `<span>Commit to</span><strong>${esc(current.name)}</strong>` : `<span>Commit on no branch, at</span><strong class="gt-mono">${esc((state.head ?? '').slice(0, 7))}</strong>`;
  const banner = conflicts.length
    ? `<div class="gt-banner"><span class="gt-banner__icon">${icon('warn')}</span><span>${plural(conflicts.length, 'file conflicts', 'files conflict')}: ${esc(conflicts.map((f) => f.path).join(', '))}. Resolve them before committing.</span></div>`
    : '';
  const can = ticked > 0 && c.message.trim() !== '' && !c.committing && !conflicts.length;
  const why = conflicts.length ? 'Resolve the conflicts first.' : !ticked ? 'Tick the files to commit.' : !c.message.trim() ? 'Write a commit message.' : '';

  const list = committable.length
    ? tree.map((n) => nodeHtml(n, c, state.grouping === 'directory')).join('')
    : `<div class="gt-empty">${icon('check')}<span class="gt-empty__title">Working tree is clean</span><span>Everything here is committed.</span><button class="gt-btn" data-action="tabLog">Show log</button></div>`;
  return `<div class="gt-pane__head gt-commit-head">
  <span class="gt-section-title">${committable.length ? `${ticked} of ${plural(committable.length, 'file', 'files')} in this commit` : 'Nothing to commit'}</span>
  <span class="gt-spacer"></span>
  <span class="gt-menu-anchor">
    <button class="gt-icon-btn${state.grouping !== 'none' ? ' is-on' : ''}" data-action="groupMenu" title="Group by" aria-label="Group by" aria-haspopup="menu" aria-expanded="${c.groupMenu}">${icon('group')}</button>
    ${c.groupMenu ? groupMenuHtml(state.grouping) : ''}
  </span>
  <button class="gt-btn gt-btn--ghost" data-action="stashTicked"${ticked ? '' : ' disabled title="Tick the files to stash."'}>${icon('folder', 'gt-i--sm')}Stash…</button>
</div>
${banner || notice ? `<div class="gt-commit-banner">${notice}${banner}</div>` : ''}
<div class="gt-scroll">${list}</div>
<div class="gt-composer">
  <div class="gt-composer__target">${icon('branch', 'gt-i--sm')}${target}${state.account ? `<span class="gt-spacer"></span><span class="gt-composer__as${state.account.expired ? ' is-expired' : ''}" title="${esc(state.account.email)}">${icon('account', 'gt-i--sm')}as ${esc(state.account.label)}</span>` : ''}</div>
  <label class="gt-section-title" for="gt-commit-message">Commit message</label>
  <textarea id="gt-commit-message" class="gt-textarea" data-role="commitMessage" placeholder="What does this change do?">${esc(c.message)}</textarea>
  <div class="gt-pane__row">
    <button class="gt-btn gt-btn--primary" data-action="commitNow"${can ? '' : ` disabled title="${esc(why)}"`}>${c.committing ? 'Committing…' : 'Commit'}</button>
    <button class="gt-btn" data-action="commitAndPush"${can ? '' : ` disabled title="${esc(why)}"`}>${icon('push')}Commit and push</button>
  </div>
</div>`;
}
