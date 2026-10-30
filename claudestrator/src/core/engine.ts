// The engine: drives tasks through the state machine, runs each agent as a Claude Code session, runs gates,
// commits, pushes and opens draft PRs. Independent of VS Code; the extension listens to its events.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { loadConfig } from './config';
import { EFFORTS, SCENARIOS } from './protocol';
import { buildPipeline, scenarioKind, taskPipeline, fitsScenario, onRepos } from './pipeline';
import { nextAction, runOf, artifactPath, branchName, sameStep, editableFrom, stepRepos, TASK_FILES, type NextAction, type RunAction } from './machine';
import { parseInvocation, classifyInput, detectScenario, runIntake, renderTicket, IntakeError, extractAcceptanceCriteria } from './intake';
import { TaskService, type DispatchResult } from './store';
import { exec, GitRepo, branchSync, taskRepos, prepareRepos, taskDiff, removeWorktrees } from './git';
import { runGates } from './gates';
import { guardBash } from './guard';
import { buildAgentPrompt, parseStageReport, lastJsonBlock } from './prompt';
import { commitSubject, prTitle, prBody } from './pr';
import { renderReport, jiraText } from './report';
import type { Live, PermissionRequest, RepoStatus } from './wire';
import type { ClaudeRunner, ClaudeSession, Limits, TurnResult } from './runner';
import type { HookServer, Decision, ToolCall } from './hookserver';
import type { AtlassianClient, Invocation } from './intake';
import type { StageSource } from './pipeline';
import type { RepoGates } from './gates';
import type { TaskRepo } from './git';
import type { BlockedRepo, CheckpointContext, CommentResult, ComposerArgs, Preview, TranscriptItem, UsageItem } from './wire';
import type { Checkpoint, Config, Effort, EventBody, EventOf, GatesStatus, Pipeline, Source, Spec, Step, TaskGroup, TaskInstruction, TaskState } from './types';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const REPORT_OUTPUTS = new Set(['readiness', 'audit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'Task', 'BashOutput', 'ToolSearch', 'Skill']);
const REPORT_RETRIES = 2;
/** What Claude Code says when its own sign-in is missing or expired (not an MCP server's). */
const CLAUDE_AUTH = /Failed to authenticate|OAuth (session|token) (has )?expired|Invalid API key|Please run \/login|not logged in|authentication_error/i;
const INTAKE_KEY = '0000-intake';
/** MCP tools an intake session may call: reading only (Atlassian: getJiraIssue, search, fetch, getConfluencePage, …). */
const MCP_READ = /^(get|search|fetch|lookup|list|read|atlassianUserInfo)/i;
/** The one write a Jira comment session may make (Atlassian: addCommentToJiraIssue). */
const MCP_COMMENT = /^addComment/i;
const COMMENT_TIMEOUT_MS = 4 * 60000;

const COMMENT_INSTRUCTIONS = `You post exactly one comment on one Jira issue and do nothing else.
Use the MCP tool that adds a comment to a Jira issue (e.g. addCommentToJiraIssue). If a tool needs a cloud id, look it up with the tool that lists accessible Atlassian resources.
Post the comment body exactly as given, once. Never edit, transition, assign, link or create anything.
End your reply with a fenced json block: {"ok": true, "commentId": "<id, or empty>"}, or {"error": "<what went wrong>"} if it could not be posted.`;

const INTAKE_INSTRUCTIONS = `You turn one Jira issue or Confluence page into a ticket for a team of coding agents.
Read it with the MCP tools you have. You only read: never create, edit, transition or comment on anything.
For Jira: read the issue (summary, description, acceptance criteria, comments, linked issues). If a tool needs a cloud id, look it up with the tool that lists accessible Atlassian resources.
Keep the description faithful (Markdown, no invention). Summarise only comments that change or clarify the scope.
If the MCP tools are missing or the issue cannot be read, do not guess: reply with {"error": "<what went wrong>"} in the json block.
End your reply with a fenced json block:
{"title": "<KEY> <summary>", "url": "<link to the issue or page>", "description": "<markdown>", "acceptanceCriteria": ["..."], "links": [{"title": "...", "url": "..."}], "context": "<scope-changing comments and linked pages, summarised, or empty>"}`;

class EngineError extends Error {
  code: string;
  blocked?: BlockedRepo[];

  constructor(code: string, message: string, extra?: { blocked?: BlockedRepo[] | undefined }) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/** An Atlassian MCP server to read tickets with when there is no API token. */
interface McpIntake {
  server: string;
  site?: string | undefined;
}

interface EngineOptions {
  workspace: string;
  home?: string | undefined;
  runner: Pick<ClaudeRunner, 'start'>;
  hooks: HookServer;
  atlassian?: (() => AtlassianClient | null) | undefined;
  mcpIntake?: (() => McpIntake | null) | undefined;
  askPermissions?: (() => boolean) | undefined;
  now?: (() => Date) | undefined;
}

interface PermissionAnswer {
  allow: boolean;
  message?: string;
}

type EngineLimits = Limits & { at: number };


/** The ticket an intake session hands back, before it is checked. */
interface RawTicket {
  title: string;
  url?: unknown;
  description?: unknown;
  acceptanceCriteria?: unknown;
  links?: unknown;
  context?: unknown;
  error?: unknown;
  commentId?: unknown;
}

/** What a session reports about itself when it ends. */
interface SessionUsage {
  model?: string | undefined;
  effort?: string | null | undefined;
  ctxPct?: number | undefined;
  tokens?: number | undefined;
}

const stepLabel = (s: { agent: string; repo?: string | undefined }): string => (s.repo ? `${s.agent} @ ${s.repo}` : s.agent);
const transcriptKey = (seq: number, step: { agent: string; repo?: string | undefined }): string => `${String(seq).padStart(4, '0')}-${step.agent}${step.repo ? `-${step.repo.replace(/[^A-Za-z0-9._-]/g, '_')}` : ''}`;

function realInside(root: string, target: string): boolean {
  const real = (p: string): string => {
    let cur = path.resolve(p);
    const rest: string[] = [];
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      return path.resolve(p);
    }
  };
  const r = real(root);
  const t = real(target);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * Events: 'changed' (taskId), 'output' ({ taskId, key, item }), 'live' ({ taskId, live }),
 * 'log' ({ level, message, taskId }), 'checkpoint' ({ taskId, checkpoint, title }), 'finished' ({ taskId, state }),
 * 'permission' (request), 'permissionDone' (requestId).
 */
class Engine extends EventEmitter {
  workspace: string;
  home: string | undefined;
  runner: Pick<ClaudeRunner, 'start'>;
  hooks: HookServer;
  atlassian: () => AtlassianClient | null;
  mcpIntake: () => McpIntake | null;
  askPermissions: () => boolean;
  sessions: Map<string, ClaudeSession>;
  running: Set<string>;
  prepared: Set<string>;
  /** The confirm-push question's context per task, with the checkpoint it was made for (`at`). */
  pushContext = new Map<string, { at: string; value: CheckpointContext }>();
  lives: Map<string, Live>;
  errors: Map<string, { code: string; message: string; blocked?: BlockedRepo[]; at: string }>;
  permissions: Map<string, { request: PermissionRequest; resolve: (a: PermissionAnswer) => void }>;
  liveCost: Map<string, number>;
  liveUsage: Map<string, UsageItem & { key: string }>;
  limits: EngineLimits | null;
  svc: TaskService;

  constructor(opts: EngineOptions) {
    super();
    this.workspace = opts.workspace;
    this.home = opts.home;
    this.runner = opts.runner;
    this.hooks = opts.hooks;
    this.atlassian = opts.atlassian || (() => null);
    /** `() => ({ server, site }) | null`: an Atlassian MCP server to read tickets with when there is no API token. */
    this.mcpIntake = opts.mcpIntake || (() => null);
    this.askPermissions = opts.askPermissions || (() => false);
    this.sessions = new Map();
    this.running = new Set();
    this.prepared = new Set();
    this.lives = new Map();
    this.errors = new Map();
    this.permissions = new Map();
    this.liveCost = new Map();
    this.liveUsage = new Map();
    /** The account's latest 5-hour and weekly limits, as agents last saw them. */
    this.limits = null;
    this.svc = new TaskService({ workspace: opts.workspace, now: opts.now, onAppend: (taskId) => this.emit('changed', taskId) });
  }

  /** Always read fresh: an edited instruction applies to the very next agent run. */
  config(flags?: { no?: string[] | undefined; only?: string[] | undefined }): Config {
    const r = loadConfig({ workspace: this.workspace, ...(this.home && { home: this.home }), flags });
    if (!r.ok) throw new EngineError('config_invalid', r.errors.map((e) => e.message).join('\n'));
    return r.config;
  }

  log(level: string, message: string, taskId?: string): void {
    this.emit('log', { level, message, ...(taskId && { taskId }) });
  }

  setLive(taskId: string, live: Live | null): void {
    // The clock runs per step: gates, report fixes and permission prompts of the same step keep it going.
    const prev = this.lives.get(taskId);
    const same = live && prev && (live.key ? prev.key === live.key : prev.phase === live.phase);
    if (live) this.lives.set(taskId, { ...live, since: same ? prev!.since : Date.now() });
    else this.lives.delete(taskId);
    this.emit('live', { taskId, live: this.lives.get(taskId) || null });
  }

  live(taskId: string): Live | null {
    return this.lives.get(taskId) || null;
  }

  dispatch(taskId: string, body: EventBody): Extract<DispatchResult, { ok: true }> {
    const r = this.svc.dispatch(taskId, body);
    if (!r.ok) throw new EngineError(r.error.code, `${body.type} rejected: ${r.error.message}`);
    return r;
  }

  // ---------- starting ----------

  /**
   * The scenario of a new task: chosen in the composer or with `--scenario`, else read from the words
   * ("перевір готовність…" → readiness, "аудит…" → audit), else deliver. A readiness check takes the Jira issue a
   * sentence names as its source.
   */
  resolveScenario(inv: { input: string; key?: string | undefined; scenario?: string | undefined }, scenario: string | undefined, config: Config) {
    const removed = config.removedScenarios || [];
    const custom = config.custom || {};
    const available = [...SCENARIOS.filter((id) => !removed.includes(id)), ...Object.keys(custom)];
    const explicit = scenario && scenario !== 'auto' ? scenario : inv.scenario;
    if (explicit && !available.includes(explicit)) throw new EngineError('bad_scenario', `there is no scenario "${explicit}" here; choose one of ${available.join(', ')}`);
    // Words can only pick a built-in scenario that is still there.
    const detected = detectScenario(inv.input);
    const name = explicit || (available.includes(detected) ? detected : 'deliver');
    const kind = scenarioKind(config, name);
    const input = inv.input || inv.key || '';
    const source = classifyInput(input, { embedded: kind === 'readiness', projects: config.jira.allowedProjects });
    return { scenario: kind, name, ...(custom[name] && { label: custom[name]!.label }), detected: !explicit && name !== 'deliver', source };
  }

  /** A custom scenario's own model and effort per agent, as `{ model: { agent: m }, effort: { agent: level } }`. */
  scenarioDefaults(config: Config, name: string): { model: Record<string, string>; effort: Record<string, Effort> } {
    const steps = (config.custom && config.custom[name] && config.custom[name]!.agents) || [];
    return {
      model: Object.fromEntries(steps.filter((st) => st.model).map((st) => [st.name, st.model])) as Record<string, string>,
      effort: Object.fromEntries(steps.filter((st) => st.effort).map((st) => [st.name, st.effort])) as Record<string, Effort>,
    };
  }

  /** What a composer input would do, without creating anything. */
  preview({ text = '', auto = false, no = [], key, effort = {}, scenario }: ComposerArgs = {}): Preview {
    let inv: Invocation;
    try {
      inv = parseInvocation(text);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const input = inv.input;
    if (!input && !(key || inv.key)) return { ok: true, empty: true };
    const flags = { no: [...new Set([...(inv.flags.no || []), ...no])], ...(inv.flags.only && { only: inv.flags.only }) };
    const r = loadConfig({ workspace: this.workspace, ...(this.home && { home: this.home }), flags });
    if (!r.ok) return { ok: false, error: r.errors.map((e) => e.message).join('\n') };
    let sc: ReturnType<Engine['resolveScenario']>;
    try {
      sc = this.resolveScenario({ ...inv, input: (input || key || inv.key) as string }, scenario, r.config);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const source = sc.source;
    const pipeline = buildPipeline(r.config, { auto: auto || inv.auto, scenario: sc.name });
    const { taskId, exists } = this.svc.idFor({ taskId: key || inv.key, source, scenario: sc.scenario });
    let problem: string | undefined;
    if (source.kind === 'jira') {
      const allowed = r.config.jira.allowedProjects;
      const project = source.key.split('-')[0]!;
      if (allowed.length && !allowed.includes(project)) problem = `Jira project ${project} is not allowed here (allowed: ${allowed.join(', ')})`;
    }
    if (pipeline.stages.length === 0) problem = problem || (sc.name === 'deliver' ? 'every agent is switched off' : `no agent is on for the ${sc.label || sc.name} scenario`);
    let taskEffort: Record<string, string> = {};
    try {
      taskEffort = this.effortFor(r.config, pipeline, inv.effort, effort, this.scenarioDefaults(r.config, sc.name).effort);
    } catch (e) {
      problem = problem || (e as Error).message;
    }
    return { ok: true, source, taskId, exists, scenario: sc.scenario, scenarioName: sc.name, scenarioDetected: sc.detected, pipeline, effort: taskEffort, warnings: [...r.warnings, ...pipeline.warnings].map((w) => w.message), ...(problem && { problem }) };
  }

  /**
   * Merges `--effort` from the text with the composer's per-agent choices into `{ agent: level }` for the task's
   * enabled agents. `*` applies to every one of them; a named agent wins over `*`. `defaults` (a custom scenario's own
   * effort per agent) apply unless the task sets something else.
   */
  effortFor(config: Config, pipeline: Pick<Pipeline, 'stages'>, fromText: Record<string, string> = {}, fromUi: Record<string, string> = {}, defaults: Record<string, string> = {}): Record<string, string> {
    const merged = { ...fromText, ...fromUi };
    const agents = pipeline.stages.map((s) => s.agent);
    const out = Object.fromEntries(Object.entries(defaults).filter(([name]) => agents.includes(name)));
    for (const [name, level] of Object.entries(merged)) {
      if (!level) continue;
      if (!EFFORTS.includes(level as Effort)) throw new EngineError('bad_effort', `effort "${level}" is not one of ${EFFORTS.join(', ')}`);
      if (name !== '*' && !config.agents[name]) throw new EngineError('bad_effort', `--effort names unknown agent "${name}"`);
    }
    if (merged['*']) for (const a of agents) out[a] = merged['*'];
    for (const [name, level] of Object.entries(merged)) if (name !== '*' && level && agents.includes(name)) out[name] = level;
    return out;
  }

  /** The group and instructions a task picked, as the config has them now; an id that is gone is an error. */
  extras(config: Config, group: string | undefined, instructions: string[]): { group?: TaskGroup; instructions: TaskInstruction[] } {
    const g = group ? config.groups[group] : undefined;
    if (group && !g) throw new EngineError('bad_group', `there is no group "${group}" here any more; pick another`);
    const missing = instructions.filter((id) => !config.instructions[id]);
    if (missing.length) throw new EngineError('bad_instruction', `there is no instruction ${missing.map((id) => `"${id}"`).join(', ')} here any more; pick again`);
    return { ...(g && { group: g }), instructions: instructions.map((id) => config.instructions[id]!) };
  }

  start({ text = '', auto = false, no = [], key, effort = {}, scenario, group, instructions = [] }: ComposerArgs = {}): { taskId: string; created: boolean } {
    const inv = parseInvocation(text);
    if (!inv.input && !(key || inv.key)) throw new EngineError('no_input', 'Describe the task, or paste a Jira key or a Confluence link');
    const flags = { no: [...new Set([...(inv.flags.no || []), ...no])], ...(inv.flags.only && { only: inv.flags.only }) };
    const config = this.config(flags);
    const sc = this.resolveScenario({ ...inv, input: (inv.input || key || inv.key) as string }, scenario, config);
    const source = sc.source;
    if (source.kind === 'jira') {
      const allowed = config.jira.allowedProjects;
      const project = source.key.split('-')[0]!;
      if (allowed.length && !allowed.includes(project)) throw new EngineError('project_not_allowed', `Jira project ${project} is not allowed (allowed: ${allowed.join(', ')})`);
    }
    const isAuto = auto || inv.auto;
    const pipeline = buildPipeline(config, { auto: isAuto, scenario: sc.name });
    if (pipeline.stages.length === 0) throw new EngineError('empty_pipeline', sc.name === 'deliver' ? 'Every agent is switched off; turn at least one on' : `No agent is on for the ${sc.label || sc.name} scenario; add one or turn one on in Agents`);
    const defaults = this.scenarioDefaults(config, sc.name);
    const taskEffort = this.effortFor(config, pipeline, inv.effort, effort, defaults.effort);
    const taskModel: Record<string, string> = Object.fromEntries(Object.entries(defaults.model).filter(([name]) => pipeline.stages.some((st) => st.agent === name)));
    const extras = this.extras(config, group, instructions);
    const extra = [...(no.length ? [`--no ${no.join(',')}`] : []), ...(auto && !inv.auto ? ['--auto'] : []), ...(scenario && scenario !== 'auto' && !inv.scenario ? [`--scenario ${scenario}`] : [])].join(' ');
    const started = this.svc.start({
      input: extra ? `${text.trim()} ${extra}` : text.trim(),
      source,
      scenario: sc.scenario,
      ...(sc.label && { scenarioName: sc.name, scenarioLabel: sc.label }),
      ...extras,
      auto: isAuto,
      pipeline,
      config,
      effort: taskEffort as Record<string, Effort>,
      model: taskModel,
      ...((key || inv.key) && { taskId: key || inv.key }),
    });
    this.svc.setCurrent(started.taskId);
    pipeline.warnings.forEach((w) => this.log('warn', w.message, started.taskId));
    return { taskId: started.taskId, created: started.created };
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  lastError(taskId: string) {
    return this.errors.get(taskId) || null;
  }

  /** Runs in the background and reports failures as events instead of throwing. */
  launch(taskId: string): void {
    if (this.running.has(taskId)) return;
    this.errors.delete(taskId);
    this.run(taskId).catch((e) => {
      if (e.code === 'stopped') return;
      const err = { code: e.code || 'internal', message: e.message || String(e), ...(e.blocked && { blocked: e.blocked }), at: new Date().toISOString() };
      this.errors.set(taskId, err);
      try {
        this.svc.record(taskId, { type: 'note', message: `Run failed: ${err.message}` });
      } catch {
        // the task folder may be gone
      }
      this.log('error', err.message, taskId);
      this.emit('changed', taskId);
    });
  }

  /** Branch mode switches your checkouts, so two tasks with repo stages cannot run at once. */
  checkExclusive(taskId: string): void {
    const s = this.svc.state(taskId);
    const touchesRepos = (st: TaskState): boolean => st.gitMode === 'branch' && st.pipeline.stages.some(onRepos);
    if (!touchesRepos(s)) return;
    for (const other of this.running) {
      if (other === taskId) continue;
      try {
        if (touchesRepos(this.svc.state(other))) throw new EngineError('busy', `${other} is running and branch mode shares your checkouts. Wait for it, or switch Git mode to worktrees in Settings.`);
      } catch (e) {
        if (e instanceof EngineError) throw e;
      }
    }
  }

  /** Drives the task until it is done, stopped or waiting for you. */
  async run(taskId: string): Promise<TaskState | undefined> {
    if (this.running.has(taskId)) throw new EngineError('already_running', `task ${taskId} is already running`);
    this.checkExclusive(taskId);
    this.running.add(taskId);
    this.emit('changed', taskId);
    try {
      for (;;) {
        const s = this.svc.state(taskId);
        const next = nextAction(s);
        switch (next.kind) {
          case 'done':
            this.emit('finished', { taskId, state: s });
            return s;
          case 'stopped':
            return s;
          case 'checkpoint':
            this.emit('checkpoint', { taskId, checkpoint: next.checkpoint, title: s.spec ? s.spec.title : taskId });
            return s;
          case 'intake':
            await this.intake(s);
            break;
          case 'run':
          case 'running':
            await this.runStep(s, next);
            break;
          case 'commit':
            await this.commit(s);
            break;
          case 'publish':
            await this.publish(s);
            break;
        }
      }
    } finally {
      this.running.delete(taskId);
      this.prepared.delete(taskId);
      this.setLive(taskId, null);
      this.emit('changed', taskId);
    }
  }

  async intake(s: TaskState): Promise<void> {
    this.setLive(s.taskId, { phase: 'intake', text: s.source.kind === 'text' ? 'Writing the ticket' : `Reading ${s.source.kind === 'jira' ? s.source.key : 'the Confluence page'}` });
    let spec: Spec;
    const via = s.source.kind !== 'text' && !this.atlassian() ? this.mcpIntake() : null;
    try {
      if (via) spec = await this.intakeViaMcp(s, via);
      else spec = await runIntake(s.taskId, s.source, { atlassian: this.atlassian(), allowedProjects: this.config().jira.allowedProjects });
    } catch (e) {
      if (e instanceof IntakeError) throw new EngineError(e.code, e.code === 'atlassian_not_configured' ? 'Jira and Confluence are not reachable: sign in to an Atlassian MCP server (MCP tab), or add an API token in Settings → Jira & Confluence' : e.message);
      throw e;
    }
    // What the user wrote next to the issue key ("check it is ready") travels with the ticket.
    if (s.source.note && !spec.request) spec = { ...spec, request: s.source.note };
    this.svc.writeArtifact(s.taskId, TASK_FILES.ticketJson, `${JSON.stringify(spec, null, 2)}\n`);
    this.svc.writeArtifact(s.taskId, TASK_FILES.ticket, renderTicket(spec));
    this.dispatch(s.taskId, { type: 'intake_completed', spec });
  }

  /** Streams an agent session's output to the UI and its transcript. */
  emitter(taskId: string, key: string): (item: TranscriptItem) => void {
    return (item) => {
      const t = Date.now();
      const stamped = { ...item, t };
      if (item.type === 'usage') this.liveUsage.set(taskId, { ...item, t, key });
      else if (item.type !== 'text_delta' && item.type !== 'thinking') this.svc.appendTranscript(taskId, key, stamped);
      if (item.type === 'turn_end') this.liveCost.set(taskId, (item.costUsd as number | undefined) || 0);
      this.emit('output', { taskId, key, item: stamped });
    };
  }

  /**
   * Reads a Jira issue or Confluence page through an Atlassian MCP server signed in with Claude Code (no API token):
   * a short read-only agent session that hands back the ticket as JSON.
   */
  async intakeViaMcp(s: TaskState, via: McpIntake): Promise<Spec> {
    const src = s.source;
    if (src.kind === 'jira') {
      const allowed = this.config().jira.allowedProjects;
      const project = src.key.split('-')[0]!;
      if (allowed.length && !allowed.includes(project)) throw new EngineError('project_not_allowed', `Jira project ${project} is not allowed (allowed: ${allowed.join(', ')})`);
    }
    const what = src.kind === 'jira' ? `the Jira issue ${src.key}${src.site || via.site ? ` on ${src.site || via.site}` : ''}` : `the Confluence page ${(src as Extract<Source, { kind: 'confluence' }>).url}`;
    const prompt = `Read ${what} using the "${via.server}" MCP server's tools and write the ticket as your instructions say.`;
    const emitItem = this.emitter(s.taskId, INTAKE_KEY);
    emitItem({ type: 'prompt', text: prompt });
    const agent = { name: 'intake', description: 'Reads the task source', model: 'haiku', effort: 'low' as const, instructions: INTAKE_INSTRUCTIONS, output: 'plan' };
    const hook = this.hooks.register(async ({ tool }) => {
      if (READ_TOOLS.has(tool) || tool === 'ToolSearch') return { allow: true };
      const action = tool.startsWith('mcp__') ? tool.split('__').pop() : '';
      if (action && MCP_READ.test(action)) return { allow: true };
      emitItem({ type: 'blocked', tool, reason: 'reading the ticket only reads: this tool could change something' });
      return { allow: false, reason: 'Claudestrator: the intake only reads; use the get/search/fetch tools' };
    });
    this.setLive(s.taskId, { phase: 'intake', key: INTAKE_KEY, text: `Reading ${src.kind === 'jira' ? src.key : 'the page'} via ${via.server}` });
    const session = this.runner.start({ agent, prompt, cwd: this.workspace, additionalDirectories: [], env: hook.env, name: `claudestrator ${s.taskId} · intake`, onOutput: emitItem });
    this.sessions.set(s.taskId, session);
    let t: TurnResult = { ok: false, report: '' };
    try {
      t = await session.turn();
      let parsed: RawTicket | null = null;
      for (let i = 0; ; i++) {
        if (this.svc.state(s.taskId).status === 'stopped') throw new EngineError('stopped', 'stopped');
        if (!t.ok && CLAUDE_AUTH.test(t.error || '')) throw new EngineError('claude_login', `Claude Code is signed out for this account (${t.error}). Sign in again, or switch the account.`);
        if (!t.ok) throw new EngineError('fetch_failed', `reading ${src.kind === 'jira' ? src.key : 'the page'} via ${via.server} failed: ${t.error || 'the agent failed'}`);
        const block = lastJsonBlock(t.report);
        const value = (block.ok ? block.value : null) as RawTicket | null;
        if (block.ok && value && value.error) throw new EngineError('fetch_failed', `could not read ${src.kind === 'jira' ? src.key : 'the page'} via ${via.server}: ${value.error}`);
        if (block.ok && value && typeof value.title === 'string' && value.title.trim()) {
          parsed = value;
          break;
        }
        if (i >= 1) throw new EngineError('fetch_failed', `could not read ${src.kind === 'jira' ? src.key : 'the page'} via ${via.server}: ${block.ok ? 'the reply has no title' : block.error}. ${t.report.slice(0, 300)}`);
        session.send(`I need the ticket as the fenced json block your instructions describe (with a title). ${block.ok ? '' : block.error}`, { from: 'orchestrator' });
        t = await session.turn();
      }
      const ticket = parsed!;
      const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
      const description = String(ticket.description || '');
      const links = (Array.isArray(ticket.links) ? (ticket.links as { title?: unknown; url?: unknown }[]) : []).filter((l) => l && l.url).map((l) => ({ title: String(l.title || l.url), url: String(l.url) }));
      if (ticket.url) links.unshift({ title: src.kind === 'jira' ? src.key : String(ticket.title), url: String(ticket.url) });
      return {
        id: s.taskId,
        source: src,
        title: String(ticket.title).trim(),
        description,
        acceptanceCriteria: list(ticket.acceptanceCriteria).length ? list(ticket.acceptanceCriteria) : extractAcceptanceCriteria(description),
        links,
        ...((ticket.context as string | undefined) && String(ticket.context).trim() && { context: String(ticket.context).trim() }),
      };
    } finally {
      session.close();
      this.sessions.delete(s.taskId);
      this.hooks.unregister(hook.token);
      this.liveUsage.delete(s.taskId);
      this.liveCost.delete(s.taskId);
      const u: SessionUsage = session.usage ? session.usage() : {};
      this.svc.record(s.taskId, { type: 'agent_stopped', agent: 'intake', payload: { costUsd: t.costUsd || session.costUsd || 0, turns: t.turns || session.turns || 0, sessionId: t.sessionId || session.sessionId, cwd: this.workspace, transcript: INTAKE_KEY, ...(u.model && { model: u.model }), ...(u.effort && { effort: u.effort }) } });
    }
  }

  spentUsd(taskId: string): number {
    let total = 0;
    for (const e of this.svc.events(taskId)) if (e.type === 'agent_stopped') total += Number((e.payload && e.payload.costUsd) || 0);
    return total;
  }

  async runStep(s: TaskState, next: NextAction): Promise<void> {
    const taskId = s.taskId;
    const step = (next as RunAction | Extract<NextAction, { kind: 'running' }>).step;
    const config = this.config();
    const taskDir = this.svc.dir(taskId);
    const stage = s.pipeline.stages[step.stage]!;
    const configured = config.agents[step.agent];
    // The task's own model and effort for this agent (from its scenario or the composer) win over the configured ones.
    const override = s.effort && s.effort[step.agent];
    const model = s.model && s.model[step.agent];
    const agent = configured && (override || model) ? { ...configured, ...(override && { effort: override }), ...(model && { model }) } : configured;
    const label = stepLabel(step);

    const budget = config.limits.budgetUsd;
    const spent = budget !== undefined ? this.spentUsd(taskId) : 0;
    if (budget !== undefined && spent >= budget) {
      this.log('warn', `Budget of $${budget} spent ($${spent.toFixed(2)}); the task stopped`, taskId);
      this.dispatch(taskId, { type: 'stopped', reason: `budget of $${budget} spent` });
      return;
    }

    let repoDir: string | undefined;
    /** A `repos` stage (the tester) works in every repo of the pass: `[{ name, dir }]`. */
    let workRepos: { name: string; dir: string }[] = [];
    if (onRepos(stage)) {
      if (!this.prepared.has(taskId)) {
        this.setLive(taskId, { phase: 'preparing', step, text: `Preparing branch ${branchName(s)}` });
        const p = await prepareRepos(this.workspace, s, config);
        if (!p.ok) throw new EngineError(p.code, `${p.error}${p.blocked ? `: ${p.blocked.map((b) => `${b.repo} (${b.problem})`).join(', ')}` : ''}`, { blocked: p.blocked });
        this.prepared.add(taskId);
      }
      if (step.repo) repoDir = taskRepos(this.workspace, s, config, [step.repo])[0]!.dir;
      else workRepos = taskRepos(this.workspace, s, config, stepRepos(s, step)).map((r) => ({ name: r.name, dir: r.dir }));
    }

    let diffPath: string | undefined;
    let emptyDiff = false;
    if (stage.output === 'verdict' && s.repos.length) {
      this.setLive(taskId, { phase: 'preparing', step, text: 'Collecting the diff for review' });
      const diff = await taskDiff(taskRepos(this.workspace, s, config, s.repos.map((r) => r.name)));
      diffPath = this.svc.writeArtifact(taskId, `reviews/r${s.review.round}/diff.patch`, diff.text);
      emptyDiff = diff.empty;
    }

    let seq: number;
    if (next.kind === 'run') seq = this.dispatch(taskId, { type: 'stage_started', agent: step.agent, ...(step.repo && { repo: step.repo }) }).event.seq!;
    else {
      const started = this.svc.events(taskId).filter((e): e is EventOf<'stage_started'> => e.type === 'stage_started' && sameStep(e, step));
      seq = started.length ? started[started.length - 1]!.seq! : 0;
    }
    const key = transcriptKey(seq, step);
    const fail = (error: string) => this.dispatch(taskId, { type: 'stage_failed', agent: step.agent, ...(step.repo && { repo: step.repo }), error });

    if (!agent || !agent.enabled) {
      fail(`agent "${step.agent}" is no longer enabled in the config`);
      return;
    }

    const state = this.svc.state(taskId);
    const run = next.kind === 'run' ? next : runOf(state, step);
    // Readiness and audit agents read every configured repo where it is, also outside the workspace folder.
    const readRepos = REPORT_OUTPUTS.has(stage.output) ? Object.values(config.repos).map((r) => ({ name: r.name, dir: path.resolve(this.workspace, r.path), baseBranch: r.baseBranch, ...(r.role && { role: r.role }) })) : [];
    const prompt = buildAgentPrompt({ state, next: run, taskDir, language: config.language, ...(repoDir && { repoDir }), ...(workRepos.length && { workRepos }), ...(diffPath && { diffPath }), ...(readRepos.length && { repos: readRepos }) });
    const cwd = repoDir || (workRepos.length === 1 ? workRepos[0]!.dir : this.workspace);
    const emitItem = this.emitter(taskId, key);
    if (next.kind === 'run') emitItem({ type: 'prompt', text: prompt });

    const writeRoots = stage.scope === 'repo' ? [repoDir as string] : workRepos.map((r) => r.dir);
    const hook = this.hooks.register((call) => this.decide({ taskId, step, writeRoots, config, call, emitItem }));
    const session = this.runner.start({
      agent,
      prompt,
      cwd,
      additionalDirectories: [...new Set([taskDir, this.workspace, ...workRepos.map((r) => r.dir), ...readRepos.map((r) => r.dir).filter((d) => fs.existsSync(d))])].filter((d) => !realInside(cwd, d)),
      env: hook.env,
      name: `claudestrator ${taskId} · ${label}`,
      onOutput: emitItem,
      onLimits: (limits) => {
        this.limits = limits;
        this.emit('limits', limits);
      },
      ...(budget !== undefined && { maxBudgetUsd: Math.max(0.01, budget - spent) }),
    });
    this.sessions.set(taskId, session);
    this.setLive(taskId, { phase: 'agent', step, key, text: `${label} is working` });

    let t: TurnResult = { ok: false, report: '' };
    const stopped = (): boolean => this.svc.state(taskId).status === 'stopped';
    try {
      t = await session.turn();
      if (stopped()) return;
      if (!t.ok) return void fail(t.error || 'the agent failed');

      let gates: 'none' | 'pass' | 'fail' = 'none';
      // The repos whose checks run after this step: its own, or every repo a `repos` stage worked in.
      const targets = (stage.scope === 'repo' ? [{ name: step.repo as string, dir: repoDir }] : workRepos).filter((r): r is { name: string; dir: string } => Boolean(r.dir && config.repos[r.name] && config.repos[r.name]!.gates.length));
      const where = targets.map((r) => r.name).join(', ');
      if (targets.length) {
        for (let attempt = 1; ; attempt++) {
          const runs: RepoGates[] = [];
          for (const r of targets) {
            this.setLive(taskId, { phase: 'gates', step, key, text: `Running gates in ${r.name}` });
            runs.push(
              await runGates({
                repo: config.repos[r.name]!,
                dir: r.dir,
                logDir: path.join(taskDir, 'gates', `r${state.review.round}`),
                onGate: (name) => this.setLive(taskId, { phase: 'gates', step, key, text: `Gate "${name}" in ${r.name} (attempt ${attempt})` }),
              })
            );
            if (stopped()) return;
          }
          const g: { status: GatesStatus; summary: string; results: { gate: string; status: GatesStatus; ms: number | undefined }[] } = {
            status: runs.some((x) => x.status === 'fail') ? 'fail' : runs.some((x) => x.status === 'pass') ? 'pass' : 'skipped',
            summary: runs.map((x) => x.summary).join('\n'),
            results: runs.flatMap((x) => x.results.map(({ gate, status, ms }) => ({ gate: runs.length > 1 ? `${x.repo} · ${gate}` : gate, status, ms }))),
          };
          this.svc.record(taskId, { type: 'gates_ran', agent: step.agent, ...(step.repo ? { repo: step.repo } : { repos: targets.map((r) => r.name) }), status: g.status, attempt, summary: g.summary });
          emitItem({ type: 'gates', status: g.status, attempt, summary: g.summary, results: g.results });
          if (g.status !== 'fail') {
            gates = g.status === 'pass' ? 'pass' : 'none';
            break;
          }
          if (attempt >= config.limits.gateAttempts) {
            gates = 'fail';
            break;
          }
          const red = runs.filter((x) => x.status === 'fail').map((x) => x.repo).join(', ');
          session.send(`Gates failed in ${red} (attempt ${attempt} of ${config.limits.gateAttempts}). Fix the causes below. Do not weaken, skip or delete tests or lint rules. Then reply with your full report again.\n\n${g.summary}`, { from: 'orchestrator' });
          this.setLive(taskId, { phase: 'agent', step, key, text: `${label} is fixing red gates in ${where.includes(',') ? red : where}` });
          t = await session.turn();
          if (stopped()) return;
          if (!t.ok) return void fail(t.error || 'the agent failed while fixing gates');
        }
      }

      let parsed = parseStageReport(stage.output, t.report);
      for (let i = 0; !parsed.ok && i < REPORT_RETRIES; i++) {
        this.setLive(taskId, { phase: 'agent', step, key, text: `${label} is correcting its report` });
        session.send(`Your report could not be read: ${parsed.error}. Reply again with the complete, corrected report.`, { from: 'orchestrator' });
        t = await session.turn();
        if (stopped()) return;
        if (!t.ok) return void fail(t.error || 'the agent failed while correcting its report');
        parsed = parseStageReport(stage.output, t.report);
      }
      if (!parsed.ok) return void fail(`report still invalid after ${REPORT_RETRIES} corrections: ${parsed.error}`);

      const artifact = artifactPath(stage.output, step.agent, state.review.round, step.repo);
      this.svc.writeArtifact(taskId, artifact, t.report.endsWith('\n') ? t.report : `${t.report}\n`);
      this.dispatch(taskId, {
        type: 'stage_completed',
        agent: step.agent,
        ...(step.repo && { repo: step.repo }),
        artifact,
        ...(parsed.plan && { plan: parsed.plan }),
        ...(parsed.verdict && { verdict: parsed.verdict }),
        ...(parsed.readiness && { readiness: parsed.readiness }),
        ...(parsed.audit && { audit: parsed.audit }),
        ...(emptyDiff && { emptyDiff: true }),
        gates,
      });
      if (REPORT_OUTPUTS.has(stage.output)) this.writeReport(taskId, config.language);
    } finally {
      session.close();
      this.sessions.delete(taskId);
      this.hooks.unregister(hook.token);
      this.denyPermissions(taskId, 'the agent session ended');
      this.liveCost.delete(taskId);
      this.liveUsage.delete(taskId);
      const u: SessionUsage = session.usage ? session.usage() : {};
      this.svc.record(taskId, {
        type: 'agent_stopped',
        agent: step.agent,
        payload: {
          costUsd: t.costUsd || session.costUsd || 0,
          turns: t.turns || session.turns || 0,
          sessionId: t.sessionId || session.sessionId,
          cwd,
          transcript: key,
          ...(u.model && { model: u.model }),
          ...(u.effort && { effort: u.effort }),
          ...(u.ctxPct !== undefined && { ctxPct: u.ctxPct }),
          ...(u.tokens && { tokens: u.tokens }),
        },
      });
    }
  }

  /** The permission policy of an agent session: the Bash guard, writes only inside the stage's repo, then (optionally) you. */
  async decide({ taskId, step, writeRoots = [], config, call, emitItem }: { taskId: string; step: Step; writeRoots?: string[]; config: Config; call: ToolCall; emitItem: (item: TranscriptItem) => void }): Promise<Decision> {
    const { tool, input } = call;
    const blocked = (reason: string): Decision => {
      emitItem({ type: 'blocked', tool, reason, input: summarizeInput(tool, input) });
      return { allow: false, reason: `Claudestrator: ${reason}` };
    };
    if (READ_TOOLS.has(tool)) return { allow: true };
    const cwd = writeRoots.length === 1 ? writeRoots[0]! : this.workspace;
    if (tool === 'Bash') {
      const d = guardBash(String(input.command || ''), {
        policy: config.policy,
        cwd: call.cwd && fs.existsSync(call.cwd) ? call.cwd : cwd,
        workspace: this.workspace,
        repoDirs: Object.values(config.repos).map((r) => path.resolve(this.workspace, r.path)),
        ...(this.home && { home: this.home }),
        task: { taskId, canPush: false },
        agent: true,
        writeRoots,
        branchOf: branchSync,
        isRepoRoot: (dir) => fs.existsSync(path.join(dir, '.git')),
        readFile: (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null),
      });
      if (!d.allow) return blocked(d.reason);
    }
    if (WRITE_TOOLS.has(tool)) {
      const target = String(input.file_path || input.notebook_path || input.path || '');
      if (!writeRoots.length) return blocked(`the ${step.agent} stage does not change files`);
      if (path.resolve(cwd, target).split(path.sep).includes('.git')) return blocked(`${tool} into git metadata (.git) is not allowed; Claudestrator owns git`);
      if (!target || !writeRoots.some((root) => realInside(root, path.resolve(cwd, target)))) return blocked(`${tool} outside ${writeRoots.join(', ')} is not allowed: this stage works only in ${step.repo || 'the task\'s repos'}`);
    }
    // Claude Code is started with the agent's tools; anything else reaching the hook is refused.
    const agent = config.agents[step.agent];
    const given = !agent || !agent.tools || agent.tools.some((t) => t === tool || t.startsWith(`${tool}(`)) || (tool.startsWith('mcp__') && agent.mcp !== false);
    if (!given) return blocked(`${tool} is not one of the ${step.agent} agent's tools`);
    if (!this.askPermissions()) return { allow: true };
    const requestId = crypto.randomUUID();
    const request: PermissionRequest = { requestId, taskId, agent: step.agent, ...(step.repo && { repo: step.repo }), tool, input: summarizeInput(tool, input), at: Date.now() };
    const prev = this.live(taskId);
    this.setLive(taskId, { ...(prev || {}), phase: 'permission', step, text: `${stepLabel(step)} asks to use ${tool}` });
    this.emit('changed', taskId);
    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.permissions.set(requestId, { request, resolve });
      this.emit('permission', request);
    });
    if (prev) this.setLive(taskId, prev);
    return answer.allow ? { allow: true } : { allow: false, reason: answer.message || 'denied by the user' };
  }

  pendingPermissions(taskId?: string): PermissionRequest[] {
    return [...this.permissions.values()].map((p) => p.request).filter((r) => !taskId || r.taskId === taskId);
  }

  permissionReply(requestId: string, allow: boolean, message?: string): boolean {
    const p = this.permissions.get(requestId);
    if (!p) return false;
    this.permissions.delete(requestId);
    p.resolve({ allow, ...(message && { message }) });
    this.emit('permissionDone', requestId);
    return true;
  }

  denyPermissions(taskId: string, message: string): void {
    for (const [id, p] of this.permissions) if (p.request.taskId === taskId) this.permissionReply(id, false, message);
  }

  // ---------- finishing ----------

  async commit(s: TaskState): Promise<void> {
    this.setLive(s.taskId, { phase: 'committing', text: 'Committing' });
    const config = this.config();
    const subject = commitSubject(s);
    const body = s.source.kind === 'jira' ? `Refs: ${s.taskId}` : '';
    const branch = branchName(s) as string;
    const committed: string[] = [];
    for (const r of taskRepos(this.workspace, s, config, s.repos.map((x) => x.name))) {
      if (!(await r.git.isRepo())) continue;
      if ((await r.git.dirty()).length) {
        // The work is committed on the task branch only: another branch checked out meanwhile (main, another task's)
        // would get it instead.
        const current = await r.git.branch();
        if (current !== branch) throw new EngineError('wrong_branch', `${r.name} is on ${current || 'a detached HEAD'}, not the task branch ${branch}; switch back (git switch ${branch}) and try again`);
        await r.git.addAll();
        const c = await r.git.git('commit', '-m', subject, ...(body ? ['-m', body] : []));
        if (c.code !== 0) {
          this.dispatch(s.taskId, { type: 'commit_failed', repo: r.name, output: `${c.stdout}${c.stderr}`.trim().slice(-8000) });
          return;
        }
      }
      if ((await r.git.branchChanges(r.base, branch)).length) committed.push(r.name);
    }
    this.dispatch(s.taskId, { type: 'committed', repos: committed });
  }

  async publish(s: TaskState): Promise<void> {
    const config = this.config();
    const branch = branchName(s) as string;
    const taskDir = this.svc.dir(s.taskId);
    const all = taskRepos(this.workspace, s, config, s.repos.map((r) => r.name));
    const repos: TaskRepo[] = [];
    for (const r of all) if ((await r.git.branchChanges(r.base, branch)).length) repos.push(r);
    const prs = { ...s.prs };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pr-'));
    const bodyFile = (repo: string): string => {
      const f = path.join(tmp, `${repo}.md`);
      fs.writeFileSync(f, prBody(this.svc.state(s.taskId), repo, taskDir, config.language, prs));
      return f;
    };
    try {
      for (const r of repos) {
        if (prs[r.name]) continue;
        this.setLive(s.taskId, { phase: 'publishing', text: `Pushing ${r.name}` });
        const push = await r.git.git('push', '-u', 'origin', branch);
        if (push.code !== 0) throw new EngineError('push_failed', `${r.name}: ${push.stderr.trim()}`);
        // A retry after a partial failure (or a Stop mid-publish) finds the PR it already opened.
        const open = await exec('gh', ['pr', 'view', branch, '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url'], { cwd: r.dir, timeoutMs: 60000 });
        if (open.code === 0 && /^https?:\/\//.test(open.stdout.trim())) {
          prs[r.name] = open.stdout.trim();
          continue;
        }
        this.setLive(s.taskId, { phase: 'publishing', text: `Opening a draft PR in ${r.name}` });
        const pr = await exec('gh', ['pr', 'create', '--draft', '--base', r.base, '--head', branch, '--title', prTitle(s), '--body-file', bodyFile(r.name)], { cwd: r.dir, timeoutMs: 120000 });
        if (pr.code !== 0) throw new EngineError('pr_failed', `${r.name}: ${pr.stderr.trim() || pr.stdout.trim()}`);
        prs[r.name] = pr.stdout.trim().split('\n').reverse().find((l) => /^https?:\/\//.test(l.trim()))?.trim() || pr.stdout.trim();
      }
      // Every body lists the others, so link them once all exist.
      if (Object.keys(prs).length > 1) for (const r of repos) await exec('gh', ['pr', 'edit', prs[r.name]!, '--body-file', bodyFile(r.name)], { cwd: r.dir, timeoutMs: 120000 });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    this.dispatch(s.taskId, { type: 'published', prs });
    if (s.answers.some((a) => a.id === 'confirm-push' && a.option === 'push-comment')) {
      this.setLive(s.taskId, { phase: 'publishing', text: `Commenting on ${(s.source as Extract<Source, { kind: 'jira' }>).key}` });
      await this.comment(s, `Draft PRs, in merge order:\n\n${s.repos.filter((r) => prs[r.name]).map((r) => `${r.name}: ${prs[r.name]}`).join('\n')}`, 'prs');
    }
  }

  /** `report.md`: every readiness or audit agent's result in one document. */
  writeReport(taskId: string, language?: string): void {
    const text = renderReport(this.svc.state(taskId), language);
    if (text) this.svc.writeArtifact(taskId, TASK_FILES.report, text);
  }

  /**
   * Posts a comment on the task's Jira issue: over REST with an API token, else through the account's Atlassian MCP
   * server (a short session that may call only the add-comment tool). Never throws; the outcome is recorded as a
   * `jira_comment` event the task screen shows. `what`: plan, prs or report.
   */
  async comment(s: TaskState, text: string, what = 'note'): Promise<CommentResult> {
    if (s.source.kind !== 'jira') return { ok: false, error: 'the task is not a Jira issue' };
    const key = s.source.key;
    const client = this.atlassian();
    const via = client ? null : this.mcpIntake();
    const record = (r: CommentResult): CommentResult => {
      try {
        this.svc.record(s.taskId, { type: 'jira_comment', key, what, ok: r.ok, via: client ? 'api' : via ? `mcp:${via.server}` : 'none', ...(r.error && { error: r.error }), ...(r.id && { commentId: r.id }), text });
      } catch {
        // the task folder may be gone
      }
      if (!r.ok) this.log('warn', `Jira comment on ${key} failed: ${r.error}`, s.taskId);
      return r;
    };
    if (!client && !via) return record({ ok: false, error: 'Jira is not connected: sign in to an Atlassian MCP server (MCP tab) or add an API token (Settings → Jira & Confluence)' });
    try {
      if (client) return record({ ok: true, id: await client.addComment(key, text) });
      return record(await this.commentViaMcp(s, via!, text));
    } catch (e) {
      return record({ ok: false, error: (e as Error).message || String(e) });
    }
  }

  async commentViaMcp(s: TaskState, via: McpIntake, text: string): Promise<CommentResult> {
    const jira = s.source as Extract<Source, { kind: 'jira' }>;
    const key = jira.key;
    const site = jira.site || via.site;
    const n = this.svc.events(s.taskId).filter((e) => e.type === 'jira_comment').length + 1;
    const transcript = `comment-${n}`;
    const append = (item: TranscriptItem): void => {
      if (item.type !== 'text_delta' && item.type !== 'thinking' && item.type !== 'usage') this.svc.appendTranscript(s.taskId, transcript, { ...item, t: Date.now() });
    };
    const prompt = `Add one comment to the Jira issue ${key}${site ? ` on ${site}` : ''} with the "${via.server}" MCP server's tools. The comment body is everything between the two marker lines, verbatim:\n-----BEGIN COMMENT-----\n${text}\n-----END COMMENT-----`;
    append({ type: 'prompt', text: prompt });
    let posted = 0;
    const hook = this.hooks.register(async ({ tool }) => {
      if (tool === 'ToolSearch') return { allow: true };
      const action = tool.startsWith('mcp__') ? tool.split('__').pop() : '';
      if (action && MCP_COMMENT.test(action) && posted === 0) {
        posted += 1;
        return { allow: true };
      }
      if (action && MCP_READ.test(action)) return { allow: true };
      append({ type: 'blocked', tool, reason: 'a Jira comment session only posts that one comment' });
      return { allow: false, reason: posted ? 'Claudestrator: the comment is already posted; stop and report' : 'Claudestrator: only the add-comment and read tools are allowed here' };
    });
    const agent = { name: 'jira-comment', description: 'Posts one Jira comment', model: 'haiku', effort: 'low' as const, instructions: COMMENT_INSTRUCTIONS, output: 'plan' };
    const session = this.runner.start({ agent, prompt, cwd: this.workspace, additionalDirectories: [], env: hook.env, name: `claudestrator ${s.taskId} · Jira comment`, onOutput: append });
    let t: TurnResult = { ok: false, report: '' };
    let timer: NodeJS.Timeout | undefined;
    try {
      t = await Promise.race([session.turn(), new Promise<TurnResult>((resolve) => (timer = setTimeout(() => resolve({ ok: false, report: '', error: 'timed out' }), COMMENT_TIMEOUT_MS)))]);
      if (!t.ok) return { ok: false, error: CLAUDE_AUTH.test(t.error || '') ? 'Claude Code is signed out for this account' : `via ${via.server}: ${t.error || 'the agent failed'}` };
      const block = lastJsonBlock(t.report);
      const value = (block.ok ? block.value : null) as RawTicket | null;
      if (block.ok && value && value.error) return { ok: false, error: `via ${via.server}: ${value.error}` };
      if (!posted) return { ok: false, error: `via ${via.server}: no comment tool was called${block.ok ? '' : ` (${t.report.slice(0, 200)})`}` };
      return { ok: true, ...(block.ok && value && (value.commentId as string | undefined) && { id: String(value.commentId) }) };
    } finally {
      clearTimeout(timer);
      if (!t.ok) await session.interrupt();
      session.close();
      this.hooks.unregister(hook.token);
      const u: SessionUsage = session.usage ? session.usage() : {};
      this.svc.record(s.taskId, { type: 'agent_stopped', agent: 'jira-comment', payload: { costUsd: t.costUsd || session.costUsd || 0, turns: t.turns || session.turns || 0, sessionId: t.sessionId || session.sessionId, cwd: this.workspace, transcript, ...(u.model && { model: u.model }) } });
    }
  }

  /** Posts a finished readiness check or audit on the task's Jira issue. */
  async postReport(taskId: string): Promise<CommentResult> {
    const s = this.svc.state(taskId);
    if (!(s.reports || []).length) throw new EngineError('no_report', 'There is no report to post yet');
    if (s.source.kind !== 'jira') throw new EngineError('not_jira', 'This task did not come from a Jira issue');
    return this.comment(s, jiraText(s, this.config().language), 'report');
  }

  /** Posts a comment that failed again, with the same text. */
  async retryComment(taskId: string, seq: number): Promise<CommentResult> {
    const e = this.svc.events(taskId).find((x): x is EventOf<'jira_comment'> => x.type === 'jira_comment' && x.seq === seq);
    if (!e) throw new EngineError('no_comment', 'That comment is not in the task log');
    return this.comment(this.svc.state(taskId), e.text!, e.what);
  }

  // ---------- commands from the UI ----------

  /** Starts or resumes a task. */
  /**
   * Reshapes what is still to come in a task: `names` is the whole new order. Stages that ran keep their place;
   * an agent the task already has keeps its role, a new one comes from the config. A running task carries on with it.
   */
  editPipeline(taskId: string, names: string[]): { warnings: string[] } {
    const s = this.svc.state(taskId);
    if (editableFrom(s) === -1) throw new EngineError('pipeline_locked', 'The stages of this task are through; its pipeline can no longer change');
    const config = this.config();
    const agents: StageSource[] = names.map((name) => {
      const kept = s.pipeline.stages.find((st) => st.agent === name);
      // An agent the task has keeps its place and scope, also one from before a scope changed meaning.
      if (kept) return { name, output: kept.output, scope: kept.scope };
      const a = config.agents[name];
      if (!a) throw new EngineError('unknown_agent', `There is no agent "${name}"`);
      if (!fitsScenario(a.output, s.scenario)) throw new EngineError('wrong_scenario', `"${name}" writes a ${a.output} report and cannot join this task`);
      return { name, output: a.output, runs: a.runs };
    });
    const pipeline = taskPipeline(agents, { scenario: s.scenario, auto: s.auto, maxRounds: s.limits.reviewRounds });
    this.dispatch(taskId, { type: 'pipeline_changed', pipeline: { mode: pipeline.mode, stages: pipeline.stages, reviewLoop: pipeline.reviewLoop } });
    pipeline.warnings.forEach((w) => this.log('warn', w.message, taskId));
    return { warnings: pipeline.warnings.map((w) => w.message) };
  }

  resume(taskId: string): void {
    const s = this.svc.state(taskId);
    if (s.status === 'stopped') this.dispatch(taskId, { type: 'resumed' });
    this.launch(taskId);
  }

  async answer(taskId: string, checkpointId: string, option: string, feedback?: string): Promise<void> {
    let s = this.svc.state(taskId);
    if (s.status === 'stopped' && s.checkpoint) s = this.dispatch(taskId, { type: 'resumed' }).state;
    const r = this.dispatch(taskId, { type: 'checkpoint_answered', id: checkpointId, option, ...(feedback && { feedback }) });
    if (option === 'approve-post') {
      const ctx = await this.checkpointContext(s, s.checkpoint);
      this.comment(r.state, `Plan approved.\n\n${(ctx.text || '').slice(0, 20000)}`, 'plan');
    }
    if (r.state.status === 'active') this.launch(taskId);
  }

  sendMessage(taskId: string, text: string): void {
    const session = this.sessions.get(taskId);
    if (!session) throw new EngineError('no_agent', 'No agent is running for this task right now');
    session.send(text);
  }

  /** Stops the running agent (if any) and the task; resuming later re-runs the same step. */
  async stop(taskId: string, reason = 'stopped by you'): Promise<void> {
    const s = this.svc.state(taskId);
    if (s.status !== 'stopped' && s.status !== 'done') this.dispatch(taskId, { type: 'stopped', reason });
    this.denyPermissions(taskId, 'the task was stopped');
    const session = this.sessions.get(taskId);
    if (session) await session.interrupt();
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.running]) await this.stop(id, 'VS Code closed the workspace').catch(() => {});
  }

  /** What a human needs to decide a checkpoint: `{ format: 'markdown'|'log', text, files? }`. */
  async checkpointContext(s: TaskState, cp: Checkpoint | null): Promise<CheckpointContext> {
    if (!cp) return { format: 'markdown', text: '' };
    const read = (rel?: string): string => (rel ? this.svc.readArtifact(s.taskId, rel) : '');
    switch (cp.id) {
      case 'approve-plan': {
        const plans = s.artifacts.filter((a) => a.output === 'plan');
        const last = plans[plans.length - 1];
        return { format: 'markdown', text: read(last && last.path), file: last && last.path };
      }
      case 'review-limit':
        return {
          format: 'markdown',
          text: s.artifacts.filter((a) => a.output === 'verdict' && a.round === s.review.round).map((a) => read(a.path)).join('\n\n---\n\n'),
        };
      case 'gate-failure': {
        const gates = this.svc.events(s.taskId).filter((e): e is EventOf<'gates_ran'> => e.type === 'gates_ran');
        const g = gates[gates.length - 1];
        return { format: 'log', text: g ? g.summary : cp.reason || '' };
      }
      case 'confirm-push': {
        // Several git calls per repo, asked again on every refresh of the task screen; nothing they read changes while
        // the same question is open.
        const hit = this.pushContext.get(s.taskId);
        if (hit && hit.at === cp.at) return hit.value;
        const config = this.config();
        const parts: string[] = [];
        const repos: { name: string; branch: string | null; base: string; files: number; dir: string }[] = [];
        const branch = branchName(s) as string;
        for (const r of taskRepos(this.workspace, s, config, s.repos.map((x) => x.name))) {
          // What will be pushed is the task branch, whatever is checked out now.
          const files = await r.git.branchChanges(r.base, branch);
          const log = await r.git.git('--no-pager', 'log', '--stat', '--format=%h %s', `${await r.git.baseRef(r.base, branch)}..${branch}`);
          repos.push({ name: r.name, branch, base: r.base, files: files.length, dir: r.dir });
          parts.push(`${r.name} (${branch} → ${r.base})\n${log.stdout.trim() || 'no commits'}`);
        }
        const value: CheckpointContext = { format: 'log', text: parts.join('\n\n'), repos };
        this.pushContext.set(s.taskId, { at: cp.at, value });
        return value;
      }
      default:
        return { format: 'log', text: cp.reason || '' };
    }
  }

  async cleanup(taskId: string, force?: boolean) {
    const s = this.svc.state(taskId);
    return removeWorktrees(this.workspace, s, (loadConfig({ workspace: this.workspace }) as { config?: Config }).config || null, force);
  }

  async remove(taskId: string): Promise<void> {
    this.pushContext.delete(taskId);
    if (this.running.has(taskId)) await this.stop(taskId);
    this.svc.remove(taskId);
    this.errors.delete(taskId);
    this.emit('changed', taskId);
  }

  /** Runs one repo's gates on its current changes, outside any task. */
  async runGatesNow(repoName: string, force?: boolean) {
    const config = this.config();
    const repo = config.repos[repoName];
    if (!repo) throw new EngineError('unknown_repo', `no repo "${repoName}" in the config`);
    const dir = path.resolve(this.workspace, repo.path);
    return runGates({ repo, dir, logDir: path.join(this.workspace, '.orch', 'gates'), force });
  }

  async repoStatus() {
    const config = this.config();
    const out: RepoStatus[] = [];
    for (const repo of Object.values(config.repos)) {
      const dir = path.resolve(this.workspace, repo.path);
      const git = new GitRepo(dir);
      const isRepo = await git.isRepo();
      out.push({
        name: repo.name,
        dir,
        exists: fs.existsSync(dir),
        isRepo,
        ...(isRepo && { branch: await git.branch(), dirty: (await git.dirty()).length, last: await git.lastCommit(), sync: await git.aheadBehind(repo.baseBranch) }),
      });
    }
    return out;
  }
}

function summarizeInput(tool: string, input: Record<string, unknown>): unknown {
  if (!input || typeof input !== 'object') return input;
  if (tool === 'Bash') return { command: String(input.command || '').slice(0, 2000), ...((input.description as string | undefined) && { description: input.description }) };
  if (WRITE_TOOLS.has(tool)) return { file_path: input.file_path || input.notebook_path || input.path };
  const json = JSON.stringify(input);
  return json.length > 2000 ? { preview: `${json.slice(0, 2000)}…` } : input;
}

/** What the composer sends: the text, the options beside it, and the scenario picked. */
/** What a human needs to decide a checkpoint. */
export type { CheckpointContext, ComposerArgs, EngineOptions, Live, McpIntake, PermissionRequest };
export { Engine, EngineError, stepLabel, transcriptKey, realInside, CLAUDE_AUTH };
