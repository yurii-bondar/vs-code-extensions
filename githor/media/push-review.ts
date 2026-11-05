// The push screen (design `10`): where the commits go, each commit with its files, and Push or Cancel.
import type { CommitDetails } from '../src/core/types.js';
import { authorName } from './commit-log.js';
import { icon } from './icons.js';
import { age, esc, plural } from './text.js';

export interface PushReview {
  ref: string;
  /** Null while the host reads the commits. */
  commits: CommitDetails[] | null;
  to: string;
  creates: boolean;
  /** The file open on the right: which commit, which path. */
  selected: { sha: string; path: string } | null;
}

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const commits = (n: number): string => plural(n, 'commit', 'commits');

export function pushReviewHtml(review: PushReview, { branch, me, busy }: { branch: string; me: string | null; busy: boolean }): string {
  const list = review.commits;
  const n = list?.length ?? 0;
  const remote = review.to.split('/')[0] ?? 'origin';
  const head = `<div class="gt-pane__head">
  <button class="gt-btn gt-btn--ghost gt-diff-back" data-action="closePushReview">${icon('back', 'gt-i--sm')}Back</button>
  <h2 class="gt-title">${list ? `${review.creates ? 'Publish' : 'Push'} ${commits(n)} to ${esc(remote)}` : 'Reading what to push…'}</h2>
  <div class="gt-kv"><span class="gt-muted">From</span><span><span class="gt-chip">${icon('laptop', 'gt-i--sm')}local</span> ${esc(branch)}</span>
  <span class="gt-muted">To</span><span>${review.creates ? `creates ${esc(review.to)}` : `<span class="gt-chip">${icon('cloud', 'gt-i--sm')}remote</span> ${esc(review.to)}`}</span></div>
</div>`;
  if (!list) return `${head}<div class="gt-empty"><span class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Reading the commits…</span></div>`;

  const body = list
    .map((c) => {
      const files = c.files
        .map((f) => {
          const on = review.selected?.sha === c.sha && review.selected.path === f.path;
          const st = f.status === 'A' || f.status === 'D' ? f.status : 'M';
          const stat = f.binary ? '' : `<span class="gt-file__stat"><span class="gt-plus">+${f.add}</span> <span class="gt-minus">−${f.del}</span></span>`;
          return `<button class="gt-file gt-file--nested${on ? ' is-selected' : ''}" data-action="reviewFile" data-sha="${esc(c.sha)}" data-path="${esc(f.path)}"><span class="gt-file__st gt-file__st--${st}">${f.status}</span><span class="gt-file__path" title="${esc(f.path)}">${esc(nameOf(f.path))} <span class="gt-file__dir">${esc(dirOf(f.path))}</span></span>${stat}</button>`;
        })
        .join('');
      return `<div class="gt-review-commit"><span>${esc(c.subject)}</span><span class="gt-detail__meta">${esc(authorName(c, me))} · ${age(c.committedAt)} ago · <span class="gt-mono">${esc(c.short)}</span></span></div>${files}`;
    })
    .join('');
  return `${head}
<div class="gt-scroll"><div class="gt-section-title gt-review-title">Commits</div>${body || '<div class="gt-empty"><span>Nothing to push.</span></div>'}</div>
<div class="gt-composer">
  <p class="gt-muted">Uncommitted changes stay on this machine.</p>
  <div class="gt-pane__row">
    <button class="gt-btn gt-btn--primary" data-action="pushReviewed" data-ref="${esc(review.ref)}"${n && !busy ? '' : ' disabled'}>${icon(busy ? 'spinner' : 'push', busy ? 'gt-spin' : '')}${review.creates ? 'Publish' : `Push ${n}`}</button>
    <button class="gt-btn" data-action="closePushReview">Cancel</button>
  </div>
</div>`;
}
