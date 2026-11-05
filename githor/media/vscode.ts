// The page's line to the host, and what it keeps across reloads.
import type { BranchFilter } from '../src/core/marks.js';
import type { ClientMessage } from '../src/protocol.js';

/** What survives a reload of the page (a hidden sidebar view is reloaded when shown). */
export interface Persisted {
  filter?: BranchFilter;
  query?: string;
}

const api = acquireVsCodeApi();

export const post = (message: ClientMessage): void => api.postMessage(message);
export const restore = (): Persisted => api.getState() ?? {};
export const persist = (state: Persisted): void => api.setState(state);
