// The machine around the orchestrator: a usable PATH (VS Code started from the Dock does not get the
// login shell's), where claude / gh live, and the health checks shown on the dashboard.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { exists } from './files';
import { exec, launch, setShim, type ExecResult } from './git';
import { parseFlags, versionProblem } from './runner';

const HOME = os.homedir();
const isWin = process.platform === 'win32';

function run(cmd: string, args: string[], timeout = 8000, env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    const [file, argv] = launch(cmd, args);
    execFile(file, argv, { timeout, env: env || process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/** PATH as the user's login shell sets it, merged with what VS Code already has. */
async function loginShellPath(): Promise<string> {
  if (isWin) return process.env.PATH || '';
  const shell = process.env.SHELL || ((await exists('/bin/zsh')) ? '/bin/zsh' : '/bin/bash');
  const marker = '__CLAUDESTRATOR_PATH__';
  const r = await run(shell, ['-lc', `printf '${marker}%s${marker}' "$PATH"`], 8000);
  const m = r.stdout.match(new RegExp(`${marker}(.*)${marker}`));
  const extra = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const parts = [...(m ? m[1]!.split(':') : []), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
  return [...new Set(parts)].join(':');
}

/** First executable named `name` on PATH (no shell functions or aliases: we spawn it directly). */
async function which(name: string, PATH?: string): Promise<string | null> {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if ((await fs.promises.stat(file)).isFile()) {
          if (!isWin) await fs.promises.access(file, fs.constants.X_OK);
          return file;
        }
      } catch {
        // not here
      }
    }
  }
  return null;
}

function expand(p: string): string;
function expand(p: string | null | undefined): string | null | undefined;
function expand(p: string | null | undefined): string | null | undefined {
  return p ? path.resolve(String(p).replace(/^~(?=$|[\\/])/, HOME)) : p;
}

/** How long what was read of a Claude Code file holds before the file is looked at again. */
const FRESH_MS = 5000;
const jsonFiles = new Map<string, { at: number; sig: string; value: unknown }>();

/**
 * A JSON file of Claude Code's, parsed once per change and looked at no more than every FRESH_MS: `.claude.json` keeps
 * per-project history and can be megabytes, Claude Code rewrites it all the time an agent runs, and the dashboard asks
 * for the account and the MCP servers on every refresh. Undefined when it is not there or not JSON (being written).
 */
async function readJsonFresh(file: string, now: number = Date.now()): Promise<unknown> {
  const hit = jsonFiles.get(file);
  if (hit && now - hit.at < FRESH_MS) return hit.value;
  let sig: string;
  try {
    const st = await fs.promises.stat(file);
    sig = `${st.size}:${st.mtimeMs}`;
  } catch {
    jsonFiles.set(file, { at: now, sig: '', value: undefined });
    return undefined;
  }
  if (hit && hit.sig === sig) {
    hit.at = now;
    return hit.value;
  }
  let value: unknown;
  try {
    value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    value = undefined;
  }
  jsonFiles.set(file, { at: now, sig, value });
  return value;
}

/** The signed-in email a `.claude.json` names. */
async function accountEmail(file: string): Promise<string | undefined> {
  const data = await readJsonFresh(file);
  const acc = typeof data === 'object' && data !== null ? (data as { oauthAccount?: unknown }).oauthAccount : undefined;
  const value = typeof acc === 'object' && acc !== null ? (acc as { emailAddress?: unknown }).emailAddress : undefined;
  return typeof value === 'string' ? value : undefined;
}

interface ClaudeAccount {
  dir: string;
  label: string;
  email?: string;
}

/** What a config folder is called: `.claude` is the default account, `.claude-work` is "work". */
const accountLabel = (dir: string): string => path.basename(dir).replace(/^\.claude-?/, '') || 'default';

let accounts: { at: number; list: Promise<ClaudeAccount[]> } | null = null;

/** Claude Code config folders (accounts): ~/.claude and ~/.claude-*. Looked for again after FRESH_MS. */
function claudeAccounts(now: number = Date.now()): Promise<ClaudeAccount[]> {
  if (accounts && now - accounts.at < FRESH_MS) return accounts.list;
  const list = findAccounts();
  accounts = { at: now, list };
  return list;
}

async function findAccounts(): Promise<ClaudeAccount[]> {
  const out: ClaudeAccount[] = [];
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(HOME);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name !== '.claude' && !name.startsWith('.claude-')) continue;
    const dir = path.join(HOME, name);
    try {
      if (!(await fs.promises.stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!(await Promise.all(['projects', '.claude.json', 'settings.json'].map((f) => exists(path.join(dir, f))))).includes(true)) continue;
    let email: string | undefined;
    for (const f of [path.join(dir, '.claude.json'), ...(name === '.claude' ? [path.join(HOME, '.claude.json')] : [])]) {
      email = await accountEmail(f);
      if (email !== undefined) break;
    }
    out.push({ dir, label: accountLabel(dir), ...(email && { email }) });
  }
  return out;
}

/**
 * Health of everything the pipeline needs. `settings`: { claudePath }.
 * Returns { PATH, claude: { path, version, flags }, git, gh, checkedAt }.
 */
interface ClaudeProbe {
  path: string | null | undefined;
  ok: boolean;
  version?: string | undefined;
  flags?: string[];
  error?: string;
}
interface GhProbe {
  path: string | null;
  ok: boolean;
  version?: string;
  account?: string | undefined;
  error?: string;
}
interface Probe {
  PATH: string;
  env: NodeJS.ProcessEnv;
  claude: ClaudeProbe;
  git: { ok: boolean; version: string };
  gh: GhProbe;
  /** GitLab's CLI: needed only for repos on GitLab and GitLab issues. */
  glab: GhProbe;
  checkedAt: string;
}

/**
 * The file an npm Windows shim (`claude.cmd`) runs, absolute: `"%dp0%\\node_modules\\…\\cli.js" %*` in the shim's
 * text, or the older `"%~dp0\\…"` form. Null when the text is not such a shim.
 */
function npmShimTarget(text: string, shimDir: string): string | null {
  const m = text.match(/"%~?dp0%?\\([^"]+)"\s+%\*/i);
  return m ? path.join(shimDir, ...m[1]!.split('\\')) : null;
}

/** Registers what a `.cmd`/`.bat` shim runs, so it can be spawned; an error message when it cannot be. */
async function resolveShim(command: string, PATH: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.promises.readFile(command, 'utf8');
  } catch (e) {
    return `cannot read ${command}: ${(e as Error).message}`;
  }
  const target = npmShimTarget(text, path.dirname(command));
  if (!target) return `${command} is a script Claudestrator cannot start; set claudestrator.claudePath to claude.exe (the native build)`;
  if (/\.exe$/i.test(target)) {
    setShim(command, { file: target, args: [] });
    return null;
  }
  const node = await which('node', PATH);
  if (!node) return `${command} runs ${target} with Node.js, which is not on PATH`;
  setShim(command, { file: node, args: [target] });
  return null;
}

async function probe(settings: { claudePath?: string } = {}): Promise<Probe> {
  const PATH = await loginShellPath();
  const env: NodeJS.ProcessEnv = { ...process.env, PATH };
  delete env.ELECTRON_RUN_AS_NODE;

  const claudePath = settings.claudePath && settings.claudePath !== 'claude' ? expand(settings.claudePath) : await which('claude', PATH);
  const claude: ClaudeProbe = { path: claudePath, ok: false };
  const found = claudePath && (await exists(claudePath)) ? claudePath : null;
  const shimError = found && isWin && /\.(cmd|bat)$/i.test(found) ? await resolveShim(found, PATH) : null;
  if (shimError) claude.error = shimError;
  else if (found) {
    const v = await run(found, ['--version'], 15000, env);
    claude.version = v.stdout.trim().split('\n')[0] || undefined;
    const h = await run(found, ['--help'], 15000, env);
    claude.flags = [...parseFlags(h.stdout + h.stderr)];
    const tooOld = v.code === 0 ? versionProblem(claude.version) : null;
    claude.ok = v.code === 0 && !tooOld;
    if (tooOld) claude.error = tooOld;
    else if (!claude.ok) claude.error = (v.stderr || v.stdout).trim().slice(0, 300) || `exit ${v.code}`;
  } else claude.error = claudePath ? `${claudePath} does not exist` : 'not found on PATH';

  const gitV = await exec('git', ['--version'], { env, timeoutMs: 8000 });
  const git = { ok: gitV.code === 0, version: gitV.stdout.trim().replace(/^git version /, '') };

  const [gh, glab] = await Promise.all([forgeCli('gh', PATH, env, 'needed only to open PRs and read GitHub issues'), forgeCli('glab', PATH, env, 'needed only for repos and issues on GitLab')]);

  return { PATH, env, claude, git, gh, glab, checkedAt: new Date().toISOString() };
}

/** A forge's CLI (gh, glab): installed, its version, and whether it is signed in, as whom. */
async function forgeCli(cmd: 'gh' | 'glab', PATH: string, env: NodeJS.ProcessEnv, needed: string): Promise<GhProbe> {
  const found = await which(cmd, PATH);
  const probe: GhProbe = { path: found, ok: false };
  if (!found) return { ...probe, error: `not installed (${needed})` };
  const v = await exec(found, ['--version'], { env, timeoutMs: 8000 });
  probe.version = (v.stdout.split('\n')[0] || '').replace(new RegExp(`^${cmd}( version)? `), '').trim();
  const a = await exec(found, ['auth', 'status'], { env, timeoutMs: 15000 });
  probe.ok = a.code === 0;
  const out = `${a.stdout}\n${a.stderr}`;
  const account = out.match(/account (\S+)/) || out.match(/as (\S+)/);
  if (account) probe.account = account[1];
  if (!probe.ok) probe.error = `not logged in (run: ${cmd} auth login)`;
  return probe;
}

/**
 * The newest status-line snapshot of an account (written by a Claude Code status line such as ctx-man's into
 * `<config dir>/statusline/<session>.json`): limits and the session's model and effort, before any agent ran.
 */
/** A rate-limit entry of the status line JSON. */
interface RawLimit {
  used_percentage?: number | null;
  resets_at?: number;
}
interface LimitSnapshot {
  pct: number;
  resetsAt: number | undefined;
}
interface StatuslineSnapshot {
  fiveHour: LimitSnapshot | undefined;
  sevenDay: LimitSnapshot | undefined;
  at: number;
  source: string;
  model?: string;
  effort?: string;
}

const snapshots = new Map<string, { at: number; value: Promise<StatuslineSnapshot | null> }>();

/**
 * The account's newest status line snapshot (ctx-man writes one per session to `<account>/statusline/`), looked for no
 * more than every FRESH_MS: the dashboard asks for the limits on every refresh, and each look reads the whole folder.
 */
function statuslineSnapshot(configDir: string, now: number = Date.now()): Promise<StatuslineSnapshot | null> {
  const hit = snapshots.get(configDir);
  if (hit && now - hit.at < FRESH_MS) return hit.value;
  const value = readStatusline(configDir);
  snapshots.set(configDir, { at: now, value });
  return value;
}

async function readStatusline(configDir: string): Promise<StatuslineSnapshot | null> {
  const dir = path.join(configDir, 'statusline');
  let newest: { name: string; mtimeMs: number } | null = null;
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const st = await fs.promises.stat(path.join(dir, name));
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: st.mtimeMs };
    } catch {
      // pruned meanwhile
    }
  }
  if (!newest) return null;
  try {
    const s = JSON.parse(await fs.promises.readFile(path.join(dir, newest.name), 'utf8')) as { five_hour?: RawLimit; seven_day?: RawLimit; updated_at?: number; model?: string; effort?: string };
    const lim = (l?: RawLimit): LimitSnapshot | undefined => (l && l.used_percentage != null ? { pct: Math.round(Number(l.used_percentage)), resetsAt: l.resets_at } : undefined);
    const out: StatuslineSnapshot = { fiveHour: lim(s.five_hour), sevenDay: lim(s.seven_day), at: (s.updated_at ? s.updated_at * 1000 : newest.mtimeMs), source: 'statusline', ...(s.model && { model: s.model }), ...(s.effort && { effort: s.effort }) };
    return out.fiveHour || out.sevenDay ? out : null;
  } catch {
    return null;
  }
}

export type { ClaudeAccount, Probe, StatuslineSnapshot };
export { loginShellPath, which, expand, accountLabel, claudeAccounts, probe, forgeCli, statuslineSnapshot, npmShimTarget, readJsonFresh };
