// The shape of ~/.ctx-man/statusline.json. Types only: the renderer is copied to ~/.ctx-man/ as one file and
// must not load anything that is not Node's own, so nothing here may be imported at run time.

export type SegmentId =
  | 'profile'
  | 'project'
  | 'git'
  | 'model'
  | 'effort'
  | 'context'
  | 'tokens'
  | 'five_hour'
  | 'seven_day'
  | 'cost'
  | 'lines'
  | 'duration'
  | 'clock'
  | 'output_style'
  | 'version'
  | 'text';

export type BarFormat = 'pct' | 'bar' | 'both';

export interface SegmentConfig {
  id: SegmentId;
  line: number;
  enabled: boolean;
  icon: string;
  label: string;
  color: string;
  bold: boolean;
  /** Attached to the previous segment, without the separator. */
  join: boolean;
  // Options: which ones a segment has depends on its id.
  accountColor?: boolean;
  showAheadBehind?: boolean;
  showDirty?: boolean;
  colorByLevel?: boolean;
  thresholds?: boolean;
  format?: BarFormat;
  showReset?: boolean;
  text?: string;
}

export interface Thresholds {
  warn: number;
  danger: number;
  okColor: string;
  warnColor: string;
  dangerColor: string;
}

export interface AccountStyle {
  label?: string;
  color?: string;
}

export interface Compat {
  tmuxStateFile: boolean;
  sessionSnapshots: boolean;
  disableFile: boolean;
}

export interface StatusLineConfig {
  version: number;
  separator: string;
  separatorColor: string;
  thresholds: Thresholds;
  barWidth: number;
  /** Names and colors by email (or by folder when there is no email). */
  accounts: Record<string, AccountStyle>;
  compat: Compat;
  segments: SegmentConfig[];
}
