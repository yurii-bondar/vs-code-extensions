// "Squash N commits into one" (design `12`, its states in `13`): the commits, the files of the result, the new message,
// what the squash means for origin, and Squash or Cancel.
import type { SquashPlan } from '../src/core/types.js';
import { authorName } from './commit-log.js';
import { icon } from './icons.js';
import { age, esc, plural } from './text.js';

export interface SquashState {
  shas: string[];
  plan: SquashPlan | null;
  message: string;
  /** The file of the result open on the right. */
  selected: string | null;
  busy: boolean;
}

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const commits = (n: number): string => plural(n, 'commit', 'commits');

/** The message a squash starts with: every subject, newest first, one per line. */
export const defaultMessage = (plan: SquashPlan): string => plan.commits.map((c) => c.subject).join('\n');

export function squashRailHtml(s: SquashState, { branch, me }: { branch: string; me: string | null }): string {
  const p = s.plan;
  const n = s.shas.length;
  const head = `<div class="gt-pane__head">
  <button class="gt-btn gt-btn--ghost gt-diff-back" data-action="closeSquash">${icon('back', 'gt-i--sm')}Back</button>
  <h2 class="gt-title">Squash ${commits(n)} into one</h2>
  <div class="gt-detail__meta">On <strong>${esc(branch)}</strong></div>
</div>`;
  if (!p) return `${head}<div class="gt-empty"><span class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Checking the commits…</span></div>`;

  const list = p.commits.map((c) => `<div class="gt-review-commit"><span>${esc(c.subject)}</span><span class="gt-detail__meta">${esc(authorName(c, me))} · ${age(c.committedAt)} ago · <span class="gt-mono">${esc(c.short)}</span></span></div>`).join('');
  const files = p.files
    .map((f) => {
      const st = f.status === 'A' || f.status === 'D' ? f.status : 'M';
      const stat = f.binary ? '' : `<span class="gt-file__stat"><span class="gt-plus">+${f.add}</span> <span class="gt-minus">−${f.del}</span></span>`;
      return `<button class="gt-file${s.selected === f.path ? ' is-selected' : ''}" data-action="squashFile" data-path="${esc(f.path)}"><span class="gt-file__st gt-file__st--${st}">${f.status}</span><span class="gt-file__path" title="${esc(f.path)}">${esc(nameOf(f.path))} <span class="gt-file__dir">${esc(dirOf(f.path))}</span></span>${stat}</button>`;
    })
    .join('');
  // what the squash means, as `13` says it: in the way, already on origin, or nobody affected
  const note = p.problem
    ? `<div class="gt-banner gt-banner--danger"><span class="gt-banner__icon">${icon('warn')}</span><span>${esc(p.problem)}</span></div>`
    : p.pushed.length
      ? `<div class="gt-banner"><span class="gt-banner__icon">${icon('warn')}</span><span>${esc(p.pushed.join(', '))} ${p.pushed.length === 1 ? 'is' : 'are'} already on origin. After this you'll need to force-push.</span></div>`
      : `<p class="gt-muted">These commits aren't on origin yet, so nobody else is affected. One commit will be left to push.</p>`;
  const can = !p.problem && s.message.trim() !== '' && !s.busy;
  return `${head}
<div class="gt-scroll">
  <div class="gt-section-title gt-review-title">Commits</div>${list}
  <div class="gt-section-title gt-review-title">Files in the result</div>${files}
</div>
<div class="gt-composer">
  <label class="gt-section-title" for="gt-squash-message">New commit message</label>
  <textarea id="gt-squash-message" class="gt-textarea" data-role="squashMessage"${p.problem ? ' disabled' : ''}>${esc(s.message)}</textarea>
  ${note}
  ${p.after ? `<p class="gt-muted">${commits(p.after)} after these ${p.after === 1 ? 'is' : 'are'} put back on top.</p>` : ''}
  <div class="gt-pane__row">
    <button class="gt-btn gt-btn--primary" data-action="squashNow"${can ? '' : ' disabled'}>${s.busy ? 'Squashing…' : `Squash ${n}`}</button>
    <button class="gt-btn" data-action="closeSquash">Cancel</button>
  </div>
</div>`;
}
