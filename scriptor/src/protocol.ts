import { HUES } from './core/types';
import type { GroupDraft, Hue, ScriptDraft } from './core/types';

export interface GroupView {
  id: string;
  name: string;
  hue: Hue;
}

export interface ScriptView {
  id: string;
  name: string;
  path: string;
  dir: string;
  description: string;
  groupId: string | null;
  interpreter: string;
  args: string;
  cwd: string;
  lastRunAt: number;
  /** The file is not on disk any more. */
  missing: boolean;
  /** What the extension of the file means: `Python`, `PY`, a hue. */
  kind: { label: string; short: string; hue: Hue };
  /** What runs it when no interpreter is set, e.g. `python3`; empty when the file is run itself. */
  detected: string;
}

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'run'; id: string }
  | { type: 'runGroup'; id: string }
  | { type: 'pick'; target: 'file' | 'folder' }
  | { type: 'saveScript'; draft: ScriptDraft }
  | { type: 'saveGroup'; draft: GroupDraft }
  | { type: 'removeScript'; id: string }
  | { type: 'removeGroup'; id: string }
  | { type: 'openFile'; id: string }
  | { type: 'reveal'; id: string };

export type HostMessage =
  | { type: 'state'; groups: GroupView[]; scripts: ScriptView[] }
  | { type: 'picked'; target: 'file' | 'folder'; path: string }
  | { type: 'addScript'; groupId: string | null }
  | { type: 'addGroup' }
  | { type: 'editScript'; id: string }
  | { type: 'editGroup'; id: string }
  | { type: 'saved' }
  | { type: 'toast'; kind: 'ok' | 'error'; text: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, key: string): string | null => (typeof o[key] === 'string' ? o[key] : null);
const optStr = (o: Record<string, unknown>, key: string): string | null | undefined => (o[key] === null ? null : str(o, key) ?? undefined);

function scriptDraft(raw: unknown): ScriptDraft | null {
  if (!isRecord(raw)) return null;
  const id = optStr(raw, 'id');
  const groupId = optStr(raw, 'groupId');
  const [name, path, description, interpreter, args, cwd] = ['name', 'path', 'description', 'interpreter', 'args', 'cwd'].map((k) => str(raw, k));
  if (id === undefined || groupId === undefined || name === null || path === null || description === null || interpreter === null || args === null || cwd === null) return null;
  return { id, groupId, name: name ?? '', path: path ?? '', description: description ?? '', interpreter: interpreter ?? '', args: args ?? '', cwd: cwd ?? '' };
}

function groupDraft(raw: unknown): GroupDraft | null {
  if (!isRecord(raw)) return null;
  const id = optStr(raw, 'id');
  const name = str(raw, 'name');
  const hue = HUES.find((h) => h === raw['hue']);
  return id === undefined || name === null || !hue ? null : { id, name, hue };
}

/** What the webview posted, narrowed once at the edge; null for anything that is not a known message. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null;
  const id = str(raw, 'id');
  switch (raw['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'run':
    case 'runGroup':
    case 'removeScript':
    case 'removeGroup':
    case 'openFile':
    case 'reveal':
      return id === null ? null : { type: raw['type'], id };
    case 'pick':
      return raw['target'] === 'file' || raw['target'] === 'folder' ? { type: 'pick', target: raw['target'] } : null;
    case 'saveScript': {
      const draft = scriptDraft(raw['draft']);
      return draft && { type: 'saveScript', draft };
    }
    case 'saveGroup': {
      const draft = groupDraft(raw['draft']);
      return draft && { type: 'saveGroup', draft };
    }
    default:
      return null;
  }
}
