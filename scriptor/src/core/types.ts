export type ScriptId = string & { readonly __brand: 'ScriptId' };
export type GroupId = string & { readonly __brand: 'GroupId' };

export const HUES = ['violet', 'blue', 'cyan', 'green', 'amber', 'orange', 'rose', 'pink'] as const;
export type Hue = (typeof HUES)[number];

export interface Script {
  id: ScriptId;
  name: string;
  /** Absolute path to the file. */
  path: string;
  /** What the script is for; shown in its tooltip. */
  description: string;
  groupId: GroupId | null;
  /** Command that runs the file, e.g. `python3 -u`. Empty: picked by the file extension. */
  interpreter: string;
  /** Appended to the command as typed. */
  args: string;
  /** Terminal folder. Empty: the folder of the script. */
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
  name: string;
  path: string;
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
