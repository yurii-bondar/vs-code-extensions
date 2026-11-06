// End to end: a scenario's Parallel runs its reviewers at the same time, each in its own session, and a Branch after
// them runs only when its condition holds.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { workspace, harness, only, runTask } from './helpers/e2e';

const SCENARIO = `agents:
  security: { extends: reviewer, description: Security only }
  docs: { extends: developer, description: Writes the docs }
scenarios:
  ship:
    label: Ship
    agents:
      - developer
      - parallel: [reviewer, security]
      - branch:
          on: security
          if: { verdict: changes_requested }
          then: [docs]
`;

test('engine: the reviewers of a Parallel work at once, and the review loop judges both', async () => {
  const ws = workspace(['api'], SCENARIO);
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_REVIEW: 'fail-once' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature --repos api', scenario: 'ship' });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(s.checkpoint || h.engine.lastError(taskId)));

    const events = await h.engine.svc.events(taskId);
    const steps = events.filter((e) => e.type === 'stage_started' || e.type === 'stage_completed').map((e) => `${e.type === 'stage_started' ? '>' : '<'}${(e as { agent: string }).agent}`);
    // Round 1: both start before either ends; one of them asks for a fix, so the developer and both reviewers go again.
    const firstEnd = steps.findIndex((x) => x === '<reviewer' || x === '<security');
    assert.ok(steps.slice(0, firstEnd).includes('>reviewer') && steps.slice(0, firstEnd).includes('>security'), steps.join(' '));
    assert.equal(only(events, 'stage_started').filter((e) => e.agent === 'developer').length, 2, 'one fix round');
    assert.equal(only(events, 'stage_started').filter((e) => e.agent === 'security').length, 2);
    // Both approve in the end: the branch on security's changes is not taken.
    assert.equal(only(events, 'stage_started').filter((e) => e.agent === 'docs').length, 0);
    assert.equal(h.engine.sessions.size, 0, 'no session is left open');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a member of a group that hangs is stopped while the other one works, and the task shows both', async () => {
  const ws = workspace(['api'], SCENARIO);
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const engine = h.engine;
    engine.stallMs = 300;
    // The other member works, and so does a step of the same name in another task (the same transcript key there),
    // with a question of its own waiting for you: none of it is this session's sign of work.
    const mate = engine.emitter('T-1', '0006-reviewer');
    const elsewhere = engine.emitter('T-2', '0007-security');
    const busy = setInterval(() => {
      mate({ type: 'text_delta', text: '.' });
      elsewhere({ type: 'text_delta', text: '.' });
    }, 50);
    engine.permissions.set('r-mate', { request: { requestId: 'r-mate', taskId: 'T-1', agent: 'reviewer', tool: 'Bash', input: {}, at: 0 }, resolve: () => {} });
    let interrupted = false;
    let end: (r: { ok: boolean; report: string }) => void = () => {};
    const turn = new Promise<{ ok: boolean; report: string }>((resolve) => (end = resolve));
    const session = { turn: () => turn, interrupt: async () => void ((interrupted = true), end({ ok: false, report: '' })) };
    const r = await engine.turnOf('T-1', session, { key: '0007-security', step: { agent: 'security' } });
    clearInterval(busy);
    engine.permissions.delete('r-mate');
    assert.ok(interrupted, 'its own silence counts, not the other member\'s or the other task\'s');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /no sign of work/);

    engine.setMemberLive('T-1', 'reviewer', { phase: 'agent', text: 'reviewer is working', key: 'k1' });
    engine.setMemberLive('T-1', 'security', { phase: 'agent', text: 'security is working', key: 'k2' });
    assert.equal(engine.live('T-1')!.text, 'reviewer is working · security is working');
    engine.setMemberLive('T-1', 'reviewer', null);
    assert.equal(engine.live('T-1')!.text, 'security is working');
    engine.setMemberLive('T-1', 'security', null);
    assert.equal(engine.live('T-1'), null);
  } finally {
    h.hooks.dispose();
  }
});

test('engine: You approve after a Parallel shows every member\'s report under what to look at', async () => {
  const ws = workspace(['api'], SCENARIO.replace('      - parallel: [reviewer, security]\n', '      - parallel: [reviewer, security]\n      - approve: Read both reviews\n'));
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature --repos api', scenario: 'ship' });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'approve-step', JSON.stringify(s.checkpoint || h.engine.lastError(taskId)));
    assert.deepEqual(s.checkpoint!.options, ['approve', 'stop']);
    const ctx = await h.engine.checkpointContext(s, s.checkpoint);
    assert.match(ctx.text, /^\*\*Read both reviews\*\*/);
    assert.equal(ctx.text.split('\n\n---\n\n').length, 2, 'the reviewer\'s and security\'s');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a session of a parallel group that ends leaves the others their turn, their cost and their watch', async () => {
  const ws = workspace(['api'], SCENARIO);
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const engine = h.engine;
    const ends: ((r: { ok: boolean; report: string }) => void)[] = [];
    const session = () => ({ turn: () => new Promise<{ ok: boolean; report: string }>((resolve) => ends.push(resolve)), interrupt: async () => {} });
    const first = engine.turnOf('T-1', session(), { key: '0006-reviewer', step: { agent: 'reviewer' } });
    const second = engine.turnOf('T-1', session(), { key: '0007-security', step: { agent: 'security' } });
    assert.equal(engine.inTurn.get('T-1'), 2);
    ends[0]!({ ok: true, report: '' });
    await first;
    assert.ok(engine.inTurn.has('T-1'), 'security still works on its turn');
    ends[1]!({ ok: true, report: '' });
    await second;
    assert.equal(engine.inTurn.has('T-1'), false);

    engine.liveCost.set('T-1', new Map([['0006-reviewer', 0.5], ['0007-security', 0.25]]));
    engine.liveUsage.set('T-1', { type: 'usage', key: '0007-security', t: 0 } as never);
    engine.activity.set('T-1/0007-security', 1);
    engine.sessionEnded('T-1', '0006-reviewer');
    assert.deepEqual([...engine.liveCost.get('T-1')!], [['0007-security', 0.25]], 'its cost goes; the other one\'s stays');
    assert.equal(engine.liveUsage.get('T-1')!.key, '0007-security');
    assert.ok(engine.activity.has('T-1/0007-security'));
    engine.sessionEnded('T-1', '0007-security');
    assert.equal(engine.liveCost.has('T-1'), false);
    assert.equal(engine.liveUsage.has('T-1'), false);
    assert.equal(engine.activity.size, 0);
  } finally {
    h.hooks.dispose();
  }
});

