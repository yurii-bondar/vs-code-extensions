// The runner against a minimal stream-json CLI: which result answers which turn.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { ClaudeSession } from '../src/core/runner';
import type { RunnerOptions } from '../src/core/runner';
import type { TranscriptItem } from '../src/core/store';

const FAKE = path.join(__dirname, 'fixtures', 'fake-stream.js');
fs.chmodSync(FAKE, 0o755);

/** A session of the fake CLI, with the modes it runs in. */
function session(modes: string, prompt = 'implement the plan', delay = 100): { s: ClaudeSession; items: TranscriptItem[] } {
  const items: TranscriptItem[] = [];
  const opts: RunnerOptions = { command: () => FAKE, flags: () => new Set(), settingSources: () => null, hookSettings: () => '{}', env: () => ({ FAKE_STREAM: modes, FAKE_STREAM_DELAY: String(delay) }) };
  return { s: new ClaudeSession({ agent: { model: 'sonnet', instructions: '' }, prompt, cwd: __dirname, onOutput: (i) => void items.push(i) }, opts), items };
}

for (const modes of ['uuids', '']) {
  test(`runner: a message typed mid-turn is answered before the turn counts as done${modes ? ' (results name their messages)' : ' (results do not say which messages they answer)'}`, async () => {
    const { s } = session(modes);
    try {
      setTimeout(() => s.send('reuse formatDate from utils'), 30);
      const first = await s.turn();
      assert.equal(first.report, 'answer to: reuse formatDate from utils', 'the turn ends with the answer to the last message');
      s.send('Gates failed: fix the lint error', { from: 'orchestrator' });
      const second = await s.turn();
      assert.equal(second.report, 'answer to: Gates failed: fix the lint error', 'the gate feedback gets its own answer, not a stale one');
    } finally {
      s.close();
    }
  });
}

test('runner: an answer to a message sent between turns never stands in for the next turn', async () => {
  const { s } = session('uuids', 'implement the plan', 50);
  try {
    assert.equal((await s.turn()).report, 'answer to: implement the plan');
    s.send('also update the README'); // typed while the gates run
    await new Promise((r) => setTimeout(r, 150)); // answered meanwhile; nobody waits for it
    s.send('Gates failed: fix the lint error', { from: 'orchestrator' });
    assert.equal((await s.turn()).report, 'answer to: Gates failed: fix the lint error');
  } finally {
    s.close();
  }
});
