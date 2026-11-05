import { refExists } from './branches';
import type { GitRunner } from './git';
import type { DeletedBranch, MergedBranch, RepoRoot } from './types';

export interface DeleteResult {
  deleted: DeletedBranch[];
  /** Remote branches deleted, as `origin/feat/x`. Nothing brings these back. */
  deletedOnRemote: string[];
  failed: { name: string; error: string }[];
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `origin/feat/x` → remote `origin`, branch `feat/x`. */
function splitUpstream(upstream: string): { remote: string; branch: string } {
  const slash = upstream.indexOf('/');
  return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) };
}

/**
 * Deletes merged branches: on their remote first when `onRemote` (only an upstream that is merged too), then locally
 * with `-D`, because git's `-d` does not recognise a squash or rebase merge. One push per remote; when it fails, each
 * branch is tried alone, so one protected branch does not keep the rest.
 */
export async function deleteBranches(git: GitRunner, root: RepoRoot, { branches, onRemote }: { branches: readonly MergedBranch[]; onRemote: boolean }): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: [], deletedOnRemote: [], failed: [] };

  if (onRemote) {
    const byRemote = new Map<string, string[]>();
    for (const b of branches) {
      if (!b.upstream || !b.upstreamMerged) continue;
      const { remote, branch } = splitUpstream(b.upstream);
      byRemote.set(remote, [...(byRemote.get(remote) ?? []), branch]);
    }
    for (const [remote, names] of byRemote) {
      try {
        await git.run(root, ['push', '--quiet', remote, '--delete', ...names]);
        result.deletedOnRemote.push(...names.map((n) => `${remote}/${n}`));
      } catch {
        for (const name of names) {
          try {
            await git.run(root, ['push', '--quiet', remote, '--delete', name]);
            result.deletedOnRemote.push(`${remote}/${name}`);
          } catch (e) {
            result.failed.push({ name: `${remote}/${name}`, error: errorText(e) });
          }
        }
      }
    }
  }

  for (const b of branches) {
    try {
      await git.run(root, ['branch', '-D', b.name]);
      result.deleted.push({ name: b.name, sha: b.sha, upstream: b.upstream });
    } catch (e) {
      result.failed.push({ name: b.name, error: errorText(e) });
    }
  }
  return result;
}

/**
 * Brings deleted local branches back at their old tips, tracking their upstream again when it still exists. Returns
 * the names that could not be restored, such as one recreated meanwhile.
 */
export async function restoreBranches(git: GitRunner, root: RepoRoot, branches: readonly DeletedBranch[]): Promise<string[]> {
  const failed: string[] = [];
  for (const b of branches) {
    try {
      await git.run(root, ['branch', b.name, b.sha]);
    } catch {
      failed.push(b.name);
      continue;
    }
    if (b.upstream && (await refExists(git, root, `refs/remotes/${b.upstream}`))) {
      await git.run(root, ['branch', `--set-upstream-to=${b.upstream}`, b.name]).catch(() => undefined);
    }
  }
  return failed;
}
