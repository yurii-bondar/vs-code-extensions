// The steps of a custom scenario as config.yaml writes them (agents, and blocks of them: parallel, branch, loop) and as
// the rest of Claudestrator reads them: one list of agent steps, each marked with the block it is in.

import type { Condition, Effort, StepWhen } from './types';

/** An agent step: its name, or the agent with what it runs with and does in this scenario. */
type AgentStepLayer = string | { agent: string; model?: string; effort?: Effort; instructions?: string | { file: string } };
/** Read-only agents that run at once. */
interface ParallelLayer {
  parallel: AgentStepLayer[];
}
/** The task waits for you after the step or block before it: `true`, or what to look at. */
interface ApproveLayer {
  approve: string | true;
}
/** Steps that run only when the result of `on` meets `if` (`then`), or only when it does not (`else`). */
interface BranchLayer {
  branch: { on: string; if: Condition; then?: (AgentStepLayer | ApproveLayer)[]; else?: (AgentStepLayer | ApproveLayer)[] };
}
/** Steps that run again until the reviewers at their end approve, up to `rounds` times. */
interface LoopLayer {
  loop: { rounds?: number; steps: (AgentStepLayer | ParallelLayer)[] };
}
type ScenarioStepLayer = AgentStepLayer | ParallelLayer | BranchLayer | LoopLayer | ApproveLayer;

/** An agent step with the blocks it is in. Parallel blocks are numbered from 1 in the order they come. */
interface FlatStep<S = AgentStepLayer> {
  step: S;
  parallel?: number;
  when?: StepWhen;
  loop?: { rounds?: number };
  approve?: { text?: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isParallel = (s: unknown): s is ParallelLayer => isObject(s) && Array.isArray(s.parallel);
const isBranch = (s: unknown): s is BranchLayer => isObject(s) && isObject(s.branch);
const isLoop = (s: unknown): s is LoopLayer => isObject(s) && isObject(s.loop);
const isApprove = (s: unknown): s is ApproveLayer => isObject(s) && 'approve' in s;
const approveOf = (a: ApproveLayer): { text?: string } => (typeof a.approve === 'string' ? { text: a.approve } : {});
const approveLayer = (a: { text?: string }): ApproveLayer => ({ approve: a.text || true });
const agentOf = (s: AgentStepLayer): string => (typeof s === 'string' ? s : s.agent);

/** The agent steps of `layers` in order, each with the blocks it is in. */
function flattenSteps(layers: readonly ScenarioStepLayer[]): FlatStep[] {
  const out: FlatStep[] = [];
  let group = 0;
  const plain = (s: AgentStepLayer | ParallelLayer, extra: Omit<FlatStep, 'step'> = {}): void => {
    if (!isParallel(s)) return void out.push({ step: s, ...extra });
    group += 1;
    for (const m of s.parallel) out.push({ step: m, ...extra, parallel: group });
  };
  // An approve marks the step before it (the last of a block before it); one with nothing before it is dropped.
  const approve = (a: ApproveLayer, from: number): void => {
    if (out.length > from) out[out.length - 1]!.approve = approveOf(a);
  };
  for (const s of layers) {
    if (isApprove(s)) approve(s, 0);
    else if (isLoop(s)) {
      const loop = s.loop.rounds !== undefined ? { rounds: s.loop.rounds } : {};
      for (const b of s.loop.steps) plain(b, { loop });
    } else if (isBranch(s)) {
      const { on, if: cond } = s.branch;
      for (const [arm, when] of [[s.branch.then, { on, if: cond }], [s.branch.else, { on, if: cond, else: true as const }]] as const) {
        const from = out.length;
        for (const t of arm ?? []) {
          if (isApprove(t)) approve(t, from);
          else out.push({ step: t, when });
        }
      }
    } else plain(s);
  }
  return out;
}

const sameCondition = (a: StepWhen, b: StepWhen): boolean => a.on === b.on && JSON.stringify(a.if) === JSON.stringify(b.if);

/** Steps next to each other with the same parallel number as one parallel block, the others as they are. */
function nestPlain(flat: readonly FlatStep[]): (AgentStepLayer | ParallelLayer)[] {
  const out: (AgentStepLayer | ParallelLayer)[] = [];
  for (let i = 0; i < flat.length; ) {
    const f = flat[i]!;
    let j = i + 1;
    if (f.parallel !== undefined) while (j < flat.length && flat[j]!.parallel === f.parallel) j++;
    out.push(j - i > 1 ? { parallel: flat.slice(i, j).map((x) => x.step) } : f.step);
    i = j;
  }
  return out;
}

/** The blocks of a flat list again, as config.yaml writes them: the inverse of `flattenSteps`. */
function nestSteps(flat: readonly FlatStep[]): ScenarioStepLayer[] {
  const out: ScenarioStepLayer[] = [];
  for (let i = 0; i < flat.length; ) {
    const f = flat[i]!;
    let j = i + 1;
    if (f.loop) {
      while (j < flat.length && flat[j]!.loop) j++;
      out.push({ loop: { ...(f.loop.rounds !== undefined && { rounds: f.loop.rounds }), steps: nestPlain(flat.slice(i, j)) } });
    } else if (f.when) {
      while (j < flat.length && flat[j]!.when && sameCondition(flat[j]!.when!, f.when)) j++;
      const arm = flat.slice(i, j);
      const steps = (list: FlatStep[]) => list.flatMap((x) => (x.approve ? [x.step, approveLayer(x.approve)] : [x.step]));
      const then = steps(arm.filter((x) => !x.when!.else));
      const otherwise = steps(arm.filter((x) => x.when!.else));
      out.push({ branch: { on: f.when.on, if: f.when.if, ...(then.length && { then }), ...(otherwise.length && { else: otherwise }) } });
    } else {
      if (f.parallel !== undefined) while (j < flat.length && flat[j]!.parallel === f.parallel && !flat[j]!.loop && !flat[j]!.when) j++;
      out.push(...nestPlain(flat.slice(i, j)));
    }
    // After a step or a block (not inside a branch's arm, which keeps its own): the task waits for you there.
    const approved = flat.slice(i, j).filter((x) => !x.when).find((x) => x.approve);
    if (approved) out.push(approveLayer(approved.approve!));
    i = j;
  }
  return out;
}

/** The same blocks with each agent step replaced by `fn`'s. */
function mapAgentSteps(layers: readonly ScenarioStepLayer[], fn: (s: AgentStepLayer) => AgentStepLayer): ScenarioStepLayer[] {
  return nestSteps(flattenSteps(layers).map((f) => ({ ...f, step: fn(f.step) })));
}

export type { AgentStepLayer, ApproveLayer, BranchLayer, FlatStep, LoopLayer, ParallelLayer, ScenarioStepLayer };
export { agentOf, flattenSteps, mapAgentSteps, nestSteps };
