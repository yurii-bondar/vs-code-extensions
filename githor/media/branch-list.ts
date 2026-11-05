// The branch list: filter input, filters, rows and their empty states (design `01`, `05`, `08`, Penpot "Branch row").
import { BRANCH_FILTERS, inFilter, marksOf } from '../src/core/marks.js';
import type { BranchFilter } from '../src/core/marks.js';
import type { Branch } from '../src/core/types.js';
import type { BusyView } from '../src/protocol.js';
import { icon } from './icons.js';
import { rowActionHtml } from './sync-controls.js';
import { age, esc } from './text.js';

const FILTER_LABELS: Record<BranchFilter, string> = { all: 'All', attention: 'Attention', local: 'Local', remote: 'Remote' };

export const matchesQuery = (branch: Branch, query: string): boolean => branch.name.toLowerCase().includes(query.trim().toLowerCase());

export function filtersHtml(branches: readonly Branch[], active: BranchFilter): string {
  return BRANCH_FILTERS.map((f) => {
    const n = branches.filter((b) => inFilter(b, f)).length;
    return `<button class="gt-filter${f === active ? ' is-on' : ''}" data-action="filter" data-filter="${f}" aria-pressed="${f === active}">${FILTER_LABELS[f]}<span class="gt-filter__n">${n}</span></button>`;
  }).join('');
}

/** `feat/` muted, the rest plain: the prefix says the kind, the rest is the name. */
function nameHtml(name: string): string {
  const cut = name.lastIndexOf('/') + 1;
  return `<span class="gt-branch__prefix">${esc(name.slice(0, cut))}</span>${esc(name.slice(cut))}`;
}

/** The chips and counts of a row; a zero count is not shown. */
function marksHtml(branch: Branch): string {
  const { local, ahead, remote, behind, end } = marksOf(branch);
  const parts: string[] = [];
  if (local) parts.push(`<span class="gt-chip">${icon('laptop', 'gt-i--sm')}local</span>${ahead ? `<span class="gt-mark gt-mark--ahead" title="${ahead} to push">↑${ahead}</span>` : ''}`);
  if (remote) parts.push(`<span class="gt-chip" title="${esc(branch.upstream ?? '')}">${icon('cloud', 'gt-i--sm')}remote</span>${behind ? `<span class="gt-mark gt-mark--behind" title="${behind} to pull">↓${behind}</span>` : ''}`);
  const tail =
    end === 'in-sync'
      ? `<span class="gt-insync">${icon('check', 'gt-i--sm')}in sync</span>`
      : end === 'diverged'
        ? `<button class="gt-diverged" data-action="compare" data-ref="${esc(branch.ref)}" title="Local and remote both moved: ${ahead} to push, ${behind} to pull. Compare them" aria-label="Compare ${esc(branch.name)} with its remote">${icon('diverge', 'gt-i--sm')}</button>`
        : '';
  return `<span class="gt-marks">${parts.join('')}</span>${tail}`;
}

interface RowArgs {
  busy: BusyView | null;
  menuRef: string | null;
  /** The branch highlighted in the log; undefined where rows cannot be selected (the sidebar has no log). */
  selectedRef?: string | null;
}

function rowHtml(branch: Branch, { busy, menuRef, selectedRef }: RowArgs): string {
  const ref = esc(branch.ref);
  const hit = selectedRef === undefined ? '' : `<button class="gt-branch__hit" data-action="selectBranch" data-ref="${ref}" aria-label="Highlight ${esc(branch.name)} in the log"></button>`;
  const more = `<button class="gt-icon-btn gt-branch__more${menuRef === branch.ref ? ' is-open' : ''}" data-action="branchMenu" data-ref="${ref}" title="Branch actions" aria-label="Branch actions" aria-haspopup="menu">${icon('more', 'gt-i--sm')}</button>`;
  const action = `${branch.current ? '' : `<button class="gt-branch__quick" data-action="switch" data-ref="${ref}">Switch</button>`}${more}`;
  const pin = branch.pinned ? `<span class="gt-branch__pin" title="Pinned">${icon('pin', 'gt-i--sm')}</span>` : '';
  return `<div class="gt-branch${branch.current ? ' is-current' : ''}${selectedRef === branch.ref ? ' is-selected' : ''}">${hit}
  <div class="gt-branch__top">
    ${branch.current ? `<span class="gt-branch__cur" title="Current branch">${icon('check', 'gt-i--sm')}</span>` : ''}
    <span class="gt-branch__name" title="${esc(branch.name)}">${nameHtml(branch.name)}</span>
    ${pin}<span class="gt-branch__age has-quick">${age(branch.committedAt)}</span>${action}
  </div>
  <div class="gt-branch__bot">${marksHtml(branch)}${rowActionHtml(branch, busy)}</div>
</div>`;
}

const empty = ({ glyph, title, text, actions = '' }: { glyph: string; title: string; text: string; actions?: string }): string =>
  `<div class="gt-empty">${glyph}<span class="gt-empty__title">${title}</span><span>${text}</span>${actions ? `<div class="gt-pane__row">${actions}</div>` : ''}</div>`;

const SKELETON = '<div class="gt-branch"><div class="gt-branch__top"><span class="gt-skeleton gt-skeleton--name"></span><span class="gt-spacer"></span><span class="gt-skeleton gt-skeleton--age"></span></div><div class="gt-branch__bot"><span class="gt-skeleton gt-skeleton--marks"></span></div></div>';

export interface ListArgs {
  loaded: boolean;
  hasRepo: boolean;
  branches: readonly Branch[];
  filter: BranchFilter;
  query: string;
  busy: BusyView | null;
  /** The branch whose menu is open. */
  menuRef: string | null;
  /** See RowArgs. */
  selectedRef?: string | null;
}

export function listHtml({ loaded, hasRepo, branches, filter, query, busy, menuRef, selectedRef }: ListArgs): string {
  if (!loaded) return SKELETON.repeat(4);
  if (!hasRepo) return empty({ glyph: icon('folder'), title: 'This folder is not a git repository', text: 'Open a folder that is a git repository.' });
  if (!branches.length) return empty({ glyph: icon('branch'), title: 'No branches yet', text: 'Make the first commit to start one.' });
  const shown = branches.filter((b) => inFilter(b, filter) && matchesQuery(b, query));
  if (shown.length) return shown.map((b) => rowHtml(b, { busy, menuRef, ...(selectedRef === undefined ? {} : { selectedRef }) })).join('');
  if (query.trim()) {
    const from = branches.find((b) => b.current)?.name;
    return empty({
      glyph: icon('search'),
      title: `No branch matches “${esc(query.trim())}”`,
      text: from ? `Create it from ${esc(from)}, or clear the filter.` : 'Clear the filter to see every branch.',
      actions: `${from ? '<button class="gt-btn gt-btn--primary" data-action="createFromQuery">Create branch</button>' : ''}<button class="gt-btn" data-action="clearQuery">Clear</button>`,
    });
  }
  return empty({ glyph: icon('check'), title: `No ${FILTER_LABELS[filter].toLowerCase()} branches`, text: 'Nothing here needs you.', actions: '<button class="gt-btn" data-action="filter" data-filter="all">Show all</button>' });
}
