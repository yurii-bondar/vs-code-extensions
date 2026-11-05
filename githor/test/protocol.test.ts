import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMessage } from '../src/protocol';

test('parseClientMessage accepts the known messages', () => {
  assert.deepEqual(parseClientMessage({ type: 'ready', extra: 1 }), { type: 'ready' });
  assert.deepEqual(parseClientMessage({ type: 'fetch', all: true }), { type: 'fetch', all: true });
  assert.deepEqual(parseClientMessage({ type: 'switch', ref: 'refs/heads/feat/x' }), { type: 'switch', ref: 'refs/heads/feat/x' });
  assert.deepEqual(parseClientMessage({ type: 'scanMerged', target: null }), { type: 'scanMerged', target: null });
  assert.deepEqual(parseClientMessage({ type: 'scanMerged', target: 'develop' }), { type: 'scanMerged', target: 'develop' });
  assert.deepEqual(parseClientMessage({ type: 'deleteMerged', target: 'main', names: ['a', 'b'], onRemote: false }), { type: 'deleteMerged', target: 'main', names: ['a', 'b'], onRemote: false });
  assert.deepEqual(parseClientMessage({ type: 'undo', id: 3 }), { type: 'undo', id: 3 });
});

test('parseClientMessage rejects what is not a known message', () => {
  const bad = [
    null,
    'ready',
    [],
    {},
    { type: 'fetch' },
    { type: 'switch', ref: '' },
    { type: 'scanMerged' },
    { type: 'deleteMerged', target: 'main', names: ['a', 3], onRemote: false },
    { type: 'deleteMerged', target: 'main', names: 'a', onRemote: false },
    { type: 'undo', id: '3' },
    { type: 'nope' },
  ];
  for (const raw of bad) assert.equal(parseClientMessage(raw), null, JSON.stringify(raw));
});
