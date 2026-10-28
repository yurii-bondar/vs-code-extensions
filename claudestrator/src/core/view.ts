// UI models built from a task's state and events: cards for lists, a step timeline, the activity feed.
import { transition, passSteps, sameStep, branchName, MAX_EMPTY_ROUNDS } from './machine';
import { onRepos } from './pipeline';
import { describeEvent, CHECKPOINT_TITLE } from './describe';
import { transcriptKey } from './engine';
import { resultOf } from './report';
import type { OrchEvent, Source, StepRef, TaskState } from './types';

import type { Card, FeedEvent, Live, PermissionRequest, Status, StepItem, TaskDetail, TaskError, TaskSource, UsageItem } from './wire';
/** The part of the engine the UI models read. */
interface ViewEngine {
  isRunning(taskId: string): boolean;
  lastError(taskId: string): TaskError | null | undefined;
  pendingPermissions(taskId: string): PermissionRequest[];
  live(taskId: string): Live | null;
  liveCost: Map<string, number>;
  liveUsage: Map<string, UsageItem & { key: string }>;
  sessions: Map<string, unknown>;
  svc: {
    events(taskId: string): OrchEvent[];
    state(taskId: string): TaskState;
    files(taskId: string): { path: string; size: number; mtime: number }[];
    dir(taskId: string): string;
  };
}

/** A task as the engine lists it: its state, or why it cannot be read. */
interface TaskEntry {
  taskId: string;
  state?: TaskState;
  corrupt?: boolean;
  error?: string;
}

const VERDICT_LABEL: Record<string, string> = { ready: 'Ready', not_ready: 'Not ready', needs_check: 'Needs a human check' };

const CHECKPOINT_HINT: Record<string, string> = {
  'approve-plan': 'Read the plan. Approve it, or say what to change and the planner revises it.',
  'gate-failure': 'The repo checks stayed red after the agent tried to fix them.',
  'agent-failure': 'An agent stopped before finishing its report.',
  'review-limit': 'The reviewer still has blocking findings after the last fix round.',
  'hook-failure': 'A git hook rejected the commit.',
  'confirm-push': 'Everything is committed locally. Push the branches and open draft PRs?',
};

const EMPTY_DIFF_HINT = 'The last review rounds saw an empty diff: the agents changed nothing, so more fix rounds would not help. Add guidance and retry, ship as it is, or stop.';

const titleOf = (s: TaskState | null | undefined, taskId: string): string => (s && s.spec && s.spec.title) || (s && s.input ? s.input.split('\n')[0]!.slice(0, 100) : taskId);

function sourceOf(s: TaskState | null | undefined): TaskSource | null {
  if (!s) return null;
  const src: Source = s.source;
  const link = s.spec && s.spec.links && s.spec.links[0];
  if (src.kind === 'jira') return { kind: 'jira', label: src.key, url: (link && link.url) || (src.site ? `https://${src.site}/browse/${src.key}` : undefined) };
  if (src.kind === 'confluence') return { kind: 'confluence', label: 'Confluence page', url: src.url };
  return { kind: 'text', label: 'Description' };
}

function costOf(events: OrchEvent[]): number {
  let cost = 0;
  for (const e of events) if (e.type === 'agent_stopped') cost += Number((e.payload && e.payload.costUsd) || 0);
  return cost;
}

/** Executed steps, from the log, plus what is still to come. */
function stepsOf(events: OrchEvent[], state: TaskState, { running }: { running: boolean }): StepItem[] {
  let s = null as TaskState | null;
  // Reading the ticket is the first step; it has a transcript when an agent read it (via MCP).
  const intakeRan = events.some((e) => e.type === 'agent_stopped' && e.payload && e.payload.transcript === '0000-intake');
  const intakeLive = state.phase === 'intake' && running;
  const steps: StepItem[] = [{ kind: 'intake', label: 'Ticket', ...((intakeRan || intakeLive) && { key: '0000-intake' }), status: state.phase !== 'intake' ? 'done' : running ? 'running' : 'next' }];
  const findLast = (pred: (st: StepItem) => boolean): StepItem | null => {
    for (let i = steps.length - 1; i >= 0; i--) if (pred(steps[i]!)) return steps[i]!;
    return null;
  };
  for (const e of events) {
    switch (e.type) {
      case 'stage_started':
        steps.push({ kind: 'agent', key: transcriptKey(e.seq!, e), agent: e.agent, repo: e.repo, ...(!e.repo && s && s.pipeline.stages.some((st) => st.agent === e.agent && st.scope === 'repos') && { allRepos: true }), round: s ? s.review.round : 1, status: 'running', startedAt: e.at, mode: s ? s.nextMode : 'initial' });
        break;
      case 'stage_completed': {
        const st = findLast((x) => x.status === 'running' && sameStep(x as StepRef, e));
        if (st) Object.assign(st, { status: 'done', endedAt: e.at, artifact: e.artifact, gates: e.gates, ...(e.verdict && { verdict: { status: e.verdict.status, findings: e.verdict.findings.length, blocking: e.verdict.findings.filter((f) => f.severity !== 'minor').length } }), ...(e.readiness && { readiness: { verdict: e.readiness.verdict, met: e.readiness.criteria.filter((c) => c.status === 'met').length, total: e.readiness.criteria.length } }), ...(e.audit && { audit: { findings: e.audit.findings.length, serious: e.audit.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length } }) });
        break;
      }
      case 'stage_failed': {
        const st = findLast((x) => x.status === 'running' && sameStep(x as StepRef, e));
        if (st) Object.assign(st, { status: 'failed', endedAt: e.at, error: e.error });
        break;
      }
      case 'gates_ran': {
        const st = findLast((x) => sameStep(x as StepRef, e));
        if (st) st.gateRuns = [...(st.gateRuns || []), { attempt: e.attempt, status: e.status }];
        break;
      }
      case 'agent_stopped': {
        const p = e.payload || {};
        const st = (p.transcript && findLast((x) => x.key === p.transcript)) || findLast((x) => x.agent === e.agent);
        if (st) {
          st.costUsd = (st.costUsd || 0) + Number(p.costUsd || 0);
          st.turns = (st.turns || 0) + Number(p.turns || 0);
          if (p.sessionId) st.sessionId = p.sessionId;
          if (p.cwd) st.cwd = p.cwd;
          if (p.model) st.model = p.model;
          if (p.effort) st.effort = p.effort;
          if (p.ctxPct !== undefined) st.ctxPct = p.ctxPct;
          if (p.tokens) st.tokens = (st.tokens || 0) + p.tokens;
        }
        break;
      }
    }
    const r = transition(s, e);
    if (r.ok) s = r.state;
  }
  // The step the state still calls running: live here, or interrupted (VS Code closed, or another tool runs it).
  for (const st of steps) if (st.kind === 'agent' && st.status === 'running' && !(state.running && sameStep(state.running, st as StepRef) && running)) st.status = state.status === 'stopped' ? 'paused' : 'interrupted';

  if (state.checkpoint && state.checkpoint.id !== 'confirm-push') {
    steps.push({ kind: 'human', id: state.checkpoint.id, label: CHECKPOINT_TITLE[state.checkpoint.id]!, status: state.status === 'stopped' ? 'paused' : 'waiting' });
  }

  const upcoming: StepItem[] = [];
  if (state.phase === 'intake' || state.phase === 'stages') {
    // Upcoming steps start after the running one or the one a checkpoint stopped at, or at the next one.
    const after = state.running || (state.checkpoint && state.checkpoint.step) || null;
    const current = after || state.next;
    if (state.repos.length) {
      const pass = passSteps(state);
      const i = current ? pass.findIndex((p) => p.stage === current.stage && sameStep(p, current)) : -1;
      const rest = i === -1 ? (current || state.checkpoint ? [] : pass) : pass.slice(after ? i + 1 : i);
      for (const p of rest) upcoming.push({ kind: 'agent', agent: p.agent, repo: p.repo, round: state.review.round, status: state.next && sameStep(state.next, p) && p.stage === state.next.stage ? 'next' : 'pending' });
      // Stages after a running review loop only show up once the loop is left.
      if (state.review.fixing && state.pipeline.reviewLoop) {
        for (const st of state.pipeline.stages.slice(state.pipeline.reviewLoop.end + 1)) upcoming.push({ kind: 'agent', agent: st.agent, perRepo: st.scope === 'repo', allRepos: st.scope === 'repos', status: 'pending' });
      }
    } else {
      const from = current ? current.stage + (after ? 1 : 0) : 0;
      for (const st of state.pipeline.stages.slice(from)) upcoming.push({ kind: 'agent', agent: st.agent, perRepo: st.scope === 'repo', allRepos: st.scope === 'repos', status: current && st === state.pipeline.stages[current.stage] ? 'next' : 'pending' });
    }
  }
  const hasRepoStages = state.pipeline.stages.some(onRepos);
  if (hasRepoStages && state.outcome !== 'completed') {
    const fs = state.finishStep;
    const done = state.phase === 'done';
    const pushOpen = state.checkpoint && state.checkpoint.id === 'confirm-push';
    upcoming.push({ kind: 'finish', id: 'commit', label: 'Commit', status: done || fs === 'confirm' || fs === 'publish' ? 'done' : state.checkpoint && state.checkpoint.id === 'hook-failure' ? 'failed' : fs === 'commit' ? (running ? 'running' : 'next') : 'pending' });
    upcoming.push({ kind: 'human', id: 'confirm-push', label: 'Confirm push', status: done || fs === 'publish' ? 'done' : pushOpen ? (state.status === 'stopped' ? 'paused' : 'waiting') : 'pending' });
    upcoming.push({ kind: 'finish', id: 'publish', label: state.outcome === 'local' ? 'Kept local' : 'Draft PRs', status: state.outcome === 'published' ? 'done' : state.outcome === 'local' ? 'skipped' : fs === 'publish' ? (running ? 'running' : 'next') : 'pending' });
  }
  return [...steps, ...upcoming];
}

function statusOf(state: TaskState | null, { running, error, corrupt, asking }: { running?: boolean; error?: unknown; corrupt?: boolean; asking?: boolean }): Status {
  if (corrupt) return { key: 'corrupt', label: 'Unreadable', tone: 'error', group: 'attention' };
  if (running && asking) return { key: 'running', label: 'Asks your permission', tone: 'warn', group: 'attention' };
  if (running) return { key: 'running', label: 'Running', tone: 'accent', group: 'running' };
  if (state!.status === 'waiting') return { key: 'waiting', label: CHECKPOINT_TITLE[state!.checkpoint!.id] || 'Needs you', tone: 'warn', group: 'attention' };
  if (state!.status === 'done') {
    const r = resultOf(state!);
    if (r && r.kind === 'readiness') return { key: 'done', label: VERDICT_LABEL[r.verdict]!, tone: r.verdict === 'ready' ? 'ok' : 'warn', group: 'done' };
    if (r && r.kind === 'audit') {
      const serious = r.counts.critical! + r.counts.high!;
      return { key: 'done', label: r.findings.length ? `${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}${serious ? ` · ${serious} serious` : ''}` : 'No findings', tone: r.counts.critical ? 'error' : serious ? 'warn' : 'ok', group: 'done' };
    }
    const label = state!.outcome === 'published' ? 'PRs opened' : state!.outcome === 'local' ? 'Kept local' : 'Done';
    return { key: 'done', label, tone: 'ok', group: 'done' };
  }
  if (state!.status === 'stopped') return { key: 'stopped', label: state!.checkpoint ? `Stopped at: ${CHECKPOINT_TITLE[state!.checkpoint.id]}` : 'Stopped', tone: 'muted', group: 'stopped' };
  if (error) return { key: 'failed', label: 'Run failed', tone: 'error', group: 'attention' };
  if (state!.running) return { key: 'interrupted', label: 'Interrupted', tone: 'warn', group: 'attention' };
  return { key: 'ready', label: 'Ready to continue', tone: 'muted', group: 'stopped' };
}

/** A compact card for lists and the tree. */
function summary(engine: ViewEngine, entry: TaskEntry): Card {
  const taskId = entry.taskId;
  if (entry.corrupt) return { taskId, title: taskId, status: statusOf(null, { corrupt: true }), error: { message: entry.error }, steps: [], cost: 0 } as unknown as Card;
  const state = entry.state!;
  const running = engine.isRunning(taskId);
  const error = engine.lastError(taskId);
  let events: OrchEvent[] = [];
  try {
    events = engine.svc.events(taskId);
  } catch {
    // raced with a delete
  }
  const steps = stepsOf(events, state, { running });
  const agentSteps = steps.filter((s) => s.kind !== 'human' || s.status !== 'pending');
  const lastStop = [...events].reverse().find((e) => e.type === 'stopped');
  const result = resultOf(state);
  return {
    taskId,
    title: titleOf(state, taskId),
    source: sourceOf(state),
    scenario: state.scenario || 'deliver',
    ...(state.scenarioLabel && { scenarioLabel: state.scenarioLabel }),
    ...(result && { result: result.kind === 'readiness' ? { kind: 'readiness', verdict: result.verdict, met: result.met, total: result.criteria.length } : { kind: 'audit', counts: result.counts } }),
    status: statusOf(state, { running, error, asking: engine.pendingPermissions(taskId).length > 0 }),
    checkpoint: state.checkpoint ? { id: state.checkpoint.id, title: CHECKPOINT_TITLE[state.checkpoint.id], hint: state.checkpoint.id === 'review-limit' && state.review.emptyRounds >= MAX_EMPTY_ROUNDS ? EMPTY_DIFF_HINT : CHECKPOINT_HINT[state.checkpoint.id] } : null,
    live: engine.live(taskId),
    error,
    stopReason: state.status === 'stopped' && lastStop && lastStop.type === 'stopped' ? lastStop.reason : undefined,
    round: state.review.round,
    maxRounds: state.review.maxRounds,
    phase: state.phase,
    outcome: state.outcome,
    prs: state.prs,
    branch: branchName(state),
    repos: state.repos.map((r) => r.name),
    cost: costOf(events) + (engine.liveCost.get(taskId) || 0),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    progress: { done: agentSteps.filter((s) => ['done', 'skipped'].includes(s.status)).length, total: agentSteps.length },
    mini: steps.map((s) => ({ kind: s.kind, agent: s.agent, repo: s.repo, label: s.label, status: s.status })),
  };
}

/** Everything the task screen shows. */
function detail(engine: ViewEngine, taskId: string): TaskDetail {
  const state = engine.svc.state(taskId);
  const events = engine.svc.events(taskId);
  const running = engine.isRunning(taskId);
  const card = summary(engine, { taskId, state });
  return {
    ...card,
    input: state.input,
    auto: state.auto,
    gitMode: state.gitMode,
    effort: state.effort || {},
    model: state.model || {},
    pipeline: state.pipeline,
    plan: state.plan || null,
    spec: state.spec ? { title: state.spec.title, acceptanceCriteria: state.spec.acceptanceCriteria, links: state.spec.links } : null,
    openFindings: state.review.openFindings,
    result: resultOf(state),
    comments: events.filter((e) => e.type === 'jira_comment').map((e) => ({ seq: e.seq, at: e.at, key: e.key, what: e.what, ok: e.ok, via: e.via, ...(e.error && { error: e.error }) })),
    answers: state.answers,
    steps: stepsOf(events, state, { running }),
    events: events.flatMap((e): FeedEvent[] => {
      const d = describeEvent(e);
      return d && d.text ? [{ seq: e.seq, at: e.at, type: e.type, ...d }] : [];
    }),
    files: engine.svc.files(taskId),
    taskDir: engine.svc.dir(taskId),
    permissions: engine.pendingPermissions(taskId),
    canMessage: engine.sessions.has(taskId),
    liveUsage: engine.liveUsage.get(taskId) || null,
  };
}

export type { Card, Status, StepItem, TaskEntry, TaskError, ViewEngine };
export { summary, detail, stepsOf, statusOf, CHECKPOINT_HINT };
