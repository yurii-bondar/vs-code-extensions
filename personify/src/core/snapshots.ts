// Snapshots taken before Import, Reset, Revert session and Restore, so each of them can be undone from the Profiles page.
import { isRecord, str } from './json';
import type { Snapshot } from './customizations';
import type { Scope } from './types';

export type SnapshotId = string & { readonly __brand: 'SnapshotId' };

export interface SavedKeybindings {
  readonly file: string;
  readonly text: string;
}

export interface SnapshotRecord {
  readonly id: SnapshotId;
  /** Epoch milliseconds. */
  readonly at: number;
  /** What was about to happen, e.g. "Before importing work.json". */
  readonly reason: string;
  readonly settings: Snapshot;
  /** keybindings.json as it was; null when it could not be read. */
  readonly keybindings: SavedKeybindings | null;
}

/** What the Profiles page lists. */
export interface SnapshotInfo {
  readonly id: SnapshotId;
  readonly at: number;
  readonly reason: string;
}

export const MAX_SNAPSHOTS = 10;

/** The list with `record` added: newest first, at most `max`. */
export function withSnapshot(list: readonly SnapshotRecord[], record: SnapshotRecord, max = MAX_SNAPSHOTS): SnapshotRecord[] {
  return [record, ...list.filter((s) => s.id !== record.id)].slice(0, max);
}

export const snapshotInfo = (list: readonly SnapshotRecord[]): SnapshotInfo[] => list.map(({ id, at, reason }) => ({ id, at, reason }));

function savedKeybindings(raw: unknown): SavedKeybindings | null {
  if (!isRecord(raw)) return null;
  const file = str(raw.file);
  const text = str(raw.text);
  return file !== null && text !== null ? { file, text } : null;
}

/** Snapshots read back from extension storage, which an older version may have written; anything malformed is dropped. */
export function parseSnapshots(raw: unknown): SnapshotRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): SnapshotRecord[] => {
    if (!isRecord(r)) return [];
    const id = str(r.id);
    const reason = str(r.reason);
    const settings = r.settings;
    if (!id || reason === null || typeof r.at !== 'number' || !Number.isFinite(r.at) || !isRecord(settings)) return [];
    const level = (scope: Scope): Record<string, unknown> => {
      const values = settings[scope];
      return isRecord(values) ? { ...values } : {};
    };
    return [{ id: id as SnapshotId, at: r.at, reason, settings: { user: level('user'), workspace: level('workspace') }, keybindings: savedKeybindings(r.keybindings) }];
  });
}
