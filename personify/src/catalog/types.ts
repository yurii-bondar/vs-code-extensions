// What Personify can edit. The catalog is plain data: the host uses it to write settings, the webview to render them.

/** A key of `workbench.colorCustomizations`. */
export interface ColorItem {
  readonly kind: 'color';
  readonly key: string;
  readonly label: string;
  /** Empty when there is nothing to add to the label. */
  readonly desc: string;
}

interface SettingBase {
  readonly kind: 'setting';
  /** A plain VS Code setting, e.g. `editor.fontSize`. */
  readonly key: string;
  readonly label: string;
  /** Empty when there is nothing to add to the label. */
  readonly hint: string;
}

export interface NumberSetting extends SettingBase {
  readonly type: 'number';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Empty for a unitless number. */
  readonly unit: string;
}
export interface FontSetting extends SettingBase {
  readonly type: 'font';
}
export interface EnumSetting extends SettingBase {
  readonly type: 'enum';
  readonly options: readonly string[];
}
export interface BooleanSetting extends SettingBase {
  readonly type: 'boolean';
}
export type SettingItem = NumberSetting | FontSetting | EnumSetting | BooleanSetting;

export interface NoteItem {
  readonly kind: 'note';
  readonly text: string;
}

export type AreaItem = ColorItem | SettingItem | NoteItem;

export interface Area {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly desc: string;
  readonly groups: readonly { readonly title: string; readonly items: readonly AreaItem[] }[];
}

export interface TokenItem {
  readonly id: string;
  readonly label: string;
  readonly example: string;
  /** TextMate selectors, prefixed with every root of the language. */
  readonly scopes: readonly string[];
  /** Semantic token selectors, suffixed with every semantic language of the language. */
  readonly semantic: readonly string[];
  /** Empty when there is nothing to add. */
  readonly hint: string;
}

export interface Language {
  readonly id: string;
  readonly title: string;
  readonly short: string;
  readonly roots: readonly string[];
  readonly semanticLanguages: readonly string[];
  /** The language id the sample opens in. */
  readonly sampleLanguage: string;
  readonly groups: readonly { readonly title: string; readonly items: readonly TokenItem[] }[];
  /** Sample lines; `⟦item.id¦text⟧` marks a token for the preview. */
  readonly sample: readonly string[];
}

export const tokenItem = (id: string, label: string, example: string, scopes: readonly string[], semantic: readonly string[] = [], hint = ''): TokenItem => ({ id, label, example, scopes, semantic, hint });
