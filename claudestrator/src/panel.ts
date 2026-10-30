// The dashboard webview: one panel, routed inside (home, task, agents, repos, settings, setup).
// The page asks with `{ type: 'req', id, method, params }`; pushes are `changed`, `output`, `live`, `permission`, `toast`.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import * as view from './core/view';
import * as cfg from './core/config';
import * as backups from './core/backup';
import * as libraries from './core/library';
import { buildPipeline, outline, taskPipeline, fitsScenario } from './core/pipeline';
import { editableFrom } from './core/machine';
import { taskRepos, taskDiff } from './core/git';
import { findRepos, describeRepo, reposFromFolders, repoLayerOf, WORKSPACE_MAP, safeName } from './core/setup';
import { expand } from './core/env';
import { effectiveFor } from './core/defaults';
import { AGENT_COLORS, OUTPUTS, EFFORTS, validateSetting } from './core/protocol';
import { settings, type Orchestrator } from './orchestrator';
import type { Engine } from './core/engine';
import type { ComposerArgs, ConfigData, ConfigSummary, HealthSummary, NewAgentParams, PipelineEdit, Preview, ReposData, Route, Rpc, RpcHandlers, SaveGroupParams, SaveInstructionParams, SaveScenarioParams, SettingsData, SetupParams, TaskScreen } from './core/wire';
import type { Agent, ScenarioStep, Gate, TaskState } from './core/types';
import type { ConfigLayer, RepoLayer } from './core/config';

/** A request from the page: `{ type: 'req', id, method, params }`. */
interface PageRequest {
  type: 'req';
  id: number;
  method: string;
  params?: unknown;
}

/** What arrives from the page is untyped: only a well-formed request is answered. */
function isPageRequest(msg: unknown): msg is PageRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'req' && typeof m.id === 'number' && typeof m.method === 'string' && /^[a-zA-Z]+$/.test(m.method);
}

/** A repo as the page sends it back from the setup wizard or the detected list. */
interface PickedRepo {
  name: string;
  path: string;
  role?: string | undefined;
  baseBranch?: string | undefined;
  gates?: Gate[] | undefined;
}

type Handler = (params: unknown) => Promise<unknown>;

const LANGUAGES = ['English', 'Ukrainian', 'German', 'French', 'Spanish', 'Polish', 'Portuguese', 'Italian', 'Japanese', 'Chinese'];

class DashboardPanel implements RpcHandlers {
  static current: DashboardPanel | undefined;

  context: vscode.ExtensionContext;
  orch: Orchestrator;
  initialRoute: Route | undefined;
  disposables: vscode.Disposable[];
  panel: vscode.WebviewPanel;
  missedChange = false;

  static show(context: vscode.ExtensionContext, orch: Orchestrator, route?: Route): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(DashboardPanel.current.panel.viewColumn);
      if (route) DashboardPanel.current.post({ type: 'navigate', route });
      return DashboardPanel.current;
    }
    DashboardPanel.current = new DashboardPanel(context, orch, route);
    return DashboardPanel.current;
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
      vscode.commands.executeCommand('setContext', 'claudestratorPanelFocus', e.webviewPanel.active);
      // What changed while the panel was hidden is refreshed once, as it shows again.
      if (e.webviewPanel.visible && this.missedChange) {
        this.missedChange = false;
        this.post({ type: 'changed' });
      }
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);

    orch.onEngine(({ name, data: payload }) => {
      const data = payload as Record<string, unknown>;
      if (name === 'output') this.post({ type: 'output', ...data });
      else if (name === 'live') this.post({ type: 'live', ...data });
      else if (name === 'permission') this.post({ type: 'permission', request: data });
      else if (name === 'permissionDone') this.post({ type: 'permissionDone', requestId: data });
      else if (name === 'mcpLogin') this.post({ type: 'toast', kind: data.kind || (data.ok ? 'ok' : 'error'), text: data.message });
      else if (name === 'log' && data.level !== 'info') this.post({ type: 'toast', kind: data.level === 'error' ? 'error' : 'warn', text: data.message, taskId: data.taskId });
    }, null, this.disposables);
    // A hidden panel keeps its page (retainContextWhenHidden), but reloading it on every change would be wasted work.
    orch.onDidChange(() => {
      if (this.panel.visible) this.post({ type: 'changed' });
      else this.missedChange = true;
    }, null, this.disposables);
    orch.onDidChangeConfig(() => this.post({ type: 'config' }), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudestrator') && this.post({ type: 'config' }), null, this.disposables);
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    vscode.commands.executeCommand('setContext', 'claudestratorPanelFocus', false);
    this.disposables.forEach((d) => d.dispose());
  }

  post(msg: Record<string, unknown>): Thenable<boolean> {
    return this.panel.webview.postMessage(msg);
  }

  async onMessage(msg: unknown): Promise<void> {
    if (!isPageRequest(msg)) return;
    // Only the panel's own `$` handlers, never something reached through Object's prototype.
    const name = `$${msg.method}`;
    const fn = Object.prototype.hasOwnProperty.call(DashboardPanel.prototype, name) ? (this as unknown as Record<string, Handler | undefined>)[name] : undefined;
    try {
      if (!fn) throw new Error(`unknown request ${msg.method}`);
      const data = await fn.call(this, msg.params || {});
      this.post({ type: 'res', id: msg.id, ok: true, data });
    } catch (err) {
      const e = err as Error & { code?: string; blocked?: object };
      this.post({ type: 'res', id: msg.id, ok: false, error: e.message || String(e), code: e.code, ...(e.blocked && { blocked: e.blocked }) });
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

  async $boot() {
    return { route: this.initialRoute || null, platform: process.platform, version: this.context.extension.packageJSON.version };
  }

  configSummary(): ConfigSummary {
    const r = this.orch.config();
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
          return { name: n, scenario, color: a.color, output: a.output, runs: a.runs, enabled: a.enabled, description: a.description, model: a.model, effort: a.effort, ...(st.model && { ownModel: true }), ...(st.effort && { ownEffort: true }), actual: effectiveFor(a, this.orch.defaults) };
        }),
      // Custom scenarios for the composer's menu and the Scenarios page, and the built-in ones that were removed.
      custom: Object.values(c.custom).map((sc) => ({ id: sc.id, label: sc.label, description: sc.description, kind: sc.kind, ...(sc.source && { source: sc.source }) })),
      removedScenarios: c.removedScenarios,
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

  healthSummary(): HealthSummary {
    const h = this.orch.health;
    if (!h) {
      // The dashboard is the first to need them: start the checks; the page refreshes when they are done.
      void this.orch.ensureReady();
      return { checking: true };
    }
    const account = this.orch.account();
    return {
      checkedAt: h.checkedAt,
      claude: { ok: h.claude.ok, version: h.claude.version, path: h.claude.path, error: h.claude.error },
      git: { ok: h.git.ok, version: h.git.version },
      gh: { ok: h.gh.ok, version: h.gh.version, account: h.gh.account, error: h.gh.error, installed: Boolean(h.gh.path) },
      node: { ok: h.node.ok, path: h.node.path },
      account,
      atlassian: Boolean(this.orch.atlassianAuth()),
      atlassianMcp: (this.orch.mcpIntakeServer() || ({} as { server?: string })).server || null,
    };
  }

  async $overview() {
    const engine = this.orch.engine;
    return {
      root: this.root,
      rootName: this.root ? path.basename(this.root) : null,
      hasConfig: this.orch.hasProjectConfig(),
      config: this.root ? this.configSummary() : null,
      health: this.healthSummary(),
      tasks: engine ? this.orch.list().map((entry) => view.summary(engine, entry)) : [],
      limits: this.orch.limits(),
      account: this.orch.account(),
      accounts: this.orch.accounts(),
      mcp: (() => {
        const list = this.orch.mcp.servers;
        const n = (st: string): number => list.filter((s) => s.state === st).length;
        return { total: list.length, connected: n('connected'), problems: n('needs_auth') + n('failed'), installed: n('installed'), checking: this.orch.mcp.checking };
      })(),
      defaults: this.orch.defaults ? { models: this.orch.defaults.models, byModel: this.orch.defaults.byModel } : null,
      permissions: engine ? engine.pendingPermissions() : [],
    };
  }

  async $health({ refresh }: { refresh?: boolean }) {
    if (refresh) await this.orch.refreshHealth();
    else await this.orch.ensureReady();
    return this.healthSummary();
  }

  // ---------- tasks ----------

  async $preview(p: ComposerArgs): Promise<Preview> {
    const r = this.engine.preview(p);
    return r.ok && !r.empty ? { ...r, outline: outline(r.pipeline) } : r;
  }

  async $start(p: ComposerArgs) {
    await this.orch.ensureReady();
    if (!(this.orch.health && this.orch.health.claude.ok)) {
      const go = await vscode.window.showWarningMessage('Claude Code CLI was not found, so agents cannot run.', { modal: true, detail: 'Install Claude Code, or set its path in Claudestrator → Settings. The task is created either way and you can run it later.' }, 'Create Task Anyway');
      if (!go) throw Object.assign(new Error('Claude Code CLI not found'), { code: 'cancelled' });
    }
    const r = this.engine.start(p);
    this.engine.launch(r.taskId);
    return r;
  }

  async $task({ taskId }: { taskId: string }): Promise<TaskScreen> {
    const engine = this.engine;
    const state = engine.svc.state(taskId);
    return {
      ...view.detail(engine, taskId),
      ...(state.checkpoint && { checkpointContext: await engine.checkpointContext(state, state.checkpoint), checkpointFull: state.checkpoint }),
      ticket: engine.svc.readArtifact(taskId, 'ticket.md'),
      pipelineEdit: this.pipelineEdit(state),
    };
  }

  /** What the task's pipeline editor shows: its stages, from which one they can change, and the agents to add. */
  pipelineEdit(state: TaskState): PipelineEdit | null {
    const from = editableFrom(state);
    if (from === -1) return null;
    const r = this.orch.config();
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
    return this.engine.svc.readTranscript(taskId, key);
  }

  async $run({ taskId }: { taskId: string }) {
    await this.orch.ensureReady();
    this.engine.resume(taskId);
  }

  async $stop({ taskId }: { taskId: string }) {
    await this.engine.stop(taskId);
  }

  async $answer({ taskId, checkpointId, option, feedback }: Rpc['answer']['params']) {
    await this.orch.ensureReady();
    await this.engine.answer(taskId, checkpointId, option, feedback);
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
    this.engine.sendMessage(taskId, text);
  }

  async $permission({ requestId, allow, message }: Rpc['permission']['params']) {
    if (!this.engine.permissionReply(requestId, allow, message)) throw new Error('That request is no longer waiting');
  }

  async $openFile({ taskId, file, preview }: { taskId?: string; file: string; preview?: boolean }): Promise<unknown> {
    const abs = taskId ? this.engine.svc.artifactFile(taskId, file) : file;
    if (!fs.existsSync(abs)) throw new Error(`${path.basename(abs)} does not exist (yet)`);
    const uri = vscode.Uri.file(abs);
    if (preview && abs.endsWith('.md')) return vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    if (abs.endsWith('.patch') || abs.endsWith('.diff')) await vscode.languages.setTextDocumentLanguage(doc, 'diff');
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    return undefined;
  }

  /** The task's current combined diff, freshly computed, in a diff-highlighted editor. */
  async $openDiff({ taskId }: { taskId: string }) {
    const engine = this.engine;
    const state = engine.svc.state(taskId);
    if (!state.repos.length) throw new Error('No repos have changes yet');
    const r = this.orch.config();
    const diff = await taskDiff(taskRepos(this.root, state, r.ok ? r.config : null, state.repos.map((x) => x.name)));
    const file = engine.svc.writeArtifact(taskId, 'diff.patch', diff.text);
    await this.$openFile({ file });
  }

  async $openRepo({ taskId, repo }: { taskId: string; repo: string }) {
    const state = this.engine.svc.state(taskId);
    const r = this.orch.config();
    const [tr] = taskRepos(this.root, state, r.ok ? r.config : null, [repo]);
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(tr!.dir));
  }

  async $revealTask({ taskId }: { taskId: string }) {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(this.engine.svc.dir(taskId), 'events.ndjson')));
  }

  async $deleteTask({ taskId }: { taskId: string }) {
    const state = this.engine.svc.state(taskId);
    const worktrees = state.gitMode === 'worktree' && state.repos.length;
    const choice = await vscode.window.showWarningMessage(
      `Delete task ${taskId}?`,
      { modal: true, detail: `This removes .orch/tasks/${taskId} (its log, plan, reports and transcripts). Branches and commits in your repos stay.${worktrees ? ' Its worktrees are removed too, if they have no uncommitted work.' : ''}` },
      'Delete'
    );
    if (choice !== 'Delete') return { deleted: false };
    if (worktrees) await this.engine.cleanup(taskId, false);
    await this.engine.remove(taskId);
    return { deleted: true };
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
    const d = view.detail(this.engine, taskId);
    const step = d.steps.find((s) => s.key === key);
    if (!step || !step.sessionId) throw new Error('This step has no Claude session to continue');
    const dir = this.orch.account().dir;
    const terminal = vscode.window.createTerminal({
      name: `Claude · ${step.agent}${step.repo ? `@${step.repo}` : ''}`,
      cwd: step.cwd && fs.existsSync(step.cwd) ? step.cwd : this.root,
      env: { CLAUDE_CONFIG_DIR: dir || null },
      iconPath: new vscode.ThemeIcon('sparkle'),
    });
    terminal.show();
    const claude = (this.orch.health && this.orch.health.claude.path) || 'claude';
    terminal.sendText(`${/\s/.test(claude) ? `"${claude}"` : claude} --resume ${step.sessionId}`);
  }

  async $openExternal({ url }: { url: string }) {
    if (!/^https?:\/\//.test(url)) throw new Error('not a web link');
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async $copy({ text }: { text: string }) {
    await vscode.env.clipboard.writeText(text);
  }

  // ---------- MCP ----------

  async $accounts() {
    return { current: this.orch.account(), accounts: this.orch.accounts() };
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
    if (refresh || stale) this.orch.refreshMcp();
    const health = this.healthSummary();
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
    const r = this.orch.config();
    const layer = this.root ? cfg.readProjectLayer(this.root) : {};
    const base = { root: this.root, hasConfig: this.orch.hasProjectConfig(), files: { project: this.root && cfg.projectConfigFile(this.root), user: cfg.userConfigFile() }, layer, colors: AGENT_COLORS, outputs: OUTPUTS, efforts: EFFORTS, builtins: cfg.builtinAgentNames(), languages: LANGUAGES, libraries: this.root ? libraries.listLibraries({ workspace: this.root }) : [] };
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
    cfg.updateAgentConfig(this.root, name, patch);
  }

  async $resetAgent({ name }: { name: string }) {
    const ok = await vscode.window.showWarningMessage(`Reset "${name}" to its default definition?`, { modal: true, detail: 'Removes what this workspace\'s config.yaml says about the agent (model, tools, instructions…). Its instructions file, if any, stays on disk.' }, 'Reset');
    if (ok) cfg.resetAgentConfig(this.root, name);
  }

  async $setPipeline({ pipeline }: { pipeline: string[] }) {
    cfg.setPipeline(this.root, pipeline);
  }

  async $setScenario({ scenario, agents }: { scenario: string; agents: string[] }) {
    cfg.setScenario(this.root, scenario, agents);
  }

  /**
   * Creates or changes a custom scenario. `agents`: `[{ name, model?, effort? }]`; without `id` a new one is named after
   * its label. Returns its id.
   */
  async $saveScenario({ id, label, description, agents = [] }: SaveScenarioParams) {
    return { id: cfg.saveCustomScenario({ workspace: this.root, id, label, description, agents }) };
  }

  async $deleteScenario({ id }: { id: string }) {
    const r = this.orch.config();
    const label = (r.ok && r.config.custom[id] && r.config.custom[id]!.label) || ({ readiness: 'Check readiness', audit: 'Audit' } as Record<string, string>)[id] || id;
    const builtin = id === 'readiness' || id === 'audit';
    const ok = await vscode.window.showWarningMessage(`Delete the scenario "${label}"?`, { modal: true, detail: builtin ? 'It disappears from the menu. You can bring it back from the same menu.' : 'Its agents stay; only this scenario (their order, models and effort) is removed from config.yaml. Tasks already started keep running.' }, 'Delete');
    if (!ok) return { deleted: false };
    cfg.removeScenario(this.root, id);
    return { deleted: true };
  }

  async $restoreScenario({ id }: { id: string }) {
    cfg.restoreScenario(this.root, id);
  }

  // ---------- task groups and instructions ----------

  async $saveGroup({ id, type, label, jira, instructions, defaultInstructions }: SaveGroupParams) {
    return { id: cfg.saveGroup({ workspace: this.root, id, type, label, jira, instructions, defaultInstructions }) };
  }

  async $deleteGroup({ id }: { id: string }) {
    return { deleted: await this.deleteEntry('groups', id, 'Tasks already in it keep showing it.') };
  }

  async $saveInstruction({ id, label, text }: SaveInstructionParams) {
    return { id: cfg.saveInstruction({ workspace: this.root, id, label, text }) };
  }

  async $deleteInstruction({ id }: { id: string }) {
    return { deleted: await this.deleteEntry('instructions', id, 'Tasks that picked it keep following it.') };
  }

  private async deleteEntry(section: cfg.EntrySection, id: string, detail: string): Promise<boolean> {
    const r = this.orch.config();
    const label = (r.ok && r.config[section][id] && r.config[section][id]!.label) || id;
    const ok = await vscode.window.showWarningMessage(`Delete the ${section === 'groups' ? 'group' : 'instruction'} "${label}"?`, { modal: true, detail: `It is removed from config.yaml. ${detail}` }, 'Delete');
    if (!ok) return false;
    cfg.removeEntry(this.root, section, id);
    return true;
  }

  /** Saves the project's agents, pipeline and scenarios (with the agents' instruction files) to a file you pick. */
  async $backupConfig() {
    const now = new Date();
    const backup = backups.createBackup({ workspace: this.root, now });
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.root, `claudestrator-backup-${now.toISOString().slice(0, 10)}.yaml`)),
      filters: { 'Claudestrator backup': ['yaml', 'yml'] },
      saveLabel: 'Save backup',
      title: 'Save backup of agents, pipeline and scenarios',
    });
    if (!uri) return { saved: false };
    fs.writeFileSync(uri.fsPath, backup.text);
    return { saved: true, file: uri.fsPath, agents: backup.agents, scenarios: backup.scenarios, pipeline: backup.pipeline };
  }

  /** Reads a backup you pick and, after you confirm, writes its agents, pipeline and scenarios into the project. */
  async $restoreConfigBackup() {
    const nothing = { cancelled: true, agents: [], pipeline: false, scenarios: [], skipped: [] };
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: vscode.Uri.file(this.root), openLabel: 'Restore', title: 'Restore from backup', filters: { 'Claudestrator backup': ['yaml', 'yml', 'json'] } })) || [];
    if (!uri) return nothing;
    const parsed = backups.parseBackup(fs.readFileSync(uri.fsPath, 'utf8'));
    if (!parsed.ok) throw new Error(parsed.error);
    const plan = backups.previewRestore({ workspace: this.root, backup: parsed.backup });
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
    const done = backups.restoreBackup({ workspace: this.root, backup: parsed.backup });
    return { cancelled: false, agents: [...done.agents.add, ...done.agents.replace], pipeline: done.pipeline, scenarios: [...done.scenarios.add, ...done.scenarios.replace], skipped: done.skipped };
  }

  // ---------- libraries ----------

  /** Picks a folder, offers to start a library in it when it has no library.yaml, and asks who uses it. */
  async $addLibrary() {
    const none = { added: null };
    const [uri] = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(this.root), openLabel: 'Use as a library', title: 'A folder of agents and scenarios (library.yaml)' })) || [];
    if (!uri) return none;
    const name = path.basename(uri.fsPath);
    const exists = fs.existsSync(path.join(uri.fsPath, cfg.LIBRARY_FILE));
    if (!exists) {
      const create = await vscode.window.showInformationMessage(`${name} has no ${cfg.LIBRARY_FILE}. Start a library there?`, { modal: true, detail: `An empty ${cfg.LIBRARY_FILE} is written; move agents and scenarios into it from the Agents page, or write them as in config.yaml.` }, 'Start a library');
      if (!create) return none;
    }
    const scope = await vscode.window.showInformationMessage(`Use ${name} in…`, { modal: true, detail: 'All my projects: listed in ~/.claudestrator/config.yaml.\n\nThis project: listed in its .claudestrator/config.yaml, so teammates get it too (a folder inside the project is listed by a relative path).' }, 'All my projects', 'This project');
    if (!scope) return none;
    const info = libraries.addLibrary({ workspace: this.root, dir: uri.fsPath, scope: scope === 'This project' ? 'project' : 'user', create: !exists });
    return { added: info.label };
  }

  async $removeLibrary({ file, scope }: { file: string; scope: 'user' | 'project' }) {
    const label = cfg.libraryLabel(file);
    const ok = await vscode.window.showWarningMessage(`Stop using the library ${label}?`, { modal: true, detail: `It is taken out of ${scope === 'user' ? '~/.claudestrator/config.yaml' : 'this project\'s config.yaml'}; the folder stays on disk. If this project still runs one of its agents, nothing changes and you are told which.` }, 'Stop using it');
    if (!ok) return { removed: false };
    libraries.removeLibrary({ workspace: this.root, file, scope });
    return { removed: true };
  }

  async $moveToLibrary({ library, agents = [], scenarios = [] }: { library: string; agents?: string[]; scenarios?: string[] }) {
    const what = [...scenarios.map((s) => `scenario ${s}`), ...agents.map((a) => `agent ${a}`)].join(', ');
    const ok = await vscode.window.showInformationMessage(`Move ${what} to the library ${cfg.libraryLabel(library)}?`, { modal: true, detail: 'It leaves this project\'s config.yaml and is kept in the library, with its instructions file; a scenario takes along the agents of this project it runs. The project keeps using it through the library. The same names in the library are replaced.' }, 'Move');
    if (!ok) return { moved: false, agents: [], scenarios: [] };
    return { moved: true, ...libraries.moveToLibrary({ workspace: this.root, library, agents, scenarios }) };
  }

  async $newAgent({ name, base, description, output, model, effort }: NewAgentParams) {
    const file = cfg.addAgent({ workspace: this.root, name, base, description, output, model, effort });
    await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
  }


  async $editInstructions({ name }: { name: string }) {
    const r = this.orch.config();
    if (!r.ok) throw new Error(r.errors[0]!.message);
    const file = cfg.ensureInstructionsFile(this.root, name, r.config.agents[name]);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
  }

  async $setValue({ keyPath, value }: { keyPath: string[]; value: unknown }) {
    // The value itself is checked by the config validator when it is written.
    if (!Array.isArray(keyPath) || !keyPath.length || !keyPath.every((k) => typeof k === 'string' && k.length > 0)) throw new Error('invalid config path');
    cfg.setProjectValue(this.root, keyPath, value);
  }

  async $openConfig({ which }: { which: string }) {
    const file = which === 'user' ? cfg.userConfigFile() : cfg.projectConfigFile(this.root);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# Claudestrator ${which === 'user' ? 'user' : 'workspace'} config. Later layers override earlier ones field by field:\n# built-in defaults → ~/.claudestrator/config.yaml → <workspace>/.claudestrator/config.yaml\n{}\n`);
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  // ---------- repos ----------

  async $repos(): Promise<ReposData> {
    const r = this.orch.config();
    const configured = r.ok ? r.config.repos : {};
    const status = r.ok ? await this.engine.repoStatus() : [];
    const known = new Set(Object.values(configured).map((x) => path.resolve(this.root, x.path)));
    const detected = this.root ? findRepos(this.root).filter((d) => !known.has(d.dir)) : [];
    const ctxDir = path.join(this.root, cfg.CONFIG_DIR);
    return {
      ok: r.ok,
      errors: r.ok ? [] : r.errors.map((e) => e.message),
      repos: Object.values(configured).map((x) => ({ ...x, status: status.find((s) => s.name === x.name), suggested: describeRepo(path.resolve(this.root, x.path)).gates })),
      detected,
      context: r.ok ? r.config.context.map((f) => ({ file: f, rel: path.relative(this.root, f), exists: fs.existsSync(f), ref: path.relative(ctxDir, f) })) : [],
      baseBranch: r.ok ? r.config.baseBranch : 'main',
    };
  }

  async $saveRepo({ name, oldName, layer }: { name?: string; oldName?: string; layer: RepoLayer }) {
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Repo names use letters, digits, dots, dashes and underscores');
    const clean: RepoLayer = {
      ...(layer.role && { role: layer.role }),
      ...(layer.path && layer.path !== name && { path: layer.path }),
      ...(layer.baseBranch && { baseBranch: layer.baseBranch }),
      gates: (layer.gates || []).filter((g) => g.name && g.cmd).map((g) => ({ name: g.name, cmd: g.cmd, ...(g.dir && { dir: g.dir }), ...(g.when && { when: g.when }) })),
    };
    if (!clean.gates!.length) delete clean.gates;
    cfg.setRepo(this.root, name, clean, oldName);
  }

  async $removeRepo({ name }: { name: string }) {
    const ok = await vscode.window.showWarningMessage(`Remove "${name}" from Claudestrator?`, { modal: true, detail: 'Only the config entry is removed; the folder and its git history stay as they are.' }, 'Remove');
    if (ok) cfg.setRepo(this.root, name, undefined);
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
    const r = this.orch.config();
    const existing = !forSetup && r.ok ? Object.values(r.config.repos) : [];
    return reposFromFolders(this.root, picked.map((u) => u.fsPath), { names: existing.map((x) => x.name), dirs: existing.map((x) => path.resolve(this.root, x.path)) });
  }

  async $pickWorkspace() {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(this.root || os.homedir()), openLabel: 'Use as Claudestrator workspace', title: 'The folder that holds your repos and .claudestrator/config.yaml' })) || [];
    if (!uri) return null;
    await settings().update('workspaceFolder', uri.fsPath, vscode.ConfigurationTarget.Global);
    this.orch.rebuild();
    return uri.fsPath;
  }

  async $addDetected({ repos }: { repos: PickedRepo[] }) {
    for (const d of repos) cfg.setRepo(this.root, safeName(d.name), repoLayerOf(d));
  }

  async $runGates({ name, force }: { name: string; force?: boolean }) {
    return this.engine.runGatesNow(name, force);
  }

  async $addContext() {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: vscode.Uri.file(this.root), openLabel: 'Give to every agent', filters: { 'Text files': ['md', 'txt', 'yaml', 'yml', 'json'] } });
    if (!picked) return;
    const r = this.orch.config();
    const current = r.ok ? r.config.context : [];
    const all = [...new Set([...current, ...picked.map((u) => u.fsPath)])].map((f) => cfg.configRelative(this.root, f));
    cfg.setProjectValue(this.root, ['context'], all);
  }

  async $removeContext({ file }: { file: string }) {
    const r = this.orch.config();
    const rest = (r.ok ? r.config.context : []).filter((f) => f !== file).map((f) => cfg.configRelative(this.root, f));
    cfg.setProjectValue(this.root, ['context'], rest.length ? rest : undefined);
  }

  async $createWorkspaceMap() {
    const file = path.join(this.root, cfg.CONFIG_DIR, 'workspace.md');
    const r = this.orch.config();
    if (!fs.existsSync(file)) {
      const repos = r.ok ? Object.values(r.config.repos).map((x) => ({ name: x.name, path: x.path, ...describeRepo(path.resolve(this.root, x.path)) })) : [];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, WORKSPACE_MAP(repos));
    }
    const current = r.ok ? r.config.context : [];
    if (!current.includes(file)) {
      cfg.setProjectValue(this.root, ['context'], [...current, file].map((f) => cfg.configRelative(this.root, f)));
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  // ---------- setup ----------

  async $detect() {
    if (!this.root) return { repos: [] };
    return { root: this.root, repos: findRepos(this.root) };
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
    const file = cfg.createProjectConfig(this.root, layer, ' Claudestrator workspace config. Edit it here or in the Claudestrator dashboard.\n Layers: built-in defaults → ~/.claudestrator/config.yaml → this file.');
    if (map) {
      const mapFile = path.join(this.root, cfg.CONFIG_DIR, 'workspace.md');
      if (!fs.existsSync(mapFile)) fs.writeFileSync(mapFile, WORKSPACE_MAP(repos || []));
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
      accounts: this.orch.accounts(),
      account: this.orch.account(),
      atlassian: { site: s.get('atlassian.site') || '', email: s.get('atlassian.email') || '', hasToken: Boolean(this.orch.token), fromEnv: !this.orch.token && Boolean(process.env.ATLASSIAN_API_TOKEN), connected: Boolean(auth), mcp: this.orch.mcpIntakeServer() },
      health: this.healthSummary(),
    };
  }

  async $updateSetting({ key, value }: { key: string; value: unknown }) {
    const issues = validateSetting(key, value);
    if (issues.length) throw new Error(`invalid setting: ${issues.join('; ')}`);
    await settings().update(key, value, vscode.ConfigurationTarget.Global);
    if (key === 'claudePath' || key === 'nodePath') await this.orch.refreshHealth();
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

  html(media: vscode.Uri, scripts: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'app.js'));
    const md = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'markdown.js'));
    const task = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'task.js'));
    const conf = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'config.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: https:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Claudestrator</title>
</head>
<body>
  <div id="app"><div class="boot"><div class="spinner"></div></div></div>
  <div id="toasts" aria-live="polite"></div>
  <div id="modal-root"></div>
  <script nonce="${nonce}" src="${md}"></script>
  <script nonce="${nonce}" src="${js}"></script>
  <script nonce="${nonce}" src="${task}"></script>
  <script nonce="${nonce}" src="${conf}"></script>
</body>
</html>`;
  }
}

export type { Route };
export { DashboardPanel };
