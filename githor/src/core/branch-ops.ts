// Creating, renaming and deleting one branch (design `33`–`37`, `43`), and what deleting it would lose.
import { refExists } from './branches';
import { splitUpstream } from './sync';
import type { GitRunner } from './git';
import type { Branch, RepoRoot } from './types';

export interface CommitLine {
  sha: string;
  subject: string;
  author: string;
}

const lines = (out: string): CommitLine[] =>
  out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha = '', author = '', subject = ''] = l.split('\0');
      return { sha, author, subject };
    });

/** Why `name` cannot be a new branch, or null when it can. */
export async function nameProblem(git: GitRunner, root: RepoRoot, name: string): Promise<string | null> {
  if (!name.trim()) return 'Type a name.';
  const valid = await git.run(root, ['check-ref-format', '--branch', name]).then(
    () => true,
    () => false
  );
  if (!valid || name !== name.trim()) return 'Not a valid branch name: no spaces, `..`, `~`, `^`, `:` or a trailing `/`.';
  if (await refExists(git, root, `refs/heads/${name}`)) return 'A branch with this name already exists.';
  return null;
}

/** Makes `name` at `start` (a branch's ref), and checks it out when `switchTo`. */
export async function createBranch(git: GitRunner, root: RepoRoot, { name, start, switchTo }: { name: string; start: string; switchTo: boolean }): Promise<void> {
  await git.run(root, switchTo ? ['switch', '--create', name, start] : ['branch', name, start]);
}

/**
 * Renames a local branch. With `onRemote`, pushes the new name to the branch's remote, makes the branch track it, and
 * deletes the old name there; anyone using the old name has to switch.
 */
export async function renameBranch(git: GitRunner, root: RepoRoot, { branch, to, onRemote }: { branch: Branch; to: string; onRemote: boolean }): Promise<void> {
  await git.run(root, ['branch', '--move', branch.name, to]);
  if (!onRemote || !branch.upstream) return;
  const { remote, branch: old } = splitUpstream(branch.upstream);
  await git.run(root, ['push', '--set-upstream', remote, `refs/heads/${to}:refs/heads/${to}`]);
  await git.run(root, ['push', remote, '--delete', old]);
}

/** Deletes a local branch, with `-D` because a squash merge does not count for `-d`; on its remote too when asked. */
export async function deleteBranch(git: GitRunner, root: RepoRoot, { branch, onRemote }: { branch: Branch; onRemote: boolean }): Promise<void> {
  if (onRemote && branch.upstream) await deleteOnRemote(git, root, branch.upstream);
  if (branch.local) await git.run(root, ['branch', '-D', branch.name]);
}

/** Deletes `origin/feat/x` on its remote. Nothing brings it back. */
export async function deleteOnRemote(git: GitRunner, root: RepoRoot, upstream: string): Promise<void> {
  const { remote, branch } = splitUpstream(upstream);
  await git.run(root, ['push', remote, '--delete', branch]);
}

/**
 * Commits that are on `branch` and on no other branch, local or remote: what deleting it loses. `withUpstream`: count
 * the commits only its remote copy has as well, which is what deleting both loses.
 */
export async function onlyHere(git: GitRunner, root: RepoRoot, { branch, withUpstream }: { branch: Branch; withUpstream: boolean }): Promise<{ local: CommitLine[]; remote: CommitLine[] }> {
  // --exclude takes the name as --branches and --remotes see it: without refs/heads/ or refs/remotes/.
  const notElsewhere = ['--not', `--exclude=${branch.name}`, '--branches', ...(branch.upstream ? [`--exclude=${branch.upstream}`] : []), '--remotes'];
  const log = (ref: string, others: readonly string[]): Promise<CommitLine[]> => git.run(root, ['log', '--format=%h%x00%an%x00%s', ref, ...others]).then(lines);
  const local = branch.local ? await log(branch.ref, ['--not', `--exclude=${branch.name}`, '--branches', '--remotes']) : [];
  const upstreamRef = branch.upstream ? `refs/remotes/${branch.upstream}` : null;
  const remote = withUpstream && upstreamRef && (await refExists(git, root, upstreamRef)) ? await log(upstreamRef, notElsewhere) : [];
  return { local, remote };
}
