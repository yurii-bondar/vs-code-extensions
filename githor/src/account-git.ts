import { classifyRefusal, identityArgs, parseRemote, pickAccount, remoteEnv } from './core/accounts';
import type { AccountPick, RemoteRefusal } from './core/accounts';
import { GitError } from './core/git';
import type { GitRunner } from './core/git';
import { canPush } from './core/hosting';
import type { Fetch } from './core/hosting';
import type { Account } from './core/types';
import type { AccountStore } from './account-store';
import type { RepoModel } from './model';

/** The remote refused the account (design `48`): which account, why, and another one that can push, if any. */
export class AccountProblem extends Error {
  constructor(
    readonly kind: RemoteRefusal,
    readonly account: Account,
    /** `github.com/northwind/billing`. */
    readonly remote: string,
    readonly suggestion: Account | null
  ) {
    super(kind === 'unauthorized' ? `${account.label} needs a new sign-in.` : `The remote rejected ${account.label}${suggestion ? `; ${suggestion.label} can push there` : ''}.`);
  }
}

/** Subcommands that talk to a remote, and so need the account's sign-in. */
const NETWORK = new Set(['fetch', 'pull', 'push', 'ls-remote']);

/** The git subcommand of an argument list: the first word that is not an option or a `-c` value. */
function subcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++;
    else if (!args[i]?.startsWith('-')) return args[i];
  }
  return undefined;
}

export interface AccountGitArgs {
  base: GitRunner;
  store: AccountStore;
  model: RepoModel;
  fetch: Fetch;
}

/** The account the shown repository uses now, and why. */
export function activePick({ store, model }: Pick<AccountGitArgs, 'store' | 'model'>): AccountPick {
  const root = model.root;
  return pickAccount({ accounts: store.list(), rules: store.rules(), repoChoice: root ? store.repoChoice(root) : null, remote: model.remote ? parseRemote(model.remote.url) : null, lastUsed: store.lastUsed() });
}

/**
 * A git runner acting as the repository's account: its identity on every command (so commits, merges, stashes and
 * squashes carry it), and its sign-in on the commands that talk to the remote. Without an account it is the plain
 * runner. A refusal by the remote becomes an AccountProblem; a sign-in the remote no longer accepts is marked expired.
 */
export function accountGit({ base, store, model, fetch }: AccountGitArgs): GitRunner {
  return {
    async run(cwd, args, options) {
      const { account } = activePick({ store, model });
      if (!account) return base.run(cwd, args, options);
      const remote = model.remote ? parseRemote(model.remote.url) : null;
      const network = NETWORK.has(subcommand(args) ?? '');
      let env: Record<string, string> = {};
      if (network && remote) {
        const token = account.auth.kind === 'ssh' ? null : await store.token(account);
        if (account.auth.kind !== 'ssh' && token === null && remote.https && remote.host === account.host) {
          await store.setExpired(account.id, true);
          throw new AccountProblem('unauthorized', account, `${remote.host}/${remote.path}`, null);
        }
        env = remoteEnv({ account, remote, token });
      }
      try {
        return await base.run(cwd, [...identityArgs(account), ...args], { env: { ...env, ...options?.env } });
      } catch (e) {
        const kind = network && remote && e instanceof GitError ? classifyRefusal(e.message) : null;
        if (!kind || !remote) throw e;
        if (kind === 'unauthorized') {
          await store.setExpired(account.id, true);
          throw new AccountProblem(kind, account, `${remote.host}/${remote.path}`, null);
        }
        // another account on the same host that can push there, asked only now that this one was refused
        let suggestion: Account | null = null;
        for (const other of store.list()) {
          if (other.id === account.id || other.host !== remote.host || other.auth.kind === 'ssh') continue;
          const token = await store.token(other);
          if (token && (await canPush({ fetch, provider: other.provider, remote, token }))) {
            suggestion = other;
            break;
          }
        }
        throw new AccountProblem(kind, account, `${remote.host}/${remote.path}`, suggestion);
      }
    },
  };
}
