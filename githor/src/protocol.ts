import type { Grouping } from './core/commit-groups';
import type { ConflictPart, Resolution } from './core/conflict';
import type { Branch, CommitDetails, CommitLine, CommitView, CompareView, FileChange, FileDiff, KeptBranch, MergedBranch, OperationView, WorkingFile } from './core/types';

/** A push, pull, publish or sync that is running, on `ref`; null `ref` for the current branch's sync. */
export interface BusyView {
  action: 'push' | 'pull' | 'publish' | 'sync';
  ref: string | null;
}

export interface RepoView {
  name: string;
  root: string;
}

/** Everything a page shows about the repository. */
export interface StateView {
  repo: RepoView | null;
  branches: Branch[];
  /** False until the first read of the repository is done. */
  loaded: boolean;
  /** When the repository last fetched, in ms; null when it never has. */
  fetchedAt: number | null;
  fetching: boolean;
  /** git's message when the last fetch failed. */
  fetchError: string | null;
  defaultBranch: string | null;
  busy: BusyView | null;
  /** The commit checked out; null before the first commit. */
  head: string | null;
  /** What the working copy changed since the last commit. */
  working: WorkingFile[];
  grouping: Grouping;
  /** The merge or rebase in progress, if any. */
  operation: OperationView | null;
}

/** The "Delete all merged branches" dialog for one target. */
export interface MergedView {
  target: string;
  /** What the target picker offers. */
  targets: string[];
  merged: MergedBranch[];
  kept: KeptBranch[];
}

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'fetch'; all: boolean }
  | { type: 'switch'; ref: string }
  | { type: 'pickBranch' }
  | { type: 'openEditor' }
  | { type: 'showOutput' }
  /** Lists the merged branches; a null target means the default branch. */
  | { type: 'scanMerged'; target: string | null }
  | { type: 'deleteMerged'; target: string; names: string[]; onRemote: boolean }
  | { type: 'undo'; id: number }
  | { type: 'push'; ref: string; force: boolean; tags: boolean }
  | { type: 'pull'; ref: string }
  | { type: 'publish'; ref: string }
  /** Pull, then push: `ref`, or the current branch when null. */
  | { type: 'sync'; ref: string | null }
  /** Asks what a force-push of `ref` would remove from its remote, for the confirmation. */
  | { type: 'forceInfo'; ref: string }
  | { type: 'checkName'; name: string }
  | { type: 'newBranch'; name: string; start: string; switchTo: boolean }
  | { type: 'rename'; ref: string; to: string; onRemote: boolean }
  /** Asks what deleting `ref` would lose, for the delete dialog. */
  | { type: 'deleteInfo'; ref: string }
  | { type: 'deleteBranch'; ref: string; onRemote: boolean }
  | { type: 'pin'; ref: string; pinned: boolean }
  | { type: 'copyName'; name: string }
  /** Asks for the newest `limit` commits of the log. */
  | { type: 'log'; limit: number }
  | { type: 'commitDetails'; shas: string[] }
  | { type: 'switchCommit'; sha: string }
  | { type: 'cherryPick'; shas: string[] }
  | { type: 'revert'; sha: string }
  /** Opens a changed file in VS Code's diff editor: as it was in `parent` and as it is in `sha`. */
  | { type: 'openDiff'; sha: string; parent: string | null; file: FileChange }
  /** Asks for a changed file side by side, for the page's own diff (`02`). */
  | { type: 'fileDiff'; sha: string; parent: string | null; file: FileChange }
  | { type: 'setGrouping'; grouping: Grouping }
  /** Asks for one working-copy file side by side, against the last commit. */
  | { type: 'workingDiff'; path: string }
  | { type: 'commit'; paths: string[]; message: string; push: boolean }
  /** Asks for what a push of `ref` would send, for the push screen (`10`). */
  | { type: 'pushReview'; ref: string }
  | { type: 'compare'; ref: string }
  | { type: 'bringTogether'; ref: string; how: 'merge' | 'rebase' }
  | { type: 'conflictFile'; path: string }
  | { type: 'resolveConflict'; path: string; resolutions: Resolution[] }
  | { type: 'reopenConflict'; path: string }
  | { type: 'continueOperation' }
  | { type: 'abortOperation' };

export type HostMessage =
  | { type: 'state'; state: StateView }
  /** Opens the dialog, when a command asked for it. */
  | { type: 'openDeleteMerged' }
  /** Opens the compare screen (`03`) for a branch, when the sidebar asked for it. */
  | { type: 'openCompare'; ref: string }
  | { type: 'merged'; view: MergedView }
  /** The dialog's work is done: it closes. */
  | { type: 'mergedDone' }
  | { type: 'toast'; text: string; undo: number | null }
  | { type: 'forceInfo'; ref: string; count: number; authors: string[] }
  | { type: 'nameCheck'; name: string; problem: string | null }
  /** What deleting `ref` loses: merged into the default branch, or the commits only it has, here and on its remote. */
  | { type: 'deleteInfo'; ref: string; mergedInto: string | null; local: CommitLine[]; remote: CommitLine[] }
  /** A branch dialog's work is done: it closes. */
  | { type: 'branchDone' }
  | { type: 'log'; commits: CommitView[]; hasMore: boolean; me: string | null }
  | { type: 'commitDetails'; details: CommitDetails[] }
  | { type: 'fileDiff'; diff: FileDiff }
  /** A commit is made; with `push`, the push screen opens for `ref`. */
  | { type: 'committed'; push: boolean; ref: string | null }
  | { type: 'pushReview'; ref: string; commits: CommitDetails[]; to: string; creates: boolean }
  | { type: 'compare'; view: CompareView }
  | { type: 'conflictFile'; path: string; parts: ConflictPart[] }
  | { type: 'error'; text: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const STATUSES: readonly string[] = ['A', 'M', 'D', 'R', 'C', 'T'];
function isFileChange(v: unknown): v is FileChange {
  if (!isRecord(v)) return false;
  const { status, path, oldPath, add, del, binary } = v;
  return typeof status === 'string' && STATUSES.includes(status) && nonEmpty(path) && (oldPath === null || nonEmpty(oldPath)) && typeof add === 'number' && typeof del === 'number' && typeof binary === 'boolean';
}

function isResolution(v: unknown): v is Resolution {
  if (!isRecord(v)) return false;
  return v['take'] === 'local' || v['take'] === 'remote' || v['take'] === 'both' || (v['take'] === 'edit' && typeof v['text'] === 'string');
}

/** What the webview posted, narrowed once at the edge; null for anything that is not a known message. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw['type']) {
    case 'ready':
    case 'continueOperation':
    case 'abortOperation':
    case 'pickBranch':
    case 'openEditor':
    case 'showOutput':
      return { type: raw['type'] };
    case 'fetch':
      return typeof raw['all'] === 'boolean' ? { type: 'fetch', all: raw['all'] } : null;
    case 'switch':
    case 'pull':
    case 'publish':
    case 'forceInfo':
    case 'deleteInfo':
      return nonEmpty(raw['ref']) ? { type: raw['type'], ref: raw['ref'] } : null;
    case 'sync':
      return raw['ref'] === null || nonEmpty(raw['ref']) ? { type: 'sync', ref: raw['ref'] } : null;
    case 'checkName':
      return typeof raw['name'] === 'string' ? { type: 'checkName', name: raw['name'] } : null;
    case 'copyName':
      return nonEmpty(raw['name']) ? { type: 'copyName', name: raw['name'] } : null;
    case 'newBranch': {
      const { name, start, switchTo } = raw;
      return nonEmpty(name) && nonEmpty(start) && typeof switchTo === 'boolean' ? { type: 'newBranch', name, start, switchTo } : null;
    }
    case 'rename': {
      const { ref, to, onRemote } = raw;
      return nonEmpty(ref) && nonEmpty(to) && typeof onRemote === 'boolean' ? { type: 'rename', ref, to, onRemote } : null;
    }
    case 'deleteBranch':
      return nonEmpty(raw['ref']) && typeof raw['onRemote'] === 'boolean' ? { type: 'deleteBranch', ref: raw['ref'], onRemote: raw['onRemote'] } : null;
    case 'log':
      return Number.isInteger(raw['limit']) && (raw['limit'] as number) > 0 ? { type: 'log', limit: raw['limit'] as number } : null;
    case 'commitDetails':
    case 'cherryPick':
      return Array.isArray(raw['shas']) && raw['shas'].length > 0 && raw['shas'].every(nonEmpty) ? { type: raw['type'], shas: raw['shas'] } : null;
    case 'switchCommit':
    case 'revert':
      return nonEmpty(raw['sha']) ? { type: raw['type'], sha: raw['sha'] } : null;
    case 'openDiff':
    case 'fileDiff': {
      const { sha, parent, file } = raw;
      return nonEmpty(sha) && (parent === null || nonEmpty(parent)) && isFileChange(file) ? { type: raw['type'], sha, parent, file } : null;
    }
    case 'setGrouping':
      return raw['grouping'] === 'none' || raw['grouping'] === 'directory' ? { type: 'setGrouping', grouping: raw['grouping'] } : null;
    case 'workingDiff':
    case 'conflictFile':
    case 'reopenConflict':
      return nonEmpty(raw['path']) ? { type: raw['type'], path: raw['path'] } : null;
    case 'compare':
      return nonEmpty(raw['ref']) ? { type: 'compare', ref: raw['ref'] } : null;
    case 'bringTogether':
      return nonEmpty(raw['ref']) && (raw['how'] === 'merge' || raw['how'] === 'rebase') ? { type: 'bringTogether', ref: raw['ref'], how: raw['how'] } : null;
    case 'resolveConflict': {
      const { path, resolutions } = raw;
      return nonEmpty(path) && Array.isArray(resolutions) && resolutions.length > 0 && resolutions.every(isResolution) ? { type: 'resolveConflict', path, resolutions } : null;
    }
    case 'pushReview':
      return nonEmpty(raw['ref']) ? { type: 'pushReview', ref: raw['ref'] } : null;
    case 'commit': {
      const { paths, message, push } = raw;
      return Array.isArray(paths) && paths.length > 0 && paths.every(nonEmpty) && nonEmpty(message) && typeof push === 'boolean' ? { type: 'commit', paths, message, push } : null;
    }
    case 'pin':
      return nonEmpty(raw['ref']) && typeof raw['pinned'] === 'boolean' ? { type: 'pin', ref: raw['ref'], pinned: raw['pinned'] } : null;
    case 'push': {
      const { ref, force, tags } = raw;
      return nonEmpty(ref) && typeof force === 'boolean' && typeof tags === 'boolean' ? { type: 'push', ref, force, tags } : null;
    }
    case 'scanMerged':
      return raw['target'] === null || nonEmpty(raw['target']) ? { type: 'scanMerged', target: raw['target'] } : null;
    case 'deleteMerged': {
      const { target, names, onRemote } = raw;
      if (!nonEmpty(target) || typeof onRemote !== 'boolean' || !Array.isArray(names) || !names.every(nonEmpty)) return null;
      return { type: 'deleteMerged', target, names, onRemote };
    }
    case 'undo':
      return Number.isInteger(raw['id']) ? { type: 'undo', id: raw['id'] as number } : null;
    default:
      return null;
  }
}
