// Shapes shared by the host and the webview. Plain data only: the webview loads none of the host's modules.

export type Scope = 'user' | 'workspace';
export type ThemeMode = 'all' | 'current';
export type Tab = 'hotkeys' | 'appearance' | 'syntax' | 'profiles';

export interface Prefs {
  readonly scope: Scope;
  readonly themeMode: ThemeMode;
}

/** Where a write goes: user or workspace settings, nested under "[Theme name]" when `theme` is set. */
export interface Target {
  readonly scope: Scope;
  readonly theme: string | null;
}

/** What the catalog's settings hold: numbers, enum strings, font names and booleans. */
export type SettingValue = string | number | boolean;

export interface SettingState {
  /** Written at the current scope; null when not set there. */
  value: SettingValue | null;
  /** What applies right now, from any level. */
  effective: SettingValue | null;
  def: SettingValue | null;
}

export interface AppearanceState {
  colors: Record<string, string>;
  settings: Record<string, SettingState>;
}

/** `fontStyle: ''` is a style too: it clears the theme's bold or italic. null leaves it to the theme. */
export interface TokenStyle {
  fg: string | null;
  fontStyle: string | null;
}

export interface CustomRule extends TokenStyle {
  id: string;
  /** Comma-separated TextMate scopes, as typed. */
  scope: string;
}

export interface SyntaxState {
  /** By `langId/itemId`. */
  items: Record<string, TokenStyle>;
  custom: CustomRule[];
  /** null: the theme decides. */
  semanticHighlighting: boolean | null;
}

export interface SyntaxChange {
  readonly langId: string;
  readonly itemId: string;
  /** null resets the token to the theme. */
  readonly style: TokenStyle | null;
}

interface RowBase {
  /** Unique within one keybindings message. */
  readonly id: string;
  readonly command: string;
  readonly title: string;
  readonly key: string;
  /** Empty: always. */
  readonly when: string;
  readonly args: unknown;
}

export interface DefaultRow extends RowBase {
  readonly source: 'default';
  /** Index of the `-command` entry in keybindings.json that switches this default off; null while it is on. */
  readonly removalIndex: number | null;
}

export interface UserRow extends RowBase {
  readonly source: 'user';
  /** Index of the entry in keybindings.json. */
  readonly index: number;
}

export type KeybindingRow = DefaultRow | UserRow;

export interface CommandInfo {
  readonly id: string;
  readonly title: string;
}

export interface KeybindingsState {
  readonly rows: KeybindingRow[];
  readonly commands: CommandInfo[];
  readonly file: string;
  /** Why keybindings.json could not be read; null when it was. */
  readonly error: string | null;
  /** False when VS Code's own defaults were unavailable and only extension shortcuts are listed. */
  readonly defaultsFromVscode: boolean;
}

/** A change to keybindings.json. Edits by index re-check the command there, in case the file changed meanwhile. */
export type KeybindingEdit =
  | { readonly op: 'add'; readonly command: string; readonly key: string; readonly when: string; readonly args: unknown }
  | { readonly op: 'update'; readonly index: number; readonly command: string; readonly key: string; readonly when: string }
  | { readonly op: 'remove'; readonly index: number; readonly command: string }
  | { readonly op: 'disableDefault'; readonly command: string; readonly key: string; readonly when: string }
  | { readonly op: 'replaceDefault'; readonly command: string; readonly oldKey: string; readonly oldWhen: string; readonly key: string; readonly when: string; readonly args: unknown }
  | { readonly op: 'restoreDefault'; readonly index: number; readonly command: string }
  | { readonly op: 'resetCommand'; readonly command: string };
