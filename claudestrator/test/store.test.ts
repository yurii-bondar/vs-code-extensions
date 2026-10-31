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
  assert.equal((await svc.readTranscript('T-1', '0001-dev')).length, 500, 'queued lines are part of what a reader sees');
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
  assert.deepEqual((await svc.events(taskId)).map((e) => e.seq), Array.from({ length: 21 }, (_, i) => i + 1));
});

test('store: a transcript read while lines are being written has each line once, in order', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tr-race-'));
  const svc = new TaskService({ workspace: ws });
  fs.mkdirSync(svc.dir('T-1'), { recursive: true });
  let written = 0;
  const reads: number[][] = [];
  // An agent streams while the task screen reads its transcript again and again.
  const writer = (async () => {
    for (let i = 0; i < 400; i++) {
      svc.appendTranscript('T-1', '0001-dev', { type: 'text', text: `${i}` });
      written++;
      if (i % 20 === 0) await new Promise((r) => setImmediate(r));
    }
  })();
  for (let k = 0; k < 30; k++) {
    const seen = written;
    const items = (await svc.readTranscript('T-1', '0001-dev', 10000)).map((i) => Number('text' in i ? i.text : -1));
    assert.ok(items.length >= seen, `a read misses nothing written before it (${items.length} < ${seen})`);
    reads.push(items);
    await new Promise((r) => setImmediate(r));
  }
  await writer;
  await svc.flushTranscripts();
  reads.push((await svc.readTranscript('T-1', '0001-dev', 10000)).map((i) => Number('text' in i ? i.text : -1)));
  for (const items of reads) assert.deepEqual(items, Array.from({ length: items.length }, (_, i) => i), 'each line once, in order');
  assert.equal(reads.at(-1)!.length, 400);
});

test('store: a long transcript is read from its end, whole lines only, also where a chunk cuts a character', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tail-'));
  const svc = new TaskService({ workspace: ws });
  const file = svc.transcriptFile('T-1', '0001-dev');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 20,000 items of mixed length with Cyrillic in them: several megabytes, chunk borders anywhere.
  const lines: string[] = [];
  for (let i = 0; i < 20000; i++) lines.push(`${JSON.stringify({ type: 'text', text: `${i} ${'ї'.repeat(i % 97)}` })}\n`);
  fs.writeFileSync(file, lines.join(''));
  const items = await svc.readTranscript('T-1', '0001-dev');
  assert.equal(items.length, 1500);
  assert.deepEqual(items.map((i) => Number(String('text' in i ? i.text : '').split(' ')[0])), Array.from({ length: 1500 }, (_, k) => 18500 + k));
  assert.ok(items.every((i) => !String('text' in i ? i.text : '').includes('�')), 'no character cut in two');
  assert.equal((await svc.readTranscript('T-1', '0001-dev', 30000)).length, 20000, 'a limit above the length reads it all');
  assert.deepEqual(await svc.readTranscript('T-1', 'none'), [], 'no file yet');
});

test('store: a task another live process runs is not run here, and a lease nobody holds any more is taken over', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lease-'));
  const svc = new TaskService({ workspace: ws });
  fs.mkdirSync(svc.dir('T-1'), { recursive: true });
  const lease = path.join(svc.dir('T-1'), 'run.lease');

  const mine = await svc.takeLease('T-1');
  assert.ok(mine.ok);
  assert.equal(await svc.runsElsewhere('T-1'), null, 'this process is not elsewhere');
  await mine.release();
  assert.ok(!fs.existsSync(lease), 'released');

  // Another VS Code window: alive, and not this process.
  fs.writeFileSync(lease, `${process.ppid}\n`);
  const held = await svc.takeLease('T-1');
  assert.deepEqual(held, { ok: false, pid: process.ppid });
  assert.equal(await svc.runsElsewhere('T-1'), process.ppid);
  assert.deepEqual(await svc.runningElsewhere(), ['T-1']);

  // That window stopped renewing it (hung, or its pid went to another program).
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lease, old, old);
  assert.equal(await svc.runsElsewhere('T-1'), null);
  const taken = await svc.takeLease('T-1');
  assert.ok(taken.ok, 'an unrenewed lease is taken over');
  await taken.release();

  // A window that crashed holding it.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(lease, `${dead.stdout}\n`);
  const after = await svc.takeLease('T-1');
  assert.ok(after.ok, 'the lease of a process that is gone is taken over');
  await after.release();
});
