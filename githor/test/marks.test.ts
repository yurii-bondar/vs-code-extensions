import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inFilter, marksOf, marksText } from '../src/core/marks';
import type { Branch, SyncState } from '../src/core/types';

const branch = (sync: SyncState, ahead = 0, behind = 0): Branch => ({
  name: 'x',
  ref: 'refs/heads/x',
  current: false,
  local: sync !== 'remote',
  upstream: sync === 'unpushed' ? null : 'origin/x',
  sync,
  ahead,
  behind,
  sha: 's',
  committedAt: 0,
});

test('marksOf follows the design table', () => {
  assert.deepEqual(marksOf(branch('ahead', 2)), { local: true, ahead: 2, remote: true, behind: 0, end: null });
  assert.deepEqual(marksOf(branch('behind', 0, 3)), { local: true, ahead: 0, remote: true, behind: 3, end: null });
  assert.deepEqual(marksOf(branch('diverged', 1, 2)), { local: true, ahead: 1, remote: true, behind: 2, end: 'diverged' });
  assert.deepEqual(marksOf(branch('unpushed', 2)), { local: true, ahead: 2, remote: false, behind: 0, end: null });
  assert.deepEqual(marksOf(branch('synced')), { local: true, ahead: 0, remote: true, behind: 0, end: 'in-sync' });
  assert.deepEqual(marksOf(branch('remote')), { local: false, ahead: 0, remote: true, behind: 0, end: null });
  assert.deepEqual(marksOf(branch('gone')), { local: true, ahead: 0, remote: false, behind: 0, end: null });
});

test('marksText is what the status bar shows', () => {
  assert.equal(marksText(branch('ahead', 2)), '↑2');
  assert.equal(marksText(branch('behind', 0, 3)), '↓3');
  assert.equal(marksText(branch('diverged', 1, 2)), '↑1 ↓2');
  assert.equal(marksText(branch('synced')), 'in sync');
  assert.equal(marksText(branch('unpushed')), '');
  assert.equal(marksText(branch('gone')), '');
});

test('inFilter sorts branches into the filters of the list', () => {
  const all = [branch('ahead', 2), branch('behind', 0, 3), branch('diverged', 1, 1), branch('unpushed', 2), branch('unpushed'), branch('synced'), branch('remote'), branch('gone')];
  const count = (filter: Parameters<typeof inFilter>[1]): number => all.filter((b) => inFilter(b, filter)).length;
  assert.equal(count('all'), 8);
  assert.equal(count('attention'), 5);
  assert.equal(count('local'), 3);
  assert.equal(count('remote'), 1);
});
