import type { Branch, KeptBranch, MergedBranch } from './core/types';

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
  | { type: 'undo'; id: number };

export type HostMessage =
  | { type: 'state'; state: StateView }
  /** Opens the dialog, when a command asked for it. */
  | { type: 'openDeleteMerged' }
  | { type: 'merged'; view: MergedView }
  /** The dialog's work is done: it closes. */
  | { type: 'mergedDone' }
  | { type: 'toast'; text: string; undo: number | null }
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
      return nonEmpty(raw['ref']) ? { type: 'switch', ref: raw['ref'] } : null;
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
