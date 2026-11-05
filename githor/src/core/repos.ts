import * as path from 'path';
import type { RepoRoot } from './types';

export interface PickRepoArgs {
  /** The repositories VS Code has open. */
  roots: readonly RepoRoot[];
  /** The file in the active editor, if any. */
  file?: string | undefined;
  /** The repository the panel shows now. */
  current?: RepoRoot | null;
}

/**
 * The repository to show: the innermost one holding `file`, else the one shown now while it is still open,
 * else the first. Null when no repository is open.
 */
export function pickRepo({ roots, file, current = null }: PickRepoArgs): RepoRoot | null {
  const holding = file ? roots.filter((r) => file === r || file.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) : [];
  const innermost = holding.sort((a, b) => b.length - a.length)[0];
  if (innermost) return innermost;
  if (current && roots.includes(current)) return current;
  return roots[0] ?? null;
}
