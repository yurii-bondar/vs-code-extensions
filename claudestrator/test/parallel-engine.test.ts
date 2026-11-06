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
    // The other member works: the task shows signs of work all the time, its own session none.
    const busy = setInterval(() => engine.activity.set('T-1', Date.now()), 50);
    let interrupted = false;
    let end: (r: { ok: boolean; report: string }) => void = () => {};
    const turn = new Promise<{ ok: boolean; report: string }>((resolve) => (end = resolve));
    const session = { turn: () => turn, interrupt: async () => void ((interrupted = true), end({ ok: false, report: '' })) };
    const r = await engine.turnOf('T-1', session, '0007-security');
    clearInterval(busy);
    assert.ok(interrupted, 'its own silence counts, not the task\'s');
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
