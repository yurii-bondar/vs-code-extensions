// The side-by-side diff (design `02`): the commit's files on the left with Back to log, the selected file on the
// right with Before and After, one grid row per line pair, removed and added lines tinted, changed words marked.
import type { CommitDetails, DiffRow, DiffSide, FileDiff } from '../src/core/types.js';
import { icon } from './icons.js';
import { isPlain, lineHtml } from './syntax.js';
import { esc, plural } from './text.js';

/** Which file of which commit is open; null `diff` while it is read. */
export interface DiffState {
  sha: string;
  path: string;
  diff: FileDiff | null;
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export function diffFilesHtml(state: DiffState, commit: CommitDetails | undefined): string {
  const files = commit?.files ?? [];
  const rows = files
    .map((f) => {
      const stat = f.binary ? '<span class="gt-muted">binary</span>' : `<span class="gt-plus">+${f.add}</span> <span class="gt-minus">−${f.del}</span>`;
      const st = f.status === 'A' || f.status === 'D' ? f.status : 'M';
      return `<button class="gt-file${f.path === state.path ? ' is-selected' : ''}" data-action="openFileDiff" data-sha="${esc(state.sha)}" data-path="${esc(f.path)}">
  <span class="gt-file__st gt-file__st--${st}">${f.status}</span>
  <span class="gt-file__path" title="${esc(f.path)}">${esc(nameOf(f.path))} <span class="gt-file__dir">${esc(dirOf(f.path))}</span></span>
  <span class="gt-file__stat">${stat}</span>
</button>`;
    })
    .join('');
  return `<div class="gt-pane__head">
  <button class="gt-btn gt-btn--ghost gt-diff-back" data-action="backToLog">${icon('back', 'gt-i--sm')}Back to log</button>
  <strong class="gt-diff-files__subject" title="${esc(commit?.subject ?? '')}">${esc(commit?.subject ?? '')}</strong>
  <span class="gt-section-title">${plural(files.length, 'file', 'files')} changed</span>
</div>
<div class="gt-scroll">${rows}</div>`;
}

function cell(side: DiffSide | null, tone: string, plain: boolean, extra = ''): string {
  if (!side) return `<span class="gt-diff__num${extra}"></span><span class="gt-diff__code gt-cell--none"></span>`;
  return `<span class="gt-diff__num${extra}${tone}">${side.n}</span><span class="gt-diff__code${tone}">${lineHtml(side.segs, plain) || ' '}</span>`;
}

function rowHtml(row: DiffRow, plain: boolean): string {
  const left = row.kind === 'change' || row.kind === 'del' ? ' gt-cell--del' : '';
  const right = row.kind === 'change' || row.kind === 'add' ? ' gt-cell--add' : '';
  return `<div class="gt-diff__row">${cell(row.left, left, plain)}${cell(row.right, right, plain, ' gt-diff__num--right')}</div>`;
}

export function diffPaneHtml(state: DiffState): string {
  const d = state.diff;
  const file = d ? d.path : state.path;
  if (!d) return `<div class="gt-empty"><span class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Reading ${esc(nameOf(file))}…</span></div>`;
  const add = d.hunks.reduce((n, h) => n + h.rows.filter((r) => r.right && r.kind !== 'same').length, 0);
  const del = d.hunks.reduce((n, h) => n + h.rows.filter((r) => r.left && r.kind !== 'same').length, 0);
  const head = `<div class="gt-diff-file">
  <strong>${esc(nameOf(file))}</strong> <span class="gt-file__dir">${esc(dirOf(file))}</span>
  <span class="gt-file__stat"><span class="gt-plus">+${add}</span> <span class="gt-minus">−${del}</span></span>
  <span class="gt-spacer"></span>
  <button class="gt-icon-btn" data-action="openInEditorDiff" title="Open in VS Code's diff editor" aria-label="Open in VS Code's diff editor">${icon('file', 'gt-i--sm')}</button>
</div>`;
  if (d.binary || d.tooLarge) {
    const why = d.binary ? 'This is a binary file.' : 'This diff is too large to draw here.';
    return `${head}<div class="gt-empty"><span class="gt-empty__title">${why}</span><button class="gt-btn" data-action="openInEditorDiff">Open in VS Code's diff editor</button></div>`;
  }
  const plain = isPlain(file);
  const body = d.hunks.map((h) => `<div class="gt-diff__row"><span class="gt-diff__hunk">${esc(h.header)}</span></div>${h.rows.map((r) => rowHtml(r, plain)).join('')}`).join('');
  return `${head}<div class="gt-diff">
  <div class="gt-diff__head"><span class="gt-diff__side-label">Before: ${d.before ? esc(d.before) : 'nothing (first commit)'}</span><span class="gt-diff__side-label">After: ${esc(d.after)}</span></div>
  ${body || '<div class="gt-empty"><span>No line changed: the file was only renamed or its mode changed.</span></div>'}
</div>`;
}
