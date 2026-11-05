// What a commit's details offer (design `01`, `14`): Switch to it, Cherry-pick it onto the current branch, Revert it.
// The conflict screens come with merge (`23`–`30`); until then a cherry-pick or revert that stops at a conflict is
// aborted at once, so the repository is left as it was.
import type { GitRunner } from './git';
import type { RepoRoot } from './types';

export class ConflictError extends Error {
  constructor(
    readonly files: readonly string[],
    what: string
  ) {
    super(`${what} stopped at a conflict in ${files.join(', ') || 'some files'}. Nothing was changed.`);
  }
}

const head = async (git: GitRunner, root: RepoRoot): Promise<string> => (await git.run(root, ['rev-parse', 'HEAD'])).trim();

/** The files git left unmerged. */
async function conflicted(git: GitRunner, root: RepoRoot): Promise<string[]> {
  return (await git.run(root, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
}

/** Runs a cherry-pick or revert; on a conflict, aborts it and throws ConflictError with the files. */
async function applying({ git, root, args, what }: { git: GitRunner; root: RepoRoot; args: readonly string[]; what: string }): Promise<void> {
  try {
    await git.run(root, args);
  } catch (e) {
    const files = await conflicted(git, root).catch(() => []);
    if (!files.length) throw e;
    await git.run(root, [args[0] ?? 'cherry-pick', '--abort']).catch(() => undefined);
    throw new ConflictError(files, what);
  }
}

/** Checks the commit out without a branch (detached), which is what Switch on a commit means. */
export async function switchToCommit(git: GitRunner, root: RepoRoot, sha: string): Promise<void> {
  await git.run(root, ['switch', '--detach', sha]);
}

/**
 * Applies commits onto the current branch, oldest first, whatever order they were picked in. Returns the commit the
 * branch was at, for Undo.
 */
export async function cherryPick(git: GitRunner, root: RepoRoot, shas: readonly string[]): Promise<string> {
  const before = await head(git, root);
  const ordered = (await git.run(root, ['rev-list', '--topo-order', '--reverse', '--no-walk', ...shas])).split('\n').filter(Boolean);
  await applying({ git, root, args: ['cherry-pick', ...ordered], what: 'Cherry-pick' });
  return before;
}

/** Adds a commit that undoes `sha`; a merge commit is reverted against its first parent. Returns the old tip. */
export async function revertCommit(git: GitRunner, root: RepoRoot, sha: string): Promise<string> {
  const before = await head(git, root);
  const parents = (await git.run(root, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').length - 1;
  await applying({ git, root, args: ['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), sha], what: 'Revert' });
  return before;
}

/** Undo of a cherry-pick or revert: the branch goes back to `sha`, keeping uncommitted changes (`reset --keep`). */
export async function resetTo(git: GitRunner, root: RepoRoot, sha: string): Promise<void> {
  await git.run(root, ['reset', '--keep', sha]);
}
