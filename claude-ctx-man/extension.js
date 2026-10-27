const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountStore, ENV_KEY, expand } = require('./src/accounts');
const { SessionTree, ago, BIG_SESSION_BYTES } = require('./src/tree');
const sessions = require('./src/sessions');
const { StatusLinePanel } = require('./src/statusline');

const config = () => vscode.workspace.getConfiguration('ctxMan');

let store;
let tree;
let view;

function workspaceRoot(preferPath) {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  return folders.find((f) => preferPath && (preferPath === f || preferPath.startsWith(f + path.sep))) || folders[0];
}

function launch(account, cwd, args = []) {
  const terminal = vscode.window.createTerminal({
    name: `Claude · ${account.label}`,
    cwd: cwd && fs.existsSync(cwd) ? cwd : workspaceRoot(),
    env: { [ENV_KEY]: account.dir },
    iconPath: new vscode.ThemeIcon('sparkle'),
  });
  terminal.show();
  terminal.sendText([config().get('claudeCommand') || 'claude', ...args].join(' '));
}

async function pickAccount(placeHolder, exclude) {
  const active = store.active;
  const items = [];
  for (const account of store.accounts) {
    if (exclude && exclude.dir === account.dir) continue;
    const loggedIn = await store.loginState(account);
    items.push({
      label: `${active && active.dir === account.dir ? '$(pass-filled)' : loggedIn ? '$(account)' : '$(warning)'} ${account.label}`,
      description: [active && active.dir === account.dir ? 'active' : '', account.email, account.org].filter(Boolean).join(' · ') || (loggedIn ? '' : 'not logged in'),
      detail: account.dir,
      account,
    });
  }
  if (!items.length) {
    vscode.window.showWarningMessage('No other Claude Code accounts found. Add one with "Claude Ctx Man: Add Account Folder…".');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
  return picked && picked.account;
}

async function pickSession(placeHolder) {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const all = store.accounts.flatMap((a) => sessions.listSessions(a)).sort((a, b) => b.mtime - a.mtime);
  const here = folders.length ? all.filter((s) => sessions.inWorkspace(s, folders)) : [];
  const list = (here.length ? here : all).slice(0, 50);
  if (!list.length) {
    vscode.window.showInformationMessage('No Claude Code sessions yet. Start one with the + next to an account.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((s) => ({ label: s.title, description: `${s.account.label} · ${ago(s.mtime)}`, detail: s.cwd, session: s })),
    { placeHolder, matchOnDescription: true, matchOnDetail: true }
  );
  return picked && picked.session;
}

const sessionOf = async (node, placeHolder) => (node && node.session) || pickSession(placeHolder);

async function switchTo(account) {
  const applied = await store.activate(account);
  const actions = ['Start Claude'];
  if (applied.includes('extension')) actions.push('Reload Claude Code Extension');
  const users = [];
  if (applied.includes('terminals')) users.push('new terminals');
  if (applied.includes('extension')) users.push('the Claude Code extension (after a reload)');
  const who = users.join(' and ');
  const where = who ? ` ${who[0].toUpperCase()}${who.slice(1)} use it now.` : '';
  const choice = await vscode.window.showInformationMessage(`Now using ${account.label}${account.email ? ` (${account.email})` : ''}.${where}`, ...actions);
  if (choice === 'Start Claude') launch(account, workspaceRoot());
  else if (choice === 'Reload Claude Code Extension') vscode.commands.executeCommand('workbench.action.restartExtensionHost');
}

async function continueOnAccount(node) {
  const session = await sessionOf(node, 'Which session should continue on another account?');
  if (!session) return;
  const target = await pickAccount(`Continue "${session.title}" on…`, session.account);
  if (!target) return;

  if (session.cwd && !fs.existsSync(session.cwd)) {
    const go = await vscode.window.showWarningMessage(`The session's folder no longer exists:\n${session.cwd}\nClaude finds sessions by folder, so resume may fail.`, { modal: true }, 'Continue anyway');
    if (!go) return;
  }

  const dest = sessions.targetFile(session, target);
  let copy = true;
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs > session.mtime) {
    const choice = await vscode.window.showWarningMessage(
      `${target.label} already has a newer copy of this session (it was continued there).`,
      { modal: true, detail: `Overwriting replaces that copy with the older one from ${session.account.label}.` },
      'Resume That Copy',
      'Overwrite'
    );
    if (!choice) return;
    copy = choice === 'Overwrite';
  }
  if (copy) sessions.copySession(session, target);

  if (!(await store.loginState(target))) {
    vscode.window.showWarningMessage(`${target.label} does not look logged in. Claude will ask you to log in first.`);
  }
  launch(target, session.cwd, ['--resume', session.id]);
  if (config().get('switchActiveOnContinue')) await store.activate(target);
  if (session.size > BIG_SESSION_BYTES) {
    vscode.window.showInformationMessage(`This session is ${(session.size / 1024 / 1024).toFixed(1)} MB. Its full context is sent again on ${target.label}; run /compact first to use fewer of that account's limits.`);
  }
  tree.refresh();
}

async function exportHandoff(node) {
  const session = await sessionOf(node, 'Which session should be handed off?');
  if (!session) return;
  const markdown = sessions.buildHandoff(session, { maxMessages: config().get('handoffMessages') || 12 });
  await vscode.env.clipboard.writeText(markdown);
  const root = workspaceRoot(session.cwd);
  if (!root) {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage('Handoff copied to the clipboard. Paste it into Cursor chat or any other tool.');
    return;
  }
  const dir = path.join(root, config().get('handoffDir') || '.ctx-man');
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const file = path.join(dir, `handoff-${session.id.slice(0, 8)}.md`);
  fs.writeFileSync(file, markdown);
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  vscode.window.showInformationMessage(`Handoff saved to ${path.relative(root, file)} and copied. In Cursor, @-mention this file or paste it into the chat.`);
}

async function sessionActions(node) {
  const s = node.session;
  const items = [
    { label: '$(play) Resume', description: `on ${s.account.label}`, run: () => launch(s.account, s.cwd, ['--resume', s.id]) },
    { label: '$(arrow-swap) Continue on another account…', description: 'e.g. when this one hit its limit', run: () => continueOnAccount(node) },
    { label: '$(export) Hand off to Cursor / other tool', description: 'summary file + clipboard', run: () => exportHandoff(node) },
    { kind: vscode.QuickPickItemKind.Separator, label: '' },
    { label: '$(copy) Copy session ID', run: () => vscode.env.clipboard.writeText(s.id) },
    { label: '$(file) Reveal transcript file', run: () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.file)) },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: `What to do with "${s.title}"?` });
  if (picked && picked.run) await picked.run();
}

async function addAccount() {
  const [uri] = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(os.homedir()), openLabel: 'Use as Claude config folder' })) || [];
  if (!uri) return;
  const label = await vscode.window.showInputBox({ prompt: 'Short name for this account', value: path.basename(uri.fsPath).replace(/^\.claude-?/, '') || 'account' });
  if (label === undefined) return;
  const list = (config().inspect('accounts').globalValue || []).filter((a) => a && expand(a.configDir) !== uri.fsPath);
  list.push({ label, configDir: uri.fsPath });
  await config().update('accounts', list, vscode.ConfigurationTarget.Global);
}

function updateStatus(item) {
  const a = store.active;
  item.text = `$(account) ${a ? a.label : 'Claude'}`;
  item.tooltip = a ? `Claude account: ${a.label}${a.email ? `\n${a.email}` : ''}\n\nClick to switch` : 'Switch Claude account';
  item.show();
}

// Running sessions append to their transcript constantly, so refreshes are debounced.
let watchers = [];
function watchSessions() {
  watchers.forEach((w) => w.dispose());
  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => tree.refresh(), 2000);
  };
  watchers = store.accounts.map((a) => {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(a.dir), 'projects/*/*.jsonl'));
    w.onDidCreate(refresh);
    w.onDidChange(refresh);
    w.onDidDelete(refresh);
    return w;
  });
}

function setAllProjects(on) {
  tree.allProjects = on;
  view.description = on ? 'all projects' : 'this workspace';
  vscode.commands.executeCommand('setContext', 'ctxMan.allProjects', on);
  tree.refresh();
}

function activate(context) {
  store = new AccountStore(context);
  tree = new SessionTree(store);
  watchSessions();
  context.subscriptions.push({ dispose: () => watchers.forEach((w) => w.dispose()) });

  view = vscode.window.createTreeView('ctxMan.sessions', { treeDataProvider: tree, showCollapseAll: true });
  setAllProjects(false);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.command = 'ctxMan.switchAccount';
  updateStatus(status);

  const reg = (id, fn) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    status,
    view,
    store.onDidChange(() => updateStatus(status)),
    reg('ctxMan.switchAccount', async () => {
      const account = await pickAccount('Switch the active Claude Code account');
      if (account) await switchTo(account);
    }),
    reg('ctxMan.activateAccount', (node) => node && node.account && switchTo(node.account)),
    reg('ctxMan.openTerminal', (node) => launch((node && node.account) || store.active, workspaceRoot())),
    reg('ctxMan.continueOnAccount', continueOnAccount),
    reg('ctxMan.resumeHere', async (node) => {
      const s = await sessionOf(node, 'Which session should be resumed?');
      if (s) launch(s.account, s.cwd, ['--resume', s.id]);
    }),
    reg('ctxMan.exportHandoff', exportHandoff),
    reg('ctxMan.sessionActions', sessionActions),
    reg('ctxMan.revealSession', (node) => node && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.session.file))),
    reg('ctxMan.copySessionId', (node) => node && vscode.env.clipboard.writeText(node.session.id)),
    reg('ctxMan.addAccount', addAccount),
    reg('ctxMan.configureStatusLine', () => StatusLinePanel.show(context, store)),
    reg('ctxMan.hideAccount', (node) => node && node.account && store.setHidden(node.account, true)),
    reg('ctxMan.showHiddenAccounts', async () => {
      const hidden = store.all.filter((a) => store.isHidden(a));
      if (!hidden.length) return vscode.window.showInformationMessage('No hidden accounts.');
      const picked = await vscode.window.showQuickPick(
        hidden.map((a) => ({ label: a.label, description: a.email, detail: a.dir, account: a })),
        { canPickMany: true, placeHolder: 'Select accounts to show again' }
      );
      for (const p of picked || []) await store.setHidden(p.account, false);
    }),
    reg('ctxMan.refresh', () => {
      store.refreshLogins();
      store.reload();
    }),
    reg('ctxMan.toggleAllProjects', () => setAllProjects(!tree.allProjects)),
    reg('ctxMan.showAllProjects', () => setAllProjects(true)),
    reg('ctxMan.showWorkspaceOnly', () => setAllProjects(false)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (['accounts', 'autoDiscover', 'hiddenAccounts'].some((k) => e.affectsConfiguration(`ctxMan.${k}`))) {
        store.reload();
        watchSessions();
      } else if (e.affectsConfiguration('ctxMan.maxSessionsPerAccount')) {
        tree.refresh();
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
