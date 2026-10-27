const vscode = require('vscode');
const path = require('path');
const { Orchestrator, settings } = require('./src/orchestrator');
const { TaskTree } = require('./src/tree');
const { DashboardPanel } = require('./src/panel');
const view = require('./src/core/view');
const { CHECKPOINT_TITLE } = require('./src/core/describe');

let orch;

const notify = (kind) => {
  const level = settings().get('notifications');
  return level === 'all' || (level === 'needsYou' && kind === 'needsYou');
};

function open(context, route) {
  return DashboardPanel.show(context, orch, route);
}

async function pickTask(placeHolder, filter = () => true) {
  const engine = orch.engine;
  if (!engine) return undefined;
  const cards = orch.list().map((e) => view.summary(engine, e)).filter(filter);
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

const idOf = (arg) => (typeof arg === 'string' ? arg : arg && arg.card ? arg.card.taskId : undefined);

function updateStatus(item, tree) {
  const c = tree.counts();
  const parts = [];
  if (c.running) parts.push(`$(sync~spin) ${c.running}`);
  if (c.attention) parts.push(`$(bell-dot) ${c.attention}`);
  item.text = parts.length ? `$(hubot) ${parts.join('  ')}` : '$(hubot)';
  const running = tree.cards.filter((x) => x.status.group === 'running');
  const waiting = tree.cards.filter((x) => x.status.group === 'attention');
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown('**Claudestrator**\n\n');
  for (const x of running) md.appendMarkdown(`$(sync~spin) \`${x.taskId}\` ${(x.live && x.live.text) || 'running'}\n\n`);
  for (const x of waiting) md.appendMarkdown(`$(bell-dot) \`${x.taskId}\` ${x.status.label}\n\n`);
  if (!running.length && !waiting.length) md.appendMarkdown('Nothing needs you right now.\n\n');
  md.appendMarkdown('[New task](command:claudestrator.newTask) · [Dashboard](command:claudestrator.open)');
  item.tooltip = md;
  item.backgroundColor = c.attention ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  item.show();
}

const resetIn = (unix) => {
  if (!unix) return '';
  const s = Math.max(0, Math.round(unix - Date.now() / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

/** `5h 31% · wk 26%`, like the Claude Code status line; warning colours from 80%. */
function updateLimits(item, o) {
  const l = o.limits();
  if (!l) return item.hide();
  const part = (label, w) => (w ? `${label} ${w.pct}%` : '');
  item.text = `$(pulse) ${[part('5h', l.fiveHour), part('wk', l.sevenDay)].filter(Boolean).join(' · ')}`;
  const max = Math.max((l.fiveHour && l.fiveHour.pct) || 0, (l.sevenDay && l.sevenDay.pct) || 0);
  item.backgroundColor = max >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground') : max >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown('**Claude usage limits**\n\n');
  for (const [label, w] of [['5-hour', l.fiveHour], ['Weekly', l.sevenDay]]) {
    if (w) md.appendMarkdown(`${label}: **${w.pct}%**${w.reset ? ' (window reset)' : w.resetsAt ? ` · resets in ${resetIn(w.resetsAt)}` : ''}\n\n`);
  }
  const mins = Math.round((Date.now() - (l.at || 0)) / 60000);
  md.appendMarkdown(`_${l.source === 'statusline' ? 'From your Claude Code status line' : 'Reported to the agents'} ${mins < 1 ? 'just now' : `${mins}m ago`}_`);
  item.tooltip = md;
  item.show();
}

function activate(context) {
  orch = new Orchestrator(context);
  const tree = new TaskTree(orch);
  const treeView = vscode.window.createTreeView('claudestrator.tasks', { treeDataProvider: tree, showCollapseAll: false });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'claudestrator.open';
  status.name = 'Claudestrator';
  const limitsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  limitsItem.command = 'claudestrator.open';
  limitsItem.name = 'Claudestrator: Claude limits';

  const refresh = () => {
    tree.refresh();
    const c = tree.counts();
    treeView.badge = c.attention ? { value: c.attention, tooltip: `${c.attention} task${c.attention === 1 ? '' : 's'} need${c.attention === 1 ? 's' : ''} you` } : undefined;
    updateStatus(status, tree);
    updateLimits(limitsItem, orch);
  };

  orch.init().then(refresh, (e) => vscode.window.showErrorMessage(`Claudestrator could not start: ${e.message}`));

  // Notifications: a checkpoint, a finished task, a failure, a permission prompt.
  orch.onEngine(async ({ name, data }) => {
    const visible = DashboardPanel.current && DashboardPanel.current.panel.visible;
    if (name === 'checkpoint' && notify('needsYou') && !visible) {
      const choice = await vscode.window.showInformationMessage(`${data.taskId} needs you: ${CHECKPOINT_TITLE[data.checkpoint.id]}`, { detail: data.title }, 'Open');
      if (choice) open(context, { name: 'task', taskId: data.taskId });
    } else if (name === 'finished' && notify('all')) {
      const prs = Object.values(data.state.prs || {});
      const msg = data.state.outcome === 'published' ? `${data.taskId}: draft PRs are open.` : `${data.taskId} is done.`;
      const choice = await vscode.window.showInformationMessage(msg, ...(prs.length ? ['Open PRs'] : []), 'Open');
      if (choice === 'Open PRs') prs.forEach((u) => vscode.env.openExternal(vscode.Uri.parse(u)));
      else if (choice) open(context, { name: 'task', taskId: data.taskId });
    } else if (name === 'log' && data.level === 'error' && notify('all') && !visible) {
      const choice = await vscode.window.showErrorMessage(`${data.taskId ? `${data.taskId}: ` : ''}${data.message}`, ...(data.taskId ? ['Open'] : []));
      if (choice) open(context, { name: 'task', taskId: data.taskId });
    } else if (name === 'permission') {
      const what = data.tool === 'Bash' ? `run \`${String((data.input && data.input.command) || '').slice(0, 120)}\`` : data.input && data.input.file_path ? `${data.tool.toLowerCase()} ${path.basename(data.input.file_path)}` : `use ${data.tool}`;
      const choice = await vscode.window.showWarningMessage(`${data.agent}${data.repo ? ` @ ${data.repo}` : ''} wants to ${what}`, { detail: `Task ${data.taskId}` }, 'Allow', 'Deny', 'Open');
      if (choice === 'Allow' || choice === 'Deny') orch.engine && orch.engine.permissionReply(data.requestId, choice === 'Allow');
      else if (choice === 'Open') open(context, { name: 'task', taskId: data.taskId });
    }
  }, null, context.subscriptions);

  const reg = (id, fn) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    orch,
    treeView,
    status,
    limitsItem,
    orch.onDidChange(refresh),
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
      const taskId = idOf(arg) || (await pickTask('Resume which task?', (c) => ['stopped', 'failed', 'interrupted', 'ready'].includes(c.status.key)));
      if (!taskId) return;
      await orch.ensureReady();
      try {
        orch.engine.resume(taskId);
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    }),
    reg('claudestrator.stopTask', async (arg) => {
      const taskId = idOf(arg) || (await pickTask('Stop which task?', (c) => c.status.key === 'running'));
      if (taskId) await orch.engine.stop(taskId);
    }),
    reg('claudestrator.revealTaskFolder', (arg) => {
      const taskId = idOf(arg);
      if (taskId) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(orch.engine.svc.dir(taskId), 'events.ndjson')));
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
      const line = (ok, name, text) => `${ok ? '✓' : '✗'} ${name}${text ? `: ${text}` : ''}`;
      const detail = [line(h.claude.ok, 'Claude Code', h.claude.version || h.claude.error), line(h.git.ok, 'Git', h.git.version), line(h.gh.ok, 'GitHub CLI', h.gh.ok ? h.gh.account || h.gh.version : h.gh.error)].join('\n');
      vscode.window.showInformationMessage(h.claude.ok && h.git.ok ? 'Claudestrator is ready.' : 'Claudestrator needs attention.', { modal: true, detail });
    }),
    reg('claudestrator.refresh', async () => {
      orch.rebuild();
      await orch.refreshHealth();
      refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => orch.rebuild()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudestrator.workspaceFolder')) orch.rebuild();
      if (e.affectsConfiguration('claudestrator.claudePath') || e.affectsConfiguration('claudestrator.nodePath')) orch.refreshHealth();
      else if (e.affectsConfiguration('claudestrator.settingSources')) orch.refreshDefaults(true);

    })
  );

  // Ages in the tree ("5m ago") drift; refresh them now and then.
  const tick = setInterval(() => tree.cards.length && refresh(), 60000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });

  // For integration tests and other extensions.
  return { orchestrator: orch, tree, DashboardPanel };
}

async function deactivate() {
  // Agents are child processes of this window; stop them cleanly so their tasks resume from the same step.
  if (orch && orch.engine) await orch.engine.stopAll();
}

module.exports = { activate, deactivate };
