import { isRecord, str } from './core/json';
import type { Area, Language } from './catalog/types';
import type { JsonObject } from './core/json';
import type { AppearanceState, CustomRule, KeybindingEdit, KeybindingsState, Prefs, Scope, SettingValue, SyntaxChange, SyntaxState, Tab, ThemeMode, TokenStyle } from './core/types';

export interface PrefsView extends Prefs {
  /** The active color theme. */
  readonly theme: string;
  readonly hasWorkspace: boolean;
}

export type ToastKind = 'info' | 'success' | 'error';

export type HostMessage =
  | { type: 'init'; tab: Tab | null; platform: string; catalog: { areas: readonly Area[]; languages: readonly Language[] } }
  | { type: 'focusTab'; tab: Tab }
  | { type: 'state'; prefs: PrefsView; appearance: AppearanceState; syntax: SyntaxState }
  | ({ type: 'keybindings' } & KeybindingsState)
  | { type: 'toast'; text: string; kind: ToastKind };

export type ClientMessage =
  | { type: 'ready' }
  | ({ type: 'prefs' } & Prefs)
  | { type: 'setColors'; changes: Record<string, string | null> }
  | { type: 'setSettings'; changes: Record<string, SettingValue | null> }
  | { type: 'setSyntax'; changes: SyntaxChange[] }
  | { type: 'setCustom'; list: CustomRule[] }
  | { type: 'kb'; edit: KeybindingEdit }
  | { type: 'kbRefresh' }
  | { type: 'openKeybindingsJson' }
  | { type: 'openSettingsJson' }
  | { type: 'openSample'; langId: string }
  | { type: 'inspectScope'; langId: string }
  | { type: 'export'; includeKeybindings: boolean }
  | { type: 'import' }
  | { type: 'resetAll' }
  | { type: 'revertSession' };

const SCOPES: readonly Scope[] = ['user', 'workspace'];
const THEME_MODES: readonly ThemeMode[] = ['all', 'current'];

/** Saved or posted prefs; anything unknown falls back to user settings and all themes. */
export function parsePrefs(raw: unknown): Prefs {
  const r = isRecord(raw) ? raw : {};
  return { scope: SCOPES.find((s) => s === r.scope) ?? 'user', themeMode: THEME_MODES.find((m) => m === r.themeMode) ?? 'all' };
}

const settingValue = (v: unknown): SettingValue | null => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null);
const index = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const style = (v: unknown): TokenStyle => (isRecord(v) ? { fg: str(v.fg) || null, fontStyle: str(v.fontStyle) } : { fg: null, fontStyle: null });

function record<T extends SettingValue | null>(raw: unknown, value: (v: unknown) => T): Record<string, T> {
  const out: Record<string, T> = {};
  if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) out[k] = value(v);
  return out;
}

const records = (raw: unknown): JsonObject[] => (Array.isArray(raw) ? raw.filter(isRecord) : []);

function syntaxChange(r: JsonObject): SyntaxChange[] {
  const langId = str(r.langId);
  const itemId = str(r.itemId);
  if (langId === null || itemId === null) return [];
  return [{ langId, itemId, style: r.style === null ? null : style(r.style) }];
}

function customRule(r: JsonObject): CustomRule[] {
  const id = str(r.id);
  return id === null ? [] : [{ id, scope: str(r.scope) ?? '', ...style(r) }];
}

function keybindingEdit(raw: unknown): KeybindingEdit | null {
  if (!isRecord(raw)) return null;
  const command = str(raw.command);
  const key = str(raw.key) ?? '';
  const when = str(raw.when) ?? '';
  const at = index(raw.index);
  if (command === null) return null;
  switch (raw.op) {
    case 'add':
      return { op: 'add', command, key, when, args: raw.args };
    case 'update':
      return at === null ? null : { op: 'update', index: at, command, key, when };
    case 'remove':
      return at === null ? null : { op: 'remove', index: at, command };
    case 'disableDefault':
      return { op: 'disableDefault', command, key, when };
    case 'replaceDefault':
      return { op: 'replaceDefault', command, oldKey: str(raw.oldKey) ?? '', oldWhen: str(raw.oldWhen) ?? '', key, when, args: raw.args };
    case 'restoreDefault':
      return at === null ? null : { op: 'restoreDefault', index: at, command };
    case 'resetCommand':
      return { op: 'resetCommand', command };
    default:
      return null;
  }
}

/** What the webview posted, narrowed once at the edge; null for anything that is not a known message. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'ready':
    case 'kbRefresh':
    case 'openKeybindingsJson':
    case 'openSettingsJson':
    case 'import':
    case 'resetAll':
    case 'revertSession':
      return { type: raw.type };
    case 'prefs':
      return { type: 'prefs', ...parsePrefs(raw) };
    case 'setColors':
      return { type: 'setColors', changes: record(raw.changes, (v) => str(v) || null) };
    case 'setSettings':
      return { type: 'setSettings', changes: record(raw.changes, settingValue) };
    case 'setSyntax':
      return { type: 'setSyntax', changes: records(raw.changes).flatMap(syntaxChange) };
    case 'setCustom':
      return { type: 'setCustom', list: records(raw.list).flatMap(customRule) };
    case 'kb': {
      const edit = keybindingEdit(raw.edit);
      return edit && { type: 'kb', edit };
    }
    case 'openSample':
    case 'inspectScope': {
      const langId = str(raw.langId);
      return langId === null ? null : { type: raw.type, langId };
    }
    case 'export':
      return { type: 'export', includeKeybindings: raw.includeKeybindings === true };
    default:
      return null;
  }
}
