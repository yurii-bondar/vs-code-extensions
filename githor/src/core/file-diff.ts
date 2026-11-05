import { sideBySide } from './side-by-side';
import type { GitRunner } from './git';
import type { FileChange, FileDiff, RepoRoot } from './types';

/** git's empty tree: what the first commit's files are compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Past this many diff lines the page does not draw the file. */
const MAX_LINES = 5000;

/** One changed file of a commit, side by side, against the commit's first parent; renames are followed. */
export async function fileDiff(git: GitRunner, root: RepoRoot, { sha, parent, file }: { sha: string; parent: string | null; file: FileChange }): Promise<FileDiff> {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const [diff, short] = await Promise.all([
    git.run(root, ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', parent ?? EMPTY_TREE, sha, '--', ...paths]),
    parent ? git.run(root, ['rev-parse', '--short', parent]).then((s) => s.trim()) : Promise.resolve(null),
  ]);
  const after = (await git.run(root, ['rev-parse', '--short', sha])).trim();
  const binary = /^Binary files .* differ$/m.test(diff);
  const tooLarge = diff.split('\n').length > MAX_LINES;
  return { sha, path: file.path, before: short, after, hunks: binary || tooLarge ? [] : sideBySide(diff), binary, tooLarge };
}
