import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WindowRegistry } from '../src/windows';
import { STALE_MS } from '../src/core/state';
import type { ProjectUri, WindowId } from '../src/core/types';

const uri = (s: string): ProjectUri => s as ProjectUri;

function setup(): { dir: string; clock: { now: number }; window: (id: string) => WindowRegistry } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtp-'));
  const clock = { now: 100_000 };
  return { dir, clock, window: (id) => new WindowRegistry({ dir, windowId: id as WindowId, now: () => clock.now }) };
}

test('windows see each other through the shared files, and a window that stops beating drops out', async () => {
  const { clock, window } = setup();
  const a = window('a');
  const b = window('b');
  await a.heartbeat(uri('file:///a'));
  await b.heartbeat(uri('file:///b'));
  assert.deepEqual(await a.open(uri('file:///a')), ['file:///a', 'file:///b']);

  clock.now += STALE_MS + 1;
  await a.heartbeat(uri('file:///a'));
  assert.deepEqual(await a.open(uri('file:///a')), ['file:///a']);
});

test('leave removes only this window', async () => {
  const { window } = setup();
  const a = window('a');
  const b = window('b');
  await a.heartbeat(uri('file:///a'));
  await b.heartbeat(uri('file:///b'));
  await a.leave();
  assert.deepEqual(await b.open(uri('file:///b')), ['file:///b']);
});

test('focus remembers the previous project, which is the last one for every other window', async () => {
  const { window } = setup();
  const a = window('a');
  const b = window('b');
  assert.equal(await a.last(uri('file:///a')), null);
  await a.focus(uri('file:///a'));
  await b.focus(uri('file:///b'));
  assert.equal(await b.last(uri('file:///b')), 'file:///a');
  assert.equal(await a.last(uri('file:///a')), null);
});

test('unreadable files read as empty', async () => {
  const { dir, window } = setup();
  fs.writeFileSync(path.join(dir, 'windows.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'focus.json'), '[]');
  const a = window('a');
  assert.deepEqual(await a.open(null), []);
  assert.deepEqual(await a.focusState(), { current: null, previous: null });
});
