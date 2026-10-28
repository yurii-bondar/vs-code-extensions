/** A Claude Code config folder, the value of `CLAUDE_CONFIG_DIR`. One folder is one account. */
export type ConfigDir = string & { readonly __brand: 'ConfigDir' };
export type SessionId = string & { readonly __brand: 'SessionId' };
/** The folder name Claude Code gives a project under `<config>/projects/`: the working directory with symbols turned into `-`. */
export type ProjectSlug = string & { readonly __brand: 'ProjectSlug' };

export interface Account {
  dir: ConfigDir;
  label: string;
  /** Empty when the folder has no cached login profile. */
  email: string;
  org: string;
}

export interface Session {
  id: SessionId;
  file: string;
  projectDir: ProjectSlug;
  account: Account;
  mtime: number;
  size: number;
  title: string;
  firstPrompt: string;
  lastPrompt: string;
  /** Empty when the transcript does not say. */
  cwd: string;
  branch: string;
}
