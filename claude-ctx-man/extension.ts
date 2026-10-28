import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountStore } from './src/accounts';
import { ENV_KEY, expand } from './src/configdir';
import { Sidebar } from './src/sidebar';
import { BIG_SESSION_BYTES, ago } from './src/format';
import * as sessions from './src/sessions';
import { StatusLinePanel } from './src/statusline';
import { setupAiFiles } from './src/setupAi';
import type { Target } from './src/sidebar';
import type { Account, Session } from './src/types';

const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('ctxMan');

let store: AccountStore;
let sidebar: Sidebar;

/** What a command gets when it is run from the sidebar: what it was run on. */
type Arg = Target | undefined;

const accountOf = (node: Arg): Account | undefined => (node && node.kind === 'account' ? node.account : undefined);
const sessionOfNode = (node: Arg): Session | undefined => (node && node.kind === 'session' ? node.session : undefined);

function workspaceRoot(preferPath?: string): string | undefined {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  return folders.find((f) => preferPath && (preferPath === f || preferPath.startsWith(f + path.sep))) ?? folders[0];
}

function launch(account: Account, cwd: string | undefined, args: string[] = []): void {
  const dir = cwd && fs.existsSync(cwd) ? cwd : workspaceRoot();
  const terminal = vscode.window.createTerminal({
    name: `Claude · ${account.label}`,
    ...(dir ? { cwd: dir } : {}),
    env: { [ENV_KEY]: account.dir },
    iconPath: new vscode.ThemeIcon('sparkle'),
  });
  terminal.show();
  terminal.sendText([config().get<string>('claudeCommand') || 'claude', ...args].join(' '));
}

interface AccountPick extends vscode.QuickPickItem {
  account: Account;
}

async function pickAccount(placeHolder: string, exclude?: Account): Promise<Account | undefined> {
  const active = store.active;
  const items: AccountPick[] = [];
  for (const account of store.accounts) {
    if (exclude && exclude.dir === account.dir) continue;
    const loggedIn = await store.loginState(account);
    const isActive = active?.dir === account.dir;
    items.push({
      label: `${isActive ? '$(pass-filled)' : loggedIn ? '$(account)' : '$(warning)'} ${account.label}`,
      description: [isActive ? 'active' : '', account.email, account.org].filter(Boolean).join(' · ') || (loggedIn ? '' : 'not logged in'),
      detail: account.dir,
      account,
    });
  }
  if (!items.length) {
    vscode.window.showWarningMessage('No other Claude Code accounts found. Add one with "Claude Ctx Man: Add Account Folder…".');
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true }))?.account;
}

interface SessionPick extends vscode.QuickPickItem {
  session: Session;
}

async function pickSession(placeHolder: string): Promise<Session | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const all = store.accounts.flatMap((a) => sessions.listSessions(a)).sort((a, b) => b.mtime - a.mtime);
  const here = folders.length ? all.filter((s) => sessions.inWorkspace(s, folders)) : [];
  const list = (here.length ? here : all).slice(0, 50);
  if (!list.length) {
    vscode.window.showInformationMessage('No Claude Code sessions yet. Start one with the + next to an account.');
    return undefined;
  }
  const items: SessionPick[] = list.map((s) => ({ label: s.title, description: `${s.account.label} · ${ago(s.mtime)}`, detail: s.cwd, session: s }));
  return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true }))?.session;
}

const sessionFrom = (node: Arg, placeHolder: string): Promise<Session | undefined> => {
  const own = sessionOfNode(node);
  return own ? Promise.resolve(own) : pickSession(placeHolder);
};

async function switchTo(account: Account): Promise<void> {
  const applied = await store.activate(account);
  const actions = ['Start Claude'];
  if (applied.includes('extension')) actions.push('Reload Claude Code Extension');
  const users: string[] = [];
  if (applied.includes('terminals')) users.push('new terminals');
  if (applied.includes('extension')) users.push('the Claude Code extension (after a reload)');
  const who = users.join(' and ');
  const where = who ? ` ${who[0]?.toUpperCase() ?? ''}${who.slice(1)} use it now.` : '';
  const choice = await vscode.window.showInformationMessage(`Now using ${account.label}${account.email ? ` (${account.email})` : ''}.${where}`, ...actions);
  if (choice === 'Start Claude') launch(account, workspaceRoot());
  else if (choice === 'Reload Claude Code Extension') vscode.commands.executeCommand('workbench.action.restartExtensionHost');
}

async function continueOnAccount(node?: Arg): Promise<void> {
  const session = await sessionFrom(node, 'Which session should continue on another account?');
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
  if (config().get<boolean>('switchActiveOnContinue')) await store.activate(target);
  if (session.size > BIG_SESSION_BYTES) {
    vscode.window.showInformationMessage(`This session is ${(session.size / 1024 / 1024).toFixed(1)} MB. Its full context is sent again on ${target.label}; run /compact first to use fewer of that account's limits.`);
  }
  void sidebar.refresh();
}

async function exportHandoff(node?: Arg): Promise<void> {
  const session = await sessionFrom(node, 'Which session should be handed off?');
  if (!session) return;
  const markdown = sessions.buildHandoff(session, { maxMessages: config().get<number>('handoffMessages') || 12 });
  await vscode.env.clipboard.writeText(markdown);
  const root = workspaceRoot(session.cwd);
  if (!root) {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage('Handoff copied to the clipboard. Paste it into Cursor chat or any other tool.');
    return;
  }
  const dir = path.join(root, config().get<string>('handoffDir') || '.ctx-man');
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const file = path.join(dir, `handoff-${session.id.slice(0, 8)}.md`);
  fs.writeFileSync(file, markdown);
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  vscode.window.showInformationMessage(`Handoff saved to ${path.relative(root, file)} and copied. In Cursor, @-mention this file or paste it into the chat.`);
}

interface ActionPick extends vscode.QuickPickItem {
  run?: () => unknown;
}

async function sessionActions(node: Arg): Promise<void> {
  const s = sessionOfNode(node);
  if (!s) return;
  const items: ActionPick[] = [
    { label: '$(play) Resume', description: `on ${s.account.label}`, run: () => launch(s.account, s.cwd, ['--resume', s.id]) },
    { label: '$(arrow-swap) Continue on another account…', description: 'e.g. when this one hit its limit', run: () => continueOnAccount(node) },
    { label: '$(export) Hand off to Cursor / other tool', description: 'summary file + clipboard', run: () => exportHandoff(node) },
    { kind: vscode.QuickPickItemKind.Separator, label: '' },
    { label: '$(copy) Copy session ID', run: () => vscode.env.clipboard.writeText(s.id) },
    { label: '$(file) Reveal transcript file', run: () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.file)) },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: `What to do with "${s.title}"?` });
  if (picked?.run) await picked.run();
}

async function addAccount(): Promise<void> {
  const [uri] = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(os.homedir()), openLabel: 'Use as Claude config folder' })) ?? [];
  if (!uri) return;
  const label = await vscode.window.showInputBox({ prompt: 'Short name for this account', value: path.basename(uri.fsPath).replace(/^\.claude-?/, '') || 'account' });
  if (label === undefined) return;
  const saved = config().inspect<{ label?: string; configDir?: string }[]>('accounts')?.globalValue ?? [];
  const list = saved.filter((a) => a && typeof a.configDir === 'string' && expand(a.configDir) !== uri.fsPath);
  list.push({ label, configDir: uri.fsPath });
  await config().update('accounts', list, vscode.ConfigurationTarget.Global);
}

function updateStatus(item: vscode.StatusBarItem): void {
  const a = store.active;
  item.text = `$(account) ${a ? a.label : 'Claude'}`;
  item.tooltip = a ? `Claude account: ${a.label}${a.email ? `\n${a.email}` : ''}\n\nClick to switch` : 'Switch Claude account';
  item.show();
}

// Running sessions append to their transcript constantly, so refreshes are debounced.
let watchers: vscode.FileSystemWatcher[] = [];
function watchSessions(): void {
  for (const w of watchers) w.dispose();
  let timer: NodeJS.Timeout | undefined;
  const refresh = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void sidebar.refresh(), 2000);
  };
  watchers = store.accounts.map((a) => {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(a.dir), 'projects/*/*.jsonl'));
    w.onDidCreate(refresh);
    w.onDidChange(refresh);
    w.onDidDelete(refresh);
    return w;
  });
}

function setAllProjects(on: boolean): void {
  sidebar.allProjects = on;
  sidebar.describe();
  vscode.commands.executeCommand('setContext', 'ctxMan.allProjects', on);
  void sidebar.refresh();
}

export function activate(context: vscode.ExtensionContext): void {
  store = new AccountStore(context);
  sidebar = new Sidebar(store, context.extensionUri);
  watchSessions();
  context.subscriptions.push({ dispose: () => watchers.forEach((w) => w.dispose()) }, store);

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(Sidebar.viewType, sidebar));
  setAllProjects(false);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.command = 'ctxMan.switchAccount';
  updateStatus(status);

  const reg = (id: string, fn: (node?: Arg) => unknown): vscode.Disposable => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    status,
    store.onDidChange(() => updateStatus(status)),
    reg('ctxMan.switchAccount', async () => {
      const account = await pickAccount('Switch the active Claude Code account');
      if (account) await switchTo(account);
    }),
    reg('ctxMan.activateAccount', (node) => {
      const account = accountOf(node);
      return account && switchTo(account);
    }),
    reg('ctxMan.openTerminal', (node) => {
      const account = accountOf(node) ?? store.active;
      if (account) launch(account, workspaceRoot());
    }),
    reg('ctxMan.continueOnAccount', continueOnAccount),
    reg('ctxMan.resumeHere', async (node) => {
      const s = await sessionFrom(node, 'Which session should be resumed?');
      if (s) launch(s.account, s.cwd, ['--resume', s.id]);
    }),
    reg('ctxMan.exportHandoff', exportHandoff),
    reg('ctxMan.sessionActions', sessionActions),
    reg('ctxMan.revealSession', (node) => {
      const s = sessionOfNode(node);
      return s && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.file));
    }),
    reg('ctxMan.copySessionId', (node) => {
      const s = sessionOfNode(node);
      return s && vscode.env.clipboard.writeText(s.id);
    }),
    reg('ctxMan.addAccount', addAccount),
    reg('ctxMan.setupAiFiles', () => setupAiFiles(context)),
    reg('ctxMan.configureStatusLine', () => StatusLinePanel.show(context, store)),
    reg('ctxMan.hideAccount', (node) => {
      const account = accountOf(node);
      return account && store.setHidden(account, true);
    }),
    reg('ctxMan.showHiddenAccounts', async () => {
      const hidden = store.all.filter((a) => store.isHidden(a));
      if (!hidden.length) return vscode.window.showInformationMessage('No hidden accounts.');
      const items: AccountPick[] = hidden.map((a) => ({ label: a.label, description: a.email, detail: a.dir, account: a }));
      const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Select accounts to show again' });
      for (const p of picked ?? []) await store.setHidden(p.account, false);
      return undefined;
    }),
    reg('ctxMan.refresh', () => {
      store.refreshLogins();
      store.reload();
    }),
    reg('ctxMan.toggleAllProjects', () => setAllProjects(!sidebar.allProjects)),
    reg('ctxMan.showAllProjects', () => setAllProjects(true)),
    reg('ctxMan.showWorkspaceOnly', () => setAllProjects(false)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (['accounts', 'autoDiscover', 'hiddenAccounts'].some((k) => e.affectsConfiguration(`ctxMan.${k}`))) {
        store.reload();
        watchSessions();
      } else if (e.affectsConfiguration('ctxMan.maxSessionsPerAccount')) {
        void sidebar.refresh();
      }
    })
  );
}

export function deactivate(): void {}
