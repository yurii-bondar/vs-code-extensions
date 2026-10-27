// The extension's service: one engine per workspace root, the environment it runs in, and change events
// for the tree, the status bar and the dashboard.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./core/engine');
const { ClaudeRunner } = require('./core/runner');
const { HookServer, writeHookSettings } = require('./core/hookserver');
const { setChildEnv, getChildEnv } = require('./core/git');
const { resolveDefaults } = require('./core/defaults');
const mcp = require('./core/mcp');
const { exec } = require('./core/git');
const { AtlassianClient } = require('./core/intake');
const os = require('os');
const { probe, expand, statuslineSnapshot, claudeAccounts } = require('./core/env');
const { projectConfigFile, loadConfig } = require('./core/config');

const SECRET_KEY = 'claudestrator.atlassianToken';
// What a current Claude Code accepts; used until the real `claude --help` has been read.
const DEFAULT_FLAGS = ['--include-partial-messages', '--tools', '--setting-sources', '--max-budget-usd', '--name', '--effort', '--mcp-config'];

const settings = () => vscode.workspace.getConfiguration('claudestrator');

function workspaceRoot() {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const configured = settings().get('workspaceFolder');
  if (configured) {
    const p = expand(configured);
    return path.isAbsolute(configured) || configured.startsWith('~') ? p : folders.length ? path.resolve(folders[0], configured) : p;
  }
  // Prefer a folder that already has a Claudestrator config.
  return folders.find((f) => fs.existsSync(projectConfigFile(f))) || folders[0] || null;
}

class Orchestrator {
  constructor(context) {
    this.context = context;
    this.hooks = new HookServer();
    this.health = null;
    this.engine = null;
    this.root = null;
    this.token = undefined;
    this.watchers = [];
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this._onDidChangeConfig = new vscode.EventEmitter();
    this.onDidChangeConfig = this._onDidChangeConfig.event;
    this._onEngine = new vscode.EventEmitter();
    /** Engine events, re-emitted with their name: `{ name, data }`. */
    this.onEngine = this._onEngine.event;
    this.mcp = { servers: [], checking: false, checkedAt: null, error: null };
    this.mcpLogins = new Map();
    /** Claude Code sign-in per account folder: `{ loggedIn, email, plan }`, from `claude auth status`. */
    this.auth = new Map();
    this.claudeLoginTerminal = null;
    this.hookSettingsFile = path.join(context.globalStorageUri.fsPath, 'hook-settings.json');
    this.hookScript = path.join(context.extensionPath, 'hook', 'pretooluse.js');
  }

  async init() {
    this.lastAccount = this.account().dir;
    // ctx-man switches the account by writing these settings; follow it unless an account is chosen here.
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!['claudestrator.claudeConfigDir', 'terminal.integrated.env', 'claudeCode.environmentVariables'].some((k) => e.affectsConfiguration(k))) return;
      const dir = this.account().dir;
      if (dir === this.lastAccount) return;
      this.lastAccount = dir;
      this.onAccountChanged();
    });
    await this.hooks.listen();
    this.token = await this.context.secrets.get(SECRET_KEY);
    this.writeHookSettings(null);
    this.ready = this.refreshHealth();
    this.rebuild();
  }

  writeHookSettings(nodePath) {
    writeHookSettings(this.hookSettingsFile, { node: nodePath, script: this.hookScript });
  }

  async refreshHealth() {
    const s = settings();
    try {
      this.health = await probe({ claudePath: s.get('claudePath'), nodePath: s.get('nodePath') });
      setChildEnv(this.health.env);
      this.writeHookSettings(this.health.node.path);
      this.refreshDefaults(true);
      this.refreshAuth();
      if (!this.mcp.checkedAt) this.refreshMcp();
    } catch (e) {
      this.health = { error: e.message, claude: { ok: false, error: e.message }, node: {}, git: {}, gh: {} };
    }
    this.fire();
    return this.health;
  }

  async ensureReady() {
    if (this.ready) await this.ready;
  }

  /** (Re)creates the engine for the current workspace root. Running tasks of the old one keep going. */
  rebuild() {
    const root = workspaceRoot();
    if (this.engine && root === this.root) return;
    this.root = root;
    this.disposeWatchers();
    if (!root) {
      this.engine = null;
      this.fire();
      return;
    }
    const runner = new ClaudeRunner({
      command: () => (this.health && this.health.claude && this.health.claude.path) || expand(settings().get('claudePath') || '') || 'claude',
      flags: () => new Set((this.health && this.health.claude && this.health.claude.flags) || DEFAULT_FLAGS),
      settingSources: () => settings().get('settingSources') || null,
      hookSettings: () => this.hookSettingsFile,
      mcpConfig: () => mcp.writeUserMcpConfig(path.join(this.context.globalStorageUri.fsPath, 'agent-mcp.json'), this.agentEnv().CLAUDE_CONFIG_DIR),
      env: () => {
        const dir = this.account().dir;
        return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
      },
    });
    this.engine = new Engine({
      workspace: root,
      runner,
      hooks: this.hooks,
      atlassian: () => this.atlassian(),
      mcpIntake: () => this.mcpIntakeServer(),
      askPermissions: () => settings().get('askPermissions') === true,
    });
    for (const name of ['changed', 'output', 'live', 'log', 'checkpoint', 'finished', 'permission', 'permissionDone', 'limits']) {
      this.engine.on(name, (data) => {
        this._onEngine.fire({ name, data });
        if (name === 'limits') this.context.globalState.update(this.limitsKey(), { ...data, source: 'agents' });
        if (['changed', 'live', 'permission', 'permissionDone', 'limits'].includes(name)) this.fire();
      });
    }
    this.watch(root);
    this.fire();
  }

  watch(root) {
    const base = vscode.Uri.file(root);
    let timer;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.fire(true), 300);
    };
    const tasks = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, '.orch/tasks/*/events.ndjson'));
    tasks.onDidChange(changed);
    tasks.onDidCreate(changed);
    tasks.onDidDelete(changed);
    let ctimer;
    const configChanged = () => {
      clearTimeout(ctimer);
      ctimer = setTimeout(() => {
        this._onDidChangeConfig.fire();
        this.refreshDefaults();
      }, 200);
    };
    const cfg = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, '.claudestrator/**'));
    cfg.onDidChange(configChanged);
    cfg.onDidCreate(configChanged);
    cfg.onDidDelete(configChanged);
    this.watchers.push(tasks, cfg);
  }

  disposeWatchers() {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
  }

  /** Coalesces bursts (streaming output, gate progress) into one UI refresh. */
  fire(external) {
    if (this.fireTimer) return;
    this.fireTimer = setTimeout(() => {
      this.fireTimer = null;
      this._onDidChange.fire({ external: Boolean(external) });
    }, 120);
  }

  /** The config folder of the agents' account (where its status-line snapshots live). */
  accountDir() {
    return this.account().shownDir;
  }

  limitsKey() {
    return `claudestrator.limits:${this.accountDir()}`;
  }

  /**
   * The account's 5-hour and weekly limits: whichever is newer of what agents last reported and the account's
   * newest status-line snapshot. A window whose reset time has passed is reported as fresh (0%).
   */
  limits() {
    const stored = this.context.globalState.get(this.limitsKey());
    const snap = statuslineSnapshot(this.accountDir());
    const best = [stored, snap].filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    if (!best) return null;
    const now = Date.now() / 1000;
    const fresh = (w) => (w && w.resetsAt && w.resetsAt < now ? { pct: 0, resetsAt: undefined, reset: true } : w);
    return { ...best, fiveHour: fresh(best.fiveHour), sevenDay: fresh(best.sevenDay) };
  }

  /**
   * What "default" model and effort really are for this account and settings, per model the agents use.
   * Asked from the CLI (no model request); refreshed when the account, settings sources or agents' models change.
   */
  async refreshDefaults(force) {
    if (!this.root || !this.health || !this.health.claude || !this.health.claude.ok) return this.defaults;
    const r = this.config();
    const aliases = ['inherit', ...(r.ok ? Object.values(r.config.agents).map((a) => a.model) : [])];
    const sources = settings().get('settingSources') || null;
    const dir = this.account().dir;
    const key = JSON.stringify([this.root, dir, sources, [...new Set(aliases)].sort()]);
    if (!force && key === this.defaultsKey) return this.defaults;
    this.defaultsKey = key;
    const env = this.agentEnv();
    const d = await resolveDefaults({ command: this.health.claude.path, cwd: this.root, env, settingSources: sources, aliases });
    if (d && key === this.defaultsKey) {
      this.defaults = d;
      this._onDidChangeConfig.fire();
      this.fire();
    }
    return this.defaults;
  }

  /**
   * The Claude Code account (config folder) the agents, MCP checks and limits use, and where that choice comes from:
   * this extension's setting, then the account ctx-man made active for VS Code terminals or the Claude Code
   * extension, then VS Code's own environment, else the default (~/.claude with ~/.claude.json).
   */
  account() {
    const platform = { darwin: 'osx', win32: 'windows' }[process.platform] || 'linux';
    const all = vscode.workspace.getConfiguration();
    const fromExtension = (all.get('claudeCode.environmentVariables') || []).find((e) => e && e.name === 'CLAUDE_CONFIG_DIR');
    const candidates = [
      ['setting', settings().get('claudeConfigDir'), 'chosen here'],
      ['terminals', (all.get(`terminal.integrated.env.${platform}`) || {}).CLAUDE_CONFIG_DIR, 'active for VS Code terminals (ctx-man)'],
      ['claude-code', fromExtension && fromExtension.value, 'set for the Claude Code extension'],
      ['environment', process.env.CLAUDE_CONFIG_DIR, 'VS Code was started with CLAUDE_CONFIG_DIR'],
    ];
    const hit = candidates.find(([, v]) => v);
    const dir = hit ? path.resolve(expand(hit[1])) : null;
    const home = path.join(os.homedir(), '.claude');
    const info = claudeAccounts().find((a) => a.dir === (dir || home)) || {};
    const auth = this.auth.get(dir || home);
    return {
      ...(auth && { loggedIn: auth.loggedIn, ...(auth.plan && { plan: auth.plan }) }),
      dir,
      shownDir: dir || home,
      label: info.label || (dir ? path.basename(dir).replace(/^\.claude-?/, '') || 'default' : 'default'),
      ...(info.email && { email: info.email }),
      source: hit ? hit[0] : 'default',
      sourceText: hit ? hit[2] : 'no account chosen: the default ~/.claude',
    };
  }

  /** Every Claude Code account on this machine, without the ones hidden in ctx-man. */
  accounts() {
    const hidden = vscode.workspace.getConfiguration('ctxMan').get('hiddenAccounts') || [];
    const current = this.account().shownDir;
    return claudeAccounts()
      .filter((a) => a.dir === current || !hidden.some((h) => h === a.label || path.resolve(expand(h)) === a.dir))
      .map((a) => {
        const auth = this.auth.get(a.dir);
        return { ...a, current: a.dir === current, ...(auth && { loggedIn: auth.loggedIn, ...(auth.email && { email: auth.email }) }) };
      });
  }

  /** `claude auth status` for every account (local, no request to a model). */
  async refreshAuth() {
    if (!this.health || !this.health.claude || !this.health.claude.ok) return;
    const home = path.join(os.homedir(), '.claude');
    const base = { ...getChildEnv() };
    delete base.ELECTRON_RUN_AS_NODE;
    await Promise.all(
      claudeAccounts().map(async (a) => {
        const env = { ...base };
        // The default account is the one without CLAUDE_CONFIG_DIR (its config is ~/.claude.json).
        if (a.dir === home) delete env.CLAUDE_CONFIG_DIR;
        else env.CLAUDE_CONFIG_DIR = a.dir;
        const r = await exec(this.claudeCommand(), ['auth', 'status', '--json'], { cwd: os.homedir(), env, timeoutMs: 20000 });
        try {
          const j = JSON.parse(r.stdout);
          this.auth.set(a.dir, { loggedIn: Boolean(j.loggedIn), ...(j.email && { email: j.email }), ...(j.subscriptionType && { plan: j.subscriptionType }) });
        } catch {
          // an older CLI without `auth status`: leave the state unknown
        }
      })
    );
    this.fire();
  }

  /** `claude auth login` for the agents' account, in a terminal (it opens the browser and may ask for a code). */
  claudeLogin() {
    if (this.claudeLoginTerminal && !this.claudeLoginTerminal.exitStatus) return this.claudeLoginTerminal.show();
    const dir = this.account().dir;
    const terminal = vscode.window.createTerminal({ name: `Claude sign-in · ${this.account().label}`, shellPath: this.claudeCommand(), shellArgs: ['auth', 'login'], cwd: os.homedir(), env: { PATH: getChildEnv().PATH, CLAUDE_CONFIG_DIR: dir || null }, iconPath: new vscode.ThemeIcon('account') });
    terminal.show();
    this.claudeLoginTerminal = terminal;
    let sub;
    const done = () => {
      clearInterval(poll);
      if (sub) sub.dispose();
      this.claudeLoginTerminal = null;
      this.refreshAuth().then(() => {
        const ok = this.account().loggedIn;
        this._onEngine.fire({ name: 'mcpLogin', data: { ok, kind: ok ? 'ok' : 'info', message: ok ? `Signed in to Claude as ${this.account().email || this.account().label}` : 'The Claude sign-in did not finish' } });
        if (ok) this.onAccountChanged();
      });
    };
    const poll = setInterval(() => terminal.exitStatus && done(), 1000);
    sub = vscode.window.onDidCloseTerminal((t) => t === terminal && done());
  }

  /** The configuration listener above picks the change up. */
  async setAccount(dir) {
    await settings().update('claudeConfigDir', dir || '', vscode.ConfigurationTarget.Global);
  }

  /** A new account means other MCP servers, limits and defaults. */
  onAccountChanged() {
    this.mcp = { servers: [], checking: false, checkedAt: null, error: null };
    this.refreshAuth();
    this.refreshDefaults(true);
    this.refreshMcp();
    this.fire();
  }

  /** The environment Claude Code runs in for the agents: login-shell PATH and their account. */
  agentEnv() {
    const dir = this.account().dir;
    const env = { ...getChildEnv() };
    if (dir) env.CLAUDE_CONFIG_DIR = dir;
    else delete env.CLAUDE_CONFIG_DIR;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLAUDECODE;
    return env;
  }

  claudeCommand() {
    return (this.health && this.health.claude && this.health.claude.path) || expand(settings().get('claudePath') || '') || 'claude';
  }

  // ---------- MCP ----------

  /** Starts a health check unless one runs; the configured list shows at once, states arrive after a few seconds. */
  refreshMcp() {
    if (!this.root || this.mcp.checking) return;
    // Exactly the CLAUDE_CONFIG_DIR the CLI gets (none means ~/.claude.json), so the list matches `claude mcp list`.
    const configDir = this.agentEnv().CLAUDE_CONFIG_DIR;
    const servers = this.mcp.servers.length ? this.mcp.servers : mcp.configuredMcpServers(this.root, configDir);
    this.mcp = { ...this.mcp, servers, checking: true };
    this.fire();
    mcp
      .checkMcpServers({ command: this.claudeCommand(), workspace: this.root, configDir, env: this.agentEnv() })
      .then((r) => (this.mcp = { ...r, checking: false, error: r.error || null }))
      .catch((e) => (this.mcp = { servers, checking: false, checkedAt: new Date().toISOString(), error: e.message }))
      .finally(() => this.fire());
  }

  /** A connected (or, before the first check, configured) Atlassian MCP server the intake can read Jira with. */
  mcpIntakeServer() {
    const isAtlassian = (x) => /atlassian|jira|confluence/i.test(`${x.name} ${x.target || ''}`) && !x.missing && !x.disabled;
    const list = this.mcp.servers.length ? this.mcp.servers : this.root ? mcp.configuredMcpServers(this.root, this.agentEnv().CLAUDE_CONFIG_DIR) : [];
    const hit = list.find((x) => isAtlassian(x) && x.state === 'connected') || (!this.mcp.checkedAt && list.find(isAtlassian));
    return hit ? { server: hit.name, site: settings().get('atlassian.site') || undefined } : null;
  }

  mcpState() {
    return {
      ...this.mcp,
      servers: this.mcp.servers.map((s) => ({ ...s, canLogin: mcp.canLogin(s), login: this.mcpLogins.has(s.name) ? { since: this.mcpLogins.get(s.name).since } : null })),
    };
  }

  /**
   * `claude mcp login <name>` in an integrated terminal: it needs a real terminal (it may ask you to paste the
   * redirect URL), and you see what it does. When it exits or you close it, the list is checked again.
   */
  mcpLogin(name) {
    if (!mcp.isMcpName(name)) throw new Error('not an MCP server name');
    const open = this.mcpLogins.get(name);
    if (open) {
      open.terminal.show();
      return;
    }
    const dir = this.account().dir;
    const terminal = vscode.window.createTerminal({
      name: `MCP sign-in · ${name}`,
      shellPath: this.claudeCommand(),
      shellArgs: ['mcp', 'login', name],
      cwd: this.root,
      env: { PATH: getChildEnv().PATH, CLAUDE_CONFIG_DIR: dir || null },
      iconPath: new vscode.ThemeIcon('key'),
    });
    terminal.show();
    const entry = { since: Date.now(), terminal, lines: [] };
    this.mcpLogins.set(name, entry);
    this.fire();
    let sub;
    const finish = (code) => {
      if (this.mcpLogins.get(name) !== entry) return;
      clearInterval(poll);
      if (sub) sub.dispose();
      this.mcpLogins.delete(name);
      const message = code === 0 ? `${name}: signed in` : code === undefined ? `${name}: sign-in terminal closed; checking the server again` : `${name}: sign-in did not finish (exit ${code}); see the terminal`;
      this._onEngine.fire({ name: 'mcpLogin', data: { server: name, ok: code === 0, kind: code === 0 ? 'ok' : code === undefined ? 'info' : 'error', message } });
      this.refreshMcp();
    };
    // exitStatus is set when the process ends, even while the terminal stays open.
    const poll = setInterval(() => terminal.exitStatus && finish(terminal.exitStatus.code), 1000);
    sub = vscode.window.onDidCloseTerminal((t) => t === terminal && finish(t.exitStatus ? t.exitStatus.code : undefined));
  }

  mcpShowLogin(name) {
    const entry = this.mcpLogins.get(name);
    if (entry) entry.terminal.show();
  }

  mcpCancelLogin(name) {
    const entry = this.mcpLogins.get(name);
    if (entry) entry.terminal.dispose();
  }

  async mcpDetails(name) {
    if (!mcp.isMcpName(name)) throw new Error('not an MCP server name');
    const r = await exec(this.claudeCommand(), ['mcp', 'get', name], { cwd: this.root, timeoutMs: 60000, env: this.agentEnv() });
    return mcp.redactMcpDetails((r.stdout || r.stderr).trim());
  }

  atlassianAuth() {
    const s = settings();
    const site = s.get('atlassian.site') || process.env.ATLASSIAN_SITE;
    const email = s.get('atlassian.email') || process.env.ATLASSIAN_EMAIL;
    const token = this.token || process.env.ATLASSIAN_API_TOKEN;
    return site && email && token ? { site, email, token } : null;
  }

  atlassian() {
    const auth = this.atlassianAuth();
    return auth ? new AtlassianClient(auth) : null;
  }

  async saveAtlassian({ site, email, token }) {
    const s = settings();
    await s.update('atlassian.site', site || '', vscode.ConfigurationTarget.Global);
    await s.update('atlassian.email', email || '', vscode.ConfigurationTarget.Global);
    if (token !== undefined) {
      if (token) await this.context.secrets.store(SECRET_KEY, token);
      else await this.context.secrets.delete(SECRET_KEY);
      this.token = token || undefined;
    }
  }

  /** The resolved config, or `{ ok: false, errors }`; never throws. */
  config() {
    if (!this.root) return { ok: false, errors: [{ message: 'Open a folder first' }], warnings: [] };
    return loadConfig({ workspace: this.root });
  }

  hasProjectConfig() {
    return Boolean(this.root && fs.existsSync(projectConfigFile(this.root)));
  }

  /** Every task as a list entry, guarded against a task folder vanishing mid-read. */
  list() {
    if (!this.engine) return [];
    try {
      return this.engine.svc.list();
    } catch {
      return [];
    }
  }

  dispose() {
    if (this.configSub) this.configSub.dispose();
    this.disposeWatchers();
    this.hooks.dispose();
    this._onDidChange.dispose();
    this._onDidChangeConfig.dispose();
    this._onEngine.dispose();
  }
}

module.exports = { Orchestrator, workspaceRoot, settings };
