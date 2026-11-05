export type ScriptId = string & { readonly __brand: 'ScriptId' };
export type GroupId = string & { readonly __brand: 'GroupId' };

export const HUES = ['violet', 'blue', 'cyan', 'green', 'amber', 'orange', 'rose', 'pink'] as const;
export type Hue = (typeof HUES)[number];

/** A script file run by its interpreter, or a command line typed as is (`npm run dev`). */
export type ScriptType = 'file' | 'command';

export interface Script {
  id: ScriptId;
  type: ScriptType;
  name: string;
  /** Absolute path to the file. Empty for a command. */
  path: string;
  /** The line typed into the terminal. Empty for a file. */
  command: string;
  /** What the script is for; shown in its tooltip. */
  description: string;
  groupId: GroupId | null;
  /** Command that runs the file, e.g. `python3 -u`. Empty: picked by the file extension. Always empty for a command. */
  interpreter: string;
  /** Appended to the command as typed. Always empty for a command. */
  args: string;
  /** Terminal folder. Empty: the folder of the script. Required for a command. */
  cwd: string;
  /** Unix ms of the last run from Scriptor, 0 if never. */
  lastRunAt: number;
}

export interface Group {
  id: GroupId;
  name: string;
  hue: Hue;
}

export interface Library {
  groups: Group[];
  scripts: Script[];
}

/** What the editor sends: a script before it is validated and given an id. */
export interface ScriptDraft {
  id: string | null;
  type: ScriptType;
  name: string;
  path: string;
  command: string;
  description: string;
  groupId: string | null;
  interpreter: string;
  args: string;
  cwd: string;
}

export interface GroupDraft {
  id: string | null;
  name: string;
  hue: Hue;
}
