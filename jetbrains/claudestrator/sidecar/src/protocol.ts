// The wire between the IDE plugin (Kotlin) and this process: one JSON object per line on stdin/stdout.
// stdout carries only this protocol; anything the engine prints goes to stderr (see transport.ts).
// The Kotlin side of it is `Protocol.kt`; change both together.

/** Plugin → sidecar. */
export type Incoming =
  | { type: 'init'; workspaceFolders: string[]; settings: Settings; storageDir: string; extensionDir: string; version: string }
  | { type: 'settings'; settings: Settings; changed: string[] }
  | { type: 'page'; msg: unknown }
  | { type: 'dashboard'; route?: unknown; reveal?: boolean }
  | { type: 'dashboardClosed' }
  | { type: 'call'; id: number; method: string; params?: Record<string, unknown> }
  | { type: 'res'; id: number; ok: boolean; data?: unknown; error?: string }
  | { type: 'terminalClosed'; id: number; code?: number }
  | { type: 'shutdown' };

/** Sidecar → plugin. */
export type Outgoing =
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  | { type: 'post'; msg: unknown }
  | { type: 'revealDashboard' }
  | { type: 'state'; root: string | null; cards: unknown[]; limits: unknown; health: unknown }
  | { type: 'engine'; name: string; data: unknown }
  | { type: 'req'; id: number; method: string; params: unknown }
  | { type: 'res'; id: number; ok: boolean; data?: unknown; error?: string };

/** Flat, like VS Code's: `claudestrator.claudePath`, `claudestrator.atlassian.site`, … */
export type Settings = Record<string, unknown>;
