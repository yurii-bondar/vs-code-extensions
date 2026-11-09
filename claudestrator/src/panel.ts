// The dashboard webview: one panel, routed inside (home, task, agents, repos, settings, setup).
// The page asks with `{ type: 'req', id, method, params }`; pushes are `changed`, `output`, `live`, `permission`, `toast`.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import * as view from './core/view';
import type { OutputPush } from './core/view';
import { exists } from './core/files';
import * as cfg from './core/config';
import * as backups from './core/backup';
import * as libraries from './core/library';
import { buildPipeline, fixedFlow, outline, scenarioPipeline, taskPipeline, fitsScenario } from './core/pipeline';
import { editableFrom } from './core/machine';
import { flowOf } from './core/flow';
import { taskRepos, taskDiff, launch, getChildEnv } from './core/git';
import { findRepos, describeRepo, reposFromFolders, repoLayerOf, WORKSPACE_MAP, safeName } from './core/setup';
import { expand } from './core/env';
import { effectiveFor } from './core/defaults';
import { AGENT_COLORS, OUTPUTS, EFFORTS, validateSetting } from './core/protocol';
import { parsePageRequest, openable, SESSION_ID } from './core/requests';
import { fixProblem, fixableCheckpoint, fixDirs, fixPrompt, fixArgs } from './core/fix';
import { settings, type Orchestrator } from './orchestrator';
import type { Engine } from './core/engine';
import type { BlockedRepo, ComposerArgs, ConfigData, HostMessage, ConfigSummary, HealthSummary, NewAgentParams, PipelineEdit, Preview, ReposData, Route, Rpc, RpcHandlers, SaveGroupParams, SaveInstructionParams, SaveScenarioParams, SettingsData, SetupParams, TaskScreen } from './core/wire';
import type { Agent, Effort, ScenarioStep, Gate, TaskState } from './core/types';
import type { ConfigLayer, RepoLayer } from './core/config';

/** A repo as the page sends it back from the setup wizard or the detected list. */
interface PickedRepo {
  name: string;
  path: string;
  role?: string | undefined;
  baseBranch?: string | undefined;
  gates?: Gate[] | undefined;
}

type Handler = (params: unknown) => Promise<unknown>;

/** How often streamed agent output goes to the page. */
const OUTPUT_MS = 50;
/**
 * The dashboard's scripts, in the order they load: each uses what the ones before it put on the page (task.js the
 * transcript of stream.js, diagram.js the draft, canvas and right column of the three diagram-*.js before it). The JetBrains plugin builds its page from the same files (PageHtml.kt, `SCRIPTS`), and the
 * release script checks that it lists these, in this order.
 */
const PAGE_SCRIPTS = ['markdown.js', 'stream.js', 'app.js', 'task.js', 'diagram-model.js', 'diagram-canvas.js', 'diagram-side.js', 'diagram.js', 'config.js'];
const LANGUAGES = ['English', 'Ukrainian', 'German', 'French', 'Spanish', 'Polish', 'Portuguese', 'Italian', 'Japanese', 'Chinese'];

class DashboardPanel implements RpcHandlers {
  static current: DashboardPanel | undefined;

  context: vscode.ExtensionContext;
  orch: Orchestrator;
  initialRoute: Route | undefined;
  disposables: vscode.Disposable[];
  panel: vscode.WebviewPanel;
  missedChange = false;
  /** Streamed output not posted yet, and the timer that posts it. */
  outputQueue: OutputPush[] = [];
  outputTimer: NodeJS.Timeout | undefined;
  /** Steps (task and key) whose text pieces went unposted while the panel was hidden: none goes until their message ends. */
  missedText = new Set<string>();

  static show(context: vscode.ExtensionContext, orch: Orchestrator, route?: Route): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(DashboardPanel.current.panel.viewColumn);
      if (route) DashboardPanel.current.navigate(route);
      return DashboardPanel.current;
    }
    DashboardPanel.current = new DashboardPanel(context, orch, route);
    return DashboardPanel.current;
  }

  /** Whether the page has asked where to start: before that, a screen to show is where it starts. */
  booted = false;

  /**
   * Shows a screen. A page still loading would get the message before it listens, or go there and then to where it
   * was opened for (two quick "Open Task" clicks ended on the first task): it starts on the latest one instead.
   */
  navigate(route: Route): void {
    if (this.booted) void this.post({ type: 'navigate', route });
    else this.initialRoute = route;
  }

  constructor(context: vscode.ExtensionContext, orch: Orchestrator, route?: Route) {
    this.context = context;
    this.orch = orch;
    this.initialRoute = route;
    this.disposables = [];
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    // The page's scripts are compiled from media/*.ts into dist/media.
    const scripts = vscode.Uri.joinPath(context.extensionUri, 'dist', 'media');
    this.panel = vscode.window.createWebviewPanel('claudestrator.dashboard', 'Claudestrator', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media, scripts],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'tab-icon-orchestra.svg');
    this.panel.webview.html = this.html(media, scripts);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState((e) => {
      // What changed while the panel was hidden is refreshed once, as it shows again.
      if (e.webviewPanel.visible && this.missedChange) {
        this.missedChange = false;
        this.post({ type: 'changed' });
      }
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    this.listen();
  }

  /**
   * What the page hears of the engine and the config: streamed output in batches, the rest as it comes. Apart from the
   * constructor so the preview harness, which has no webview, sends the page exactly what VS Code's panel would.
   */
  listen(): void {
    const orch = this.orch;
    orch.onEngine((e) => {
      switch (e.name) {
        case 'output':
          // Only the task on screen streams; a Write's whole file of another task need not cross to the page.
          if (e.data.taskId !== this.viewing) return;
          return this.queueOutput({ type: 'output', ...e.data });
        case 'live':
          return void this.post({ type: 'live', ...e.data });
        case 'permission':
          return void this.post({ type: 'permission', request: e.data });
        case 'permissionDone':
          return void this.post({ type: 'permissionDone', requestId: e.data });
        case 'mcpLogin':
          return void this.post({ type: 'toast', kind: e.data.kind, text: e.data.message });
        case 'log':
          if (e.data.level !== 'info') this.post({ type: 'toast', kind: e.data.level === 'error' ? 'error' : 'warn', text: e.data.message, taskId: e.data.taskId });
          return;
        case 'changed':
        case 'checkpoint':
        case 'finished':
        case 'limits':
          return; // the page reads these again on `changed`
        default: {
          const unhandled: never = e;
          return unhandled;
        }
      }
    }, null, this.disposables);
    // A hidden panel keeps its page (retainContextWhenHidden), but reloading it on every change would be wasted work.
    orch.onDidChange(() => {
      if (this.panel.visible) this.post({ type: 'changed' });
      else this.missedChange = true;
    }, null, this.disposables);
    orch.onDidChangeConfig(() => this.post({ type: 'config' }), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudestrator') && this.post({ type: 'config' }), null, this.disposables);
  }

  /**
   * Streamed output goes to the page every OUTPUT_MS, text pieces of a step merged. A hidden panel gets no text
   * pieces: the transcript keeps the whole text, which the page gets as the agent finishes the message.
   */
  queueOutput(push: OutputPush): void {
    // Steps of different tasks may have the same key.
    const step = `${push.taskId}\n${push.key}`;
    if (push.item.type === 'text_delta') {
      // Pieces missed while hidden would leave the next ones mid-sentence; the step's whole text comes next anyway.
      if (!this.panel.visible) this.missedText.add(step);
      if (this.missedText.has(step)) return;
    } else if (push.item.type !== 'usage' && push.item.type !== 'user') this.missedText.delete(step); // the message ended (or a new one starts)
    view.queueOutput(this.outputQueue, push);
    if (!this.outputTimer) this.outputTimer = setTimeout(() => this.flushOutput(), OUTPUT_MS);
  }

  flushOutput(): void {
    this.outputTimer = undefined;
    const batch = this.outputQueue;
    this.outputQueue = [];
    for (const push of batch) this.post(push);
  }

  dispose(): void {
    clearTimeout(this.outputTimer);
    DashboardPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }

  post(msg: HostMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(msg);
  }

  async onMessage(msg: unknown): Promise<void> {
    // What arrives from the page is untyped: only a known request with parameters of its shape reaches a handler.
    const parsed = parsePageRequest(msg);
    if (!parsed) return;
    if (!parsed.ok) {
      if (parsed.id !== null) this.post({ type: 'res', id: parsed.id, ok: false, error: parsed.error });
      return;
    }
    const { id, method, params } = parsed.request;
    // `implements RpcHandlers` makes sure every request has its `$` handler.
    const handler = (this as RpcHandlers)[`$${method}`] as Handler;
    try {
      const data = await handler.call(this, params ?? {});
      this.post({ type: 'res', id, ok: true, data });
    } catch (err) {
      const e = err as Error & { code?: string; blocked?: BlockedRepo[] };
      this.post({ type: 'res', id, ok: false, error: e.message || String(e), code: e.code, ...(e.blocked && { blocked: e.blocked }) });
    }
  }

  get engine(): Engine {
    if (!this.orch.engine) throw new Error('Open a folder to use Claudestrator');
    return this.orch.engine;
  }

  /** The workspace folder. Null without one; everything that needs it goes through `engine`, which throws first. */
  get root(): string {
    return this.orch.root as string;
  }

  // ---------- overview ----------

  /** The route the panel was opened with, once: a reload of the page goes back to where you were, not to it. */
  /** The task the page shows, whose agent's output it gets. */
  viewing: string | null = null;

  async $view({ taskId }: { taskId: string | null }) {
    this.viewing = taskId;
    return null;
  }

  async $boot() {
    const route = this.initialRoute || null;
    this.initialRoute = undefined;
    this.booted = true;
    return { route, platform: process.platform, version: this.context.extension.packageJSON.version };
  }

  async configSummary(): Promise<ConfigSummary> {
    const r = await this.orch.config();
    if (!r.ok) return { ok: false, errors: r.errors.map((e) => e.message), warnings: (r.warnings || []).map((w) => w.message) };
    const c = r.config;
    type Entry = [string, string, Partial<ScenarioStep>?];
    return {
      ok: true,
      warnings: r.warnings.map((w) => w.message),
      // The delivery pipeline's agents, then each report scenario's, then each custom scenario's with its own model and
      // effort; `scenario` says which composer mode shows them.
      agents: ([
        ...c.pipeline.map((n): Entry => [n, 'deliver']),
        ...Object.entries(c.scenarios).flatMap(([sc, names]) => names.map((n): Entry => [n, sc])),
        ...Object.values(c.custom).flatMap((sc) => sc.agents.map((st): Entry => [st.name, sc.id, st])),
      ] as Entry[])
        .filter(([n]) => c.agents[n])
        .map(([n, scenario, st = {}]) => {
          const a: Agent = { ...c.agents[n]!, ...(st.model && { model: st.model }), ...(st.effort && { effort: st.effort }) };
          return { name: n, scenario, color: a.color, output: a.output, runs: a.runs, enabled: a.enabled, description: a.description, model: a.model, effort: a.effort, ...(st.model && { ownModel: true }), ...(st.effort && { ownEffort: true }), ...(st.instructions && { instructions: st.instructions }), ...(st.instructionsFile && { instructionsFile: st.instructionsFile }), actual: effectiveFor(a, this.orch.defaults) };
        }),
      // Custom scenarios for the composer's menu and the Scenarios page, and the built-in ones that were removed.
      custom: Object.values(c.custom).map((sc) => ({ id: sc.id, label: sc.label, description: sc.description, kind: sc.kind, ...(sc.source && { source: sc.source }), ...(sc.intake && { intake: sc.intake }) })),
      removedScenarios: c.removedScenarios.map((id) => ({ id, ...cfg.builtinScenarioInfo(id) })),
      // Every agent, for the composer's scenario editor to add from.
      catalog: Object.values(c.agents).map((a) => ({ name: a.name, output: a.output, runs: a.runs, color: a.color, enabled: a.enabled, description: a.description })),
      pipelineWarnings: buildPipeline(c).warnings.map((w) => w.message),
      repos: Object.keys(c.repos),
      language: c.language,
      gitMode: c.git.mode,
      jiraProjects: c.jira.allowedProjects,
      groups: Object.values(c.groups),
      instructions: Object.values(c.instructions),
    };
  }

  async healthSummary(): Promise<HealthSummary> {
    const h = this.orch.health;
    if (!h) {
      // The dashboard is the first to need them: start the checks; the page refreshes when they are done.
      void this.orch.ensureReady();
      return { checking: true };
    }
    const account = await this.orch.account();
    return {
      checkedAt: h.checkedAt,
      claude: { ok: h.claude.ok, version: h.claude.version, path: h.claude.path, error: h.claude.error },
      git: { ok: h.git.ok, version: h.git.version },
      gh: { ok: h.gh.ok, version: h.gh.version, account: h.gh.account, error: h.gh.error, installed: Boolean(h.gh.path) },
      glab: { ok: h.glab.ok, version: h.glab.version, account: h.glab.account, error: h.glab.error, installed: Boolean(h.glab.path) },
      account,
      atlassian: Boolean(this.orch.atlassianAuth()),
      atlassianMcp: ((await this.orch.mcpIntakeServer('atlassian')) || ({} as { server?: string })).server || null,
      linearMcp: ((await this.orch.mcpIntakeServer('linear')) || ({} as { server?: string })).server || null,
    };
  }

  async $overview() {
    const engine = this.orch.engine;
    const tasks = engine ? await Promise.all((await this.orch.list()).map((entry) => view.summary(engine, entry))) : [];
    return {
      root: this.root,
      rootName: this.root ? path.basename(this.root) : null,
      languages: LANGUAGES,
      hasConfig: await this.orch.hasProjectConfig(),
      config: this.root ? await this.configSummary() : null,
      health: await this.healthSummary(),
      tasks,
      sections: view.sectionIndex(tasks),
      limits: await this.orch.limits(),
      account: await this.orch.account(),
      accounts: await this.orch.accounts(),
      mcp: (() => {
        const list = this.orch.mcp.servers;
        const n = (st: string): number => list.filter((s) => s.state === st).length;
        return { total: list.length, connected: n('connected'), problems: n('needs_auth') + n('failed'), installed: n('installed'), checking: this.orch.mcp.checking };
      })(),
      defaults: this.orch.defaults ? { models: this.orch.defaults.models, byModel: this.orch.defaults.byModel } : null,
      permissions: this.orch.pendingPermissions(),
    };
  }

  async $health({ refresh }: { refresh?: boolean }) {
    if (refresh) await this.orch.refreshHealth();
    else await this.orch.ensureReady();
    return this.healthSummary();
  }

  // ---------- tasks ----------

  async $preview(p: ComposerArgs): Promise<Preview> {
    const r = await this.engine.preview(p);
    return r.ok && !r.empty ? { ...r, outline: outline(r.pipeline) } : r;
  }

  async $start(p: ComposerArgs) {
    await this.orch.ensureReady();
    if (!(this.orch.health && this.orch.health.claude.ok)) {
      const problem = (this.orch.health && this.orch.health.claude.error) || 'Claude Code CLI was not found';
      const go = await vscode.window.showWarningMessage(`${problem}, so agents cannot run.`, { modal: true, detail: 'Install or update Claude Code, or set its path in Claudestrator → Settings. The task is created either way and you can run it later.' }, 'Create Task Anyway');
      if (!go) throw Object.assign(new Error(problem), { code: 'cancelled' });
    }
    const r = await this.engine.start(p);
    this.engine.launch(r.taskId);
    return r;
  }

  async $task({ taskId }: { taskId: string }): Promise<TaskScreen> {
    const engine = this.engine;
    // Deleted from the sidebar, another window or the CLI while its screen was open: the page goes home.
    if (!(await engine.svc.exists(taskId))) throw Object.assign(new Error(`${taskId} was deleted`), { code: 'no_task' });
    const state = await engine.svc.state(taskId);
    const detail = await view.detail(engine, taskId);
    const context = state.checkpoint ? await engine.checkpointContext(state, state.checkpoint) : null;
    const problem = fixProblem({ status: detail.status.key, error: detail.error, checkpoint: state.checkpoint, checkpointText: context ? context.text : '' });
    return {
      ...detail,
      ...(state.checkpoint && context && { checkpointContext: context, checkpointFull: state.checkpoint }),
      fix: problem ? problem.source : null,
      ticket: await engine.svc.readArtifact(taskId, 'ticket.md'),
      pipelineEdit: await this.pipelineEdit(state),
      flow: flowOf(state),
    };
  }

  /** What the task's pipeline editor shows: its stages, from which one they can change, and the agents to add. */
  async pipelineEdit(state: TaskState): Promise<PipelineEdit | null> {
    const from = editableFrom(state);
    // A scenario's Parallel, Branch or Loop is changed in the scenario, not as this list.
    if (from === -1 || fixedFlow(state.pipeline)) return null;
    const r = await this.orch.config();
    const agents: Record<string, Agent> = r.ok ? r.config.agents : {};
    const stages = state.pipeline.stages.map((st) => ({ agent: st.agent, output: st.output, scope: st.scope, color: agents[st.agent] && agents[st.agent]!.color }));
    const { warnings } = taskPipeline(stages.map((st) => ({ name: st.agent, output: st.output, scope: st.scope })), { scenario: state.scenario, auto: state.auto, maxRounds: state.limits.reviewRounds });
    const choices = Object.values(agents)
      .filter((a) => fitsScenario(a.output, state.scenario) && !stages.some((st) => st.agent === a.name))
      .map((a) => ({ name: a.name, output: a.output, runs: a.runs, color: a.color, description: a.description, enabled: a.enabled }));
    return { from, stages, choices, warnings: warnings.map((w) => w.message) };
  }

  async $editPipeline({ taskId, names }: { taskId: string; names: string[] }) {
    return this.engine.editPipeline(taskId, names);
  }

  async $transcript({ taskId, key }: { taskId: string; key: string }) {
    return await this.engine.svc.readTranscript(taskId, key);
  }

  async $run({ taskId }: { taskId: string }) {
    await this.orch.ensureReady();
    await this.engine.resume(taskId);
  }

  async $stop({ taskId }: { taskId: string }) {
    // A task of a replaced engine (the workspace folder changed) still runs there.
    await (this.orch.engineOf(taskId) ?? this.engine).stop(taskId);
  }

  async $answer({ taskId, checkpointId, option, feedback, at }: Rpc['answer']['params']) {
    await this.orch.ensureReady();
    await this.engine.answer(taskId, checkpointId, option, feedback, at);
  }

  async $postReport({ taskId }: { taskId: string }) {
    await this.orch.ensureReady();
    return this.engine.postReport(taskId);
  }

  async $retryComment({ taskId, seq }: { taskId: string; seq: number }) {
    await this.orch.ensureReady();
    return this.engine.retryComment(taskId, seq);
  }

  async $message({ taskId, text }: { taskId: string; text: string }) {
    (this.orch.engineOf(taskId) ?? this.engine).sendMessage(taskId, text);
  }

  async $permission({ requestId, allow, message }: Rpc['permission']['params']) {
    if (!this.orch.permissionReply(requestId, allow, message)) throw new Error('That request is no longer waiting');
  }

  async $openFile({ taskId, file, preview }: { taskId?: string; file: string; preview?: boolean }): Promise<unknown> {
    const abs = taskId ? this.engine.svc.artifactFile(taskId, file) : file;
    if (!taskId && !openable(abs, await this.openableRoots())) throw new Error(`${file} is outside the workspace and its repos; open it yourself if you need it`);
    if (!(await exists(abs))) throw new Error(`${path.basename(abs)} does not exist (yet)`);
    const uri = vscode.Uri.file(abs);
    // An agent's report that would load images from the web opens as text: the preview would fetch them.
    if (preview && abs.endsWith('.md')) {
      if (!view.loadsRemote(await fs.promises.readFile(abs, 'utf8').catch(() => ''))) return vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
      vscode.window.setStatusBarMessage(`${path.basename(abs)} links images on the web: opened as text, so viewing it loads none`, 8000);
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (abs.endsWith('.patch') || abs.endsWith('.diff')) await vscode.languages.setTextDocumentLanguage(doc, 'diff');
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    return undefined;
  }

  /** Where a path the page sends may lead: the workspace, the configured repos, and the files the config comes from. */
  async openableRoots(): Promise<string[]> {
    const r = await this.orch.config();
    if (!r.ok) return [this.root];
    return [this.root, ...Object.values(r.config.repos).map((repo) => path.resolve(this.root, repo.path)), ...r.config.sources];
  }

  /** The task's current combined diff, freshly computed, in a diff-highlighted editor. */
  async $openDiff({ taskId }: { taskId: string }) {
    const engine = this.engine;
    const state = await engine.svc.state(taskId);
    if (!state.repos.length) throw new Error('No repos have changes yet');
    const r = await this.orch.config();
    const diff = await taskDiff(taskRepos(this.root, state, r.ok ? r.config : null, state.repos.map((x) => x.name)));
    await engine.svc.writeArtifact(taskId, 'diff.patch', diff.text);
    await this.$openFile({ taskId, file: 'diff.patch' });
  }

  async $openRepo({ taskId, repo }: { taskId: string; repo: string }) {
    const state = await this.engine.svc.state(taskId);
    const r = await this.orch.config();
    const [tr] = taskRepos(this.root, state, r.ok ? r.config : null, [repo]);
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(tr!.dir));
  }

  async $revealTask({ taskId }: { taskId: string }) {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(this.engine.svc.dir(taskId), 'events.ndjson')));
  }

  async $deleteTask({ taskId }: { taskId: string }) {
    return deleteTask(this.engine, taskId);
  }

  /** A task deleted elsewhere (from the sidebar) while its screen is open: the page leaves it. */
  taskDeleted(taskId: string): void {
    if (this.viewing === taskId) this.navigate({ name: 'home' });
  }

  async $cleanup({ taskId }: { taskId: string }) {
    const r = await this.engine.cleanup(taskId, false);
    const kept = r.filter((x) => x.status === 'kept');
    if (kept.length) {
      const force = await vscode.window.showWarningMessage(`${kept.map((k) => k.repo).join(', ')}: the worktree has uncommitted work.`, { modal: true, detail: kept.map((k) => k.error).join('\n') }, 'Remove Anyway');
      if (force) return this.engine.cleanup(taskId, true);
    }
    return r;
  }

  async $resumeTerminal({ taskId, key }: { taskId: string; key: string }) {
    const d = await view.detail(this.engine, taskId);
    const step = d.steps.find((s) => s.key === key);
    if (!step || !step.sessionId) throw new Error('This step has no Claude session to continue');
    // It comes from the task log, and goes on a shell's command line.
    if (!SESSION_ID.test(step.sessionId)) throw new Error('This step\'s session id is not one Claude Code makes');
    // The account the step ran under keeps its session; the one chosen now may be another (ctx-man switched it).
    const dir = step.configDir ?? this.orch.accountChoice().dir;
    // Claude itself runs in the terminal, as for the sign-in, not a command line typed into a shell: each shell quotes
    // differently (PowerShell reads `"C:\Program Files\…\claude.cmd" --resume` as a string and an error). An npm shim
    // runs its target, as the agents do.
    const [shellPath, shellArgs] = launch(this.orch.claudeCommand(), ['--resume', step.sessionId]);
    const terminal = vscode.window.createTerminal({
      name: `Claude · ${step.agent}${step.repo ? `@${step.repo}` : ''}`,
      shellPath,
      shellArgs,
      cwd: step.cwd && (await exists(step.cwd)) ? step.cwd : this.root,
      env: { PATH: getChildEnv().PATH, CLAUDE_CONFIG_DIR: dir || null },
      iconPath: new vscode.ThemeIcon('sparkle'),
    });
    terminal.show();
  }

  /**
   * "Fix in chat": Claude Code in a terminal, started with the failure the task screen shows, in the repo it is in, under
   * the agents' account, with the model and effort picked on the button. The task stays where it is: you retry it there.
   */
  async $fixInChat({ taskId, model, effort }: { taskId: string; model?: string | undefined; effort?: Effort | undefined }) {
    const state = await this.engine.svc.state(taskId);
    const detail = await view.detail(this.engine, taskId);
    const context = fixableCheckpoint(state.checkpoint) ? await this.engine.checkpointContext(state, state.checkpoint) : null;
    const problem = fixProblem({ status: detail.status.key, error: detail.error, checkpoint: state.checkpoint, checkpointText: context ? context.text : '' });
    if (!problem) throw new Error(`${taskId} has no failure to fix right now`);
    const r = await this.orch.config();
    const repos = taskRepos(this.root, state, r.ok ? r.config : null, state.repos.map((x) => x.name)).map((x) => ({ name: x.name, dir: x.dir }));
    const { cwd, addDirs } = fixDirs({ root: this.root, repos, problem });
    const prompt = fixPrompt({ taskId, title: detail.title, branch: detail.branch, repos, taskDir: detail.taskDir, problem });
    // Claude runs in the terminal itself, as for Continue in terminal: the prompt is an argument, never shell text.
    const [shellPath, shellArgs] = launch(this.orch.claudeCommand(), fixArgs({ prompt, model, effort, addDirs }));
    const terminal = vscode.window.createTerminal({
      name: `Fix · ${taskId}`,
      shellPath,
      shellArgs,
      cwd: (await exists(cwd)) ? cwd : this.root,
      env: { PATH: getChildEnv().PATH, CLAUDE_CONFIG_DIR: this.orch.accountChoice().dir || null },
      iconPath: new vscode.ThemeIcon('sparkle'),
    });
    terminal.show();
  }

  async $openExternal({ url }: { url: string }) {
    if (!view.isWebLink(url)) throw new Error('not a web link');
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async $copy({ text }: { text: string }) {
    await vscode.env.clipboard.writeText(text);
  }

  // ---------- MCP ----------

  async $accounts() {
    return { current: await this.orch.account(), accounts: await this.orch.accounts() };
  }

  async $claudeLogin() {
    this.orch.claudeLogin();
  }

  async $setAccount({ dir }: { dir?: string | null }) {
    await this.orch.setAccount(dir);
    return this.orch.account();
  }

  async $mcp({ refresh }: { refresh?: boolean }) {
    const stale = !this.orch.mcp.checkedAt || Date.now() - new Date(this.orch.mcp.checkedAt).getTime() > 2 * 60000;
    if (refresh || stale) await this.orch.refreshMcp();
    const health = await this.healthSummary();
    return { ...this.orch.mcpState(), account: health.checking ? undefined : health.account };
  }

  async $mcpLogin({ name }: { name: string }) {
    this.orch.mcpLogin(name);
  }

  async $mcpShowLogin({ name }: { name: string }) {
    this.orch.mcpShowLogin(name);
  }

  async $mcpCancelLogin({ name }: { name: string }) {
    this.orch.mcpCancelLogin(name);
  }

  async $mcpDetails({ name }: { name: string }) {
    return this.orch.mcpDetails(name);
  }

  // ---------- agents & pipeline ----------

  async $config(): Promise<ConfigData> {
    const r = await this.orch.config();
    const layer: ConfigLayer = this.root ? await cfg.readProjectLayer(this.root) : {};
    const base = { root: this.root, hasConfig: await this.orch.hasProjectConfig(), files: { project: this.root && cfg.projectConfigFile(this.root), user: cfg.userConfigFile() }, layer, colors: AGENT_COLORS, outputs: OUTPUTS, efforts: EFFORTS, builtins: cfg.builtinAgentNames(), languages: LANGUAGES, libraries: this.root ? await libraries.listLibraries({ workspace: this.root }) : [] };
    if (!r.ok) return { ...base, ok: false, errors: r.errors.map((e) => e.message), warnings: (r.warnings || []).map((w) => w.message) };
    const pipeline = buildPipeline(r.config);
    const agents = Object.values(r.config.agents).map((a) => ({
      ...a,
      instructions: undefined,
      instructionsPreview: a.instructions.slice(0, 600),
      instructionsLength: a.instructions.length,
      overridden: Boolean(layer.agents && layer.agents[a.name]),
      actual: effectiveFor(a, this.orch.defaults),
      builtin: cfg.builtinAgentNames().includes(a.name),
    }));
    const defaults = this.orch.defaults ? { models: this.orch.defaults.models, byModel: this.orch.defaults.byModel } : null;
    return { ...base, ok: true, warnings: [...r.warnings, ...pipeline.warnings].map((w) => w.message), config: { ...r.config, agents: undefined }, agents, pipeline, outline: outline(pipeline), defaults };
  }

  async $updateAgent({ name, patch }: { name: string; patch: Record<string, unknown> }) {
    await cfg.updateAgentConfig(this.root, name, patch);
  }

  async $resetAgent({ name }: { name: string }) {
    const ok = await vscode.window.showWarningMessage(`Reset "${name}" to its default definition?`, { modal: true, detail: 'Removes what this workspace\'s config.yaml says about the agent (model, tools, instructions…). Its instructions file, if any, stays on disk.' }, 'Reset');
    if (ok) await cfg.resetAgentConfig(this.root, name);
  }

  async $setPipeline({ pipeline }: { pipeline: string[] }) {
    await cfg.setPipeline(this.root, pipeline);
  }

  async $setScenario({ scenario, agents }: { scenario: string; agents: string[] }) {
    await cfg.setScenario(this.root, scenario, agents);
  }

  /**
   * Creates or changes a custom scenario. `agents`: `[{ name, model?, effort? }]`; without `id` a new one is named after
   * its label. Returns its id.
   */
  async $saveScenario({ id, label, description, agents = [], intake }: SaveScenarioParams) {
    return { id: await cfg.saveCustomScenario({ workspace: this.root, id, label, description, agents, intake }) };
  }

  async $deleteScenario({ id }: { id: string }) {
    const r = await this.orch.config();
    const label = (r.ok && r.config.custom[id] && r.config.custom[id]!.label) || ({ readiness: 'Check readiness', audit: 'Audit' } as Record<string, string>)[id] || id;
    const builtin = cfg.builtinScenarioIds().includes(id);
    const ok = await vscode.window.showWarningMessage(`Delete the scenario "${label}"?`, { modal: true, detail: builtin ? 'It disappears from the menu. You can bring it back from the same menu.' : 'Its agents stay; only this scenario (their order, models and effort) is removed from config.yaml. Tasks already started keep running.' }, 'Delete');
    if (!ok) return { deleted: false };
    await cfg.removeScenario(this.root, id);
    return { deleted: true };
  }

  async $restoreScenario({ id }: { id: string }) {
    await cfg.restoreScenario(this.root, id);
  }

  // ---------- task groups and instructions ----------

  async $saveGroup({ id, type, label, jira, instructions, defaultInstructions, baseBranch }: SaveGroupParams) {
    return { id: await cfg.saveGroup({ workspace: this.root, id, type, label, jira, instructions, defaultInstructions, baseBranch }) };
  }

  async $deleteGroup({ id }: { id: string }) {
    return { deleted: await this.deleteEntry('groups', id, 'Tasks already in it keep showing it.') };
  }

  async $saveInstruction({ id, label, text }: SaveInstructionParams) {
    return { id: await cfg.saveInstruction({ workspace: this.root, id, label, text }) };
  }

  async $deleteInstruction({ id }: { id: string }) {
    return { deleted: await this.deleteEntry('instructions', id, 'Tasks that picked it keep following it.') };
  }

  private async deleteEntry(section: cfg.EntrySection, id: string, detail: string): Promise<boolean> {
    const r = await this.orch.config();
    const label = (r.ok && r.config[section][id] && r.config[section][id]!.label) || id;
    const ok = await vscode.window.showWarningMessage(`Delete the ${section === 'groups' ? 'group' : 'instruction'} "${label}"?`, { modal: true, detail: `It is removed from config.yaml. ${detail}` }, 'Delete');
    if (!ok) return false;
    await cfg.removeEntry(this.root, section, id);
    return true;
  }

  /** Saves the project's agents, pipeline and scenarios (with the agents' instruction files) to a file you pick. */
  async $backupConfig() {
    const now = new Date();
    const backup = await backups.createBackup({ workspace: this.root, now });
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.root, `claudestrator-backup-${now.toISOString().slice(0, 10)}.yaml`)),
      filters: { 'Claudestrator backup': ['yaml', 'yml'] },
      saveLabel: 'Save backup',
      title: 'Save backup of agents, pipeline and scenarios',
    });
    if (!uri) return { saved: false };
    await fs.promises.writeFile(uri.fsPath, backup.text);
    return { saved: true, file: uri.fsPath, agents: backup.agents, scenarios: backup.scenarios, pipeline: backup.pipeline };
  }

  /** Reads a backup you pick and, after you confirm, writes its agents, pipeline and scenarios into the project. */
  async $restoreConfigBackup() {
    const nothing = { cancelled: true, agents: [], pipeline: false, scenarios: [], skipped: [] };
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: vscode.Uri.file(this.root), openLabel: 'Restore', title: 'Restore from backup', filters: { 'Claudestrator backup': ['yaml', 'yml', 'json'] } })) || [];
    if (!uri) return nothing;
    const parsed = backups.parseBackup(await fs.promises.readFile(uri.fsPath, 'utf8'));
    if (!parsed.ok) throw new Error(parsed.error);
    const plan = await backups.previewRestore({ workspace: this.root, backup: parsed.backup });
    const count = plan.agents.add.length + plan.agents.replace.length + plan.scenarios.add.length + plan.scenarios.replace.length + (plan.pipeline ? 1 : 0);
    const left = plan.skipped.map((x) => `${x.kind === 'pipeline' ? 'the pipeline' : `${x.kind} ${x.id}`} (${x.reason})`).join('; ');
    if (!count) throw new Error(`Nothing can be restored from this backup: ${left}`);
    const line = (label: string, ids: string[]): string | false => ids.length > 0 && `${label}: ${ids.join(', ')}.`;
    const detail = [
      line('Agents added', plan.agents.add),
      line('Agents replaced, with their instructions', plan.agents.replace),
      plan.pipeline && "The pipeline is replaced with the backup's.",
      line('Scenarios added', plan.scenarios.add),
      line('Scenarios replaced', plan.scenarios.replace),
      left && `Left out: ${left}.`,
      'Everything else in this project stays as it is.',
    ].filter(Boolean).join('\n\n');
    const ok = await vscode.window.showWarningMessage(`Restore ${count} item${count === 1 ? '' : 's'} from the backup?`, { modal: true, detail }, 'Restore');
    if (!ok) return nothing;
    const done = await backups.restoreBackup({ workspace: this.root, backup: parsed.backup });
    return { cancelled: false, agents: [...done.agents.add, ...done.agents.replace], pipeline: done.pipeline, scenarios: [...done.scenarios.add, ...done.scenarios.replace], skipped: done.skipped };
  }

  // ---------- libraries ----------

  /** Picks a folder, offers to start a library in it when it has no library.yaml, and asks who uses it. */
  async $addLibrary() {
    const none = { added: null };
    const [uri] = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(this.root), openLabel: 'Use as a library', title: 'A folder of agents and scenarios (library.yaml)' })) || [];
    if (!uri) return none;
    const name = path.basename(uri.fsPath);
    const create = !(await exists(path.join(uri.fsPath, cfg.LIBRARY_FILE)));
    if (create) {
      const start = await vscode.window.showInformationMessage(`${name} has no ${cfg.LIBRARY_FILE}. Start a library there?`, { modal: true, detail: `An empty ${cfg.LIBRARY_FILE} is written; move agents and scenarios into it from the Agents page, or write them as in config.yaml.` }, 'Start a library');
      if (!start) return none;
    }
    const scope = await vscode.window.showInformationMessage(`Use ${name} in…`, { modal: true, detail: 'All my projects: listed in ~/.claudestrator/config.yaml.\n\nThis project: listed in its .claudestrator/config.yaml, so teammates get it too (a folder inside the project is listed by a relative path).' }, 'All my projects', 'This project');
    if (!scope) return none;
    const info = await libraries.addLibrary({ workspace: this.root, dir: uri.fsPath, scope: scope === 'This project' ? 'project' : 'user', create });
    return { added: info.label };
  }

  async $removeLibrary({ file, scope }: { file: string; scope: 'user' | 'project' }) {
    const label = cfg.libraryLabel(file);
    const ok = await vscode.window.showWarningMessage(`Stop using the library ${label}?`, { modal: true, detail: `It is taken out of ${scope === 'user' ? '~/.claudestrator/config.yaml' : 'this project\'s config.yaml'}; the folder stays on disk. If this project still runs one of its agents, nothing changes and you are told which.` }, 'Stop using it');
    if (!ok) return { removed: false };
    await libraries.removeLibrary({ workspace: this.root, file, scope });
    return { removed: true };
  }

  async $moveToLibrary({ library, agents = [], scenarios = [] }: { library: string; agents?: string[]; scenarios?: string[] }) {
    const what = [...scenarios.map((s) => `scenario ${s}`), ...agents.map((a) => `agent ${a}`)].join(', ');
    const ok = await vscode.window.showInformationMessage(`Move ${what} to the library ${cfg.libraryLabel(library)}?`, { modal: true, detail: 'It leaves this project\'s config.yaml and is kept in the library, with its instructions file; a scenario takes along the agents of this project it runs. The project keeps using it through the library. The same names in the library are replaced.' }, 'Move');
    if (!ok) return { moved: false, agents: [], scenarios: [] };
    return { moved: true, ...(await libraries.moveToLibrary({ workspace: this.root, library, agents, scenarios })) };
  }

  async $newAgent({ name, base, description, output, model, effort, standalone }: NewAgentParams) {
    const file = await cfg.addAgent({ workspace: this.root, name, base, description, output, model, effort, standalone });
    await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
  }


  async $editInstructions({ name }: { name: string }) {
    const r = await this.orch.config();
    if (!r.ok) throw new Error(r.errors[0]!.message);
    const file = await cfg.ensureInstructionsFile(this.root, name, r.config.agents[name]);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
  }

  /** What a scenario with these steps would run (approvals, review loop, warnings), before it is saved. */
  async $previewScenario({ agents, auto }: Rpc['previewScenario']['params']) {
    const r = await this.orch.config();
    if (!r.ok) throw new Error(r.errors[0]!.message);
    const pipeline = scenarioPipeline(r.config, agents, { auto });
    return { pipeline, outline: outline(pipeline) };
  }

  /** Opens what a scenario's step adds to its agent's instructions, moved into a file of its own first. */
  async $editStepInstructions({ scenario, agent }: { scenario: string; agent: string }) {
    const file = await cfg.ensureStepInstructionsFile({ workspace: this.root, scenario, agent });
    await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
  }

  async $setValue({ keyPath, value }: { keyPath: string[]; value: unknown }) {
    // The value itself is checked by the config validator when it is written.
    if (!Array.isArray(keyPath) || !keyPath.length || !keyPath.every((k) => typeof k === 'string' && k.length > 0)) throw new Error('invalid config path');
    await cfg.setProjectValue(this.root, keyPath, value);
  }

  async $openConfig({ which }: { which: string }) {
    await openConfig(this.root, which);
  }

  // ---------- repos ----------

  async $repos(): Promise<ReposData> {
    const r = await this.orch.config();
    const configured = r.ok ? r.config.repos : {};
    const status = r.ok ? await this.engine.repoStatus() : [];
    const known = new Set(Object.values(configured).map((x) => path.resolve(this.root, x.path)));
    const detected = this.root ? (await findRepos(this.root)).filter((d) => !known.has(d.dir)) : [];
    const ctxDir = path.join(this.root, cfg.CONFIG_DIR);
    return {
      ok: r.ok,
      errors: r.ok ? [] : r.errors.map((e) => e.message),
      repos: await Promise.all(Object.values(configured).map(async (x) => ({ ...x, status: status.find((s) => s.name === x.name), suggested: (await describeRepo(path.resolve(this.root, x.path))).gates }))),
      detected,
      context: r.ok ? await Promise.all(r.config.context.map(async (f) => ({ file: f, rel: path.relative(this.root, f), exists: await exists(f), ref: path.relative(ctxDir, f) }))) : [],
      baseBranch: r.ok ? r.config.baseBranch : 'main',
    };
  }

  async $saveRepo({ name, oldName, layer }: { name?: string; oldName?: string; layer: RepoLayer }) {
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Repo names use letters, digits, dots, dashes and underscores');
    const clean: RepoLayer = {
      ...(layer.role && { role: layer.role }),
      ...(layer.path && layer.path !== name && { path: layer.path }),
      ...(layer.baseBranch && { baseBranch: layer.baseBranch }),
      gates: (layer.gates || []).filter((g) => g.name && g.cmd).map((g) => ({ name: g.name, cmd: g.cmd, ...(g.dir && { dir: g.dir }), ...(g.when && { when: g.when }), ...(g.timeout !== undefined && { timeout: g.timeout }) })),
    };
    if (!clean.gates!.length) delete clean.gates;
    await cfg.setRepo(this.root, name, clean, oldName);
  }

  async $removeRepo({ name }: { name: string }) {
    const ok = await vscode.window.showWarningMessage(`Remove "${name}" from Claudestrator?`, { modal: true, detail: 'Only the config entry is removed; the folder and its git history stay as they are.' }, 'Remove');
    if (ok) await cfg.setRepo(this.root, name, undefined);
  }

  /** Folder picker anywhere on disk: picked repos, or the repos inside picked folders, ready to confirm. */
  async $pickRepos({ forSetup }: { forSetup?: boolean } = {}) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: true,
      defaultUri: vscode.Uri.file(path.dirname(this.root)),
      openLabel: 'Add repositories',
      title: 'Pick a git repository, several, or a folder that contains repositories',
    });
    if (!picked || !picked.length) return null;
    const r = await this.orch.config();
    const existing = !forSetup && r.ok ? Object.values(r.config.repos) : [];
    return reposFromFolders(this.root, picked.map((u) => u.fsPath), { names: existing.map((x) => x.name), dirs: existing.map((x) => path.resolve(this.root, x.path)) });
  }

  async $pickWorkspace() {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(this.root || os.homedir()), openLabel: 'Use as Claudestrator workspace', title: 'The folder that holds your repos and .claudestrator/config.yaml' })) || [];
    if (!uri) return null;
    await settings().update('workspaceFolder', uri.fsPath, vscode.ConfigurationTarget.Global);
    await this.orch.rebuild();
    return uri.fsPath;
  }

  async $addDetected({ repos }: { repos: PickedRepo[] }) {
    for (const d of repos) await cfg.setRepo(this.root, safeName(d.name), repoLayerOf(d));
  }

  async $runGates({ name, force }: { name: string; force?: boolean }) {
    return this.engine.runGatesNow(name, force);
  }

  async $addContext() {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: vscode.Uri.file(this.root), openLabel: 'Give to every agent', filters: { 'Text files': ['md', 'txt', 'yaml', 'yml', 'json'] } });
    if (!picked) return;
    const r = await this.orch.config();
    const current = r.ok ? r.config.context : [];
    const all = [...new Set([...current, ...picked.map((u) => u.fsPath)])].map((f) => cfg.configRelative(this.root, f));
    await cfg.setProjectValue(this.root, ['context'], all);
  }

  async $removeContext({ file }: { file: string }) {
    const r = await this.orch.config();
    const rest = (r.ok ? r.config.context : []).filter((f) => f !== file).map((f) => cfg.configRelative(this.root, f));
    await cfg.setProjectValue(this.root, ['context'], rest.length ? rest : undefined);
  }

  async $createWorkspaceMap() {
    const file = path.join(this.root, cfg.CONFIG_DIR, 'workspace.md');
    const r = await this.orch.config();
    if (!(await exists(file))) {
      const repos = r.ok ? await Promise.all(Object.values(r.config.repos).map(async (x) => ({ name: x.name, path: x.path, ...(await describeRepo(path.resolve(this.root, x.path))) }))) : [];
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, WORKSPACE_MAP(repos));
    }
    const current = r.ok ? r.config.context : [];
    if (!current.includes(file)) {
      await cfg.setProjectValue(this.root, ['context'], [...current, file].map((f) => cfg.configRelative(this.root, f)));
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  // ---------- setup ----------

  async $detect() {
    if (!this.root) return { repos: [] };
    return { root: this.root, repos: await findRepos(this.root) };
  }

  async $setup({ repos, language, gitMode, map, baseBranch }: SetupParams) {
    const layer: ConfigLayer = {
      ...(language && language !== 'English' && { language }),
      ...(baseBranch && baseBranch !== 'main' && { baseBranch }),
      ...(gitMode && gitMode !== 'branch' && { git: { mode: gitMode } }),
      repos: Object.fromEntries((repos || []).map((d) => [safeName(d.name), repoLayerOf(d, baseBranch || 'main')])),
      ...(map && { context: ['./workspace.md'] }),
    };
    if (!Object.keys(layer.repos!).length) delete layer.repos;
    const file = await cfg.createProjectConfig(this.root, layer, ' Claudestrator workspace config. Edit it here or in the Claudestrator dashboard.\n Layers: built-in defaults → ~/.claudestrator/config.yaml → this file.');
    if (map) {
      const mapFile = path.join(this.root, cfg.CONFIG_DIR, 'workspace.md');
      if (!(await exists(mapFile))) await fs.promises.writeFile(mapFile, WORKSPACE_MAP(repos || []));
    }
    return { file };
  }

  // ---------- settings ----------

  async $settings(): Promise<SettingsData> {
    const s = settings();
    const auth = this.orch.atlassianAuth();
    return {
      claudePath: s.get<string>('claudePath'),
      claudeConfigDir: s.get<string>('claudeConfigDir'),
      claudeConfigDirResolved: s.get('claudeConfigDir') ? path.resolve(expand(s.get<string>('claudeConfigDir')!)) : '',
      settingSources: s.get<string[]>('settingSources'),
      askPermissions: s.get<boolean>('askPermissions'),
      notifications: s.get<string>('notifications'),
      workspaceFolder: s.get<string>('workspaceFolder'),
      root: this.root,
      accounts: await this.orch.accounts(),
      account: await this.orch.account(),
      atlassian: { site: s.get('atlassian.site') || '', email: s.get('atlassian.email') || '', hasToken: Boolean(this.orch.token), fromEnv: !this.orch.token && Boolean(process.env.ATLASSIAN_API_TOKEN), connected: Boolean(auth), mcp: await this.orch.mcpIntakeServer() },
      bitbucket: { email: s.get('bitbucket.email') || '', hasToken: Boolean(this.orch.bitbucketToken), fromEnv: !this.orch.bitbucketToken && Boolean(process.env.BITBUCKET_API_TOKEN), connected: Boolean(this.orch.bitbucketAuth()) },
      health: await this.healthSummary(),
    };
  }

  async $updateSetting({ key, value }: { key: string; value: unknown }) {
    const issues = validateSetting(key, value);
    if (issues.length) throw new Error(`invalid setting: ${issues.join('; ')}`);
    await settings().update(key, value, vscode.ConfigurationTarget.Global);
    if (key === 'claudePath') await this.orch.refreshHealth();
    else if (key === 'settingSources') this.orch.refreshDefaults(true);
  }

  async $pickClaude() {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use this Claude Code CLI' })) || [];
    if (!uri) return null;
    await this.$updateSetting({ key: 'claudePath', value: uri.fsPath });
    return uri.fsPath;
  }

  async $saveAtlassian({ site, email, token }: { site?: string; email?: string; token?: string }) {
    await this.orch.saveAtlassian({ site: (site || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''), email: (email || '').trim(), token });
  }

  async $testAtlassian() {
    const client = this.orch.atlassian();
    if (!client) throw new Error('Fill in the site, email and API token first');
    return client.myself();
  }

  async $saveBitbucket({ email, token }: { email?: string; token?: string }) {
    await this.orch.saveBitbucket({ email: (email || '').trim(), token });
  }

  async $testBitbucket() {
    const client = this.orch.bitbucket();
    if (!client) throw new Error('Fill in the email and API token first');
    return client.myself();
  }

  html(media: vscode.Uri, scripts: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.css'));
    const tags = PAGE_SCRIPTS.map((name) => `  <script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(scripts, name))}"></script>`).join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Claudestrator</title>
</head>
<body>
  <div id="app"><div class="boot"><div class="spinner"></div></div></div>
  <div id="toasts" aria-live="polite"></div>
  <div id="modal-root"></div>
${tags}
</body>
</html>`;
  }
}

// What the dashboard and the sidebar's commands both do; a command does it without opening the dashboard.

/** Deletes a task once you confirm, with its worktrees when they hold no uncommitted work. */
async function deleteTask(engine: Engine, taskId: string): Promise<{ deleted: boolean }> {
  const state = await engine.svc.state(taskId);
  const worktrees = state.gitMode === 'worktree' && state.repos.length;
  const choice = await vscode.window.showWarningMessage(
    `Delete task ${taskId}?`,
    { modal: true, detail: `This removes .orch/tasks/${taskId} (its log, plan, reports and transcripts). Branches and commits in your repos stay.${worktrees ? ' Its worktrees are removed too, if they have no uncommitted work.' : ''}` },
    'Delete'
  );
  if (choice !== 'Delete') return { deleted: false };
  if ((await engine.svc.runsElsewhere(taskId)) !== null) throw new Error(`${taskId} runs in another VS Code window; stop it there first`);
  // Stopped first, and its run ended: a worktree is never removed under an agent that still works in it.
  if (engine.isRunning(taskId)) {
    await engine.stop(taskId);
    await engine.settled(taskId);
  }
  if (worktrees) await engine.cleanup(taskId, false);
  await engine.remove(taskId);
  return { deleted: true };
}

/** Opens your (`user`) or the workspace's config.yaml in an editor, written first with a comment when there is none. */
async function openConfig(root: string, which: string): Promise<void> {
  const file = which === 'user' ? cfg.userConfigFile() : cfg.projectConfigFile(root);
  if (!(await exists(file))) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `# Claudestrator ${which === 'user' ? 'user' : 'workspace'} config. Later layers override earlier ones field by field:\n# built-in defaults → ~/.claudestrator/config.yaml → <workspace>/.claudestrator/config.yaml\n{}\n`);
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

export type { Route };
export { DashboardPanel, deleteTask, openConfig };
