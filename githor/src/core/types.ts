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
