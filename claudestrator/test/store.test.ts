// The task store: transcripts are written off the extension host's thread, and the lock never waits on a dead process.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TaskService } from '../src/core/store';

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
