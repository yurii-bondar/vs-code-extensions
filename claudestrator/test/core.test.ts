import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import os from 'os';
import * as path from 'path';

import { transition, replay, nextAction, passSteps, stepRepos, editableFrom, runOf as rerunOf } from '../src/core/machine';
import { buildPipeline, outline, taskPipeline } from '../src/core/pipeline';
import * as config from '../src/core/config';
import * as backups from '../src/core/backup';
import * as libraries from '../src/core/library';
import { buildAgentPrompt, parseStageReport, reportLanguage } from '../src/core/prompt';
import { guardBash } from '../src/core/guard';
import { readJsonFresh } from '../src/core/env';
import { GitRepo, exec } from '../src/core/git';
import { parseHookRequest } from '../src/core/hookserver';
import { plain } from '../src/core/gates';
import { parseInvocation, storageToText, classifyInput, extractAcceptanceCriteria, adfToText, detectScenario } from '../src/core/intake';
import { TaskService } from '../src/core/store';
import { stepsOf, summary, queueOutput } from '../src/core/view';
import type { OutputPush } from '../src/core/view';
import type { ViewEngine } from '../src/core/view';
import { buildArgs, limitsOf, sameWindows } from '../src/core/runner';
import { Engine } from '../src/core/engine';
import { resolveDefaults, effectiveFor, modelName } from '../src/core/defaults';
import * as mcp from '../src/core/mcp';
import { findRepos, reposFromFolders, repoLayerOf } from '../src/core/setup';
import { execFileSync } from 'child_process';
import { parseReadiness, parseAudit, parsePlanMeta, validateSetting, validateConfigLayer } from '../src/core/protocol';
import { renderReport, jiraText } from '../src/core/report';
import type { Agent, Config, EventBody, EventOf, OrchEvent, Output, PlanMeta, PlanRepo, Source, Spec, StoredPipeline, TaskState } from '../src/core/types';
import type { GuardContext, GuardVerdict } from '../src/core/guard';
import type { NextAction, RunAction } from '../src/core/machine';
import type { ConfigLayer, Layer } from '../src/core/config';
import type { RunnerOptions } from '../src/core/runner';
import type { ComposerArgs, EngineOptions } from '../src/core/engine';

const tr = (s: TaskState | null, e: OrchEvent) => transition(s, e);
const nx = (s: TaskState) => nextAction(s);
const rpl = (events: OrchEvent[]) => replay(events);
const resolve = (...a: Parameters<typeof config.resolveConfig>) => config.resolveConfig(...a);
const loadCfg = (a: Parameters<typeof config.loadConfig>[0]) => config.loadConfig(a);
const report = (output: Output, text: string) => parseStageReport(output, text);

test('stages only agents read report in English, the rest in the task language', async () => {
  for (const output of ['code', 'tests', 'verdict'] as Output[]) assert.equal(reportLanguage(output, 'Ukrainian'), 'English');
  for (const output of ['plan', 'readiness', 'audit'] as Output[]) assert.equal(reportLanguage(output, 'Ukrainian'), 'Ukrainian');
});
const guard = (command: string, ctx: GuardContext) => guardBash(command, ctx);
const bp = (c: Config, o?: Parameters<typeof buildPipeline>[1]) => buildPipeline(c, o);
const pr = (v: unknown) => parseReadiness(v);
const pa = (v: unknown) => parseAudit(v);
const classify = (input: string, o?: Parameters<typeof classifyInput>[1]) => classifyInput(input, o);

/** Narrows a `{ ok }` result to its success variant; the test fails, printing the result, if it is not one. */
function passed<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.ok(r.ok, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** Narrows a `{ ok }` result to its failure variant; the test fails if it succeeded. */
function failed<T extends { ok: boolean }>(r: T): Extract<T, { ok: false }> {
  assert.equal(r.ok, false, 'expected a failure');
  return r as Extract<T, { ok: false }>;
}

/** Narrows the next action to a run; the test fails if it is anything else. */
function runOf(a: NextAction): RunAction {
  assert.equal(a.kind, 'run');
  return a as RunAction;
}

/** The guard's refusal; the test fails if the command was allowed. */
function denied(v: GuardVerdict): Extract<GuardVerdict, { allow: false }> {
  assert.equal(v.allow, false, 'expected the guard to refuse');
  return v as Extract<GuardVerdict, { allow: false }>;
}

/** What the composer's preview says about a valid input; the test fails for an empty or rejected one. */
async function previewOf(engine: Engine, args: ComposerArgs) {
  const p = await engine.preview(args);
  assert.ok(p.ok && !('empty' in p), JSON.stringify(p));
  return p as Extract<typeof p, { pipeline: unknown }>;
}

/** Events as they are logged: stamped one second apart. */
const timed = (events: EventBody[]): OrchEvent[] => events.map((e, i) => ({ ...e, at: at(i) }) as OrchEvent);

/** A partial task state, as far as `renderReport` and `jiraText` read it. */
const asState = (partial: unknown) => partial as TaskState;

const layer = (c: ConfigLayer): Layer => ({ name: 'project', baseDir: '/ws/.claudestrator', config: c });

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function defaultPipeline(opts?: Parameters<typeof buildPipeline>[1]) {
  const r = passed(resolve([config.builtinLayer()]));
  return { config: r.config, pipeline: bp(r.config, opts) };
}

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function createdEvent(pipeline: StoredPipeline, { source = { kind: 'text', text: 'x' }, knownRepos = ['api', 'web'] }: { source?: Source; knownRepos?: string[] } = {}): EventOf<'task_created'> {
  return { type: 'task_created', taskId: 'T-1', input: 'x', source, auto: false, pipeline, limits: { reviewRounds: 2, gateAttempts: 3 }, knownRepos, at: at(0) };
}

const PLAN: PlanMeta = { type: 'feat', slug: 'max-bet', title: 'add max bet', repos: [{ name: 'api', mode: 'full' }, { name: 'web', mode: 'full' }], openQuestions: [] };
const spec: Spec = { id: 'T-1', source: { kind: 'text', text: 'x' }, title: 'x', description: 'x', acceptanceCriteria: [], links: [] };

test('pipeline: the built-in agents make a full pipeline with a review loop', async () => {
  const { pipeline } = defaultPipeline();
  assert.equal(pipeline.mode, 'full');
  assert.deepEqual(pipeline.stages.map((s) => [s.agent, s.scope, s.approval]), [
    ['planner', 'task', true],
    ['developer', 'repo', false],
    ['tester', 'repos', false],
    ['reviewer', 'task', false],
  ]);
  assert.deepEqual(pipeline.reviewLoop, { restartAt: 1, end: 3, fixers: ['developer', 'tester'], reviewers: ['reviewer'], maxRounds: 2 });
  assert.deepEqual(outline(pipeline).map((o) => o.kind), ['stage', 'human', 'loop-start', 'repo-block', 'stage', 'stage', 'loop-end', 'finish', 'human', 'finish']);
  assert.equal(bp(defaultPipeline().config, { auto: true }).stages[0]!.approval, false);
});

test('machine: plan → approval → per-repo work → review fix round → commit → push', async () => {
  const { pipeline } = defaultPipeline();
  let s: TaskState | null = null;
  let n = 0;
  const apply = (e: EventBody): TaskState => {
    const r = tr(s, { ...e, at: at(++n) } as OrchEvent);
    assert.ok(r.ok, r.ok ? undefined : r.error.message);
    s = r.state;
    return r.state;
  };
  apply(createdEvent(pipeline));
  assert.equal(nx(s!).kind, 'intake');
  apply({ type: 'intake_completed', spec });
  assert.deepEqual(s!.next, { stage: 0, agent: 'planner' });

  // Out-of-order events are rejected.
  assert.equal(tr(s, { type: 'stage_started', agent: 'developer', repo: 'api', at: at(99) }).ok, false);

  apply({ type: 'stage_started', agent: 'planner' });
  assert.equal(failed(tr(s, { type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', at: at(99) })).error.code, 'plan_meta_required');
  apply({ type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: PLAN });
  assert.equal(s!.status, 'waiting');
  assert.deepEqual(s!.checkpoint!.options, ['approve', 'change', 'stop'], 'jira-only options are dropped for text tasks');
  assert.equal(failed(tr(s, { type: 'stage_started', agent: 'developer', repo: 'api', at: at(99) })).error.code, 'awaiting_checkpoint');

  apply({ type: 'checkpoint_answered', id: 'approve-plan', option: 'approve' });
  // The developer works repo by repo, then one tester covers every repo.
  assert.deepEqual(passSteps(s!).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'developer@api', 'developer@web', 'tester@', 'reviewer@']);
  for (const repo of ['api', 'web']) {
    apply({ type: 'stage_started', agent: 'developer', repo });
    apply({ type: 'stage_completed', agent: 'developer', repo, artifact: `reports/r1/developer-${repo}.md`, gates: 'pass' });
  }
  apply({ type: 'stage_started', agent: 'tester' });
  assert.equal(runOf(nx({ ...s!, running: null, next: s!.running })).artifact, 'reports/r1/tester.md');
  assert.ok(['reports/r1/developer-api.md', 'reports/r1/developer-web.md'].every((f) => runOf(nx({ ...s!, running: null, next: s!.running })).inputs.includes(f)), 'the tester reads every developer report');
  apply({ type: 'stage_completed', agent: 'tester', artifact: 'reports/r1/tester.md', gates: 'pass' });
  apply({ type: 'stage_started', agent: 'reviewer' });
  apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'reviews/r1/reviewer.md', verdict: { status: 'changes_requested', summary: 'x', findings: [{ severity: 'major', repo: 'web', problem: 'no test' }, { severity: 'minor', problem: 'naming' }] } });
  // Fix round 2 targets only the repo with blocking findings.
  assert.equal(s!.review.round, 2);
  assert.deepEqual(s!.review.fixRepos, ['web']);
  const run = runOf(nx(s!));
  assert.equal(run.mode, 'fix');
  assert.ok(run.inputs.includes('reviews/r1/reviewer.md'));
  apply({ type: 'stage_started', agent: 'developer', repo: 'web' });
  apply({ type: 'stage_completed', agent: 'developer', repo: 'web', artifact: 'reports/r2/developer-web.md', gates: 'pass' });
  assert.deepEqual(stepRepos(s!, s!.next!), ['web'], 'in a fix round the tester covers only the repos sent back');
  apply({ type: 'stage_started', agent: 'tester' });
  apply({ type: 'stage_completed', agent: 'tester', artifact: 'reports/r2/tester.md', gates: 'pass' });
  apply({ type: 'stage_started', agent: 'reviewer' });
  apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'reviews/r2/reviewer.md', verdict: { status: 'approved', summary: 'ok', findings: [{ severity: 'minor', repo: 'web', problem: 'typo' }] } });
  assert.equal(s!.phase, 'finish');
  assert.equal(nx(s!).kind, 'commit');
  assert.equal(s!.review.openFindings.length, 1);

  assert.equal(failed(tr(s, { type: 'published', prs: {}, at: at(99) })).error.code, 'push_not_confirmed');
  apply({ type: 'committed', repos: ['api', 'web'] });
  assert.equal(s!.checkpoint!.id, 'confirm-push');
  apply({ type: 'checkpoint_answered', id: 'confirm-push', option: 'push' });
  assert.equal(nx(s!).kind, 'publish');
  apply({ type: 'published', prs: { api: 'https://x/1', web: 'https://x/2' } });
  assert.equal(s!.status, 'done');
  assert.equal(s!.outcome, 'published');
});

test('machine: without configured repos a plan may only name plain folders of the workspace', async () => {
  const { pipeline } = defaultPipeline();
  const planWith = (name: string) => {
    const s = rpl(timed([createdEvent(pipeline, { knownRepos: [] }), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }]));
    return tr(s, { type: 'stage_completed', agent: 'planner', artifact: 'p', plan: { ...PLAN, repos: [{ name, mode: 'full' }] }, at: at(50) });
  };
  for (const name of ['api', 'web-app', 'billing_v2', 'repo.js']) assert.ok(planWith(name).ok, name);
  for (const name of ['../other', '/Users/me/dotfiles', 'a/b', '..', '.hidden', 'x..y']) assert.equal(failed(planWith(name)).error.code, 'unknown_repo', name);
});

test('git: what a task branch publishes does not depend on what is checked out', async () => {
  const dir = tmp('cs-branch-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('switch', '-q', '-c', 'feat/x');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'work');
  git('switch', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'other work on main\n');
  const repo = new GitRepo(dir);
  assert.deepEqual(await repo.branchChanges('main', 'feat/x'), ['b.txt'], 'the task branch changes b.txt, though main is checked out');
  assert.deepEqual(await repo.changedFiles('main'), ['c.txt'], 'HEAD-based diff would have seen only what is on main');
  assert.deepEqual(await repo.branchChanges('main', 'main'), []);
  assert.match(git('log', '--format=%s', `${await repo.baseRef('main', 'feat/x')}..feat/x`), /work/);
});

test('machine: a plan that names a repo twice runs its step once', async () => {
  const { pipeline } = defaultPipeline();
  const twice: PlanMeta = { ...PLAN, repos: [{ name: 'api', mode: 'full' }, { name: 'api', mode: 'full' }] };
  assert.ok(!parsePlanMeta(twice).ok, 'the engine has the planner correct it');
  // Recorded anyway (an older task, another tool): the machine takes each repo once.
  const s = rpl(timed([createdEvent(pipeline), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_completed', agent: 'planner', artifact: 'p', plan: twice }]));
  assert.deepEqual(s.repos.map((r) => r.name), ['api']);
  assert.deepEqual(passSteps(s).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'developer@api', 'tester@', 'reviewer@']);
});

test('machine: review limit, stop keeps the question, resume asks again', async () => {
  const { pipeline } = defaultPipeline();
  const events: EventBody[] = [createdEvent(pipeline, { knownRepos: [] }), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_completed', agent: 'planner', artifact: 'p', plan: { ...PLAN, repos: [{ name: 'api', mode: 'full' }] } }];
  events.push({ type: 'checkpoint_answered', id: 'approve-plan', option: 'stop' });
  let s = rpl(timed(events));
  assert.equal(s.status, 'stopped');
  assert.equal(nx(s).kind, 'stopped');
  s = passed(tr(s, { type: 'resumed', at: at(50) })).state;
  assert.equal(s.status, 'waiting');
  assert.equal(s.checkpoint!.id, 'approve-plan');
});

/** A one-repo task whose reviewer asks for changes in every round; `emptyDiffs[i]` says whether round i + 1 had nothing to review. */
function reviewedRounds(emptyDiffs: boolean[], reviewRounds: number): TaskState {
  const { pipeline } = defaultPipeline();
  const events: EventBody[] = [
    { ...createdEvent(pipeline, { knownRepos: [] }), limits: { reviewRounds, gateAttempts: 3 } },
    { type: 'intake_completed', spec },
    { type: 'stage_started', agent: 'planner' },
    { type: 'stage_completed', agent: 'planner', artifact: 'p', plan: { ...PLAN, repos: [{ name: 'api', mode: 'full' }] } },
    { type: 'checkpoint_answered', id: 'approve-plan', option: 'approve' },
  ];
  emptyDiffs.forEach((empty, i) => {
    const r = i + 1;
    events.push(
      { type: 'stage_started', agent: 'developer', repo: 'api' },
      { type: 'stage_completed', agent: 'developer', repo: 'api', artifact: `reports/r${r}/developer-api.md`, gates: 'pass' },
      { type: 'stage_started', agent: 'tester' },
      { type: 'stage_completed', agent: 'tester', artifact: `reports/r${r}/tester.md`, gates: 'pass' },
      { type: 'stage_started', agent: 'reviewer' },
      { type: 'stage_completed', agent: 'reviewer', artifact: `reviews/r${r}/reviewer.md`, verdict: { status: 'changes_requested', summary: 'x', findings: [{ severity: 'major', repo: 'api', problem: 'nothing is implemented' }] }, ...(empty && { emptyDiff: true }) },
    );
  });
  return rpl(timed(events));
}

test('machine: your feedback stays with a step run again after a Stop, and reaches every step of the fix round', async () => {
  const { pipeline } = defaultPipeline();
  const planned: EventBody[] = [
    createdEvent(pipeline, { knownRepos: [] }),
    { type: 'intake_completed', spec },
    { type: 'stage_started', agent: 'planner' },
    { type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: { ...PLAN, repos: [{ name: 'api', mode: 'full' }, { name: 'web', mode: 'full' }] } },
  ];
  // "Request changes", the planner starts, Stop, resume: it runs again with the feedback.
  const s = rpl(timed([...planned, { type: 'checkpoint_answered', id: 'approve-plan', option: 'change', feedback: 'split it in two' }, { type: 'stage_started', agent: 'planner' }, { type: 'stopped', reason: 'x' }, { type: 'resumed' }]));
  const again = rerunOf(s, s.running!);
  assert.deepEqual([again.mode, again.feedback], ['replan', 'split it in two']);
  assert.ok(again.inputs.includes('plan/planner.md'), 'and its previous plan');

  // "Priorities for the fix round" (at the round limit, "retry" with them): every step of the round gets them.
  const finding = (repo: string) => ({ severity: 'major' as const, repo, problem: 'x' });
  const limited = rpl(timed([
    { ...createdEvent(pipeline, { knownRepos: [] }), limits: { reviewRounds: 1, gateAttempts: 3 } },
    ...planned.slice(1),
    { type: 'checkpoint_answered', id: 'approve-plan', option: 'approve' },
    { type: 'stage_started', agent: 'developer', repo: 'api' }, { type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'reports/r1/developer-api.md', gates: 'pass' },
    { type: 'stage_started', agent: 'developer', repo: 'web' }, { type: 'stage_completed', agent: 'developer', repo: 'web', artifact: 'reports/r1/developer-web.md', gates: 'pass' },
    { type: 'stage_started', agent: 'tester' }, { type: 'stage_completed', agent: 'tester', artifact: 'reports/r1/tester.md', gates: 'pass' },
    { type: 'stage_started', agent: 'reviewer' }, { type: 'stage_completed', agent: 'reviewer', artifact: 'reviews/r1/reviewer.md', verdict: { status: 'changes_requested', summary: 'x', findings: [finding('api'), finding('web')] } },
    { type: 'checkpoint_answered', id: 'review-limit', option: 'retry', feedback: 'performance first' },
    { type: 'stage_started', agent: 'developer', repo: 'api' }, { type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'reports/r2/developer-api.md', gates: 'pass' },
  ]));
  const next = nx(limited) as RunAction;
  assert.deepEqual([next.step.agent, next.step.repo, next.mode, next.feedback], ['developer', 'web', 'fix', 'performance first'], 'the second repo of the round too');
  assert.ok(next.inputs.includes('reviews/r1/reviewer.md'));

  // A fix-round step that failed and is retried still reads the findings it fixes.
  const retried = passed(tr(passed(tr(limited, { type: 'stage_started', agent: 'developer', repo: 'web', at: at(90) } as OrchEvent)).state, { type: 'stage_failed', agent: 'developer', repo: 'web', error: 'maxTurns', at: at(91) } as OrchEvent)).state;
  const retry = nx(passed(tr(retried, { type: 'checkpoint_answered', id: 'agent-failure', option: 'retry', at: at(92) } as OrchEvent)).state) as RunAction;
  assert.equal(retry.mode, 'retry');
  assert.ok(retry.inputs.includes('reviews/r1/reviewer.md'), 'the findings are among its inputs');
});

test('machine: the review of a later round reads the one before it, to check its findings first', async () => {
  let s = reviewedRounds([false], 3);
  for (const e of [
    { type: 'stage_started', agent: 'developer', repo: 'api' },
    { type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'reports/r2/developer-api.md', gates: 'pass' },
    { type: 'stage_started', agent: 'tester' },
    { type: 'stage_completed', agent: 'tester', artifact: 'reports/r2/tester.md', gates: 'pass' },
  ] as EventBody[]) s = passed(tr(s, { ...e, at: at(80) } as OrchEvent)).state;
  const review = runOf(nx(s));
  assert.deepEqual([review.step.agent, review.round], ['reviewer', 2]);
  assert.ok(review.inputs.includes('reviews/r1/reviewer.md'), review.inputs.join(', '));
  const prompt = buildAgentPrompt({ state: s, next: review, taskDir: '/ws/.orch/tasks/T-1', language: 'English' });
  assert.match(prompt, /review round 2: the previous round's review is among the inputs\. Check first that each of its blocker and major findings is fixed/);
});

test('machine: two review rounds in a row with an empty diff stop the loop before the round limit', async () => {
  // The limit would allow five rounds; the agents changed nothing twice, so a third fix round is not started.
  const s = reviewedRounds([true, true], 5);
  assert.equal(s.status, 'waiting');
  assert.equal(s.checkpoint!.id, 'review-limit');
  assert.match(s.checkpoint!.reason!, /diff was empty in 2 review rounds/);
  assert.equal(s.review.round, 2, 'no further fix round was started');
  assert.equal(s.review.emptyRounds, 2);
});

test('machine: a round with changes between two empty ones resets the count', async () => {
  const s = reviewedRounds([true, false, true], 5);
  assert.equal(s.checkpoint, null);
  assert.equal(s.review.round, 4, 'the fix rounds go on while the diffs are not empty twice in a row');
  assert.equal(s.review.emptyRounds, 1);
});

test('machine: one empty round is not enough, and a round limit still applies', async () => {
  const once = reviewedRounds([true], 5);
  assert.equal(once.checkpoint, null);
  assert.equal(once.review.round, 2);
  const limit = reviewedRounds([false, false], 2);
  assert.equal(limit.checkpoint!.id, 'review-limit');
  assert.match(limit.checkpoint!.reason!, /still has blocking findings/);
});

test('machine: a failed agent opens agent-failure and retry runs the same step', async () => {
  const { pipeline } = defaultPipeline();
  let s = rpl(timed([createdEvent(pipeline), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_failed', agent: 'planner', error: 'boom' }]));
  assert.equal(s.checkpoint!.id, 'agent-failure');
  assert.equal(s.checkpoint!.reason, 'boom');
  s = passed(tr(s, { type: 'checkpoint_answered', id: 'agent-failure', option: 'retry', feedback: 'try harder', at: at(9) })).state;
  const next = runOf(nx(s));
  assert.equal(next.mode, 'retry');
  assert.equal(next.feedback, 'try harder');
});

test('machine: an agent that says it cannot go on is blocked; the same failure after a retry needs guidance for the next', async () => {
  const { pipeline } = defaultPipeline();
  const blocker = (words: string): OrchEvent[] => timed([{ type: 'stage_started', agent: 'planner' }, { type: 'stage_failed', agent: 'planner', error: words, blocked: true }]);
  let s = rpl([...timed([createdEvent(pipeline), { type: 'intake_completed', spec }]), ...blocker('planner reports it cannot go on: the branch fix/plinko-config was made from main, and the Plinko code is only on origin/plinko (e5d2be7d)')]);
  assert.equal(s.checkpoint!.blocked, true);
  assert.equal(s.checkpoint!.repeated, undefined, 'the first time is news');
  s = passed(tr(s, { type: 'checkpoint_answered', id: 'agent-failure', option: 'retry', at: at(20) })).state;
  // Worded anew by the agent, with another hash: the same failure.
  for (const e of blocker('planner reports it cannot go on: the task branch fix/plinko-config is made from main, but the Plinko code exists only on origin/plinko (32 commits ahead, 51e252e3)')) s = passed(tr(s, { ...e, at: at(30) })).state;
  assert.equal(s.checkpoint!.repeated, true);
  assert.equal(failed(tr(s, { type: 'checkpoint_answered', id: 'agent-failure', option: 'retry', at: at(40) })).error.code, 'guidance_required', 'a retry as it was ends there again');
  assert.equal(failed(tr(s, { type: 'checkpoint_answered', id: 'agent-failure', option: 'retry', feedback: '  ', at: at(40) })).error.code, 'guidance_required');
  s = passed(tr(s, { type: 'checkpoint_answered', id: 'agent-failure', option: 'retry', feedback: 'The branch is fast-forwarded to origin/plinko now', at: at(40) })).state;
  // Another failure is news again, and so is any after a step that went through.
  for (const e of timed([{ type: 'stage_started', agent: 'planner' }, { type: 'stage_failed', agent: 'planner', error: 'the agent ran out of turns' }])) s = passed(tr(s, { ...e, at: at(50) })).state;
  assert.equal(s.checkpoint!.repeated, undefined);
  assert.equal(s.checkpoint!.blocked, undefined, 'one that ended without a report is not blocked');
  s = passed(tr(s, { type: 'checkpoint_answered', id: 'agent-failure', option: 'retry', at: at(60) })).state;
  for (const e of timed([{ type: 'stage_started', agent: 'planner' }, { type: 'stage_failed', agent: 'planner', error: 'the agent ran out of turns' }])) s = passed(tr(s, { ...e, at: at(70) })).state;
  assert.equal(s.checkpoint!.repeated, true, 'the same words twice');
});

test('machine: a commit a hook rejects the same way again says so, and its retry stays one click', async () => {
  const { pipeline } = defaultPipeline();
  let s = rpl(timed([createdEvent(pipeline), { type: 'intake_completed', spec }]));
  s = { ...s, phase: 'finish', finishStep: 'commit' };
  const rejected = (output: string) => passed(tr(s, { type: 'commit_failed', repo: 'api', output, at: at(10) } as OrchEvent)).state;
  s = rejected('mktemp: mkstemp failed on /var/folders/wl/x/T/tmp.F7tN7fIsCo: Operation not permitted\nAborting commit due to empty commit message.');
  assert.equal(s.checkpoint!.repeated, undefined);
  s = passed(tr(s, { type: 'checkpoint_answered', id: 'hook-failure', option: 'retry', at: at(11) })).state;
  s = rejected('mktemp: mkstemp failed on /var/folders/wl/x/T/tmp.Q2ab9ZkLmn: Operation not permitted\nAborting commit due to empty commit message.');
  assert.equal(s.checkpoint!.repeated, true);
  assert.ok(passed(tr(s, { type: 'checkpoint_answered', id: 'hook-failure', option: 'retry', at: at(12) })).state, 'what changes is outside the task: no guidance to give');
});

test('config: project layer overrides, extends, flags and comment-preserving edits', async () => {
  const ws = tmp('cs-config-');
  const home = tmp('cs-home-');
  fs.mkdirSync(path.join(ws, '.claudestrator', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claudestrator', 'prompts', 'security.md'), 'Look for security holes.');
  fs.writeFileSync(
    path.join(ws, '.claudestrator', 'config.yaml'),
    `# team config
agents:
  tester: { enabled: false }
  security:
    extends: reviewer
    instructions: { mode: append, file: ./prompts/security.md }
pipeline: [planner, developer, tester, reviewer, security]
language: Ukrainian
repos:
  api:
    role: Backend
    gates:
      - { name: lint, cmd: npm run lint }
`
  );
  const r = passed(await loadCfg({ workspace: ws, home }));
  assert.equal(r.config.language, 'Ukrainian');
  assert.equal(r.config.agents.tester!.enabled, false);
  assert.equal(r.config.agents.security!.output, 'verdict');
  assert.deepEqual(r.config.agents.security!.lineage, ['reviewer', 'security']);
  assert.match(r.config.agents.security!.instructions, /fresh eyes[\s\S]*security holes/);
  assert.equal(r.config.repos.api!.baseBranch, 'main');
  assert.equal(bp(r.config).reviewLoop!.reviewers.join(','), 'reviewer,security');

  const flagged = await loadCfg({ workspace: ws, home, flags: { no: ['nope'] } });
  assert.equal(flagged.ok, false);

  await config.updateAgentConfig(ws, 'planner', { model: 'sonnet' });
  await config.setProjectValue(ws, ['limits', 'reviewRounds'], 3);
  await config.setPipeline(ws, ['planner', 'developer', 'reviewer']);
  const text = fs.readFileSync(config.projectConfigFile(ws), 'utf8');
  assert.match(text, /# team config/);
  assert.match(text, /pipeline: \[ planner, developer, reviewer \]/);
  const again = passed(await loadCfg({ workspace: ws, home }));
  assert.equal(again.config.agents.planner!.model, 'sonnet');
  assert.equal(again.config.limits.reviewRounds, 3);
  await assert.rejects(() => config.setProjectValue(ws, ['limits', 'reviewRounds'], 99), /invalid/);
  await config.setProjectValue(ws, ['limits', 'reviewRounds'], undefined);
  assert.doesNotMatch(fs.readFileSync(config.projectConfigFile(ws), 'utf8'), /limits/);

  // Edits from the dashboard can overlap; each one reads the file the one before it wrote, so none is lost, and a
  // refused edit does not hold up the next one.
  await Promise.all([
    config.updateAgentConfig(ws, 'developer', { model: 'opus' }),
    config.setProjectValue(ws, ['limits', 'budgetUsd'], 7),
    assert.rejects(() => config.setProjectValue(ws, ['limits', 'reviewRounds'], 99), /invalid/),
    config.setScenario(ws, 'audit', ['auditor']),
    config.setRepo(ws, 'web', { path: './web' }),
  ]);
  const overlapped = await config.readProjectLayer(ws);
  assert.deepEqual([overlapped.agents!.planner!.model, overlapped.agents!.developer!.model, overlapped.limits, overlapped.scenarios!.audit, overlapped.repos!.web], ['sonnet', 'opus', { budgetUsd: 7 }, ['auditor'], { path: './web' }]);
  await config.setProjectValue(ws, ['limits'], undefined);

  const file = await config.ensureInstructionsFile(ws, 'developer', again.config.agents.developer);
  assert.equal(file, path.join(ws, '.claudestrator', 'prompts', 'developer.md'));
  assert.match(fs.readFileSync(file, 'utf8'), /You implement one repository/);
  assert.deepEqual((await config.readProjectLayer(ws)).agents!.developer!.instructions, { mode: 'replace', file: './prompts/developer.md' });

  fs.writeFileSync(config.projectConfigFile(ws), 'agents:\n  planner: { modle: opus }\n');
  const bad = failed(await loadCfg({ workspace: ws, home }));
  assert.match(bad.errors[0]!.message, /agents\.planner\.modle: unknown field/);
});

test('reports: plan and verdict blocks are validated, nulls tolerated', async () => {
  const plan = passed(report('plan', '## Summary\nPlan...\n### api\n- cap it\n```json\n{"type":"feat","slug":"a-b","title":null,"repos":[{"name":"api"}],"openQuestions":[]}\n```'));
  assert.deepEqual(plan.plan!.repos, [{ name: 'api', mode: 'full' }]);
  // A plan is its text: one handed over as data alone, or with no section for a repo it plans for, goes back.
  const data = { type: 'feat', slug: 'a-b', repos: [{ name: 'api' }, { name: 'game-client' }], openQuestions: [] };
  assert.match(failed(parseStageReport('plan', '', data)).error, /the report has no text, only its data/);
  assert.match(failed(parseStageReport('plan', '## Summary\nCap bets.\n\n### `api`\n- cap', data)).error, /no section for game-client: .*\(### game-client\)/);
  assert.ok(parseStageReport('plan', '## Summary\nCap bets.\n\n### `api`\n- cap\n\n## game-client (UI)\n- show it', data).ok, 'any heading that names the repo');
  assert.match(failed(parseStageReport('plan', '## Summary\nThe api and game-client change.\n### api.v2\n- x', data)).error, /no section for api, game-client/, 'a name in passing, or inside another, is no section');
  assert.match(failed(report('code', '')).error, /no text/, 'a developer that wrote nothing');
  assert.ok(parseStageReport('verdict', '', { status: 'approved', summary: 'fine', findings: [] }).ok, "a verdict's data is its report");
  assert.match(failed(report('plan', 'no block')).error, /no ```json block/);
  assert.match(failed(report('plan', '```json\n{"type":"feat","slug":"Bad Slug","repos":[]}\n```')).error, /^the report has no text[\s\S]*; also, the plan json block does not match the schema: .*slug must be kebab-case[\s\S]*repos: needs at least 1/, 'every problem in one message');
  const v = failed(report('verdict', '```json\n{"status":"approved","summary":"s","findings":[{"severity":"major","problem":"p","line":null}]}\n```'));
  assert.match(v.error, /changes_requested exactly when/);
  assert.ok(report('code', 'anything').ok);
});

test('guard: a command is recognised behind paths, shell keywords, wrappers, eval, sh -lc and find -exec', async () => {
  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: false, allowNoVerify: false, sandbox: true, localPorts: false, network: [], writable: [], checkEnv: [] };
  const ctx: GuardContext = { policy, cwd: '/ws/api', workspace: '/ws', home: '/home/u', agent: true, task: { taskId: 'T', canPush: false }, branchOf: async () => 'feat/x', isRepoRoot: async (d) => d === '/ws/api', readFile: async () => null };
  const refused = [
    '/usr/bin/git push --force origin main',
    'if true; then git push --force; fi',
    'for b in a; do git push -f; done',
    '{ git push -f; }',
    '! git push -f',
    'xargs git push -f',
    'xargs -n 1 -I {} git push -f',
    'timeout 60 git push -f',
    'timeout -s KILL 60 git push -f',
    'nice git push -f',
    'nice -n 10 git push -f',
    'env -i git push -f',
    'env -u HOME FOO=1 git push -f',
    'stdbuf -o L git push -f',
    'eval "git push -f"',
    'bash -lc "git push -f"',
    'sh -ec "git push -f"',
    'zsh -xc "git push -f"',
    'git \\\n  push -f',
    'echo "<<EOF"\ngit push -f',
    'git -c alias.p="push --force" p origin main',
    'git -c core.hooksPath=/dev/null status',
    'git config core.hooksPath /dev/null',
    'git config alias.p "push --force"',
    'git p origin main',
    'git remote set-url origin https://evil.example/x.git',
    'git remote add evil https://evil.example/x.git',
    'gh api --method=POST repos/o/r/issues',
    'gh api -XPOST repos/o/r/issues',
    'gh api repos/o/r/issues -f title=x',
    'gh api repos/o/r/issues --input body.json',
    'gh api -Ftitle=x repos/o/r/issues',
    '/bin/rm -rf /home/u',
    'D=/home/u; rm -rf $D',
    'rm -rf "$TARGET"',
    'rm -rf `pwd`/..',
    'find /home/u -delete',
    'find / -name x -delete',
    'find . -exec git push -f {} \\;',
    'find . -execdir rm -rf /home/u {} +',
    'echo "$(git push -f)"',
    'echo "`git push -f`"',
    'X=$(git push -f)',
  ];
  for (const command of refused) assert.equal((await guard(command, ctx)).allow, false, `should be refused: ${command}`);

  // What agents do all day keeps working.
  const allowed = [
    'git status',
    'git diff main...HEAD -- src',
    'git log --oneline -20',
    'git add -A',
    'git show HEAD:package.json',
    'git config --get user.name',
    'git config --list',
    'git remote -v',
    'git branch --show-current',
    'npm test',
    'timeout 600 npm test',
    'nice -n 5 npm run lint',
    'env CI=1 npm test',
    'bash -lc "npm run lint && npm test"',
    'if [ -f package.json ]; then npm ci; fi',
    'find . -name "*.ts" -exec grep -l foo {} \\;',
    'find . -name "*.log" -delete',
    'ls | xargs -n 1 echo',
    'gh pr view 12',
    'gh api repos/o/r/pulls',
    'gh api -X GET repos/o/r/pulls',
    'rm -rf node_modules dist',
    'rm -rf /tmp/build-cache',
    'echo "git push --force"',
    'cat <<EOF\ngit push -f\nEOF',
  ];
  for (const command of allowed) assert.equal((await guard(command, ctx)).allow, true, `should be allowed: ${command}`);
});

test('guard: an agent writes files only where its stage works or in a temp folder, never into .git', async () => {
  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: false, allowNoVerify: false, sandbox: true, localPorts: false, network: [], writable: [], checkEnv: [] };
  const base: GuardContext = { policy, cwd: '/ws/api', workspace: '/ws', home: '/home/u', agent: true, task: { taskId: 'T', canPush: false }, branchOf: async () => 'feat/x', isRepoRoot: async (d) => d === '/ws/api' || d === '/ws/web', readFile: async () => null };
  const developer = { ...base, writeRoots: ['/ws/api'] };
  const reviewer = { ...base, writeRoots: [] };
  const check = async (ctx: GuardContext, list: string[], allowed: boolean): Promise<void> => {
    for (const command of list) assert.equal((await guard(command, ctx)).allow, allowed, `${allowed ? 'should be allowed' : 'should be refused'} (${ctx.writeRoots!.length ? 'developer' : 'reviewer'}): ${command}`);
  };
  await check(developer, [
    'echo x >> /home/u/.zshrc',
    'echo x>/ws/web/a.ts',
    'sed -i "s/a/b/" /ws/web/x.ts',
    'perl -pi -e "s/a/b/" /ws/web/x.ts',
    'cp a.ts /ws/web/a.ts',
    'cp -t /ws/web a.ts',
    'mv /ws/api/a.ts /home/u/a.ts',
    'touch /ws/web/x',
    'mkdir -p /home/u/bin',
    'ls | tee /home/u/list.txt',
    'echo x > "$OUT"',
    'dd if=/dev/zero of=/home/u/big bs=1 count=1',
    'cat > .git/hooks/pre-push',
    'echo x > /ws/api/.git/config',
    'bash -c "echo x >> ~/.profile"',
  ], false);
  await check(developer, [
    'echo x > out.txt',
    'echo x > /ws/api/src/new.ts',
    'npm test > /tmp/log.txt 2>&1',
    'npm test 2>/dev/null',
    'npm test >&2',
    'sed -i "s/a/b/" src/x.ts',
    'sed -i.bak -e "s/a/b/" src/x.ts',
    'cp src/a.ts src/b.ts',
    'mkdir -p src/new && touch src/new/index.ts',
    'ls 2>&1 | tee /tmp/x',
    'echo "a > b"',
    'git diff > /tmp/patch.diff',
  ], true);
  await check(reviewer, ['sed -i "s/a/b/" src/x.ts', 'echo x > notes.md', 'cp a.ts b.ts', 'rm src/x.ts'], false);
  await check(reviewer, ['npm test', 'cat src/x.ts | grep foo', 'echo x > /tmp/notes.md', 'git log > /tmp/log'], true);
});

test('guard: an agent makes no link to git metadata or to Claudestrator\'s config, and .git is .git in any case', async () => {
  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: false, allowNoVerify: false, sandbox: true, localPorts: false, network: [], writable: [], checkEnv: [] };
  const ctx: GuardContext = { policy, cwd: '/ws/api', workspace: '/ws', home: '/home/u', agent: true, task: { taskId: 'T', canPush: false }, writeRoots: ['/ws/api'], protect: ['/ws/.claudestrator'], branchOf: async () => 'feat/x', isRepoRoot: async (d) => d === '/ws/api', readFile: async () => null };
  // A write through the link would land in the file it leads to: Write and Edit run outside the sandbox.
  for (const command of [
    'ln -s .git/config cfg',
    'ln -sf .git/hooks h',
    'ln .git/config hard',
    'ln -s ../.git/config src/cfg',
    'ln -s /ws/api/.git gitdir',
    'ln -t src .git/config',
    'link .git/config x',
    'cp -l .git/config x',
    'cp -s .git/config x',
    'cp -al .git/hooks hooks',
    'ln -s ../.claudestrator/config.yaml settings.yaml',
    'echo x >> .GIT/config',
    'cd .Git && echo x > config',
  ]) {
    assert.equal((await guard(command, ctx)).allow, false, command);
  }
  for (const command of ['ln -s src/a.ts b.ts', 'ln -s ../shared/x.ts src/x.ts', 'cp .git/config /tmp/config.txt', 'cp -r src lib']) {
    assert.equal((await guard(command, ctx)).allow, true, command);
  }
});

test('hook: a tool call that is not in the expected shape is refused, never passed as an unknown tool', async () => {
  assert.deepEqual(parseHookRequest(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/ws' })), { tool: 'Bash', input: { command: 'ls' }, cwd: '/ws' });
  assert.deepEqual(parseHookRequest(JSON.stringify({ tool_name: 'Read' })), { tool: 'Read', input: {}, cwd: '' });
  for (const bad of ['', 'not json', '[]', '{}', '{"tool_name":""}', '{"tool_name":5}', '{"tool_name":"Bash","tool_input":"rm -rf /"}']) {
    assert.equal(parseHookRequest(bad), null, bad);
  }
});

test('guard: agents never touch git history, destructive commands are refused', async () => {
  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: true, allowNoVerify: false, sandbox: true, localPorts: false, network: [], writable: [], checkEnv: [] };
  const ctx = (extra: Partial<GuardContext> = {}): GuardContext => ({ policy, cwd: '/ws/api', workspace: '/ws', home: '/home/u', agent: true, task: { taskId: 'T', canPush: false }, branchOf: async () => 'feat/x', isRepoRoot: async (d) => d === '/ws/api', readFile: async () => null, ...extra });
  const refusal = async (command: string, c: GuardContext) => denied(await guard(command, c)).reason;
  assert.equal((await guard('npm test && git status', ctx())).allow, true);
  assert.match(await refusal('git commit -m "x"', ctx()), /agents do not run git commit/);
  assert.match(await refusal('echo hi; bash -c "git push origin feat/x"', ctx()), /git push/);
  assert.equal((await guard('echo "git push --force"', ctx())).allow, true, 'quoted text is not a command');
  assert.match(await refusal('rm -rf ../api', ctx()), /repository/);
  assert.match(await refusal('rm -rf ~', ctx()), /not allowed/);
  assert.equal((await guard('rm -rf node_modules', ctx())).allow, true);
  assert.match(await refusal('gh pr create --title x', ctx()), /only read with gh/);
  const orchestrator = ctx({ agent: false, task: { taskId: 'T', canPush: true } });
  assert.match(await refusal('git push --force', orchestrator), /force-push/);
  assert.match(await refusal('gh pr create --title x --body y', orchestrator), /drafts only/);
  assert.match(await refusal('git commit -m "x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"', ctx({ agent: false, branchOf: async () => 'feat/x' })), /AI attribution/);
  assert.match(await refusal('git commit --no-verify -m x', ctx({ agent: false })), /hooks/);
  // Redirections are not arguments: what an agent appends to a read-only command does not turn it into a write.
  for (const read of ['git branch -a 2>/dev/null', 'git branch 2>&1 | head', 'git branch --list > /tmp/branches.txt', 'git log --oneline 2> /dev/null']) {
    assert.equal((await guard(read, ctx())).allow, true, read);
  }
  assert.match(await refusal('git branch feature-x 2>/dev/null', ctx()), /do not create, rename or delete branches/);
  assert.match(await refusal('git push origin main 2>&1', ctx()), /git push/);
  assert.match(await refusal('git branch --list > ../other/branches.txt', ctx({ writeRoots: ['/ws/api'] })), /outside \/ws\/api/, 'the file it writes is still checked');
  // Git that reads, stages or applies a patch is the agents'; what moves HEAD, hides changes or runs a program is not.
  for (const read of ['git log --oneline', 'git stash list', 'git stash show -p stash@{0}', 'git worktree list', 'git reflog', 'git reflog show HEAD', 'git lfs ls-files', 'git add -N new.ts', 'git apply fix.patch', 'git fetch origin main', 'GIT_PAGER=cat git log', 'GIT_TERMINAL_PROMPT=0 git ls-remote origin', 'git grep -n foo']) {
    assert.equal((await guard(read, ctx())).allow, true, read);
  }
  for (const [command, reason] of [
    ['git symbolic-ref HEAD refs/heads/main', /do not run git symbolic-ref/],
    ['git bisect start', /do not run git bisect/],
    ['git update-index --assume-unchanged src/a.ts', /do not run git update-index/],
    ['git submodule update --init', /do not run git submodule/],
    ['git clone https://github.com/x/y /tmp/y', /do not run git clone/],
    ['git stash', /do not run git stash/],
    ['git worktree add ../wt', /do not run git worktree/],
    ['git reflog expire --all', /only read with git reflog/],
    ['git lfs pull', /only read with git lfs/],
    ['git fetch --upload-pack="touch /tmp/pwned" origin', /--upload-pack runs a program/],
    ['git grep -Ovim foo', /-Ovim runs a program/],
    ['git diff --output=/etc/x', /--output runs a program or writes a file/],
    ['GIT_EXTERNAL_DIFF=/tmp/evil git diff', /git's environment \(GIT_EXTERNAL_DIFF\)/],
    ['env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=sh git log', /git's environment \(GIT_CONFIG_COUNT\)/],
    ['export GIT_DIR=/tmp/other.git && git status', /git's environment \(GIT_DIR\)/],
    ['PAGER="sh -c evil" git log', /git's environment \(PAGER\)/],
  ] as [string, RegExp][]) {
    assert.match(await refusal(command, ctx()), reason, command);
  }
  assert.equal((await guard('export NODE_ENV=test && npm test', ctx())).allow, true, 'other variables are the agent\'s to set');
  for (const publish of ['npm publish', 'npm publish --access public', 'cd pkg && pnpm publish', 'yarn npm publish', 'npx twine upload dist/*', 'cargo publish', 'gem push x.gem', 'poetry publish --build']) {
    assert.match(await refusal(publish.replace('npx ', ''), ctx()), /publishes a package/, publish);
  }
  assert.equal((await guard('npm run publish-docs && npm pack', ctx())).allow, true, 'a script named after publishing is not npm publish');
  assert.match(await refusal('security find-generic-password -s gh:github.com -w', ctx()), /keychain/);
  assert.equal((await guard('npm publish', orchestrator)).allow, true, 'only agents are held to it');
});

test('intake: invocations, sources and acceptance criteria', async () => {
  assert.deepEqual(parseInvocation('PROJ-123 --no tester --auto'), { input: 'PROJ-123', flags: { no: ['tester'] }, auto: true });
  assert.deepEqual(parseInvocation("Don't break the dice game"), { input: "Don't break the dice game", flags: {}, auto: false });
  assert.deepEqual(parseInvocation('Fix the typo --repos api,web --repos api'), { input: 'Fix the typo', flags: {}, auto: false, repos: ['api', 'web'] });
  assert.throws(() => parseInvocation('Fix it --repos'), /--repos needs a repo name/);
  // A flag's name inside the description is a word of it; flags count at the start or the end.
  assert.deepEqual(parseInvocation('Add a --key option to the CLI'), { input: 'Add a --key option to the CLI', flags: {}, auto: false });
  assert.deepEqual(parseInvocation("Support --auto mode in the user's dashboard"), { input: "Support --auto mode in the user's dashboard", flags: {}, auto: false });
  assert.deepEqual(parseInvocation('Cap bets\n\n## Acceptance criteria\n- the --no flag skips tester\n--auto --no tester'), { input: 'Cap bets\n\n## Acceptance criteria\n- the --no flag skips tester', flags: { no: ['tester'] }, auto: true });
  assert.deepEqual(parseInvocation('--effort high --scenario audit Find slow queries'), { input: 'Find slow queries', flags: {}, auto: false, scenario: 'audit', effort: { '*': 'high' } });
  assert.deepEqual(parseInvocation('--key=PROJ-9'), { input: '', flags: {}, auto: false, key: 'PROJ-9' });
  assert.deepEqual(classify('PROJ-12'), { kind: 'jira', key: 'PROJ-12' });
  assert.deepEqual(classify('https://acme.atlassian.net/browse/PROJ-7'), { kind: 'jira', key: 'PROJ-7', site: 'acme.atlassian.net' });
  assert.equal((classify('https://acme.atlassian.net/wiki/spaces/X/pages/12345/Title') as Extract<Source, { kind: 'confluence' }>).pageId, '12345');
  assert.equal(classify('Add a cap https://x.y/z').kind, 'text');
  assert.deepEqual(extractAcceptanceCriteria('Intro\n\n## Acceptance criteria\n- one\n- two\n  continued\n\n## Notes\n- not this'), ['one', 'two continued']);
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'AC' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }] }), '## AC\n\n- a');
  // One malformed node does not fail the whole ticket.
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Due ' }, { type: 'date', attrs: { timestamp: 'soon' } }, { type: 'date', attrs: { timestamp: '1767225600000' } }] }] }), 'Due 2026-01-01');
  assert.equal(storageToText('<p>A &#99999999; B &#x1F680; &amp; &bogus;</p>'), 'A &#99999999; B 🚀 & &bogus;');
  // Jira action items and decisions are a checklist, often the acceptance criteria; a status lozenge keeps its word.
  const t = (text: string) => ({ type: 'text', text });
  const jira = adfToText({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('Acceptance criteria')] },
    { type: 'taskList', attrs: { localId: 'x' }, content: [
      { type: 'taskItem', attrs: { localId: 'a', state: 'TODO' }, content: [t('Refund is created')] },
      { type: 'taskItem', attrs: { localId: 'b', state: 'DONE' }, content: [t('Email is sent')] },
    ] },
    { type: 'decisionList', content: [{ type: 'decisionItem', attrs: { state: 'DECIDED' }, content: [t('Refunds go to the card')] }] },
    { type: 'paragraph', content: [t('Status: '), { type: 'status', attrs: { text: 'BLOCKED' } }] },
  ] });
  assert.equal(jira, '## Acceptance criteria\n\n- [ ] Refund is created\n- [x] Email is sent\n\n- Refunds go to the card\n\nStatus: [BLOCKED]');
  assert.deepEqual(extractAcceptanceCriteria(jira).slice(0, 2), ['Refund is created', 'Email is sent']);
  // Confluence's task lists and noformat blocks, the same way.
  const page = storageToText('<h2>Acceptance criteria</h2><ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Refund is created</ac:task-body></ac:task><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Email is sent</ac:task-body></ac:task></ac:task-list><h2>API</h2><ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[curl -X POST /refunds]]></ac:plain-text-body></ac:structured-macro>');
  assert.deepEqual(extractAcceptanceCriteria(page), ['Refund is created', 'Email is sent']);
  assert.match(page, /```\ncurl -X POST \/refunds\n```/);
  assert.doesNotMatch(page, /incomplete|1Refund/);
  assert.equal(classify('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=../../x').kind, 'text', 'a page id is digits');
  assert.equal((classify('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=4242') as Extract<Source, { kind: 'confluence' }>).pageId, '4242');
});

test('store: tasks persist, rejections are logged, torn tails are ignored', async () => {
  const ws = tmp('cs-store-');
  const { pipeline, config: cfg } = defaultPipeline();
  const svc = new TaskService({ workspace: ws });
  const started = await svc.start({ input: 'x', source: { kind: 'text', text: 'x' }, auto: false, pipeline, config: cfg });
  assert.ok(started.created);
  assert.ok(fs.existsSync(path.join(ws, '.orch', '.gitignore')));
  const second = await svc.start({ input: 'y', source: { kind: 'text', text: 'y' }, auto: false, pipeline, config: cfg });
  assert.notEqual(second.taskId, started.taskId);
  failed(await svc.dispatch(started.taskId, { type: 'stage_started', agent: 'planner' }));
  assert.equal((await svc.events(started.taskId)).at(-1)!.type, 'transition_rejected');
  fs.appendFileSync(path.join(svc.dir(started.taskId), 'events.ndjson'), '{"seq": 3, "type": "no');
  assert.equal((await svc.state(started.taskId)).phase, 'intake');
  assert.ok((await svc.dispatch(started.taskId, { type: 'intake_completed', spec })).ok);
  assert.equal((await svc.list()).length, 2);
});

test('view: the step timeline continues after the step a checkpoint stopped at', async () => {
  const { pipeline } = defaultPipeline();
  const events = timed([createdEvent(pipeline), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: PLAN }]).map((e, i) => ({ ...e, seq: i + 1 }));
  const state = rpl(events);
  const steps = stepsOf(events, state, { running: false });
  assert.deepEqual(steps.map((s) => `${s.kind}:${s.agent || s.label}${s.repo ? `@${s.repo}` : ''}:${s.status}`), [
    'intake:Ticket:done',
    'agent:planner:done',
    'human:Plan approval:waiting',
    'agent:developer@api:pending',
    'agent:developer@web:pending',
    'agent:tester:pending',
    'agent:reviewer:pending',
    'finish:Commit:pending',
    'human:Confirm push:pending',
    'finish:Draft PRs:pending',
  ]);
});

test('gates: output for agents has no colour codes and no redrawn progress lines', async () => {
  assert.equal(plain('\u001b[31mFAIL\u001b[0m src/a.ts\n[1/3] building\r[2/3] building\r[3/3] done  \nok\n'), 'FAIL src/a.ts\n[3/3] done\nok\n');
});

test('config: effort is validated and inherited along extends', async () => {
  const ws = tmp('cs-effort-');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(config.projectConfigFile(ws), 'agents:\n  reviewer: { effort: high }\n  security: { extends: reviewer, description: Security }\n');
  const r = passed(await loadCfg({ workspace: ws, home: tmp('cs-h-') }));
  assert.equal(r.config.agents.security!.effort, 'high');
  assert.equal(r.config.agents.planner!.effort, 'high', 'the built-in effort of the planner');
  assert.equal(r.config.agents.verifier!.effort, undefined);
  assert.deepEqual(['planner', 'developer', 'tester', 'reviewer'].map((n) => r.config.agents[n]!.mcp), [undefined, false, false, false], 'only agents that work on the repo run without MCP');
  assert.equal(r.config.agents.security!.mcp, false, 'an agent that extends the reviewer inherits it');
  await config.updateAgentConfig(ws, 'developer', { mcp: true });
  assert.equal(passed(await loadCfg({ workspace: ws })).config.agents.developer!.mcp, true, 'a project can give an agent its MCP servers back');
  await assert.rejects(() => config.updateAgentConfig(ws, 'developer', { mcp: 'no' }), /mcp/);
  await config.updateAgentConfig(ws, 'planner', { effort: 'xhigh' });
  assert.equal(passed(await loadCfg({ workspace: ws })).config.agents.planner!.effort, 'xhigh');
  await config.updateAgentConfig(ws, 'planner', { effort: null });
  assert.equal(passed(await loadCfg({ workspace: ws })).config.agents.planner!.effort, 'high', 'clearing the setting falls back to the built-in effort');
  await assert.rejects(() => config.updateAgentConfig(ws, 'planner', { effort: 'huge' }), /effort: expected one of low, medium, high, xhigh, max/);
  const args = buildArgs({ agent: { model: 'opus', effort: 'low', instructions: 'x' } as Agent, settings: {} }, { flags: () => new Set(['--effort']), settingSources: () => null } as Partial<RunnerOptions> as RunnerOptions);
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.ok(!buildArgs({ agent: { effort: 'low' } as Agent, settings: {} }, { flags: () => new Set(), settingSources: () => null } as Partial<RunnerOptions> as RunnerOptions).includes('--effort'), 'old CLIs without --effort still run');
  const turns = buildArgs({ agent: { maxTurns: 40 } as Agent, settings: {} }, { flags: () => new Set(['--max-turns']), settingSources: () => null } as Partial<RunnerOptions> as RunnerOptions);
  assert.equal(turns[turns.indexOf('--max-turns') + 1], '40', "an agent's maxTurns reaches Claude Code");
  assert.ok(!buildArgs({ agent: {} as Agent, settings: {} }, { flags: () => new Set(['--max-turns']), settingSources: () => null } as Partial<RunnerOptions> as RunnerOptions).includes('--max-turns'), 'no cap unless the agent sets one');
  assert.deepEqual(limitsOf({ rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 9 }), { fiveHour: undefined, sevenDay: { pct: 50, resetsAt: 9, status: undefined } });
  // Each session reports the windows again: the same report is no change.
  const w = { fiveHour: { pct: 31, resetsAt: 9, status: 'allowed' }, sevenDay: { pct: 26, resetsAt: 99 } };
  assert.equal(sameWindows(w, { ...w, fiveHour: { ...w.fiveHour } }), true);
  assert.equal(sameWindows(w, { ...w, fiveHour: { ...w.fiveHour, pct: 32 } }), false);
  assert.equal(sameWindows(w, { ...w, fiveHour: { ...w.fiveHour, status: 'rejected' } }), false);
  assert.equal(sameWindows(null, w), false);
});

test('task effort: --effort in the text, per-agent choices, and the override reaching the agent', async () => {
  assert.deepEqual(parseInvocation('Fix it --effort high').effort, { '*': 'high' });
  assert.deepEqual(parseInvocation('Fix it --effort developer=max,tester=low').effort, { developer: 'max', tester: 'low' });
  const ws = tmp('cs-teff-');
  const engine = new Engine({ workspace: ws, home: tmp('cs-h-'), runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'] });
  const r = await engine.start({ text: 'Do it --effort medium --no tester', effort: { developer: 'max' } });
  const s = await engine.svc.state(r.taskId);
  assert.deepEqual(s.effort, { planner: 'medium', developer: 'max', reviewer: 'medium' }, 'all enabled agents, a named one wins, skipped ones get nothing');
  assert.equal(((await engine.svc.events(r.taskId))[0] as EventOf<'task_created'>).effort!.developer, 'max', 'frozen in the task log');
  await assert.rejects(() => engine.start({ text: 'x --effort huge' }), /not one of low/);
  await assert.rejects(() => engine.start({ text: 'x', effort: { nobody: 'high' } }), /unknown agent "nobody"/);
  assert.match((await previewOf(engine, { text: 'x --effort huge' })).problem!, /not one of/);
  assert.deepEqual((await previewOf(engine, { text: 'x', effort: { '*': 'low' } })).effort, { planner: 'low', developer: 'low', tester: 'low', reviewer: 'low' });
});

test('defaults: what "default" really means is asked from the CLI, and shown per agent', async () => {
  const fake = path.join(__dirname, 'fixtures', 'fake-claude.js');
  const d = await resolveDefaults({ command: fake, cwd: os.tmpdir(), env: { ...process.env, FAKE_DEFAULT_EFFORT: 'high' }, aliases: ['inherit', 'sonnet'] });
  assert.deepEqual(d!.byModel, { inherit: { model: 'claude-opus-5-5', effort: 'high' }, sonnet: { model: 'claude-sonnet-5-5', effort: 'high' } });
  assert.deepEqual(effectiveFor({ model: 'inherit' }, d), { model: 'claude-opus-5-5', modelName: 'Opus 5.5', modelIsDefault: true, effort: 'high', effortIsDefault: true, defaultEffort: 'high' });
  assert.equal(effectiveFor({ model: 'sonnet', effort: 'low' }, d).effort, 'low');
  assert.equal(effectiveFor({ model: 'sonnet', effort: 'low' }, d, 'max').effort, 'max', 'the task override wins');
  assert.equal(effectiveFor({ model: 'haiku' }, d).modelName, 'Haiku 5.5', 'names come from the CLI model list');
  assert.equal(effectiveFor({ model: 'claude-custom-9' }, d).modelName, 'Custom 9', 'unknown ids fall back to a readable name');
  assert.equal(modelName('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(await resolveDefaults({ command: '/nonexistent/claude', cwd: os.tmpdir(), env: process.env }), null);
});

test('mcp: states from claude mcp list, configured servers, masked details and sign-in', async () => {
  const list = mcp.parseMcpList(`Checking MCP server health…

claude.ai Docs: https://api.anthropic.com/mcp - ✔ Connected
Atlassian: https://mcp.atlassian.com/v1/sse (SSE) - ! Needs authentication
Grafana: http://localhost:8765/mcp (HTTP) - ✗ Failed to connect
shadcn: npx shadcn mcp - ⏸ Pending approval
`);
  assert.deepEqual(list.map((s) => [s.name, s.state, s.transport, s.scope]), [
    ['claude.ai Docs', 'connected', 'http', 'claude.ai'],
    ['Atlassian', 'needs_auth', 'sse', 'config'],
    ['Grafana', 'failed', 'http', 'config'],
    ['shadcn', 'installed', 'stdio', 'config'],
  ]);
  assert.ok(list[3]!.pending);
  assert.deepEqual(list.map(mcp.canLogin), [true, true, true, false]);

  const ws = tmp('cs-mcp-');
  const cfg = tmp('cs-mcp-cfg-');
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { Grafana: { type: 'http', url: 'http://x', headers: { Authorization: 'secret' } } }, projects: { [ws]: { mcpServers: { db: { command: 'npx' } }, disabledMcpServers: ['db'] } } }));
  fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { sentry: { type: 'sse', url: 'https://s' } } }));
  const configured = await mcp.configuredMcpServers(ws, cfg);
  assert.deepEqual(configured.map((s) => [s.name, s.scope, s.transport, Boolean(s.disabled)]), [['Grafana', 'user', 'http', false], ['db', 'local', 'stdio', true], ['sentry', 'project', 'sse', false]]);
  assert.ok(!JSON.stringify(configured).includes('secret'), 'server configs carry secrets; only names leave the file');
  const merged = mcp.mergeMcp(configured, list);
  assert.equal(merged.find((s) => s.name === 'Grafana')!.scope, 'user');
  assert.equal(merged.find((s) => s.name === 'db')!.state, 'installed', 'configured but not in the check still shows');
  const afterOkCheck = mcp.mergeMcp(configured, list, true);
  const sentry = afterOkCheck.find((s) => s.name === 'sentry');
  assert.ok(sentry!.missing, 'in a file but not loaded by Claude Code');
  assert.equal(mcp.canLogin(sentry!), false, 'no sign-in for a server the CLI does not know');
  assert.ok(!afterOkCheck.find((s) => s.name === 'db')!.missing, 'disabled servers are not missing');
  const home = tmp('cs-home-');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { real: { type: 'http', url: 'x' } } }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ mcpServers: { stale: { type: 'http', url: 'x' } } }));
  const realHome = os.homedir;
  os.homedir = () => home;
  try {
    assert.deepEqual((await mcp.configuredMcpServers(ws, undefined)).map((s) => s.name).filter((n) => n !== 'sentry'), ['real'], 'the default account reads ~/.claude.json, not ~/.claude/.claude.json');
  } finally {
    os.homedir = realHome;
  }

  const masked = mcp.redactMcpDetails('  Authorization: Bearer abc.def\n  API_TOKEN=supersecret\n  URL: https://x');
  assert.ok(!/abc\.def|supersecret/.test(masked) && /URL: https:\/\/x/.test(masked));
  const details = mcp.redactMcpDetails([
    '  Command: npx',
    '  Args: -y @grafana/mcp --url https://grafana.acme.io --api-key glsa_0123456789abcdefghijABCDEF --verbose',
    '  Environment: DATABASE_URL=postgres://admin:hunter2@db:5432/app SENTRY_AUTH_TOKEN=sntrys_abc LOG_LEVEL=debug',
    '  URL: https://mcp.acme.io/sse?access_token=eyJabc.def&region=eu',
    '  Note: uses ghp_0123456789abcdefghijABCDEFGHIJ',
  ].join('\n'));
  for (const secret of ['glsa_0123', 'hunter2', 'sntrys_abc', 'eyJabc', 'ghp_0123']) assert.ok(!details.includes(secret), `${secret} masked:\n${details}`);
  for (const kept of ['--url https://grafana.acme.io', '--verbose', 'postgres://admin:', 'LOG_LEVEL=debug', 'region=eu', 'Command: npx']) assert.ok(details.includes(kept), `${kept} kept:\n${details}`);
  assert.equal(mcp.isMcpName('Atlassian'), true);
  assert.equal(mcp.isMcpName('x; rm -rf /'), false);

  const fake = path.join(__dirname, 'fixtures', 'fake-claude.js');
  const state = tmp('cs-mcp-state-');
  const env = { ...process.env, FAKE_STATE: state };
  let r = await mcp.checkMcpServers({ command: fake, workspace: ws, configDir: cfg, env });
  assert.equal(r.servers.find((s) => s.name === 'Atlassian')!.state, 'needs_auth');
  // Signing in happens in a terminal (`claude mcp login`); the next check sees it.
  fs.writeFileSync(path.join(state, 'mcp-signed-in'), '');
  r = await mcp.checkMcpServers({ command: fake, workspace: ws, configDir: cfg, env });
  assert.equal(r.servers.find((s) => s.name === 'Atlassian')!.state, 'connected', 'connected after signing in');
});

test('setup: repos two levels down are found, with the gates, stack, role and base branch they suggest', async () => {
  const ws = tmp('cs-find-');
  const repo = (...parts: string[]): string => {
    const d = path.join(ws, ...parts);
    fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: d });
    return d;
  };
  const web = repo('web');
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ description: 'Storefront', scripts: { lint: 'eslint .', typecheck: 'vue-tsc', test: 'vitest' }, devDependencies: { nuxt: '3', typescript: '5' } }));
  fs.writeFileSync(path.join(web, 'pnpm-lock.yaml'), '');
  fs.mkdirSync(path.join(web, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(web, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/trunk\n');
  const api = repo('services', 'api');
  fs.writeFileSync(path.join(api, 'pyproject.toml'), '[tool.ruff]\n[tool.pytest.ini_options]\n');
  fs.writeFileSync(path.join(api, '.git', 'packed-refs'), '0000000000000000000000000000000000000000 refs/heads/master\n');
  repo('a', 'b', 'too-deep');
  repo('node_modules', 'pkg');

  const found = (await findRepos(ws)).sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(found.map((r) => [r.name, r.path, r.stack, r.role, r.baseBranch]), [
    ['api', 'services/api', ['Python'], undefined, 'master'],
    ['web', 'web', ['Nuxt', 'TypeScript'], 'Storefront', 'trunk'],
  ]);
  assert.deepEqual(found[1]!.gates.map((g) => g.cmd), ['pnpm lint', 'pnpm typecheck', 'pnpm test']);
  assert.deepEqual(found[0]!.gates.map((g) => g.cmd), ['ruff check .', 'pytest -q']);
});

test('repos outside the workspace: picked folders, paths and the guard', async () => {
  const ws = tmp('cs-ws-');
  const outer = tmp('cs-outer-');
  for (const d of [path.join(ws, 'inner'), path.join(outer, 'billing'), path.join(outer, 'group', 'auth')]) {
    fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: d });
  }
  fs.writeFileSync(path.join(outer, 'billing', 'go.mod'), 'module billing\n');
  fs.mkdirSync(path.join(outer, 'plain'));
  const r = await reposFromFolders(ws, [path.join(ws, 'inner'), outer, path.join(outer, 'plain')], { names: ['inner'], dirs: [] });
  assert.deepEqual(r.repos.map((x) => [x.name, x.outside, path.isAbsolute(x.path)]), [['inner-2', false, false], ['billing', true, true], ['auth', true, true]]);
  assert.equal(r.repos[0]!.path, 'inner');
  assert.deepEqual(r.repos[1]!.gates.map((g) => g.name), ['vet', 'test']);
  assert.deepEqual(r.notRepos, [path.join(outer, 'plain')]);
  assert.equal((await reposFromFolders(ws, [outer], { names: [], dirs: [path.join(outer, 'billing'), path.join(outer, 'group', 'auth')] })).repos.length, 0, 'already configured repos are skipped');

  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: false, allowNoVerify: false, sandbox: true, localPorts: false, network: [], writable: [], checkEnv: [] };
  const ctx = { policy, cwd: path.join(outer, 'billing'), workspace: ws, repoDirs: [path.join(outer, 'billing')], agent: true, branchOf: async () => 'feat/x', isRepoRoot: async (d: string) => d === path.join(outer, 'billing'), readFile: async () => null };
  assert.equal((await guard('rm -rf dist', ctx)).allow, true, 'cleaning inside an outside repo is fine');
  assert.match(denied(await guard(`rm -rf ${path.join(outer, 'billing')}`, ctx)).reason, /contains the workspace, a repository/);
  assert.match(denied(await guard('rm -rf .git', ctx)).reason, /git metadata/);
  assert.match(denied(await guard('rm -rf /opt/elsewhere/plain', ctx)).reason, /outside the workspace and its repos/);
});

test('scenarios: built-in readiness and audit agents, validated config, read-only pipelines', async () => {
  const r = passed(resolve([config.builtinLayer()]));
  assert.deepEqual(r.config.scenarios, { readiness: ['verifier'], audit: ['auditor'] });
  assert.deepEqual(r.warnings, [], 'scenario agents are not "enabled but never run"');
  for (const [sc, agent, output] of [['readiness', 'verifier', 'readiness'], ['audit', 'auditor', 'audit']]) {
    const p = bp(r.config, { scenario: sc });
    assert.equal(p.mode, sc);
    assert.deepEqual(p.stages, [{ agent, output, scope: 'task', approval: false }]);
    assert.equal(p.reviewLoop, null);
    assert.equal(outline(p).pop()!.text, sc === 'audit' ? 'audit report' : 'readiness report');
  }

  const bad = failed(resolve([config.builtinLayer(), layer({ scenarios: { audit: ['reviewer', 'ghost'] }, pipeline: ['planner', 'auditor'] })]));
  const codes = bad.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['report_agent_in_pipeline', 'scenario_unknown_agent', 'scenario_wrong_output']);

  const two = passed(resolve([config.builtinLayer(), layer({ agents: { 'perf-auditor': { extends: 'auditor', instructions: { mode: 'append', text: 'Performance only.' } } }, scenarios: { audit: ['auditor', 'perf-auditor'] } })]));
  assert.deepEqual(bp(two.config, { scenario: 'audit' }).stages.map((s) => s.agent), ['auditor', 'perf-auditor']);
  assert.match(two.config.agents['perf-auditor']!.instructions, /You audit code[\s\S]*Performance only\.$/);
});

test('scenarios: readiness verdicts come from the criteria, audit findings are sorted, reports render', async () => {
  const crit = (status: string) => ({ criterion: `c-${status}`, status, evidence: 'e' });
  assert.equal(passed(pr({ summary: 's', criteria: [crit('met')] })).value.verdict, 'ready');
  assert.equal(passed(pr({ summary: 's', criteria: [crit('met'), crit('unverifiable')] })).value.verdict, 'needs_check');
  assert.equal(passed(pr({ summary: 's', criteria: [crit('met')], gaps: [{ severity: 'high', problem: 'p' }] })).value.verdict, 'not_ready');
  assert.equal(passed(pr({ summary: 's', criteria: [crit('partial')], verdict: 'ready' })).value.verdict, 'not_ready', "the agent's own verdict does not count");
  assert.equal(pr({ summary: 's', criteria: [] }).ok, false, 'at least one criterion');
  assert.equal(pr({ summary: 's', criteria: [{ criterion: 'x', status: 'done' }] }).ok, false);

  const a = pa({ summary: 's', findings: [{ severity: 'low', title: 'l', problem: 'p' }, { severity: 'critical', title: 'c', problem: 'p', line: null }] });
  assert.deepEqual(passed(a).value.findings.map((f) => f.severity), ['critical', 'low']);
  assert.equal(pa({ summary: 's', findings: [{ severity: 'blocker', title: 't', problem: 'p' }] }).ok, false);
  assert.equal(passed(report('audit', `x\n\`\`\`json\n${JSON.stringify({ summary: 's', findings: [] })}\n\`\`\``)).audit!.findings.length, 0);
  assert.match(failed(report('readiness', 'no block')).error, /no ```json block/);

  const state = { taskId: 'PROJ-1-check', scenario: 'readiness', spec: { title: 'PROJ-1 Cap bets' }, reports: [{ agent: 'verifier', value: passed(pr({ summary: 'Close.', criteria: [crit('met'), crit('not_met')] })).value }] };
  assert.match(renderReport(asState(state), 'Ukrainian'), /^# Перевірка готовності: PROJ-1 Cap bets\n\n\*\*❌ Не готово\*\* · 1\/2 виконано/);
  assert.match(jiraText(asState(state), 'English'), /❌ c-not_met — e/);
  assert.equal(jiraText(asState(state), 'English', 40).length, 40, 'a comment stays within the limit');
});

test('scenarios: the state machine finishes a report scenario without git; intake reads issues named in a sentence', async () => {
  const { config: c } = defaultPipeline();
  const pipeline = bp(c, { scenario: 'audit' });
  let s = passed(tr(null, { ...createdEvent(pipeline), scenario: 'audit' })).state;
  assert.equal(s.scenario, 'audit');
  s = passed(tr(s, { type: 'intake_completed', spec, at: at(1) })).state;
  assert.deepEqual(runOf(nx(s)).inputs, ['ticket.md']);
  assert.equal(runOf(nx(s)).artifact, 'audit/auditor.md');
  s = passed(tr(s, { type: 'stage_started', agent: 'auditor', at: at(2) })).state;
  assert.equal(failed(tr(s, { type: 'stage_completed', agent: 'auditor', artifact: 'audit/auditor.md', at: at(3) })).error.code, 'audit_required');
  s = passed(tr(s, { type: 'stage_completed', agent: 'auditor', artifact: 'audit/auditor.md', audit: { summary: 's', scope: [], findings: [] }, at: at(3) })).state;
  assert.equal(s.status, 'done');
  assert.equal(s.outcome, 'completed');
  assert.equal(s.reports.length, 1);
  assert.equal(passed(tr(null, createdEvent(bp(c)))).state.scenario, 'deliver', 'old logs are deliveries');
  assert.equal(detectScenario('перевір готовність виконання таски'), 'readiness');
  assert.equal(detectScenario('Check the acceptance criteria of PROJ-3'), 'readiness');
  assert.equal(detectScenario('Зроби аудит проекту'), 'audit');
  assert.equal(detectScenario('Add a health check'), 'deliver');
  assert.deepEqual(classify('PROJ-7: перевір готовність', { embedded: true }), { kind: 'jira', key: 'PROJ-7', note: 'перевір готовність' });
  assert.deepEqual(classify('Is https://acme.atlassian.net/browse/PROJ-8 ready?', { embedded: true }), { kind: 'jira', key: 'PROJ-8', site: 'acme.atlassian.net', note: 'Is ready?' });
  assert.equal(classify('PROJ-7 перевір готовність').kind, 'text', 'only report scenarios look inside a sentence');
  assert.equal(classify('XY-1 ready?', { embedded: true, projects: ['PROJ'] }).kind, 'text', 'outside the allowed projects it is no issue');
  assert.equal(classify('switch to UTF-8, ready?', { embedded: true }).kind, 'text');
  assert.equal(parseInvocation('x --scenario audit').scenario, 'audit');
  // Any well-formed name parses (it may be a custom scenario); the engine checks that it exists.
  assert.equal(parseInvocation('x --scenario hotfix').scenario, 'hotfix');
  assert.throws(() => parseInvocation('x --scenario Not_A_Name'), /--scenario names a scenario/);

  const ws = tmp('cs-ids-');
  const svc = new TaskService({ workspace: ws });
  const jira: Source = { kind: 'jira', key: 'PROJ-9' };
  assert.deepEqual(await svc.idFor({ source: jira, scenario: 'readiness' }), { taskId: 'PROJ-9-check', exists: false });
  await svc.start({ input: 'PROJ-9', source: jira, scenario: 'readiness', auto: false, pipeline: bp(c, { scenario: 'readiness' }), config: c });
  assert.deepEqual(await svc.idFor({ source: jira, scenario: 'readiness' }), { taskId: 'PROJ-9-check', exists: true }, 'an unfinished check continues');
  assert.deepEqual(await svc.idFor({ source: jira }), { taskId: 'PROJ-9', exists: false }, 'the delivery task has its own id');
  assert.equal((await svc.state('PROJ-9-check')).scenario, 'readiness');
});

test('machine: the pipeline of a task changes only after the steps that ran, run now or wait for you', async () => {
  const { pipeline } = defaultPipeline();
  let s: TaskState | null = null;
  let n = 0;
  const apply = (e: EventBody): TaskState => {
    const r = tr(s, { ...e, at: at(++n) } as OrchEvent);
    assert.ok(r.ok, r.ok ? undefined : r.error.message);
    s = r.state;
    return r.state;
  };
  const edit = (agents: [string, Output][]) => {
    const p = taskPipeline(agents.map(([name, output]) => ({ name, output })), { auto: false, maxRounds: 2 });
    return tr(s, { type: 'pipeline_changed', pipeline: { mode: p.mode, stages: p.stages, reviewLoop: p.reviewLoop }, at: at(++n) });
  };
  const PLANNER: [string, Output] = ['planner', 'plan'];
  const DEV: [string, Output] = ['developer', 'code'];
  const TESTER: [string, Output] = ['tester', 'tests'];
  const REVIEWER: [string, Output] = ['reviewer', 'verdict'];

  apply(createdEvent(pipeline));
  assert.equal(editableFrom(s!), 0, 'before the ticket everything can change');
  apply({ type: 'intake_completed', spec });
  apply({ type: 'stage_started', agent: 'planner' });
  assert.equal(failed(edit([DEV, PLANNER, TESTER, REVIEWER])).error.code, 'pipeline_locked', 'the running planner stays first');
  assert.equal(failed(edit([PLANNER, DEV, DEV, REVIEWER])).error.code, 'pipeline_duplicate');

  // While the planner runs, the tester goes and a second reviewer joins; the loop now ends at the new reviewer.
  s = passed(edit([PLANNER, DEV, REVIEWER, ['security', 'verdict']])).state;
  assert.deepEqual(s.pipeline.stages.map((st) => st.agent), ['planner', 'developer', 'reviewer', 'security']);
  assert.equal(s.pipeline.reviewLoop!.end, 3);
  apply({ type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: PLAN });
  assert.equal(s!.checkpoint!.id, 'approve-plan');
  // A question that waits for you does not block an edit.
  s = passed(edit([PLANNER, DEV, TESTER, REVIEWER])).state;
  apply({ type: 'checkpoint_answered', id: 'approve-plan', option: 'approve' });
  assert.deepEqual(passSteps(s!).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'developer@api', 'developer@web', 'tester@', 'reviewer@']);

  apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'reports/r1/developer-api.md', gates: 'pass' });
  // The developer's per-repo block is still running; the tester after it can still go.
  assert.equal(editableFrom(s!), 2);
  assert.equal(failed(edit([PLANNER, REVIEWER, DEV])).error.code, 'pipeline_locked');
  s = passed(edit([PLANNER, DEV, REVIEWER])).state;
  assert.deepEqual(passSteps(s).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'developer@api', 'developer@web', 'reviewer@']);
  s = passed(edit([PLANNER, DEV, TESTER])).state;
  assert.equal(s.pipeline.reviewLoop, null);

  // A task that started when the tester ran per repo keeps it so: consecutive per-repo stages run repo by repo.
  const old: TaskState = { ...s, pipeline: { ...s.pipeline, stages: s.pipeline.stages.map((st) => (st.agent === 'tester' ? { ...st, scope: 'repo' as const } : st)) } };
  assert.deepEqual(passSteps(old).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'developer@api', 'tester@api', 'developer@web', 'tester@web']);

  apply({ type: 'stopped' });
  s = passed(edit([PLANNER, DEV, TESTER, REVIEWER])).state;
  assert.equal(s.status, 'stopped', 'a stopped task can be edited and stays stopped');
});

test('pipeline: runs switches a code or tests agent between once per repo and once across all repos', async () => {
  const ws = tmp('cs-runs-');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  const load = async (yaml: string) => {
    fs.writeFileSync(config.projectConfigFile(ws), yaml);
    return passed(await loadCfg({ workspace: ws, home: tmp('cs-h-') }));
  };
  const steps = (pipeline: StoredPipeline, repos: PlanRepo[]): TaskState => {
    let s: TaskState | null = null;
    const events: EventBody[] = [createdEvent(pipeline), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_completed', agent: 'planner', artifact: 'p', plan: { ...PLAN, repos } }, { type: 'checkpoint_answered', id: 'approve-plan', option: 'approve' }];
    for (const e of events) s = passed(tr(s, { ...e, at: at(1) } as OrchEvent)).state;
    return s!;
  };
  const two = PLAN.repos;

  // The tester back to per repo: developer and tester alternate repo by repo, as before.
  let r = await load('agents:\n  tester: { runs: per-repo }\n');
  assert.equal(r.config.agents.tester!.runs, 'per-repo');
  let s = steps(bp(r.config), two);
  assert.deepEqual(passSteps(s).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'developer@api', 'tester@api', 'developer@web', 'tester@web', 'reviewer@']);

  // The developer across all repos at once; it skips a repo the plan wants tests only for.
  r = await load('agents:\n  developer: { runs: all-repos }\n  hotfix: { extends: developer, description: Hotfix }\npipeline: [planner, hotfix, tester, reviewer]\n');
  assert.equal(r.config.agents.hotfix!.runs, 'all-repos', 'runs is inherited along extends');
  s = steps(bp(r.config), [{ name: 'api', mode: 'full' }, { name: 'web', mode: 'tests_only' }]);
  assert.deepEqual(passSteps(s).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'hotfix@', 'tester@', 'reviewer@']);
  assert.deepEqual(stepRepos(s, s.next!), ['api']);
  assert.deepEqual(stepRepos(s, passSteps(s)[2]!), ['api', 'web']);

  // On a plan or review agent it means nothing, and says so.
  r = await load('agents:\n  reviewer: { runs: per-repo }\n');
  assert.ok(r.warnings.some((w) => w.code === 'runs_ignored'));
  assert.equal(bp(r.config).stages.find((st) => st.agent === 'reviewer')!.scope, 'task');
  await assert.rejects(() => config.updateAgentConfig(ws, 'tester', { runs: 'sometimes' }), /runs: expected one of per-repo, all-repos/);
});

test('scenarios: custom scenarios with their own agents, models and effort; built-in ones can be removed', async () => {
  const hotfix: NonNullable<ConfigLayer['scenarios']>[string] = { label: 'Hotfix', description: 'Code and a quick review', agents: ['developer', { agent: 'reviewer', model: 'sonnet', effort: 'low' }] };
  const r = passed(resolve([config.builtinLayer(), layer({ scenarios: { hotfix, 'deep-audit': { agents: [{ agent: 'auditor', effort: 'max' }] }, readiness: false } })]));
  assert.deepEqual(r.config.custom.hotfix, { id: 'hotfix', label: 'Hotfix', description: 'Code and a quick review', kind: 'deliver', agents: [{ name: 'developer' }, { name: 'reviewer', model: 'sonnet', effort: 'low' }], source: 'project' });
  assert.equal(r.config.custom['deep-audit']!.kind, 'audit', 'the kind follows from the agents');
  assert.deepEqual(r.config.removedScenarios, ['readiness']);
  assert.deepEqual(r.config.scenarios.readiness, []);

  const p = bp(r.config, { scenario: 'hotfix' });
  assert.deepEqual(p.stages.map((s) => s.agent), ['developer', 'reviewer']);
  assert.ok(p.reviewLoop, 'a delivery scenario gets the review loop');
  assert.equal(bp(r.config, { scenario: 'deep-audit' }).mode, 'audit');

  const mixed = failed(resolve([config.builtinLayer(), layer({ scenarios: { odd: { agents: ['developer', 'auditor'] } } })]));
  assert.deepEqual(mixed.errors.map((e) => e.code), ['scenario_mixed']);
  assert.match(failed(resolve([config.builtinLayer(), layer({ scenarios: { odd: { agents: ['ghost', 'developer', 'developer'] } } })])).errors.map((e) => e.code).join(), /scenario_unknown_agent.*scenario_duplicate/);

  // Written to the project file and run by the engine with the scenario's model and effort.
  const ws = tmp('cs-custom-');
  await config.setCustomScenario(ws, 'hotfix', { label: 'Hotfix', agents: [{ name: 'developer' }, { name: 'reviewer', model: 'sonnet', effort: 'low' }] });
  await config.removeScenario(ws, 'audit');
  const yaml = fs.readFileSync(config.projectConfigFile(ws), 'utf8');
  assert.match(yaml, /hotfix:\n\s+label: Hotfix\n\s+agents:\n\s+- developer\n\s+- agent: reviewer\n\s+model: sonnet\n\s+effort: low/);
  assert.match(yaml, /audit: false/);
  const engine = new Engine({ workspace: ws, home: tmp('cs-h-'), runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'] });
  const prev = await previewOf(engine, { text: 'Fix the login', scenario: 'hotfix' });
  assert.equal(prev.scenarioName, 'hotfix');
  assert.deepEqual(prev.effort, { reviewer: 'low' });
  assert.equal((await previewOf(engine, { text: 'Зроби аудит проекту' })).scenarioName, 'deliver', 'words cannot pick a removed scenario');
  await assert.rejects(() => engine.start({ text: 'x', scenario: 'audit' }), /no scenario "audit"/);
  assert.match(prev.problem!, /name them with --repos/, 'no planner names its repos, and the workspace has none');
  const { taskId } = await engine.start({ text: 'Fix the login --repos api', scenario: 'hotfix', effort: { developer: 'high' } });
  const s = await engine.svc.state(taskId);
  assert.equal(s.scenario, 'deliver');
  assert.equal(s.scenarioLabel, 'Hotfix');
  assert.deepEqual(s.model, { reviewer: 'sonnet' });
  assert.deepEqual(s.effort, { reviewer: 'low', developer: 'high' }, 'the composer adds to the scenario effort');

  await config.setCustomScenario(ws, 'quick-fix', { label: 'Quick fix', agents: [{ name: 'developer' }] }, 'hotfix');
  await config.restoreScenario(ws, 'audit');
  const after = passed(await loadCfg({ workspace: ws, home: tmp('cs-h-') }));
  assert.deepEqual(Object.keys(after.config.custom), ['quick-fix'], 'renamed');
  assert.deepEqual(after.config.removedScenarios, []);
  await config.removeScenario(ws, 'quick-fix');
  assert.deepEqual(Object.keys(passed(await loadCfg({ workspace: ws, home: tmp('cs-h-') })).config.custom), []);
});

test('config edits from the dashboard: new scenarios and agents, kept only when the config still works', async () => {
  const ws = tmp('cs-edit-');
  const home = tmp('cs-edit-h-');
  const resolved = async () => passed(await loadCfg({ workspace: ws, home })).config;

  // A scenario is named after its label; taken and reserved names get a number, labels stay unique.
  assert.equal(await config.saveCustomScenario({ workspace: ws, home, label: 'Quick fix', agents: [{ name: 'developer' }] }), 'quick-fix');
  assert.equal(await config.saveCustomScenario({ workspace: ws, home, label: 'Quick-fix!' }), 'quick-fix-2');
  assert.equal(await config.saveCustomScenario({ workspace: ws, home, label: 'Audit' }), 'audit-2', 'a built-in name is not taken');
  assert.equal(await config.saveCustomScenario({ workspace: ws, home, label: 'Перевірка' }), 'scenario', 'no Latin letters: a plain name');
  await assert.rejects(() => config.saveCustomScenario({ workspace: ws, home, label: 'quick fix' }), /already exists/);
  await assert.rejects(() => config.saveCustomScenario({ workspace: ws, home, label: '  ' }), /Give the scenario a name/);
  await assert.rejects(() => config.saveCustomScenario({ workspace: ws, home, id: 'nope', label: 'X' }), /no scenario "nope"/);
  assert.equal(await config.saveCustomScenario({ workspace: ws, home, id: 'quick-fix', label: 'Quick fix', description: ' d ', agents: [{ name: 'developer' }, { name: 'reviewer', effort: 'low' }] }), 'quick-fix');
  assert.deepEqual((await resolved()).custom['quick-fix']!.agents, [{ name: 'developer' }, { name: 'reviewer', effort: 'low' }]);

  // A change that would break the config is undone, with the problem that names this scenario.
  const before = fs.readFileSync(config.projectConfigFile(ws), 'utf8');
  await assert.rejects(() => config.saveCustomScenario({ workspace: ws, home, id: 'quick-fix', label: 'Quick fix', agents: [{ name: 'developer' }, { name: 'auditor' }] }), /quick-fix.*mixes/);
  assert.equal(fs.readFileSync(config.projectConfigFile(ws), 'utf8'), before);

  // An agent based on another runs right after it, with its own instructions file.
  const file = await config.addAgent({ workspace: ws, home, name: 'security-reviewer', base: 'developer', description: 'Checks for injection' });
  assert.equal(file, path.join(ws, config.CONFIG_DIR, config.PROMPTS_DIR, 'security-reviewer.md'));
  assert.match(fs.readFileSync(file, 'utf8'), /Added to the instructions of "developer"/);
  assert.deepEqual((await resolved()).pipeline, ['planner', 'developer', 'security-reviewer', 'tester', 'reviewer']);
  // One that writes a readiness report joins that scenario, not the pipeline.
  // Without a description an agent of its own would break the config: the old panel left it so, this undoes it.
  await assert.rejects(() => config.addAgent({ workspace: ws, home, name: 'qa-check', output: 'readiness' }), /needs a description/);
  assert.equal(fs.existsSync(path.join(ws, config.CONFIG_DIR, config.PROMPTS_DIR, 'qa-check.md')), false);
  await config.addAgent({ workspace: ws, home, name: 'qa-check', output: 'readiness', description: 'Checks QA notes' });
  assert.deepEqual((await resolved()).scenarios.readiness, ['verifier', 'qa-check']);
  assert.ok(!(await resolved()).pipeline.includes('qa-check'));
  await assert.rejects(() => config.addAgent({ workspace: ws, home, name: 'Bad Name' }), /lowercase/);
  await assert.rejects(() => config.addAgent({ workspace: ws, home, name: 'developer' }), /already exists/);
  // Based on an agent that does not exist: nothing is left behind, not even the instructions file.
  await assert.rejects(() => config.addAgent({ workspace: ws, home, name: 'ghost', base: 'not-here' }));
  assert.equal(fs.existsSync(path.join(ws, config.CONFIG_DIR, config.PROMPTS_DIR, 'ghost.md')), false);
  assert.ok(!(await resolved()).agents.ghost);
});

test('groups and instructions: written in the composer, frozen into a task, and given to every agent', async () => {
  const ws = tmp('cs-extra-');
  const home = tmp('cs-extra-h-');
  const resolved = async () => passed(await loadCfg({ workspace: ws, home })).config;

  // Named after their label like scenarios; the Jira key is written in capitals and must look like one.
  assert.equal(await config.saveGroup({ workspace: ws, home, type: 'epic', label: 'Checkout revamp', jira: ' cp-123 ' }), 'checkout-revamp');
  assert.equal(await config.saveGroup({ workspace: ws, home, type: 'story', label: 'Checkout-revamp!' }), 'checkout-revamp-2');
  assert.deepEqual((await resolved()).groups['checkout-revamp'], { id: 'checkout-revamp', type: 'epic', label: 'Checkout revamp', jira: 'CP-123' });
  await assert.rejects(() => config.saveGroup({ workspace: ws, home, type: 'epic', label: 'X', jira: 'CP 1' }), /not a Jira key/);
  await assert.rejects(() => config.saveGroup({ workspace: ws, home, type: 'epic', label: 'checkout REVAMP' }), /group called .* already exists/);
  await assert.rejects(() => config.saveGroup({ workspace: ws, home, type: 'group', label: ' ' }), /Give the group a name/);
  await assert.rejects(() => config.saveGroup({ workspace: ws, home, id: 'nope', type: 'group', label: 'X' }), /no group "nope"/);
  // Editing keeps the id; dropping the Jira key removes it.
  assert.equal(await config.saveGroup({ workspace: ws, home, id: 'checkout-revamp', type: 'story', label: 'Checkout v2' }), 'checkout-revamp');
  assert.deepEqual((await resolved()).groups['checkout-revamp'], { id: 'checkout-revamp', type: 'story', label: 'Checkout v2' });

  assert.equal(await config.saveInstruction({ workspace: ws, home, label: 'No new deps', text: ' Use what the repo has. ' }), 'no-new-deps');
  assert.equal(await config.saveInstruction({ workspace: ws, home, label: 'Тести', text: 'Cover edge cases' }), 'instruction', 'no Latin letters: a plain id');
  assert.equal((await resolved()).instructions['no-new-deps']!.text, 'Use what the repo has.');
  await assert.rejects(() => config.saveInstruction({ workspace: ws, home, label: 'Empty', text: '  ' }), /Write the instruction/);

  // Your user config can hold them too; only the project's own can be deleted from the project.
  fs.mkdirSync(path.join(home, config.CONFIG_DIR), { recursive: true });
  fs.writeFileSync(config.userConfigFile(home), 'instructions:\n  mine: { label: Mine, text: Keep it short }\n');
  assert.equal((await resolved()).instructions.mine!.label, 'Mine');
  await assert.rejects(() => config.removeEntry(ws, 'instructions', 'mine'), /not in this project's config\.yaml/);
  await config.removeEntry(ws, 'groups', 'checkout-revamp-2');
  assert.deepEqual(Object.keys((await resolved()).groups), ['checkout-revamp']);
  assert.match(fs.readFileSync(config.projectConfigFile(ws), 'utf8'), /^groups:/m);
  await config.removeEntry(ws, 'groups', 'checkout-revamp');
  assert.doesNotMatch(fs.readFileSync(config.projectConfigFile(ws), 'utf8'), /^groups:/m, 'no empty section is left');

  // A task keeps them as they were when it started.
  await config.saveGroup({ workspace: ws, home, type: 'epic', label: 'Payments', jira: 'CP-7', instructions: ' Refunds live under /v2/refunds. ' });
  const engine = new Engine({ workspace: ws, home, runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'] });
  await assert.rejects(() => engine.start({ text: 'x', group: 'gone' }), /no group "gone"/);
  await assert.rejects(() => engine.start({ text: 'x', instructions: ['no-new-deps', 'gone'] }), /no instruction "gone"/);
  const r = await engine.start({ text: 'Add refunds', group: 'payments', instructions: ['no-new-deps', 'mine'] });
  await config.saveInstruction({ workspace: ws, home, id: 'no-new-deps', label: 'No new deps', text: 'Changed later' });
  let s = await engine.svc.state(r.taskId);
  assert.deepEqual(s.group, { id: 'payments', type: 'epic', label: 'Payments', jira: 'CP-7', instructions: 'Refunds live under /v2/refunds.' });
  assert.deepEqual(s.instructions.map((x) => x.text), ['Use what the repo has.', 'Keep it short']);
  assert.deepEqual((await engine.svc.state((await engine.start({ text: 'Plain' })).taskId)).instructions, [], 'none picked: none given');

  // Every agent's prompt names the group and carries the instructions verbatim.
  await engine.dispatch(r.taskId, { type: 'intake_completed', spec: { ...spec, id: r.taskId } });
  s = await engine.svc.state(r.taskId);
  const prompt = buildAgentPrompt({ state: s, next: runOf(nx(s)), taskDir: ws, language: 'English' });
  assert.match(prompt, /Part of the epic "Payments" \(Jira CP-7\)\./);
  assert.match(prompt, /instructions for this task, verbatim[^\n]*\n\n### For every task in "Payments"\nRefunds live under \/v2\/refunds\.\n\n### No new deps\nUse what the repo has\.\n\n### Mine\nKeep it short/, "the group's first, then the task's own");
  // A group ticks instructions that exist; deleting one unticks it everywhere in the project.
  await assert.rejects(() => config.saveGroup({ workspace: ws, home, id: 'payments', type: 'epic', label: 'Payments', defaultInstructions: ['nope'] }), /no instruction "nope"/);
  await config.saveGroup({ workspace: ws, home, id: 'payments', type: 'epic', label: 'Payments', instructions: 'x', defaultInstructions: ['no-new-deps', 'mine', 'no-new-deps'] });
  assert.deepEqual((await resolved()).groups.payments!.defaultInstructions, ['no-new-deps', 'mine']);
  await config.removeEntry(ws, 'instructions', 'no-new-deps');
  assert.deepEqual((await resolved()).groups.payments!.defaultInstructions, ['mine']);
  // One named in a hand-written config that does not exist is left out with a warning, not an error.
  await config.setProjectValue(ws, ['groups', 'payments', 'defaultInstructions'], ['mine', 'ghost']);
  const loaded = passed(await loadCfg({ workspace: ws, home }));
  assert.deepEqual(loaded.config.groups.payments!.defaultInstructions, ['mine']);
  assert.ok(loaded.warnings.some((w) => w.code === 'unknown_instruction' && w.message.includes('"ghost"')));

  // A group without instructions adds none; a blank text is not written.
  assert.equal(await config.saveGroup({ workspace: ws, home, id: 'payments', type: 'epic', label: 'Payments', instructions: '  ' }), 'payments');
  assert.equal((await resolved()).groups.payments!.instructions, undefined);
});

test('setup: a picked repo is written with only what differs from the defaults; settings are checked by shape', async () => {
  assert.deepEqual(repoLayerOf({ name: 'api', path: 'api' }), {});
  assert.deepEqual(repoLayerOf({ name: 'api', path: 'services/api', role: 'REST API', baseBranch: 'develop', gates: [{ name: 'lint', cmd: 'npm run lint' }] }), { role: 'REST API', path: 'services/api', baseBranch: 'develop', gates: [{ name: 'lint', cmd: 'npm run lint' }] });
  assert.deepEqual(repoLayerOf({ name: 'api', path: 'api', baseBranch: 'develop', gates: [] }, 'develop'), {}, 'the workspace base branch is the default');

  assert.deepEqual(validateSetting('notifications', 'needsYou'), []);
  assert.deepEqual(validateSetting('settingSources', ['project', 'local']), []);
  assert.deepEqual(validateSetting('askPermissions', true), []);
  assert.equal(validateSetting('notifications', 'loud').length, 1);
  assert.equal(validateSetting('settingSources', ['everything']).length, 1);
  assert.equal(validateSetting('askPermissions', 'yes').length, 1);
  assert.equal(validateSetting('claudePath', { evil: true }).length, 1);
  assert.match(validateSetting('constructor', 'x')[0]!, /unknown setting/, 'nothing reached through the prototype');
  assert.match(validateSetting('editor.fontSize', 30)[0]!, /unknown setting/);
});

/** A library folder: one agent of its own with its instructions in prompts/, and a scenario that runs it. */
function securityLibrary(dir: string = tmp('cs-lib-')): string {
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompts', 'security.md'), 'Look for injection first. The checklist is {{dir}}/checklist.md.\n');
  fs.writeFileSync(path.join(dir, 'library.yaml'), [
    'agents:',
    '  security-reviewer:',
    '    extends: reviewer',
    '    description: Reviews for security',
    '    instructions: { mode: append, file: ./prompts/security.md }',
    'scenarios:',
    '  secure-delivery:',
    '    label: Secure delivery',
    '    agents: [planner, developer, security-reviewer]',
    '',
  ].join('\n'));
  return dir;
}

const userConfig = (home: string, text: string): void => {
  fs.mkdirSync(path.join(home, config.CONFIG_DIR), { recursive: true });
  fs.writeFileSync(path.join(home, config.CONFIG_DIR, config.CONFIG_FILE), text);
};

test('libraries: agents and scenarios from a folder of their own merge in, a project changes them without touching the library', async () => {
  const lib = securityLibrary();
  const home = tmp('cs-lib-h-');
  const ws = tmp('cs-lib-ws-');
  userConfig(home, `libraries: [${lib}]\n`);
  const label = path.basename(lib);

  const r = passed(await loadCfg({ workspace: ws, home }));
  const agent = r.config.agents['security-reviewer']!;
  assert.ok(agent.layers.includes(`library:${label}`));
  assert.match(agent.instructions, /Look for injection first/, 'instruction files resolve from the library folder');
  assert.ok(agent.instructions.includes(`The checklist is ${lib}/checklist.md.`), '{{dir}} names the library folder, wherever it is kept');
  assert.equal(r.config.custom['secure-delivery']!.source, `library:${label}`);
  assert.deepEqual(r.config.pipeline, ['planner', 'developer', 'tester', 'reviewer'], 'a library agent is not run by default');
  assert.ok(!r.warnings.some((w) => w.code === 'not_in_pipeline'), 'nor is it reported as never running');
  assert.deepEqual(bp(r.config, { scenario: 'secure-delivery' }).stages.map((st) => st.agent), ['planner', 'developer', 'security-reviewer']);

  // The project changes the library's agent; the library file stays as it was.
  const before = fs.readFileSync(path.join(lib, 'library.yaml'), 'utf8');
  await config.updateAgentConfig(ws, 'security-reviewer', { model: 'opus' });
  const changed = passed(await loadCfg({ workspace: ws, home })).config.agents['security-reviewer']!;
  assert.equal(changed.model, 'opus');
  assert.deepEqual(changed.layers.filter((l) => l !== 'builtin'), [`library:${label}`, 'project']);
  assert.equal(fs.readFileSync(path.join(lib, 'library.yaml'), 'utf8'), before);

  // A library that is not there: a warning, the rest loads. One that holds more than agents and scenarios: an error.
  userConfig(home, `libraries: [${lib}, ${path.join(lib, 'nope')}]\n`);
  assert.ok(passed(await loadCfg({ workspace: ws, home })).warnings.some((w) => w.code === 'library_missing'));
  const bad = tmp('cs-lib-bad-');
  fs.writeFileSync(path.join(bad, 'library.yaml'), 'repos:\n  api: {}\n');
  userConfig(home, `libraries: [${bad}]\n`);
  assert.match(failed(await loadCfg({ workspace: ws, home })).errors[0]!.message, /only agents and scenarios/);

  // Two libraries with the same agent: the later one wins, and that is said.
  userConfig(home, `libraries: [${lib}, ${securityLibrary()}]\n`);
  assert.ok(passed(await loadCfg({ workspace: ws, home })).warnings.some((w) => w.code === 'library_conflict'));
});

test('libraries: added for you or for the project, removed only when nothing needs them, and a project moves its own into one', async () => {
  const home = tmp('cs-lib-h-');
  const ws = tmp('cs-lib-ws-');
  const where = { workspace: ws, home };

  // A folder inside the workspace is listed relative to .claudestrator/, so it works in every clone.
  const shared = path.join(ws, 'shared-agents');
  await assert.rejects(() => libraries.addLibrary({ ...where, dir: shared, scope: 'project' }), /no library\.yaml/);
  const added = await libraries.addLibrary({ ...where, dir: shared, scope: 'project', create: true });
  assert.deepEqual([added.scope, added.entry, added.exists], ['project', '../shared-agents', true]);
  assert.match(fs.readFileSync(path.join(shared, 'library.yaml'), 'utf8'), /^# Claudestrator library/);
  await assert.rejects(() => libraries.addLibrary({ ...where, dir: shared, scope: 'user' }), /already/);
  // One elsewhere under home, for you: `~/…` in the user config.
  const mine = path.join(home, 'my-agents');
  fs.mkdirSync(mine);
  securityLibrary(mine);
  assert.equal((await libraries.addLibrary({ ...where, dir: mine, scope: 'user' })).entry, '~/my-agents');
  assert.deepEqual((await libraries.listLibraries(where)).map((l) => [l.label, l.scope, l.agents.join(), l.scenarios.join()]), [['my-agents', 'user', 'security-reviewer', 'secure-delivery'], ['shared-agents', 'project', '', '']]);

  // While the project runs a library's agent, the library cannot go.
  await config.saveCustomScenario({ ...where, label: 'Careful', agents: [{ name: 'developer' }, { name: 'security-reviewer' }] });
  const userFile = path.join(home, config.CONFIG_DIR, config.CONFIG_FILE);
  const before = fs.readFileSync(userFile, 'utf8');
  await assert.rejects(() => libraries.removeLibrary({ ...where, file: path.join(mine, 'library.yaml'), scope: 'user' }), /security-reviewer/);
  assert.equal(fs.readFileSync(userFile, 'utf8'), before, 'the user config is as it was');
  await config.removeScenario(ws, 'careful');
  await libraries.removeLibrary({ ...where, file: path.join(mine, 'library.yaml'), scope: 'user' });
  assert.deepEqual((await libraries.listLibraries(where)).map((l) => l.label), ['shared-agents']);

  // The project's own scenario moves into the shared library, with the agent it needs and that agent's instructions.
  await config.addAgent({ ...where, name: 'perf-auditor', output: 'audit', description: 'Finds slow code' });
  fs.writeFileSync(path.join(ws, config.CONFIG_DIR, config.PROMPTS_DIR, 'perf-auditor.md'), 'Measure before you judge.\n');
  await config.saveCustomScenario({ ...where, label: 'Perf audit', agents: [{ name: 'perf-auditor', effort: 'high' }] });
  const moved = await libraries.moveToLibrary({ ...where, library: path.join(shared, 'library.yaml'), scenarios: ['perf-audit'] });
  assert.deepEqual(moved, { agents: ['perf-auditor'], scenarios: ['perf-audit'] });
  assert.equal(fs.readFileSync(path.join(shared, 'prompts', 'perf-auditor.md'), 'utf8'), 'Measure before you judge.\n');
  assert.match(fs.readFileSync(path.join(shared, 'library.yaml'), 'utf8'), /^agents:\n {2}perf-auditor:\n {4}/m, 'written as a person would, not on one line');
  assert.equal(fs.existsSync(path.join(ws, config.CONFIG_DIR, config.PROMPTS_DIR, 'perf-auditor.md')), false, 'the project copy is gone');
  const projectNow = await config.readProjectLayer(ws);
  assert.ok(!(projectNow.agents && projectNow.agents['perf-auditor']) && !(projectNow.scenarios && projectNow.scenarios['perf-audit']));
  const after = passed(await loadCfg({ workspace: ws, home })).config;
  assert.equal(after.custom['perf-audit']!.source, 'library:shared-agents');
  assert.match(after.agents['perf-auditor']!.instructions, /Measure before you judge/);
  await assert.rejects(() => libraries.moveToLibrary({ ...where, library: '/nowhere/library.yaml', agents: ['developer'] }), /not one of this project's libraries/);
  await assert.rejects(() => libraries.moveToLibrary({ ...where, library: path.join(shared, 'library.yaml'), agents: ['ghost'] }), /not defined in this project/);
});

/** A project with an agent of its own (its instructions in a file), a changed built-in agent, a pipeline and scenarios. */
async function projectWithAgents(): Promise<string> {
  const ws = tmp('cs-backup-');
  const dir = path.join(ws, config.CONFIG_DIR);
  fs.mkdirSync(path.join(dir, config.PROMPTS_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, config.PROMPTS_DIR, 'security-reviewer.md'), 'Look for injection first.\n');
  await config.createProjectConfig(ws, {
    agents: {
      'security-reviewer': { extends: 'reviewer', description: 'Reviews for security', instructions: { mode: 'append', file: './prompts/security-reviewer.md' } },
      developer: { model: 'opus', maxTurns: 40 },
    },
    pipeline: ['planner', 'developer', 'tester', 'security-reviewer'],
    scenarios: { audit: false, hotfix: { label: 'Hotfix', agents: ['developer', { agent: 'security-reviewer', effort: 'low' }] } },
  });
  return ws;
}

const noBackup = { savedAt: undefined, agents: {}, files: {}, pipeline: undefined, scenarios: {} };

test('backup: agents, pipeline and scenarios are saved as YAML with the instruction files, read back (JSON too), anything else is refused', async () => {
  const made = await backups.createBackup({ workspace: await projectWithAgents(), now: new Date('2026-10-28T12:00:00Z') });
  assert.deepEqual([made.agents, made.scenarios, made.pipeline], [2, 2, true]);
  assert.match(made.text, /^# Claudestrator backup/);
  assert.match(made.text, /claudestrator-backup: 1/);
  assert.match(made.text, /pipeline: \[ planner, developer, tester, security-reviewer \]/, 'a list of names stays on one line, written the way the extension writes config.yaml');
  assert.match(made.text, /audit: false/);
  assert.match(made.text, /files:\n\s+\.\/prompts\/security-reviewer\.md: \|\n\s+Look for injection first\./, 'the instruction file travels in the backup');

  const parsed = backups.parseBackup(made.text);
  assert.ok(parsed.ok);
  assert.deepEqual(Object.keys(parsed.backup.agents).sort(), ['developer', 'security-reviewer']);
  assert.deepEqual(parsed.backup.files, { './prompts/security-reviewer.md': 'Look for injection first.\n' });
  assert.deepEqual(parsed.backup.pipeline, ['planner', 'developer', 'tester', 'security-reviewer']);
  assert.deepEqual(Object.keys(parsed.backup.scenarios), ['audit', 'hotfix']);
  assert.equal(parsed.backup.savedAt, '2026-10-28T12:00:00.000Z');

  const { savedAt, ...asData } = parsed.backup;
  assert.ok(savedAt);
  assert.ok(backups.parseBackup(JSON.stringify({ [backups.MARKER]: 1, ...asData })).ok, 'a backup converted to JSON restores too');

  const error = (t: string): string => {
    const r = backups.parseBackup(t);
    assert.ok(!r.ok, t);
    return r.error;
  };
  assert.match(error('agents:\n  developer: {}\n'), /not a Claudestrator backup/, 'a config.yaml is not a backup');
  assert.match(error('just some text'), /not a Claudestrator backup/);
  assert.match(error('a: [1'), /not valid YAML or JSON/);
  assert.match(error(`${backups.MARKER}: 2\nscenarios: {}`), /newer Claudestrator/);
  assert.match(error(`${backups.MARKER}: 1`), /backup is empty/);
  assert.match(error(`${backups.MARKER}: 1\nscenarios:\n  deliver: [developer]`), /reserved/);
  assert.match(error(`${backups.MARKER}: 1\nagents:\n  Odd Name: {}\n`), /lowercase kebab-case/);
  assert.match(error(`${backups.MARKER}: 1\nagents:\n  qa: {}\nfiles:\n  ../../evil.md: pwned\n`), /outside \.claudestrator/, 'a file may not leave .claudestrator/');
  assert.match(error(`${backups.MARKER}: 1\nagents:\n  qa: {}\nfiles:\n  /etc/passwd: pwned\n`), /outside \.claudestrator/);
  assert.match(error(`${backups.MARKER}: 1\nagents:\n  qa: {}\nfiles:\n  ./config.yaml: 'repos: {}'\n`), /outside \.claudestrator\/prompts/, 'a backup may not overwrite config.yaml');
  assert.match(error(`${backups.MARKER}: 1\nagents:\n  qa: {}\nfiles:\n  ./prompts/qa.md: 5\n`), /"files" section/);

  await assert.rejects(() => backups.createBackup({ workspace: tmp('cs-backup-'), now: new Date() }), /nothing to back up/);
  const broken = tmp('cs-backup-');
  fs.mkdirSync(path.join(broken, config.CONFIG_DIR));
  fs.writeFileSync(config.projectConfigFile(broken), 'agents: [unclosed\n');
  await assert.rejects(() => backups.createBackup({ workspace: broken, now: new Date() }), /does not parse/);
});

test('backup: restore into another project writes the agents with their instruction files, the pipeline and the scenarios', async () => {
  const parsed = backups.parseBackup((await backups.createBackup({ workspace: await projectWithAgents(), now: new Date() })).text);
  assert.ok(parsed.ok);
  const to = tmp('cs-backup-');
  const home = tmp('cs-backup-h-');
  await config.setCustomScenario(to, 'mine', { label: 'Mine', agents: [{ name: 'developer' }] });

  const plan = await backups.previewRestore({ workspace: to, backup: parsed.backup, home });
  assert.deepEqual(plan.agents, { add: ['security-reviewer', 'developer'], replace: [] });
  assert.equal(plan.pipeline, true);
  assert.deepEqual(plan.scenarios, { add: ['audit', 'hotfix'], replace: [] });
  assert.deepEqual(plan.skipped, []);

  await backups.restoreBackup({ workspace: to, backup: parsed.backup, home });
  assert.equal(fs.readFileSync(path.join(to, config.CONFIG_DIR, config.PROMPTS_DIR, 'security-reviewer.md'), 'utf8'), 'Look for injection first.\n');
  const after = passed(await loadCfg({ workspace: to, home }));
  assert.equal(after.config.agents['security-reviewer']!.description, 'Reviews for security');
  assert.match(after.config.agents['security-reviewer']!.instructions, /Look for injection first\./);
  assert.equal(after.config.agents.developer!.model, 'opus');
  assert.deepEqual((await config.readProjectLayer(to)).pipeline, ['planner', 'developer', 'tester', 'security-reviewer']);
  assert.deepEqual(Object.keys(after.config.custom).sort(), ['hotfix', 'mine'], 'a scenario that is not in the backup is not touched');
  assert.deepEqual(after.config.removedScenarios, ['audit']);

  // The same backup again replaces what is there, an agent entirely, instruction file included.
  await config.updateAgentConfig(to, 'security-reviewer', { description: 'Edited by hand' });
  fs.writeFileSync(path.join(to, config.CONFIG_DIR, config.PROMPTS_DIR, 'security-reviewer.md'), 'Edited too.\n');
  assert.deepEqual((await backups.previewRestore({ workspace: to, backup: parsed.backup, home })).agents.replace, ['security-reviewer', 'developer']);
  await backups.restoreBackup({ workspace: to, backup: parsed.backup, home });
  assert.equal(passed(await loadCfg({ workspace: to, home })).config.agents['security-reviewer']!.description, 'Reviews for security');
  assert.equal(fs.readFileSync(path.join(to, config.CONFIG_DIR, config.PROMPTS_DIR, 'security-reviewer.md'), 'utf8'), 'Look for injection first.\n');
});

test('backup: what the project cannot run is left out and said so, a file outside .claudestrator/ is never written', async () => {
  const ws = tmp('cs-backup-');
  const home = tmp('cs-backup-h-');
  const backup = {
    ...noBackup,
    files: { './prompts/a.md': 'A\n' },
    pipeline: ['planner', 'developer', 'ghost-agent'],
    agents: {
      a: { extends: 'reviewer', instructions: { mode: 'append', file: './prompts/a.md' } },
      b: { extends: 'not-here' },
      c: { extends: 'b' },
      d: { extends: 'reviewer', instructions: { mode: 'append', file: './prompts/missing.md' } },
      e: { extends: 'reviewer', instructions: { mode: 'append', file: '../escape.md' } },
      f: { extends: 'reviewer', instructions: { mode: 'replace', file: './config.yaml' } },
    },
    scenarios: { s1: { agents: ['developer', 'c'] }, s2: { agents: ['developer', 'a'] } },
  };
  const plan = await backups.previewRestore({ workspace: ws, backup, home });
  assert.deepEqual(plan.agents, { add: ['a'], replace: [] });
  assert.deepEqual(plan.skipped.map((x) => `${x.kind}:${x.id}`).sort(), ['agent:b', 'agent:c', 'agent:d', 'agent:e', 'agent:f', 'pipeline:pipeline', 'scenario:s1']);
  assert.match(plan.skipped.find((x) => x.id === 'c')!.reason, /builds on the agent "b"/, 'an agent whose base was left out is left out too');
  assert.match(plan.skipped.find((x) => x.id === 'd')!.reason, /not in the backup/);
  assert.match(plan.skipped.find((x) => x.id === 'e')!.reason, /outside \.claudestrator/);
  assert.match(plan.skipped.find((x) => x.kind === 'pipeline')!.reason, /"ghost-agent"/);
  assert.deepEqual(plan.scenarios.add, ['s2']);

  await backups.restoreBackup({ workspace: ws, backup, home });
  const after = passed(await loadCfg({ workspace: ws, home }));
  assert.ok(after.config.agents.a && !after.config.agents.b);
  assert.equal((await config.readProjectLayer(ws)).pipeline, undefined, 'a pipeline naming an unknown agent is not written');
  assert.equal(fs.existsSync(path.join(ws, 'escape.md')), false);
  // A backup of which nothing can be restored writes nothing and says why.
  const none = await backups.restoreBackup({ workspace: ws, backup: { ...noBackup, agents: { x: { extends: 'nope' } } }, home });
  assert.deepEqual(none.agents, { add: [], replace: [] });
  assert.deepEqual(none.skipped.map((x) => x.id), ['x']);
});

test('backup: file paths mean the same on Windows and on macOS/Linux', async () => {
  // A backup names its files with `/`; one written on Windows with `\` is the same file.
  assert.equal(backups.fileKey('./prompts/a.md'), 'prompts/a.md');
  assert.equal(backups.fileKey('.\\prompts\\a.md'), 'prompts/a.md');
  assert.equal(backups.fileKey('prompts/sub/../a.md'), 'prompts/a.md');
  for (const bad of ['../x.md', '..\\x.md', 'prompts/../../x.md', '/etc/passwd', 'C:\\Windows\\x.md', 'c:/x.md', '.', '..', './config.yaml', 'config.yaml', 'prompts/../config.yaml', './notes.md', 'prompts']) assert.equal(backups.fileKey(bad), null, bad);

  // The real folder check, with Windows paths (drive letters, `\`, another drive).
  const dir = 'C:\\Users\\me\\ws\\.claudestrator';
  assert.equal(backups.inside(dir, 'prompts/a.md', path.win32), 'C:\\Users\\me\\ws\\.claudestrator\\prompts\\a.md');
  assert.equal(backups.inside(dir, '..\\evil.md', path.win32), null);
  assert.equal(backups.inside(dir, 'D:\\evil.md', path.win32), null);
  assert.equal(backups.inside(dir, '.', path.win32), null);
  assert.equal(backups.inside('/ws/.claudestrator', 'prompts/a.md', path.posix), '/ws/.claudestrator/prompts/a.md');
  assert.equal(backups.inside('/ws/.claudestrator', '../.claudestrator-other/x', path.posix), null, 'a sibling folder with the same prefix is outside');

  // End to end: a Windows-made backup restores here, its agent finding its instruction file.
  const text = `${backups.MARKER}: 1\nagents:\n  a:\n    extends: reviewer\n    instructions:\n      mode: append\n      file: .\\prompts\\a.md\nfiles:\n  .\\prompts\\a.md: A\n`;
  const parsed = backups.parseBackup(text);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  const ws = tmp('cs-backup-');
  const home = tmp('cs-backup-h-');
  assert.deepEqual((await backups.previewRestore({ workspace: ws, backup: parsed.backup, home })).agents.add, ['a']);
  await backups.restoreBackup({ workspace: ws, backup: parsed.backup, home });
  assert.equal(fs.readFileSync(path.join(ws, config.CONFIG_DIR, 'prompts', 'a.md'), 'utf8'), 'A');
  assert.deepEqual((await config.readProjectLayer(ws)).agents!.a!.instructions, { mode: 'append', file: './prompts/a.md' }, 'the config names the file with `/`');
  assert.match(passed(await loadCfg({ workspace: ws, home })).config.agents.a!.instructions, /A/);
});

test('backup: a restore that would break the config is undone, instruction files included', async () => {
  const home = tmp('cs-backup-h-');
  const ws = await projectWithAgents();
  const file = config.projectConfigFile(ws);
  const promptsDir = path.join(ws, config.CONFIG_DIR, config.PROMPTS_DIR);
  const before = fs.readFileSync(file, 'utf8');
  const backup = {
    ...noBackup,
    files: { './prompts/security-reviewer.md': 'CHANGED\n', './prompts/new-agent.md': 'x\n' },
    agents: {
      'new-agent': { extends: 'reviewer', instructions: { mode: 'append', file: './prompts/new-agent.md' } },
      'security-reviewer': { extends: 'reviewer', instructions: { mode: 'replace', file: './prompts/security-reviewer.md' } },
    },
    scenarios: { odd: { agents: ['developer', 'auditor'] } },
  };
  await assert.rejects(() => backups.restoreBackup({ workspace: ws, backup, home }), /mixes agents/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'config.yaml is as it was');
  assert.equal(fs.readFileSync(path.join(promptsDir, 'security-reviewer.md'), 'utf8'), 'Look for injection first.\n', 'an overwritten file is put back');
  assert.equal(fs.existsSync(path.join(promptsDir, 'new-agent.md')), false, 'a new file is removed');

  const empty = tmp('cs-backup-');
  await assert.rejects(() => backups.restoreBackup({ workspace: empty, backup: { ...noBackup, scenarios: backup.scenarios }, home }), /mixes agents/);
  assert.equal(fs.existsSync(config.projectConfigFile(empty)), false, 'a config that did not exist is not left behind');
});

test('view: a task whose log does not replay gets a whole card, so the list and the sidebar still show the rest', async () => {
  const ws = tmp('cs-corrupt-');
  const { pipeline, config: cfg } = defaultPipeline();
  const svc = new TaskService({ workspace: ws });
  const ok = await svc.start({ input: 'x', source: { kind: 'text', text: 'x' }, auto: false, pipeline, config: cfg });
  const bad = path.join(ws, '.orch', 'tasks', 'T-BROKEN');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'events.ndjson'), '{"seq":1,"type":"stage_started","agent":"x","at":"2026-01-01T00:00:00.000Z"}\n');
  const entries = await svc.list();
  assert.deepEqual(entries.map((e) => e.taskId).sort(), [ok.taskId, 'T-BROKEN'].sort());
  const corrupt = entries.find((e) => e.corrupt)!;
  const card = await summary({} as ViewEngine, corrupt);
  assert.equal(card.status.key, 'corrupt');
  assert.equal(card.status.resumable, false, 'there is nothing to resume');
  assert.match(card.error!.message!, /log cannot be read: event #1 \(stage_started\) does not replay/);
  assert.deepEqual([card.mini, card.repos, card.progress], [[], [], { done: 0, total: 0 }], 'what the list and the tree read is there');
  assert.ok(!Number.isNaN(Date.parse(card.updatedAt)));
});

test('config: what the project config relaxes of your safety policy is said, not applied silently', async () => {
  const home = tmp('cs-home-');
  const ws = tmp('cs-ws-');
  fs.mkdirSync(path.join(home, '.claudestrator'));
  fs.writeFileSync(path.join(home, '.claudestrator', 'config.yaml'), 'policy: { forbidAiAttribution: true }\njira: { allowedProjects: [CP] }\n');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  const project = async (yaml: string) => {
    fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), yaml);
    const r = await config.loadConfig({ workspace: ws, home });
    assert.ok(r.ok);
    return r.warnings.filter((w) => w.code === 'policy_loosened').map((w) => w.message);
  };
  const said = await project("policy: { sandbox: false, network: ['*'], protectedBranches: [main], forbidAiAttribution: false, allowNoVerify: true, draftPrsOnly: false }\njira: { allowedProjects: [CP, OPS] }\n");
  for (const m of [/turns the sandbox off/, /reach any host/, /no longer protects master/, /allows AI attribution/, /git hooks be skipped/, /not as drafts|instead of as drafts/, /Jira projects you did not \(OPS\)/]) assert.ok(said.some((x) => m.test(x)), `${m}: ${said.join(' | ')}`);
  assert.deepEqual(await project("policy: { sandbox: true, protectedBranches: [main, master, release] }\njira: { allowedProjects: [CP] }\n"), [], 'tightening it says nothing');
  // What widens the sandbox without turning it off: a host, a folder, a credential for the checks, a tool that reaches out.
  const wider = await project('policy: { network: [evil.example], writable: [~/Library/LaunchAgents], localPorts: true, checkEnv: [GH_TOKEN, DATABASE_URL] }\nagents:\n  developer: { tools: [Read, Edit, Write, Bash, WebFetch, mcp__github] }\n');
  for (const m of [/reach evil\.example/, /write ~\/Library\/LaunchAgents/, /open local ports and reach every service listening on this machine/, /hands GH_TOKEN, DATABASE_URL to checks.*a GitHub token/, /gives the developer agent WebFetch, mcp__github/]) assert.ok(wider.some((x) => m.test(x)), `${m}: ${wider.join(' | ')}`);
  fs.writeFileSync(path.join(home, '.claudestrator', 'config.yaml'), 'policy: { forbidAiAttribution: true, network: [evil.example], checkEnv: [DATABASE_URL] }\njira: { allowedProjects: [CP] }\n');
  assert.ok(!(await project('policy: { network: [evil.example], checkEnv: [DATABASE_URL] }\n')).some((x) => /evil|DATABASE_URL/.test(x)), 'what your own config already allows is not news');

  // A library the project lists comes with the repo too: what its agents reach is said like the project's own.
  fs.mkdirSync(path.join(ws, 'lib'));
  fs.writeFileSync(path.join(ws, 'lib', 'library.yaml'), 'agents:\n  developer: { mcp: true, tools: [Read, Edit, Write, Bash, mcp__github__*] }\n  planner: { tools: [Read, Grep, WebFetch] }\n');
  const fromLib = await project('libraries: [../lib]\n');
  for (const m of [/library "lib" the project's config lists gives the developer agent mcp__github__\*/, /library "lib" .* turns MCP servers on for the developer agent/, /library "lib" .* gives the planner agent WebFetch/]) assert.ok(fromLib.some((x) => m.test(x)), `${m}: ${fromLib.join(' | ')}`);
  // The same library listed in your own config is yours.
  fs.writeFileSync(path.join(home, '.claudestrator', 'config.yaml'), `libraries: [${path.join(ws, 'lib')}]\n`);
  assert.deepEqual(await project('language: English\n'), [], 'a library you list is not news');
});

test("config: a project's or a library's instruction files stay inside it, and none is a credential or a system file", async () => {
  const home = fs.realpathSync(tmp('cs-home-'));
  const ws = fs.realpathSync(tmp('cs-ws-'));
  const lib = fs.realpathSync(tmp('cs-lib-'));
  fs.mkdirSync(path.join(home, '.aws'));
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key = x\n');
  fs.writeFileSync(path.join(home, 'notes.md'), 'Mine.\n');
  fs.mkdirSync(path.join(ws, '.claudestrator', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claudestrator', 'prompts', 'dev.md'), 'Be brief.\n');
  fs.symlinkSync(path.join(home, 'notes.md'), path.join(ws, '.claudestrator', 'prompts', 'link.md'));
  fs.writeFileSync(path.join(lib, 'library.yaml'), 'agents:\n  security: { extends: reviewer, instructions: { mode: append, file: ../outside.md } }\n');
  fs.writeFileSync(path.join(path.dirname(lib), 'outside.md'), 'x\n');
  const load = async (projectYaml: string, userYaml = '') => {
    fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), projectYaml);
    fs.mkdirSync(path.join(home, '.claudestrator'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claudestrator', 'config.yaml'), userYaml);
    return config.loadConfig({ workspace: ws, home });
  };
  const refused = async (projectYaml: string, userYaml?: string): Promise<string> => {
    const r = await load(projectYaml, userYaml);
    assert.ok(!r.ok, `refused: ${projectYaml}`);
    return r.errors.map((e) => e.message).join('\n');
  };
  assert.ok((await load('agents:\n  developer: { instructions: { mode: append, file: ./prompts/dev.md } }\n')).ok);
  assert.match(await refused('agents:\n  developer: { instructions: { file: ../../outside.md } }\n'), /outside the workspace/);
  assert.match(await refused('agents:\n  developer: { instructions: { file: ./prompts/link.md } }\n'), /outside the workspace/, 'a link out of it too');
  assert.match(await refused(`agents:\n  developer: { instructions: { file: ${path.join(home, '.aws', 'credentials')} } }\n`), /holds credentials/);
  const unused = await load(`libraries: [${lib}]\n`);
  assert.ok(unused.ok && unused.warnings.some((w) => w.agent === 'security' && /outside the library/.test(w.message)), 'an agent nothing runs is a warning, as for a missing file');
  assert.match(await refused(`libraries: [${lib}]\npipeline: [planner, developer, security]\n`), /outside the library/);
  assert.match(await refused('', `agents:\n  developer: { instructions: { file: ${path.join(home, '.aws', 'credentials')} } }\n`), /holds credentials/, 'your own config names no credential either');
  assert.ok((await load('', `agents:\n  developer: { instructions: { mode: append, file: ${path.join(home, 'notes.md')} } }\n`)).ok, 'your own config names any other file');
  if (fs.existsSync('/proc/self/environ')) assert.match(await refused('agents:\n  developer: { instructions: { file: /proc/self/environ } }\n'), /system file/);
  // A repo's dotenv file is inside the workspace, and holds its keys all the same.
  fs.mkdirSync(path.join(ws, 'api'));
  for (const name of ['.env', '.env.staging', '.envrc', '.ENV.local']) {
    fs.writeFileSync(path.join(ws, 'api', name), 'STRIPE_KEY=sk_live_x\n');
    assert.match(await refused(`agents:\n  planner: { instructions: { mode: append, file: ../api/${name} } }\n`), /dotenv file/, name);
  }
  fs.symlinkSync(path.join(ws, 'api', '.env'), path.join(ws, '.claudestrator', 'prompts', 'env.md'));
  assert.match(await refused('agents:\n  planner: { instructions: { mode: append, file: ./prompts/env.md } }\n'), /dotenv file/, 'through a link too');
});

test('config: policy.writable opens no home folder, nothing above it and not the whole disk', async () => {
  for (const w of ['~', '~/', '/', '~/.']) assert.ok(validateConfigLayer({ policy: { writable: [w] } }).length, `${w} is refused by the schema`);
  assert.deepEqual(validateConfigLayer({ policy: { writable: ['~/.cache/go-build', '/opt/cache dir'] } }), []);
  const home = fs.realpathSync(tmp('cs-home-'));
  const ws = tmp('cs-ws-');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  for (const w of [path.dirname(home), `${home}/x/..`]) {
    fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), `policy: { writable: ['${w}'] }\n`);
    const r = await config.loadConfig({ workspace: ws, home });
    assert.ok(!r.ok && r.errors.some((e) => e.code === 'writable_too_wide'), w);
  }
});

test('view: streamed text of one step merges into one message, other items keep their order', async () => {
  const q: OutputPush[] = [];
  const delta = (key: string, text: string): OutputPush => ({ type: 'output', taskId: 'T', key, item: { type: 'text_delta', text } });
  for (const piece of ['Rea', 'ding ', 'the file']) queueOutput(q, delta('a', piece));
  queueOutput(q, { type: 'output', taskId: 'T', key: 'a', item: { type: 'tool_use', id: '1', name: 'Read', input: {} } });
  queueOutput(q, delta('a', 'Done'));
  queueOutput(q, delta('b', 'other step'));
  queueOutput(q, delta('b', '!'));
  assert.deepEqual(q.map((m) => [m.key, m.item.type, 'text' in m.item ? m.item.text : '']), [['a', 'text_delta', 'Reading the file'], ['a', 'tool_use', ''], ['a', 'text_delta', 'Done'], ['b', 'text_delta', 'other step!']]);
});

test('config: read again only when a file it comes from changes, and a path to a device is refused, not read', async () => {
  const home = tmp('cs-home-');
  const ws = tmp('cs-ws-');
  const dir = path.join(ws, '.claudestrator');
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompts', 'dev.md'), 'Be brief.\n');
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'agents:\n  developer: { instructions: { mode: append, file: ./prompts/dev.md } }\nlanguage: German\n');
  const load = async () => passed(await config.loadConfig({ workspace: ws, home })).config;
  const first = await load();
  assert.match(first.agents.developer!.instructions, /Be brief\.$/);
  const again = await load();
  assert.deepEqual(again, first);
  again.language = 'mutated';
  assert.equal((await load()).language, 'German', 'a caller changing its copy changes nobody else\'s');

  fs.writeFileSync(path.join(dir, 'prompts', 'dev.md'), 'Be very brief.\n');
  assert.match((await load()).agents.developer!.instructions, /Be very brief\.$/, 'an instruction file changed');
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'agents:\n  developer: { instructions: { mode: append, file: ./prompts/dev.md } }\nlanguage: Ukrainian\n');
  assert.equal((await load()).language, 'Ukrainian', 'the config file changed');
  fs.mkdirSync(path.join(home, '.claudestrator'));
  fs.writeFileSync(path.join(home, '.claudestrator', 'config.yaml'), 'limits: { reviewRounds: 5 }\n');
  assert.equal((await load()).limits.reviewRounds, 5, 'a user config that did not exist before');

  if (fs.existsSync('/dev/zero')) {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'context: [/dev/zero]\n');
    const r = await config.loadConfig({ workspace: ws, home });
    assert.ok(r.ok && r.warnings.some((w) => w.code === 'context_missing' && w.source === '/dev/zero'), 'a context file that cannot be read is a warning, not a hang');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'agents:\n  developer: { instructions: { file: /dev/zero } }\n');
    const bad = await config.loadConfig({ workspace: ws, home });
    assert.ok(!bad.ok && bad.errors.some((e) => /system file|not a regular file/.test(e.message)), 'instructions from a device are an error, not a hang');
  }
});

test("env: Claude Code's big JSON files are parsed once per change, and looked at no more than every few seconds", async () => {
  const file = path.join(tmp('cs-json-'), '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } }));
  const t = 1_000_000;
  assert.deepEqual(await readJsonFresh(file, t), { oauthAccount: { emailAddress: 'a@x' } });
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'b@x' }, pad: 'x'.repeat(10) }));
  assert.deepEqual(await readJsonFresh(file, t + 1000), { oauthAccount: { emailAddress: 'a@x' } }, 'within the window the file is not even looked at');
  assert.deepEqual(await readJsonFresh(file, t + 6000), { oauthAccount: { emailAddress: 'b@x' }, pad: 'x'.repeat(10) }, 'after it, a change is read');
  fs.writeFileSync(file, '{"half');
  assert.equal(await readJsonFresh(file, t + 12000), undefined, 'a file caught mid-write is no value, not an error');
  assert.equal(await readJsonFresh(path.join(path.dirname(file), 'none.json'), t), undefined);
});

test('store: an append keeps the cached state and events current, and a write by another process is still seen', async () => {
  const ws = tmp('cs-store-');
  const { pipeline, config: cfg } = defaultPipeline();
  const svc = new TaskService({ workspace: ws });
  const { taskId } = await svc.start({ input: 'x', source: { kind: 'text', text: 'x' }, auto: false, pipeline, config: cfg });
  const file = path.join(ws, '.orch', 'tasks', taskId, 'events.ndjson');
  const before = await svc.state(taskId);
  await svc.record(taskId, { type: 'note', message: 'one' });
  const after = await svc.state(taskId);
  assert.notEqual(after, before, 'a new log is a new state object: what the dashboard derives from it is cached by it');
  assert.deepEqual(after, before);
  assert.deepEqual((await svc.events(taskId)).map((e) => e.seq), [1, 2]);
  const r = await svc.dispatch(taskId, { type: 'intake_completed', spec: { id: taskId, source: { kind: 'text', text: 'x' }, title: 'x', description: '', acceptanceCriteria: [], links: [] } });
  assert.ok(r.ok);
  assert.equal(await svc.state(taskId), r.state, 'the state the transition made, without a replay');
  // The claudestrator CLI appends to the same log: the signature changes, and it is read again.
  fs.appendFileSync(file, `${JSON.stringify({ seq: 4, type: 'note', message: 'from the CLI', at: new Date().toISOString() })}\n`);
  assert.equal((await svc.events(taskId)).at(-1)!.type, 'note');
  assert.equal((await svc.record(taskId, { type: 'note', message: 'two' })).seq, 5, 'numbered after it');
  // A torn line left by a crash is cut and the next event numbered from what is whole.
  fs.appendFileSync(file, '{"seq":6,"type":"no');
  assert.equal((await svc.record(taskId, { type: 'note', message: 'three' })).seq, 6);
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq), [1, 2, 3, 4, 5, 6]);
});

test('config: a repo with nothing but its name stays configured when the config is edited', async () => {
  const ws = tmp('cs-repo-');
  await config.createProjectConfig(ws, { repos: { api: {}, web: { gates: [{ name: 'lint', cmd: 'npm run lint' }] } } });
  await config.setProjectValue(ws, ['language'], 'German');
  await config.setRepo(ws, 'web', {});
  await config.updateAgentConfig(ws, 'planner', { effort: 'max' });
  const r = passed(await config.loadConfig({ workspace: ws, home: tmp('cs-home-') }));
  assert.deepEqual(Object.keys(r.config.repos).sort(), ['api', 'web']);
  assert.deepEqual(r.config.repos.web!.gates, [], 'its gates removed, the repo kept');
  assert.equal(r.config.language, 'German');
});

test("config: a library agent nothing runs does not break the config with a missing file; an instructions file is made only in .claudestrator", async () => {
  const home = tmp('cs-home-');
  const ws = tmp('cs-ws-');
  const lib = tmp('cs-lib-');
  fs.writeFileSync(path.join(lib, 'library.yaml'), 'agents:\n  perf: { extends: reviewer, instructions: { mode: append, file: ./prompts/perf.md } }\n');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), `libraries: [${lib}]\n`);
  const r = await config.loadConfig({ workspace: ws, home });
  assert.ok(r.ok, 'the rest of the config works');
  assert.ok(r.warnings.some((w) => w.code === 'instructions_unreadable' && w.agent === 'perf'), 'and the missing file is said');
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), `libraries: [${lib}]\npipeline: [planner, developer, perf]\n`);
  const used = await config.loadConfig({ workspace: ws, home });
  assert.ok(!used.ok && used.errors.some((e) => e.agent === 'perf'), 'an agent the pipeline runs needs its instructions');

  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'agents:\n  developer: { instructions: { file: ../../outside-prompt.md } }\n');
  await assert.rejects(() => config.ensureInstructionsFile(ws, 'developer', { instructions: 'x' }), /outside \.claudestrator\/; create it yourself/);
  assert.ok(!fs.existsSync(path.resolve(ws, '.claudestrator', '../../outside-prompt.md')), 'nothing was created out there');
});

test('git: output too large to read whole says it was cut, so a diff is never taken for whole', async () => {
  const r = await exec(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000))"], { maxBytes: 1000 });
  assert.equal(r.code, 125);
  assert.match(r.stderr, /passed 1000 bytes and was cut there/);
  assert.ok(r.stdout.length <= 1000);
});

test('config: a base branch is a branch name, never something git would read as an option', async () => {
  for (const base of ['main', 'release/2.x', 'develop_v2']) assert.deepEqual(validateConfigLayer({ baseBranch: base, repos: { api: { baseBranch: base } } }), [], base);
  for (const base of ['--upload-pack=touch /tmp/x', '-main', 'a..b', 'feat//x', '']) {
    assert.ok(validateConfigLayer({ baseBranch: base }).length > 0, `baseBranch ${base}`);
    assert.ok(validateConfigLayer({ repos: { api: { baseBranch: base } } }).length > 0, `repos.api.baseBranch ${base}`);
  }
});

test('config: a task has a budget unless you say it has none', () => {
  assert.equal(passed(resolve([config.builtinLayer()])).config.limits.budgetUsd, 25, 'built in');
  assert.equal(passed(resolve([config.builtinLayer(), layer({ limits: { budgetUsd: 60 } })])).config.limits.budgetUsd, 60);
  assert.equal(passed(resolve([config.builtinLayer(), layer({ limits: { budgetUsd: 0 } })])).config.limits.budgetUsd, undefined, '0: no limit');
  assert.ok(validateConfigLayer({ limits: { budgetUsd: -1 } }).length > 0);
});

test('config: a repo name is a folder name of its own, never a path out of the worktrees folder', () => {
  for (const name of ['api', 'web-app', 'svc_2', 'api.v2']) assert.deepEqual(validateConfigLayer({ repos: { [name]: {} } }), [], name);
  for (const name of ['..', '../../..', 'a/b', 'a\\b', '.hidden', '-rf', 'x..y', '/abs', 'two words']) {
    assert.ok(validateConfigLayer({ repos: { [name]: { path: 'api' } } }).length > 0, name);
  }
});

test('config: the safety policy\'s lists are a few entries, as sandbox-runtime gets them', () => {
  assert.deepEqual(validateConfigLayer({ policy: { network: Array.from({ length: 100 }, (_, i) => `h${i}.acme.corp`) } }), []);
  assert.match(validateConfigLayer({ policy: { network: Array.from({ length: 101 }, (_, i) => `h${i}.acme.corp`) } })[0]!, /policy\.network: at most 100 items, got 101/);
  assert.match(validateConfigLayer({ policy: { writable: Array.from({ length: 5000 }, () => '~/.cache') } })[0]!, /at most 100 items/, 'one issue, not one per entry');
  assert.equal(validateConfigLayer({ policy: { writable: Array.from({ length: 5000 }, () => 'bad') } }).length, 1);
});

test('view: a task without its ticket yet is titled by what was typed, without the flags', async () => {
  const ws = tmp('cs-title-');
  const { pipeline, config: cfg } = defaultPipeline();
  const svc = new TaskService({ workspace: ws });
  const { taskId } = await svc.start({ input: 'Add the feature everywhere --auto --scenario deliver', source: { kind: 'text', text: 'Add the feature everywhere' }, auto: true, pipeline, config: cfg });
  const engine = { isRunning: () => false, lastError: () => null, pendingPermissions: () => [], live: () => null, liveCost: new Map(), svc } as unknown as ViewEngine;
  assert.equal((await summary(engine, { taskId, state: await svc.state(taskId) })).title, 'Add the feature everywhere');
});

test('config: an edit writes the whole file or nothing, keeps a linked config a link, and never writes over another window', async () => {
  const dir = fs.realpathSync(tmp('cs-write-'));
  const dotfiles = path.join(dir, 'dotfiles', 'claudestrator.yaml');
  fs.mkdirSync(path.dirname(dotfiles));
  fs.writeFileSync(dotfiles, 'language: German # mine\n');
  const file = path.join(dir, 'config.yaml');
  fs.symlinkSync(dotfiles, file);
  await config.editYamlFile(file, (doc) => doc.setIn(['baseBranch'], 'develop'), { validate: validateConfigLayer, what: 'the config' });
  assert.ok(fs.lstatSync(file).isSymbolicLink(), 'still a link to your dotfiles');
  assert.equal(fs.readFileSync(dotfiles, 'utf8'), 'language: German # mine\nbaseBranch: develop\n');
  assert.deepEqual(fs.readdirSync(path.dirname(dotfiles)), ['claudestrator.yaml'], 'no temporary file left');

  // Another window (or the CLI) writes the file while this edit is under way.
  await assert.rejects(
    () => config.editYamlFile(file, (doc) => (fs.writeFileSync(dotfiles, 'language: Ukrainian\n'), doc.setIn(['baseBranch'], 'main')), { validate: validateConfigLayer, what: 'the config' }),
    /changed while it was being edited/
  );
  assert.equal(fs.readFileSync(dotfiles, 'utf8'), 'language: Ukrainian\n', "the other window's edit stays");
});
