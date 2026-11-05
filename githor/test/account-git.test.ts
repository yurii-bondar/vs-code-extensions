import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountGit, AccountProblem } from '../src/account-git';
import type { AccountGitArgs } from '../src/account-git';
import { GitError } from '../src/core/git';
import type { GitRunner, RunOptions } from '../src/core/git';
import type { Fetch } from '../src/core/hosting';
import type { Account, AccountId, RepoRoot } from '../src/core/types';

const account = (label: string, o: Partial<Account> = {}): Account => ({ id: label.toLowerCase() as AccountId, label, provider: 'github', host: 'github.com', login: label.toLowerCase(), name: label, email: `${label.toLowerCase()}@example.com`, auth: { kind: 'token' }, ...o });

/** A store with these accounts and tokens; the repository chose `chosen`. */
function fakeStore(accounts: Account[], tokens: Record<string, string>, chosen: string | null): AccountGitArgs['store'] & { expiredIds: string[] } {
  const expiredIds: string[] = [];
  return {
    expiredIds,
    list: () => accounts,
    rules: () => [],
    repoChoice: () => chosen as AccountId | null,
    lastUsed: () => null,
    token: async (a: Account) => tokens[a.id] ?? null,
    setExpired: async (id: AccountId) => void expiredIds.push(id),
  } as unknown as AccountGitArgs['store'] & { expiredIds: string[] };
}

const model = { root: '/repo' as RepoRoot, remote: { name: 'origin', url: 'https://github.com/northwind/billing.git' } } as unknown as AccountGitArgs['model'];

/** A runner that records each call and fails with `failWith` on push. */
function fakeBase(failWith: string | null = null): GitRunner & { calls: { args: readonly string[]; env: RunOptions['env'] }[] } {
  const calls: { args: readonly string[]; env: RunOptions['env'] }[] = [];
  return {
    calls,
    async run(_cwd, args, options) {
      calls.push({ args, env: options?.env });
      if (failWith && args.includes('push')) throw new GitError({ args, stderr: failWith, stdout: '', exitCode: 128 });
      return '';
    },
  };
}

const noFetch: Fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

test('without an account, git runs as it is', async () => {
  const base = fakeBase();
  const git = accountGit({ base, store: fakeStore([], {}, null), model, fetch: noFetch });
  await git.run('/repo' as RepoRoot, ['push']);
  assert.deepEqual(base.calls, [{ args: ['push'], env: undefined }]);
});

test("every command carries the account's identity; only those that talk to the remote carry its sign-in", async () => {
  const base = fakeBase();
  const git = accountGit({ base, store: fakeStore([account('Work')], { work: 'tok' }, 'work'), model, fetch: noFetch });
  await git.run('/repo' as RepoRoot, ['commit', '-m', 'x']);
  await git.run('/repo' as RepoRoot, ['push', 'origin', 'main']);
  assert.deepEqual(base.calls[0]?.args, ['-c', 'user.name=Work', '-c', 'user.email=work@example.com', 'commit', '-m', 'x']);
  assert.deepEqual(base.calls[0]?.env, {});
  assert.equal(base.calls[1]?.env?.['GIT_CONFIG_KEY_1'], 'http.https://github.com/.extraHeader');
  // the header is in the environment, never in the arguments
  assert.ok(!base.calls[1]?.args.join(' ').includes('AUTHORIZATION'));
});

test('a 403 becomes an AccountProblem naming another account that can push there', async () => {
  const base = fakeBase("remote: Permission to northwind/billing.git denied to personal.\nfatal: unable to access '…': The requested URL returned error: 403");
  const fetch: Fetch = async (url, init) => ({ ok: true, status: 200, json: async () => ({ permissions: { push: url.includes('/repos/northwind/billing') && init.headers['Authorization'] === 'Bearer work-tok' } }) });
  const store = fakeStore([account('Personal'), account('Work')], { personal: 'p-tok', work: 'work-tok' }, 'personal');
  const git = accountGit({ base, store, model, fetch });
  await assert.rejects(git.run('/repo' as RepoRoot, ['push']), (e: unknown) => e instanceof AccountProblem && e.kind === 'forbidden' && e.account.label === 'Personal' && e.suggestion?.label === 'Work' && e.remote === 'github.com/northwind/billing');
});

test('a sign-in the remote refuses, or a missing token, marks the account expired', async () => {
  const store = fakeStore([account('Client')], { client: 'old' }, 'client');
  const refused = accountGit({ base: fakeBase("fatal: Authentication failed for 'https://github.com/x/y.git/'"), store, model, fetch: noFetch });
  await assert.rejects(refused.run('/repo' as RepoRoot, ['push']), (e: unknown) => e instanceof AccountProblem && e.kind === 'unauthorized');
  const gone = fakeStore([account('Client')], {}, 'client');
  const noToken = accountGit({ base: fakeBase(), store: gone, model, fetch: noFetch });
  await assert.rejects(noToken.run('/repo' as RepoRoot, ['fetch']), (e: unknown) => e instanceof AccountProblem && e.kind === 'unauthorized');
  assert.deepEqual([store.expiredIds, gone.expiredIds], [['client'], ['client']]);
});

test('a refusal that is not about the account is passed on as it is', async () => {
  const git = accountGit({ base: fakeBase('! [rejected] main -> main (non-fast-forward)'), store: fakeStore([account('Work')], { work: 't' }, 'work'), model, fetch: noFetch });
  await assert.rejects(git.run('/repo' as RepoRoot, ['push']), (e: unknown) => e instanceof GitError && !(e instanceof AccountProblem));
});

test('an account whose sign-in does not fit the address refuses to talk to the remote, rather than sign in as someone else', async () => {
  const base = fakeBase();
  const ssh = account('Work', { auth: { kind: 'ssh', keyPath: '/k' } });
  await assert.rejects(accountGit({ base, store: fakeStore([ssh], {}, 'work'), model, fetch: noFetch }).run('/repo' as RepoRoot, ['push']), /SSH key, and origin is an HTTPS address/);
  const sshModel = { root: '/repo' as RepoRoot, remote: { name: 'origin', url: 'git@github.com:northwind/billing.git' } } as unknown as AccountGitArgs['model'];
  await assert.rejects(accountGit({ base, store: fakeStore([account('Work')], { work: 't' }, 'work'), model: sshModel, fetch: noFetch }).run('/repo' as RepoRoot, ['fetch']), /token, and origin is an SSH address/);
  // nothing reached git; a commit is not about the address
  assert.equal(base.calls.length, 0);
  await accountGit({ base, store: fakeStore([ssh], {}, 'work'), model, fetch: noFetch }).run('/repo' as RepoRoot, ['commit', '-m', 'x']);
  assert.equal(base.calls.length, 1);
});
