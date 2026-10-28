import * as path from 'path';
import { randomUUID } from 'crypto';
import { HUES } from './types';
import type { Group, GroupDraft, GroupId, Hue, Library, Script, ScriptDraft, ScriptId } from './types';

export const emptyLibrary = (): Library => ({ groups: [], scripts: [] });

type MakeId = () => string;
const uuid: MakeId = () => randomUUID().slice(0, 8);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const isHue = (v: unknown): v is Hue => HUES.some((h) => h === v);

/** The library as stored: whatever was saved becomes one valid shape, and what cannot be used is dropped. */
export function parseLibrary(raw: unknown): Library {
  if (!isRecord(raw)) return emptyLibrary();
  const groups: Group[] = [];
  for (const g of Array.isArray(raw['groups']) ? raw['groups'] : []) {
    if (!isRecord(g) || !text(g['id']) || !text(g['name']) || groups.some((x) => x.id === g['id'])) continue;
    groups.push({ id: text(g['id']) as GroupId, name: text(g['name']), hue: isHue(g['hue']) ? g['hue'] : 'violet' });
  }
  const scripts: Script[] = [];
  for (const s of Array.isArray(raw['scripts']) ? raw['scripts'] : []) {
    if (!isRecord(s) || !text(s['id']) || !text(s['path']) || scripts.some((x) => x.id === s['id'])) continue;
    const groupId = text(s['groupId']);
    scripts.push({
      id: text(s['id']) as ScriptId,
      name: text(s['name']) || path.basename(text(s['path'])),
      path: text(s['path']),
      description: text(s['description']),
      groupId: groups.some((g) => g.id === groupId) ? (groupId as GroupId) : null,
      interpreter: text(s['interpreter']),
      args: text(s['args']),
      cwd: text(s['cwd']),
      lastRunAt: typeof s['lastRunAt'] === 'number' && Number.isFinite(s['lastRunAt']) ? s['lastRunAt'] : 0,
    });
  }
  return { groups, scripts };
}

/** Why a draft cannot be saved, or null. */
export function validateScript(draft: ScriptDraft): string | null {
  const file = draft.path.trim();
  if (!file) return 'Choose the script file or type its path.';
  if (!path.isAbsolute(file)) return 'The path must be absolute (or start with ~).';
  if (draft.cwd.trim() && !path.isAbsolute(draft.cwd.trim())) return 'The working directory must be an absolute path (or start with ~).';
  return null;
}

export function validateGroup(draft: GroupDraft): string | null {
  return draft.name.trim() ? null : 'Give the group a name.';
}

/** Adds the script, or replaces the one with the draft's id. */
export function saveScript(lib: Library, draft: ScriptDraft, makeId: MakeId = uuid): Library {
  const existing = lib.scripts.find((s) => s.id === draft.id);
  const file = draft.path.trim();
  const script: Script = {
    id: existing?.id ?? (makeId() as ScriptId),
    name: draft.name.trim() || path.basename(file),
    path: file,
    description: draft.description.trim(),
    groupId: lib.groups.find((g) => g.id === draft.groupId)?.id ?? null,
    interpreter: draft.interpreter.trim(),
    args: draft.args.trim(),
    cwd: draft.cwd.trim(),
    lastRunAt: existing?.lastRunAt ?? 0,
  };
  return { ...lib, scripts: existing ? lib.scripts.map((s) => (s === existing ? script : s)) : [...lib.scripts, script] };
}

export const removeScript = (lib: Library, id: ScriptId): Library => ({ ...lib, scripts: lib.scripts.filter((s) => s.id !== id) });

export function saveGroup(lib: Library, draft: GroupDraft, makeId: MakeId = uuid): Library {
  const existing = lib.groups.find((g) => g.id === draft.id);
  const group: Group = { id: existing?.id ?? (makeId() as GroupId), name: draft.name.trim(), hue: draft.hue };
  return { ...lib, groups: existing ? lib.groups.map((g) => (g === existing ? group : g)) : [...lib.groups, group] };
}

/** The scripts of a removed group stay, without a group. */
export const removeGroup = (lib: Library, id: GroupId): Library => ({
  groups: lib.groups.filter((g) => g.id !== id),
  scripts: lib.scripts.map((s) => (s.groupId === id ? { ...s, groupId: null } : s)),
});

export const markRun = (lib: Library, ids: readonly ScriptId[], at: number): Library => ({
  ...lib,
  scripts: lib.scripts.map((s) => (ids.includes(s.id) ? { ...s, lastRunAt: at } : s)),
});
