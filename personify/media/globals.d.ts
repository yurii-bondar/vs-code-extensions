// The panel is one plain script (main.js), not a module. What the host sends and accepts is typed by src/protocol.ts.

type HostMessage = import('../src/protocol').HostMessage;
type ClientMessage = import('../src/protocol').ClientMessage;
type PrefsView = import('../src/protocol').PrefsView;
type ToastKind = import('../src/protocol').ToastKind;
type Area = import('../src/catalog/types').Area;
type AreaItem = import('../src/catalog/types').AreaItem;
type SettingItem = import('../src/catalog/types').SettingItem;
type Language = import('../src/catalog/types').Language;
type Tab = import('../src/core/types').Tab;
type AppearanceState = import('../src/core/types').AppearanceState;
type SyntaxState = import('../src/core/types').SyntaxState;
type SettingValue = import('../src/core/types').SettingValue;
type TokenStyle = import('../src/core/types').TokenStyle;
type CustomRule = import('../src/core/types').CustomRule;
type KeybindingRow = import('../src/core/types').KeybindingRow;
type KeybindingsState = import('../src/core/types').KeybindingsState;
type KeybindingEdit = import('../src/core/types').KeybindingEdit;

/** What survives a reload of the page; checked on read, since an older version may have written it. */
interface PersistedState {
  tab?: string;
  area?: string;
  lang?: string;
}

declare function acquireVsCodeApi(): {
  postMessage(message: ClientMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
};
