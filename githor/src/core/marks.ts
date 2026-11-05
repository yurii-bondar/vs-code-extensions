// The sync language of the design (Penpot "Branch row sync marks"), shared by the branch list, the quick pick and
// the status bar. Pure: the webview imports this file as well.
import type { Branch } from './types';

/** What a branch row shows beside its chips. A zero count is not shown. */
export interface RowMarks {
  /** The `local` chip, with `↑ahead` beside it when ahead is not zero. */
  local: boolean;
  ahead: number;
  /** The `remote` chip, with `↓behind` beside it when behind is not zero. */
  remote: boolean;
  behind: number;
  /** The right side of the row: `in sync` when both counts are zero, the `⇅` icon when both are not. */
  end: 'in-sync' | 'diverged' | null;
}

export function marksOf(branch: Branch): RowMarks {
  switch (branch.sync) {
    case 'remote':
      return { local: false, ahead: 0, remote: true, behind: 0, end: null };
    case 'gone':
      // The remote branch was deleted: the row shows its local chip alone.
      return { local: true, ahead: 0, remote: false, behind: 0, end: null };
    case 'unpushed':
      return { local: true, ahead: branch.ahead, remote: false, behind: 0, end: null };
    case 'synced':
    case 'ahead':
    case 'behind':
    case 'diverged': {
      const { ahead, behind } = branch;
      const end = ahead && behind ? 'diverged' : !ahead && !behind ? 'in-sync' : null;
      return { local: true, ahead, remote: true, behind, end };
    }
    default: {
      const unreachable: never = branch.sync;
      return unreachable;
    }
  }
}

export type BranchFilter = 'all' | 'attention' | 'local' | 'remote';
export const BRANCH_FILTERS: readonly BranchFilter[] = ['all', 'attention', 'local', 'remote'];

/**
 * `attention`: something to push, pull or clean up. `local`: on this machine only (never pushed, or deleted on the
 * remote). `remote`: on a remote only.
 */
export function inFilter(branch: Branch, filter: BranchFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'attention':
      return branch.ahead > 0 || branch.behind > 0 || branch.sync === 'gone';
    case 'local':
      return branch.sync === 'unpushed' || branch.sync === 'gone';
    case 'remote':
      return branch.sync === 'remote';
    default: {
      const unreachable: never = filter;
      return unreachable;
    }
  }
}

/** The marks as text, for the status bar and the quick pick: `↑2`, `↓3`, `↑1 ↓2`, `in sync`, or empty. */
export function marksText(branch: Branch): string {
  const marks = marksOf(branch);
  if (marks.end === 'in-sync') return 'in sync';
  return [marks.ahead ? `↑${marks.ahead}` : '', marks.behind ? `↓${marks.behind}` : ''].filter(Boolean).join(' ');
}
