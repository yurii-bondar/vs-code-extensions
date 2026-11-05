// A branch that moved on both sides, compared with its remote (design `03`).
import { GitError } from './git';
import type { GitRunner } from './git';
import type { Branch, CompareView, RepoRoot } from './types';

const commitLines = async (git: GitRunner, root: RepoRoot, range: readonly string[]): Promise<CompareView['local']> =>
  (await git.run(root, ['log', '--format=%h%x00%an%x00%ae%x00%ct%x00%s', ...range]))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [short = '', author = '', email = '', time = '0', subject = ''] = l.split('\0');
      return { short, author, email, committedAt: Number(time) * 1000, subject };
    });

/**
 * The commits only the local branch has and only its remote has, where they start from, and the files a merge of the
 * two would conflict in (from `git merge-tree`, which merges without touching the working copy; git 2.38 or later,
 * else null).
 */
export async function compareWithRemote(git: GitRunner, root: RepoRoot, branch: Branch): Promise<CompareView> {
  if (!branch.upstream) throw new Error(`${branch.name} has no remote branch to compare with.`);
  const remote = `refs/remotes/${branch.upstream}`;
  const [local, onRemote, base] = await Promise.all([
    commitLines(git, root, [`${remote}..${branch.ref}`]),
    commitLines(git, root, [`${branch.ref}..${remote}`]),
    git.run(root, ['merge-base', branch.ref, remote]).then((s) => s.trim()),
  ]);
  const [baseLine] = await commitLines(git, root, ['-1', base]);
  // exit 0: merges cleanly; exit 1: the tree, then the conflicted paths; anything else: this git cannot tell
  const conflicts = await git.run(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', branch.ref, remote]).then(
    () => [],
    (e: unknown) => (e instanceof GitError && e.exitCode === 1 ? e.stdout.split('\n').slice(1).filter(Boolean) : null)
  );
  return { ref: branch.ref, name: branch.name, upstream: branch.upstream, local, remote: onRemote, base: baseLine ?? null, conflicts };
}
