// The details pane (design `01`, `14`): one commit's message, actions and changed files, or the commits selected
// together, to squash or cherry-pick them (`14`).
import type { CommitDetails, CommitView, FileChange } from '../src/core/types.js';
import { icon } from './icons.js';
import { authorName, avatar } from './commit-log.js';
import { age, esc, plural } from './text.js';

export interface DetailsArgs {
  selected: readonly string[];
  commits: readonly CommitView[];
  details: ReadonlyMap<string, CommitDetails>;
  me: string | null;
  head: string | null;
  /** The commits the current branch (HEAD) reaches, to tell what Cherry-pick and Revert can do. */
  onHead: ReadonlySet<string>;
  /** The checked-out branch, or null when on no branch. */
  current: string | null;
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const attr = (why: string | null): string => (why ? ` disabled title="${esc(why)}"` : '');

function fileRow(file: FileChange, sha: string | null): string {
  const stat = file.binary ? '<span class="gt-muted">binary</span>' : `<span class="gt-plus">+${file.add}</span> <span class="gt-minus">−${file.del}</span>`;
  const renamed = file.oldPath ? ` <span class="gt-file__dir">from ${esc(file.oldPath)}</span>` : '';
  return `<button class="gt-file" data-action="openDiff" data-sha="${esc(sha ?? '')}" data-path="${esc(file.path)}"${sha ? '' : ' disabled'}>
  <span class="gt-file__st gt-file__st--${file.status === 'R' || file.status === 'C' || file.status === 'T' ? 'M' : file.status}">${file.status}</span>
  <span class="gt-file__path" title="${esc(file.path)}">${esc(nameOf(file.path))} <span class="gt-file__dir">${esc(dirOf(file.path))}</span>${renamed}</span>
  <span class="gt-file__stat">${stat}</span>
</button>`;
}

/** The files of several commits together, their counts added up. */
function unionFiles(list: readonly CommitDetails[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const d of list) {
    for (const f of d.files) {
      const seen = byPath.get(f.path);
      byPath.set(f.path, seen ? { ...seen, add: seen.add + f.add, del: seen.del + f.del, binary: seen.binary || f.binary } : f);
    }
  }
  return [...byPath.values()];
}

const loading = `<div class="gt-detail"><p class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Reading the commit…</p></div>`;

export function detailsHtml(args: DetailsArgs): string {
  const { selected, details, me, head, onHead, current } = args;
  if (!selected.length) return '<div class="gt-empty"><span class="gt-empty__title">No commit selected</span><span>Pick a commit to see what it changed.</span></div>';
  const onto = current ?? 'HEAD';

  if (selected.length === 1) {
    const sha = selected[0] as string;
    const d = details.get(sha);
    if (!d) return loading;
    const who = authorName(d, me);
    const switchWhy = sha === head ? 'This commit is checked out.' : null;
    const pickWhy = onHead.has(sha) ? `Already on ${onto}.` : null;
    const revertWhy = onHead.has(sha) ? null : `Not on ${onto}.`;
    return `<div class="gt-detail">
  <h2 class="gt-title">${esc(d.subject)}</h2>
  ${d.body ? `<p class="gt-detail__body">${esc(d.body)}</p>` : ''}
  <div class="gt-detail__meta">${avatar(who)}<span>${esc(who)} · ${age(d.committedAt)} ago ·</span><span class="gt-mono">${esc(d.short)}</span>
    <button class="gt-icon-btn" data-action="copySha" data-sha="${esc(d.sha)}" title="Copy the full hash" aria-label="Copy the full hash">${icon('copy', 'gt-i--sm')}</button></div>
  <div class="gt-pane__row">
    <button class="gt-btn" data-action="switchCommit" data-sha="${esc(sha)}"${attr(switchWhy)}>Switch</button>
    <button class="gt-btn" data-action="cherryPick" data-sha="${esc(sha)}"${attr(pickWhy)}>Cherry-pick</button>
    <button class="gt-btn" data-action="revert" data-sha="${esc(sha)}"${attr(revertWhy)}>Revert</button>
  </div>
</div>
<div class="gt-pane__head"><span class="gt-section-title">${d.files.length ? `${plural(d.files.length, 'file', 'files')} changed, click one to open it side by side` : 'No file changed'}</span></div>
<div class="gt-scroll">${d.files.map((f) => fileRow(f, sha)).join('')}</div>`;
  }

  const list = selected.map((sha) => details.get(sha));
  const ready = list.filter((d): d is CommitDetails => d !== undefined);
  const items = list
    .map((d, i) => {
      const c = args.commits.find((x) => x.sha === selected[i]);
      const subject = d?.subject ?? c?.subject ?? '';
      const meta = d ? `${esc(authorName(d, me))} · ${age(d.committedAt)} ago · <span class="gt-mono">${esc(d.short)}</span>` : '…';
      return `<div class="gt-detail__pick"><span>${esc(subject)}</span><span class="gt-detail__meta">${meta}</span></div>`;
    })
    .join('');
  const pickWhy = selected.some((sha) => onHead.has(sha)) ? `Some of them are already on ${onto}.` : null;
  const files = unionFiles(ready);
  return `<div class="gt-detail">
  <div><h2 class="gt-title">${selected.length} commits selected</h2><p class="gt-muted">Cmd-click adds or removes a commit.</p></div>
  ${items}
  <div class="gt-pane__row"><button class="gt-btn gt-btn--primary" data-action="openSquash">Squash ${selected.length} commits…</button><button class="gt-btn" data-action="cherryPickAll"${attr(pickWhy)}>Cherry-pick ${selected.length}</button></div>
</div>
<div class="gt-pane__head"><span class="gt-section-title">Files changed <span class="gt-count">${files.length}</span></span></div>
<div class="gt-scroll">${ready.length === list.length ? files.map((f) => fileRow(f, null)).join('') : loading}</div>`;
}
