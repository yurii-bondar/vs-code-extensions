// Shapes shared by the host and the webview. No Node imports here: the webview's tsconfig reads this file too.

/** The absolute path of a repository's working tree. */
export type RepoRoot = string & { readonly __brand: 'RepoRoot' };

/**
 * Where a branch stands against its upstream.
 * `unpushed`: a local branch with no upstream. `gone`: its upstream was deleted on the remote.
 * `remote`: a branch on a remote that no local branch tracks.
 */
export type SyncState = 'synced' | 'ahead' | 'behind' | 'diverged' | 'gone' | 'unpushed' | 'remote';

export interface Branch {
  /** What a person calls it: `main`, `feat/login`. A remote-only branch is named without its remote. */
  name: string;
  /** The full ref, unique in the repository: `refs/heads/main`, `refs/remotes/origin/review`. */
  ref: string;
  current: boolean;
  /** The person pinned it, so it sorts right after the current branch. */
  pinned: boolean;
  /** A local branch exists; false for a remote-only one. */
  local: boolean;
  /** The remote branch: what a local branch tracks (`origin/main`), or a remote-only branch itself. Null for none. */
  upstream: string | null;
  sync: SyncState;
  /** Commits on the local branch and not on its upstream; with no upstream, not on any remote. */
  ahead: number;
  /** Commits on the upstream and not on the local branch. */
  behind: number;
  sha: string;
  /** Committer time of the tip, in ms. */
  committedAt: number;
}

/** A local branch whose every change is already in the target, so deleting it loses no work. */
export interface MergedBranch {
  name: string;
  sha: string;
  committedAt: number;
  upstream: string | null;
  /** The upstream exists and is merged too, so deleting it on its remote loses nothing either. */
  upstreamMerged: boolean;
}

/** A merged branch that is left alone, and why. */
export interface KeptBranch {
  name: string;
  reason: string;
}

export interface MergedScan {
  target: string;
  merged: MergedBranch[];
  kept: KeptBranch[];
}

/** A local branch that was deleted, with what it takes to bring it back. */
export interface DeletedBranch {
  name: string;
  sha: string;
  upstream: string | null;
}

/** One commit, as a list in a dialog shows it. */
export interface CommitLine {
  sha: string;
  subject: string;
  author: string;
}

/** A ref beside a commit in the log: a branch (here, on its remote, or both) or a tag. */
export interface RefChip {
  name: string;
  kind: 'branch' | 'tag';
  local: boolean;
  remote: boolean;
  /** The branch checked out. */
  head: boolean;
}

/** One commit as the log shows it. */
export interface CommitView {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  committedAt: number;
  subject: string;
  refs: RefChip[];
}

export interface FileChange {
  /** git's letter: Added, Modified, Deleted, Renamed, Copied, Type change. */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string;
  /** For a rename or copy, the path before. */
  oldPath: string | null;
  add: number;
  del: number;
  binary: boolean;
}

/** One commit's message and changed files, against its first parent. */
export interface CommitDetails {
  sha: string;
  short: string;
  /** The first parent, which the files are compared with; null for the first commit. */
  parent: string | null;
  author: string;
  email: string;
  committedAt: number;
  subject: string;
  body: string;
  files: FileChange[];
}

/** A piece of a diff line; `changed` marks the words that differ from the line's pair. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffSide {
  /** The line number on this side. */
  n: number;
  segs: DiffSegment[];
}

/** One row of the side-by-side diff: a line on each side, or on one side with nothing across. */
export interface DiffRow {
  kind: 'same' | 'change' | 'del' | 'add';
  left: DiffSide | null;
  right: DiffSide | null;
}

export interface DiffHunk {
  /** The `@@ -21,14 +21,16 @@ function …` line. */
  header: string;
  rows: DiffRow[];
}

/** One file of a commit, side by side. */
export interface FileDiff {
  sha: string;
  path: string;
  /** What the left side is: the parent's short hash, or null for the first commit. */
  before: string | null;
  after: string;
  hunks: DiffHunk[];
  binary: boolean;
  /** More lines than the page draws; VS Code's diff editor can still open it. */
  tooLarge: boolean;
}

/** A file the working copy changed, as the commit list shows it (design `04`, `49`). */
export interface WorkingFile {
  path: string;
  /** For a rename, the path before. */
  oldPath: string | null;
  /** `A` added, `M` modified, `D` deleted, `R` renamed, `T` type changed; `U` for an unversioned (untracked) file. */
  status: 'A' | 'M' | 'D' | 'R' | 'T' | 'U';
  /** Git left the file unmerged: a merge or rebase stopped at a conflict in it. */
  conflicted: boolean;
  add: number;
  del: number;
  binary: boolean;
}

/** A merge or rebase the repository is in the middle of. */
export interface OperationView {
  kind: 'merge' | 'rebase';
  /** Your branch: always the left side of a conflict, whatever git calls it. */
  local: string;
  /** The branch merged in, or rebased onto: always the right side. */
  remote: string;
  /** Files still unmerged. */
  conflicted: string[];
  /** Files already staged for the merge commit: merged on their own, or resolved. */
  staged: string[];
}

export interface CompareCommit {
  short: string;
  author: string;
  email: string;
  committedAt: number;
  subject: string;
}

/** A branch that moved on both sides, compared with its remote (design `03`). */
export interface CompareView {
  ref: string;
  name: string;
  upstream: string;
  local: CompareCommit[];
  remote: CompareCommit[];
  /** Where both sides start from. */
  base: CompareCommit | null;
  /** Files a merge would conflict in; null when this git cannot tell (before 2.38). */
  conflicts: string[] | null;
}
