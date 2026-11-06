// The file that Export writes and Import reads: { personify: 1, exportedAt, colors, settings, textMateRules, semanticRules, keybindings? }.
import * as catalog from '../catalog';
import { CUSTOM_PREFIX, RULE_PREFIX } from './customizations';
import { isRecord, records, settingValue, str } from './json';
import type { Customization } from './customizations';
import type { JsonObject } from './json';
import type { SettingValue } from './types';

export type DiffKind = 'added' | 'changed' | 'removed';

/** One thing an import would change, in words the panel can show. */
export interface DiffEntry {
  readonly kind: DiffKind;
  /** e.g. "Editor › Background" or "JS/TS › Function calls". */
  readonly label: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface ProfileDiff {
  readonly entries: readonly DiffEntry[];
  /** Items the file has that are already set the same way. */
  readonly same: number;
}

const areaLabels = new Map(
  catalog.AREAS.flatMap((a) => a.groups.flatMap((g) => g.items.flatMap((i) => (i.kind === 'note' ? [] : [[i.key, `${a.title} › ${i.label}`] as const]))))
);

function ruleLabel(name: string, rule: JsonObject): string {
  if (name.startsWith(CUSTOM_PREFIX)) {
    const scope = Array.isArray(rule.scope) ? rule.scope.filter((s): s is string => typeof s === 'string').join(', ') : str(rule.scope);
    return `Custom scope ${scope ?? ''}`.trim();
  }
  const [langId = '', itemId = ''] = name.slice(RULE_PREFIX.length).split('/');
  const found = catalog.findItem(langId, itemId);
  return found ? `${found.lang.short} › ${found.item.label}` : name;
}

function ruleStyle(rule: JsonObject): string {
  const s = isRecord(rule.settings) ? rule.settings : {};
  return [str(s.foreground), str(s.fontStyle)].filter(Boolean).join(' ') || 'theme';
}

const shown = (v: SettingValue): string => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

/**
 * What importing `incoming` over `current` would change, with the same rules as Customizations.importState:
 * Merge adds and overwrites, Replace also removes what the file does not have. Semantic rules travel with
 * their TextMate rule, so they are not listed twice.
 */
export function diffProfile(current: Customization, incoming: Customization, { replace }: { replace: boolean }): ProfileDiff {
  const entries: DiffEntry[] = [];
  let same = 0;
  interface Compare<T> {
    cur: ReadonlyMap<string, T>;
    next: ReadonlyMap<string, T>;
    label: (key: string, value: T) => string;
    text: (value: T) => string;
  }
  const compare = <T extends SettingValue | JsonObject>({ cur, next, label, text }: Compare<T>): void => {
    for (const [key, value] of next) {
      const old = cur.get(key);
      if (old === undefined) entries.push({ kind: 'added', label: label(key, value), from: null, to: text(value) });
      else if (JSON.stringify(old) !== JSON.stringify(value)) entries.push({ kind: 'changed', label: label(key, value), from: text(old), to: text(value) });
      else same++;
    }
    if (replace) for (const [key, value] of cur) if (!next.has(key)) entries.push({ kind: 'removed', label: label(key, value), from: text(value), to: null });
  };
  const known = <T>(record: Readonly<Record<string, T>>, keys: readonly string[]): Map<string, T> => new Map(Object.entries(record).filter(([k]) => keys.includes(k)));
  const label = (key: string): string => areaLabels.get(key) ?? key;
  compare({ cur: known(current.colors, catalog.COLOR_KEYS), next: known(incoming.colors, catalog.COLOR_KEYS), label, text: (v) => String(v) });
  compare({ cur: known(current.settings, catalog.SETTING_KEYS), next: known(incoming.settings, catalog.SETTING_KEYS), label, text: shown });
  const rules = (list: readonly JsonObject[]): Map<string, JsonObject> =>
    new Map(list.flatMap((r) => {
      const name = str(r.name);
      return name?.startsWith(RULE_PREFIX) ? [[name, r] as const] : [];
    }));
  compare({ cur: rules(current.textMateRules), next: rules(incoming.textMateRules), label: ruleLabel, text: ruleStyle });
  return { entries, same };
}

export interface Profile extends Customization {
  /** keybindings.json entries as exported. */
  readonly keybindings: readonly JsonObject[];
}

export function profileFile(state: Customization, keybindings: readonly unknown[] | null, now: Date): JsonObject {
  const data: JsonObject = { personify: 1, exportedAt: now.toISOString(), ...state };
  if (keybindings) data.keybindings = keybindings;
  return data;
}

/** A profile from a file the user picked; null when it is not one. Values of the wrong type are dropped. */
export function parseProfile(raw: unknown): Profile | null {
  if (!isRecord(raw) || raw.personify !== 1) return null;
  const colors: Record<string, string> = {};
  if (isRecord(raw.colors)) {
    for (const [k, v] of Object.entries(raw.colors)) {
      const color = str(v);
      if (color) colors[k] = color;
    }
  }
  const settings: Record<string, SettingValue> = {};
  if (isRecord(raw.settings)) {
    for (const [k, v] of Object.entries(raw.settings)) {
      const value = settingValue(v);
      if (value !== null) settings[k] = value;
    }
  }
  return {
    colors,
    settings,
    textMateRules: records(raw.textMateRules),
    semanticRules: isRecord(raw.semanticRules) ? raw.semanticRules : {},
    keybindings: records(raw.keybindings).filter((kb) => typeof kb.command === 'string' && typeof kb.key === 'string'),
  };
}
