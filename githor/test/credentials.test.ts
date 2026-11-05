// The account's sign-in against real git and a local HTTP server: the header reaches the host, and when the host
// refuses it nothing else answers for the account. The helper and askpass here are fakes in a temp dir that only
// record being called; the user's keychain and git config are never reached (test/repo.ts isolates them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { classifyRefusal, parseRemote, remoteEnv } from '../src/core/accounts';
import { GitError } from '../src/core/git';
import type { Account, AccountId, RepoRoot } from '../src/core/types';
import { git } from './repo';

const account: Account = { id: 'work' as AccountId, label: 'Work', provider: 'github', host: 'github.com', login: 'work', name: 'Work', email: 'work@example.com', auth: { kind: 'token' } };

/** A host that answers every request with `status`, and the Authorization headers it was sent. */
async function host(status: 401 | 403): Promise<{ url: string; auth: string[]; close: () => Promise<void> }> {
  const auth: string[] = [];
  const server = http.createServer((req, res) => {
    auth.push(req.headers.authorization ?? '');
    res.writeHead(status, status === 401 ? { 'WWW-Authenticate': 'Basic realm="test"' } : {});
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, auth, close: () => new Promise((done) => server.close(() => done())) };
}

/** A repository whose config has a credential helper (for every URL and for this host), and an askpass, all fakes. */
async function setup(hostUrl: string): Promise<{ dir: string; root: RepoRoot; calls: () => Promise<string>; askpass: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'githor-cred-')));
  const log = path.join(dir, 'calls.log');
  const fake = (name: string, answer: string): string => `#!/bin/sh\necho "${name} $1" >> '${log}'\n${answer}\n`;
  await fs.writeFile(path.join(dir, 'helper.sh'), fake('helper', '[ "$1" = get ] && echo username=other && echo password=OTHER-ACCOUNT'), { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'askpass.sh'), fake('askpass', 'echo OTHER-ACCOUNT'), { mode: 0o755 });
  const root = path.join(dir, 'repo') as RepoRoot;
  await git.run(dir as RepoRoot, ['init', '-q', root]);
  await git.run(root, ['config', '--add', 'credential.helper', path.join(dir, 'helper.sh')]);
  await git.run(root, ['config', '--add', `credential.${hostUrl}.helper`, path.join(dir, 'helper.sh')]);
  return { dir, root, askpass: path.join(dir, 'askpass.sh'), calls: () => fs.readFile(log, 'utf8').catch(() => '') };
}

/** The account's environment for a github.com remote, pointed at the local host instead. */
function envFor(hostUrl: string): Record<string, string> {
  const remote = parseRemote('https://github.com/northwind/billing.git');
  assert.ok(remote);
  const env = remoteEnv({ account, remote, token: 'tok' });
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace('https://github.com', hostUrl)]));
}

async function refusal(run: Promise<string>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (e instanceof GitError) return e.message;
    throw e;
  }
  assert.fail('git should have failed');
}

test('without the account, a 401 makes git ask the helpers and askpass (what the account has to stop)', async () => {
  const server = await host(401);
  const s = await setup(server.url);
  try {
    await refusal(git.run(s.root, ['ls-remote', `${server.url}/northwind/billing.git`], { env: { GIT_ASKPASS: s.askpass } }));
    assert.match(await s.calls(), /helper get/);
  } finally {
    await server.close();
    await fs.rm(s.dir, { recursive: true, force: true });
  }
});

test("a 401 to the account's header ends there: no helper or askpass answers, and git reports it as unauthorized", async () => {
  const server = await host(401);
  const s = await setup(server.url);
  try {
    const message = await refusal(git.run(s.root, ['ls-remote', `${server.url}/northwind/billing.git`], { env: { GIT_ASKPASS: s.askpass, ...envFor(server.url) } }));
    assert.equal(await s.calls(), '');
    assert.equal(classifyRefusal(message), 'unauthorized');
    assert.ok(server.auth.length > 0 && server.auth.every((a) => a === `basic ${Buffer.from('x-access-token:tok').toString('base64')}`), server.auth.join());
  } finally {
    await server.close();
    await fs.rm(s.dir, { recursive: true, force: true });
  }
});

test("a 403 to the account's header is a refusal of the account, with no other sign-in tried", async () => {
  const server = await host(403);
  const s = await setup(server.url);
  try {
    const message = await refusal(git.run(s.root, ['ls-remote', `${server.url}/northwind/billing.git`], { env: { GIT_ASKPASS: s.askpass, ...envFor(server.url) } }));
    assert.equal(await s.calls(), '');
    assert.equal(classifyRefusal(message), 'forbidden');
  } finally {
    await server.close();
    await fs.rm(s.dir, { recursive: true, force: true });
  }
});
