import type { Branch, CommitLine, KeptBranch, MergedBranch } from './core/types';

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
  | { type: 'copyName'; name: string };

export type HostMessage =
  | { type: 'state'; state: StateView }
  /** Opens the dialog, when a command asked for it. */
  | { type: 'openDeleteMerged' }
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
  | { type: 'error'; text: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** What the webview posted, narrowed once at the edge; null for anything that is not a known message. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw['type']) {
    case 'ready':
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
