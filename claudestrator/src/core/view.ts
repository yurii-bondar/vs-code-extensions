// UI models built from a task's state and events: cards for lists, a step timeline, the activity feed.
import * as path from 'path';
import { transition, passSteps, sameStep, branchName, spentOf, blockingQuestions, onlyHumanFindings, MAX_EMPTY_ROUNDS } from './machine';
import { onRepos } from './pipeline';
import { evaluate, stepRuns } from './conditions';
import { describeEvent, checkpointTitle } from './describe';
import { transcriptKey } from './engine';
import { resultOf } from './report';
import { parseInvocation } from './intake';
import type { GroupType, OrchEvent, Source, StepRef, StepWhen, TaskState } from './types';

/** A step of a branch whose condition is known already and keeps it out. */
const skipped = (s: TaskState, when: StepWhen | undefined): boolean => Boolean(when) && evaluate(s, when!.on, when!.if) !== null && !stepRuns(s, when);

import type { Card, FeedEvent, Live, PermissionRequest, Status, StepItem, TaskDetail, TaskError, TaskPush, TaskSection, TaskSource, UsageItem } from './wire';
/** The part of the engine the UI models read. */
interface ViewEngine {
  isRunning(taskId: string): boolean;
  lastError(taskId: string): TaskError | null | undefined;
  pendingPermissions(taskId: string): PermissionRequest[];
  live(taskId: string): Live | null;
  liveCost: Map<string, Map<string, number>>;
  liveUsage: Map<string, UsageItem & { key: string }>;
  sessions: Map<string, readonly unknown[]>;
  inTurn: ReadonlyMap<string, number>;
  svc: {
    events(taskId: string): Promise<OrchEvent[]>;
    state(taskId: string): Promise<TaskState>;
    files(taskId: string): Promise<{ path: string; size: number; mtime: number }[]>;
    dir(taskId: string): string;
    runsElsewhere(taskId: string): Promise<number | null>;
  };
}

/** A task as the engine lists it: its state, or why it cannot be read. */
interface TaskEntry {
  taskId: string;
  state?: TaskState;
  corrupt?: boolean;
  error?: string;
  /** For a corrupt one: when its log last changed, since no state says so. */
  at?: string;
}

const VERDICT_LABEL: Record<string, string> = { ready: 'Ready', not_ready: 'Not ready', needs_check: 'Needs a human check' };

const CHECKPOINT_HINT: Record<string, string> = {
  'approve-step': 'The scenario waits for you here. Read what the step did, then go on, or have it run again with your words.',
  'approve-plan': 'Read the plan. Approve it, or say what to change and the planner revises it.',
  'gate-failure': 'The repo checks stayed red after the agent tried to fix them.',
  'agent-failure': 'An agent stopped before finishing its report.',
  'review-limit': 'The reviewer still has blocking findings after the last fix round.',
  'protected-changes': "An agent changed the repo's Claude Code or VS Code settings, which no agent writes. Read the change, then apply it or leave it.",
  'hook-failure': 'A git hook rejected the commit.',
  'confirm-push': 'Everything is committed locally. Push the branches and open draft PRs?',
  'post-review': 'The review is done. Post it to the pull request as comments?',
};

const HUMAN_FINDINGS_HINT = "The blocking findings are about the repo's Claude Code or VS Code settings, which no agent changes: make the change yourself, then retry for another review.";

const EMPTY_DIFF_HINT = 'The last review rounds saw an empty diff: the agents changed nothing, so more fix rounds would not help. Add guidance and retry, ship as it is, or stop.';

/** What a waiting task's notice says of its checkpoint. */
function hintOf(state: TaskState): string | undefined {
  const cp = state.checkpoint!;
  if (cp.id === 'review-limit' && state.review.emptyRounds >= MAX_EMPTY_ROUNDS) return EMPTY_DIFF_HINT;
  if (cp.id === 'review-limit' && onlyHumanFindings(state.review.verdicts)) return HUMAN_FINDINGS_HINT;
  if (cp.id === 'agent-failure' && cp.blocked) return 'An agent reported it cannot go on, and why.';
  if (cp.id === 'approve-plan' && blockingQuestions(state.plan).length) return 'The plan holds a question only you can answer: answer it, and the planner revises the plan with your answer.';
  const hint = CHECKPOINT_HINT[cp.id];
  return cp.repeated && hint ? `${hint} It failed the same way as the attempt before.` : hint;
}

/** The ticket's title, or before there is one the first line of what was typed, without its flags (`--auto`). */
function titleOf(s: TaskState | null | undefined, taskId: string): string {
  if (s && s.spec && s.spec.title) return s.spec.title;
  if (!s || !s.input) return taskId;
  let text = s.input;
  try {
    text = parseInvocation(s.input).input || s.input;
  } catch {
    // flags it cannot read: shown as typed
  }
  return text.split('\n')[0]!.slice(0, 100);
}

function sourceOf(s: TaskState | null | undefined): TaskSource | null {
  if (!s) return null;
  const src: Source = s.source;
  const link = s.spec && s.spec.links && s.spec.links[0];
  if (src.kind === 'jira') return { kind: 'jira', label: src.key, url: (link && link.url) || (src.site ? `https://${src.site}/browse/${src.key}` : undefined) };
  if (src.kind === 'confluence') return { kind: 'confluence', label: 'Confluence page', url: src.url };
  if (src.kind === 'linear') return { kind: 'linear', label: src.key, url: src.url };
  if (src.kind === 'github') return { kind: 'github', label: `${src.repo}#${src.number}`, url: (link && link.url) || `https://${src.host}/${src.repo}/issues/${src.number}` };
  if (src.kind === 'gitlab') return { kind: 'gitlab', label: `${src.project}#${src.number}`, url: (link && link.url) || `https://${src.host}/${src.project}/-/issues/${src.number}` };
  if (src.kind === 'pr') return { kind: 'pr', label: `${src.project}${src.forge === 'gitlab' ? '!' : '#'}${src.number}`, url: (link && link.url) || undefined };
  return { kind: 'text', label: 'Description' };
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
  const totals = new Map<StepItem, Map<string, { costUsd: number; turns: number; tokens: number }>>();
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
      case 'agent_progress':
      case 'agent_stopped': {
        const p = e.payload || {};
        const st = (p.transcript && findLast((x) => x.key === p.transcript)) || findLast((x) => x.agent === e.agent);
        if (st) {
          // A session reports running totals: each counts once, at its latest, and a step adds up its sessions.
          const sessions = totals.get(st) || new Map<string, { costUsd: number; turns: number; tokens: number }>();
          totals.set(st, sessions);
          const id = p.sessionId || `#${e.seq}`;
          const was = sessions.get(id) || { costUsd: 0, turns: 0, tokens: 0 };
          sessions.set(id, { costUsd: Math.max(was.costUsd, Number(p.costUsd) || 0), turns: Math.max(was.turns, Number(p.turns) || 0), tokens: Math.max(was.tokens, Number(p.tokens) || 0) });
          if (p.sessionId) st.sessionId = p.sessionId;
          if (p.cwd) st.cwd = p.cwd;
          if (p.configDir) st.configDir = p.configDir;
          if (p.model) st.model = p.model;
          if (p.effort) st.effort = p.effort;
          if (p.ctxPct !== undefined) st.ctxPct = p.ctxPct;
        }
        break;
      }
    }
    const r = transition(s, e);
    if (r.ok) s = r.state;
  }
  for (const [st, sessions] of totals) {
    const all = [...sessions.values()];
    st.costUsd = all.reduce((n, x) => n + x.costUsd, 0);
    st.turns = all.reduce((n, x) => n + x.turns, 0);
    const tokens = all.reduce((n, x) => n + x.tokens, 0);
    if (tokens) st.tokens = tokens;
  }
  // The step the state still calls running: live here, or interrupted (VS Code closed, or another tool runs it).
  for (const st of steps) if (st.kind === 'agent' && st.status === 'running' && !(state.running.some((r) => sameStep(r, st as StepRef)) && running)) st.status = state.status === 'stopped' ? 'paused' : 'interrupted';

  if (state.checkpoint && state.checkpoint.id !== 'confirm-push') {
    steps.push({ kind: 'human', id: state.checkpoint.id, label: checkpointTitle(state.checkpoint), status: state.status === 'stopped' ? 'paused' : 'waiting' });
  }

  const upcoming: StepItem[] = [];
  if (state.phase === 'intake' || state.phase === 'stages') {
    // Upcoming steps start after the running one or the one a checkpoint stopped at, or at the next one.
    const after = state.running[0] || (state.checkpoint && state.checkpoint.step) || null;
    const current = after || state.next;
    if (state.repos.length) {
      const pass = passSteps(state);
      const i = current ? pass.findIndex((p) => p.stage === current.stage && sameStep(p, current)) : -1;
      const rest = i === -1 ? (current || state.checkpoint ? [] : pass) : pass.slice(after ? i + 1 : i);
      for (const p of rest) {
        // The other members of a parallel group under way are listed above, as they started.
        if (state.running.some((r) => sameStep(r, p)) || (state.parallel && [...state.parallel.done, ...state.parallel.failed.map((f) => f.step)].some((d) => sameStep(d, p)))) continue;
        upcoming.push({ kind: 'agent', agent: p.agent, repo: p.repo, round: state.review.round, status: state.next && sameStep(state.next, p) && p.stage === state.next.stage ? 'next' : skipped(state, state.pipeline.stages[p.stage]!.when) ? 'skipped' : 'pending' });
      }
      // Stages after a running review loop only show up once the loop is left.
      if (state.review.fixing && state.pipeline.reviewLoop) {
        for (const st of state.pipeline.stages.slice(state.pipeline.reviewLoop.end + 1)) upcoming.push({ kind: 'agent', agent: st.agent, perRepo: st.scope === 'repo', allRepos: st.scope === 'repos', status: 'pending' });
      }
    } else {
      const from = current ? current.stage + (after ? 1 : 0) : 0;
      for (const st of state.pipeline.stages.slice(from)) {
        if (state.running.some((r) => r.agent === st.agent)) continue;
        upcoming.push({ kind: 'agent', agent: st.agent, perRepo: st.scope === 'repo', allRepos: st.scope === 'repos', status: current && st === state.pipeline.stages[current.stage] ? 'next' : skipped(state, st.when) ? 'skipped' : 'pending' });
      }
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

/** What Resume runs from where it is. */
const RESUMABLE = new Set(['stopped', 'failed', 'interrupted', 'ready']);

interface StatusFlags {
  running?: boolean;
  /** Another VS Code window on this workspace runs the task now. */
  elsewhere?: boolean;
  error?: unknown;
  corrupt?: boolean;
  asking?: boolean;
}

function statusOf(state: TaskState | null, flags: StatusFlags): Status {
  const status = baseStatus(state, flags);
  return { ...status, resumable: RESUMABLE.has(status.key) };
}

function baseStatus(state: TaskState | null, { running, elsewhere, error, corrupt, asking }: StatusFlags): Omit<Status, 'resumable'> {
  if (corrupt) return { key: 'corrupt', label: 'Unreadable', tone: 'error', group: 'attention' };
  if (running && asking) return { key: 'running', label: 'Asks your permission', tone: 'warn', group: 'attention' };
  if (running) return { key: 'running', label: 'Running', tone: 'accent', group: 'running' };
  if (elsewhere && state!.status === 'active') return { key: 'elsewhere', label: 'Running in another window', tone: 'accent', group: 'running' };
  if (state!.status === 'waiting') return { key: 'waiting', label: checkpointTitle(state!.checkpoint!), tone: 'warn', group: 'attention' };
  if (state!.status === 'done') {
    const r = resultOf(state!);
    if (r && r.kind === 'readiness') return { key: 'done', label: VERDICT_LABEL[r.verdict]!, tone: r.verdict === 'ready' ? 'ok' : 'warn', group: 'done' };
    if (r && r.kind === 'audit') {
      const serious = r.counts.critical! + r.counts.high!;
      return { key: 'done', label: r.findings.length ? `${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}${serious ? ` · ${serious} serious` : ''}` : 'No findings', tone: r.counts.critical ? 'error' : serious ? 'warn' : 'ok', group: 'done' };
    }
    const label = state!.outcome === 'published' ? 'PRs opened' : state!.outcome === 'local' ? 'Kept local' : state!.outcome === 'posted' ? 'Review posted' : state!.source.kind === 'pr' ? 'Reviewed' : 'Done';
    return { key: 'done', label, tone: 'ok', group: 'done' };
  }
  if (state!.status === 'stopped') return { key: 'stopped', label: state!.checkpoint ? `Stopped at: ${checkpointTitle(state!.checkpoint)}` : 'Stopped', tone: 'muted', group: 'stopped' };
  if (error) return { key: 'failed', label: 'Run failed', tone: 'error', group: 'attention' };
  if (state!.running.length) return { key: 'interrupted', label: 'Interrupted', tone: 'warn', group: 'attention' };
  return { key: 'ready', label: 'Ready to continue', tone: 'muted', group: 'stopped' };
}

/** What a card derives from the whole event log: the step timeline, the cost, the last stop. */
interface Derived {
  steps: StepItem[];
  cost: number;
  lastStop: OrchEvent | undefined;
}

/**
 * Derived data per state object. The store hands out the same state object until the events file changes, so a list
 * refresh replays only the tasks that moved; finished tasks cost nothing. Keyed again by `running`, which steps show.
 */
const derivedCache = new WeakMap<TaskState, Map<boolean, Derived>>();

async function derive(engine: ViewEngine, taskId: string, state: TaskState, running: boolean): Promise<Derived> {
  const byRunning = derivedCache.get(state) ?? new Map<boolean, Derived>();
  const hit = byRunning.get(running);
  if (hit) return hit;
  let events: OrchEvent[] = [];
  try {
    events = await engine.svc.events(taskId);
  } catch {
    // raced with a delete
  }
  const derived = { steps: stepsOf(events, state, { running }), cost: spentOf(events), lastStop: [...events].reverse().find((e) => e.type === 'stopped') };
  byRunning.set(running, derived);
  derivedCache.set(state, byRunning);
  return derived;
}

/** The card of a task whose log does not replay: every field a card has, so a list shows it beside the others. */
function corruptCard(taskId: string, error: string | undefined, at = new Date(0).toISOString()): Card {
  return {
    taskId,
    title: taskId,
    source: null,
    scenario: 'deliver',
    status: statusOf(null, { corrupt: true }),
    checkpoint: null,
    live: null,
    error: { message: `its log cannot be read: ${error || 'unknown error'}` },
    stopReason: undefined,
    round: 0,
    maxRounds: 0,
    phase: 'done',
    outcome: undefined,
    prs: {},
    branch: null,
    repos: [],
    cost: 0,
    createdAt: at,
    updatedAt: at,
    progress: { done: 0, total: 0 },
    mini: [],
  };
}

/** A compact card for lists and the tree. */
async function summary(engine: ViewEngine, entry: TaskEntry): Promise<Card> {
  const taskId = entry.taskId;
  if (entry.corrupt) return corruptCard(taskId, entry.error, entry.at);
  const state = entry.state!;
  const running = engine.isRunning(taskId);
  const elsewhere = !running && state.status === 'active' && (await engine.svc.runsElsewhere(taskId)) !== null;
  const error = engine.lastError(taskId);
  const { steps, cost, lastStop } = await derive(engine, taskId, state, running);
  const agentSteps = steps.filter((s) => s.kind !== 'human' || s.status !== 'pending');
  const result = resultOf(state);
  return {
    taskId,
    title: titleOf(state, taskId),
    source: sourceOf(state),
    scenario: state.scenario || 'deliver',
    ...(state.scenarioLabel && { scenarioLabel: state.scenarioLabel }),
    ...(state.group && { group: state.group }),
    ...(result && { result: result.kind === 'readiness' ? { kind: 'readiness', verdict: result.verdict, met: result.met, total: result.criteria.length } : { kind: 'audit', counts: result.counts } }),
    status: statusOf(state, { running, elsewhere, error, asking: engine.pendingPermissions(taskId).length > 0 }),
    checkpoint: state.checkpoint ? { id: state.checkpoint.id, title: checkpointTitle(state.checkpoint), hint: hintOf(state) } : null,
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
    cost: cost + [...(engine.liveCost.get(taskId)?.values() ?? [])].reduce((a, b) => a + b, 0),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    progress: { done: agentSteps.filter((s) => ['done', 'skipped'].includes(s.status)).length, total: agentSteps.length },
    mini: steps.map((s) => ({ kind: s.kind, agent: s.agent, repo: s.repo, label: s.label, status: s.status })),
  };
}

/** Everything the task screen shows. */
async function detail(engine: ViewEngine, taskId: string): Promise<TaskDetail> {
  const state = await engine.svc.state(taskId);
  const events = await engine.svc.events(taskId);
  const running = engine.isRunning(taskId);
  const card = await summary(engine, { taskId, state });
  return {
    ...card,
    input: state.input,
    auto: state.auto,
    gitMode: state.gitMode,
    effort: state.effort || {},
    model: state.model || {},
    instructions: state.instructions,
    pipeline: state.pipeline,
    plan: state.plan || null,
    spec: state.spec ? { title: state.spec.title, acceptanceCriteria: state.spec.acceptanceCriteria, links: state.spec.links } : null,
    openFindings: state.review.openFindings,
    result: resultOf(state),
    comments: events.filter((e) => e.type === 'jira_comment').map((e) => ({ seq: e.seq, at: e.at, key: e.key, what: e.what, ok: e.ok, via: e.via, ...(e.error && { error: e.error }) })),
    answers: state.answers,
    steps: (await derive(engine, taskId, state, running)).steps,
    events: events.flatMap((e): FeedEvent[] => {
      const d = describeEvent(e);
      return d && d.text ? [{ seq: e.seq, at: e.at, type: e.type, ...d }] : [];
    }),
    files: await engine.svc.files(taskId),
    taskDir: engine.svc.dir(taskId),
    permissions: engine.pendingPermissions(taskId),
    // A message reaches one session: not the members of a parallel group, which work at once.
    canMessage: engine.sessions.get(taskId)?.length === 1 && engine.inTurn.has(taskId),
    liveUsage: engine.liveUsage.get(taskId) || null,
  };
}

/** Which kind of section of the sidebar a task falls in: its group's type, or none. */
type SectionKind = GroupType | 'ungrouped';

/** One top-level row of the sidebar: the tasks of one epic, story or group, or every task without one. */
interface Section {
  /** Stable across refreshes, so the tree keeps a section folded the way the user left it. */
  key: string;
  kind: SectionKind;
  label: string;
  jira?: string;
  cards: Card[];
}

const SECTION_ORDER: readonly SectionKind[] = ['epic', 'story', 'group', 'ungrouped'];
const STATUS_ORDER: readonly string[] = ['attention', 'running', 'stopped', 'done'];

/**
 * The cards by the group each task belongs to: epics, then stories, then groups, then the ungrouped tasks. Sections of
 * one kind and the cards in a section keep the order the cards come in (newest first), with the tasks that need you
 * ahead of the running, the paused and the finished ones. A section is labelled as its newest task saw the group.
 */
function sectionsOf(cards: readonly Card[]): Section[] {
  const byKey = new Map<string, Section>();
  for (const card of cards) {
    const g = card.group;
    const key = g ? `${g.type}:${g.id}` : 'ungrouped';
    let section = byKey.get(key);
    if (!section) {
      section = g ? { key, kind: g.type, label: g.label, ...(g.jira && { jira: g.jira }), cards: [] } : { key, kind: 'ungrouped', label: 'Ungrouped', cards: [] };
      byKey.set(key, section);
    }
    section.cards.push(card);
  }
  const rank = (c: Card): number => STATUS_ORDER.indexOf(c.status.group);
  const sections = [...byKey.values()];
  for (const s of sections) s.cards.sort((a, b) => rank(a) - rank(b));
  return sections.sort((a, b) => SECTION_ORDER.indexOf(a.kind) - SECTION_ORDER.indexOf(b.kind));
}

/** The sections as the dashboard's rail lists them: ids in place of the cards, which the overview carries once. */
function sectionIndex(cards: readonly Card[]): TaskSection[] {
  return sectionsOf(cards).map(({ cards: list, ...s }) => ({ ...s, taskIds: list.map((c) => c.taskId) }));
}

type OutputPush = Extract<TaskPush, { type: 'output' }>;

/**
 * Queues one streamed item for the page. Text the agent writes arrives a few characters at a time: consecutive pieces
 * of one step merge into one message, so the host posts a handful of messages per flush instead of one per token.
 */
function queueOutput(queue: OutputPush[], push: OutputPush): void {
  const last = queue[queue.length - 1];
  if (last && push.item.type === 'text_delta' && last.item.type === 'text_delta' && last.taskId === push.taskId && last.key === push.key) {
    last.item = { ...last.item, text: last.item.text + push.item.text };
  } else queue.push({ ...push, item: { ...push.item } as OutputPush['item'] });
}

export type { Card, OutputPush, Section, SectionKind, Status, StepItem, TaskEntry, TaskError, ViewEngine };
/**
 * Whether Markdown loads something from the web when shown: an image or a reference an image uses at an address
 * (`![](https://host/?q=<the code>)`). VS Code's preview fetches them; an agent steered by a ticket could write one
 * into a report, and opening it would send what it carries past the sandbox.
 */
function loadsRemote(markdown: string): boolean {
  return /!\[[^\]\n]{0,300}\]\(\s*<?(?:https?:)?\/\//i.test(markdown) || /<(?:img|image|source|video|audio|iframe|object|embed|link)\b[^>]*\b(?:src|href|srcset|data|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(markdown) || (/!\[/.test(markdown) && /^\s{0,3}\[[^\]\n]+\]:\s*<?(?:https?:)?\/\//m.test(markdown));
}

/**
 * Text for a notification, shown as it is written. In a notification's message VS Code makes `[label](command:…)` (or
 * `file:`, `https:`) a link it opens on a click, commands included; the text may come from an agent, a ticket, an MCP
 * server or the output of git and gh. A space between `]` and `(` leaves the brackets as text, and a bare `command:` or
 * `vscode:` address gets a zero-width space before its colon.
 */
function plainNotice(text: string): string {
  return text.replace(/\]\(/g, '] (').replace(/\b(command|vscode)(?=:)/gi, '$1​');
}

/**
 * Whether a value is a web address, the only kind opened outside the editor: a PR's value may be whatever `gh` printed,
 * and a `command:`, `file:` or `vscode:` address would run something or open a file instead.
 */
function isWebLink(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url);
}

/** An engine's `log` event as a line of the extension's log: its level (anything else is info) and its task. */
function logLine({ level, message, taskId }: { level: string; message: string; taskId?: string }): { level: 'error' | 'warn' | 'info'; text: string } {
  return { level: level === 'error' || level === 'warn' ? level : 'info', text: taskId ? `[${taskId}] ${message}` : message };
}

/** The longest command a permission notification shows. */
const NOTICE_COMMAND = 120;

/**
 * A permission request as a notification says it, and whether it says all of it. A notification has room for one
 * short line (and shows no `detail`): a longer command, or one with line breaks or invisible characters, is shown cut,
 * and the notification then offers no Allow, only the dashboard, which shows it whole.
 */
function permissionNotice(p: Pick<PermissionRequest, 'agent' | 'repo' | 'tool' | 'input'>): { text: string; whole: boolean } {
  const input = typeof p.input === 'object' && p.input !== null ? (p.input as Record<string, unknown>) : {};
  let what = `use ${p.tool}`;
  let whole = true;
  if (p.tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const flat = command.replace(/[\p{Cc}\p{Cf}]+/gu, ' ');
    whole = flat === command && command.length <= NOTICE_COMMAND;
    what = `run \`${whole ? command : `${flat.slice(0, NOTICE_COMMAND)}…`}\``;
  } else if (typeof input.file_path === 'string') what = `${p.tool.toLowerCase()} ${path.basename(input.file_path)}`;
  return { text: plainNotice(`${p.agent}${p.repo ? ` @ ${p.repo}` : ''} wants to ${what}`), whole };
}

export { isWebLink, loadsRemote, logLine, permissionNotice, plainNotice, sectionIndex, sectionsOf, summary, detail, stepsOf, statusOf, queueOutput, CHECKPOINT_HINT };
