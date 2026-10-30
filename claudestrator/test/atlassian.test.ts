// The Atlassian REST client: a timeout on every request, retries that never post a comment twice.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { AtlassianClient } from '../src/core/intake';

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
