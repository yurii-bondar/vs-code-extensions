// The working copy: what changed since the last commit (design `04`, `49`), its diff, and committing a chosen set of
// files; plus the commits a push would send (`10`).
import { promises as fs } from 'fs';
import * as path from 'path';
import { sideBySide } from './side-by-side';
import type { GitRunner } from './git';
import type { Branch, FileDiff, RepoRoot, WorkingFile } from './types';

/** git's empty tree: what a repository without a commit yet is compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_UNTRACKED_BYTES = 512 * 1024;

const headOrEmpty = (git: GitRunner, root: RepoRoot): Promise<string> => git.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => 'HEAD', () => EMPTY_TREE);

type Letter = WorkingFile['status'];
const LETTERS = new Set(['A', 'M', 'D', 'R', 'T']);

/** `git status --porcelain=v2 -z --untracked-files=all`: tracked changes (staged or not), unmerged and untracked files. */
export function parseStatus(out: string): WorkingFile[] {
  const parts = out.split('\0');
  const files: WorkingFile[] = [];
  const file = (p: string, status: Letter, extra: Partial<WorkingFile> = {}): WorkingFile => ({ path: p, oldPath: null, status, conflicted: false, add: 0, del: 0, binary: false, ...extra });
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? '';
    const fields = entry.split(' ');
    switch (entry[0]) {
      case '1': {
        const xy = fields[1] ?? '..';
        const letter = (xy[0] !== '.' ? xy[0] : xy[1]) ?? 'M';
        files.push(file(fields.slice(8).join(' '), (LETTERS.has(letter) ? letter : 'M') as Letter));
        break;
      }
      case '2':
        // the original path follows as its own NUL-separated part
        files.push(file(fields.slice(9).join(' '), 'R', { oldPath: parts[++i] ?? null }));
        break;
      case 'u':
        files.push(file(fields.slice(10).join(' '), 'M', { conflicted: true }));
        break;
      case '?':
        files.push(file(entry.slice(2), 'U'));
        break;
      default:
        break;
    }
  }
  return files;
}

/** `git diff --numstat -z`: added and removed lines per path; a rename's counts are filed under its new path. */
export function parseNumstat(out: string): Map<string, { add: number; del: number; binary: boolean }> {
  const stats = new Map<string, { add: number; del: number; binary: boolean }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const [add = '', del = '', p = ''] = (parts[i] ?? '').split('\t');
    if (add === '') continue;
    const target = p === '' ? ((i += 2), parts[i] ?? '') : p;
    stats.set(target, { add: add === '-' ? 0 : Number(add), del: del === '-' ? 0 : Number(del), binary: add === '-' });
  }
  return stats;
}

/** Every file the working copy changed since the last commit, with its line counts. */
export async function readWorking(git: GitRunner, root: RepoRoot): Promise<WorkingFile[]> {
  const base = await headOrEmpty(git, root);
  const [status, numstat] = await Promise.all([git.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']), git.run(root, ['diff', '-M', '--numstat', '-z', base])]);
  const stats = parseNumstat(numstat);
  return parseStatus(status).map((f) => ({ ...f, ...(stats.get(f.path) ?? {}) }));
}

/** One working-copy file side by side: the last commit on the left, the working copy on the right. */
export async function workingDiff(git: GitRunner, root: RepoRoot, file: WorkingFile): Promise<FileDiff> {
  const label = { sha: 'WORKTREE', path: file.path, before: 'HEAD', after: 'working copy' };
  if (file.status === 'U') {
    const full = path.join(root, file.path);
    const size = (await fs.stat(full)).size;
    if (size > MAX_UNTRACKED_BYTES) return { ...label, hunks: [], binary: false, tooLarge: true };
    const text = await fs.readFile(full, 'utf8');
    if (text.includes('\0')) return { ...label, hunks: [], binary: true, tooLarge: false };
    const lines = text.replace(/\n$/, '').split('\n');
    return { ...label, hunks: [{ header: `@@ -0,0 +1,${lines.length} @@ new file`, rows: lines.map((t, i) => ({ kind: 'add' as const, left: null, right: { n: i + 1, segs: [{ text: t, changed: false }] } })) }], binary: false, tooLarge: false };
  }
  const base = await headOrEmpty(git, root);
  const diff = await git.run(root, ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', base, '--', ...(file.oldPath ? [file.oldPath, file.path] : [file.path])]);
  const binary = /^Binary files .* differ$/m.test(diff);
  return { ...label, hunks: binary ? [] : sideBySide(diff), binary, tooLarge: false };
}

/**
 * Commits exactly these files as they are in the working copy: new ones are added first, and `--only` leaves out
 * anything else that was staged. Returns the new commit and the one it was made on (null for the first commit).
 */
export async function commitFiles(git: GitRunner, root: RepoRoot, { files, message }: { files: readonly WorkingFile[]; message: string }): Promise<{ sha: string; parent: string | null }> {
  const paths = files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
  const parent = await git.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((s) => s.trim(), () => null);
  await git.run(root, ['add', '--all', '--', ...paths]);
  await git.run(root, ['commit', '--only', '--message', message, '--', ...paths]);
  return { sha: (await git.run(root, ['rev-parse', 'HEAD'])).trim(), parent };
}

/** Undo of a commit: the branch goes back to `parent`, and the commit's changes stay in the working copy, staged. */
export async function uncommit(git: GitRunner, root: RepoRoot, parent: string): Promise<void> {
  await git.run(root, ['reset', '--soft', parent]);
}

/** The commits a push of `branch` sends, newest first: those its upstream lacks, or no remote has when it has none. */
export async function commitsToPush(git: GitRunner, root: RepoRoot, branch: Branch): Promise<string[]> {
  const range = branch.upstream && branch.sync !== 'gone' ? [`refs/remotes/${branch.upstream}..${branch.ref}`] : [branch.ref, '--not', '--remotes'];
  return (await git.run(root, ['rev-list', ...range])).split('\n').filter(Boolean);
}
