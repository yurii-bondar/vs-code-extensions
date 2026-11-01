// The Atlassian REST client: a timeout on every request, retries that never post a comment twice.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AtlassianClient, AtlassianError, IntakeError, classifyInput, otherSite, runIntake } from '../src/core/intake';
import { Engine, type EngineOptions } from '../src/core/engine';
import type { TaskState } from '../src/core/types';

const AUTH = { site: 'acme.atlassian.net', email: 'dev@example.com', token: 't' };

/** A fetch that answers from a script, one entry per call: a status (with headers) or an error to throw. */
function scripted(steps: ({ status: number; headers?: Record<string, string>; body?: unknown } | Error)[]) {
  const calls: { url: string; method: string; signal: boolean }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), signal: init.signal instanceof AbortSignal });
    const step = steps.shift();
    if (!step) throw new Error('no more answers');
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status, headers: step.headers ?? {} });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const named = (name: string, message = name): Error => Object.assign(new Error(message), { name });

test('atlassian: a GET is retried after a "try later" status, a network error or a timeout', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => void waits.push(ms);

  const busy = scripted([{ status: 503 }, named('TypeError', 'fetch failed'), { status: 200, body: { displayName: 'Dev', emailAddress: 'dev@example.com' } }]);
  const me = await new AtlassianClient(AUTH, { fetch: busy.fetch, sleep }).myself();
  assert.deepEqual(me, { name: 'Dev', email: 'dev@example.com' });
  assert.equal(busy.calls.length, 3);
  assert.ok(busy.calls.every((c) => c.signal), 'every request carries a timeout signal');
  assert.deepEqual(waits, [1000, 2000], 'backs off between attempts');

  const slow = scripted([named('TimeoutError'), named('TimeoutError'), named('TimeoutError')]);
  await assert.rejects(new AtlassianClient(AUTH, { fetch: slow.fetch, sleep, timeoutMs: 5000 }).myself(), /no answer in 5s/);
  assert.equal(slow.calls.length, 3, 'gives up after three attempts');

  const missing = scripted([{ status: 404 }]);
  await assert.rejects(new AtlassianClient(AUTH, { fetch: missing.fetch, sleep }).myself(), /404/);
  assert.equal(missing.calls.length, 1, 'a client error is not retried');
});

test('atlassian: a comment is posted again only when the server says it did not take it', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => void waits.push(ms);

  const limited = scripted([{ status: 429, headers: { 'retry-after': '2' } }, { status: 201, body: { id: '10001' } }]);
  assert.equal(await new AtlassianClient(AUTH, { fetch: limited.fetch, sleep }).addComment('PROJ-1', 'hi'), '10001');
  assert.equal(limited.calls.length, 2);
  assert.deepEqual(waits, [2000], 'waits as long as Retry-After says');

  const dropped = scripted([named('TypeError', 'socket hang up'), { status: 201, body: { id: 'twice' } }]);
  await assert.rejects(new AtlassianClient(AUTH, { fetch: dropped.fetch, sleep }).addComment('PROJ-1', 'hi'), /socket hang up/);
  assert.equal(dropped.calls.length, 1, 'a POST that may have arrived is not sent twice');

  const broken = scripted([{ status: 502 }, { status: 201, body: { id: 'twice' } }]);
  await assert.rejects(new AtlassianClient(AUTH, { fetch: broken.fetch, sleep }).addComment('PROJ-1', 'hi'), /502/);
  assert.equal(broken.calls.length, 1, 'a 502 may come after the comment was saved');
});

test("atlassian: a link to another site is not read or commented on with this site's token", async () => {
  const none = scripted([]);
  const client = new AtlassianClient(AUTH, { fetch: none.fetch, sleep: async () => {} });
  const elsewhere = classifyInput('https://clientb.atlassian.net/browse/PROJ-12');
  assert.equal(otherSite(elsewhere, client.site), 'clientb.atlassian.net');
  assert.equal(otherSite(classifyInput('https://ACME.atlassian.net/browse/PROJ-12'), client.site), null, 'the same site, any case');
  assert.equal(otherSite(classifyInput('PROJ-12'), client.site), null, 'a bare key is on the token\'s site');
  assert.equal(otherSite(classifyInput('https://clientb.atlassian.net/wiki/spaces/X/pages/123/Title'), client.site), 'clientb.atlassian.net');
  await assert.rejects(runIntake('PROJ-12', elsewhere, { atlassian: client }), (e: IntakeError) => e.code === 'other_site' && /PROJ-12 is on clientb\.atlassian\.net/.test(e.message));
  assert.equal(none.calls.length, 0, "acme's PROJ-12 was never asked for");

  // The engine reads it through the account's Atlassian MCP server instead, and comments there too; without one it says why.
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-site-')));
  const engine = new Engine({ workspace: ws, home: ws, runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'], atlassian: () => client });
  const r = await engine.comment({ taskId: 'PROJ-12', source: elsewhere } as TaskState, 'Plan approved.');
  assert.ok(!r.ok && /PROJ-12 is on clientb\.atlassian\.net, and the API token is for acme\.atlassian\.net/.test(r.error ?? ''), r.error);
  assert.equal(none.calls.length, 0, 'no comment on the wrong issue');
});

test('atlassian: a ticket with a huge description or hundreds of comments is cut, and says so', async () => {
  const { capSpec } = await import('../src/core/intake');
  const spec = { id: 'T', source: { kind: 'text' as const, text: 'x' }, title: 'x', description: 'd'.repeat(100000), acceptanceCriteria: [], links: [], context: `${'old '.repeat(20000)}LATEST COMMENT` };
  const capped = capSpec(spec);
  assert.ok(capped.description.length < 41000 && /more characters of the description are left out/.test(capped.description));
  assert.ok(capped.context!.length < 21000 && capped.context!.endsWith('LATEST COMMENT'), 'the latest comments stay');
  assert.deepEqual(capSpec({ ...spec, description: 'short', context: 'short' }), { ...spec, description: 'short', context: 'short' });
});

test('atlassian: a refused token, a missing access or a misspelt site says what to do, never with the token', async () => {
  const secret = { site: 'acme.atlassian.net', email: 'dev@example.com', token: 'ATATT-secret-123' };
  const header = Buffer.from(`${secret.email}:${secret.token}`).toString('base64');
  const sleep = async (): Promise<void> => {};
  const failure = async (steps: Parameters<typeof scripted>[0], read: (c: AtlassianClient) => Promise<unknown>): Promise<Error> => {
    const { fetch } = scripted(steps);
    try {
      await read(new AtlassianClient(secret, { fetch, sleep }));
    } catch (e) {
      const message = (e as Error).message;
      assert.ok(!message.includes(secret.token) && !message.includes(header), `no token in "${message}"`);
      return e as Error;
    }
    throw new Error('it did not fail');
  };

  const expired = await failure([{ status: 401 }], (c) => c.myself());
  assert.match(expired.message, /^GET \/rest\/api\/3\/myself: 401: acme\.atlassian\.net refused the API token: .*Settings → Jira & Confluence$/);
  assert.equal((expired as AtlassianError).status, 401);
  // The intake tells a refused token from the rest, so the engine can read through the MCP server instead.
  const { fetch } = scripted([{ status: 401 }]);
  await assert.rejects(runIntake('PROJ-1', { kind: 'jira', key: 'PROJ-1' }, { atlassian: new AtlassianClient(secret, { fetch, sleep }) }), (e: IntakeError) => e.code === 'atlassian_auth' && /API token/.test(e.message));

  assert.match((await failure([{ status: 403 }], (c) => c.issue('PROJ-1'))).message, /403: the API token's account has no access to this on acme\.atlassian\.net/);
  assert.match((await failure([{ status: 404 }], (c) => c.page('42'))).message, /404: there is no such issue or page on acme\.atlassian\.net, or the API token's account cannot see it/);

  // Node's fetch says "fetch failed"; the reason is in its cause.
  const cause = (code: string, message: string): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
  const misspelt = cause('ENOTFOUND', 'getaddrinfo ENOTFOUND acme.atlassian.net');
  const nowhere = await failure([misspelt, misspelt, misspelt], (c) => c.myself());
  assert.match(nowhere.message, /the connection to acme\.atlassian\.net failed: fetch failed \(getaddrinfo ENOTFOUND acme\.atlassian\.net\): is the site right\? \(Settings → Jira & Confluence\)/);
  assert.equal((nowhere as AtlassianError).status, null);
  const proxy = cause('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate');
  assert.match((await failure([proxy, proxy, proxy], (c) => c.myself())).message, /fetch failed \(UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate\): its certificate is not trusted here/);
  // Every address refused: an AggregateError without a message of its own.
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([new Error('connect ECONNREFUSED 10.0.0.1:443')], ''), { code: 'ECONNREFUSED' }) });
  assert.match((await failure([refused, refused, refused], (c) => c.myself())).message, /fetch failed \(connect ECONNREFUSED 10\.0\.0\.1:443\)$/);
  // A library that put the credentials into its text does not get them into the message.
  const leaky = new TypeError(`invalid header Basic ${header}`);
  assert.match((await failure([leaky], (c) => c.addComment('PROJ-1', 'hi'))).message, /invalid header Basic \*\*\*/);
});
