// Requests from the dashboard page are checked at the boundary before any handler runs.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { parsePageRequest, openable, commandTaskId, SESSION_ID } from '../src/core/requests';

test('requests: only a known request with parameters of its shape reaches a handler', async () => {
  const ok = parsePageRequest({ type: 'req', id: 1, method: 'answer', params: { taskId: 'PROJ-1', checkpointId: 'approve-plan', option: 'approve' } });
  assert.ok(ok && ok.ok);
  assert.equal(ok.request.method, 'answer');

  assert.ok(parsePageRequest({ type: 'req', id: 2, method: 'boot' })?.ok, 'a request without parameters');
  assert.ok(parsePageRequest({ type: 'req', id: 3, method: 'pickRepos' })?.ok, 'optional parameters may be left out');
  assert.ok(parsePageRequest({ type: 'req', id: 4, method: 'start', params: { text: 'fix it', key: undefined, extra: 1 } })?.ok, 'fields a handler does not read are ignored');

  assert.equal(parsePageRequest('hi'), null, 'not a request at all: no answer');
  assert.equal(parsePageRequest({ type: 'res', id: 1 }), null);

  const unknown = parsePageRequest({ type: 'req', id: 5, method: 'constructor' });
  assert.deepEqual(unknown, { ok: false, id: 5, error: 'unknown request constructor' }, "nothing reached through Object's prototype");

  const bad = parsePageRequest({ type: 'req', id: 6, method: 'answer', params: { taskId: 'PROJ-1', checkpointId: 7 } });
  assert.ok(bad && !bad.ok);
  assert.match(bad.error, /checkpointId: expected a string/);
  assert.match(bad.error, /option: required/);
});

test('requests: the page opens only web links outside the editor', async () => {
  assert.ok(parsePageRequest({ type: 'req', id: 1, method: 'openExternal', params: { url: 'https://github.com/acme/api/pull/1' } })?.ok);
  for (const url of ['command:workbench.action.terminal.new', 'file:///etc/passwd', 'vscode://settings', '']) {
    const r = parsePageRequest({ type: 'req', id: 2, method: 'openExternal', params: { url } });
    assert.ok(r && !r.ok, url);
  }
});

test('requests: a path from the page opens only inside the workspace, its repos or the config, and a session id is only one', async () => {
  const roots = ['/ws', '/elsewhere/billing', '/home/u/libs/agents/library.yaml'];
  for (const file of ['/ws/api/src/a.ts', '/elsewhere/billing/go.mod', '/home/u/libs/agents/library.yaml', '/ws/./api/../web/x']) assert.equal(openable(file, roots), true, file);
  for (const file of ['/etc/passwd', '/home/u/.ssh/id_rsa', '/ws/../etc/hosts', '/wsx/a', '/home/u/libs/agents/other.yaml']) assert.equal(openable(file, roots), false, file);
  assert.ok(SESSION_ID.test('3f1c2a4e-9b7d-4c1e-8f2a-1234567890ab'));
  for (const id of ['x; rm -rf ~', '$(curl evil)', '', 'a b']) assert.equal(SESSION_ID.test(id), false, id);
});

test('requests: a task command takes its task from an id, the sidebar row or the dashboard row right-clicked', () => {
  assert.equal(commandTaskId('T-1'), 'T-1');
  assert.equal(commandTaskId({ card: { taskId: 'T-2' } }), 'T-2', 'the sidebar tree');
  assert.equal(commandTaskId({ webview: 'claudestrator.dashboard', webviewSection: 'task', taskId: 'T-3', taskStatus: 'done' }), 'T-3', "the rail's data-vscode-context");
  for (const arg of [undefined, '', {}, { taskId: 7 }, { card: null }, { card: { taskId: '' } }, null]) assert.equal(commandTaskId(arg), undefined, JSON.stringify(arg));
});

test("requests: Bitbucket's credentials from the page are strings, and its test takes none", () => {
  assert.ok(parsePageRequest({ type: 'req', id: 1, method: 'saveBitbucket', params: { email: 'dev@acme.com', token: 't' } })?.ok);
  assert.ok(parsePageRequest({ type: 'req', id: 2, method: 'saveBitbucket', params: {} })?.ok, 'both may be left out');
  const bad = parsePageRequest({ type: 'req', id: 3, method: 'saveBitbucket', params: { token: 42 } });
  assert.ok(bad && !bad.ok && /token: expected a string/.test(bad.error));
  assert.ok(parsePageRequest({ type: 'req', id: 4, method: 'testBitbucket' })?.ok);
});

test('requests: an answer may leave findings of a review out, by their ids', () => {
  assert.ok(parsePageRequest({ type: 'req', id: 1, method: 'answer', params: { taskId: 'api-pr-12', checkpointId: 'post-review', option: 'post', omit: ['0.1', '1.0'] } })?.ok);
  const bad = parsePageRequest({ type: 'req', id: 2, method: 'answer', params: { taskId: 'api-pr-12', checkpointId: 'post-review', option: 'post', omit: [3] } });
  assert.ok(bad && !bad.ok && /omit/.test(bad.error));
});
