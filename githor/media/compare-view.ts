// "Has moved on both sides" (design `03`): what only the local branch and only its remote have, where they start,
// the conflict to expect, and the three ways to bring them together.
import type { CompareCommit, CompareView } from '../src/core/types.js';
import { authorName } from './commit-log.js';
import { icon } from './icons.js';
import { age, esc, listing, plural } from './text.js';

export interface CompareState {
  ref: string;
  view: CompareView | null;
  /** Force-push was picked: the warning asks before anything is sent. */
  confirmForce: boolean;
}

const commits = (n: number): string => plural(n, 'commit', 'commits');

function column({ title, glyph, list, me }: { title: string; glyph: Parameters<typeof icon>[0]; list: readonly CompareCommit[]; me: string | null }): string {
  const items = list.map((c) => `<div class="gt-compare__item"><span>${esc(c.subject)}</span><span class="gt-detail__meta">${esc(authorName(c, me))} · ${age(c.committedAt)} ago · <span class="gt-mono">${esc(c.short)}</span></span></div>`).join('');
  return `<div class="gt-compare__col"><div class="gt-compare__head">${icon(glyph)}${title}<span class="gt-count">${list.length}</span></div>${items || '<div class="gt-compare__item gt-muted">Nothing</div>'}</div>`;
}

/** Who loses commits on origin with a force-push: `2 commits by Marek`, `Marek's 2 commits` in the warning. */
const by = (list: readonly CompareCommit[]): string => `${commits(list.length)}${list.length ? ` by ${esc(listing([...new Set(list.map((c) => c.author))]))}` : ''}`;

export function compareHtml(c: CompareState, { me, current, defaultBranch, busy }: { me: string | null; current: string | null; defaultBranch: string | null; busy: boolean }): string {
  const v = c.view;
  const back = `<button class="gt-btn gt-btn--ghost gt-diff-back" data-action="closeCompare">${icon('back', 'gt-i--sm')}Back to log</button>`;
  if (!v) return `<div class="gt-compare">${back}<p class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Comparing with the remote…</p></div>`;
  const name = esc(v.name);
  const conflict =
    v.conflicts === null
      ? ''
      : v.conflicts.length
        ? `<div class="gt-banner"><span class="gt-banner__icon">${icon('warn')}</span><span>Both sides changed ${esc(listing(v.conflicts))}, so expect ${plural(v.conflicts.length, 'conflict', 'conflicts')} to resolve.</span></div>`
        : '<div class="gt-banner gt-banner--ok"><span class="gt-banner__icon">' + icon('check') + '</span><span>No file was changed on both sides, so they should come together without a conflict.</span></div>';
  const switching = current !== v.name ? `<span class="gt-choice__note">Switches to ${name} first.</span>` : '';
  const off = busy ? ' disabled' : '';
  const forceWhy = v.name === defaultBranch ? `Turned off on ${name}: it rewrites shared history.` : null;
  const authors = [...new Set(v.remote.map((x) => x.author))];
  const whose = authors.length === 1 ? `${esc(authors[0] ?? '')}'s ${commits(v.remote.length)}` : by(v.remote);
  const force = c.confirmForce
    ? `<div class="gt-banner gt-banner--danger"><span class="gt-banner__icon">${icon('warn')}</span><span>${whose} leave origin for everyone.</span>
        <span class="gt-spacer"></span><button class="gt-btn gt-btn--danger" data-action="forcePushCompare" data-ref="${esc(v.ref)}"${off}>Force-push</button><button class="gt-btn" data-action="cancelForceCompare">Cancel</button></div>`
    : `<div class="gt-banner gt-banner--danger gt-banner--quiet"><span class="gt-banner__icon">${icon('warn')}</span><span>Force-push asks first: ${whose} leave origin for everyone.</span></div>`;
  return `<div class="gt-compare">
  <div class="gt-pane__row">${back}<h2 class="gt-title">${v.local.length && v.remote.length ? `${name} has moved on both sides` : `${name} compared with ${esc(v.upstream)}`}</h2></div>
  <div class="gt-compare__cols">${column({ title: 'Only on local', glyph: 'laptop', list: v.local, me })}${column({ title: 'Only on remote', glyph: 'cloud', list: v.remote, me })}</div>
  ${v.base ? `<div class="gt-compare__base">${icon('commit', 'gt-i--sm')}Both sides start from <span class="gt-mono">${esc(v.base.short)}</span> ${esc(v.base.subject)}</div>` : ''}
  ${conflict}
  <div class="gt-section-title">How do you want to bring them together?</div>
  <div class="gt-choice"><div class="gt-choice__text"><div class="gt-choice__name">Put my ${v.local.length === 1 ? 'commit' : 'commits'} on top</div><div class="gt-muted">Rebase. History stays one straight line, then you push ${commits(v.local.length)}.</div>${switching}</div><button class="gt-btn gt-btn--primary" data-action="rebaseRemote" data-ref="${esc(v.ref)}"${off}>Rebase on remote</button></div>
  <div class="gt-choice"><div class="gt-choice__text"><div class="gt-choice__name">Join both histories</div><div class="gt-muted">Merge. Keeps every commit as it is and adds one merge commit.</div>${switching}</div><button class="gt-btn" data-action="mergeRemote" data-ref="${esc(v.ref)}"${off}>Merge remote</button></div>
  <div class="gt-choice"><div class="gt-choice__text"><div class="gt-choice__name">Replace the remote with my version</div><div class="gt-muted">${esc(forceWhy ?? `Force-push with lease. Removes ${by(v.remote)} from origin.`)}</div></div><button class="gt-btn gt-btn--danger" data-action="askForceCompare"${forceWhy || busy ? ' disabled' : ''}>Force-push…</button></div>
  ${forceWhy ? '' : force}
</div>`;
}
