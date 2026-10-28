import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import os from 'os';
import * as path from 'path';

import { transition, replay, nextAction, passSteps, stepRepos, editableFrom } from '../src/core/machine';
import { buildPipeline, outline, taskPipeline } from '../src/core/pipeline';
import * as config from '../src/core/config';
import { parseStageReport } from '../src/core/prompt';
import { guardBash } from '../src/core/guard';
import { plain } from '../src/core/gates';
import { parseInvocation, classifyInput, extractAcceptanceCriteria, adfToText, detectScenario } from '../src/core/intake';
import { TaskService } from '../src/core/store';
import { stepsOf } from '../src/core/view';
import { buildArgs, limitsOf } from '../src/core/runner';
import { Engine } from '../src/core/engine';
import { resolveDefaults, effectiveFor, modelName } from '../src/core/defaults';
import * as mcp from '../src/core/mcp';
import { reposFromFolders } from '../src/core/setup';
import { execFileSync } from 'child_process';
import { parseReadiness, parseAudit } from '../src/core/protocol';
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
function previewOf(engine: Engine, args: ComposerArgs) {
  const p = engine.preview(args);
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

test('pipeline: the built-in agents make a full pipeline with a review loop', () => {
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

test('machine: plan → approval → per-repo work → review fix round → commit → push', () => {
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

test('machine: review limit, stop keeps the question, resume asks again', () => {
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

test('machine: a failed agent opens agent-failure and retry runs the same step', () => {
  const { pipeline } = defaultPipeline();
  let s = rpl(timed([createdEvent(pipeline), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_failed', agent: 'planner', error: 'boom' }]));
  assert.equal(s.checkpoint!.id, 'agent-failure');
  assert.equal(s.checkpoint!.reason, 'boom');
  s = passed(tr(s, { type: 'checkpoint_answered', id: 'agent-failure', option: 'retry', feedback: 'try harder', at: at(9) })).state;
  const next = runOf(nx(s));
  assert.equal(next.mode, 'retry');
  assert.equal(next.feedback, 'try harder');
});

test('config: project layer overrides, extends, flags and comment-preserving edits', () => {
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
  const r = passed(loadCfg({ workspace: ws, home }));
  assert.equal(r.config.language, 'Ukrainian');
  assert.equal(r.config.agents.tester!.enabled, false);
  assert.equal(r.config.agents.security!.output, 'verdict');
  assert.deepEqual(r.config.agents.security!.lineage, ['reviewer', 'security']);
  assert.match(r.config.agents.security!.instructions, /fresh eyes[\s\S]*security holes/);
  assert.equal(r.config.repos.api!.baseBranch, 'main');
  assert.equal(bp(r.config).reviewLoop!.reviewers.join(','), 'reviewer,security');

  const flagged = loadCfg({ workspace: ws, home, flags: { no: ['nope'] } });
  assert.equal(flagged.ok, false);

  config.updateAgentConfig(ws, 'planner', { model: 'sonnet' });
  config.setProjectValue(ws, ['limits', 'reviewRounds'], 3);
  config.setPipeline(ws, ['planner', 'developer', 'reviewer']);
  const text = fs.readFileSync(config.projectConfigFile(ws), 'utf8');
  assert.match(text, /# team config/);
  assert.match(text, /pipeline: \[ planner, developer, reviewer \]/);
  const again = passed(loadCfg({ workspace: ws, home }));
  assert.equal(again.config.agents.planner!.model, 'sonnet');
  assert.equal(again.config.limits.reviewRounds, 3);
  assert.throws(() => config.setProjectValue(ws, ['limits', 'reviewRounds'], 99), /invalid/);
  config.setProjectValue(ws, ['limits', 'reviewRounds'], undefined);
  assert.doesNotMatch(fs.readFileSync(config.projectConfigFile(ws), 'utf8'), /limits/);

  const file = config.ensureInstructionsFile(ws, 'developer', again.config.agents.developer);
  assert.equal(file, path.join(ws, '.claudestrator', 'prompts', 'developer.md'));
  assert.match(fs.readFileSync(file, 'utf8'), /You implement one repository/);
  assert.deepEqual(config.readProjectLayer(ws).agents!.developer!.instructions, { mode: 'replace', file: './prompts/developer.md' });

  fs.writeFileSync(config.projectConfigFile(ws), 'agents:\n  planner: { modle: opus }\n');
  const bad = failed(loadCfg({ workspace: ws, home }));
  assert.match(bad.errors[0]!.message, /agents\.planner\.modle: unknown field/);
});

test('reports: plan and verdict blocks are validated, nulls tolerated', () => {
  const plan = passed(report('plan', 'Plan...\n```json\n{"type":"feat","slug":"a-b","title":null,"repos":[{"name":"api"}],"openQuestions":[]}\n```'));
  assert.deepEqual(plan.plan!.repos, [{ name: 'api', mode: 'full' }]);
  assert.match(failed(report('plan', 'no block')).error, /no ```json block/);
  assert.match(failed(report('plan', '```json\n{"type":"feat","slug":"Bad Slug","repos":[]}\n```')).error, /slug must be kebab-case[\s\S]*repos: needs at least 1/);
  const v = failed(report('verdict', '```json\n{"status":"approved","summary":"s","findings":[{"severity":"major","problem":"p","line":null}]}\n```'));
  assert.match(v.error, /changes_requested exactly when/);
  assert.ok(report('code', 'anything').ok);
});

test('guard: agents never touch git history, destructive commands are refused', () => {
  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: true, allowNoVerify: false };
  const ctx = (extra: Partial<GuardContext> = {}): GuardContext => ({ policy, cwd: '/ws/api', workspace: '/ws', home: '/home/u', agent: true, task: { taskId: 'T', canPush: false }, branchOf: () => 'feat/x', isRepoRoot: (d) => d === '/ws/api', readFile: () => null, ...extra });
  const refusal = (command: string, c: GuardContext) => denied(guard(command, c)).reason;
  assert.equal(guard('npm test && git status', ctx()).allow, true);
  assert.match(refusal('git commit -m "x"', ctx()), /agents do not run git commit/);
  assert.match(refusal('echo hi; bash -c "git push origin feat/x"', ctx()), /git push/);
  assert.equal(guard('echo "git push --force"', ctx()).allow, true, 'quoted text is not a command');
  assert.match(refusal('rm -rf ../api', ctx()), /repository/);
  assert.match(refusal('rm -rf ~', ctx()), /not allowed/);
  assert.equal(guard('rm -rf node_modules', ctx()).allow, true);
  assert.match(refusal('gh pr create --title x', ctx()), /only read with gh/);
  const orchestrator = ctx({ agent: false, task: { taskId: 'T', canPush: true } });
  assert.match(refusal('git push --force', orchestrator), /force-push/);
  assert.match(refusal('gh pr create --title x --body y', orchestrator), /drafts only/);
  assert.match(refusal('git commit -m "x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"', ctx({ agent: false, branchOf: () => 'feat/x' })), /AI attribution/);
  assert.match(refusal('git commit --no-verify -m x', ctx({ agent: false })), /hooks/);
});

test('intake: invocations, sources and acceptance criteria', () => {
  assert.deepEqual(parseInvocation('PROJ-123 --no tester --auto'), { input: 'PROJ-123', flags: { no: ['tester'] }, auto: true });
  assert.deepEqual(parseInvocation("Don't break the dice game"), { input: "Don't break the dice game", flags: {}, auto: false });
  assert.deepEqual(classify('PROJ-12'), { kind: 'jira', key: 'PROJ-12' });
  assert.deepEqual(classify('https://acme.atlassian.net/browse/PROJ-7'), { kind: 'jira', key: 'PROJ-7', site: 'acme.atlassian.net' });
  assert.equal((classify('https://acme.atlassian.net/wiki/spaces/X/pages/12345/Title') as Extract<Source, { kind: 'confluence' }>).pageId, '12345');
  assert.equal(classify('Add a cap https://x.y/z').kind, 'text');
  assert.deepEqual(extractAcceptanceCriteria('Intro\n\n## Acceptance criteria\n- one\n- two\n  continued\n\n## Notes\n- not this'), ['one', 'two continued']);
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'AC' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }] }), '## AC\n\n- a');
});

test('store: tasks persist, rejections are logged, torn tails are ignored', () => {
  const ws = tmp('cs-store-');
  const { pipeline, config: cfg } = defaultPipeline();
  const svc = new TaskService({ workspace: ws });
  const started = svc.start({ input: 'x', source: { kind: 'text', text: 'x' }, auto: false, pipeline, config: cfg });
  assert.ok(started.created);
  assert.ok(fs.existsSync(path.join(ws, '.orch', '.gitignore')));
  const second = svc.start({ input: 'y', source: { kind: 'text', text: 'y' }, auto: false, pipeline, config: cfg });
  assert.notEqual(second.taskId, started.taskId);
  failed(svc.dispatch(started.taskId, { type: 'stage_started', agent: 'planner' }));
  assert.equal(svc.events(started.taskId).at(-1)!.type, 'transition_rejected');
  fs.appendFileSync(path.join(svc.dir(started.taskId), 'events.ndjson'), '{"seq": 3, "type": "no');
  assert.equal(svc.state(started.taskId).phase, 'intake');
  assert.ok(svc.dispatch(started.taskId, { type: 'intake_completed', spec }).ok);
  assert.equal(svc.list().length, 2);
});

test('view: the step timeline continues after the step a checkpoint stopped at', () => {
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

test('gates: output for agents has no colour codes and no redrawn progress lines', () => {
  assert.equal(plain('\u001b[31mFAIL\u001b[0m src/a.ts\n[1/3] building\r[2/3] building\r[3/3] done  \nok\n'), 'FAIL src/a.ts\n[3/3] done\nok\n');
});

test('config: effort is validated and inherited along extends', () => {
  const ws = tmp('cs-effort-');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(config.projectConfigFile(ws), 'agents:\n  reviewer: { effort: high }\n  security: { extends: reviewer, description: Security }\n');
  const r = passed(loadCfg({ workspace: ws, home: tmp('cs-h-') }));
  assert.equal(r.config.agents.security!.effort, 'high');
  assert.equal(r.config.agents.planner!.effort, 'high', 'the built-in effort of the planner');
  assert.equal(r.config.agents.verifier!.effort, undefined);
  assert.deepEqual(['planner', 'developer', 'tester', 'reviewer'].map((n) => r.config.agents[n]!.mcp), [undefined, false, false, false], 'only agents that work on the repo run without MCP');
  assert.equal(r.config.agents.security!.mcp, false, 'an agent that extends the reviewer inherits it');
  config.updateAgentConfig(ws, 'developer', { mcp: true });
  assert.equal(passed(loadCfg({ workspace: ws })).config.agents.developer!.mcp, true, 'a project can give an agent its MCP servers back');
  assert.throws(() => config.updateAgentConfig(ws, 'developer', { mcp: 'no' }), /mcp/);
  config.updateAgentConfig(ws, 'planner', { effort: 'xhigh' });
  assert.equal(passed(loadCfg({ workspace: ws })).config.agents.planner!.effort, 'xhigh');
  config.updateAgentConfig(ws, 'planner', { effort: null });
  assert.equal(passed(loadCfg({ workspace: ws })).config.agents.planner!.effort, 'high', 'clearing the setting falls back to the built-in effort');
  assert.throws(() => config.updateAgentConfig(ws, 'planner', { effort: 'huge' }), /effort: expected one of low, medium, high, xhigh, max/);
  const args = buildArgs({ agent: { model: 'opus', effort: 'low', instructions: 'x' } as Agent }, { flags: () => new Set(['--effort']), settingSources: () => null, hookSettings: () => '/h.json' } as RunnerOptions);
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.ok(!buildArgs({ agent: { effort: 'low' } as Agent }, { flags: () => new Set(), settingSources: () => null, hookSettings: () => '/h' } as RunnerOptions).includes('--effort'), 'old CLIs without --effort still run');
  assert.deepEqual(limitsOf({ rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 9 }), { fiveHour: undefined, sevenDay: { pct: 50, resetsAt: 9, status: undefined } });
});

test('task effort: --effort in the text, per-agent choices, and the override reaching the agent', () => {
  assert.deepEqual(parseInvocation('Fix it --effort high').effort, { '*': 'high' });
  assert.deepEqual(parseInvocation('Fix it --effort developer=max,tester=low').effort, { developer: 'max', tester: 'low' });
  const ws = tmp('cs-teff-');
  const engine = new Engine({ workspace: ws, home: tmp('cs-h-'), runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'] });
  const r = engine.start({ text: 'Do it --effort medium --no tester', effort: { developer: 'max' } });
  const s = engine.svc.state(r.taskId);
  assert.deepEqual(s.effort, { planner: 'medium', developer: 'max', reviewer: 'medium' }, 'all enabled agents, a named one wins, skipped ones get nothing');
  assert.equal((engine.svc.events(r.taskId)[0] as EventOf<'task_created'>).effort!.developer, 'max', 'frozen in the task log');
  assert.throws(() => engine.start({ text: 'x --effort huge' }), /not one of low/);
  assert.throws(() => engine.start({ text: 'x', effort: { nobody: 'high' } }), /unknown agent "nobody"/);
  assert.match(previewOf(engine, { text: 'x --effort huge' }).problem!, /not one of/);
  assert.deepEqual(previewOf(engine, { text: 'x', effort: { '*': 'low' } }).effort, { planner: 'low', developer: 'low', tester: 'low', reviewer: 'low' });
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
  const configured = mcp.configuredMcpServers(ws, cfg);
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
    assert.deepEqual(mcp.configuredMcpServers(ws, undefined).map((s) => s.name).filter((n) => n !== 'sentry'), ['real'], 'the default account reads ~/.claude.json, not ~/.claude/.claude.json');
  } finally {
    os.homedir = realHome;
  }

  const masked = mcp.redactMcpDetails('  Authorization: Bearer abc.def\n  API_TOKEN=supersecret\n  URL: https://x');
  assert.ok(!/abc\.def|supersecret/.test(masked) && /URL: https:\/\/x/.test(masked));
  assert.equal(mcp.isMcpName('Atlassian'), true);
  assert.equal(mcp.isMcpName('x; rm -rf /'), false);

  const fake = path.join(__dirname, 'fixtures', 'fake-claude.js');
  const state = tmp('cs-mcp-state-');
  const env = { ...process.env, FAKE_STATE: state };
  let r = await mcp.checkMcpServers({ command: fake, workspace: ws, configDir: cfg, env });
  assert.equal(r.servers.find((s) => s.name === 'Atlassian')!.state, 'needs_auth');
  const lines: string[] = [];
  const code = await mcp.mcpLogin({ command: fake, workspace: ws, env, name: 'Atlassian', onLine: (l) => lines.push(l) }).done;
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /https:\/\/auth\.example\.com/);
  r = await mcp.checkMcpServers({ command: fake, workspace: ws, configDir: cfg, env });
  assert.equal(r.servers.find((s) => s.name === 'Atlassian')!.state, 'connected', 'connected after signing in');
});

test('repos outside the workspace: picked folders, paths and the guard', () => {
  const ws = tmp('cs-ws-');
  const outer = tmp('cs-outer-');
  for (const d of [path.join(ws, 'inner'), path.join(outer, 'billing'), path.join(outer, 'group', 'auth')]) {
    fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: d });
  }
  fs.writeFileSync(path.join(outer, 'billing', 'go.mod'), 'module billing\n');
  fs.mkdirSync(path.join(outer, 'plain'));
  const r = reposFromFolders(ws, [path.join(ws, 'inner'), outer, path.join(outer, 'plain')], { names: ['inner'], dirs: [] });
  assert.deepEqual(r.repos.map((x) => [x.name, x.outside, path.isAbsolute(x.path)]), [['inner-2', false, false], ['billing', true, true], ['auth', true, true]]);
  assert.equal(r.repos[0]!.path, 'inner');
  assert.deepEqual(r.repos[1]!.gates.map((g) => g.name), ['vet', 'test']);
  assert.deepEqual(r.notRepos, [path.join(outer, 'plain')]);
  assert.equal(reposFromFolders(ws, [outer], { names: [], dirs: [path.join(outer, 'billing'), path.join(outer, 'group', 'auth')] }).repos.length, 0, 'already configured repos are skipped');

  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: false, allowNoVerify: false };
  const ctx = { policy, cwd: path.join(outer, 'billing'), workspace: ws, repoDirs: [path.join(outer, 'billing')], agent: true, branchOf: () => 'feat/x', isRepoRoot: (d: string) => d === path.join(outer, 'billing'), readFile: () => null };
  assert.equal(guard('rm -rf dist', ctx).allow, true, 'cleaning inside an outside repo is fine');
  assert.match(denied(guard(`rm -rf ${path.join(outer, 'billing')}`, ctx)).reason, /contains the workspace, a repository/);
  assert.match(denied(guard('rm -rf .git', ctx)).reason, /git metadata/);
  assert.match(denied(guard('rm -rf /opt/elsewhere/plain', ctx)).reason, /outside the workspace and its repos/);
});

test('scenarios: built-in readiness and audit agents, validated config, read-only pipelines', () => {
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

test('scenarios: readiness verdicts come from the criteria, audit findings are sorted, reports render', () => {
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

test('scenarios: the state machine finishes a report scenario without git; intake reads issues named in a sentence', () => {
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
  assert.deepEqual(svc.idFor({ source: jira, scenario: 'readiness' }), { taskId: 'PROJ-9-check', exists: false });
  svc.start({ input: 'PROJ-9', source: jira, scenario: 'readiness', auto: false, pipeline: bp(c, { scenario: 'readiness' }), config: c });
  assert.deepEqual(svc.idFor({ source: jira, scenario: 'readiness' }), { taskId: 'PROJ-9-check', exists: true }, 'an unfinished check continues');
  assert.deepEqual(svc.idFor({ source: jira }), { taskId: 'PROJ-9', exists: false }, 'the delivery task has its own id');
  assert.equal(svc.state('PROJ-9-check').scenario, 'readiness');
});

test('machine: the pipeline of a task changes only after the steps that ran, run now or wait for you', () => {
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

test('pipeline: runs switches a code or tests agent between once per repo and once across all repos', () => {
  const ws = tmp('cs-runs-');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  const load = (yaml: string) => {
    fs.writeFileSync(config.projectConfigFile(ws), yaml);
    return passed(loadCfg({ workspace: ws, home: tmp('cs-h-') }));
  };
  const steps = (pipeline: StoredPipeline, repos: PlanRepo[]): TaskState => {
    let s: TaskState | null = null;
    const events: EventBody[] = [createdEvent(pipeline), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_completed', agent: 'planner', artifact: 'p', plan: { ...PLAN, repos } }, { type: 'checkpoint_answered', id: 'approve-plan', option: 'approve' }];
    for (const e of events) s = passed(tr(s, { ...e, at: at(1) } as OrchEvent)).state;
    return s!;
  };
  const two = PLAN.repos;

  // The tester back to per repo: developer and tester alternate repo by repo, as before.
  let r = load('agents:\n  tester: { runs: per-repo }\n');
  assert.equal(r.config.agents.tester!.runs, 'per-repo');
  let s = steps(bp(r.config), two);
  assert.deepEqual(passSteps(s).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'developer@api', 'tester@api', 'developer@web', 'tester@web', 'reviewer@']);

  // The developer across all repos at once; it skips a repo the plan wants tests only for.
  r = load('agents:\n  developer: { runs: all-repos }\n  hotfix: { extends: developer, description: Hotfix }\npipeline: [planner, hotfix, tester, reviewer]\n');
  assert.equal(r.config.agents.hotfix!.runs, 'all-repos', 'runs is inherited along extends');
  s = steps(bp(r.config), [{ name: 'api', mode: 'full' }, { name: 'web', mode: 'tests_only' }]);
  assert.deepEqual(passSteps(s).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'hotfix@', 'tester@', 'reviewer@']);
  assert.deepEqual(stepRepos(s, s.next!), ['api']);
  assert.deepEqual(stepRepos(s, passSteps(s)[2]!), ['api', 'web']);

  // On a plan or review agent it means nothing, and says so.
  r = load('agents:\n  reviewer: { runs: per-repo }\n');
  assert.ok(r.warnings.some((w) => w.code === 'runs_ignored'));
  assert.equal(bp(r.config).stages.find((st) => st.agent === 'reviewer')!.scope, 'task');
  assert.throws(() => config.updateAgentConfig(ws, 'tester', { runs: 'sometimes' }), /runs: expected one of per-repo, all-repos/);
});

test('scenarios: custom scenarios with their own agents, models and effort; built-in ones can be removed', () => {
  const hotfix: NonNullable<ConfigLayer['scenarios']>[string] = { label: 'Hotfix', description: 'Code and a quick review', agents: ['developer', { agent: 'reviewer', model: 'sonnet', effort: 'low' }] };
  const r = passed(resolve([config.builtinLayer(), layer({ scenarios: { hotfix, 'deep-audit': { agents: [{ agent: 'auditor', effort: 'max' }] }, readiness: false } })]));
  assert.deepEqual(r.config.custom.hotfix, { id: 'hotfix', label: 'Hotfix', description: 'Code and a quick review', kind: 'deliver', agents: [{ name: 'developer' }, { name: 'reviewer', model: 'sonnet', effort: 'low' }] });
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
  config.setCustomScenario(ws, 'hotfix', { label: 'Hotfix', agents: [{ name: 'developer' }, { name: 'reviewer', model: 'sonnet', effort: 'low' }] });
  config.removeScenario(ws, 'audit');
  const yaml = fs.readFileSync(config.projectConfigFile(ws), 'utf8');
  assert.match(yaml, /hotfix:\n\s+label: Hotfix\n\s+agents:\n\s+- developer\n\s+- agent: reviewer\n\s+model: sonnet\n\s+effort: low/);
  assert.match(yaml, /audit: false/);
  const engine = new Engine({ workspace: ws, home: tmp('cs-h-'), runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'] });
  const prev = previewOf(engine, { text: 'Fix the login', scenario: 'hotfix' });
  assert.equal(prev.scenarioName, 'hotfix');
  assert.deepEqual(prev.effort, { reviewer: 'low' });
  assert.equal(previewOf(engine, { text: 'Зроби аудит проекту' }).scenarioName, 'deliver', 'words cannot pick a removed scenario');
  assert.throws(() => engine.start({ text: 'x', scenario: 'audit' }), /no scenario "audit"/);
  const { taskId } = engine.start({ text: 'Fix the login', scenario: 'hotfix', effort: { developer: 'high' } });
  const s = engine.svc.state(taskId);
  assert.equal(s.scenario, 'deliver');
  assert.equal(s.scenarioLabel, 'Hotfix');
  assert.deepEqual(s.model, { reviewer: 'sonnet' });
  assert.deepEqual(s.effort, { reviewer: 'low', developer: 'high' }, 'the composer adds to the scenario effort');

  config.setCustomScenario(ws, 'quick-fix', { label: 'Quick fix', agents: [{ name: 'developer' }] }, 'hotfix');
  config.restoreScenario(ws, 'audit');
  const after = passed(loadCfg({ workspace: ws, home: tmp('cs-h-') }));
  assert.deepEqual(Object.keys(after.config.custom), ['quick-fix'], 'renamed');
  assert.deepEqual(after.config.removedScenarios, []);
  config.removeScenario(ws, 'quick-fix');
  assert.deepEqual(Object.keys(passed(loadCfg({ workspace: ws, home: tmp('cs-h-') })).config.custom), []);
});
