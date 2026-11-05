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
  assert.deepEqual(parseClientMessage({ type: 'push', ref: 'refs/heads/x', force: true, tags: false }), { type: 'push', ref: 'refs/heads/x', force: true, tags: false });
  assert.deepEqual(parseClientMessage({ type: 'pull', ref: 'refs/heads/x' }), { type: 'pull', ref: 'refs/heads/x' });
  assert.deepEqual(parseClientMessage({ type: 'publish', ref: 'refs/heads/x' }), { type: 'publish', ref: 'refs/heads/x' });
  assert.deepEqual(parseClientMessage({ type: 'sync', ref: null }), { type: 'sync', ref: null });
  assert.deepEqual(parseClientMessage({ type: 'newBranch', name: 'feat/x', start: 'refs/heads/main', switchTo: true }), { type: 'newBranch', name: 'feat/x', start: 'refs/heads/main', switchTo: true });
  assert.deepEqual(parseClientMessage({ type: 'rename', ref: 'refs/heads/a', to: 'b', onRemote: false }), { type: 'rename', ref: 'refs/heads/a', to: 'b', onRemote: false });
  assert.deepEqual(parseClientMessage({ type: 'deleteBranch', ref: 'refs/heads/a', onRemote: true }), { type: 'deleteBranch', ref: 'refs/heads/a', onRemote: true });
  assert.deepEqual(parseClientMessage({ type: 'pin', ref: 'refs/heads/a', pinned: true }), { type: 'pin', ref: 'refs/heads/a', pinned: true });
  assert.deepEqual(parseClientMessage({ type: 'checkName', name: '' }), { type: 'checkName', name: '' });
  assert.deepEqual(parseClientMessage({ type: 'forceInfo', ref: 'refs/heads/x' }), { type: 'forceInfo', ref: 'refs/heads/x' });
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
    { type: 'push', ref: 'refs/heads/x', force: 'yes', tags: false },
    { type: 'push', ref: 'refs/heads/x' },
    { type: 'pull' },
    { type: 'sync' },
    { type: 'rename', ref: 'refs/heads/a', to: '', onRemote: false },
    { type: 'newBranch', name: 'x', start: 'refs/heads/main' },
    { type: 'pin', ref: 'refs/heads/a' },
    { type: 'nope' },
  ];
  for (const raw of bad) assert.equal(parseClientMessage(raw), null, JSON.stringify(raw));
});
