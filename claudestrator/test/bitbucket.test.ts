// Bitbucket Cloud's pull requests over its REST API, and what stops a publish without a token.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BitbucketClient } from '../src/core/bitbucket';
import { changeRequests, issueLine, parseRemote, type Run } from '../src/core/forge';

const AUTH = { email: 'dev@acme.com', token: 'bb-secret-token-123456' };

/** A fetch that answers in order, and records what was asked: method, address, Authorization and the JSON body. */
function scripted(steps: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: { method: string; url: string; auth: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ method: String(init.method), url, auth: headers.Authorization ?? '', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const step = steps.shift();
    if (!step) throw new Error('no more answers');
    return new Response(step.status === 204 ? null : JSON.stringify(step.body ?? {}), { status: step.status, headers: step.headers ?? {} });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const noCli: Run = async () => ({ code: 1, stdout: '', stderr: 'no CLI here' });
const remote = parseRemote('git@bitbucket.org:acme/api.git');
const page = (id: number) => ({ links: { html: { href: `https://bitbucket.org/acme/api/pull-requests/${id}` } } });

test('bitbucket: bitbucket.org is Bitbucket Cloud; a Data Center host is not', () => {
  assert.deepEqual(remote, { forge: 'bitbucket', host: 'bitbucket.org', project: 'acme/api' });
  assert.deepEqual(parseRemote('https://dev@bitbucket.org/acme/api.git'), { forge: 'bitbucket', host: 'bitbucket.org', project: 'acme/api' });
  assert.equal(parseRemote('ssh://git@bitbucket.acme.com:7999/proj/api.git'), null, 'another API than Cloud');
  assert.equal(issueLine({ kind: 'github', host: 'github.com', repo: 'acme/api', number: 1 }, remote, 1), undefined);
});

test('bitbucket: finds an open PR, opens a draft, sets its description, lists those of a key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bb-'));
  const body = path.join(dir, 'api.md');
  fs.writeFileSync(body, '## What\n\nCap bets');
  const api = scripted([
    { status: 200, body: { values: [] } },
    { status: 201, body: { id: 7, ...page(7) } },
    { status: 200, body: { id: 7, title: 'feat: cap bets (CP-1)' } },
    { status: 200, body: { id: 7 } },
    { status: 200, body: { values: [{ id: 3, title: 'CP-1 cap', state: 'MERGED', draft: false, source: { branch: { name: 'feat/CP-1-cap' } }, destination: { branch: { name: 'main' } }, ...page(3) }] } },
  ]);
  const prs = changeRequests({ remote, dir, run: noCli, bitbucket: new BitbucketClient(AUTH, { fetch: api.fetch, sleep: async () => {} }) });
  assert.equal(prs.forge, 'bitbucket');
  assert.equal(prs.problem, null);

  assert.equal(await prs.findOpen('feat/CP-1-cap'), null);
  assert.equal(api.calls[0]!.url, `https://api.bitbucket.org/2.0/repositories/acme/api/pullrequests?state=OPEN&q=${encodeURIComponent('source.branch.name = "feat/CP-1-cap"')}`);
  assert.equal(api.calls[0]!.auth, `Basic ${Buffer.from(`${AUTH.email}:${AUTH.token}`).toString('base64')}`);

  const made = await prs.create({ base: 'main', head: 'feat/CP-1-cap', title: 'feat: cap bets (CP-1)', bodyFile: body, draft: true });
  assert.deepEqual(made, { ok: true, value: 'https://bitbucket.org/acme/api/pull-requests/7' });
  assert.equal(api.calls[1]!.method, 'POST');
  assert.deepEqual(api.calls[1]!.body, { title: 'feat: cap bets (CP-1)', description: '## What\n\nCap bets', source: { branch: { name: 'feat/CP-1-cap' } }, destination: { branch: { name: 'main' } }, draft: true, close_source_branch: false });

  assert.deepEqual(await prs.setBody('https://bitbucket.org/acme/api/pull-requests/7', body), { ok: true, value: true });
  assert.equal(api.calls[3]!.method, 'PUT');
  assert.deepEqual(api.calls[3]!.body, { title: 'feat: cap bets (CP-1)', description: '## What\n\nCap bets' }, 'the title it has, with the new description');

  const found = await prs.search('CP-1');
  assert.ok(found.ok);
  assert.deepEqual(found.value, [{ number: 3, title: 'CP-1 cap', url: 'https://bitbucket.org/acme/api/pull-requests/3', state: 'merged', draft: false, head: 'feat/CP-1-cap', base: 'main', mergedAt: '' }]);
  assert.match(api.calls[4]!.url, /state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen=50&q=/);
  assert.equal(decodeURIComponent(api.calls[4]!.url.split('&q=')[1]!), 'title ~ "CP-1" OR description ~ "CP-1"');
});

test('bitbucket: a refusal says what to do and never shows the token; a POST is not sent twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bb-'));
  const body = path.join(dir, 'api.md');
  fs.writeFileSync(body, 'x');
  const refused = scripted([{ status: 401, body: { error: { message: `bad credentials for ${AUTH.token}` } } }]);
  const prs = changeRequests({ remote, dir, run: noCli, bitbucket: new BitbucketClient(AUTH, { fetch: refused.fetch, sleep: async () => {} }) });
  const made = await prs.create({ base: 'main', head: 'feat/x', title: 't', bodyFile: body, draft: true });
  assert.ok(!made.ok);
  assert.match(made.error, /401.*refused the API token.*Integrations → Bitbucket/);
  assert.ok(!made.error.includes(AUTH.token), 'the token is masked');

  const broken = scripted([{ status: 502 }, { status: 201, body: page(1) }]);
  const again = changeRequests({ remote, dir, run: noCli, bitbucket: new BitbucketClient(AUTH, { fetch: broken.fetch, sleep: async () => {} }) });
  assert.ok(!(await again.create({ base: 'main', head: 'feat/x', title: 't', bodyFile: body, draft: true })).ok);
  assert.equal(broken.calls.length, 1, 'a 502 may come after the PR was opened');

  const busy = scripted([{ status: 503 }, { status: 200, body: { values: [page(4)] } }]);
  const retried = changeRequests({ remote, dir, run: noCli, bitbucket: new BitbucketClient(AUTH, { fetch: busy.fetch, sleep: async () => {} }) });
  assert.equal(await retried.findOpen('feat/x'), 'https://bitbucket.org/acme/api/pull-requests/4', 'a GET is tried again');
});

test('bitbucket: without a token it says so before anything is pushed', async () => {
  const prs = changeRequests({ remote, dir: os.tmpdir(), run: noCli, bitbucket: null });
  assert.match(prs.problem!, /acme\/api is on Bitbucket.*API token.*Integrations → Bitbucket/);
  assert.equal(await prs.findOpen('feat/x'), null);
  const found = await prs.search('CP-1');
  assert.ok(!found.ok);
  assert.equal(found.error, prs.problem);
  assert.equal(changeRequests({ remote: parseRemote('git@github.com:acme/api.git'), dir: os.tmpdir(), run: noCli }).problem, null, 'gh needs no token here');
});

test('bitbucket: the connection test says who the token is', async () => {
  const api = scripted([{ status: 200, body: { display_name: 'Ann Dev', username: 'ann' } }]);
  assert.deepEqual(await new BitbucketClient(AUTH, { fetch: api.fetch }).myself(), { name: 'Ann Dev', email: AUTH.email });
  assert.equal(api.calls[0]!.url, 'https://api.bitbucket.org/2.0/user');
});
