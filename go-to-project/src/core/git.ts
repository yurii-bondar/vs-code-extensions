import { promises as fs } from 'fs';
import * as path from 'path';

/** The git dir for `dir` or one of its parents; follows the `gitdir:` file of worktrees and submodules. */
export async function resolveGitDir(dir: string): Promise<string | undefined> {
  for (let cur = dir; ; cur = path.dirname(cur)) {
    const dotGit = path.join(cur, '.git');
    try {
      const stat = await fs.stat(dotGit);
      if (stat.isDirectory()) return dotGit;
      const m = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'));
      if (m?.[1]) return path.resolve(cur, m[1].trim());
    } catch {
      // not here, keep walking up
    }
    if (path.dirname(cur) === cur) return undefined;
  }
}

/** Branch name from a git dir's HEAD, the short hash when detached; undefined when there is no git. */
export async function readBranch(dir: string): Promise<string | undefined> {
  const gitDir = await resolveGitDir(dir);
  if (!gitDir) return undefined;
  const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? head.slice(0, 7);
  return gitDir.includes(`${path.sep}worktrees${path.sep}`) ? `${branch} (worktree)` : branch;
}
