// Parallel groups, branches and a scenario's own loop in the state machine: what may start, when the task moves on,
// which steps a branch skips, and that a log of them replays to the same state.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { transition, replay, nextAction, groupPending } from '../src/core/machine';
import { describeCondition, evaluate } from '../src/core/conditions';
import type { EventBody, OrchEvent, Spec, Stage, StoredPipeline, TaskState } from '../src/core/types';

const at = (i: number): string => new Date(Date.UTC(2026, 10, 6, 12, 0, i)).toISOString();
const spec: Spec = { id: 'T-1', source: { kind: 'text', text: 'x' }, title: 'x', description: 'x', acceptanceCriteria: [], links: [] };
const st = (agent: string, output: Stage['output'], extra: Partial<Stage> = {}): Stage => ({ agent, output, scope: output === 'code' ? 'repo' : 'task', approval: false, ...extra });
const approved = { status: 'approved' as const, summary: 'ok', findings: [] };
const changes = { status: 'changes_requested' as const, summary: 'no', findings: [{ severity: 'major' as const, repo: 'api', problem: 'p' }] };

/** A task driven event by event: each must apply, and the events are kept to replay. */
function task(pipeline: StoredPipeline) {
  const events: OrchEvent[] = [];
  let s: TaskState | null = null;
  const apply = (e: EventBody): TaskState => {
    const ev = { ...e, at: at(events.length) } as OrchEvent;
    const r = transition(s, ev);
    assert.ok(r.ok, `${e.type} ${JSON.stringify(e).slice(0, 120)}: ${r.ok ? '' : r.error.message}`);
    events.push(ev);
    s = r.state;
    return s;
  };
  const refused = (e: EventBody): string => {
    const r = transition(s, { ...e, at: at(events.length) } as OrchEvent);
    assert.ok(!r.ok, `${e.type} should be refused`);
    return r.error.code;
  };
  apply({ type: 'task_created', taskId: 'T-1', input: 'x', source: { kind: 'text', text: 'x' }, auto: false, pipeline, limits: { reviewRounds: 2, gateAttempts: 3 }, knownRepos: ['api'] });
  apply({ type: 'intake_completed', spec, repos: [{ name: 'api', mode: 'full' }] });
  return { apply, refused, state: () => s!, events };
}

const REVIEWED: StoredPipeline = {
  mode: 'custom',
  stages: [st('developer', 'code'), st('reviewer', 'verdict', { group: 1 }), st('security', 'verdict', { group: 1 })],
  reviewLoop: { restartAt: 0, end: 2, fixers: ['developer'], reviewers: ['reviewer', 'security'], maxRounds: 2 },
};

test('parallel: the members of a group start in any order and the round is judged when the last one ends', () => {
  const t = task(REVIEWED);
  t.apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  t.apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'd', gates: 'pass' });
  assert.equal(t.state().next!.agent, 'reviewer');
  assert.deepEqual(groupPending(t.state()).map((m) => m.agent), ['reviewer', 'security']);
  t.apply({ type: 'stage_started', agent: 'security' });
  t.apply({ type: 'stage_started', agent: 'reviewer' });
  assert.deepEqual(t.state().running.map((r) => r.agent), ['security', 'reviewer']);
  assert.equal(t.refused({ type: 'stage_started', agent: 'developer', repo: 'api' }), 'already_running');

  t.apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'r1', verdict: approved });
  assert.equal(t.state().next, null, 'the group is not through while security reviews');
  assert.equal(nextAction(t.state()).kind, 'running');
  t.apply({ type: 'stage_completed', agent: 'security', artifact: 's1', verdict: changes });
  const s = t.state();
  assert.equal(s.review.round, 2, 'one blocking finding of either sends the work back');
  assert.equal(s.next!.agent, 'developer');
  assert.equal(s.parallel, undefined);
  assert.deepEqual(replay(t.events), s);
});

test('parallel: a member that fails is asked about once the others end, and its retry alone runs again', () => {
  const t = task(REVIEWED);
  t.apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  t.apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'd', gates: 'pass' });
  t.apply({ type: 'stage_started', agent: 'reviewer' });
  t.apply({ type: 'stage_started', agent: 'security' });
  t.apply({ type: 'stage_failed', agent: 'reviewer', error: 'the API went away' });
  assert.equal(t.state().checkpoint, null, 'security is still reviewing');
  t.apply({ type: 'stage_completed', agent: 'security', artifact: 's1', verdict: approved });
  assert.equal(t.state().checkpoint!.id, 'agent-failure');
  assert.equal(t.state().checkpoint!.step!.agent, 'reviewer');
  t.apply({ type: 'checkpoint_answered', id: 'agent-failure', option: 'retry' });
  assert.equal(t.state().next!.agent, 'reviewer');
  assert.deepEqual(groupPending(t.state()).map((m) => m.agent), [], 'security is done: it does not run again');
  t.apply({ type: 'stage_started', agent: 'reviewer' });
  t.apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'r1', verdict: approved });
  assert.equal(t.state().phase, 'finish', 'both approved: the loop is left');
  assert.deepEqual(replay(t.events), t.state());
});

test('parallel: a member that never started (the task stopped first) runs when the others end', () => {
  const t = task(REVIEWED);
  t.apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  t.apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'd', gates: 'pass' });
  t.apply({ type: 'stage_started', agent: 'reviewer' });
  t.apply({ type: 'stopped', reason: 'you' });
  t.apply({ type: 'resumed' });
  assert.deepEqual(groupPending(t.state()).map((m) => m.agent), ['security'], 'it may start next to the one that runs again');
  t.apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'r1', verdict: approved });
  assert.equal(t.state().next!.agent, 'security');
  t.apply({ type: 'stage_started', agent: 'security' });
  t.apply({ type: 'stage_completed', agent: 'security', artifact: 's1', verdict: approved });
  assert.equal(t.state().phase, 'finish');
});

const BRANCHED: StoredPipeline = {
  mode: 'custom',
  stages: [
    st('developer', 'code'),
    st('reviewer', 'verdict'),
    st('fixer', 'code', { when: { on: 'reviewer', if: { severity: 'major' } } }),
    st('notes', 'verdict', { when: { on: 'reviewer', if: { severity: 'major' }, else: true } }),
    st('closing', 'verdict'),
  ],
  reviewLoop: null,
};

test('branch: the steps of the arm whose condition holds run, the others are skipped', () => {
  for (const [verdict, ran] of [
    [changes, ['fixer', 'closing']],
    [approved, ['notes', 'closing']],
  ] as const) {
    const t = task(BRANCHED);
    t.apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
    t.apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'd', gates: 'pass' });
    t.apply({ type: 'stage_started', agent: 'reviewer' });
    t.apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'r', verdict });
    const order: string[] = [];
    while (t.state().phase === 'stages') {
      const next = t.state().next!;
      order.push(next.agent);
      t.apply({ type: 'stage_started', agent: next.agent, ...(next.repo && { repo: next.repo }) });
      t.apply({ type: 'stage_completed', agent: next.agent, ...(next.repo && { repo: next.repo }), artifact: next.agent, ...(next.repo ? { gates: 'pass' as const } : { verdict: approved }) });
    }
    assert.deepEqual(order, ran);
    assert.equal(t.refused({ type: 'stage_started', agent: ran[0] === 'fixer' ? 'notes' : 'fixer' }), 'not_in_stages', 'a skipped step does not run later');
    assert.deepEqual(replay(t.events), t.state());
  }
});

test('branch: conditions read the latest result of the step they name; nothing reported yet holds nothing', () => {
  const s = task(BRANCHED).state();
  assert.equal(evaluate(s, 'reviewer', { verdict: 'approved' }), null);
  const withReports = {
    ...s,
    review: { ...s.review, lastVerdicts: [{ agent: 'reviewer', artifact: 'r', status: 'approved' as const, findings: [{ severity: 'minor' as const, problem: 'p' }] }] },
    reports: [
      { agent: 'verifier', output: 'readiness' as const, artifact: 'v', value: { summary: '', verdict: 'not_ready' as const, criteria: [] } },
      { agent: 'auditor', output: 'audit' as const, artifact: 'a', value: { summary: '', scope: [], findings: [{ severity: 'high' as const, title: 't', problem: 'p' }] } },
    ],
    artifacts: [{ agent: 'developer', round: 1, output: 'code' as const, path: 'd', at: at(0) }],
    gateFailures: [{ stage: 0, agent: 'developer', repo: 'api' }],
  } as TaskState;
  assert.equal(evaluate(withReports, 'reviewer', { verdict: 'approved' }), true);
  assert.equal(evaluate(withReports, 'reviewer', { severity: 'minor' }), true);
  assert.equal(evaluate(withReports, 'reviewer', { severity: 'major' }), false);
  assert.equal(evaluate(withReports, 'verifier', { readiness: 'not_ready' }), true);
  assert.equal(evaluate(withReports, 'auditor', { audit: 'medium' }), true);
  assert.equal(evaluate(withReports, 'auditor', { audit: 'critical' }), false);
  assert.equal(evaluate(withReports, 'developer', { gates: 'fail' }), true);
  assert.equal(describeCondition('reviewer', { severity: 'major' }), 'reviewer found major or worse');
});

test('loop: a scenario\'s own loop runs its rounds, the one outputs make runs the limit', () => {
  const own = task({ ...REVIEWED, reviewLoop: { ...REVIEWED.reviewLoop!, maxRounds: 4, explicit: true } }).state();
  assert.equal(own.review.maxRounds, 4);
  assert.equal(task(REVIEWED).state().review.maxRounds, 2);
});

test('you approve: the task waits after the step, goes on once you approve, and runs it again with your words', () => {
  const t = task({ mode: 'custom', stages: [st('developer', 'code', { approve: { text: 'Look at the migration' } }), st('reviewer', 'verdict')], reviewLoop: null });
  t.apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  t.apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'd', gates: 'pass' });
  assert.equal(t.state().checkpoint!.id, 'approve-step');
  assert.deepEqual(t.state().checkpoint!.options, ['approve', 'retry', 'stop']);
  t.apply({ type: 'checkpoint_answered', id: 'approve-step', option: 'retry', feedback: 'keep the old column' });
  assert.equal(t.state().next!.agent, 'developer');
  assert.equal(t.state().nextMode, 'retry');
  assert.equal(t.state().feedback, 'keep the old column');
  t.apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  t.apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'd2', gates: 'pass' });
  t.apply({ type: 'checkpoint_answered', id: 'approve-step', option: 'approve' });
  assert.equal(t.state().next!.agent, 'reviewer');
  assert.deepEqual(replay(t.events), t.state());
});

test('you approve: after a Parallel that ends the loop, once both approved; the group does not run again on its own', () => {
  const pipeline = { ...REVIEWED, stages: REVIEWED.stages.map((s) => (s.agent === 'security' ? { ...s, approve: {} } : s)) };
  const t = task(pipeline);
  t.apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  t.apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'd', gates: 'pass' });
  t.apply({ type: 'stage_started', agent: 'reviewer' });
  t.apply({ type: 'stage_started', agent: 'security' });
  t.apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'r', verdict: approved });
  assert.equal(t.state().checkpoint, null);
  t.apply({ type: 'stage_completed', agent: 'security', artifact: 's', verdict: approved });
  assert.equal(t.state().checkpoint!.id, 'approve-step');
  assert.deepEqual(t.state().checkpoint!.options, ['approve', 'stop'], 'a member alone does not run again');
  t.apply({ type: 'checkpoint_answered', id: 'approve-step', option: 'approve' });
  assert.equal(t.state().phase, 'finish');
  assert.deepEqual(replay(t.events), t.state());
});
