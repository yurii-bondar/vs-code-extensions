// The engine: drives tasks through the state machine, runs each agent as a Claude Code session, runs gates,
// commits, pushes and opens draft PRs. Independent of VS Code; the extension listens to its events.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { loadConfig } = require('./config');
const { EFFORTS, SCENARIOS } = require('./protocol');
const { buildPipeline } = require('./pipeline');
const { nextAction, runOf, artifactPath, branchName, sameStep, TASK_FILES } = require('./machine');
const { parseInvocation, classifyInput, detectScenario, runIntake, renderTicket, IntakeError, extractAcceptanceCriteria } = require('./intake');
const { TaskService } = require('./store');
const { exec, GitRepo, branchSync, taskRepos, prepareRepos, taskDiff, removeWorktrees } = require('./git');
const { runGates } = require('./gates');
const { guardBash } = require('./guard');
const { buildAgentPrompt, parseStageReport, lastJsonBlock } = require('./prompt');
const { commitSubject, prTitle, prBody } = require('./pr');
const { renderReport, jiraText } = require('./report');

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
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const stepLabel = (s) => (s.repo ? `${s.agent} @ ${s.repo}` : s.agent);
const transcriptKey = (seq, step) => `${String(seq).padStart(4, '0')}-${step.agent}${step.repo ? `-${step.repo.replace(/[^A-Za-z0-9._-]/g, '_')}` : ''}`;

function realInside(root, target) {
  const real = (p) => {
    let cur = path.resolve(p);
    const rest = [];
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
  /** opts: { workspace, home?, runner, hooks, atlassian(): client|null, askPermissions(): boolean, now? } */
  constructor(opts) {
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
  config(flags) {
    const r = loadConfig({ workspace: this.workspace, ...(this.home && { home: this.home }), flags });
    if (!r.ok) throw new EngineError('config_invalid', r.errors.map((e) => e.message).join('\n'));
    return r.config;
  }

  log(level, message, taskId) {
    this.emit('log', { level, message, ...(taskId && { taskId }) });
  }

  setLive(taskId, live) {
    // The clock runs per step: gates, report fixes and permission prompts of the same step keep it going.
    const prev = this.lives.get(taskId);
    const same = live && prev && (live.key ? prev.key === live.key : prev.phase === live.phase);
    if (live) this.lives.set(taskId, { ...live, since: same ? prev.since : Date.now() });
    else this.lives.delete(taskId);
    this.emit('live', { taskId, live: this.lives.get(taskId) || null });
  }

  live(taskId) {
    return this.lives.get(taskId) || null;
  }

  dispatch(taskId, body) {
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
  resolveScenario(inv, scenario, config) {
    const explicit = scenario && scenario !== 'auto' ? scenario : inv.scenario;
    if (explicit && !SCENARIOS.includes(explicit)) throw new EngineError('bad_scenario', `scenario "${explicit}" is not one of ${SCENARIOS.join(', ')}`);
    const chosen = explicit || detectScenario(inv.input);
    const input = inv.input || inv.key || '';
    const source = classifyInput(input, { embedded: chosen === 'readiness', projects: config.jira.allowedProjects });
    return { scenario: chosen, detected: !explicit && chosen !== 'deliver', source };
  }

  /** What a composer input would do, without creating anything. */
  preview({ text = '', auto = false, no = [], key, effort = {}, scenario } = {}) {
    let inv;
    try {
      inv = parseInvocation(text);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const input = inv.input;
    if (!input && !(key || inv.key)) return { ok: true, empty: true };
    const flags = { no: [...new Set([...(inv.flags.no || []), ...no])], ...(inv.flags.only && { only: inv.flags.only }) };
    const r = loadConfig({ workspace: this.workspace, ...(this.home && { home: this.home }), flags });
    if (!r.ok) return { ok: false, error: r.errors.map((e) => e.message).join('\n') };
    let sc;
    try {
      sc = this.resolveScenario({ ...inv, input: input || key || inv.key }, scenario, r.config);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const source = sc.source;
    const pipeline = buildPipeline(r.config, { auto: auto || inv.auto, scenario: sc.scenario });
    const { taskId, exists } = this.svc.idFor({ taskId: key || inv.key, source, scenario: sc.scenario });
    let problem;
    if (source.kind === 'jira') {
      const allowed = r.config.jira.allowedProjects;
      const project = source.key.split('-')[0];
      if (allowed.length && !allowed.includes(project)) problem = `Jira project ${project} is not allowed here (allowed: ${allowed.join(', ')})`;
    }
    if (pipeline.stages.length === 0) problem = problem || (sc.scenario === 'deliver' ? 'every agent is switched off' : `no agent is on for the ${sc.scenario} scenario`);
    let taskEffort = {};
    try {
      taskEffort = this.effortFor(r.config, pipeline, inv.effort, effort);
    } catch (e) {
      problem = problem || e.message;
    }
    return { ok: true, source, taskId, exists, scenario: sc.scenario, scenarioDetected: sc.detected, pipeline, effort: taskEffort, warnings: [...r.warnings, ...pipeline.warnings].map((w) => w.message), ...(problem && { problem }) };
  }

  /**
   * Merges `--effort` from the text with the composer's per-agent choices into `{ agent: level }` for the task's
   * enabled agents. `*` applies to every one of them; a named agent wins over `*`.
   */
  effortFor(config, pipeline, fromText = {}, fromUi = {}) {
    const merged = { ...fromText, ...fromUi };
    const out = {};
    const agents = pipeline.stages.map((s) => s.agent);
    for (const [name, level] of Object.entries(merged)) {
      if (!level) continue;
      if (!EFFORTS.includes(level)) throw new EngineError('bad_effort', `effort "${level}" is not one of ${EFFORTS.join(', ')}`);
      if (name !== '*' && !config.agents[name]) throw new EngineError('bad_effort', `--effort names unknown agent "${name}"`);
    }
    if (merged['*']) for (const a of agents) out[a] = merged['*'];
    for (const [name, level] of Object.entries(merged)) if (name !== '*' && level && agents.includes(name)) out[name] = level;
    return out;
  }

  start({ text = '', auto = false, no = [], key, effort = {}, scenario } = {}) {
    const inv = parseInvocation(text);
    if (!inv.input && !(key || inv.key)) throw new EngineError('no_input', 'Describe the task, or paste a Jira key or a Confluence link');
    const flags = { no: [...new Set([...(inv.flags.no || []), ...no])], ...(inv.flags.only && { only: inv.flags.only }) };
    const config = this.config(flags);
    const sc = this.resolveScenario({ ...inv, input: inv.input || key || inv.key }, scenario, config);
    const source = sc.source;
    if (source.kind === 'jira') {
      const allowed = config.jira.allowedProjects;
      const project = source.key.split('-')[0];
      if (allowed.length && !allowed.includes(project)) throw new EngineError('project_not_allowed', `Jira project ${project} is not allowed (allowed: ${allowed.join(', ')})`);
    }
    const isAuto = auto || inv.auto;
    const pipeline = buildPipeline(config, { auto: isAuto, scenario: sc.scenario });
    if (pipeline.stages.length === 0) throw new EngineError('empty_pipeline', sc.scenario === 'deliver' ? 'Every agent is switched off; turn at least one on' : `No agent is on for the ${sc.scenario} scenario; turn one on in Agents`);
    const taskEffort = this.effortFor(config, pipeline, inv.effort, effort);
    const extra = [...(no.length ? [`--no ${no.join(',')}`] : []), ...(auto && !inv.auto ? ['--auto'] : []), ...(scenario && scenario !== 'auto' && !inv.scenario ? [`--scenario ${scenario}`] : [])].join(' ');
    const started = this.svc.start({
      input: extra ? `${text.trim()} ${extra}` : text.trim(),
      source,
      scenario: sc.scenario,
      auto: isAuto,
      pipeline,
      config,
      effort: taskEffort,
      ...((key || inv.key) && { taskId: key || inv.key }),
    });
    this.svc.setCurrent(started.taskId);
    pipeline.warnings.forEach((w) => this.log('warn', w.message, started.taskId));
    return { taskId: started.taskId, created: started.created };
  }

  isRunning(taskId) {
    return this.running.has(taskId);
  }

  lastError(taskId) {
    return this.errors.get(taskId) || null;
  }

  /** Runs in the background and reports failures as events instead of throwing. */
  launch(taskId) {
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
  checkExclusive(taskId) {
    const s = this.svc.state(taskId);
    const touchesRepos = (st) => st.gitMode === 'branch' && st.pipeline.stages.some((x) => x.scope === 'repo');
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
  async run(taskId) {
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

  async intake(s) {
    this.setLive(s.taskId, { phase: 'intake', text: s.source.kind === 'text' ? 'Writing the ticket' : `Reading ${s.source.kind === 'jira' ? s.source.key : 'the Confluence page'}` });
    let spec;
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
  emitter(taskId, key) {
    return (item) => {
      const stamped = { ...item, t: Date.now() };
      if (item.type === 'usage') this.liveUsage.set(taskId, { ...stamped, key });
      else if (item.type !== 'text_delta' && item.type !== 'thinking') this.svc.appendTranscript(taskId, key, stamped);
      if (item.type === 'turn_end') this.liveCost.set(taskId, item.costUsd || 0);
      this.emit('output', { taskId, key, item: stamped });
    };
  }

  /**
   * Reads a Jira issue or Confluence page through an Atlassian MCP server signed in with Claude Code (no API token):
   * a short read-only agent session that hands back the ticket as JSON.
   */
  async intakeViaMcp(s, via) {
    const src = s.source;
    if (src.kind === 'jira') {
      const allowed = this.config().jira.allowedProjects;
      const project = src.key.split('-')[0];
      if (allowed.length && !allowed.includes(project)) throw new EngineError('project_not_allowed', `Jira project ${project} is not allowed (allowed: ${allowed.join(', ')})`);
    }
    const what = src.kind === 'jira' ? `the Jira issue ${src.key}${src.site || via.site ? ` on ${src.site || via.site}` : ''}` : `the Confluence page ${src.url}`;
    const prompt = `Read ${what} using the "${via.server}" MCP server's tools and write the ticket as your instructions say.`;
    const emitItem = this.emitter(s.taskId, INTAKE_KEY);
    emitItem({ type: 'prompt', text: prompt });
    const agent = { name: 'intake', description: 'Reads the task source', model: 'haiku', effort: 'low', instructions: INTAKE_INSTRUCTIONS, output: 'plan' };
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
    let t = { ok: false, report: '' };
    try {
      t = await session.turn();
      let parsed = null;
      for (let i = 0; ; i++) {
        if (this.svc.state(s.taskId).status === 'stopped') throw new EngineError('stopped', 'stopped');
        if (!t.ok && CLAUDE_AUTH.test(t.error || '')) throw new EngineError('claude_login', `Claude Code is signed out for this account (${t.error}). Sign in again, or switch the account.`);
        if (!t.ok) throw new EngineError('fetch_failed', `reading ${src.kind === 'jira' ? src.key : 'the page'} via ${via.server} failed: ${t.error || 'the agent failed'}`);
        const block = lastJsonBlock(t.report);
        if (block.ok && block.value && block.value.error) throw new EngineError('fetch_failed', `could not read ${src.kind === 'jira' ? src.key : 'the page'} via ${via.server}: ${block.value.error}`);
        if (block.ok && block.value && typeof block.value.title === 'string' && block.value.title.trim()) {
          parsed = block.value;
          break;
        }
        if (i >= 1) throw new EngineError('fetch_failed', `could not read ${src.kind === 'jira' ? src.key : 'the page'} via ${via.server}: ${block.ok ? 'the reply has no title' : block.error}. ${t.report.slice(0, 300)}`);
        session.send(`I need the ticket as the fenced json block your instructions describe (with a title). ${block.ok ? '' : block.error}`, { from: 'orchestrator' });
        t = await session.turn();
      }
      const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
      const description = String(parsed.description || '');
      const links = (Array.isArray(parsed.links) ? parsed.links : []).filter((l) => l && l.url).map((l) => ({ title: String(l.title || l.url), url: String(l.url) }));
      if (parsed.url) links.unshift({ title: src.kind === 'jira' ? src.key : String(parsed.title), url: String(parsed.url) });
      return {
        id: s.taskId,
        source: src,
        title: String(parsed.title).trim(),
        description,
        acceptanceCriteria: list(parsed.acceptanceCriteria).length ? list(parsed.acceptanceCriteria) : extractAcceptanceCriteria(description),
        links,
        ...(parsed.context && String(parsed.context).trim() && { context: String(parsed.context).trim() }),
      };
    } finally {
      session.close();
      this.sessions.delete(s.taskId);
      this.hooks.unregister(hook.token);
      this.liveUsage.delete(s.taskId);
      this.liveCost.delete(s.taskId);
      const u = session.usage ? session.usage() : {};
      this.svc.record(s.taskId, { type: 'agent_stopped', agent: 'intake', payload: { costUsd: t.costUsd || session.costUsd || 0, turns: t.turns || session.turns || 0, sessionId: t.sessionId || session.sessionId, cwd: this.workspace, transcript: INTAKE_KEY, ...(u.model && { model: u.model }), ...(u.effort && { effort: u.effort }) } });
    }
  }

  spentUsd(taskId) {
    let total = 0;
    for (const e of this.svc.events(taskId)) if (e.type === 'agent_stopped') total += Number((e.payload && e.payload.costUsd) || 0);
    return total;
  }

  async runStep(s, next) {
    const taskId = s.taskId;
    const step = next.step;
    const config = this.config();
    const taskDir = this.svc.dir(taskId);
    const stage = s.pipeline.stages[step.stage];
    const configured = config.agents[step.agent];
    // The task's own effort for this agent wins over the configured one.
    const override = s.effort && s.effort[step.agent];
    const agent = configured && override ? { ...configured, effort: override } : configured;
    const label = stepLabel(step);

    const budget = config.limits.budgetUsd;
    const spent = budget !== undefined ? this.spentUsd(taskId) : 0;
    if (budget !== undefined && spent >= budget) {
      this.log('warn', `Budget of $${budget} spent ($${spent.toFixed(2)}); the task stopped`, taskId);
      this.dispatch(taskId, { type: 'stopped', reason: `budget of $${budget} spent` });
      return;
    }

    let repoDir;
    if (step.repo) {
      if (!this.prepared.has(taskId)) {
        this.setLive(taskId, { phase: 'preparing', step, text: `Preparing branch ${branchName(s)}` });
        const p = await prepareRepos(this.workspace, s, config);
        if (!p.ok) throw new EngineError(p.code, `${p.error}${p.blocked ? `: ${p.blocked.map((b) => `${b.repo} (${b.problem})`).join(', ')}` : ''}`, { blocked: p.blocked });
        this.prepared.add(taskId);
      }
      repoDir = taskRepos(this.workspace, s, config, [step.repo])[0].dir;
    }

    let diffPath;
    if (stage.output === 'verdict' && s.repos.length) {
      this.setLive(taskId, { phase: 'preparing', step, text: 'Collecting the diff for review' });
      const diff = await taskDiff(taskRepos(this.workspace, s, config, s.repos.map((r) => r.name)));
      diffPath = this.svc.writeArtifact(taskId, `reviews/r${s.review.round}/diff.patch`, diff.text);
    }

    let seq;
    if (next.kind === 'run') seq = this.dispatch(taskId, { type: 'stage_started', agent: step.agent, ...(step.repo && { repo: step.repo }) }).event.seq;
    else {
      const started = this.svc.events(taskId).filter((e) => e.type === 'stage_started' && sameStep(e, step));
      seq = started.length ? started[started.length - 1].seq : 0;
    }
    const key = transcriptKey(seq, step);
    const fail = (error) => this.dispatch(taskId, { type: 'stage_failed', agent: step.agent, ...(step.repo && { repo: step.repo }), error });

    if (!agent || !agent.enabled) {
      fail(`agent "${step.agent}" is no longer enabled in the config`);
      return;
    }

    const state = this.svc.state(taskId);
    const run = next.kind === 'run' ? next : runOf(state, step);
    // Readiness and audit agents read every configured repo where it is, also outside the workspace folder.
    const readRepos = REPORT_OUTPUTS.has(stage.output) ? Object.values(config.repos).map((r) => ({ name: r.name, dir: path.resolve(this.workspace, r.path), baseBranch: r.baseBranch, ...(r.role && { role: r.role }) })) : [];
    const prompt = buildAgentPrompt({ state, next: run, taskDir, language: config.language, ...(repoDir && { repoDir }), ...(diffPath && { diffPath }), ...(readRepos.length && { repos: readRepos }) });
    const cwd = repoDir || this.workspace;
    const emitItem = this.emitter(taskId, key);
    if (next.kind === 'run') emitItem({ type: 'prompt', text: prompt });

    const writeRoot = stage.scope === 'repo' ? repoDir : undefined;
    const hook = this.hooks.register((call) => this.decide({ taskId, step, writeRoot, config, call, emitItem }));
    const session = this.runner.start({
      agent,
      prompt,
      cwd,
      additionalDirectories: [...new Set([taskDir, this.workspace, ...readRepos.map((r) => r.dir).filter((d) => fs.existsSync(d))])].filter((d) => !realInside(cwd, d)),
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

    let t = { ok: false, report: '' };
    const stopped = () => this.svc.state(taskId).status === 'stopped';
    try {
      t = await session.turn();
      if (stopped()) return;
      if (!t.ok) return void fail(t.error || 'the agent failed');

      let gates = 'none';
      const repoCfg = step.repo ? config.repos[step.repo] : undefined;
      if (stage.scope === 'repo' && repoCfg && repoDir && repoCfg.gates.length) {
        for (let attempt = 1; ; attempt++) {
          this.setLive(taskId, { phase: 'gates', step, key, text: `Running gates in ${step.repo}` });
          const g = await runGates({
            repo: repoCfg,
            dir: repoDir,
            logDir: path.join(taskDir, 'gates', `r${state.review.round}`),
            onGate: (name) => this.setLive(taskId, { phase: 'gates', step, key, text: `Gate "${name}" in ${step.repo} (attempt ${attempt})` }),
          });
          if (stopped()) return;
          this.svc.record(taskId, { type: 'gates_ran', agent: step.agent, repo: step.repo, status: g.status, attempt, summary: g.summary });
          emitItem({ type: 'gates', status: g.status, attempt, summary: g.summary, results: g.results.map(({ gate, status, ms }) => ({ gate, status, ms })) });
          if (g.status !== 'fail') {
            gates = g.status === 'pass' ? 'pass' : 'none';
            break;
          }
          if (attempt >= config.limits.gateAttempts) {
            gates = 'fail';
            break;
          }
          session.send(`Gates failed in ${step.repo} (attempt ${attempt} of ${config.limits.gateAttempts}). Fix the causes below. Do not weaken, skip or delete tests or lint rules. Then reply with your full report again.\n\n${g.summary}`, { from: 'orchestrator' });
          this.setLive(taskId, { phase: 'agent', step, key, text: `${label} is fixing red gates` });
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
      const u = session.usage ? session.usage() : {};
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
  async decide({ taskId, step, writeRoot, config, call, emitItem }) {
    const { tool, input } = call;
    const blocked = (reason) => {
      emitItem({ type: 'blocked', tool, reason, input: summarizeInput(tool, input) });
      return { allow: false, reason: `Claudestrator: ${reason}` };
    };
    if (READ_TOOLS.has(tool)) return { allow: true };
    const cwd = writeRoot || this.workspace;
    if (tool === 'Bash') {
      const d = guardBash(String(input.command || ''), {
        policy: config.policy,
        cwd: call.cwd && fs.existsSync(call.cwd) ? call.cwd : cwd,
        workspace: this.workspace,
        repoDirs: Object.values(config.repos).map((r) => path.resolve(this.workspace, r.path)),
        ...(this.home && { home: this.home }),
        task: { taskId, canPush: false },
        agent: true,
        branchOf: branchSync,
        isRepoRoot: (dir) => fs.existsSync(path.join(dir, '.git')),
        readFile: (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null),
      });
      if (!d.allow) return blocked(d.reason);
    }
    if (WRITE_TOOLS.has(tool)) {
      const target = String(input.file_path || input.notebook_path || input.path || '');
      if (!writeRoot) return blocked(`the ${step.agent} stage does not change files`);
      if (!target || !realInside(writeRoot, path.resolve(writeRoot, target))) return blocked(`${tool} outside ${writeRoot} is not allowed: this stage works only in ${step.repo}`);
    }
    if (!this.askPermissions()) return { allow: true };
    const requestId = crypto.randomUUID();
    const request = { requestId, taskId, agent: step.agent, ...(step.repo && { repo: step.repo }), tool, input: summarizeInput(tool, input), at: Date.now() };
    const prev = this.live(taskId);
    this.setLive(taskId, { ...(prev || {}), phase: 'permission', step, text: `${stepLabel(step)} asks to use ${tool}` });
    this.emit('changed', taskId);
    const answer = await new Promise((resolve) => {
      this.permissions.set(requestId, { request, resolve });
      this.emit('permission', request);
    });
    if (prev) this.setLive(taskId, prev);
    return answer.allow ? { allow: true } : { allow: false, reason: answer.message || 'denied by the user' };
  }

  pendingPermissions(taskId) {
    return [...this.permissions.values()].map((p) => p.request).filter((r) => !taskId || r.taskId === taskId);
  }

  permissionReply(requestId, allow, message) {
    const p = this.permissions.get(requestId);
    if (!p) return false;
    this.permissions.delete(requestId);
    p.resolve({ allow, ...(message && { message }) });
    this.emit('permissionDone', requestId);
    return true;
  }

  denyPermissions(taskId, message) {
    for (const [id, p] of this.permissions) if (p.request.taskId === taskId) this.permissionReply(id, false, message);
  }

  // ---------- finishing ----------

  async commit(s) {
    this.setLive(s.taskId, { phase: 'committing', text: 'Committing' });
    const config = this.config();
    const subject = commitSubject(s);
    const body = s.source.kind === 'jira' ? `Refs: ${s.taskId}` : '';
    const committed = [];
    for (const r of taskRepos(this.workspace, s, config, s.repos.map((x) => x.name))) {
      if (!(await r.git.isRepo())) continue;
      if ((await r.git.dirty()).length) {
        await r.git.addAll();
        const c = await r.git.git('commit', '-m', subject, ...(body ? ['-m', body] : []));
        if (c.code !== 0) {
          this.dispatch(s.taskId, { type: 'commit_failed', repo: r.name, output: `${c.stdout}${c.stderr}`.trim().slice(-8000) });
          return;
        }
      }
      if ((await r.git.changedFiles(r.base)).length) committed.push(r.name);
    }
    this.dispatch(s.taskId, { type: 'committed', repos: committed });
  }

  async publish(s) {
    const config = this.config();
    const branch = branchName(s);
    const taskDir = this.svc.dir(s.taskId);
    const all = taskRepos(this.workspace, s, config, s.repos.map((r) => r.name));
    const repos = [];
    for (const r of all) if ((await r.git.changedFiles(r.base)).length) repos.push(r);
    const prs = { ...s.prs };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pr-'));
    const bodyFile = (repo) => {
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
        this.setLive(s.taskId, { phase: 'publishing', text: `Opening a draft PR in ${r.name}` });
        const pr = await exec('gh', ['pr', 'create', '--draft', '--base', r.base, '--head', branch, '--title', prTitle(s), '--body-file', bodyFile(r.name)], { cwd: r.dir, timeoutMs: 120000 });
        if (pr.code !== 0) throw new EngineError('pr_failed', `${r.name}: ${pr.stderr.trim() || pr.stdout.trim()}`);
        prs[r.name] = pr.stdout.trim().split('\n').reverse().find((l) => /^https?:\/\//.test(l.trim()))?.trim() || pr.stdout.trim();
      }
      // Every body lists the others, so link them once all exist.
      if (Object.keys(prs).length > 1) for (const r of repos) await exec('gh', ['pr', 'edit', prs[r.name], '--body-file', bodyFile(r.name)], { cwd: r.dir, timeoutMs: 120000 });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    this.dispatch(s.taskId, { type: 'published', prs });
    if (s.answers.some((a) => a.id === 'confirm-push' && a.option === 'push-comment')) {
      this.setLive(s.taskId, { phase: 'publishing', text: `Commenting on ${s.source.key}` });
      await this.comment(s, `Draft PRs, in merge order:\n\n${s.repos.filter((r) => prs[r.name]).map((r) => `${r.name}: ${prs[r.name]}`).join('\n')}`, 'prs');
    }
  }

  /** `report.md`: every readiness or audit agent's result in one document. */
  writeReport(taskId, language) {
    const text = renderReport(this.svc.state(taskId), language);
    if (text) this.svc.writeArtifact(taskId, TASK_FILES.report, text);
  }

  /**
   * Posts a comment on the task's Jira issue: over REST with an API token, else through the account's Atlassian MCP
   * server (a short session that may call only the add-comment tool). Never throws; the outcome is recorded as a
   * `jira_comment` event the task screen shows. `what`: plan, prs or report.
   */
  async comment(s, text, what = 'note') {
    if (s.source.kind !== 'jira') return { ok: false, error: 'the task is not a Jira issue' };
    const key = s.source.key;
    const client = this.atlassian();
    const via = client ? null : this.mcpIntake();
    const record = (r) => {
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
      return record(await this.commentViaMcp(s, via, text));
    } catch (e) {
      return record({ ok: false, error: e.message || String(e) });
    }
  }

  async commentViaMcp(s, via, text) {
    const key = s.source.key;
    const site = s.source.site || via.site;
    const n = this.svc.events(s.taskId).filter((e) => e.type === 'jira_comment').length + 1;
    const transcript = `comment-${n}`;
    const append = (item) => {
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
    const agent = { name: 'jira-comment', description: 'Posts one Jira comment', model: 'haiku', effort: 'low', instructions: COMMENT_INSTRUCTIONS, output: 'plan' };
    const session = this.runner.start({ agent, prompt, cwd: this.workspace, additionalDirectories: [], env: hook.env, name: `claudestrator ${s.taskId} · Jira comment`, onOutput: append });
    let t = { ok: false, report: '' };
    let timer;
    try {
      t = await Promise.race([session.turn(), new Promise((resolve) => (timer = setTimeout(() => resolve({ ok: false, report: '', error: 'timed out' }), COMMENT_TIMEOUT_MS)))]);
      if (!t.ok) return { ok: false, error: CLAUDE_AUTH.test(t.error || '') ? 'Claude Code is signed out for this account' : `via ${via.server}: ${t.error || 'the agent failed'}` };
      const block = lastJsonBlock(t.report);
      if (block.ok && block.value && block.value.error) return { ok: false, error: `via ${via.server}: ${block.value.error}` };
      if (!posted) return { ok: false, error: `via ${via.server}: no comment tool was called${block.ok ? '' : ` (${t.report.slice(0, 200)})`}` };
      return { ok: true, ...(block.ok && block.value && block.value.commentId && { id: String(block.value.commentId) }) };
    } finally {
      clearTimeout(timer);
      if (!t.ok) await session.interrupt();
      session.close();
      this.hooks.unregister(hook.token);
      const u = session.usage ? session.usage() : {};
      this.svc.record(s.taskId, { type: 'agent_stopped', agent: 'jira-comment', payload: { costUsd: t.costUsd || session.costUsd || 0, turns: t.turns || session.turns || 0, sessionId: t.sessionId || session.sessionId, cwd: this.workspace, transcript, ...(u.model && { model: u.model }) } });
    }
  }

  /** Posts a finished readiness check or audit on the task's Jira issue. */
  async postReport(taskId) {
    const s = this.svc.state(taskId);
    if (!(s.reports || []).length) throw new EngineError('no_report', 'There is no report to post yet');
    if (s.source.kind !== 'jira') throw new EngineError('not_jira', 'This task did not come from a Jira issue');
    return this.comment(s, jiraText(s, this.config().language), 'report');
  }

  /** Posts a comment that failed again, with the same text. */
  async retryComment(taskId, seq) {
    const e = this.svc.events(taskId).find((x) => x.type === 'jira_comment' && x.seq === seq);
    if (!e) throw new EngineError('no_comment', 'That comment is not in the task log');
    return this.comment(this.svc.state(taskId), e.text, e.what);
  }

  // ---------- commands from the UI ----------

  /** Starts or resumes a task. */
  resume(taskId) {
    const s = this.svc.state(taskId);
    if (s.status === 'stopped') this.dispatch(taskId, { type: 'resumed' });
    this.launch(taskId);
  }

  async answer(taskId, checkpointId, option, feedback) {
    let s = this.svc.state(taskId);
    if (s.status === 'stopped' && s.checkpoint) s = this.dispatch(taskId, { type: 'resumed' }).state;
    const r = this.dispatch(taskId, { type: 'checkpoint_answered', id: checkpointId, option, ...(feedback && { feedback }) });
    if (option === 'approve-post') {
      const ctx = await this.checkpointContext(s, s.checkpoint);
      this.comment(r.state, `Plan approved.\n\n${(ctx.text || '').slice(0, 20000)}`, 'plan');
    }
    if (r.state.status === 'active') this.launch(taskId);
  }

  sendMessage(taskId, text) {
    const session = this.sessions.get(taskId);
    if (!session) throw new EngineError('no_agent', 'No agent is running for this task right now');
    session.send(text);
  }

  /** Stops the running agent (if any) and the task; resuming later re-runs the same step. */
  async stop(taskId, reason = 'stopped by you') {
    const s = this.svc.state(taskId);
    if (s.status !== 'stopped' && s.status !== 'done') this.dispatch(taskId, { type: 'stopped', reason });
    this.denyPermissions(taskId, 'the task was stopped');
    const session = this.sessions.get(taskId);
    if (session) await session.interrupt();
  }

  async stopAll() {
    for (const id of [...this.running]) await this.stop(id, 'VS Code closed the workspace').catch(() => {});
  }

  /** What a human needs to decide a checkpoint: `{ format: 'markdown'|'log', text, files? }`. */
  async checkpointContext(s, cp) {
    if (!cp) return { format: 'markdown', text: '' };
    const read = (rel) => (rel ? this.svc.readArtifact(s.taskId, rel) : '');
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
        const gates = this.svc.events(s.taskId).filter((e) => e.type === 'gates_ran');
        const g = gates[gates.length - 1];
        return { format: 'log', text: g ? g.summary : cp.reason || '' };
      }
      case 'confirm-push': {
        const config = this.config();
        const parts = [];
        const repos = [];
        for (const r of taskRepos(this.workspace, s, config, s.repos.map((x) => x.name))) {
          const files = await r.git.changedFiles(r.base);
          const log = await r.git.git('--no-pager', 'log', '--stat', '--format=%h %s', `${await r.git.baseRef(r.base)}..HEAD`);
          repos.push({ name: r.name, branch: await r.git.branch(), base: r.base, files: files.length, dir: r.dir });
          parts.push(`${r.name} (${await r.git.branch()} → ${r.base})\n${log.stdout.trim() || 'no commits'}`);
        }
        return { format: 'log', text: parts.join('\n\n'), repos };
      }
      default:
        return { format: 'log', text: cp.reason || '' };
    }
  }

  async cleanup(taskId, force) {
    const s = this.svc.state(taskId);
    return removeWorktrees(this.workspace, s, loadConfig({ workspace: this.workspace }).config || null, force);
  }

  async remove(taskId) {
    if (this.running.has(taskId)) await this.stop(taskId);
    this.svc.remove(taskId);
    this.errors.delete(taskId);
    this.emit('changed', taskId);
  }

  /** Runs one repo's gates on its current changes, outside any task. */
  async runGatesNow(repoName, force) {
    const config = this.config();
    const repo = config.repos[repoName];
    if (!repo) throw new EngineError('unknown_repo', `no repo "${repoName}" in the config`);
    const dir = path.resolve(this.workspace, repo.path);
    return runGates({ repo, dir, logDir: path.join(this.workspace, '.orch', 'gates'), force });
  }

  async repoStatus() {
    const config = this.config();
    const out = [];
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

function summarizeInput(tool, input) {
  if (!input || typeof input !== 'object') return input;
  if (tool === 'Bash') return { command: String(input.command || '').slice(0, 2000), ...(input.description && { description: input.description }) };
  if (WRITE_TOOLS.has(tool)) return { file_path: input.file_path || input.notebook_path || input.path };
  const json = JSON.stringify(input);
  return json.length > 2000 ? { preview: `${json.slice(0, 2000)}…` } : input;
}

module.exports = { Engine, EngineError, stepLabel, transcriptKey, realInside, CLAUDE_AUTH };
