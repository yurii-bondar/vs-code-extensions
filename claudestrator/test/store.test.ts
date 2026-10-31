// The task store: transcripts are written off the extension host's thread, and the lock never waits on a dead process.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { TaskService, withLock } from '../src/core/store';

test('store: transcript lines are written asynchronously, in order, and readable before they land', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tr-'));
  const svc = new TaskService({ workspace: ws });
  fs.mkdirSync(svc.dir('T-1'), { recursive: true });
  for (let i = 0; i < 500; i++) svc.appendTranscript('T-1', '0001-dev', { type: 'text', text: `line ${i}` });
  assert.equal(svc.readTranscript('T-1', '0001-dev').length, 500, 'queued lines are part of what a reader sees');
  await svc.flushTranscripts();
  const lines = fs.readFileSync(svc.transcriptFile('T-1', '0001-dev'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((l) => JSON.parse(l).text), Array.from({ length: 500 }, (_, i) => `line ${i}`));

  fs.rmSync(svc.dir('T-1'), { recursive: true });
  svc.appendTranscript('T-1', '0001-dev', { type: 'text', text: 'late' });
  await svc.flushTranscripts();
  assert.ok(!fs.existsSync(svc.dir('T-1')), 'a deleted task does not come back as a folder of transcripts');
});

test('store: a lock left by a crashed process is taken over at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lock-'));
  const lock = path.join(dir, '.lock');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(lock, `${dead.stdout}\n`);
  const started = Date.now();
  assert.equal(await withLock(lock, async () => 'ran', { timeoutMs: 2000, staleMs: 60000 }), 'ran');
  assert.ok(Date.now() - started < 500, 'no wait for a holder that is gone');
  assert.ok(!fs.existsSync(lock), 'released');

  fs.writeFileSync(lock, `${process.ppid}\n`); // alive, and not this process: a real holder
  await assert.rejects(() => withLock(lock, async () => 'ran', { timeoutMs: 200, staleMs: 60000 }), /timed out/);
});

test('store: waiting for a lock another process holds leaves the event loop free, and writes of one task take turns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lock-'));
  const lock = path.join(dir, '.lock');
  fs.writeFileSync(lock, `${process.ppid}\n`); // a live holder: the claudestrator CLI, say
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const waited = withLock(lock, async () => 'ran', { timeoutMs: 300, staleMs: 60000 }).catch((e: Error) => e.message);
  await new Promise((r) => setTimeout(r, 150));
  fs.rmSync(lock); // it lets go
  assert.equal(await waited, 'ran');
  clearInterval(timer);
  assert.ok(ticks >= 10, `timers kept running while it waited (${ticks} ticks)`);

  // In this process, dispatches of one task run one after another: each reads the log the one before wrote.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-queue-'));
  const svc = new TaskService({ workspace: ws });
  const { taskId } = await svc.start({ input: 'x', source: { kind: 'text', text: 'x' }, auto: false, pipeline: { mode: 'auto', stages: [], reviewLoop: null }, config: { limits: { reviewRounds: 1, gateAttempts: 1 }, repos: {}, context: [], git: { mode: 'branch' } } });
  const notes = await Promise.all(Array.from({ length: 20 }, (_, i) => svc.record(taskId, { type: 'note', message: `n${i}` })));
  assert.deepEqual(notes.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i + 2), 'no two got the same number');
  assert.deepEqual(svc.events(taskId).map((e) => e.seq), Array.from({ length: 21 }, (_, i) => i + 1));
});
