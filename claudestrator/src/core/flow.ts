// A task's pipeline as the diagram on its screen draws it: its steps with where each one is, the Parallels, the
// branches with the arm taken, the loop with its round, and where you approve. Read from the task's state only.

import { describeCondition, evaluate, stepRuns } from './conditions';
import type { Output, Stage, StepWhen, TaskState } from './types';

type FlowStatus = 'done' | 'running' | 'waiting' | 'failed' | 'next' | 'pending' | 'skipped';

interface FlowNode {
  agent: string;
  output: Output;
  status: FlowStatus;
  /** The repos it worked in, for a per-repo step. */
  repos?: string[];
  /** You approve after it: what to look at, and whether you did. */
  approve?: { text?: string; status: FlowStatus };
}

type FlowItem =
  | { kind: 'step'; node: FlowNode }
  | { kind: 'parallel'; nodes: FlowNode[] }
  | { kind: 'branch'; on: string; condition: string; taken: 'then' | 'else' | null; then: FlowNode[]; else: FlowNode[] }
  | { kind: 'loop'; explicit: boolean; round: number; maxRounds: number; items: FlowItem[] }
  | { kind: 'approve'; after: string; text?: string; status: FlowStatus };

/** Where a stage is: running, waiting for you, failed, done, next, skipped by its branch, or still to come. */
function statusOf(s: TaskState, i: number): FlowStatus {
  const st = s.pipeline.stages[i]!;
  const here = (step: { stage: number } | null | undefined) => Boolean(step) && step!.stage === i;
  if (s.running.some(here)) return 'running';
  const cp = s.checkpoint;
  if (cp && here(cp.step) && cp.id !== 'approve-step') return cp.id === 'agent-failure' ? 'failed' : 'waiting';
  if (s.parallel && s.parallel.failed.some((f) => here(f.step))) return 'failed';
  if (here(s.next) && s.phase === 'stages') return 'next';
  // In the loop, a step is done for this round only once it ran in it.
  const loop = s.pipeline.reviewLoop;
  const looped = Boolean(loop) && i >= loop!.restartAt && i <= loop!.end;
  const ran = s.artifacts.some((a) => a.agent === st.agent && (!looped || a.round === s.review.round));
  if (st.when && evaluate(s, st.when.on, st.when.if) !== null && !stepRuns(s, st.when)) return 'skipped';
  if (ran) return 'done';
  return s.phase === 'finish' || s.phase === 'done' ? 'skipped' : 'pending';
}

/** You approve after stage `i`: waiting while its question is open, done once a later step began or the task is past them. */
function approveStatus(s: TaskState, i: number, node: FlowStatus): FlowStatus {
  const cp = s.checkpoint;
  if (cp && cp.id === 'approve-step' && cp.step && cp.step.stage === i) return 'waiting';
  if (node === 'skipped') return 'skipped';
  const answered = s.answers.some((a) => a.id === 'approve-step');
  const later = s.pipeline.stages.some((st, k) => k > i && s.artifacts.some((a) => a.agent === st.agent));
  return node === 'done' && (later || answered || s.phase === 'finish' || s.phase === 'done') ? 'done' : 'pending';
}

function nodeOf(s: TaskState, i: number): FlowNode {
  const st = s.pipeline.stages[i]!;
  const status = statusOf(s, i);
  const repos = st.scope === 'repo' ? [...new Set(s.artifacts.filter((a) => a.agent === st.agent && a.repo).map((a) => a.repo!))] : [];
  return { agent: st.agent, output: st.output, status, ...(repos.length && { repos }), ...(st.approve && { approve: { ...(st.approve.text && { text: st.approve.text }), status: approveStatus(s, i, status) } }) };
}

const sameWhen = (a: StepWhen | undefined, b: StepWhen | undefined): boolean => Boolean(a && b) && a!.on === b!.on && JSON.stringify(a!.if) === JSON.stringify(b!.if);

/** Stages `from..to` as items: a step, a Parallel, a Branch; You approve after a step or a Parallel. */
function itemsOf(s: TaskState, from: number, to: number): FlowItem[] {
  const stages = s.pipeline.stages;
  const out: FlowItem[] = [];
  const approveAfter = (node: FlowNode): void => {
    if (node.approve) out.push({ kind: 'approve', after: node.agent, ...(node.approve.text && { text: node.approve.text }), status: node.approve.status });
  };
  for (let i = from; i < to; ) {
    const st: Stage = stages[i]!;
    let j = i + 1;
    if (st.when) {
      while (j < to && sameWhen(stages[j]!.when, st.when)) j++;
      const nodes = stages.slice(i, j).map((x, k) => ({ x, node: nodeOf(s, i + k) }));
      const met = evaluate(s, st.when.on, st.when.if);
      out.push({ kind: 'branch', on: st.when.on, condition: describeCondition(st.when.on, st.when.if), taken: met === null ? null : met ? 'then' : 'else', then: nodes.filter((n) => !n.x.when!.else).map((n) => n.node), else: nodes.filter((n) => n.x.when!.else).map((n) => n.node) });
    } else if (st.group !== undefined) {
      while (j < to && stages[j]!.group === st.group) j++;
      const nodes = stages.slice(i, j).map((_, k) => nodeOf(s, i + k));
      out.push({ kind: 'parallel', nodes });
      approveAfter(nodes[nodes.length - 1]!);
    } else {
      const node = nodeOf(s, i);
      out.push({ kind: 'step', node });
      approveAfter(node);
    }
    i = j;
  }
  return out;
}

/** The whole pipeline: the loop (the scenario's or the one the outputs make) as a frame over its stages. */
function flowOf(s: TaskState): FlowItem[] {
  const n = s.pipeline.stages.length;
  const loop = s.pipeline.reviewLoop;
  if (!loop) return itemsOf(s, 0, n);
  const inner = itemsOf(s, loop.restartAt, loop.end + 1);
  // You approve after the loop's last step comes after the loop, once its reviewers approved.
  const after = inner[inner.length - 1] && inner[inner.length - 1]!.kind === 'approve' ? [inner.pop()!] : [];
  return [...itemsOf(s, 0, loop.restartAt), { kind: 'loop', explicit: Boolean(loop.explicit), round: s.review.round, maxRounds: s.review.maxRounds, items: inner }, ...after, ...itemsOf(s, loop.end + 1, n)];
}

export type { FlowItem, FlowNode, FlowStatus };
export { flowOf };
