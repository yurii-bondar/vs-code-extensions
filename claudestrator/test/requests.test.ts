// Requests from the dashboard page are checked at the boundary before any handler runs.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { parsePageRequest } from '../src/core/requests';

test('requests: only a known request with parameters of its shape reaches a handler', () => {
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

test('requests: the page opens only web links outside the editor', () => {
  assert.ok(parsePageRequest({ type: 'req', id: 1, method: 'openExternal', params: { url: 'https://github.com/acme/api/pull/1' } })?.ok);
  for (const url of ['command:workbench.action.terminal.new', 'file:///etc/passwd', 'vscode://settings', '']) {
    const r = parsePageRequest({ type: 'req', id: 2, method: 'openExternal', params: { url } });
    assert.ok(r && !r.ok, url);
  }
});
