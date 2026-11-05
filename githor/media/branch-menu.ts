// The menu on a branch, opened with `⋯` on its row (design `31`, `32`). Merge into and Rebase onto another branch
// are left out until they have a confirmation (a gap in the design), rather than shown dead.
import { cannotPull, cannotPush } from '../src/core/sync-rules.js';
import type { Branch } from '../src/core/types.js';
import { icon } from './icons.js';
import { esc } from './text.js';

/** The open menu: which branch, and where its `⋯` button sits on screen. */
export interface BranchMenu {
  ref: string;
  x: number;
  y: number;
}

/** Why a branch cannot be deleted, or null when it can. */
export function cannotDelete(branch: Branch, defaultBranch: string | null): string | null {
  if (branch.current) return 'This is your current branch. Switch first.';
  if (branch.name === defaultBranch) return `${branch.name} is the default branch.`;
  return null;
}

const item = ({ action, ref, label, why = null, note = null, danger = false }: { action: string; ref: string; label: string; why?: string | null; note?: string | null; danger?: boolean }): string =>
  `<button class="gt-menu__item${danger ? ' gt-menu__item--danger' : ''}" role="menuitem" data-action="${action}" data-ref="${esc(ref)}"${why ? ' disabled' : ''}>
    <span>${label}</span>${why || note ? `<span class="gt-menu__note">${esc(why ?? note ?? '')}</span>` : ''}
  </button>`;
const SEP = '<div class="gt-menu__sep" role="separator"></div>';

export function branchMenuHtml(branch: Branch, { defaultBranch }: { defaultBranch: string | null }): string {
  const ref = branch.ref;
  const parts: string[] = [];
  if (!branch.current) parts.push(item({ action: 'switch', ref, label: 'Switch', note: branch.local ? null : 'Creates a local branch from origin.' }));
  parts.push(item({ action: 'newBranchFrom', ref, label: 'New branch from here…' }));

  if (branch.local) {
    parts.push(SEP);
    if (branch.sync === 'unpushed' || branch.sync === 'gone') {
      parts.push(item({ action: 'publish', ref, label: 'Publish to origin' }));
    } else {
      parts.push(item({ action: 'pull', ref, label: `Pull${branch.behind ? ` ${branch.behind}` : ''}`, why: cannotPull(branch) }));
      parts.push(item({ action: 'push', ref, label: `Push${branch.ahead ? ` ${branch.ahead}` : ''}`, why: cannotPush(branch) }));
      parts.push(item({ action: 'syncBranch', ref, label: 'Sync', why: cannotPull(branch) }));
      parts.push(item({ action: 'compare', ref, label: 'Compare with remote', why: branch.ahead || branch.behind ? null : 'Nothing differs: the branch is in sync.' }));
    }
    parts.push(SEP);
    parts.push(item({ action: 'renameBranch', ref, label: 'Rename…' }));
    parts.push(item({ action: branch.pinned ? 'unpin' : 'pin', ref, label: branch.pinned ? 'Unpin' : 'Pin' }));
  } else {
    parts.push(SEP);
  }
  parts.push(item({ action: 'copyName', ref, label: 'Copy name' }));
  parts.push(SEP);
  parts.push(
    branch.local
      ? item({ action: 'deleteBranchAsk', ref, label: 'Delete…', why: cannotDelete(branch, defaultBranch), danger: true })
      : item({ action: 'deleteBranchAsk', ref, label: 'Delete on origin…', danger: true })
  );
  return `<div class="gt-menu gt-menu--floating" role="menu" data-stop data-role="branchMenu">
  <div class="gt-menu__title">${icon('branch', 'gt-i--sm')}${esc(branch.local ? branch.name : (branch.upstream ?? branch.name))}</div>
  ${parts.join('')}
</div>`;
}
