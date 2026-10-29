// The file that Export writes and Import reads: { personify: 1, exportedAt, colors, settings, textMateRules, semanticRules, keybindings? }.
import { settingValue } from './customizations';
import { isRecord, str } from './json';
import type { Customization } from './customizations';
import type { JsonObject } from './json';
import type { SettingValue } from './types';

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
  const records = (v: unknown): JsonObject[] => (Array.isArray(v) ? v.filter(isRecord) : []);
  return {
    colors,
    settings,
    textMateRules: records(raw.textMateRules),
    semanticRules: isRecord(raw.semanticRules) ? raw.semanticRules : {},
    keybindings: records(raw.keybindings).filter((kb) => typeof kb.command === 'string' && typeof kb.key === 'string'),
  };
}
