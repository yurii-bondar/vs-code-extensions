import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMessage } from '../src/protocol';

test('parseClientMessage accepts the known messages', () => {
  assert.deepEqual(parseClientMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseClientMessage({ type: 'run', id: 'a1' }), { type: 'run', id: 'a1' });
  assert.deepEqual(parseClientMessage({ type: 'pick', target: 'folder' }), { type: 'pick', target: 'folder' });
});

test('parseClientMessage rejects what is not a known message', () => {
  for (const bad of [null, 'run', [], {}, { type: 'run' }, { type: 'run', id: 3 }, { type: 'pick', target: 'disk' }, { type: 'nope' }]) {
    assert.equal(parseClientMessage(bad), null);
  }
});

test('parseClientMessage narrows a script draft and drops a malformed one', () => {
  const draft = { id: null, name: '', path: '/a/b.sh', description: '', groupId: null, interpreter: '', args: '', cwd: '' };
  assert.deepEqual(parseClientMessage({ type: 'saveScript', draft }), { type: 'saveScript', draft });
  assert.equal(parseClientMessage({ type: 'saveScript', draft: { ...draft, path: 5 } }), null);
  assert.equal(parseClientMessage({ type: 'saveScript', draft: { ...draft, id: 7 } }), null);
  assert.equal(parseClientMessage({ type: 'saveScript' }), null);
});

test('parseClientMessage only takes a known hue for a group', () => {
  assert.deepEqual(parseClientMessage({ type: 'saveGroup', draft: { id: null, name: 'Dev', hue: 'green' } }), { type: 'saveGroup', draft: { id: null, name: 'Dev', hue: 'green' } });
  assert.equal(parseClientMessage({ type: 'saveGroup', draft: { id: null, name: 'Dev', hue: 'red' } }), null);
});
