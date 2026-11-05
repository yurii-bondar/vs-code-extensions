// Paused at a conflict (design `23`–`29`): the files on the left with Continue and Abort, the conflict on the right
// with your branch always on the left, the Accept buttons named after the branches, the result, and editing it.
import type { ConflictPart, ConflictRegion, Resolution } from '../src/core/conflict.js';
import type { OperationView } from '../src/core/types.js';
import { icon } from './icons.js';
import { isPlain, lineHtml } from './syntax.js';
import { esc, plural } from './text.js';

export interface ConflictState {
  /** The file open on the right. */
  path: string | null;
  /** Its conflicts, as read; null while read. */
  parts: ConflictPart[] | null;
  /** A choice per conflict of the open file, in order. */
  choices: (Resolution | null)[];
  /** The conflict whose result is being written by hand, and the text so far. */
  editing: number | null;
  draft: string;
  /** Files resolved here, with what was chosen, to show the result and offer Change. */
  resolved: Map<string, { parts: ConflictPart[]; choices: Resolution[] }>;
}

export const emptyConflict = (): ConflictState => ({ path: null, parts: null, choices: [], editing: null, draft: '', resolved: new Map() });

const CONTEXT = 3;
const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const lineOf = (text: string, plain: boolean): string => lineHtml([{ text, changed: false }], plain) || ' ';

/** What a choice is called on the bar and over the result, in the design's words. */
function chosen(resolution: Resolution, op: OperationView): { using: string; result: string } {
  switch (resolution.take) {
    case 'local':
      return { using: `using ${op.local}`, result: `from ${op.local}` };
    case 'remote':
      return { using: `using ${op.remote}`, result: `from ${op.remote}` };
    case 'both':
      return { using: 'using both sides', result: `both sides, ${op.local} first` };
    case 'edit':
      return { using: 'using your edit', result: 'your edit' };
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}

const resultLines = (region: ConflictRegion, r: Resolution): string[] =>
  r.take === 'local' ? region.local : r.take === 'remote' ? region.remote : r.take === 'both' ? [...region.local, ...region.remote] : r.text.split('\n');

function fileList(title: string, paths: readonly string[], selected: string | null, tone: string): string {
  if (!paths.length) return '';
  const rows = paths
    .map((p) => `<button class="gt-file${p === selected ? ' is-selected' : ''}" data-action="selectConflictFile" data-path="${esc(p)}"><span class="gt-file__st gt-file__st--${tone}">${tone === 'D' ? '!' : 'M'}</span><span class="gt-file__path" title="${esc(p)}">${esc(nameOf(p))} <span class="gt-file__dir">${esc(dirOf(p))}</span></span></button>`)
    .join('');
  return `<div class="gt-section-title gt-review-title">${title}</div>${rows}`;
}

export function conflictRailHtml(op: OperationView, c: ConflictState): string {
  const word = op.kind === 'merge' ? 'Merge' : 'Rebase';
  const resolvedHere = op.staged.filter((p) => c.resolved.has(p));
  const own = op.staged.filter((p) => !c.resolved.has(p));
  const done = op.conflicted.length === 0;
  const lead = done
    ? `<h2 class="gt-title">Conflict resolved</h2><p class="gt-muted">${op.kind === 'merge' ? 'Continue creates the merge commit on this branch.' : 'Continue replays the rest of your commits, and may stop at the next conflict.'}</p>`
    : `<h2 class="gt-title">${word} paused at a conflict</h2><p class="gt-muted">Both sides changed the same line. Nothing is committed until you press Continue.</p>`;
  return `<div class="gt-pane__head">${lead}<div class="gt-detail__meta">On <strong>${esc(op.local)}</strong></div></div>
<div class="gt-scroll">
  ${fileList('Files with conflicts', op.conflicted, c.path, 'D')}
  ${fileList('Resolved by you', resolvedHere, c.path, 'A')}
  ${fileList('Merged on their own', own, c.path, 'M')}
</div>
<div class="gt-composer">
  <p class="gt-muted">Abort puts the branch back exactly as it was.</p>
  <div class="gt-pane__row">
    <button class="gt-btn gt-btn--primary" data-action="continueOperation"${done ? '' : ' disabled title="Resolve every conflict first."'}>Continue</button>
    <button class="gt-btn gt-btn--danger" data-action="abortOperation">Abort ${op.kind}</button>
  </div>
</div>`;
}

/** Side-by-side rows for one conflict, with a few common lines around it; numbers count each side's own version. */
function regionRows({ before, region, after, at, plain }: { before: string[]; region: ConflictRegion; after: string[]; at: { left: number; right: number }; plain: boolean }): string {
  const rows: string[] = [];
  const same = (t: string): void => {
    rows.push(`<div class="gt-diff__row"><span class="gt-diff__num">${at.left++}</span><span class="gt-diff__code">${lineOf(t, plain)}</span><span class="gt-diff__num gt-diff__num--right">${at.right++}</span><span class="gt-diff__code">${lineOf(t, plain)}</span></div>`);
  };
  before.forEach(same);
  for (let k = 0; k < Math.max(region.local.length, region.remote.length); k++) {
    const l = region.local[k];
    const r = region.remote[k];
    const left = l === undefined ? '<span class="gt-diff__num"></span><span class="gt-diff__code gt-cell--none"></span>' : `<span class="gt-diff__num gt-cell--del">${at.left++}</span><span class="gt-diff__code gt-cell--del">${lineOf(l, plain)}</span>`;
    const right = r === undefined ? '<span class="gt-diff__num gt-diff__num--right"></span><span class="gt-diff__code gt-cell--none"></span>' : `<span class="gt-diff__num gt-diff__num--right gt-cell--add">${at.right++}</span><span class="gt-diff__code gt-cell--add">${lineOf(r, plain)}</span>`;
    rows.push(`<div class="gt-diff__row">${left}${right}</div>`);
  }
  after.forEach(same);
  return rows.join('');
}

function resultBlock({ title, lines, plain }: { title: string; lines: readonly string[]; plain: boolean }): string {
  return `<div class="gt-conflict__result"><div class="gt-section-title">Result: ${esc(title)}</div><pre class="gt-conflict__lines">${lines.map((l) => lineOf(l, plain)).join('\n')}</pre></div>`;
}

export function conflictPaneHtml(op: OperationView, c: ConflictState): string {
  if (!c.path) return '<div class="gt-empty"><span>Pick a file to resolve.</span></div>';
  const file = c.path;
  const header = `<div class="gt-diff-file"><strong>${esc(nameOf(file))}</strong> <span class="gt-file__dir">${esc(dirOf(file))}</span></div>`;
  const kept = c.resolved.get(file);
  const conflicted = op.conflicted.includes(file);
  if (!conflicted && !kept) return `${header}<div class="gt-empty"><span class="gt-empty__title">${op.staged.includes(file) ? 'Merged on its own' : 'Resolved'}</span><span>Git brought both sides together here; nothing to choose.</span></div>`;
  const parts = conflicted ? c.parts : (kept?.parts ?? null);
  if (!parts) return `${header}<div class="gt-empty"><span class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Reading the conflict…</span></div>`;
  const choices = conflicted ? c.choices : (kept?.choices ?? []);
  const plain = isPlain(file);
  const total = parts.filter((p) => p.kind === 'conflict').length;

  const at = { left: 1, right: 1 };
  let n = 0;
  const blocks = parts.map((part, i) => {
    if (part.kind === 'common') {
      // lines far from any conflict only advance the numbers
      at.left += part.lines.length;
      at.right += part.lines.length;
      return '';
    }
    const prev = parts[i - 1];
    const next = parts[i + 1];
    const before = prev?.kind === 'common' ? prev.lines.slice(-CONTEXT) : [];
    const after = next?.kind === 'common' ? next.lines.slice(0, CONTEXT) : [];
    at.left -= before.length;
    at.right -= before.length;
    const line = at.left + before.length;
    const index = n++;
    const rows = regionRows({ before, region: part, after, at, plain });
    at.left -= after.length;
    at.right -= after.length;
    const choice = choices[index] ?? null;
    const label = `Conflict ${index + 1} of ${total}`;

    let bar: string;
    let result = '';
    if (c.editing === index && conflicted) {
      bar = `<div class="gt-conflict__bar"><span>${label}: write what line ${line} should say</span><span class="gt-spacer"></span>
        <button class="gt-btn" data-action="cancelEdit">Cancel</button>
        ${c.draft !== part.local.join('\n') ? '<button class="gt-btn" data-action="resetEdit">Reset</button>' : ''}
        <button class="gt-btn gt-btn--primary" data-action="saveEdit" data-index="${index}">Save result</button></div>`;
      result = `<div class="gt-conflict__result"><div class="gt-section-title">Result: ${c.draft === part.local.join('\n') ? `starts with ${esc(op.local)}` : 'edited by you, not saved yet'}</div><textarea class="gt-textarea gt-mono" data-role="conflictDraft" spellcheck="false">${esc(c.draft)}</textarea></div>`;
    } else if (choice) {
      const words = chosen(choice, op);
      const again = choice.take === 'edit'
        ? `<button class="gt-btn" data-action="changeChoice" data-index="${index}">Start over</button><button class="gt-btn" data-action="editAgain" data-index="${index}">Edit again</button>`
        : `<button class="gt-btn" data-action="changeChoice" data-index="${index}">Change</button>`;
      bar = `<div class="gt-conflict__bar is-done"><span>${icon('check', 'gt-i--sm')}${label}: ${esc(words.using)}</span><span class="gt-spacer"></span>${again}</div>`;
      result = resultBlock({ title: words.result, lines: resultLines(part, choice), plain });
    } else {
      bar = `<div class="gt-conflict__bar"><span>${icon('warn', 'gt-i--sm')}${label}: both sides changed line ${line}</span></div>
      <div class="gt-conflict__actions">
        <button class="gt-btn" data-action="accept" data-take="local" data-index="${index}" title="${esc(op.local)}">Accept ${esc(op.local)}</button>
        <button class="gt-btn" data-action="accept" data-take="remote" data-index="${index}" title="${esc(op.remote)}">Accept ${esc(op.remote)}</button>
        <button class="gt-btn" data-action="accept" data-take="both" data-index="${index}">Accept both</button>
        <button class="gt-btn gt-btn--ghost" data-action="editResult" data-index="${index}">Edit result…</button>
      </div>`;
    }
    return `<div class="gt-conflict">${rows}</div>${bar}${result}`;
  });
  return `${header}<div class="gt-diff">
  <div class="gt-diff__head"><span class="gt-diff__side-label">${icon('laptop', 'gt-i--sm')}${esc(op.local)}</span><span class="gt-diff__side-label">${icon('cloud', 'gt-i--sm')}${esc(op.remote)}</span></div>
  ${blocks.join('')}
  ${total > 1 ? `<p class="gt-muted gt-conflict__count">${plural(choices.filter(Boolean).length, 'conflict', 'conflicts')} of ${total} chosen; the file is written when all are.</p>` : ''}
</div>`;
}
