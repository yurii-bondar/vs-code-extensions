import * as path from 'path';
import type { Hue, Script } from './types';

export type ShellKind = 'posix' | 'powershell' | 'cmd';

export interface FileKind {
  /** Human name, e.g. `Node.js`. */
  label: string;
  /** Up to three letters for the badge. */
  short: string;
  hue: Hue;
  /** The command that runs the file, or null when the file is run itself (needs a shebang or the executable bit). */
  interpreter(platform: NodeJS.Platform): string | null;
}

const kind = (label: string, short: string, hue: Hue, interpreter: string | ((platform: NodeJS.Platform) => string | null)): FileKind => ({
  label,
  short,
  hue,
  interpreter: typeof interpreter === 'function' ? interpreter : () => interpreter,
});

const KINDS: Readonly<Record<string, FileKind>> = {
  sh: kind('Shell', 'SH', 'green', 'bash'),
  bash: kind('Bash', 'SH', 'green', 'bash'),
  zsh: kind('Zsh', 'ZSH', 'green', 'zsh'),
  js: kind('Node.js', 'JS', 'amber', 'node'),
  mjs: kind('Node.js', 'JS', 'amber', 'node'),
  cjs: kind('Node.js', 'JS', 'amber', 'node'),
  ts: kind('TypeScript', 'TS', 'blue', 'npx tsx'),
  py: kind('Python', 'PY', 'cyan', (platform) => (platform === 'win32' ? 'python' : 'python3')),
  rb: kind('Ruby', 'RB', 'rose', 'ruby'),
  php: kind('PHP', 'PHP', 'violet', 'php'),
  pl: kind('Perl', 'PL', 'pink', 'perl'),
  lua: kind('Lua', 'LUA', 'blue', 'lua'),
  go: kind('Go', 'GO', 'cyan', 'go run'),
  ps1: kind('PowerShell', 'PS', 'blue', (platform) => (platform === 'win32' ? 'powershell -NoProfile -ExecutionPolicy Bypass -File' : 'pwsh -File')),
  bat: kind('Batch', 'BAT', 'orange', () => null),
  cmd: kind('Batch', 'BAT', 'orange', () => null),
};

const extensionOf = (file: string): string => path.extname(file).slice(1).toLowerCase();

/** What Scriptor knows about a file; any other file is run itself. */
export function kindOf(file: string): FileKind {
  const ext = extensionOf(file);
  return KINDS[ext] ?? kind(ext ? ext.toUpperCase() : 'Executable', ext ? ext.slice(0, 3).toUpperCase() : 'EXE', 'orange', () => null);
}

const COMMAND: FileKind = kind('Command', 'CMD', 'violet', () => null);

/** What the card and the tree show for a script: the kind of its file, or `Command`. */
export const scriptKind = (script: Pick<Script, 'type' | 'path'>): FileKind => (script.type === 'command' ? COMMAND : kindOf(script.path));

/** The path that has to be on disk for the script to run: the file, or the folder of a command. */
export const locationOf = (script: Pick<Script, 'type' | 'path' | 'cwd'>): string => (script.type === 'command' ? script.cwd : script.path);

/** The folder the terminal opens in. */
export const workDirOf = (script: Pick<Script, 'path' | 'cwd'>): string => script.cwd || path.dirname(script.path);

export function shellKind(shellPath: string): ShellKind {
  const name = path.basename(shellPath.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (name === 'cmd') return 'cmd';
  if (name === 'powershell' || name === 'pwsh') return 'powershell';
  return 'posix';
}

export function quote(arg: string, shell: ShellKind): string {
  if (shell === 'cmd') return `"${arg}"`;
  if (shell === 'powershell') return `'${arg.replace(/'/g, "''")}'`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The interpreter the script will run with: its own, the one for the extension, or null to run the file itself. */
export function interpreterOf(script: Pick<Script, 'path' | 'interpreter'>, platform: NodeJS.Platform): string | null {
  return script.interpreter.trim() || kindOf(script.path).interpreter(platform);
}

export interface BuildOptions {
  script: Pick<Script, 'type' | 'path' | 'command' | 'interpreter' | 'args'>;
  shell: ShellKind;
  platform: NodeJS.Platform;
}

/** The line typed into the terminal: a command as it was written, a file with its interpreter and arguments. */
export function buildCommand({ script, shell, platform }: BuildOptions): string {
  if (script.type === 'command') return script.command.trim();
  const interpreter = interpreterOf(script, platform);
  const file = quote(script.path, shell);
  const head = interpreter ?? (shell === 'powershell' ? `& ${file}` : file);
  return [interpreter ? `${head} ${file}` : head, script.args.trim()].filter(Boolean).join(' ');
}

/** `~` and `~/x` to the home folder; anything else is left as typed. */
export function expandHome(p: string, home: string): string {
  const trimmed = p.trim();
  return trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\') ? path.join(home, trimmed.slice(1)) : trimmed;
}
