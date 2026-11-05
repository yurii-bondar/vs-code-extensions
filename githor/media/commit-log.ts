// The commit log pane (design `01`, `14`): search, Only mine, the highlighted branch, and a row per commit with its
// graph, refs, author, age and hash.
import { graphWidth, layoutGraph } from '../src/core/graph.js';
import type { GraphRow } from '../src/core/graph.js';
import type { CommitView, RefChip } from '../src/core/types.js';
import { icon } from './icons.js';
import { age, esc } from './text.js';

export interface LogState {
  commits: CommitView[] | null;
  hasMore: boolean;
  /** The person's commit address, for Only mine and "You". */
  me: string | null;
  /** How many commits are asked for. */
  limit: number;
  query: string;
  onlyMine: boolean;
  /** Selected commits, in the order picked. */
  selected: string[];
}

export const LOG_PAGE = 300;
export const emptyLog = (): LogState => ({ commits: null, hasMore: false, me: null, limit: LOG_PAGE, query: '', onlyMine: false, selected: [] });

const ROW = 32;
const LANE = 12;
const lx = (lane: number): number => 10 + lane * LANE;

/** One row's slice of the graph: half-lines bent with vertical tangents, and the node. */
function graphSvg(row: GraphRow, width: number, { head, dim }: { head: boolean; dim: boolean }): string {
  const half = ROW / 2;
  const line = (from: number, to: number, y0: number, color: number): string => {
    const x0 = lx(from);
    const x1 = lx(to);
    const d = x0 === x1 ? `M${x0} ${y0}V${y0 + half}` : `M${x0} ${y0}C${x0} ${y0 + half * 0.75} ${x1} ${y0 + half * 0.25} ${x1} ${y0 + half}`;
    return `<path class="gt-lane-${color % 4}" d="${d}"/>`;
  };
  const lines = [...row.up.map((l) => line(l.from, l.to, 0, l.color)), ...row.down.map((l) => line(l.from, l.to, half, l.color))].join('');
  const node = `<circle class="gt-node gt-lane-${row.color % 4}" cx="${lx(row.lane)}" cy="${half}" r="${head ? 5.5 : 4}"/>`;
  return `<svg class="gt-commit__graph${dim ? ' is-dim' : ''}" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}" aria-hidden="true">${lines}${node}</svg>`;
}

function refHtml(ref: RefChip): string {
  const glyph = ref.kind === 'tag' ? icon('tag', 'gt-i--sm') : `${ref.local ? icon('laptop', 'gt-i--sm') : ''}${ref.remote ? icon('cloud', 'gt-i--sm') : ''}`;
  return `<span class="gt-ref${ref.head ? ' is-head' : ''}" title="${esc(ref.kind === 'tag' ? `tag ${ref.name}` : `${ref.local ? 'local' : ''}${ref.local && ref.remote ? ' and ' : ''}${ref.remote ? 'remote' : ''} branch ${ref.name}`)}">${glyph}${esc(ref.name)}</span>`;
}

export const authorName = (c: { author: string; email: string }, me: string | null): string => (me && c.email === me ? 'You' : c.author);
export const avatar = (name: string): string => `<span class="gt-avatar" aria-hidden="true">${esc((name.trim()[0] ?? '?').toUpperCase())}</span>`;

export interface LogPaneArgs {
  log: LogState;
  head: string | null;
  /** The highlighted branch: its name, and the commits it reaches; null highlights everything. */
  highlight: { name: string; reach: Set<string> } | null;
}

export function logHeadHtml({ log, highlight }: Pick<LogPaneArgs, 'log' | 'highlight'>): string {
  return `<div class="gt-pane__row gt-log-head">
  <label class="gt-input gt-log-head__search">${icon('search', 'gt-i--sm')}<input data-role="logQuery" value="${esc(log.query)}" placeholder="Search message, hash or author" aria-label="Search commits" spellcheck="false"></label>
  <button class="gt-filter${log.onlyMine ? ' is-on' : ''}" data-action="onlyMine" aria-pressed="${log.onlyMine}"${log.me ? '' : ' disabled title="git has no user.email for this repository"'}>Only mine</button>
  ${highlight ? `<span class="gt-toolbar__meta">Highlighting</span><strong class="gt-log-head__branch" title="${esc(highlight.name)}">${esc(highlight.name)}</strong>` : ''}
</div>`;
}

export function logRowsHtml({ log, head, highlight }: LogPaneArgs): string {
  const commits = log.commits;
  if (!commits) return '<div class="gt-empty"><span class="gt-dialog__loading">' + icon('spinner', 'gt-spin') + 'Reading the log…</span></div>';
  if (!commits.length) return '<div class="gt-empty"><span class="gt-empty__title">No commits yet</span><span>Make the first commit to start the log.</span></div>';

  const q = log.query.trim().toLowerCase();
  const filtering = q !== '' || log.onlyMine;
  const matches = (c: CommitView): boolean =>
    (!log.onlyMine || c.email === log.me) && (!q || c.subject.toLowerCase().includes(q) || c.sha.startsWith(q) || c.author.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
  // the graph only makes sense over the whole log; a filtered list shows the commits alone
  const rows = filtering ? null : layoutGraph(commits);
  const width = rows ? Math.min(graphWidth(rows), 8) * LANE + 8 : 0;
  const selected = new Set(log.selected);

  const html = commits.flatMap((c, i) => {
    if (filtering && !matches(c)) return [];
    const dim = highlight !== null && !highlight.reach.has(c.sha);
    const row = rows?.[i];
    const who = authorName(c, log.me);
    return [
      `<button class="gt-commit${selected.has(c.sha) ? ' is-selected' : ''}${dim ? ' is-dim' : ''}" data-action="selectCommit" data-sha="${esc(c.sha)}">
  ${row ? graphSvg(row, width, { head: c.sha === head, dim }) : '<span class="gt-commit__nograph"></span>'}
  <span class="gt-commit__subject" title="${esc(c.subject)}">${esc(c.subject)}</span>
  <span class="gt-commit__refs">${c.refs.map(refHtml).join('')}</span>
  <span class="gt-commit__author">${avatar(who)}${esc(who)}</span>
  <span class="gt-commit__time">${age(c.committedAt)}</span>
  <span class="gt-commit__hash gt-mono">${esc(c.short)}</span>
</button>`,
    ];
  });
  if (!html.length) return `<div class="gt-empty">${icon('search')}<span class="gt-empty__title">No commit matches</span><span>Only the newest ${commits.length} commits are searched.</span></div>`;
  const more = log.hasMore ? `<div class="gt-log__more"><button class="gt-btn" data-action="moreCommits">Load ${LOG_PAGE} more</button></div>` : '';
  return `<div class="gt-log">${html.join('')}</div>${more}`;
}
