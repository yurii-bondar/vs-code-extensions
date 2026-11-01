// The runner against a minimal stream-json CLI: which result answers which turn.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { ClaudeRunner, ClaudeSession, capInput, versionProblem } from '../src/core/runner';
import type { RunnerOptions } from '../src/core/runner';
import type { TranscriptItem } from '../src/core/store';

const FAKE = path.join(__dirname, 'fixtures', 'fake-stream.js');
fs.chmodSync(FAKE, 0o755);

/** A session of the fake CLI, with the modes it runs in. */
function session(modes: string, prompt = 'implement the plan', delay = 100): { s: ClaudeSession; items: TranscriptItem[] } {
  const items: TranscriptItem[] = [];
  const opts: RunnerOptions = { command: () => FAKE, flags: () => new Set(), settingSources: () => null, env: () => ({ FAKE_STREAM: modes, FAKE_STREAM_DELAY: String(delay) }) };
  return { s: new ClaudeSession({ agent: { model: 'sonnet', instructions: '' }, prompt, cwd: __dirname, settings: {}, onOutput: (i) => void items.push(i) }, opts), items };
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
  const runner = new ClaudeRunner({ command: () => FAKE, version: () => '2.0.1 (Claude Code)', flags: () => new Set(), settingSources: () => null, env: () => ({}) });
  await assert.rejects(runner.start({ agent: { model: 'sonnet', instructions: '' }, prompt: 'hi', cwd: __dirname, settings: {}, onOutput: () => {} }), /older than/);
});

test('runner: text cut inside a multi-byte character by the pipe arrives intact', async () => {
  const { s, items } = session('utf8', 'План готовий: перевірка критеріїв 🚀', 20);
  try {
    const t = await s.turn();
    assert.equal(t.report, 'answer to: План готовий: перевірка критеріїв 🚀');
    assert.ok(!t.report.includes('�'), 'no replacement characters');
    assert.ok(items.some((i) => i.type === 'turn_end'));
  } finally {
    s.close();
  }
});

test('runner: with structured output the report is what the agent wrote after its last tool call', async () => {
  const { s } = session('hang');
  try {
    const assistant = (content: unknown[]) => s.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: content as never } });
    assistant([{ type: 'text', text: "I'll read calc.js first." }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'calc.js' } }]);
    assistant([{ type: 'text', text: '## Audit\n\n- div has no zero check.' }, { type: 'tool_use', id: 't2', name: 'StructuredOutput', input: { summary: 's', findings: [] } }]);
    let got: { report: string; structured?: unknown } | undefined;
    s.deliver = (r) => void (got = r);
    s.handle({ type: 'result', subtype: 'success', result: '{"summary":"s","findings":[]}', structured_output: { summary: 's', findings: [] }, num_turns: 2 });
    assert.equal(got!.report, '## Audit\n\n- div has no zero check.', 'no thinking aloud before a tool call');
    assert.deepEqual(got!.structured, { summary: 's', findings: [] });
  } finally {
    s.close();
  }
});

test('runner: stopping an agent stops what it started in the background too', { skip: process.platform === 'win32' }, async () => {
  const { s, items } = session('hang,child', 'start the dev server', 10000);
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 100 && !items.some((x) => x.type === 'text'); i++) await new Promise((r) => setTimeout(r, 20));
  const text = items.find((x) => x.type === 'text');
  const pid = Number(String(text && 'text' in text ? text.text : '').replace('child ', ''));
  assert.ok(pid > 0 && alive(pid), 'the agent started something');
  void s.interrupt();
  await s.turn();
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false, 'it went with the agent');
});

test('runner: a tool call reaches the UI and the transcript with its long strings cut, and saying how much was left out', () => {
  const big = 'x'.repeat(500000);
  const capped = capInput({ file_path: '/r/a.json', content: big, edits: [{ old_string: big, new_string: 'y' }] }) as { file_path: string; content: string; edits: { old_string: string; new_string: string }[] };
  assert.equal(capped.file_path, '/r/a.json');
  assert.ok(capped.content.length < 9000 && capped.content.endsWith('…(+492000 chars)'));
  assert.ok(capped.edits[0]!.old_string.length < 9000 && capped.edits[0]!.new_string === 'y');
});

test('runner: a working folder that is not there is said so, not taken for a missing CLI', async () => {
  const runner = new ClaudeRunner({ command: () => FAKE, flags: () => new Set(), settingSources: () => null, env: () => ({}) });
  await assert.rejects(runner.start({ agent: { instructions: '', model: 'inherit' }, prompt: 'x', cwd: path.join(__dirname, 'no-such-folder'), settings: {}, onOutput: () => {} }), /its working folder .*no-such-folder is not there/);
});

test("runner: a subagent's messages are a sign the session is alive, though they are not shown, and a message it cannot handle goes to the log", async () => {
  let alive = 0;
  const warnings: string[] = [];
  const items: TranscriptItem[] = [];
  const opts: RunnerOptions = { command: () => FAKE, flags: () => new Set(), settingSources: () => null, env: () => ({ FAKE_STREAM: 'uuids', FAKE_STREAM_DELAY: '10' }) };
  const s = new ClaudeSession({ agent: { model: 'sonnet', instructions: '' }, prompt: 'x', cwd: __dirname, settings: {}, onOutput: (i) => void items.push(i), onActivity: () => void alive++, onWarn: (m) => void warnings.push(m) }, opts);
  try {
    await s.turn();
    const before = { alive, items: items.length };
    s.handle({ type: 'assistant', parent_tool_use_id: 'toolu_task', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] } });
    assert.equal(alive, before.alive + 1, "the subagent's work counts for the watchdog");
    assert.equal(items.length, before.items, 'and is not shown as the agent\'s own');
    // A tool result whose content list holds a null: handling it throws, and the log says so once.
    s.proc.stdout.emit('data', `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'z', content: [null] }] } })}\n`);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not handle a message from Claude Code/);
  } finally {
    s.close();
  }
});
