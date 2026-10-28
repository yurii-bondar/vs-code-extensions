// The cross-window state, kept in two small JSON files in the global storage dir that every window shares.
import { isRecord } from './types';
import type { ProjectUri, WindowId } from './types';

export const STALE_MS = 15000;

/** windows.json: the project each open window shows, and when it last said so. */
export interface WindowEntry {
  readonly uri: ProjectUri;
  readonly ts: number;
}
export type Registry = Map<WindowId, WindowEntry>;

/** focus.json: the project of the focused window and of the one focused before it. */
export interface Focus {
  readonly current: ProjectUri | null;
  readonly previous: ProjectUri | null;
}

export function parseRegistry(value: unknown): Registry {
  const registry: Registry = new Map();
  if (!isRecord(value)) return registry;
  for (const [id, entry] of Object.entries(value)) {
    if (isRecord(entry) && typeof entry.uri === 'string' && typeof entry.ts === 'number') {
      registry.set(id as WindowId, { uri: entry.uri as ProjectUri, ts: entry.ts });
    }
  }
  return registry;
}

export const serializeRegistry = (registry: Registry): Record<string, WindowEntry> => Object.fromEntries(registry);

export function parseFocus(value: unknown): Focus {
  const field = (key: string): ProjectUri | null => {
    const v = isRecord(value) ? value[key] : undefined;
    return typeof v === 'string' && v ? (v as ProjectUri) : null;
  };
  return { current: field('current'), previous: field('previous') };
}

interface BeatArgs {
  windowId: WindowId;
  /** This window's project; null when it has none. */
  uri: ProjectUri | null;
  now: number;
}

/** The registry after a window's heartbeat: stale windows dropped, this one stamped, or removed when it has no project. */
export function beat(registry: Registry, { windowId, uri, now }: BeatArgs): Registry {
  const next: Registry = new Map();
  for (const [id, entry] of registry) {
    if (now - entry.ts <= STALE_MS) next.set(id, entry);
  }
  if (uri) next.set(windowId, { uri, ts: now });
  else next.delete(windowId);
  return next;
}

interface OpenArgs {
  windowId: WindowId;
  own: ProjectUri | null;
  now: number;
}

/** Projects open in a live window, this window's own included even when its entry went stale. */
export function openProjects(registry: Registry, { windowId, own, now }: OpenArgs): ProjectUri[] {
  const open = new Set<ProjectUri>();
  for (const [id, entry] of registry) {
    if (id === windowId || now - entry.ts <= STALE_MS) open.add(entry.uri);
  }
  if (own) open.add(own);
  return [...open];
}

/** focus.json once a window with `uri` got focus; null when it is already the current one. */
export const focused = (focus: Focus, uri: ProjectUri): Focus | null => (focus.current === uri ? null : { current: uri, previous: focus.current });

/** The project to jump back to: the one focused before, unless it is this window's own. */
export const lastProject = (focus: Focus, own: ProjectUri | null): ProjectUri | null => (focus.previous && focus.previous !== own ? focus.previous : null);

/** Open windows with the one focused before this one first, so Enter jumps straight back. */
export function previousFirst(uris: readonly ProjectUri[], previous: ProjectUri | null): ProjectUri[] {
  return [...uris].sort((a, b) => Number(b === previous) - Number(a === previous));
}
