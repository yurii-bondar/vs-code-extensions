// The runner against a minimal stream-json CLI: which result answers which turn.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { ClaudeRunner, ClaudeSession, versionProblem } from '../src/core/runner';
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

test('runner: stopping an agent ends its turn cleanly, and a CLI that ignores that is terminated', async () => {
  const clean = session('interrupt', 'implement the plan', 10000);
  const started = Date.now();
  setTimeout(() => void clean.s.interrupt(), 50);
  const t = await clean.s.turn();
  assert.equal(t.ok, false);
  assert.match(t.error!, /error_during_execution: interrupted/);
  assert.ok(Date.now() - started < 2000, 'the interrupt ended the turn without a signal');
  clean.s.close();

  const deaf = session('', 'implement the plan', 30000);
  setTimeout(() => void deaf.s.interrupt(), 50);
  const killed = await deaf.s.turn();
  assert.equal(killed.ok, false);
  assert.match(killed.error!, /session ended|stopped/);
});

test('runner: a Claude Code older than the guard needs does not start', async () => {
  assert.equal(versionProblem('2.1.314 (Claude Code)'), null);
  assert.equal(versionProblem('2.1.302 (Claude Code)'), null);
  assert.equal(versionProblem('3.0.0'), null);
  assert.equal(versionProblem(undefined), null, 'unknown: the probe has not run yet');
  assert.match(versionProblem('2.1.295 (Claude Code)')!, /2\.1\.295 is older than 2\.1\.302.*claude update/);
  assert.match(versionProblem('1.9.999')!, /older/);
  const runner = new ClaudeRunner({ command: () => FAKE, version: () => '2.0.1 (Claude Code)', flags: () => new Set(), settingSources: () => null, hookSettings: () => '{}', env: () => ({}) });
  await assert.rejects(runner.start({ agent: { model: 'sonnet', instructions: '' }, prompt: 'hi', cwd: __dirname, onOutput: () => {} }), /older than/);
});
