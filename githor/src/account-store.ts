import * as vscode from 'vscode';
import type { Account, AccountAuth, AccountId, AccountRule, Provider, RepoRoot } from './core/types';

const ACCOUNTS = 'githor.accounts';
const EXPIRED = 'githor.accountsExpired';
const LAST = 'githor.accountLast';
const choiceKey = (root: RepoRoot): string => `githor.account:${root}`;
const tokenKey = (id: AccountId): string => `githor.token.${id}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const PROVIDERS: readonly Provider[] = ['github', 'gitlab', 'other'];

function authOf(v: unknown): AccountAuth | null {
  if (!isRecord(v)) return null;
  if (v['kind'] === 'browser' && str(v['sessionAccount'])) return { kind: 'browser', sessionAccount: v['sessionAccount'] };
  if (v['kind'] === 'token') return { kind: 'token' };
  if (v['kind'] === 'ssh' && str(v['keyPath'])) return { kind: 'ssh', keyPath: v['keyPath'] };
  return null;
}

/** An account as stored, narrowed once here; anything malformed is dropped. */
function accountOf(v: unknown): Account | null {
  if (!isRecord(v)) return null;
  const { id, label, provider, host, login, name, email } = v;
  const auth = authOf(v['auth']);
  if (!str(id) || !str(label) || !PROVIDERS.includes(provider as Provider) || !str(host) || !str(login) || !str(name) || !str(email) || !auth) return null;
  return { id: id as AccountId, label, provider: provider as Provider, host, login, name, email, auth };
}

/**
 * Where accounts live (design/accounts-spike.md): the list in global state, tokens in secret storage, rules in the
 * `githor.accounts.rules` setting, a repository's own choice in the workspace's state.
 */
export class AccountStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('githor.accounts')) this.changed.fire();
      }),
      context.secrets.onDidChange(() => this.changed.fire())
    );
  }

  list(): Account[] {
    const raw: unknown = this.context.globalState.get(ACCOUNTS);
    return (Array.isArray(raw) ? raw : []).map(accountOf).filter((a): a is Account => a !== null);
  }

  rules(): AccountRule[] {
    const raw: unknown = vscode.workspace.getConfiguration('githor').get('accounts.rules');
    return (Array.isArray(raw) ? raw : []).flatMap((r: unknown) => (isRecord(r) && str(r['remote']) && str(r['account']) ? [{ remote: r['remote'], account: r['account'] }] : []));
  }

  expired(): Set<AccountId> {
    const raw: unknown = this.context.globalState.get(EXPIRED);
    return new Set((Array.isArray(raw) ? raw : []).filter(str) as AccountId[]);
  }

  async setExpired(id: AccountId, expired: boolean): Promise<void> {
    const ids = this.expired();
    if (expired === ids.has(id)) return;
    if (expired) ids.add(id);
    else ids.delete(id);
    await this.context.globalState.update(EXPIRED, [...ids]);
    this.changed.fire();
  }

  repoChoice(root: RepoRoot): AccountId | null {
    const raw: unknown = this.context.workspaceState.get(choiceKey(root));
    return str(raw) ? (raw as AccountId) : null;
  }

  async setRepoChoice(root: RepoRoot, id: AccountId | null): Promise<void> {
    await this.context.workspaceState.update(choiceKey(root), id ?? undefined);
    if (id) await this.context.globalState.update(LAST, id);
    this.changed.fire();
  }

  lastUsed(): AccountId | null {
    const raw: unknown = this.context.globalState.get(LAST);
    return str(raw) ? (raw as AccountId) : null;
  }

  async save(account: Account, token: string | null): Promise<void> {
    const rest = this.list().filter((a) => a.id !== account.id);
    if (token !== null) await this.context.secrets.store(tokenKey(account.id), token);
    await this.context.globalState.update(ACCOUNTS, [...rest, account]);
    if (!this.lastUsed()) await this.context.globalState.update(LAST, account.id);
    await this.setExpired(account.id, false);
    this.changed.fire();
  }

  /** Removes the account and its token from this computer; repositories that chose it fall back to the rules. */
  async remove(id: AccountId): Promise<void> {
    await this.context.secrets.delete(tokenKey(id));
    await this.context.globalState.update(ACCOUNTS, this.list().filter((a) => a.id !== id));
    if (this.lastUsed() === id) await this.context.globalState.update(LAST, undefined);
    await this.setExpired(id, false);
    this.changed.fire();
  }

  /**
   * The account's token, without asking anything: the VS Code sign-in's session for a browser account, the stored one
   * for a token account, none for SSH. Null when there is none any more.
   */
  async token(account: Account): Promise<string | null> {
    switch (account.auth.kind) {
      case 'token':
        return (await this.context.secrets.get(tokenKey(account.id))) ?? null;
      case 'ssh':
        return null;
      case 'browser': {
        const session = await vscode.authentication
          .getSession(providerId(account), ['repo'], { account: { id: account.auth.sessionAccount, label: account.login }, silent: true })
          .then(
            (s) => s,
            () => undefined
          );
        return session?.accessToken ?? null;
      }
      default: {
        const unreachable: never = account.auth;
        return unreachable;
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** VS Code's sign-in provider for a browser account: GitHub, or GitHub Enterprise for another host. */
export const providerId = (account: Pick<Account, 'host'>): string => (account.host === 'github.com' ? 'github' : 'github-enterprise');
