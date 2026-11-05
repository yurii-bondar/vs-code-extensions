import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRefusal, identityArgs, parseRemote, pickAccount, remoteEnv, ruleAccount, ruleMatches } from '../src/core/accounts';
import { canPush, whoAmI } from '../src/core/hosting';
import type { Fetch } from '../src/core/hosting';
import type { Account, AccountId } from '../src/core/types';
import { git } from './repo';
import type { RepoRoot } from '../src/core/types';

const account = (label: string, o: Partial<Account> = {}): Account => ({ id: label.toLowerCase() as AccountId, label, provider: 'github', host: 'github.com', login: label.toLowerCase(), name: `${label} Name`, email: `${label.toLowerCase()}@example.com`, auth: { kind: 'browser', sessionAccount: label }, ...o });
const personal = account('Personal');
const work = account('Work', { auth: { kind: 'ssh', keyPath: "/Users/a/.ssh/id_north'wind" } });
const client = account('Client', { provider: 'gitlab', host: 'gitlab.acme-client.example', auth: { kind: 'token' } });
const accounts = [personal, work, client];
const rules = [
  { remote: 'github.com/northwind/*', account: 'Work' },
  { remote: 'gitlab.acme-client.example/*', account: 'Client' },
  { remote: '*', account: 'Personal' },
];

test('parseRemote reads HTTPS, ssh:// and scp-like remotes', () => {
  assert.deepEqual(parseRemote('https://github.com/alex-moroz/vs-code-extensions.git'), { host: 'github.com', path: 'alex-moroz/vs-code-extensions', https: true });
  assert.deepEqual(parseRemote('https://user@GitLab.acme-client.example:8443/group/sub/app'), { host: 'gitlab.acme-client.example', path: 'group/sub/app', https: true });
  assert.deepEqual(parseRemote('git@github.com:northwind/billing.git'), { host: 'github.com', path: 'northwind/billing', https: false });
  assert.deepEqual(parseRemote('ssh://git@github.com:22/northwind/billing.git'), { host: 'github.com', path: 'northwind/billing', https: false });
  assert.equal(parseRemote('/local/path/repo.git'), null);
});

test('rules match by host and path; a trailing /* covers everything under it', () => {
  const r = (u: string): NonNullable<ReturnType<typeof parseRemote>> => parseRemote(u) as NonNullable<ReturnType<typeof parseRemote>>;
  assert.equal(ruleMatches('github.com/northwind/*', r('git@github.com:northwind/billing.git')), true);
  assert.equal(ruleMatches('github.com/northwind/*', r('git@github.com:northwindy/billing.git')), false);
  assert.equal(ruleMatches('gitlab.acme-client.example/*', r('https://gitlab.acme-client.example/group/sub/app')), true);
  assert.equal(ruleMatches('github.com/*/billing', r('https://github.com/northwind/billing')), true);
  assert.equal(ruleMatches('*', r('https://example.org/a/b')), true);
});

test('pickAccount: the repository choice, then the first matching rule, then the last used', () => {
  const remote = parseRemote('git@github.com:northwind/billing.git');
  assert.deepEqual(pickAccount({ accounts, rules, repoChoice: 'client' as AccountId, remote, lastUsed: null }).account?.label, 'Client');
  const byRule = pickAccount({ accounts, rules, repoChoice: null, remote, lastUsed: null });
  assert.deepEqual([byRule.account?.label, byRule.why, byRule.rule?.remote], ['Work', 'rule', 'github.com/northwind/*']);
  assert.deepEqual(pickAccount({ accounts, rules: [], repoChoice: null, remote, lastUsed: 'client' as AccountId }).account?.label, 'Client');
  assert.deepEqual(pickAccount({ accounts: [], rules, repoChoice: null, remote, lastUsed: null }), { account: null, why: 'none', rule: null });
  assert.equal(ruleAccount({ accounts, rules, remote })?.account.label, 'Work');
});

test('remoteEnv gives git a header for the token account over HTTPS, the key over SSH, and nothing for another host', () => {
  const https = parseRemote('https://gitlab.acme-client.example/group/app.git');
  assert.ok(https);
  const env = remoteEnv({ account: client, remote: https, token: 'tok' });
  assert.equal(env['GIT_CONFIG_KEY_0'], 'http.https://gitlab.acme-client.example/.extraHeader');
  assert.equal(env['GIT_CONFIG_VALUE_0'], `AUTHORIZATION: basic ${Buffer.from('oauth2:tok').toString('base64')}`);
  const ssh = parseRemote('git@github.com:northwind/billing.git');
  assert.ok(ssh);
  assert.deepEqual(remoteEnv({ account: work, remote: ssh, token: null }), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand', GIT_CONFIG_VALUE_0: "ssh -i '/Users/a/.ssh/id_north'\\''wind' -o IdentitiesOnly=yes" });
  assert.deepEqual(remoteEnv({ account: client, remote: ssh, token: 'tok' }), {});
  assert.deepEqual(identityArgs(personal), ['-c', 'user.name=Personal Name', '-c', 'user.email=personal@example.com']);
});

test('the header reaches git, for its host only', async () => {
  const remote = parseRemote('https://github.com/alex-moroz/x.git');
  assert.ok(remote);
  const env = remoteEnv({ account: personal, remote, token: 'fake' });
  const root = process.cwd() as RepoRoot;
  const header = (url: string): Promise<string> => git.run(root, ['config', '--get-urlmatch', 'http.extraHeader', url], { env }).then((s) => s.trim(), () => '');
  assert.match(await header('https://github.com/alex-moroz/x.git'), /^AUTHORIZATION: basic /);
  assert.equal(await header('https://gitlab.com/other/x.git'), '');
});

test('classifyRefusal tells no access from a refused sign-in and a missing repository', () => {
  assert.equal(classifyRefusal("remote: Permission to northwind/billing.git denied to alex-moroz.\nfatal: unable to access 'https://github.com/northwind/billing.git/': The requested URL returned error: 403"), 'forbidden');
  assert.equal(classifyRefusal("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x/y.git/'"), 'unauthorized');
  assert.equal(classifyRefusal('ERROR: Repository not found.\nfatal: Could not read from remote repository.'), 'notFound');
  assert.equal(classifyRefusal('! [rejected] main -> main (non-fast-forward)'), null);
});

test('whoAmI and canPush ask the host with the token, and read its answer', async () => {
  const seen: string[] = [];
  const fetch: Fetch = async (url, init) => {
    seen.push(`${url} ${init.headers['Authorization']}`);
    if (url.endsWith('/user')) return { ok: true, status: 200, json: async () => ({ login: 'alex-moroz' }) };
    if (url.includes('/repos/northwind/billing')) return { ok: true, status: 200, json: async () => ({ permissions: { push: true } }) };
    if (url.includes('/projects/')) return { ok: true, status: 200, json: async () => ({ permissions: { project_access: null, group_access: { access_level: 20 } } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  assert.equal(await whoAmI({ fetch, provider: 'github', host: 'github.com', token: 't1' }), 'alex-moroz');
  assert.equal(await canPush({ fetch, provider: 'github', remote: { host: 'github.com', path: 'northwind/billing', https: true }, token: 't1' }), true);
  assert.equal(await canPush({ fetch, provider: 'github', remote: { host: 'github.com', path: 'northwind/secret', https: true }, token: 't1' }), false);
  assert.equal(await canPush({ fetch, provider: 'gitlab', remote: { host: 'gitlab.acme-client.example', path: 'group/app', https: true }, token: 't2' }), false);
  assert.equal(await canPush({ fetch, provider: 'other', remote: { host: 'example.org', path: 'a/b', https: true }, token: 't3' }), null);
  assert.deepEqual(seen.slice(0, 2), ['https://api.github.com/user Bearer t1', 'https://api.github.com/repos/northwind/billing Bearer t1']);
  assert.ok(seen.some((s) => s.startsWith('https://gitlab.acme-client.example/api/v4/projects/group%2Fapp ')));
});
