// MCP servers as Claude Code sees them: what is configured (from its config files, names only), the health
// check (`claude mcp list`), details (`claude mcp get`, secrets masked) and a fresh sign-in (`claude mcp login`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { exec } = require('./git');

/**
 * installed: configured, not checked yet (or disabled / awaiting approval) · connected: working ·
 * needs_auth: needs a (re)login · failed: cannot connect.
 */
const readJson = (file) => {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
};

/**
 * Server names Claude Code would talk to, from its config files. Reads keys and transports only: configs carry secrets.
 * `configDir` is CLAUDE_CONFIG_DIR as the CLI gets it; without one Claude Code keeps its config in ~/.claude.json
 * (not ~/.claude/.claude.json, which may be a stale copy).
 */
function configuredMcpServers(workspace, configDir) {
  const dir = configDir;
  const global = readJson(dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json')) || {};
  const project = (global.projects && global.projects[workspace]) || {};
  const disabled = new Set(Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : []);
  const local = readJson(path.join(workspace, '.claude', 'settings.local.json')) || {};
  const disabledJson = new Set(Array.isArray(local.disabledMcpjsonServers) ? local.disabledMcpjsonServers : []);
  const out = [];
  const add = (servers, scope, isDisabled) => {
    if (!servers || typeof servers !== 'object') return;
    for (const [name, cfg] of Object.entries(servers)) {
      const transport = (cfg && (cfg.type || (cfg.url ? 'http' : 'stdio'))) || 'stdio';
      out.push({ name, scope, state: 'installed', transport, ...(isDisabled(name) && { disabled: true }) });
    }
  };
  add(global.mcpServers, 'user', (n) => disabled.has(n));
  add(project.mcpServers, 'local', (n) => disabled.has(n));
  add((readJson(path.join(workspace, '.mcp.json')) || {}).mcpServers, 'project', (n) => disabledJson.has(n) || disabled.has(n));
  return out;
}

/** Parses `claude mcp list`: `<name>: <target> [(TRANSPORT)] - <mark> <status>` per line. */
function parseMcpList(text) {
  const servers = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /^Checking MCP|^No MCP servers/i.test(line)) continue;
    const colon = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (colon < 0 || dash < colon) continue;
    const name = line.slice(0, colon);
    let target = line.slice(colon + 2, dash).trim();
    const statusText = line.slice(dash + 3).trim();
    let transport = /^https?:/.test(target) ? 'http' : 'stdio';
    const t = target.match(/\s\((HTTP|SSE|WS|stdio)\)$/i);
    if (t) {
      transport = t[1].toLowerCase();
      target = target.slice(0, t.index);
    }
    const detail = statusText.replace(/^[✔✓✗✘×!⚠⏸]\s*/u, '');
    const state = /disabled|pending/i.test(statusText)
      ? 'installed'
      : /needs? auth|authenticat|re-?login|expired|unauthori[sz]ed|401/i.test(statusText) || /^[!⚠]/u.test(statusText)
        ? 'needs_auth'
        : /^[✗✘×]/u.test(statusText) || /fail|error|timed? ?out/i.test(statusText)
          ? 'failed'
          : /^[✔✓]/u.test(statusText) || /connected/i.test(statusText)
            ? 'connected'
            : 'installed';
    const scope = name.startsWith('claude.ai ') ? 'claude.ai' : name.startsWith('plugin:') ? 'plugin' : 'config';
    servers.push({ name, scope, state, detail, transport, target, ...(/disabled/i.test(statusText) && { disabled: true }), ...(/pending/i.test(statusText) && { pending: true }) });
  }
  return servers;
}

/**
 * What the health check reports, with the scope from the config files. After a successful check, a server that is
 * only in a file is one Claude Code does not load (another account, a stale file): it is marked `missing`.
 */
function mergeMcp(configured, checked, checkOk = false) {
  const byName = new Map(configured.map((s) => [s.name, s]));
  const merged = checked.map((c) => {
    const conf = byName.get(c.name);
    byName.delete(c.name);
    return conf ? { ...c, scope: conf.scope, ...(conf.disabled && { disabled: true, state: 'installed' }) } : c;
  });
  const rest = [...byName.values()].map((s) => (checkOk && !s.disabled ? { ...s, missing: true, detail: 'Claude Code does not load it for this account' } : s));
  return [...merged, ...rest];
}

/** Runs Claude Code's own health check. Takes a few seconds: each server is contacted. */
async function checkMcpServers({ command, workspace, configDir, env }) {
  const configured = configuredMcpServers(workspace, configDir);
  const r = await exec(command, ['mcp', 'list'], { cwd: workspace, timeoutMs: 90000, env });
  const checked = parseMcpList(r.stdout);
  return {
    servers: mergeMcp(configured, checked, r.code === 0),
    checkedAt: new Date().toISOString(),
    ...(r.code !== 0 && !checked.length && { error: (r.stderr || r.stdout).trim().slice(0, 500) || `claude mcp list exited ${r.code}` }),
  };
}

const SECRETISH = /(token|secret|key|password|authorization|bearer|cookie)/i;

/** `claude mcp get` can print env vars and headers: keep their names, mask their values. */
function redactMcpDetails(text) {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*[^:=\s][^:=]*?)\s*([:=])\s*(.+)$/);
      if (!m || !SECRETISH.test(m[1])) return line.replace(/(Bearer\s+)\S+/gi, '$1••••');
      return `${m[1]}${m[2]} ••••`;
    })
    .join('\n');
}

/** Names come from config files; only a sane name goes on a command line (as its own argv entry, never a shell). */
const isMcpName = (name) => /^[A-Za-z0-9 _.:@-]{1,100}$/.test(name);

/** HTTP, SSE and claude.ai connectors sign in with OAuth; stdio servers do not. */
const canLogin = (s) => !s.missing && (s.scope === 'claude.ai' || ['http', 'sse', 'ws'].includes(s.transport));

/** `claude mcp login <name>`: opens the provider's sign-in page; resolves with the exit code. */
function mcpLogin({ command, workspace, env, name, onLine, timeoutMs = 10 * 60000 }) {
  let proc;
  const done = new Promise((resolve) => {
    proc = spawn(command, ['mcp', 'login', name], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
    for (const stream of [proc.stdout, proc.stderr]) {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (l && onLine) onLine(l);
        }
      });
    }
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(127);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  return { done, cancel: () => proc && proc.kill('SIGTERM') };
}

/**
 * The account's user-scope MCP servers as an `--mcp-config` file, for agents that run without the `user` setting
 * source (which would also bring personal plugins and hooks). Written 0600: server configs can carry tokens.
 * Returns the file, or null when the account has none.
 */
function writeUserMcpConfig(file, configDir) {
  const global = readJson(configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json')) || {};
  const servers = global.mcpServers && typeof global.mcpServers === 'object' ? global.mcpServers : {};
  if (!Object.keys(servers).length) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

module.exports = { writeUserMcpConfig, configuredMcpServers, parseMcpList, mergeMcp, checkMcpServers, redactMcpDetails, isMcpName, canLogin, mcpLogin };
