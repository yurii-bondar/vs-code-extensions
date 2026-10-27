// The machine around the orchestrator: a usable PATH (VS Code started from the Dock does not get the
// login shell's), where claude / node / gh live, and the health checks shown on the dashboard.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { exec } = require('./git');
const { parseFlags } = require('./runner');

const HOME = os.homedir();
const isWin = process.platform === 'win32';

function run(cmd, args, timeout = 8000, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: env || process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/** PATH as the user's login shell sets it, merged with what VS Code already has. */
async function loginShellPath() {
  if (isWin) return process.env.PATH || '';
  const shell = process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  const marker = '__CLAUDESTRATOR_PATH__';
  const r = await run(shell, ['-lc', `printf '${marker}%s${marker}' "$PATH"`], 8000);
  const m = r.stdout.match(new RegExp(`${marker}(.*)${marker}`));
  const extra = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const parts = [...(m ? m[1].split(':') : []), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
  return [...new Set(parts)].join(':');
}

/** First executable named `name` on PATH (no shell functions or aliases: we spawn it directly). */
function which(name, PATH) {
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

function expand(p) {
  return p ? path.resolve(String(p).replace(/^~(?=$|[\\/])/, HOME)) : p;
}

/** Claude Code config folders (accounts): ~/.claude and ~/.claude-*. */
function claudeAccounts() {
  const out = [];
  let names = [];
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
    let email;
    for (const f of [path.join(dir, '.claude.json'), ...(name === '.claude' ? [path.join(HOME, '.claude.json')] : [])]) {
      try {
        const acc = JSON.parse(fs.readFileSync(f, 'utf8')).oauthAccount;
        if (acc) {
          email = acc.emailAddress;
          break;
        }
      } catch {
        // missing
      }
    }
    out.push({ dir, label: name === '.claude' ? 'default' : name.replace(/^\.claude-/, ''), ...(email && { email }) });
  }
  return out;
}

/**
 * Health of everything the pipeline needs. `settings`: { claudePath, nodePath }.
 * Returns { PATH, claude: { path, version, flags }, node, git, gh, checkedAt }.
 */
async function probe(settings = {}) {
  const PATH = await loginShellPath();
  const env = { ...process.env, PATH };
  delete env.ELECTRON_RUN_AS_NODE;

  const claudePath = settings.claudePath && settings.claudePath !== 'claude' ? expand(settings.claudePath) : which('claude', PATH);
  const claude = { path: claudePath, ok: false };
  if (claudePath && fs.existsSync(claudePath)) {
    const v = await run(claudePath, ['--version'], 15000, env);
    claude.version = v.stdout.trim().split('\n')[0] || undefined;
    const h = await run(claudePath, ['--help'], 15000, env);
    claude.flags = [...parseFlags(h.stdout + h.stderr)];
    claude.ok = v.code === 0;
    if (!claude.ok) claude.error = (v.stderr || v.stdout).trim().slice(0, 300) || `exit ${v.code}`;
  } else claude.error = claudePath ? `${claudePath} does not exist` : 'not found on PATH';

  const nodePath = settings.nodePath ? expand(settings.nodePath) : which('node', PATH);
  const node = { path: nodePath && fs.existsSync(nodePath) ? nodePath : null, ok: Boolean(nodePath && fs.existsSync(nodePath)) };

  const gitV = await exec('git', ['--version'], { env, timeoutMs: 8000 });
  const git = { ok: gitV.code === 0, version: gitV.stdout.trim().replace(/^git version /, '') };

  const ghPath = which('gh', PATH);
  const gh = { path: ghPath, ok: false };
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
function statuslineSnapshot(configDir) {
  const dir = path.join(configDir, 'statusline');
  let newest = null;
  let names = [];
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
    const s = JSON.parse(fs.readFileSync(path.join(dir, newest.name), 'utf8'));
    const lim = (l) => (l && l.used_percentage != null ? { pct: Math.round(Number(l.used_percentage)), resetsAt: l.resets_at } : undefined);
    const out = { fiveHour: lim(s.five_hour), sevenDay: lim(s.seven_day), at: (s.updated_at ? s.updated_at * 1000 : newest.mtimeMs), source: 'statusline', ...(s.model && { model: s.model }), ...(s.effort && { effort: s.effort }) };
    return out.fiveHour || out.sevenDay ? out : null;
  } catch {
    return null;
  }
}

module.exports = { loginShellPath, which, expand, claudeAccounts, probe, statuslineSnapshot };
