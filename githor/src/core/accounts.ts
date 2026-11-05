// Accounts (design `45`–`48`): which account a repository uses, and what git is given to act as it. Pure: tested
// without git or VS Code. See design/accounts-spike.md for why a header through the environment.
import type { Account, AccountId, AccountRule } from './types';

/** A remote URL taken apart: `git@github.com:acme/shop.git` → github.com, acme/shop, over SSH. */
export interface RemoteInfo {
  host: string;
  /** `acme/shop`, without `.git`. */
  path: string;
  https: boolean;
}

export function parseRemote(url: string): RemoteInfo | null {
  const clean = (p: string): string => p.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const web = /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url);
  if (web?.[1] && web[2]) return { host: web[1].toLowerCase(), path: clean(web[2]), https: true };
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url);
  if (ssh?.[1] && ssh[2]) return { host: ssh[1].toLowerCase(), path: clean(ssh[2]), https: false };
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(url);
  if (scp?.[1] && scp[2]) return { host: scp[1].toLowerCase(), path: clean(scp[2]), https: false };
  return null;
}

/** `host/path`, what rules are matched against. */
export const remoteKey = (r: RemoteInfo): string => `${r.host}/${r.path}`;

/**
 * Whether a rule's pattern matches a remote. `*` alone matches everything; a trailing `/*` matches everything under
 * that path, however deep; any other `*` stands for part of one path segment.
 */
export function ruleMatches(pattern: string, remote: RemoteInfo): boolean {
  const p = pattern.trim().toLowerCase().replace(/^https?:\/\//, '');
  if (p === '*') return true;
  const escape = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  const re = p.endsWith('/*') ? new RegExp(`^${escape(p.slice(0, -2))}(/.*)?$`) : new RegExp(`^${escape(p)}$`);
  return re.test(remoteKey(remote).toLowerCase());
}

export type PickReason = 'repo' | 'rule' | 'last' | 'none';

export interface AccountPick {
  account: Account | null;
  why: PickReason;
  /** The rule that picked it, when one did. */
  rule: AccountRule | null;
}

/**
 * The account a repository uses: the repository's own choice, else the first rule matching its remote, else the
 * account last used. None when there is no account at all.
 */
export function pickAccount({ accounts, rules, repoChoice, remote, lastUsed }: { accounts: readonly Account[]; rules: readonly AccountRule[]; repoChoice: AccountId | null; remote: RemoteInfo | null; lastUsed: AccountId | null }): AccountPick {
  const byId = (id: AccountId | null): Account | undefined => accounts.find((a) => a.id === id);
  const chosen = byId(repoChoice);
  if (chosen) return { account: chosen, why: 'repo', rule: null };
  for (const rule of remote ? rules : []) {
    if (!remote || !ruleMatches(rule.remote, remote)) continue;
    const account = accounts.find((a) => a.label === rule.account);
    if (account) return { account, why: 'rule', rule };
  }
  const last = byId(lastUsed) ?? accounts[0];
  return last ? { account: last, why: 'last', rule: null } : { account: null, why: 'none', rule: null };
}

/** The account the rules alone would pick, to warn when a commit goes out as another one (design `48`). */
export function ruleAccount({ accounts, rules, remote }: { accounts: readonly Account[]; rules: readonly AccountRule[]; remote: RemoteInfo | null }): { account: Account; rule: AccountRule } | null {
  for (const rule of remote ? rules : []) {
    if (!remote || !ruleMatches(rule.remote, remote)) continue;
    const account = accounts.find((a) => a.label === rule.account);
    if (account) return { account, rule };
  }
  return null;
}

/** Config entries as environment for one git process: `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`. */
export function configEnv(entries: readonly (readonly [string, string])[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The user name a host expects beside a token in HTTP basic auth. */
const tokenUser = (provider: Account['provider']): string => (provider === 'gitlab' ? 'oauth2' : 'x-access-token');

/**
 * What git needs to talk to `remote` as `account`: over HTTPS the token as an Authorization header for that host only,
 * over SSH the account's key. Empty when the account brings nothing for this remote (another host, no token).
 *
 * Over HTTPS nothing else may answer for the account: when the host refuses the header (401), git asks the credential
 * helpers and askpass, and the keychain or `gh auth git-credential` would push as whoever they hold. An empty
 * `credential.helper`, set last, clears the helpers of every file and URL scope; an empty `GIT_ASKPASS` turns off
 * askpass (VS Code's own included), so git fails as unauthorized instead.
 */
export function remoteEnv({ account, remote, token }: { account: Account; remote: RemoteInfo; token: string | null }): Record<string, string> {
  if (remote.host !== account.host) return {};
  if (remote.https) {
    if (!token) return {};
    const basic = Buffer.from(`${tokenUser(account.provider)}:${token}`).toString('base64');
    return {
      ...configEnv([
        ['credential.helper', ''],
        [`http.https://${remote.host}/.extraHeader`, `AUTHORIZATION: basic ${basic}`],
      ]),
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
    };
  }
  if (account.auth.kind === 'ssh') return configEnv([['core.sshCommand', `ssh -i '${account.auth.keyPath.replace(/'/g, "'\\''")}' -o IdentitiesOnly=yes`]]);
  return {};
}

/** The identity of the account's commits, for the commands that make one. */
export const identityArgs = (account: Account): string[] => ['-c', `user.name=${account.name}`, '-c', `user.email=${account.email}`];

export type RemoteRefusal = 'forbidden' | 'unauthorized' | 'notFound';

/** Why the remote refused, from git's message: no write access, a sign-in it does not accept, or no such repository. */
export function classifyRefusal(message: string): RemoteRefusal | null {
  if (/error: 403|Permission to .* denied to|HTTP 403|403 Forbidden|You are not allowed to push/i.test(message)) return 'forbidden';
  if (/error: 401|Authentication failed|Invalid username or (password|token)|HTTP Basic: Access denied|could not read Username|terminal prompts disabled/i.test(message)) return 'unauthorized';
  if (/Repository not found|repository .* not found|does not appear to be a git repository|The project you were looking for could not be found/i.test(message)) return 'notFound';
  return null;
}
