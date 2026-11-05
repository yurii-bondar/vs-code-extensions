import { HUES } from './core/types';
import type { GroupDraft, Hue, ScriptDraft, ScriptType } from './core/types';

export interface GroupView {
  id: string;
  name: string;
  hue: Hue;
}

export interface ScriptView {
  id: string;
  type: ScriptType;
  name: string;
  path: string;
  command: string;
  description: string;
  groupId: string | null;
  interpreter: string;
  args: string;
  cwd: string;
  lastRunAt: number;
  /** The file, or the folder of a command, is not on disk any more. */
  missing: boolean;
  /** What the extension of the file means: `Python`, `PY`, a hue; `Command` for a command. */
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
  const type = raw['type'] === 'file' || raw['type'] === 'command' ? raw['type'] : null;
  const name = str(raw, 'name');
  const path = str(raw, 'path');
  const command = str(raw, 'command');
  const description = str(raw, 'description');
  const interpreter = str(raw, 'interpreter');
  const args = str(raw, 'args');
  const cwd = str(raw, 'cwd');
  if (id === undefined || groupId === undefined || type === null) return null;
  if (name === null || path === null || command === null || description === null || interpreter === null || args === null || cwd === null) return null;
  return { id, groupId, type, name, path, command, description, interpreter, args, cwd };
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
