import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { isRecord, readJson } from './json';
import type { ConfigDir } from './types';

export const HOME = os.homedir();
export const DEFAULT_DIR = path.join(HOME, '.claude') as ConfigDir;
export const ENV_KEY = 'CLAUDE_CONFIG_DIR';

export const expand = (p: string): ConfigDir => path.resolve(String(p).replace(/^~(?=$|[\\/])/, HOME)) as ConfigDir;

export function defaultLabel(dir: string): string {
  const base = path.basename(dir);
  if (dir === DEFAULT_DIR) return 'default';
  return base.replace(/^\.claude-?/, '') || base;
}

/** The logged-in account is cached in `.claude.json` inside the config folder (for the default folder it may live at `~/.claude.json`). */
export function readProfile(dir: string, home = HOME): { email: string; org: string } {
  const files = [path.join(dir, '.claude.json')];
  if (dir === path.join(home, '.claude')) files.push(path.join(home, '.claude.json'));
  for (const file of files) {
    const json = readJson(file);
    const account = isRecord(json) ? json['oauthAccount'] : undefined;
    if (isRecord(account)) {
      return {
        email: typeof account['emailAddress'] === 'string' ? account['emailAddress'] : '',
        org: typeof account['organizationName'] === 'string' ? account['organizationName'] : '',
      };
    }
  }
  return { email: '', org: '' };
}

export const looksLikeConfigDir = (dir: string): boolean => ['projects', '.claude.json', 'settings.json'].some((f) => fs.existsSync(path.join(dir, f)));

/** macOS keeps each config folder's login in its own Keychain item; only the item's existence is ever checked. */
export const keychainService = (dir: string): string => `Claude Code-credentials-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;

const keychainHas = (service: string): Promise<boolean> => new Promise((resolve) => execFile('security', ['find-generic-password', '-s', service], (err) => resolve(!err)));

export async function isLoggedIn(dir: ConfigDir): Promise<boolean> {
  if (process.platform === 'darwin') {
    if (await keychainHas(keychainService(dir))) return true;
    return dir === DEFAULT_DIR ? keychainHas('Claude Code-credentials') : false;
  }
  return fs.existsSync(path.join(dir, '.credentials.json'));
}
