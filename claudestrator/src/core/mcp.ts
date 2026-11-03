// MCP servers as Claude Code sees them: what is configured (from its config files, names only), the health
// check (`claude mcp list`) and details (`claude mcp get`, secrets masked). Signing in runs in a terminal.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exists } from './files';
import { exec } from './git';
import { readJsonFresh } from './env';
import type { McpServer } from './wire';

/** `~/.claude.json` as far as this module reads it. */
interface ClaudeJson {
  mcpServers?: Record<string, { type?: string; url?: string } | undefined>;
  projects?: Record<string, { disabledMcpServers?: string[]; mcpServers?: ClaudeJson['mcpServers'] } | undefined>;
  disabledMcpjsonServers?: string[];
}

/** One of Claude Code's config files, parsed once per change (`readJsonFresh`). */
const readJson = async (file: string): Promise<ClaudeJson | null> => {
  const value = await readJsonFresh(file);
  return typeof value === 'object' && value !== null ? (value as ClaudeJson) : null;
};

/**
 * Server names Claude Code would talk to, from its config files. Reads keys and transports only: configs carry secrets.
 * `configDir` is CLAUDE_CONFIG_DIR as the CLI gets it; without one Claude Code keeps its config in ~/.claude.json
 * (not ~/.claude/.claude.json, which may be a stale copy).
 */
async function configuredMcpServers(workspace: string, configDir?: string | null): Promise<McpServer[]> {
  const dir = configDir;
  const global = (await readJson(dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json'))) || {};
  const project = (global.projects && global.projects[workspace]) || {};
  const disabled = new Set(Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : []);
  const local = (await readJson(path.join(workspace, '.claude', 'settings.local.json'))) || {};
  const disabledJson = new Set(Array.isArray(local.disabledMcpjsonServers) ? local.disabledMcpjsonServers : []);
  const out: McpServer[] = [];
  const add = (servers: ClaudeJson['mcpServers'], scope: string, isDisabled: (name: string) => boolean): void => {
    if (!servers || typeof servers !== 'object') return;
    for (const [name, cfg] of Object.entries(servers)) {
      const transport = (cfg && (cfg.type || (cfg.url ? 'http' : 'stdio'))) || 'stdio';
      out.push({ name, scope, state: 'installed', transport, ...(isDisabled(name) && { disabled: true }) });
    }
  };
  add(global.mcpServers, 'user', (n) => disabled.has(n));
  add(project.mcpServers, 'local', (n) => disabled.has(n));
  add(((await readJson(path.join(workspace, '.mcp.json'))) || ({} as ClaudeJson)).mcpServers, 'project', (n) => disabledJson.has(n) || disabled.has(n));
  return out;
}

/** Parses `claude mcp list`: `<name>: <target> [(TRANSPORT)] - <mark> <status>` per line. */
function parseMcpList(text: string): McpServer[] {
  const servers: McpServer[] = [];
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
      transport = t[1]!.toLowerCase();
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
function mergeMcp(configured: McpServer[], checked: McpServer[], checkOk = false): McpServer[] {
  const byName = new Map(configured.map((s) => [s.name, s] as const));
  const merged = checked.map((c) => {
    const conf = byName.get(c.name);
    byName.delete(c.name);
    return conf ? { ...c, scope: conf.scope, ...(conf.disabled && { disabled: true, state: 'installed' }) } : c;
  });
  const rest = [...byName.values()].map((s) => (checkOk && !s.disabled ? { ...s, missing: true, detail: 'Claude Code does not load it for this account' } : s));
  return [...merged, ...rest];
}

/** Runs Claude Code's own health check. Takes a few seconds: each server is contacted. */
async function checkMcpServers({ command, workspace, configDir, env }: { command: string; workspace: string; configDir?: string | null | undefined; env?: NodeJS.ProcessEnv | undefined }): Promise<{ servers: McpServer[]; checkedAt: string; error?: string }> {
  const configured = await configuredMcpServers(workspace, configDir);
  const r = await exec(command, ['mcp', 'list'], { cwd: workspace, timeoutMs: 90000, env });
  const checked = parseMcpList(r.stdout);
  return {
    servers: mergeMcp(configured, checked, r.code === 0),
    checkedAt: new Date().toISOString(),
    ...(r.code !== 0 && !checked.length && { error: (r.stderr || r.stdout).trim().slice(0, 500) || `claude mcp list exited ${r.code}` }),
  };
}

const SECRETISH = /(token|secret|key|password|authorization|bearer|cookie)/i;

const MASK = '••••';

/** Secrets inside a line that is not itself a secret's: an argument, a variable, a URL, a token by its known prefix. */
function maskInline(line: string): string {
  return (
    line
      .replace(/(Bearer\s+)\S+/gi, `$1${MASK}`)
      // --api-key glsa_…, --token=…
      .replace(/(--?[\w-]*(?:token|secret|key|password|passwd|auth)[\w-]*)(=|\s+)(?!-)(\S+)/gi, `$1$2${MASK}`)
      // DATABASE_PASSWORD=…, X_API_KEY=… in a list of variables
      .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD)[A-Za-z0-9_]*)=([^\s&]+)/gi, `$1=${MASK}`)
      // postgres://admin:hunter2@db, https://user:pat@host, redis://:hunter2@cache
      .replace(/(\w+:\/\/[^\s/:@]*):[^\s/@]+@/g, `$1:${MASK}@`)
      // ?access_token=…, &key=…, &sig=…
      .replace(/([?&](?:access_token|token|api_?key|key|secret|password|sig|signature|auth|code)=)[^&\s]+/gi, `$1${MASK}`)
      // ghp_…, github_pat_…, glsa_…, sk-…, xoxb-…: tokens whatever they stand next to
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glsa_\w{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[\w-]{10,})/g, MASK)
  );
}

/** `claude mcp get` can print env vars, headers, arguments and URLs: keep the names, mask the values. */
function redactMcpDetails(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*[^:=\s][^:=]*?)\s*([:=])\s*(.+)$/);
      if (!m || !SECRETISH.test(m[1]!)) return maskInline(line);
      return `${m[1]}${m[2]} ${MASK}`;
    })
    .join('\n');
}

/** Names come from config files; only a sane name goes on a command line (as its own argv entry, never a shell). */
const isMcpName = (name: string): boolean => /^[A-Za-z0-9 _.:@-]{1,100}$/.test(name);

/** HTTP, SSE and claude.ai connectors sign in with OAuth; stdio servers do not. */
const canLogin = (s: McpServer): boolean => !s.missing && (s.scope === 'claude.ai' || ['http', 'sse', 'ws'].includes(s.transport as string));


/**
 * The account's user-scope MCP servers as an `--mcp-config` file, for agents that run without the `user` setting
 * source (which would also bring personal plugins and hooks). Written 0600: server configs can carry tokens.
 * Returns the file, or null when the account has none.
 */
async function writeUserMcpConfig(file: string, configDir?: string | null): Promise<string | null> {
  // `.claude.json` holds the account's history too and grows to megabytes: read it again only when it changed.
  const source = configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  const sig = await fs.promises.stat(source).then((st) => `${source}:${st.size}:${st.mtimeMs}`, () => `${source}:none`);
  const hit = mcpConfigs.get(file);
  if (hit && hit.sig === sig && (hit.result === null || (await exists(file)))) return hit.result;
  let servers: Record<string, unknown> = {};
  try {
    const global = JSON.parse(await fs.promises.readFile(source, 'utf8')) as ClaudeJson;
    if (global.mcpServers && typeof global.mcpServers === 'object') servers = global.mcpServers;
  } catch {
    // no account file, or one being rewritten: no servers this time
  }
  let result: string | null = null;
  if (Object.keys(servers).length) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    await fs.promises.chmod(file, 0o600);
    result = file;
  }
  mcpConfigs.set(file, { sig, result });
  return result;
}

/** The last `--mcp-config` written per file: what its account file looked like then, and the result. */
const mcpConfigs = new Map<string, { sig: string; result: string | null }>();

export type { McpServer };
export { writeUserMcpConfig, configuredMcpServers, parseMcpList, mergeMcp, checkMcpServers, redactMcpDetails, isMcpName, canLogin };
