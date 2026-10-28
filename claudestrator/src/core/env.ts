// The machine around the orchestrator: a usable PATH (VS Code started from the Dock does not get the
// login shell's), where claude / node / gh live, and the health checks shown on the dashboard.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { exec, type ExecResult } from './git';
import { parseFlags } from './runner';

const HOME = os.homedir();
const isWin = process.platform === 'win32';

function run(cmd: string, args: string[], timeout = 8000, env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: env || process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/** PATH as the user's login shell sets it, merged with what VS Code already has. */
async function loginShellPath(): Promise<string> {
  if (isWin) return process.env.PATH || '';
  const shell = process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  const marker = '__CLAUDESTRATOR_PATH__';
  const r = await run(shell, ['-lc', `printf '${marker}%s${marker}' "$PATH"`], 8000);
  const m = r.stdout.match(new RegExp(`${marker}(.*)${marker}`));
  const extra = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const parts = [...(m ? m[1]!.split(':') : []), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
  return [...new Set(parts)].join(':');
}

/** First executable named `name` on PATH (no shell functions or aliases: we spawn it directly). */
function which(name: string, PATH?: string): string | null {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) {
          if (!isWin) fs.accessSync(file, fs.constants.X_OK);
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

/**
 * The signed-in email a `.claude.json` names, cached by the file's size and mtime: the file keeps per-project history and
 * can be megabytes, and the account is asked for several times per refresh.
 */
const emails = new Map<string, { sig: string; email: string | undefined }>();

function accountEmail(file: string): string | undefined {
  let sig: string;
  try {
    const st = fs.statSync(file);
    sig = `${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined; // no such file
  }
  const hit = emails.get(file);
  if (hit && hit.sig === sig) return hit.email;
  let email: string | undefined;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const acc = typeof data === 'object' && data !== null ? (data as { oauthAccount?: unknown }).oauthAccount : undefined;
    const value = typeof acc === 'object' && acc !== null ? (acc as { emailAddress?: unknown }).emailAddress : undefined;
    email = typeof value === 'string' ? value : undefined;
  } catch {
    email = undefined; // being written, or not JSON
  }
  emails.set(file, { sig, email });
  return email;
}

/** Claude Code config folders (accounts): ~/.claude and ~/.claude-*. */
function claudeAccounts(): { dir: string; label: string; email?: string }[] {
  const out: { dir: string; label: string; email?: string }[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(HOME);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name !== '.claude' && !name.startsWith('.claude-')) continue;
    const dir = path.join(HOME, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!['projects', '.claude.json', 'settings.json'].some((f) => fs.existsSync(path.join(dir, f)))) continue;
    let email: string | undefined;
    for (const f of [path.join(dir, '.claude.json'), ...(name === '.claude' ? [path.join(HOME, '.claude.json')] : [])]) {
      email = accountEmail(f);
      if (email !== undefined) break;
    }
    out.push({ dir, label: name === '.claude' ? 'default' : name.replace(/^\.claude-/, ''), ...(email && { email }) });
  }
  return out;
}

/**
 * Health of everything the pipeline needs. `settings`: { claudePath, nodePath }.
 * Returns { PATH, claude: { path, version, flags }, node, git, gh, checkedAt }.
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
  node: { path: string | null; ok: boolean };
  git: { ok: boolean; version: string };
  gh: GhProbe;
  checkedAt: string;
}

async function probe(settings: { claudePath?: string; nodePath?: string } = {}): Promise<Probe> {
  const PATH = await loginShellPath();
  const env: NodeJS.ProcessEnv = { ...process.env, PATH };
  delete env.ELECTRON_RUN_AS_NODE;

  const claudePath = settings.claudePath && settings.claudePath !== 'claude' ? expand(settings.claudePath) : which('claude', PATH);
  const claude: ClaudeProbe = { path: claudePath, ok: false };
  if (claudePath && fs.existsSync(claudePath)) {
    const v = await run(claudePath, ['--version'], 15000, env);
    claude.version = v.stdout.trim().split('\n')[0] || undefined;
    const h = await run(claudePath, ['--help'], 15000, env);
    claude.flags = [...parseFlags(h.stdout + h.stderr)];
    claude.ok = v.code === 0;
    if (!claude.ok) claude.error = (v.stderr || v.stdout).trim().slice(0, 300) || `exit ${v.code}`;
  } else claude.error = claudePath ? `${claudePath} does not exist` : 'not found on PATH';

  const nodePath = settings.nodePath ? expand(settings.nodePath) : which('node', PATH);
  const node: Probe['node'] = { path: nodePath && fs.existsSync(nodePath) ? nodePath : null, ok: Boolean(nodePath && fs.existsSync(nodePath)) };

  const gitV = await exec('git', ['--version'], { env, timeoutMs: 8000 });
  const git = { ok: gitV.code === 0, version: gitV.stdout.trim().replace(/^git version /, '') };

  const ghPath = which('gh', PATH);
  const gh: GhProbe = { path: ghPath, ok: false };
  if (ghPath) {
    const v = await exec(ghPath, ['--version'], { env, timeoutMs: 8000 });
    gh.version = (v.stdout.split('\n')[0] || '').replace(/^gh version /, '').trim();
    const a = await exec(ghPath, ['auth', 'status'], { env, timeoutMs: 15000 });
    gh.ok = a.code === 0;
    const account = `${a.stdout}\n${a.stderr}`.match(/account (\S+)/) || `${a.stdout}\n${a.stderr}`.match(/as (\S+)/);
    if (account) gh.account = account[1];
    if (!gh.ok) gh.error = 'not logged in (run: gh auth login)';
  } else gh.error = 'not installed (needed only to open PRs)';

  return { PATH, env, claude, node, git, gh, checkedAt: new Date().toISOString() };
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

function statuslineSnapshot(configDir: string): StatuslineSnapshot | null {
  const dir = path.join(configDir, 'statusline');
  let newest: { name: string; mtimeMs: number } | null = null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: st.mtimeMs };
    } catch {
      // pruned meanwhile
    }
  }
  if (!newest) return null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, newest.name), 'utf8')) as { five_hour?: RawLimit; seven_day?: RawLimit; updated_at?: number; model?: string; effort?: string };
    const lim = (l?: RawLimit): LimitSnapshot | undefined => (l && l.used_percentage != null ? { pct: Math.round(Number(l.used_percentage)), resetsAt: l.resets_at } : undefined);
    const out: StatuslineSnapshot = { fiveHour: lim(s.five_hour), sevenDay: lim(s.seven_day), at: (s.updated_at ? s.updated_at * 1000 : newest.mtimeMs), source: 'statusline', ...(s.model && { model: s.model }), ...(s.effort && { effort: s.effort }) };
    return out.fiveHour || out.sevenDay ? out : null;
  } catch {
    return null;
  }
}

export type { Probe, StatuslineSnapshot };
export { loginShellPath, which, expand, claudeAccounts, probe, statuslineSnapshot };
