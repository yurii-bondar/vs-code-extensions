import { promises as fs } from 'fs';
import * as path from 'path';
import type { GitRunner } from './git';
import type { RepoRoot } from './types';

/** Fetches the current branch's remote (`origin` when it has none), or every remote, dropping deleted branches. */
export async function fetchRemotes(git: GitRunner, root: RepoRoot, { all }: { all: boolean }): Promise<void> {
  await git.run(root, all ? ['fetch', '--all', '--prune'] : ['fetch', '--prune']);
}

/** When the repository last fetched, from `FETCH_HEAD`'s time; null when it never has. */
export async function lastFetchedAt(git: GitRunner, root: RepoRoot): Promise<number | null> {
  try {
    const file = path.resolve(root, (await git.run(root, ['rev-parse', '--git-path', 'FETCH_HEAD'])).trim());
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}
