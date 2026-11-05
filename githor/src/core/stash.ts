// Stashes (design `09`): listing them with their files, stashing changes, Apply, Rename, Delete with Undo, and a stashed
// file's diff. A stash is named by its commit, since `stash@{n}` numbers shift as stashes come and go.
import { fileDiff } from './file-diff';
import { parseChanges } from './log';
import type { GitRunner } from './git';
import type { FileChange, FileDiff, RepoRoot, StashView } from './types';

const lines = (out: string): string[] => out.split('\n').filter(Boolean);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** `WIP on main: 1a2b3c subject` or `On main: my message` → the branch and what to call the stash. */
export function parseStashSubject(subject: string): { branch: string; message: string } {
  const named = /^On ([^:]+): (.*)$/.exec(subject);
  if (named) return { branch: named[1] ?? '', message: named[2] ?? '' };
  const wip = /^WIP on ([^:]+): (.*)$/.exec(subject);
  if (wip) return { branch: wip[1] ?? '', message: `WIP: ${(wip[2] ?? '').replace(/^[0-9a-f]+ /, '')}` };
  return { branch: '', message: subject };
}

/** The untracked files a stash holds, in its third parent; none when it was made without them. */
async function untrackedOf(git: GitRunner, root: RepoRoot, sha: string): Promise<FileChange[]> {
  const third = await git.run(root, ['rev-parse', '--verify', '--quiet', `${sha}^3`]).then((s) => s.trim(), () => null);
  if (!third) return [];
  return parseChanges(await git.run(root, ['diff', '--numstat', EMPTY_TREE, third]), await git.run(root, ['diff', '--name-status', EMPTY_TREE, third]));
}

export async function listStashes(git: GitRunner, root: RepoRoot): Promise<StashView[]> {
  const out = await git.run(root, ['stash', 'list', '--format=%H%x00%gs%x00%ct']).catch(() => '');
  return Promise.all(
    lines(out).map(async (line) => {
      const [sha = '', subject = '', time = '0'] = line.split('\0');
      const tracked = parseChanges(await git.run(root, ['diff', '-M', '--numstat', `${sha}^1`, sha]), await git.run(root, ['diff', '-M', '--name-status', `${sha}^1`, sha]));
      return { sha, ...parseStashSubject(subject), createdAt: Number(time) * 1000, files: [...tracked, ...(await untrackedOf(git, root, sha))] };
    })
  );
}

/** How many stashes there are, cheaply, for the tab's count. */
export async function stashCount(git: GitRunner, root: RepoRoot): Promise<number> {
  return lines(await git.run(root, ['stash', 'list', '--format=%H']).catch(() => '')).length;
}

/** `stash@{n}` for a stash commit; throws when it is gone. */
async function refOf(git: GitRunner, root: RepoRoot, sha: string): Promise<string> {
  const shas = lines(await git.run(root, ['stash', 'list', '--format=%H']));
  const n = shas.indexOf(sha);
  if (n === -1) throw new Error('That stash is gone. The list is up to date now.');
  return `stash@{${n}}`;
}

/**
 * Stashes changes: every change, or only `paths`; untracked files only with `includeUntracked`. Returns the stash
 * commit, or null when there was nothing to stash.
 */
export async function stashPush(git: GitRunner, root: RepoRoot, { message, paths, includeUntracked }: { message: string; paths: readonly string[] | null; includeUntracked: boolean }): Promise<string | null> {
  const before = await git.run(root, ['rev-parse', '--verify', '--quiet', 'refs/stash']).then((s) => s.trim(), () => null);
  await git.run(root, ['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []), ...(message ? ['--message', message] : []), ...(paths ? ['--', ...paths] : [])]);
  const after = await git.run(root, ['rev-parse', '--verify', '--quiet', 'refs/stash']).then((s) => s.trim(), () => null);
  return after && after !== before ? after : null;
}

/** Puts the stash's changes back into the working copy and keeps the stash. */
export async function applyStash(git: GitRunner, root: RepoRoot, sha: string): Promise<void> {
  await git.run(root, ['stash', 'apply', await refOf(git, root, sha)]);
}

/** Deletes a stash; returns what Undo needs to bring it back. */
export async function dropStash(git: GitRunner, root: RepoRoot, sha: string): Promise<{ sha: string; message: string }> {
  const ref = await refOf(git, root, sha);
  const subject = (await git.run(root, ['log', '-g', '-1', '--format=%gs', ref])).trim();
  await git.run(root, ['stash', 'drop', ref]);
  return { sha, message: subject };
}

/** Undo of a delete: the same stash commit is listed again, on top. */
export async function restoreStash(git: GitRunner, root: RepoRoot, { sha, message }: { sha: string; message: string }): Promise<void> {
  await git.run(root, ['stash', 'store', '--message', message, sha]);
}

/** Renames a stash: git keeps no name of its own for it, so it is stored again, on top, under the new one. */
export async function renameStash(git: GitRunner, root: RepoRoot, { sha, message }: { sha: string; message: string }): Promise<void> {
  const { message: old } = await dropStash(git, root, sha);
  const branch = parseStashSubject(old).branch;
  await restoreStash(git, root, { sha, message: branch ? `On ${branch}: ${message}` : message });
}

/** One stashed file side by side: the commit it was stashed on, and the stashed version. */
export async function stashFileDiff(git: GitRunner, root: RepoRoot, { sha, file }: { sha: string; file: FileChange }): Promise<FileDiff> {
  const inTree = lines(await git.run(root, ['ls-tree', '--name-only', sha, '--', file.path])).length > 0 || file.status === 'D';
  if (inTree) return fileDiff(git, root, { sha, parent: `${sha}^1`, file });
  // an untracked file lives in the stash's third parent, against nothing
  const third = (await git.run(root, ['rev-parse', `${sha}^3`])).trim();
  const diff = await fileDiff(git, root, { sha: third, parent: null, file });
  return { ...diff, sha };
}
