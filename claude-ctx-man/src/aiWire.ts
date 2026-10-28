// What the AI files page and the extension exchange. Types only: the page is a plain script and must not pull in Node or vscode.

export type PresetId = 'claude-only' | 'several';
export type ToolId = 'claude' | 'cursor' | 'agents';

export interface RootView {
  name: string;
  path: string;
}

export interface ItemView {
  /** Relative to the project root, with `/`. */
  path: string;
  kind: 'dir' | 'file' | 'link';
  /** Where a link points, relative to the link; empty for the rest. */
  target: string;
  /** `create`: not there yet. `exists`: already as wanted. `conflict`: something different is there and stays untouched. */
  status: 'create' | 'exists' | 'conflict';
  hint: string;
  /** What a link needs to exist, or empty. */
  needs: string;
  /** The needed path is already on disk, so the link works even if it is left out of this run. */
  needsOk: boolean;
}

export interface ResultView {
  path: string;
  status: 'created' | 'exists' | 'conflict' | 'failed' | 'skipped';
  error: string;
}

export type HostMessage =
  | { type: 'init'; roots: RootView[]; platform: string }
  | { type: 'plan'; root: string; preset: PresetId; tools: ToolId[]; items: ItemView[] }
  | { type: 'result'; root: string; results: ResultView[] };

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'plan'; root: string; preset: PresetId; tools: ToolId[] }
  | { type: 'create'; root: string; preset: PresetId; tools: ToolId[]; skip: string[] }
  | { type: 'open'; root: string; path: string };
