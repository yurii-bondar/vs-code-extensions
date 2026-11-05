import { promises as fs } from 'fs';
import * as path from 'path';
import type { GitRunner } from './git';
import type { RepoRoot } from './types';

/** The git config key Claudestrator sets on a branch its task made: `branch.<name>.claudestratorTask`. */
const OWNER_KEY = 'claudestratorTask';

/**
 * The unfinished Claudestrator task `branch` belongs to, or null. A task commits only when it finishes, so until
 * then its branch looks merged and must be kept. Finished: its record has a `published` event, or a `local` answer to
 * the push checkpoint. A task whose record is gone guards nothing. `taskDirs` are the folders Claudestrator may keep
 * `.orch/` in: the repository and the workspace folders.
 */
export async function unfinishedTask({ git, root, branch, taskDirs }: { git: GitRunner; root: RepoRoot; branch: string; taskDirs: readonly string[] }): Promise<string | null> {
  const task = await git.run(root, ['config', '--get', `branch.${branch}.${OWNER_KEY}`]).then(
    (s) => s.trim(),
    () => ''
  );
  if (!task) return null;
  for (const dir of taskDirs) {
    const events = await fs.readFile(path.join(dir, '.orch', 'tasks', task, 'events.ndjson'), 'utf8').catch(() => null);
    if (events === null) continue;
    const finished = events.includes('"type":"published"') || events.split('\n').some((l) => l.includes('"confirm-push"') && l.includes('"option":"local"'));
    return finished ? null : task;
  }
  return null;
}
