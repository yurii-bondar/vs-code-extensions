import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { parseRemote, remoteKey } from './core/accounts';
import { whoAmI } from './core/hosting';
import type { Account, AccountId, Provider } from './core/types';
import { AccountProblem, activePick } from './account-git';
import { providerId } from './account-store';
import type { AccountStore } from './account-store';
import type { RepoModel } from './model';
import type { AccountsView, NewAccount } from './protocol';

const WHY = { repo: 'chosen for this repository', rule: 'picked by rule', last: 'last used', none: '' } as const;

/** What the Manage accounts page shows (design `46`). */
export async function accountsView({ store, model }: { store: AccountStore; model: RepoModel }): Promise<AccountsView> {
  const pick = activePick({ store, model });
  const expired = store.expired();
  const remote = model.remote ? parseRemote(model.remote.url) : null;
  const read = (key: string): Promise<string> => (model.root ? model.git.run(model.root, ['config', '--get', key]).then((s) => s.trim(), () => '') : Promise.resolve(''));
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  return {
    accounts: store.list().map((a) => ({ ...a, expired: expired.has(a.id), usedHere: pick.account?.id === a.id })),
    rules: store.rules(),
    repo: model.root
      ? { name: path.basename(model.root), remoteName: model.remote?.name ?? null, remote: remote ? remoteKey(remote) : null, picked: pick.account?.id ?? null, why: WHY[pick.why], choice: store.repoChoice(model.root) }
      : null,
    defaults: { name, email },
  };
}

/** The current account in the status bar, on the right (design `45`, `06`); a click opens the account menu. */
export class AccountStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('githor.account', vscode.StatusBarAlignment.Right, 100);
  private readonly listeners: vscode.Disposable[];

  constructor(
    private readonly store: AccountStore,
    private readonly model: RepoModel
  ) {
    this.item.name = 'Githor Account';
    this.item.command = 'githor.pickAccount';
    this.listeners = [store.onDidChange(() => this.update()), model.onDidChange(() => this.update())];
    this.update();
  }

  private update(): void {
    const { account, why } = activePick({ store: this.store, model: this.model });
    if (!this.model.root || !account) {
      this.item.hide();
      return;
    }
    const expired = this.store.expired().has(account.id);
    this.item.text = `${expired ? '$(warning)' : '$(account)'} ${account.label}`;
    this.item.tooltip = `Committing and pushing as ${account.label} (${account.email}), ${WHY[why]}.${expired ? '\nIts sign-in expired: pull and push stop until you sign in again.' : ''}\nClick to switch accounts.`;
    this.item.show();
  }

  dispose(): void {
    for (const l of this.listeners) l.dispose();
    this.item.dispose();
  }
}

/** Switches the repository to `id` (null: back to the rules); returns what to say and how to put it back (design `48`, After switching). */
export async function useAccount({ store, model, id }: { store: AccountStore; model: RepoModel; id: AccountId | null }): Promise<{ text: string; undo: () => Promise<string> }> {
  const root = model.root;
  if (!root) throw new Error('Open a folder that is a git repository.');
  const before = store.repoChoice(root);
  await store.setRepoChoice(root, id);
  const now = activePick({ store, model }).account;
  const text = now ? `Now committing and pushing as ${now.label}` : 'Now picking the account by the rules';
  const undo = async (): Promise<string> => {
    await store.setRepoChoice(root, before);
    const back = activePick({ store, model }).account;
    return back ? `Back to ${back.label}` : 'Back to the rules';
  };
  return { text, undo };
}

/** The account menu (design `45`): "Commit and push as", then Add account and Manage accounts. */
export async function accountMenu({ store, model }: { store: AccountStore; model: RepoModel }): Promise<'add' | 'manage' | null> {
  const current = activePick({ store, model }).account;
  const expired = store.expired();
  type Item = vscode.QuickPickItem & { id?: AccountId; action?: 'add' | 'manage' };
  const items: Item[] = [
    ...store.list().map((a): Item => ({ label: `${a.id === current?.id ? '$(check) ' : ''}${a.label}`, description: a.email, detail: `${a.host}/${a.login}${expired.has(a.id) ? ' · sign-in expired' : ''}`, id: a.id })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Add account…', action: 'add' },
    { label: '$(gear) Manage accounts…', action: 'manage' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'Commit and push as', placeHolder: current ? `Now ${current.label}` : 'No account yet' });
  if (!picked) return null;
  if (picked.action) return picked.action;
  if (picked.id && picked.id !== current?.id) {
    const { text, undo } = await useAccount({ store, model, id: picked.id });
    void vscode.window.showInformationMessage(`Githor: ${text}`, 'Undo').then((pick) => pick && undo());
  }
  return null;
}

const ACCESS_TOKEN = { github: 'https://github.com/settings/tokens', gitlab: '/-/user_settings/personal_access_tokens', other: '' } as const;

/** Asks for a token in VS Code's own box, hidden as it is typed: it never passes through the page. */
async function askToken(label: string, provider: Provider, host: string): Promise<string | null> {
  const where = provider === 'gitlab' ? `https://${host}${ACCESS_TOKEN.gitlab}` : provider === 'github' ? ACCESS_TOKEN.github : '';
  const token = await vscode.window.showInputBox({ title: `Access token for ${label}`, prompt: `A token with push access${where ? `, made at ${where}` : ''}. It is kept in VS Code's secret storage.`, password: true, ignoreFocusOut: true });
  return token?.trim() || null;
}

/**
 * Signs an account in (design `47`): through VS Code's GitHub sign-in (an account already signed in to VS Code, or
 * another one), a token checked with the host, or an SSH key. Returns the account saved, or null when cancelled.
 */
export async function addAccount({ store, input }: { store: AccountStore; input: NewAccount }): Promise<Account | null> {
  const id = crypto.randomUUID() as AccountId;
  const base = { id, provider: input.provider, host: input.host.trim().toLowerCase() || 'github.com', name: input.name.trim(), email: input.email.trim() };
  if (input.method === 'browser') {
    const providerKey = providerId(base);
    const known = await vscode.authentication.getAccounts(providerKey);
    const taken = new Set(store.list().flatMap((a) => (a.auth.kind === 'browser' ? [a.auth.sessionAccount] : [])));
    type Item = vscode.QuickPickItem & { account?: vscode.AuthenticationSessionAccountInformation };
    const items: Item[] = [...known.filter((a) => !taken.has(a.id)).map((a): Item => ({ label: a.label, description: 'signed in to VS Code', account: a })), { label: '$(sign-in) Sign in with another account…' }];
    const picked = known.some((a) => !taken.has(a.id)) ? await vscode.window.showQuickPick(items, { title: 'Which GitHub account?' }) : items[items.length - 1];
    if (!picked) return null;
    const session = picked.account
      ? await vscode.authentication.getSession(providerKey, ['repo'], { account: picked.account, createIfNone: true })
      : await vscode.authentication.getSession(providerKey, ['repo'], { forceNewSession: { detail: 'Githor commits and pushes as this account.' }, clearSessionPreference: true });
    const account: Account = { ...base, label: input.label.trim() || session.account.label, login: session.account.label, auth: { kind: 'browser', sessionAccount: session.account.id } };
    await store.save(account, null);
    return account;
  }
  if (input.method === 'token') {
    const token = await askToken(input.label || base.host, base.provider, base.host);
    if (!token) return null;
    const login = await whoAmI({ fetch, provider: base.provider, host: base.host, token });
    if (login === null && base.provider !== 'other') throw new Error(`${base.host} did not accept this token.`);
    const account: Account = { ...base, label: input.label.trim() || login || base.host, login: login ?? input.label.trim(), auth: { kind: 'token' } };
    await store.save(account, token);
    return account;
  }
  const keys = await vscode.window.showOpenDialog({ title: 'SSH key for this account', defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')), canSelectMany: false, openLabel: 'Use this key' });
  const keyPath = keys?.[0]?.fsPath;
  if (!keyPath) return null;
  const account: Account = { ...base, label: input.label.trim() || path.basename(keyPath), login: input.label.trim() || path.basename(keyPath), auth: { kind: 'ssh', keyPath } };
  await store.save(account, null);
  return account;
}

/** Sign in again (design `48`, Sign-in expired): a new session or token for the same account. */
export async function signInAgain({ store, id }: { store: AccountStore; id: AccountId }): Promise<boolean> {
  const account = store.list().find((a) => a.id === id);
  if (!account) return false;
  if (account.auth.kind === 'browser') {
    await vscode.authentication.getSession(providerId(account), ['repo'], { account: { id: account.auth.sessionAccount, label: account.login }, createIfNone: true });
    await store.setExpired(id, false);
    return true;
  }
  if (account.auth.kind === 'token') {
    const token = await askToken(account.label, account.provider, account.host);
    if (!token) return false;
    await store.save(account, token);
    return true;
  }
  await store.setExpired(id, false);
  return true;
}

/**
 * An account problem outside the page (design `48`, as a notification): the status bar's push or pull, a fetch
 * command. Offers what the page's dialog offers; `retry` runs what was refused again, `addAccount` opens Add account.
 */
export async function explainProblem({ problem, store, model, retry, addAccount }: {
  problem: AccountProblem;
  store: AccountStore;
  model: RepoModel;
  retry: () => Promise<void>;
  addAccount: () => void;
}): Promise<void> {
  const { account, suggestion } = problem;
  const remoteName = model.remote?.name ?? 'The remote';
  if (problem.kind === 'unauthorized') {
    const pick = await vscode.window.showWarningMessage(`Githor: ${account.label} needs a new sign-in. Pull and push for this repo stop until you sign in.`, 'Sign in again', 'Later');
    if (pick === 'Sign in again' && (await signInAgain({ store, id: account.id }))) await retry();
    return;
  }
  const why = problem.kind === 'forbidden' ? 'no write access' : 'this account cannot see the repository';
  if (suggestion) {
    const action = `Switch to ${suggestion.label} and retry`;
    const pick = await vscode.window.showWarningMessage(`Githor: ${remoteName} rejected ${account.label} (${why}). ${suggestion.label} can push to ${problem.remote}.`, action, 'Cancel');
    if (pick !== action) return;
    const { text, undo } = await useAccount({ store, model, id: suggestion.id });
    void vscode.window.showInformationMessage(`Githor: ${text}`, 'Undo').then((p) => p && undo());
    await retry();
    return;
  }
  const pick = await vscode.window.showWarningMessage(`Githor: ${remoteName} rejected ${account.label} (${why}). None of your other accounts can push to ${problem.remote}.`, 'Add account…', 'Cancel');
  if (pick === 'Add account…') addAccount();
}
