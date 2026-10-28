// What the sidebar page and the extension exchange. Types only: the page is a plain script and must not pull in Node or vscode.

export interface SessionRow {
  /** Unique across accounts: a continued session has the same id on both. */
  key: string;
  title: string;
  mtime: number;
  bytes: number;
  /** Big enough that moving it to another account is costly. */
  big: boolean;
  branch: string;
  /** The folder the session ran in; only shown when sessions of all projects are listed. */
  project: string;
  lastPrompt: string;
}

export interface AccountCard {
  dir: string;
  label: string;
  email: string;
  org: string;
  initials: string;
  /** Index into the page's palette. */
  hue: number;
  active: boolean;
  loggedIn: boolean;
  /** All sessions of the account; `sessions` is capped. */
  total: number;
  sessions: SessionRow[];
}

export interface SidebarState {
  allProjects: boolean;
  hasWorkspace: boolean;
  accounts: AccountCard[];
  /** Accounts hidden by the person, so the page can offer to show them again. */
  hidden: number;
}

export type HostMessage = { type: 'state'; state: SidebarState };

export type AccountAction = 'use' | 'new' | 'hide';
export type SessionAction = 'resume' | 'continue' | 'handoff' | 'copy' | 'reveal';
export type Tool = 'statusline' | 'aiFiles' | 'addAccount' | 'showHidden' | 'refresh';

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'account'; action: AccountAction; dir: string }
  | { type: 'session'; action: SessionAction; key: string }
  | { type: 'scope'; all: boolean }
  | { type: 'tool'; tool: Tool };
