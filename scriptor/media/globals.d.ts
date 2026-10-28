// The dashboard is one plain script (app.js), not a module. What the host sends and accepts is typed by src/protocol.ts.

type GroupView = import('../src/protocol').GroupView;
type ScriptView = import('../src/protocol').ScriptView;
type HostMessage = import('../src/protocol').HostMessage;
type ClientMessage = import('../src/protocol').ClientMessage;
type Hue = import('../src/core/types').Hue;

/** What survives a reload of the page. */
interface PersistedState {
  collapsed?: string[];
}

declare function acquireVsCodeApi(): {
  postMessage(message: ClientMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
};
