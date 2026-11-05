// keybindings.json without VS Code: reading entries, building the rows the Hotkeys tab shows, and editing the text
// so the user's comments and formatting survive.
import * as jsonc from 'jsonc-parser';
import { isRecord, str } from './json';
import type { JsonObject } from './json';
import type { KeybindingEdit, KeybindingRow } from './types';

const FORMAT: jsonc.ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
const PARSE: jsonc.ParseOptions = { allowTrailingComma: true, disallowComments: false };

/** A shortcut from VS Code's or an extension's defaults. */
export interface Binding {
  readonly key: string;
  readonly command: string;
  /** Empty: always. */
  readonly when: string;
  readonly args: unknown;
}

// "cmd+shift+p" and "shift+cmd+p" are the same binding.
export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.split('+');
      const last = parts.pop() ?? '';
      return [...parts.sort(), last].join('+');
    })
    .join(' ');
}

/** A readable title for a command that has none: `workbench.action.files.saveAll` → `Files: Save All`. */
export function humanize(id: string): string {
  const rest = id.replace(/^(workbench\.action|editor\.action|workbench\.view|workbench)\./, '');
  const parts = rest.split('.');
  const words = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const name = cap(words(parts.pop() ?? ''));
  return parts.length ? `${parts.map((p) => cap(words(p))).join(' ')}: ${name}` : name;
}

/** The entries of keybindings.json as written; null when the file has syntax errors. */
export function parseKeybindings(text: string): unknown[] | null {
  const errors: jsonc.ParseError[] = [];
  const list: unknown = jsonc.parse(text, errors, PARSE);
  return errors.length || !Array.isArray(list) ? null : list;
}

/** An entry with a key and a command; null for anything else. */
export function toBinding(raw: unknown): Binding | null {
  if (!isRecord(raw)) return null;
  const key = str(raw.key);
  const command = str(raw.command);
  return key && command ? { key, command, when: str(raw.when) ?? '', args: raw.args } : null;
}

/** VS Code's default keybindings document: its shortcuts, and the commands it lists without one. */
export function parseDefaultKeybindings(text: string): { list: Binding[]; unbound: string[] } {
  const parsed: unknown = jsonc.parse(text, [], PARSE);
  const list = (Array.isArray(parsed) ? parsed : []).flatMap((raw) => toBinding(raw) ?? []);
  // The file ends with commented-out "// - command.id" lines for commands that have no key.
  const unbound = [...text.matchAll(/^\s*\/\/\s*-\s*([^\s]+)\s*$/gm)].flatMap((m) => m[1] ?? []);
  return { list, unbound };
}

interface RowsArgs {
  defaults: readonly Binding[];
  /** The entries of keybindings.json. */
  user: readonly unknown[];
  title: (command: string) => string;
}

interface Removal {
  readonly index: number;
  readonly command: string;
  /** Normalized; null switches off every key of the command. */
  readonly key: string | null;
  /** null matches every context. */
  readonly when: string | null;
}

/**
 * Every default shortcut followed by the user's own, each marked when a `-command` entry switches it off.
 * As in VS Code, such an entry switches off the defaults and the user entries above it.
 */
export function buildRows({ defaults, user, title }: RowsArgs): KeybindingRow[] {
  const removals: Removal[] = user.flatMap((entry, index) => {
    if (!isRecord(entry) || typeof entry.command !== 'string' || !entry.command.startsWith('-')) return [];
    const key = str(entry.key);
    return [{ index, command: entry.command.slice(1), key: key ? normalizeKey(key) : null, when: str(entry.when) }];
  });
  const removalOf = (command: string, key: string, when: string, after: number): number | null => {
    if (!removals.length) return null;
    const nk = normalizeKey(key);
    return removals.find((r) => r.index > after && r.command === command && (r.key === null || r.key === nk) && (r.when === null || r.when === when))?.index ?? null;
  };

  const rows: KeybindingRow[] = defaults.map((d, i) => ({
    id: `d${i}`,
    source: 'default',
    command: d.command,
    title: title(d.command),
    key: d.key,
    when: d.when,
    args: d.args,
    removalIndex: removalOf(d.command, d.key, d.when, -1),
  }));
  user.forEach((u, index) => {
    if (!isRecord(u) || typeof u.command !== 'string' || u.command.startsWith('-') || typeof u.key !== 'string' || !u.key) return;
    const when = str(u.when) || '';
    rows.push({ id: `u${index}`, source: 'user', command: u.command, title: title(u.command), key: u.key, when, args: u.args, index, removalIndex: removalOf(u.command, u.key, when, index) });
  });
  return rows;
}

const edit = (text: string, path: jsonc.JSONPath, value: unknown, extra: Partial<jsonc.ModificationOptions> = {}): string =>
  jsonc.applyEdits(text, jsonc.modify(text, path, value, { ...FORMAT, ...extra }));
const append = (text: string, entry: JsonObject): string => edit(text, [-1], entry, { isArrayInsertion: true });

// jsonc-parser 3.3.1 removes the last element of an array up to two characters before the end, as if a line break
// came before `]`. In a one-line file (`…}]`) that leaves a stray `}`, so put the line break there first.
function removeAt(text: string, index: number): string {
  const tree = jsonc.parseTree(text, [], PARSE);
  const count = tree?.type === 'array' ? (tree.children?.length ?? 0) : 0;
  const close = tree ? tree.offset + tree.length - 1 : -1;
  const lastOfMany = count > 1 && index === count - 1;
  const safe = lastOfMany && !/\s/.test(text.charAt(close - 1)) ? `${text.slice(0, close)}\n${text.slice(close)}` : text;
  return edit(safe, [index], undefined);
}

function entry({ key, command, when, args }: { key: string; command: string; when: string; args?: unknown }): JsonObject {
  const out: JsonObject = { key, command };
  if (when) out.when = when;
  if (args !== undefined) out.args = args;
  return out;
}

function checkEntry(list: readonly unknown[], index: number, command: string): void {
  const found = list[index];
  if (!isRecord(found) || found.command !== command) throw new Error('keybindings.json changed outside Personify. The list has been refreshed, please try again.');
}

/** keybindings.json text after `change`; `list` is that text parsed. Throws when an indexed entry moved. */
export function applyEdit(text: string, list: readonly unknown[], change: KeybindingEdit): string {
  switch (change.op) {
    case 'add':
      return append(text, entry(change));
    case 'update': {
      checkEntry(list, change.index, change.command);
      return edit(edit(text, [change.index, 'key'], change.key), [change.index, 'when'], change.when || undefined);
    }
    case 'remove':
      checkEntry(list, change.index, change.command);
      return removeAt(text, change.index);
    case 'disableDefault':
      return append(text, entry({ key: change.key, command: `-${change.command}`, when: change.when }));
    // Changing a default = disable the original + add the new one.
    case 'replaceDefault': {
      const removal = entry({ key: change.oldKey, command: `-${change.command}`, when: change.oldWhen });
      return append(append(text, removal), entry(change));
    }
    case 'restore':
      return applyEdit(text, list, { op: 'remove', index: change.index, command: `-${change.command}` });
    case 'resetCommand': {
      let next = text;
      for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        const c = isRecord(item) ? item.command : undefined;
        if (c === change.command || c === `-${change.command}`) next = removeAt(next, i);
      }
      return next;
    }
    default: {
      const unknownEdit: never = change;
      return unknownEdit;
    }
  }
}
