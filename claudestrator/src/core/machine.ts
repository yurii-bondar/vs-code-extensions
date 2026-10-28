// The task state machine. Pure: the same events always give the same state, and an illegal
// event (a skipped approval, an extra review round, a push before it was confirmed) is rejected.
import { CHECKPOINT_OPTIONS, JIRA_ONLY_OPTIONS, isBlocking, isInfoEvent } from './protocol';
import { onRepos } from './pipeline';
import type { Checkpoint, CheckpointId, Finding, NextMode, Output, OrchEvent, PlanRepo, Stage, Step, StepRef, TaskState, Transition } from './types';

/** The event of one type: `Ev<'stopped'>`. */
type Ev<T extends OrchEvent['type']> = Extract<OrchEvent, { type: T }>;

const ok = (state: TaskState): Transition => ({ ok: true, state });
const fail = (code: string, message: string): Transition => ({ ok: false, error: { code, message } });

const sameStep = (a: StepRef, b: StepRef): boolean => a.agent === b.agent && (a.repo ?? null) === (b.repo ?? null);
const describe = (s: StepRef): string => (s.repo ? `${s.agent} @ ${s.repo}` : s.agent);
const clone = <T>(v: T): T => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function transition(state: TaskState | null, event: OrchEvent): Transition {
  if (isInfoEvent(event)) return state ? ok(state) : fail('no_task', 'the first event must be task_created');
  if (event.type === 'task_created') {
    if (state) return fail('already_created', `task ${state.taskId} already exists`);
    return ok(created(event));
  }
  if (!state) return fail('no_task', 'the first event must be task_created');
  if (state.status === 'done') return fail('task_done', `task ${state.taskId} is finished`);

  const s = clone(state);
  s.updatedAt = event.at;

  // You may reshape what is still to come at any time, even while an agent runs or a question waits.
  if (event.type === 'pipeline_changed') return pipelineChanged(s, event);
  if (event.type === 'stopped') {
    if (s.status === 'stopped') return fail('already_stopped', 'task is already stopped');
    s.status = 'stopped';
    return ok(s);
  }
  if (event.type === 'resumed') {
    if (s.status !== 'stopped') return fail('not_stopped', 'only a stopped task can be resumed');
    s.status = s.checkpoint ? 'waiting' : 'active';
    return ok(s);
  }
  if (s.status === 'stopped') return fail('task_stopped', 'task is stopped; send resumed first');
  if (s.checkpoint && event.type !== 'checkpoint_answered') {
    return fail('awaiting_checkpoint', `waiting for checkpoint "${s.checkpoint.id}"; answer it first`);
  }

  switch (event.type) {
    case 'intake_completed':
      return intakeCompleted(s, event);
    case 'stage_started':
      return stageStarted(s, event);
    case 'stage_completed':
      return stageCompleted(s, event);
    case 'stage_failed': {
      if (!s.running || !sameStep(s.running, event)) return fail('not_running', `${describe(event)} is not running`);
      const step = s.running;
      s.running = null;
      openCheckpoint(s, 'agent-failure', event.at, step, event.error);
      return ok(s);
    }
    case 'checkpoint_answered':
      return checkpointAnswered(s, event);
    case 'committed':
      if (s.phase !== 'finish' || s.finishStep !== 'commit') return fail('not_committing', 'nothing to commit at this point');
      s.finishStep = 'confirm';
      openCheckpoint(s, 'confirm-push', event.at);
      return ok(s);
    case 'commit_failed':
      if (s.phase !== 'finish' || s.finishStep !== 'commit') return fail('not_committing', 'nothing to commit at this point');
      openCheckpoint(s, 'hook-failure', event.at, undefined, `${event.repo}: ${event.output}`);
      return ok(s);
    case 'published':
      if (s.phase !== 'finish' || s.finishStep !== 'publish') return fail('push_not_confirmed', 'push was not confirmed');
      s.prs = { ...s.prs, ...event.prs };
      finish(s, 'published');
      return ok(s);
    default: {
      // A new event type must be handled above; the compiler says so here.
      const unhandled: never = event;
      return fail('unknown_event', `unhandled event ${(unhandled as { type: string }).type}`);
    }
  }
}

/** Folds a whole event log. A log that does not replay is corrupt, so this throws. */
function replay(events: OrchEvent[]): TaskState {
  let state = null as TaskState | null;
  events.forEach((event, i) => {
    const r = transition(state, event);
    if (!r.ok) throw new Error(`event #${i + 1} (${event.type}) does not replay: ${r.error.message}`);
    state = r.state;
  });
  if (!state) throw new Error('empty event log');
  return state;
}

const canPush = (s: TaskState): boolean => s.status === 'active' && s.phase === 'finish' && s.finishStep === 'publish';

function created(e: Ev<'task_created'>): TaskState {
  return {
    taskId: e.taskId,
    input: e.input,
    source: e.source,
    /** deliver, readiness or audit; logs written before scenarios existed are deliveries. */
    scenario: e.scenario ?? 'deliver',
    /** A custom scenario the task came from; `scenario` is then what it runs as. */
    ...(e.scenarioName && { scenarioName: e.scenarioName, scenarioLabel: e.scenarioLabel }),
    auto: e.auto,
    pipeline: e.pipeline,
    knownRepos: e.knownRepos,
    contextFiles: e.contextFiles ?? [],
    gitMode: e.gitMode ?? 'branch',
    /** Effort chosen for this task only, per agent; it wins over the agents' configured effort. */
    effort: e.effort ?? {},
    /** Model per agent for this task (a custom scenario's own); it wins over the agents' configured model. */
    model: e.model ?? {},
    limits: e.limits,
    status: 'active',
    phase: 'intake',
    repos: [],
    next: null,
    nextMode: 'initial',
    feedback: null,
    running: null,
    checkpoint: null,
    review: { round: 1, maxRounds: e.limits.reviewRounds, fixing: false, fixRepos: [], emptyRounds: 0, verdicts: [], lastVerdicts: [], openFindings: [] },
    finishStep: null,
    gateFailures: [],
    artifacts: [],
    /** Readiness and audit results: `{ agent, output, artifact, value }`. */
    reports: [],
    answers: [],
    prs: {},
    createdAt: e.at,
    updatedAt: e.at,
  };
}

/**
 * Repos a plan names that this task may not touch: with repos configured, any other; without, anything that is not a
 * plain folder name of the workspace (`../other`, `/Users/me/dotfiles`), since the name becomes the path agents write in.
 */
function unknownRepos(s: TaskState, repos: PlanRepo[]): string[] {
  const names = repos.map((r) => r.name);
  if (s.knownRepos.length === 0) return names.filter((n) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) || n.includes('..'));
  return names.filter((n) => !s.knownRepos.includes(n));
}

function intakeCompleted(s: TaskState, e: Ev<'intake_completed'>): Transition {
  if (s.phase !== 'intake') return fail('intake_done', 'intake already completed');
  if (e.repos) {
    const unknown = unknownRepos(s, e.repos);
    if (unknown.length) return fail('unknown_repo', `unknown repos: ${unknown.join(', ')}`);
    s.repos = e.repos;
  }
  const stages = s.pipeline.stages;
  const firstPlan = stages.findIndex((st) => st.output === 'plan');
  const firstRepo = stages.findIndex(onRepos);
  if (firstRepo !== -1 && (firstPlan === -1 || firstRepo < firstPlan) && s.repos.length === 0) {
    return fail('repos_required', `"${stages[firstRepo]!.agent}" runs per repo before any plan names repos; pass repos with intake_completed`);
  }
  s.spec = e.spec;
  s.phase = 'stages';
  setNext(s, passSteps(s)[0] ?? null, 'initial');
  return ok(s);
}

function stageStarted(s: TaskState, e: Ev<'stage_started'>): Transition {
  if (s.phase !== 'stages') return fail('not_in_stages', `no stage can start during ${s.phase}`);
  if (s.running) return fail('already_running', `${describe(s.running)} is still running`);
  if (!s.next) return fail('nothing_next', 'no stage is due');
  if (!sameStep(s.next, e)) return fail('wrong_stage', `expected ${describe(s.next)}, got ${describe(e)}`);
  s.running = s.next;
  s.next = null;
  s.feedback = null;
  return ok(s);
}

function stageCompleted(s: TaskState, e: Ev<'stage_completed'>): Transition {
  if (!s.running || !sameStep(s.running, e)) return fail('not_running', `${describe(e)} is not running`);
  const step = s.running;
  const stage = s.pipeline.stages[step.stage]!;

  if (stage.output === 'plan') {
    if (!e.plan) return fail('plan_meta_required', `plan stage "${step.agent}" must report the plan's JSON block`);
    const unknown = unknownRepos(s, e.plan.repos);
    if (unknown.length) return fail('unknown_repo', `plan names unknown repos: ${unknown.join(', ')}`);
  }
  if (stage.output === 'verdict' && !e.verdict) return fail('verdict_required', `verdict stage "${step.agent}" must report a verdict`);
  if (stage.output === 'readiness' && !e.readiness) return fail('readiness_required', `readiness stage "${step.agent}" must report its criteria`);
  if (stage.output === 'audit' && !e.audit) return fail('audit_required', `audit stage "${step.agent}" must report its findings`);

  s.running = null;
  s.artifacts.push({ agent: step.agent, ...(step.repo && { repo: step.repo }), round: s.review.round, output: stage.output, path: e.artifact, at: e.at });

  switch (stage.output) {
    case 'plan':
      s.plan = e.plan!;
      s.repos = e.plan!.repos;
      if (stage.approval) openCheckpoint(s, 'approve-plan', e.at, step);
      else advance(s, step);
      return ok(s);
    case 'code':
    case 'tests':
      if (e.gates === 'fail') openCheckpoint(s, 'gate-failure', e.at, step);
      else advance(s, step);
      return ok(s);
    case 'verdict':
      s.review.verdicts.push({ agent: step.agent, artifact: e.artifact, status: e.verdict!.status, findings: e.verdict!.findings, ...(e.emptyDiff && { emptyDiff: true }) });
      if (s.pipeline.reviewLoop && s.pipeline.reviewLoop.end === step.stage) evaluateRound(s, e.at);
      else advance(s, step);
      return ok(s);
    case 'readiness':
    case 'audit':
      // One report per agent; a retried agent replaces its earlier one.
      s.reports = [...(s.reports || []).filter((r) => r.agent !== step.agent), { agent: step.agent, output: stage.output, artifact: e.artifact, value: e[stage.output] }];
      advance(s, step);
      return ok(s);
  }
  return fail('unknown_output', `unknown output ${stage.output as string}`);
}

function checkpointAnswered(s: TaskState, e: Ev<'checkpoint_answered'>): Transition {
  const cp = s.checkpoint;
  if (!cp) return fail('no_checkpoint', 'no checkpoint is open');
  if (cp.id !== e.id) return fail('wrong_checkpoint', `open checkpoint is "${cp.id}", not "${e.id}"`);
  if (!cp.options.includes(e.option)) return fail('invalid_option', `"${e.option}" is not an option of "${cp.id}": ${cp.options.join(', ')}`);

  s.answers.push({ id: e.id, option: e.option, ...(e.feedback && { feedback: e.feedback }), at: e.at });
  s.checkpoint = null;
  s.status = 'active';
  const feedback = e.feedback ?? null;

  if (e.option === 'stop') {
    // Keep the checkpoint so a resume asks the same question again.
    s.checkpoint = cp;
    s.status = 'stopped';
    return ok(s);
  }

  switch (cp.id) {
    case 'approve-plan':
      if (e.option === 'change') setNext(s, cp.step!, 'replan', feedback);
      else advance(s, cp.step!);
      break;
    case 'gate-failure':
      if (e.option === 'retry') setNext(s, cp.step!, 'retry', feedback);
      else {
        s.gateFailures.push(cp.step!);
        advance(s, cp.step!);
      }
      break;
    case 'agent-failure':
      setNext(s, cp.step!, 'retry', feedback);
      break;
    case 'review-limit':
      if (e.option === 'retry') {
        s.review.maxRounds += 1;
        startFixRound(s, feedback);
      } else passReview(s, true);
      break;
    case 'hook-failure':
      s.finishStep = 'commit';
      break;
    case 'confirm-push':
      if (e.option === 'local') finish(s, 'local');
      else s.finishStep = 'publish';
      break;
  }
  return ok(s);
}

/**
 * The first stage a pipeline edit may change, or -1 once the stages are through. Everything before it has run,
 * runs now or waits for you: a per-repo block counts whole (it runs repo by repo), and a fix round keeps its loop.
 */
function editableFrom(s: TaskState): number {
  if (s.status === 'done') return -1;
  if (s.phase === 'intake') return 0;
  if (s.phase !== 'stages') return -1;
  const { stages, reviewLoop } = s.pipeline;
  const current = s.running || (s.checkpoint && s.checkpoint.step) || s.next;
  let at = current ? current.stage : reviewLoop ? reviewLoop.end : stages.length - 1;
  while (stages[at]!.scope === 'repo' && at + 1 < stages.length && stages[at + 1]!.scope === 'repo') at++;
  if (s.review.fixing && reviewLoop) at = Math.max(at, reviewLoop.end);
  return at + 1;
}

function pipelineChanged(s: TaskState, e: Ev<'pipeline_changed'>): Transition {
  const from = editableFrom(s);
  if (from === -1) return fail('pipeline_locked', 'the pipeline cannot change once its stages are through');
  const before = s.pipeline.stages;
  const { stages } = e.pipeline;
  const same = (a?: Stage, b?: Stage): boolean => Boolean(a && b) && a!.agent === b!.agent && a!.output === b!.output && a!.scope === b!.scope;
  for (let i = 0; i < from; i++) {
    if (!same(before[i], stages[i])) return fail('pipeline_locked', `"${before[i]!.agent}" has run or is running; only the stages after it can change`);
  }
  const names = stages.map((st) => st.agent);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) return fail('pipeline_duplicate', `"${twice}" is in the pipeline twice`);
  s.pipeline = { mode: e.pipeline.mode, stages, reviewLoop: e.pipeline.reviewLoop };
  return ok(s);
}

function openCheckpoint(s: TaskState, id: CheckpointId, at: string, step?: Step, reason?: string): void {
  const jira = s.source.kind === 'jira';
  const options = CHECKPOINT_OPTIONS[id].filter((o) => jira || !JIRA_ONLY_OPTIONS.includes(o));
  s.checkpoint = { id, options, ...(step && { step }), ...(reason && { reason }), at };
  s.status = 'waiting';
}

/**
 * The steps of the current pass, derived from the pipeline and the plan's repos.
 * Consecutive `repo` stages form a block that runs repo by repo (developer for A, then for B); a `repos` stage
 * runs once after it, across every repo (the tester). A fix round covers only `restartAt..end` and only the
 * repos with blocking findings.
 */
function passSteps(s: TaskState): Step[] {
  const { stages, reviewLoop } = s.pipeline;
  const fixing = s.review.fixing && reviewLoop !== null;
  const from = fixing ? reviewLoop!.restartAt : 0;
  const to = fixing ? reviewLoop!.end : stages.length - 1;
  const repos = fixing ? s.repos.filter((r) => s.review.fixRepos.includes(r.name)) : s.repos;

  const steps: Step[] = [];
  let i = from;
  while (i <= to) {
    if (stages[i]!.scope !== 'repo') {
      steps.push({ stage: i, agent: stages[i]!.agent });
      i++;
      continue;
    }
    let j = i;
    while (j <= to && stages[j]!.scope === 'repo') j++;
    for (const repo of repos) {
      for (let k = i; k < j; k++) {
        if (stages[k]!.output === 'code' && repo.mode === 'tests_only') continue;
        steps.push({ stage: k, agent: stages[k]!.agent, repo: repo.name });
      }
    }
    i = j;
  }
  return steps;
}

function setNext(s: TaskState, step: Step | null, mode: NextMode, feedback: string | null = null): void {
  s.next = step;
  s.nextMode = mode;
  s.feedback = feedback;
  if (!step) enterFinish(s);
}

function advance(s: TaskState, from: Step): void {
  const pass = passSteps(s);
  const i = pass.findIndex((p) => p.stage === from.stage && sameStep(p, from));
  const next = i >= 0 ? pass[i + 1] : undefined;
  setNext(s, next ?? null, s.review.fixing ? 'fix' : 'initial');
}

/** Review rounds in a row with an empty diff after which the loop stops: another fix round would change nothing either. */
const MAX_EMPTY_ROUNDS = 2;

function evaluateRound(s: TaskState, at: string): void {
  const blocking = s.review.verdicts.some((v) => v.status === 'changes_requested');
  const empty = s.review.verdicts.length > 0 && s.review.verdicts.every((v) => v.emptyDiff);
  s.review.emptyRounds = empty ? s.review.emptyRounds + 1 : 0;
  if (!blocking) passReview(s, false);
  else if (s.review.emptyRounds >= MAX_EMPTY_ROUNDS) openCheckpoint(s, 'review-limit', at, undefined, `the diff was empty in ${s.review.emptyRounds} review rounds in a row: the agents changed nothing, so another fix round would not help`);
  else if (s.review.round < s.review.maxRounds) startFixRound(s, null);
  else openCheckpoint(s, 'review-limit', at, undefined, `round ${s.review.round} of ${s.review.maxRounds} still has blocking findings`);
}

function startFixRound(s: TaskState, feedback: string | null): void {
  const findings = s.review.verdicts.flatMap((v) => v.findings).filter(isBlocking);
  const names = s.repos.map((r) => r.name);
  const targeted = findings.map((f) => f.repo);
  // A finding without a repo, or with one outside the plan, sends every repo back.
  s.review.fixRepos = targeted.every((r) => r !== undefined && names.includes(r)) ? names.filter((n) => targeted.includes(n)) : names;
  s.review.lastVerdicts = s.review.verdicts;
  s.review.verdicts = [];
  s.review.round += 1;
  s.review.fixing = true;
  setNext(s, passSteps(s)[0] ?? null, 'fix', feedback);
}

/** Leaves the loop: minors (and, if shipped anyway, the blocking findings) go to the PR body. */
function passReview(s: TaskState, shipBlocking: boolean): void {
  const findings = s.review.verdicts.flatMap((v) => v.findings);
  s.review.openFindings.push(...(shipBlocking ? findings : findings.filter((f) => !isBlocking(f))));
  s.review.lastVerdicts = s.review.verdicts;
  s.review.verdicts = [];
  s.review.fixing = false;
  const end = s.pipeline.reviewLoop!.end;
  setNext(s, passSteps(s).find((p) => p.stage > end) ?? null, 'initial');
}

function enterFinish(s: TaskState): void {
  const worked = s.pipeline.stages.some(onRepos) && s.repos.length > 0;
  if (worked) {
    s.phase = 'finish';
    s.finishStep = 'commit';
  } else finish(s, 'completed');
}

function finish(s: TaskState, outcome: string): void {
  s.phase = 'done';
  s.status = 'done';
  s.outcome = outcome;
  s.finishStep = null;
  s.next = null;
}

// ---------- what runs next ----------

/** Paths inside the task folder. Agents pass these to each other, never the contents. */
const TASK_FILES = { events: 'events.ndjson', ticket: 'ticket.md', ticketJson: 'ticket.json', report: 'report.md' };

/** The repos a step works in: its own, or for a `repos` stage every repo of the pass (a fix round: the ones sent back). */
function stepRepos(s: TaskState, step: Step): string[] {
  if (step.repo) return [step.repo];
  // A code stage across all repos leaves out the ones the plan wants tests only for.
  const code = step.stage !== undefined && s.pipeline.stages[step.stage]!.output === 'code';
  const names = s.repos.filter((r) => !(code && r.mode === 'tests_only')).map((r) => r.name);
  return s.review.fixing ? names.filter((n) => s.review.fixRepos.includes(n)) : names;
}

function artifactPath(output: Output, agent: string, round: number, repo?: string): string {
  switch (output) {
    case 'plan':
      return `plan/${agent}.md`;
    case 'verdict':
      return `reviews/r${round}/${agent}.md`;
    case 'readiness':
    case 'audit':
      return `${output}/${agent}.md`;
    default:
      return `reports/r${round}/${agent}${repo ? `-${repo}` : ''}.md`;
  }
}

type NextAction =
  | { kind: 'done'; outcome: string | undefined }
  | { kind: 'stopped'; checkpoint: Checkpoint | null }
  | { kind: 'checkpoint'; checkpoint: Checkpoint }
  | { kind: 'intake' }
  | { kind: 'running'; step: Step }
  | { kind: 'publish'; repos: string[]; openFindings: Finding[] }
  | { kind: 'commit'; repos: string[] }
  | RunAction;

/** What the engine runs next: one agent, with its mode, inputs and where it writes. */
interface RunAction {
  kind: 'run';
  step: Step;
  output: Output;
  mode: NextMode;
  round: number;
  feedback: string | null;
  inputs: string[];
  artifact: string;
}

function nextAction(s: TaskState): NextAction {
  if (s.status === 'done') return { kind: 'done', outcome: s.outcome };
  if (s.status === 'stopped') return { kind: 'stopped', checkpoint: s.checkpoint };
  if (s.checkpoint) return { kind: 'checkpoint', checkpoint: s.checkpoint };
  if (s.phase === 'intake') return { kind: 'intake' };
  if (s.running) return { kind: 'running', step: s.running };
  const repos = s.repos.map((r) => r.name);
  if (s.phase === 'finish') {
    return s.finishStep === 'publish' ? { kind: 'publish', repos, openFindings: s.review.openFindings } : { kind: 'commit', repos };
  }
  const step = s.next!;
  const output = s.pipeline.stages[step.stage]!.output;
  return {
    kind: 'run',
    step,
    output,
    mode: s.nextMode,
    round: s.review.round,
    feedback: s.feedback,
    inputs: inputsFor(s, step, output),
    artifact: artifactPath(output, step.agent, s.review.round, step.repo),
  };
}

/** For a step that was running when the orchestrator stopped: the run description it would have had. */
function runOf(state: TaskState, step: Step): RunAction {
  const probe = nextAction({ ...state, running: null, next: step, status: 'active', checkpoint: null });
  if (probe.kind !== 'run') throw new Error('cannot rebuild the running step');
  return probe;
}

function inputsFor(s: TaskState, step: Step, output: Output): string[] {
  const latest = (pred: (a: TaskState['artifacts'][number]) => boolean): string[] => s.artifacts.filter(pred).map((a) => a.path);
  const plans = latest((a) => a.output === 'plan');
  const inputs = [...s.contextFiles, TASK_FILES.ticket];

  if (output === 'plan') {
    // A re-plan starts from its own previous plan.
    if (s.nextMode === 'replan') inputs.push(...latest((a) => a.output === 'plan' && a.agent === step.agent).slice(-1));
    else inputs.push(...plans);
    return unique(inputs);
  }
  inputs.push(...plans);

  if (output === 'code' || output === 'tests') {
    // Everything earlier stages wrote for this repo in this round, e.g. the developer reports for the tester;
    // a stage across all repos reads every repo's.
    const repos = stepRepos(s, step);
    inputs.push(...latest((a) => a.round === s.review.round && (a.output === 'code' || a.output === 'tests') && (step.repo ? a.repo === step.repo : !a.repo || repos.includes(a.repo))));
    if (s.nextMode === 'fix') inputs.push(...s.review.lastVerdicts.map((v) => v.artifact));
  }
  // Verdict stages get only the ticket and plan: fresh context is the point. The diff is added by the engine.
  return unique(inputs);
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/** `<type>/<KEY>-<slug>` for a Jira task, `<type>/<slug>` otherwise. Null until a plan exists. */
function branchName(s: TaskState): string | null {
  if (!s.plan) return null;
  const key = s.source.kind === 'jira' ? `${s.taskId}-` : '';
  return `${s.plan.type}/${key}${s.plan.slug}`;
}

export type { NextAction, RunAction };
export { MAX_EMPTY_ROUNDS, transition, replay, canPush, passSteps, editableFrom, stepRepos, nextAction, runOf, artifactPath, branchName, sameStep, TASK_FILES };
