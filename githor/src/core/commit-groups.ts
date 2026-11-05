// The commit list's sections and grouping (design `49`–`52`). Pure: the webview imports it to build the tree it draws.
import type { WorkingFile } from './types';

export type Grouping = 'none' | 'directory';

/** A ticked-state of a group: all its files, some, or none. */
export type Tick = 'all' | 'some' | 'none';

export interface FileNode {
  kind: 'file';
  file: WorkingFile;
  depth: number;
}

export interface GroupNode {
  kind: 'section' | 'directory';
  /** `Changes`, `Unversioned Files`, or a directory path. */
  label: string;
  /** The paths under it, for ticking them together. */
  paths: string[];
  tick: Tick;
  depth: number;
}

export type CommitNode = FileNode | GroupNode;

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));

const tickOf = (paths: readonly string[], ticked: ReadonlySet<string>): Tick => {
  const n = paths.filter((p) => ticked.has(p)).length;
  return n === 0 ? 'none' : n === paths.length ? 'all' : 'some';
};

/**
 * The rows of the commit list: `Changes` (tracked files) then `Unversioned Files`, each with its files; grouped by
 * directory, a row per directory path (`src/core` is one row, not two) with its files under it. An empty section is
 * left out. Unmerged files belong to the conflict screens and are left out here.
 */
export function commitTree(files: readonly WorkingFile[], { grouping, ticked }: { grouping: Grouping; ticked: ReadonlySet<string> }): CommitNode[] {
  const sections: [string, WorkingFile[]][] = [
    ['Changes', files.filter((f) => f.status !== 'U' && !f.conflicted)],
    ['Unversioned Files', files.filter((f) => f.status === 'U')],
  ];
  const nodes: CommitNode[] = [];
  for (const [label, list] of sections) {
    if (!list.length) continue;
    const paths = list.map((f) => f.path);
    nodes.push({ kind: 'section', label, paths, tick: tickOf(paths, ticked), depth: 0 });
    if (grouping === 'none') {
      nodes.push(...list.map((file): FileNode => ({ kind: 'file', file, depth: 1 })));
      continue;
    }
    const byDir = new Map<string, WorkingFile[]>();
    for (const f of list) byDir.set(dirOf(f.path), [...(byDir.get(dirOf(f.path)) ?? []), f]);
    for (const [dir, inDir] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
      const dirPaths = inDir.map((f) => f.path);
      // files at the top of the repository sit right under the section
      if (dir) nodes.push({ kind: 'directory', label: dir, paths: dirPaths, tick: tickOf(dirPaths, ticked), depth: 1 });
      nodes.push(...inDir.map((file): FileNode => ({ kind: 'file', file, depth: dir ? 2 : 1 })));
    }
  }
  return nodes;
}

/**
 * Which files are ticked after the list changed: kept as they were, new tracked files ticked, new unversioned ones not
 * (a stray file never slips into a commit), gone ones dropped.
 */
export function nextTicked({ files, ticked, known }: { files: readonly WorkingFile[]; ticked: ReadonlySet<string>; known: ReadonlySet<string> }): Set<string> {
  const next = new Set<string>();
  for (const f of files) {
    if (f.conflicted) continue;
    if (known.has(f.path) ? ticked.has(f.path) : f.status !== 'U') next.add(f.path);
  }
  return next;
}
