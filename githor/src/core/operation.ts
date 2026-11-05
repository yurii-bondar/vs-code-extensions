// A merge or rebase of a branch with its remote (design `03`, `23`–`30`): starting it, what it is paused at, resolving
// a conflicted file, and Continue or Abort.
import { promises as fs } from 'fs';
import * as path from 'path';
import { applyResolutions, parseConflicts } from './conflict';
import type { ConflictPart, Resolution } from './conflict';
import type { GitRunner } from './git';
import type { OperationView, RepoRoot } from './types';

/** No editor can be answered from here: continuing a merge or rebase keeps git's own message. */
const NO_EDITOR = ['-c', 'core.editor=true'];

const gitPath = async (git: GitRunner, root: RepoRoot, name: string): Promise<string> => path.resolve(root, (await git.run(root, ['rev-parse', '--git-path', name])).trim());
const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);
const read = (file: string): Promise<string> => fs.readFile(file, 'utf8').then((s) => s.trim(), () => '');
const lines = (out: string): string[] => out.split('\n').filter(Boolean);

/** A short name for a commit: the remote branch or branch at it, else its short hash. */
async function nameOf(git: GitRunner, root: RepoRoot, sha: string): Promise<string> {
  const name = (await git.run(root, ['name-rev', '--name-only', '--refs=refs/remotes/*', '--refs=refs/heads/*', '--exclude=*/HEAD', '--no-undefined', sha]).catch(() => '')).trim();
  return name.replace(/^remotes\//, '').replace(/[~^].*$/, '') || sha.slice(0, 7);
}

/**
 * The merge or rebase the repository is in the middle of, or null. `local` and `remote` name the two sides as the
 * screens show them; `conflicted` are the files still unmerged.
 */
export async function readOperation(git: GitRunner, root: RepoRoot): Promise<OperationView | null> {
  const [mergeHead, rebaseMerge, rebaseApply] = await Promise.all([gitPath(git, root, 'MERGE_HEAD'), gitPath(git, root, 'rebase-merge'), gitPath(git, root, 'rebase-apply')]);
  const conflicted = lines(await git.run(root, ['diff', '--name-only', '--diff-filter=U']));
  const staged = lines(await git.run(root, ['diff', '--cached', '--name-only'])).filter((p) => !conflicted.includes(p));
  if (await exists(mergeHead)) {
    const local = (await git.run(root, ['branch', '--show-current'])).trim() || 'HEAD';
    return { kind: 'merge', local, remote: await nameOf(git, root, await read(mergeHead)), conflicted, staged };
  }
  for (const dir of [rebaseMerge, rebaseApply]) {
    if (!(await exists(dir))) continue;
    const head = (await read(path.join(dir, 'head-name'))).replace(/^refs\/heads\//, '');
    const onto = await read(path.join(dir, 'onto'));
    return { kind: 'rebase', local: head || 'HEAD', remote: onto ? await nameOf(git, root, onto) : 'upstream', conflicted, staged };
  }
  return null;
}

/** Starts merging `other` into the current branch, or rebasing it onto `other`. Returns whether it stopped at a conflict. */
export async function bringTogether(git: GitRunner, root: RepoRoot, { how, other }: { how: 'merge' | 'rebase'; other: string }): Promise<{ paused: boolean }> {
  try {
    await git.run(root, how === 'merge' ? ['merge', '--no-edit', other] : [...NO_EDITOR, 'rebase', other]);
    return { paused: false };
  } catch (e) {
    if (await readOperation(git, root)) return { paused: true };
    throw e;
  }
}

/** The conflicted file as its parts, with the sides placed for this operation (see conflict.ts). */
export async function readConflict(git: GitRunner, root: RepoRoot, { file, kind }: { file: string; kind: OperationView['kind'] }): Promise<ConflictPart[]> {
  const text = await fs.readFile(path.join(root, file), 'utf8');
  return parseConflicts(text, { localIsFirst: kind === 'merge' });
}

/** Writes the file from the choices and marks it resolved (`git add`). */
export async function resolveFile(git: GitRunner, root: RepoRoot, { file, kind, resolutions }: { file: string; kind: OperationView['kind']; resolutions: readonly Resolution[] }): Promise<void> {
  const parts = await readConflict(git, root, { file, kind });
  await fs.writeFile(path.join(root, file), applyResolutions(parts, resolutions));
  await git.run(root, ['add', '--', file]);
}

/** Puts a resolved file back in conflict, markers and all, to choose again. */
export async function reopenConflict(git: GitRunner, root: RepoRoot, file: string): Promise<void> {
  await git.run(root, ['checkout', '--merge', '--', file]);
}

/** Continue: makes the merge commit, or replays the next commit of a rebase (which can stop at a conflict again). */
export async function continueOperation(git: GitRunner, root: RepoRoot, kind: OperationView['kind']): Promise<{ paused: boolean }> {
  try {
    await git.run(root, [...NO_EDITOR, kind, '--continue']);
  } catch (e) {
    if (!(await readOperation(git, root))) throw e;
  }
  return { paused: (await readOperation(git, root)) !== null };
}

/** Abort: the branch goes back exactly as it was before the merge or rebase. */
export async function abortOperation(git: GitRunner, root: RepoRoot, kind: OperationView['kind']): Promise<void> {
  await git.run(root, [kind, '--abort']);
}
