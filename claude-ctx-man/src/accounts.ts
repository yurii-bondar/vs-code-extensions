import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_DIR, ENV_KEY, HOME, defaultLabel, expand, isLoggedIn, looksLikeConfigDir, readProfile } from './configdir';
import { isRecord } from './json';
import type { Account, ConfigDir } from './types';

const PLATFORM_KEY = ({ darwin: 'osx', win32: 'windows' } as Record<string, string>)[process.platform] ?? 'linux';

const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('ctxMan');

/** The `ctxMan.accounts` setting: only entries that name a folder are kept. */
export function configuredAccounts(): { label: string; configDir: string }[] {
  const raw = config().get<unknown>('accounts');
  const out: { label: string; configDir: string }[] = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    if (isRecord(a) && typeof a['configDir'] === 'string' && a['configDir']) out.push({ label: typeof a['label'] === 'string' ? a['label'] : '', configDir: a['configDir'] });
  }
  return out;
}

const hiddenSetting = (): string[] => {
  const raw = config().get<unknown>('hiddenAccounts');
  return (Array.isArray(raw) ? raw : []).filter((h): h is string => typeof h === 'string' && !!h);
};

function discover(): Account[] {
  const found = new Map<ConfigDir, string>();
  if (config().get<boolean>('autoDiscover')) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(HOME);
    } catch {
      // home not readable; rely on configured accounts
    }
    for (const name of names) {
      if (name !== '.claude' && !name.startsWith('.claude-')) continue;
      const dir = path.join(HOME, name) as ConfigDir;
      try {
        if (fs.statSync(dir).isDirectory() && looksLikeConfigDir(dir)) found.set(dir, defaultLabel(dir));
      } catch {
        // broken symlink etc.
      }
    }
  }
  for (const a of configuredAccounts()) {
    const dir = expand(a.configDir);
    found.set(dir, a.label || defaultLabel(dir));
  }
  return [...found].map(([dir, label]): Account => ({ dir, label, ...readProfile(dir) })).sort((a, b) => a.label.localeCompare(b.label));
}

/** `CLAUDE_CONFIG_DIR` as the Claude Code extension has it in `claudeCode.environmentVariables`. */
function extensionEnvDir(cfg: vscode.WorkspaceConfiguration): string | undefined {
  const list = cfg.get<unknown>('claudeCode.environmentVariables');
  const hit = (Array.isArray(list) ? list : []).find((e) => isRecord(e) && e['name'] === ENV_KEY);
  return isRecord(hit) && typeof hit['value'] === 'string' ? hit['value'] : undefined;
}

function terminalEnvDir(cfg: vscode.WorkspaceConfiguration): string | undefined {
  const env = cfg.get<unknown>(`terminal.integrated.env.${PLATFORM_KEY}`);
  const value = isRecord(env) ? env[ENV_KEY] : undefined;
  return typeof value === 'string' ? value : undefined;
}

export class AccountStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly loginCache = new Map<ConfigDir, boolean>();
  /** Every account found, hidden ones too, so the active one is still recognized when hidden. */
  all: Account[] = [];
  accounts: Account[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.reload();
  }

  reload(): void {
    this.all = discover();
    this.accounts = this.all.filter((a) => !this.isHidden(a));
    this.emitter.fire();
  }

  isHidden(account: Account): boolean {
    return hiddenSetting().some((h) => h === account.label || expand(h) === account.dir);
  }

  async setHidden(account: Account, hidden: boolean): Promise<void> {
    const kept = (config().inspect<string[]>('hiddenAccounts')?.globalValue ?? []).filter((h) => h !== account.label && expand(h) !== account.dir);
    if (hidden) kept.push(account.label);
    await config().update('hiddenAccounts', kept.length ? kept : undefined, vscode.ConfigurationTarget.Global);
  }

  async loginState(account: Account): Promise<boolean> {
    const cached = this.loginCache.get(account.dir);
    if (cached !== undefined) return cached;
    const state = await isLoggedIn(account.dir);
    this.loginCache.set(account.dir, state);
    return state;
  }

  refreshLogins(): void {
    this.loginCache.clear();
  }

  byDir(dir: string): Account | undefined {
    return this.all.find((a) => a.dir === dir);
  }

  /** The stored choice, else whatever `CLAUDE_CONFIG_DIR` is already configured to. */
  get active(): Account | undefined {
    const cfg = vscode.workspace.getConfiguration();
    const candidates = [this.context.globalState.get<string>('ctxMan.activeDir'), extensionEnvDir(cfg), terminalEnvDir(cfg), process.env[ENV_KEY], DEFAULT_DIR];
    for (const c of candidates) {
      const account = c ? this.byDir(expand(c)) : undefined;
      if (account) return account;
    }
    return this.accounts[0] ?? this.all[0];
  }

  /** Makes the account the active one; returns where it now applies: `terminals` and/or `extension`. */
  async activate(account: Account): Promise<('terminals' | 'extension')[]> {
    await this.context.globalState.update('ctxMan.activeDir', account.dir);
    const cfg = vscode.workspace.getConfiguration();
    const applied: ('terminals' | 'extension')[] = [];
    if (config().get<boolean>('syncTerminalEnv')) {
      const key = `terminal.integrated.env.${PLATFORM_KEY}`;
      const current = cfg.inspect<Record<string, string>>(key)?.globalValue ?? {};
      await cfg.update(key, { ...current, [ENV_KEY]: account.dir }, vscode.ConfigurationTarget.Global);
      applied.push('terminals');
    }
    const extensionKey = 'claudeCode.environmentVariables';
    const inspected = cfg.inspect<{ name?: string; value?: string }[]>(extensionKey);
    if (config().get<boolean>('syncClaudeExtension') && inspected) {
      try {
        const list = (inspected.globalValue ?? []).filter((e) => e && e.name !== ENV_KEY);
        list.push({ name: ENV_KEY, value: account.dir });
        await cfg.update(extensionKey, list, vscode.ConfigurationTarget.Global);
        applied.push('extension');
      } catch {
        // Claude Code extension not installed
      }
    }
    this.emitter.fire();
    return applied;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
