// A plan's question only the user can answer: the plan waits for the answer, approved by hand or not.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { transition } from '../src/core/machine';
import { buildPipeline } from '../src/core/pipeline';
import * as config from '../src/core/config';
import { parsePlanMeta } from '../src/core/protocol';
import { workspace, harness, runTask, waitFor } from './helpers/e2e';
import type { EventBody, OrchEvent, PlanMeta, Spec, TaskState } from '../src/core/types';

const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const spec: Spec = { id: 'T-1', source: { kind: 'text', text: 'x' }, title: 'x', description: 'x', acceptanceCriteria: [], links: [] };
const plan = (blocking: boolean): PlanMeta => ({ type: 'fix', slug: 'ante-consent', title: 'ante consent wording', repos: [{ name: 'api', mode: 'full' }], openQuestions: [{ question: 'Which wording did legal approve?', default: 'change nothing', ...(blocking && { blocking: true }) }] });

/** A task through its intake, of the built-in pipeline (`auto`: no plan approval), and a way to send it more events. */
function task(auto: boolean) {
  const r = config.resolveConfig([config.builtinLayer()]);
  assert.ok(r.ok);
  let s: TaskState | null = null;
  let n = 0;
  const apply = (e: EventBody): TaskState => {
    const t = transition(s, { ...e, at: at(++n) } as OrchEvent);
    assert.ok(t.ok, t.ok ? undefined : t.error.message);
    s = t.state;
    return t.state;
  };
  const reject = (e: EventBody): string => {
    const t = transition(s, { ...e, at: at(99) } as OrchEvent);
    assert.ok(!t.ok, 'expected the event to be refused');
    return t.error.code;
  };
  apply({ type: 'task_created', taskId: 'T-1', input: 'x', source: { kind: 'text', text: 'x' }, auto, pipeline: buildPipeline(r.config, { auto }), limits: { reviewRounds: 2, gateAttempts: 3 }, knownRepos: ['api'] });
  apply({ type: 'intake_completed', spec });
  apply({ type: 'stage_started', agent: 'planner' });
  return { apply, reject };
}

test('plan: a question is blocking only when the planner says so', () => {
  const r = parsePlanMeta({ type: 'fix', slug: 'x', repos: [{ name: 'api' }], openQuestions: [{ question: 'a', default: 'b', blocking: true }, { question: 'c', default: 'd', blocking: false }, { question: 'e', default: 'f' }] });
  assert.ok(r.ok);
  assert.deepEqual(r.value.openQuestions.map((q) => q.blocking ?? null), [true, null, null]);
  const planner = (() => {
    const c = config.resolveConfig([config.builtinLayer()]);
    assert.ok(c.ok);
    return c.config.agents.planner!.instructions;
  })();
  assert.match(planner, /Mark it "blocking": true when only the user can decide it/);
  assert.match(planner, /or when no default is safe to build on/);
});

test('machine: a plan with a question only you can answer is not approved as it is: your answer goes back to the planner', () => {
  const { apply, reject } = task(false);
  let s = apply({ type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: plan(true) });
  assert.equal(s.checkpoint!.id, 'approve-plan');
  assert.deepEqual(s.checkpoint!.options, ['change', 'stop']);
  assert.equal(reject({ type: 'checkpoint_answered', id: 'approve-plan', option: 'approve' }), 'invalid_option', 'approve is not an answer to it');
  s = apply({ type: 'checkpoint_answered', id: 'approve-plan', option: 'change', feedback: 'Legal approved: "Ante doubles your chance".' });
  assert.deepEqual(s.next, { stage: 0, agent: 'planner' });
  assert.equal(s.nextMode, 'replan');
  apply({ type: 'stage_started', agent: 'planner' });
  s = apply({ type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: plan(false) });
  assert.deepEqual(s.checkpoint!.options, ['approve', 'change', 'stop'], 'the plan with the answer is approved as usual');
});

test('machine: on auto, a plan waits only for a question only you can answer', () => {
  const blocked = task(true);
  let s = blocked.apply({ type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: plan(true) });
  assert.equal(s.checkpoint!.id, 'approve-plan', 'stops although nobody approves plans');
  assert.deepEqual(s.checkpoint!.options, ['change', 'stop']);
  const open = task(true);
  s = open.apply({ type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: plan(false) });
  assert.equal(s.checkpoint, null, 'a question with a default it can go on with does not stop it');
  assert.deepEqual(s.next, { stage: 1, agent: 'developer', repo: 'api' });
});

test('engine: a task on auto stops at a plan whose question only you can answer, and goes on with your answer', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_PLAN_BLOCKING: 'Which wording did legal approve?' });
  try {
    const { taskId } = await h.engine.start({ text: 'Change the Ante consent wording', auto: true });
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'approve-plan', JSON.stringify(h.engine.lastError(taskId)));
    assert.deepEqual(s.checkpoint!.options, ['change', 'stop']);
    assert.ok(!(await h.engine.svc.events(taskId)).some((e) => e.type === 'stage_started' && e.agent === 'developer'), 'no developer ran');
    await h.engine.answer(taskId, 'approve-plan', 'change', 'Legal approved: "Ante doubles your chance".');
    s = await waitFor(async () => {
      const st = await h.engine.svc.state(taskId);
      return !h.engine.isRunning(taskId) && st.checkpoint ? st : null;
    }, 60000);
    assert.equal(s.checkpoint!.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
  } finally {
    h.hooks.dispose();
  }
});
