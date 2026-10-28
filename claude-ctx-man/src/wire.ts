// What the status line editor (media/statusline.ts) and the extension send each other. Types only: the page
// is a plain script and imports nothing at run time. The host narrows what it receives in src/messages.ts.
import type { StatusLineConfig } from '../statusline/types';

/** What a folder's `settings.json` has for `statusLine`. */
export type InstallStatus = { kind: 'none' } | { kind: 'ctxman' } | { kind: 'custom'; command: string };

export interface AccountView {
  dir: string;
  label: string;
  email: string;
  status: InstallStatus;
  /** A status line that was there before ours is remembered and can be put back. */
  canRestore: boolean;
  hidden: boolean;
}

export interface PresetView {
  id: string;
  label: string;
  hint: string;
  config: StatusLineConfig;
}

export type ToastKind = 'success' | 'error' | 'info';

export type HostMessage =
  | { type: 'init'; config: StatusLineConfig; accounts: AccountView[]; presets: PresetView[]; configFile: string }
  | { type: 'preview'; ansi: string; source: string }
  | { type: 'accounts'; accounts: AccountView[] }
  | { type: 'toast'; kind: ToastKind; text: string };

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'update'; config: StatusLineConfig }
  | { type: 'previewAccount'; dir: string }
  | { type: 'apply'; dirs: string[] }
  | { type: 'restore'; dirs: string[] }
  | { type: 'openConfig' };
