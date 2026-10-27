const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = os.homedir();
const DEFAULT_DIR = path.join(HOME, '.claude');
const ENV_KEY = 'CLAUDE_CONFIG_DIR';
const PLATFORM_KEY = { darwin: 'osx', win32: 'windows' }[process.platform] || 'linux';

const expand = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, HOME));
const config = () => vscode.workspace.getConfiguration('ctxMan');

function defaultLabel(dir) {
  const base = path.basename(dir);
  if (dir === DEFAULT_DIR) return 'default';
  return base.replace(/^\.claude-?/, '') || base;
}

// The logged-in account is cached in .claude.json inside the config folder
// (for the default folder it may live at ~/.claude.json instead).
function readProfile(dir) {
  const files = [path.join(dir, '.claude.json')];
  if (dir === DEFAULT_DIR) files.push(path.join(HOME, '.claude.json'));
  for (const file of files) {
    try {
      const account = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount;
      if (account) return { email: account.emailAddress, org: account.organizationName };
    } catch {
      // missing or unreadable, try the next one
    }
  }
  return {};
}

const looksLikeConfigDir = (dir) => ['projects', '.claude.json', 'settings.json'].some((f) => fs.existsSync(path.join(dir, f)));

function discover() {
  const found = new Map();
  if (config().get('autoDiscover')) {
    let names = [];
    try {
      names = fs.readdirSync(HOME);
    } catch {
      // home not readable; rely on configured accounts
    }
    for (const name of names) {
      if (name !== '.claude' && !name.startsWith('.claude-')) continue;
      const dir = path.join(HOME, name);
      try {
        if (fs.statSync(dir).isDirectory() && looksLikeConfigDir(dir)) found.set(dir, defaultLabel(dir));
      } catch {
        // broken symlink etc.
      }
    }
  }
  for (const a of config().get('accounts') || []) {
    if (!a || !a.configDir) continue;
    const dir = expand(a.configDir);
    found.set(dir, a.label || defaultLabel(dir));
  }
  return [...found]
    .map(([dir, label]) => ({ dir, label, ...readProfile(dir) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// macOS keeps each config folder's login in its own Keychain item:
// "Claude Code-credentials-<first 8 hex of sha256(config dir)>". Only the item's existence is checked.
const keychainService = (dir) => `Claude Code-credentials-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;

function keychainHas(service) {
  return new Promise((resolve) => execFile('security', ['find-generic-password', '-s', service], (err) => resolve(!err)));
}

async function isLoggedIn(dir) {
  if (process.platform === 'darwin') {
    if (await keychainHas(keychainService(dir))) return true;
    return dir === DEFAULT_DIR ? keychainHas('Claude Code-credentials') : false;
  }
  return fs.existsSync(path.join(dir, '.credentials.json'));
}

class AccountStore {
  constructor(context) {
    this.context = context;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
    this.loginCache = new Map();
    this.reload();
  }

  // `all` keeps hidden accounts so the active one is still recognized when hidden.
  reload() {
    this.all = discover();
    this.accounts = this.all.filter((a) => !this.isHidden(a));
    this.emitter.fire();
  }

  isHidden(account) {
    return (config().get('hiddenAccounts') || []).some((h) => h && (h === account.label || expand(h) === account.dir));
  }

  async setHidden(account, hidden) {
    const list = (config().inspect('hiddenAccounts').globalValue || []).filter((h) => h !== account.label && expand(h) !== account.dir);
    if (hidden) list.push(account.label);
    await config().update('hiddenAccounts', list.length ? list : undefined, vscode.ConfigurationTarget.Global);
  }

  async loginState(account) {
    if (!this.loginCache.has(account.dir)) this.loginCache.set(account.dir, await isLoggedIn(account.dir));
    return this.loginCache.get(account.dir);
  }

  refreshLogins() {
    this.loginCache.clear();
  }

  byDir(dir) {
    return this.all.find((a) => a.dir === dir);
  }

  // First run: pick up whatever CLAUDE_CONFIG_DIR is already configured.
  get active() {
    const stored = this.context.globalState.get('ctxMan.activeDir');
    const cfg = vscode.workspace.getConfiguration();
    const fromExtension = (cfg.get('claudeCode.environmentVariables') || []).find((e) => e && e.name === ENV_KEY);
    const fromTerminal = (cfg.get(`terminal.integrated.env.${PLATFORM_KEY}`) || {})[ENV_KEY];
    const candidates = [stored, fromExtension && fromExtension.value, fromTerminal, process.env[ENV_KEY], DEFAULT_DIR];
    for (const c of candidates) {
      const account = c && this.byDir(expand(c));
      if (account) return account;
    }
    return this.accounts[0] || this.all[0];
  }

  async activate(account) {
    await this.context.globalState.update('ctxMan.activeDir', account.dir);
    const cfg = vscode.workspace.getConfiguration();
    const applied = [];
    if (config().get('syncTerminalEnv')) {
      const key = `terminal.integrated.env.${PLATFORM_KEY}`;
      const env = { ...(cfg.inspect(key).globalValue || {}), [ENV_KEY]: account.dir };
      await cfg.update(key, env, vscode.ConfigurationTarget.Global);
      applied.push('terminals');
    }
    if (config().get('syncClaudeExtension') && cfg.inspect('claudeCode.environmentVariables')) {
      try {
        const list = (cfg.inspect('claudeCode.environmentVariables').globalValue || []).filter((e) => e && e.name !== ENV_KEY);
        list.push({ name: ENV_KEY, value: account.dir });
        await cfg.update('claudeCode.environmentVariables', list, vscode.ConfigurationTarget.Global);
        applied.push('extension');
      } catch {
        // Claude Code extension not installed
      }
    }
    this.emitter.fire();
    return applied;
  }
}

module.exports = { AccountStore, ENV_KEY, expand };
