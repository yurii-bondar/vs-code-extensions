// Turns the resolved config into stages and loop rules. Routing depends on outputs only, never on names.

import type { Agent, Config, Output, Pipeline, PipelineWarning, ReviewLoop, Runs, ScenarioStep, Scope, Stage, StoredPipeline } from './types';

const isWork = (o: Output): boolean => o === 'code' || o === 'tests';
const REPORT_OUTPUTS: Output[] = ['readiness', 'audit'];

/**
 * Where a stage runs: `repo` once per repo of the plan, `repos` once across all of them, `task` once without a repo.
 * A code or tests agent picks with `runs` (per-repo, all-repos); by default the developer works repo by repo and
 * one tester covers what it did in every repo. A task keeps the scope it started with.
 */
const SCOPE: Partial<Record<Output, Scope>> = { code: 'repo', tests: 'repos' };
const RUNS_SCOPE: Record<Runs, Scope> = { 'per-repo': 'repo', 'all-repos': 'repos' };
/** The part of an agent that decides its stage. An existing task's stage carries its `scope`. */
interface StageSource {
  name: string;
  output: Output;
  runs?: Runs | undefined;
  scope?: Scope | undefined;
}
type PlainStage = Omit<Stage, 'approval'>;
const stageOf = (a: StageSource): PlainStage => ({ agent: a.name, output: a.output, scope: a.scope || (SCOPE[a.output] && ((a.runs && RUNS_SCOPE[a.runs]) || SCOPE[a.output])) || 'task' });
/** A scenario's own Loop over stages `from..to`, with its rounds. */
interface OwnLoop {
  from: number;
  to: number;
  rounds: number | undefined;
}
/** Whether a stage works in the plan's repos (and so the task branches, commits and opens PRs). */
const onRepos = (st: { scope: Scope }): boolean => st.scope === 'repo' || st.scope === 'repos';

/** A stage works in repos before any plan stage names them: the task names its repos itself (`--repos`). */
function reposBeforePlan(stages: readonly { scope: Scope; output: Output }[]): boolean {
  const firstPlan = stages.findIndex((st) => st.output === 'plan');
  const firstRepo = stages.findIndex(onRepos);
  return firstRepo !== -1 && (firstPlan === -1 || firstRepo < firstPlan);
}

/**
 * `opts.scenario`: `deliver` (default) runs `config.pipeline`; a report scenario runs its own read-only agents; a custom
 * scenario runs its agents as a delivery or as the report they write.
 */
function buildPipeline(config: Config, opts: { scenario?: string | undefined; auto?: boolean | undefined } = {}): Pipeline {
  const scenario = opts.scenario || 'deliver';
  const custom = config.custom && config.custom[scenario];
  if (custom) return scenarioPipeline(config, custom.agents, opts);
  if (scenario !== 'deliver') return reportPipeline(config, scenario);
  const enabled = config.pipeline.map((n) => config.agents[n]).filter((a): a is Agent => Boolean(a && a.enabled));
  return routed(enabled.map(stageOf), { auto: opts.auto, maxRounds: config.limits.reviewRounds });
}

/**
 * What a custom scenario with these steps runs: the report its agents write, or a delivery routed by their outputs.
 * Turned-off agents are left out. Also what its editor shows of steps not saved yet.
 */
function scenarioPipeline(config: Pick<Config, 'agents' | 'limits'>, steps: readonly Pick<ScenarioStep, 'name' | 'parallel' | 'when' | 'loop' | 'approve'>[], opts: { auto?: boolean | undefined } = {}): Pipeline {
  const known = steps.flatMap((st) => (config.agents[st.name] ? [{ st, a: config.agents[st.name]! }] : []));
  const report = known.find(({ a }) => REPORT_OUTPUTS.includes(a.output));
  const enabled = known.filter(({ a }) => a.enabled);
  // A Parallel left with one agent (the others turned off) is that agent alone.
  const size = (g: number | undefined): number => enabled.filter(({ st }) => st.parallel === g).length;
  const plain: PlainStage[] = enabled.map(({ st, a }) => ({ ...stageOf(a), ...(st.parallel !== undefined && size(st.parallel) > 1 && { group: st.parallel }), ...(st.when && { when: st.when }), ...(st.approve && { approve: st.approve }) }));
  if (report) return reportStages(plain, report.a.output);
  const looped = enabled.map(({ st }, i) => (st.loop ? i : -1)).filter((i) => i !== -1);
  const loop = looped.length ? { from: looped[0]!, to: looped[looped.length - 1]!, rounds: enabled[looped[0]!]!.st.loop!.rounds } : undefined;
  const p = routed(plain, { auto: opts.auto, maxRounds: config.limits.reviewRounds, loop });
  // A branch on a step that does not run never holds: its other arm runs.
  for (const { st } of enabled) if (st.when && !enabled.some(({ st: x }) => x.name === st.when!.on)) p.warnings.push({ level: 'warning', code: 'branch_source_off', agent: st.name, message: `"${st.name}" waits on "${st.when.on}", which does not run (turned off): its branch's other arm runs` });
  return p;
}

/** What a scenario runs as: `deliver`, `readiness` or `audit`. A custom scenario without agents counts as a delivery. */
function scenarioKind(config: Pick<Config, 'custom'>, scenario = 'deliver'): string {
  const custom = config.custom && config.custom[scenario];
  return custom ? custom.kind || 'deliver' : scenario;
}

/**
 * The pipeline of a running task after you edited it: `agents` are `{ name, output }` in the new order.
 * Delivery stages are routed again (approval, review loop, warnings); report stages stay task-scoped and read-only.
 */
function taskPipeline(agents: StageSource[], { scenario = 'deliver', auto, maxRounds }: { scenario?: string; auto?: boolean | undefined; maxRounds: number }): Pipeline {
  if (scenario !== 'deliver') return { mode: scenario, scenario, stages: agents.map((a) => ({ ...stageOf(a), scope: 'task', approval: false })), reviewLoop: null, warnings: [] };
  return routed(agents.map(stageOf), { auto, maxRounds });
}

/** Whether a pipeline has a scenario's Parallel, Branch, Loop or You approve, which a task's list of agents cannot change. */
const fixedFlow = (p: Pick<StoredPipeline, 'stages' | 'reviewLoop'>): boolean => p.stages.some((st) => st.group !== undefined || st.when !== undefined || st.approve !== undefined) || Boolean(p.reviewLoop && p.reviewLoop.explicit);

/** Whether an agent with this output can join a task of this scenario. */
const fitsScenario = (output: Output, scenario = 'deliver'): boolean => (scenario === 'deliver' ? !REPORT_OUTPUTS.includes(output) : output === scenario);

function routed(plain: PlainStage[], { auto, maxRounds, loop }: { auto?: boolean | undefined; maxRounds: number; loop?: OwnLoop | undefined }): Pipeline {
  const warnings: PipelineWarning[] = [];
  const stages: Stage[] = plain.map((st, i) => ({
    ...st,
    approval: st.output === 'plan' && !auto && plain.slice(i + 1).some((b) => b.output !== 'plan'),
  }));

  const firstIndex = (pred: (s: Stage) => boolean): number => stages.findIndex(pred);
  const lastIndex = (pred: (s: Stage) => boolean): number => {
    for (let i = stages.length - 1; i >= 0; i--) if (pred(stages[i] as Stage)) return i;
    return -1;
  };
  const warn = (code: string, message: string, agent?: string): void => void warnings.push({ level: 'warning', code, message, ...(agent && { agent }) });

  const plans = stages.filter((s) => s.output === 'plan');
  if (plans.length > 1) warn('multiple_plans', `more than one plan stage: ${plans.map((s) => s.agent).join(', ')}; each re-plans from the previous plan`);
  const firstPlan = firstIndex((s) => s.output === 'plan');
  if (firstPlan > 0) warn('plan_not_first', `plan stage "${stages[firstPlan]!.agent}" runs after other stages`, stages[firstPlan]!.agent);

  const firstCode = firstIndex((s) => s.output === 'code');
  const firstTests = firstIndex((s) => s.output === 'tests');
  if (firstTests !== -1 && (firstCode === -1 || firstTests < firstCode)) {
    warn('tests_without_code', `"${stages[firstTests]!.agent}" tests code no stage before it wrote; it will test the existing branch`, stages[firstTests]!.agent);
  }

  const lastVerdict = lastIndex((s) => s.output === 'verdict');
  const firstVerdict = firstIndex((s) => s.output === 'verdict');
  const lastWork = lastIndex((s) => isWork(s.output));
  if (lastVerdict !== -1 && lastWork > lastVerdict) {
    warn('unreviewed_work', `"${stages[lastWork]!.agent}" runs after the last review, so its changes are never reviewed`, stages[lastWork]!.agent);
  }
  if (firstVerdict !== -1 && firstCode !== -1 && firstVerdict < firstCode) {
    warn('verdict_before_code', `"${stages[firstVerdict]!.agent}" reviews before any code is written; it reviews the existing branch`, stages[firstVerdict]!.agent);
  }
  if (reposBeforePlan(stages)) {
    warn('no_plan', 'no plan stage before the agents that change code: they work in the repos the task names (--repos api,web), else in every configured repo, on a branch named after the ticket');
  }

  let reviewLoop: ReviewLoop | null = null;
  const span = (from: number, to: number) => stages.slice(from, to + 1);
  if (loop) {
    // The scenario's own Loop: its steps, its rounds. It ends with a review (config checks that), else it is no loop.
    const body = span(loop.from, loop.to);
    if (stages[loop.to]!.output === 'verdict' && body.some((s) => isWork(s.output))) {
      reviewLoop = { restartAt: loop.from, end: loop.to, fixers: body.filter((s) => isWork(s.output)).map((s) => s.agent), reviewers: body.filter((s) => s.output === 'verdict').map((s) => s.agent), maxRounds: loop.rounds ?? maxRounds, explicit: true };
    } else warn('loop_without_work', 'the Loop has no agent that changes code before its review, so there is nothing to fix: it runs once');
  } else {
    // A step of a branch may be skipped, so it never ends the loop the outputs make, nor opens it.
    const end = lastIndex((s) => s.output === 'verdict' && !s.when);
    const restartAt = end === -1 ? -1 : firstIndex((s) => isWork(s.output) && !s.when);
    if (restartAt !== -1 && restartAt < end) {
      const body = span(restartAt, end);
      reviewLoop = { restartAt, end, fixers: body.filter((s) => isWork(s.output)).map((s) => s.agent), reviewers: body.filter((s) => s.output === 'verdict').map((s) => s.agent), maxRounds };
    }
  }

  return { mode: modeOf(stages, reviewLoop), scenario: 'deliver', stages, reviewLoop, warnings };
}

/** Readiness and audit: task-scoped stages one after another, no approval, no review loop, no git. */
function reportPipeline(config: Config, scenario: string): Pipeline {
  const names = (config.scenarios && config.scenarios[scenario]) || [];
  return reportStages(names.map((n) => config.agents[n]).filter((a): a is Agent => Boolean(a && a.enabled)), scenario);
}

function reportStages(agents: (Pick<Agent, 'name' | 'output'> | PlainStage)[], scenario: string): Pipeline {
  const stages: Stage[] = agents.map((a) => ('agent' in a ? { ...a, scope: 'task', approval: false } : { agent: a.name, output: a.output, scope: 'task', approval: false }));
  return { mode: scenario, scenario, stages, reviewLoop: null, warnings: [] };
}

function modeOf(stages: Stage[], loop: ReviewLoop | null): string {
  if (stages.length === 0) return 'intake_only';
  const outputs = new Set(stages.map((s) => s.output));
  if (outputs.size === 1 && outputs.has('plan')) return 'plan_only';
  if (outputs.size === 1 && outputs.has('verdict')) return 'review_only';
  const has = (o: Output): boolean => outputs.has(o);
  if (has('plan') && has('code') && has('tests') && has('verdict') && loop && stages[0]?.output === 'plan') return 'full';
  return 'custom';
}

/** A plain-language outline of a pipeline, as chips for the UI: `[{ text, kind }]`. */
/** A chip of the outline. `kind` says what it is; the rest depends on it. */
interface Chip {
  kind: string;
  text: string;
  agent?: string;
  output?: Output;
  allRepos?: boolean;
  agents?: { agent: string; output: Output }[];
}

function outline(pipeline: Pick<StoredPipeline, 'stages' | 'reviewLoop' | 'scenario'>): Chip[] {
  const out: Chip[] = [];
  const { stages, reviewLoop } = pipeline;
  let i = 0;
  while (i < stages.length) {
    const st = stages[i] as Stage;
    if (reviewLoop && i === reviewLoop.restartAt) out.push({ kind: 'loop-start', text: `review loop · up to ${reviewLoop.maxRounds} round${reviewLoop.maxRounds === 1 ? '' : 's'}` });
    if (st.scope === 'repo') {
      let j = i;
      const block: Stage[] = [];
      while (j < stages.length && (stages[j] as Stage).scope === 'repo') block.push(stages[j++] as Stage);
      out.push({ kind: 'repo-block', text: 'per repo', agents: block.map((b) => ({ agent: b.agent, output: b.output })) });
      i = j;
    } else {
      out.push({ kind: 'stage', agent: st.agent, output: st.output, text: st.agent, ...(st.scope === 'repos' && { allRepos: true }) });
      if (st.approval) out.push({ kind: 'human', text: 'you approve' });
      i++;
    }
    if (reviewLoop && i - 1 === reviewLoop.end) out.push({ kind: 'loop-end', text: 'fix rounds' });
  }
  if (stages.some(onRepos)) out.push({ kind: 'finish', text: 'commit' }, { kind: 'human', text: 'you confirm push' }, { kind: 'finish', text: 'draft PRs' });
  else if (pipeline.scenario && stages.length) out.push({ kind: 'finish', text: pipeline.scenario === 'audit' ? 'audit report' : 'readiness report' });
  return out;
}

export type { Chip, StageSource };
export { buildPipeline, fixedFlow, scenarioPipeline, scenarioKind, taskPipeline, fitsScenario, onRepos, reposBeforePlan, outline };
