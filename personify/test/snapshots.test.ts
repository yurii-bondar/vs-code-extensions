import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshots, snapshotInfo, withSnapshot } from '../src/core/snapshots';
import type { SnapshotId, SnapshotRecord } from '../src/core/snapshots';

const snap = (id: string, at: number): SnapshotRecord => ({
  id: id as SnapshotId,
  at,
  reason: `Before ${id}`,
  settings: { user: { 'editor.fontSize': 14 }, workspace: {} },
  keybindings: { file: '/k.json', text: '[]' },
});

test('a new snapshot goes first and the oldest fall off past the limit', () => {
  let list: SnapshotRecord[] = [];
  for (let i = 1; i <= 4; i++) list = withSnapshot(list, snap(`s${i}`, i), 3);
  assert.deepEqual(
    list.map((s) => s.id),
    ['s4', 's3', 's2']
  );
  assert.deepEqual(snapshotInfo(list.slice(0, 1)), [{ id: 's4', at: 4, reason: 'Before s4' }]);
});

test('stored snapshots survive a round trip through JSON, and malformed ones are dropped', () => {
  const stored: unknown = JSON.parse(JSON.stringify([snap('ok', 1), { id: 'no-settings', at: 2, reason: 'x' }, { id: 'bad-time', at: 'now', reason: 'x', settings: {} }, null]));
  assert.deepEqual(parseSnapshots(stored), [snap('ok', 1)]);
  assert.deepEqual(parseSnapshots('nope'), []);
});

test('a snapshot without readable keybindings keeps its settings', () => {
  const [s] = parseSnapshots([{ id: 'a', at: 1, reason: 'r', settings: { user: { x: 1 } }, keybindings: { file: '/k.json' } }]);
  assert.deepEqual(s?.settings, { user: { x: 1 }, workspace: {} });
  assert.equal(s?.keybindings, null);
});
