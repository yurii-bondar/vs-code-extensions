// Push, pull, publish and sync of one branch (design `11`, `44`). Pull is fast-forward only: a branch where local
// and remote both moved needs the compare screen (`03`), never an automatic merge that can stop at a conflict.
import type { GitRunner } from './git';
import type { Branch, RepoRoot } from './types';

/** `origin/feat/x` → remote `origin`, branch `feat/x`. */
export function splitUpstream(upstream: string): { remote: string; branch: string } {
  const slash = upstream.indexOf('/');
  return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) };
}

/** The remote a new branch is published to: `origin` when there is one, else the first. Null with no remote. */
export async function publishRemote(git: GitRunner, root: RepoRoot): Promise<string | null> {
  const remotes = (await git.run(root, ['remote'])).split('\n').filter(Boolean);
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

export interface PushArgs {
  branch: Branch;
  /** `--force-with-lease`: stops if someone pushed since the last fetch. */
  force?: boolean;
  /** Also sends tags the remote does not have yet. */
  tags?: boolean;
}

/** Pushes a local branch to its upstream; works on a branch that is not checked out too. */
export async function push(git: GitRunner, root: RepoRoot, { branch, force = false, tags = false }: PushArgs): Promise<void> {
  if (!branch.upstream) throw new Error(`${branch.name} has no remote branch to push to.`);
  const { remote, branch: target } = splitUpstream(branch.upstream);
  await git.run(root, ['push', ...(force ? [`--force-with-lease=${target}`] : []), remote, `${branch.ref}:refs/heads/${target}`, ...(tags ? ['--tags'] : [])]);
}

/** Pushes a branch that is on no remote yet, and makes it track the new remote branch. Returns `origin/feat/x`. */
export async function publish(git: GitRunner, root: RepoRoot, branch: Branch): Promise<string> {
  const remote = await publishRemote(git, root);
  if (!remote) throw new Error('This repository has no remote to publish to.');
  await git.run(root, ['push', '--set-upstream', remote, `${branch.ref}:refs/heads/${branch.name}`]);
  return `${remote}/${branch.name}`;
}

/**
 * Brings the upstream's new commits in, fast-forward only, and returns how many came. The checked-out branch pulls;
 * any other branch is moved with `git fetch <remote> <branch>:<local>`, which refuses anything but a fast-forward,
 * without switching to it.
 */
export async function pull(git: GitRunner, root: RepoRoot, branch: Branch): Promise<number> {
  if (!branch.upstream) throw new Error(`${branch.name} has no remote branch to pull from.`);
  const { remote, branch: source } = splitUpstream(branch.upstream);
  const before = (await git.run(root, ['rev-parse', branch.ref])).trim();
  await git.run(root, branch.current ? ['pull', '--ff-only', remote, source] : ['fetch', remote, `refs/heads/${source}:${branch.ref}`]);
  return Number((await git.run(root, ['rev-list', '--count', `${before}..${branch.ref}`])).trim()) || 0;
}

/** The commits on the upstream that the local branch does not have, which a force-push removes, and their authors. */
export async function remoteOnlyCommits(git: GitRunner, root: RepoRoot, branch: Branch): Promise<{ count: number; authors: string[] }> {
  if (!branch.upstream) return { count: 0, authors: [] };
  const authors = (await git.run(root, ['log', '--format=%an', `${branch.ref}..refs/remotes/${branch.upstream}`])).split('\n').filter(Boolean);
  return { count: authors.length, authors: [...new Set(authors)] };
}
