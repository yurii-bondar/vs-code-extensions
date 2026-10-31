import * as vscode from 'vscode';
import * as path from 'path';
import { Orchestrator, settings } from './src/orchestrator';
import { TaskTree, escapeMd } from './src/tree';
import { DashboardPanel } from './src/panel';
import * as view from './src/core/view';
import { CHECKPOINT_TITLE } from './src/core/describe';
import type { Route } from './src/panel';
import type { StoredLimits } from './src/orchestrator';

let orch: Orchestrator;

const notify = (kind: string): boolean => {
  const level = settings().get<string>('notifications');
  return level === 'all' || (level === 'needsYou' && kind === 'needsYou');
};

function open(context: vscode.ExtensionContext, route?: Route): DashboardPanel {
  return DashboardPanel.show(context, orch, route);
}

async function pickTask(placeHolder: string, filter: (card: view.Card) => boolean = () => true): Promise<string | undefined> {
  const engine = orch.engine;
  if (!engine) return undefined;
  const cards = (await Promise.all((await orch.list()).map((e) => view.summary(engine, e)))).filter(filter);
  if (!cards.length) {
    vscode.window.showInformationMessage('No matching tasks.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    cards.map((c) => ({ label: c.title, description: `${c.taskId} · ${c.status.label}`, taskId: c.taskId })),
    { placeHolder, matchOnDescription: true }
  );
  return picked && picked.taskId;
}

/** What a command gets: a task id, or the tree node it was run on. */
type TaskArg = string | { card?: { taskId: string } } | undefined;

const idOf = (arg: TaskArg): string | undefined => (typeof arg === 'string' ? arg : arg && arg.card ? arg.card.taskId : undefined);

function updateStatus(item: vscode.StatusBarItem, tree: TaskTree): void {
  const c = tree.counts();
  const parts = [];
  if (c.running) parts.push(`$(sync~spin) ${c.running}`);
  if (c.attention) parts.push(`$(bell-dot) ${c.attention}`);
  item.text = parts.length ? `$(hubot) ${parts.join('  ')}` : '$(hubot)';
  const running = tree.cards.filter((x) => x.status.group === 'running');
  const waiting = tree.cards.filter((x) => x.status.group === 'attention');
  const md = new vscode.MarkdownString(undefined, true);
  // Trusted for its own two links only; the live text holds repo and gate names from the config.
  md.isTrusted = { enabledCommands: ['claudestrator.newTask', 'claudestrator.open'] };
  md.appendMarkdown('**Claudestrator**\n\n');
  for (const x of running) md.appendMarkdown(`$(sync~spin) \`${x.taskId}\` ${escapeMd((x.live && x.live.text) || 'running')}\n\n`);
  for (const x of waiting) md.appendMarkdown(`$(bell-dot) \`${x.taskId}\` ${escapeMd(x.status.label)}\n\n`);
  if (!running.length && !waiting.length) md.appendMarkdown('Nothing needs you right now.\n\n');
  md.appendMarkdown('[New task](command:claudestrator.newTask) · [Dashboard](command:claudestrator.open)');
  item.tooltip = md;
  item.backgroundColor = c.attention ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  item.show();
}

const resetIn = (unix?: number): string => {
  if (!unix) return '';
  const s = Math.max(0, Math.round(unix - Date.now() / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

/** `5h 31% · wk 26%`, like the Claude Code status line; warning colours from 80%. */
function updateLimits(item: vscode.StatusBarItem, o: Orchestrator): void {
  const l = o.limits();
  if (!l) return item.hide();
  const part = (label: string, w?: { pct: number }): string => (w ? `${label} ${w.pct}%` : '');
  item.text = `$(pulse) ${[part('5h', l.fiveHour), part('wk', l.sevenDay)].filter(Boolean).join(' · ')}`;
  const max = Math.max((l.fiveHour && l.fiveHour.pct) || 0, (l.sevenDay && l.sevenDay.pct) || 0);
  item.backgroundColor = max >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground') : max >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown('**Claude usage limits**\n\n');
  for (const [label, w] of [['5-hour', l.fiveHour], ['Weekly', l.sevenDay]] as [string, StoredLimits['fiveHour']][]) {
    if (w) md.appendMarkdown(`${label}: **${w.pct}%**${w.reset ? ' (window reset)' : w.resetsAt ? ` · resets in ${resetIn(w.resetsAt)}` : ''}\n\n`);
  }
  const mins = Math.round((Date.now() - (l.at || 0)) / 60000);
  md.appendMarkdown(`_${l.source === 'statusline' ? 'From your Claude Code status line' : 'Reported to the agents'} ${mins < 1 ? 'just now' : `${mins}m ago`}_`);
  item.tooltip = md;
  item.show();
}

function activate(context: vscode.ExtensionContext) {
  orch = new Orchestrator(context);
  const tree = new TaskTree(orch);
  const treeView = vscode.window.createTreeView('claudestrator.tasks', { treeDataProvider: tree, showCollapseAll: false });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'claudestrator.open';
  status.name = 'Claudestrator';
  const limitsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  limitsItem.command = 'claudestrator.open';
  limitsItem.name = 'Claudestrator: Claude limits';

  const refresh = async (): Promise<void> => {
    await tree.refresh();
    const c = tree.counts();
    treeView.badge = c.attention ? { value: c.attention, tooltip: `${c.attention} task${c.attention === 1 ? '' : 's'} need${c.attention === 1 ? 's' : ''} you` } : undefined;
    updateStatus(status, tree);
    updateLimits(limitsItem, orch);
  };

  orch.init().then(refresh, (e: Error) => void vscode.window.showErrorMessage(`Claudestrator could not start: ${e.message}`));

  // Notifications: a checkpoint, a finished task, a failure, a permission prompt.
  orch.onEngine(async (e) => {
    const visible = DashboardPanel.current && DashboardPanel.current.panel.visible;
    if (e.name === 'checkpoint' && notify('needsYou') && !visible) {
      const { taskId, checkpoint, title } = e.data;
      const choice = await vscode.window.showInformationMessage(`${taskId} needs you: ${CHECKPOINT_TITLE[checkpoint.id]}`, { detail: title }, 'Open');
      if (choice) open(context, { name: 'task', taskId });
    } else if (e.name === 'finished' && notify('all')) {
      const { taskId, state } = e.data;
      const prs = Object.values(state.prs || {});
      const msg = state.outcome === 'published' ? `${taskId}: draft PRs are open.` : `${taskId} is done.`;
      const choice = await vscode.window.showInformationMessage(msg, ...(prs.length ? ['Open PRs'] : []), 'Open');
      if (choice === 'Open PRs') prs.forEach((u) => vscode.env.openExternal(vscode.Uri.parse(u)));
      else if (choice) open(context, { name: 'task', taskId });
    } else if (e.name === 'log' && e.data.level === 'error' && notify('all') && !visible) {
      const { taskId, message } = e.data;
      const choice = await vscode.window.showErrorMessage(`${taskId ? `${taskId}: ` : ''}${message}`, ...(taskId ? ['Open'] : []));
      if (choice && taskId) open(context, { name: 'task', taskId });
    } else if (e.name === 'permission') {
      const p = e.data;
      const input = (typeof p.input === 'object' && p.input !== null ? p.input : {}) as { command?: unknown; file_path?: unknown };
      const what = p.tool === 'Bash' ? `run \`${String(input.command || '').slice(0, 120)}\`` : typeof input.file_path === 'string' ? `${p.tool.toLowerCase()} ${path.basename(input.file_path)}` : `use ${p.tool}`;
      const choice = await vscode.window.showWarningMessage(`${p.agent}${p.repo ? ` @ ${p.repo}` : ''} wants to ${what}`, { detail: `Task ${p.taskId}` }, 'Allow', 'Deny', 'Open');
      if (choice === 'Allow' || choice === 'Deny') orch.permissionReply(p.requestId, choice === 'Allow');
      else if (choice === 'Open') open(context, { name: 'task', taskId: p.taskId });
    }
  }, null, context.subscriptions);

  const reg = (id: string, fn: (arg: TaskArg) => unknown): vscode.Disposable => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    orch,
    treeView,
    status,
    limitsItem,
    orch.onDidChange(() => void refresh()),
    reg('claudestrator.open', () => open(context, { name: 'home' })),
    reg('claudestrator.newTask', (text) => open(context, { name: 'home', compose: typeof text === 'string' ? text : '' })),
    reg('claudestrator.checkReadiness', (text) => open(context, { name: 'home', scenario: 'readiness', compose: typeof text === 'string' ? text : '' })),
    reg('claudestrator.audit', (text) => open(context, { name: 'home', scenario: 'audit', compose: typeof text === 'string' ? text : '' })),
    reg('claudestrator.newTaskFromSelection', () => {
      const editor = vscode.window.activeTextEditor;
      const text = editor ? editor.document.getText(editor.selection) : '';
      const where = editor ? `\n\n(from ${vscode.workspace.asRelativePath(editor.document.uri)}:${editor.selection.start.line + 1})` : '';
      open(context, { name: 'home', compose: text ? `${text}${where}` : '' });
    }),
    reg('claudestrator.openTask', async (arg) => {
      const taskId = idOf(arg) || (await pickTask('Open which task?'));
      if (taskId) open(context, { name: 'task', taskId });
    }),
    reg('claudestrator.answer', async (arg) => {
      const taskId = idOf(arg) || (await pickTask('Which task?', (c) => c.status.key === 'waiting'));
      if (taskId) open(context, { name: 'task', taskId, focus: 'checkpoint' });
    }),
    reg('claudestrator.runTask', async (arg) => {
      const taskId = idOf(arg) || (await pickTask('Resume which task?', (c) => c.status.resumable));
      if (!taskId) return;
      await orch.ensureReady();
      try {
        await orch.engine!.resume(taskId);
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    }),
    reg('claudestrator.stopTask', async (arg) => {
      const taskId = idOf(arg) || (await pickTask('Stop which task?', (c) => c.status.key === 'running'));
      const engine = taskId && orch.engineOf(taskId);
      if (engine) await engine.stop(taskId);
    }),
    reg('claudestrator.revealTaskFolder', (arg) => {
      const taskId = idOf(arg);
      if (taskId) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(orch.engine!.svc.dir(taskId), 'events.ndjson')));
    }),
    reg('claudestrator.deleteTask', async (arg) => {
      const taskId = idOf(arg) || (await pickTask('Delete which task?', (c) => c.status.key !== 'running'));
      if (taskId) await open(context).$deleteTask({ taskId });
    }),
    reg('claudestrator.agents', () => open(context, { name: 'agents' })),
    reg('claudestrator.repos', () => open(context, { name: 'repos' })),
    reg('claudestrator.settings', () => open(context, { name: 'settings' })),
    reg('claudestrator.setup', () => open(context, { name: 'setup' })),
    reg('claudestrator.openConfig', () => {
      if (!orch.root) return vscode.window.showWarningMessage('Open a folder first.');
      return open(context).$openConfig({ which: 'project' });
    }),
    reg('claudestrator.checkHealth', async () => {
      const h = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking Claude Code, Git and GitHub CLI…' }, () => orch.refreshHealth());
      const line = (ok: boolean | undefined, name: string, text?: string): string => `${ok ? '✓' : '✗'} ${name}${text ? `: ${text}` : ''}`;
      const detail = [line(h.claude.ok, 'Claude Code', h.claude.version || h.claude.error), line(h.git.ok, 'Git', h.git.version), line(h.gh.ok, 'GitHub CLI', h.gh.ok ? h.gh.account || h.gh.version : h.gh.error)].join('\n');
      vscode.window.showInformationMessage(h.claude.ok && h.git.ok ? 'Claudestrator is ready.' : 'Claudestrator needs attention.', { modal: true, detail });
    }),
    reg('claudestrator.refresh', async () => {
      await orch.rebuild();
      await orch.refreshHealth();
      await refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void orch.rebuild()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudestrator.workspaceFolder')) void orch.rebuild();
      if (e.affectsConfiguration('claudestrator.claudePath')) orch.refreshHealth();
      else if (e.affectsConfiguration('claudestrator.settingSources')) orch.refreshDefaults(true);

    })
  );

  // Ages in the tree ("5m ago") drift; refresh them now and then.
  const tick = setInterval(() => tree.cards.length && void refresh(), 60000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });

  // For integration tests and other extensions.
  return { orchestrator: orch, tree, DashboardPanel };
}

async function deactivate(): Promise<void> {
  // Agents are child processes of this window; stop them cleanly so their tasks resume from the same step.
  if (orch) await orch.stopAll();
}

export { activate, deactivate };
