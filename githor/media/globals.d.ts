// The webview's host API. The page's modules import their types from src/protocol.ts.

declare function acquireVsCodeApi(): {
  postMessage(message: import('../src/protocol').ClientMessage): void;
  getState(): import('./vscode').Persisted | undefined;
  setState(state: import('./vscode').Persisted): void;
};
