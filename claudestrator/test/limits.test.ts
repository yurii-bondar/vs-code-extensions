// What the engine does when the account's usage limit is used up, and when too many tasks would run at once.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { statuslineSnapshot } from '../src/core/env';
import { workspace, harness, waitFor } from './helpers/e2e';

test('limits: no agent starts while Claude Code reports the account limit as used up', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    h.engine.limits = { fiveHour: { pct: 100, resetsAt, status: 'rejected' }, sevenDay: { pct: 40, resetsAt: resetsAt + 86400, status: 'allowed' }, at: Date.now() };
    const { taskId } = await h.engine.start({ text: 'Do a thing' });
    h.engine.launch(taskId);
    const err = await waitFor(async () => h.engine.lastError(taskId));
    assert.equal(err.code, 'limit_reached');
    assert.match(err.message, /5-hour limit is used up until .*; resume the task then/);
    assert.ok(!fs.existsSync(path.join(h.state, 'calls.ndjson')), 'no Claude Code session was started');

    // Once the window has reset, the same task runs.
    h.engine.limits = { fiveHour: { pct: 100, resetsAt: Math.round(Date.now() / 1000) - 1, status: 'rejected' }, sevenDay: undefined, at: Date.now() };
    const s = await h.engine.run(taskId);
    assert.equal(s!.checkpoint!.id, 'approve-plan');
  } finally {
    h.hooks.dispose();
  }
});

test("limits: one account's used-up window does not hold back agents of another", async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const opts = (h.engine.runner as unknown as { opts: { env: () => NodeJS.ProcessEnv } }).opts;
    opts.env = () => ({ CLAUDE_CONFIG_DIR: '/accounts/work' });
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    h.engine.limits = { fiveHour: { pct: 100, resetsAt, status: 'rejected' }, sevenDay: undefined, at: Date.now() };
    // You switch to your other account in the header.
    opts.env = () => ({ CLAUDE_CONFIG_DIR: '/accounts/personal' });
    const limitsNow = () => h.engine.limits;
    assert.equal(limitsNow(), null);
    const { taskId } = await h.engine.start({ text: 'Do a thing' });
    const s = await h.engine.run(taskId);
    assert.equal(s!.checkpoint!.id, 'approve-plan', JSON.stringify(h.engine.lastError(taskId)));
    opts.env = () => ({ CLAUDE_CONFIG_DIR: '/accounts/work' });
    assert.equal(limitsNow()!.fiveHour!.status, 'rejected', 'the first account still waits for its reset');
  } finally {
    h.hooks.dispose();
  }
});

test('limits: limits.parallelTasks keeps one more task from starting', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\ngit: { mode: worktree }\nlimits: { parallelTasks: 1 }\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const a = (await h.engine.start({ text: 'First thing' })).taskId;
    const b = (await h.engine.start({ text: 'Second thing' })).taskId;
    h.engine.running.add(a);
    await assert.rejects(h.engine.run(b), (e: Error & { code?: string }) => e.code === 'busy' && /limits\.parallelTasks \(1\)/.test(e.message));
    h.engine.running.delete(a);
    const s = await h.engine.run(b);
    assert.equal(s!.checkpoint!.id, 'approve-plan', 'with room again it runs');
  } finally {
    h.hooks.dispose();
  }
});

test("limits: the status line's snapshots are looked for no more than every few seconds", async () => {
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-acct-'));
  fs.mkdirSync(path.join(account, 'statusline'));
  const write = (pct: number): void => fs.writeFileSync(path.join(account, 'statusline', 's1.json'), JSON.stringify({ five_hour: { used_percentage: pct, resets_at: 1900000000 }, updated_at: 1800000000 }));
  write(10);
  const t = 1_000_000;
  assert.equal((await statuslineSnapshot(account, t))!.fiveHour!.pct, 10);
  write(55);
  assert.equal((await statuslineSnapshot(account, t + 1000))!.fiveHour!.pct, 10, 'a refresh a second later reads nothing');
  assert.equal((await statuslineSnapshot(account, t + 6000))!.fiveHour!.pct, 55, 'a few seconds later it looks again');
});
