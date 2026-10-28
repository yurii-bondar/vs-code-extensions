import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as sessions from './sessions';
import { BIG_SESSION_BYTES, hueOf, initials } from './format';
import { parseSidebarMessage } from './sidebarMessages';
import type { AccountStore } from './accounts';
import type { Account, Session } from './types';
import type { AccountCard, ClientMessage, HostMessage, SessionRow, SidebarState } from './sidebarWire';

/** What a command is run on from the sidebar. */
export type Target = { kind: 'account'; account: Account } | { kind: 'session'; session: Session };

/** How many colors the page's palette has. */
const HUES = 8;

const keyOf = (s: Session): string => `${s.account.dir}|${s.id}`;

export class Sidebar implements vscode.WebviewViewProvider {
  static readonly viewType = 'ctxMan.sessions';
  allProjects = false;
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private byKey = new Map<string, Session>();

  constructor(
    private readonly store: AccountStore,
    private readonly extensionUri: vscode.Uri
  ) {
    store.onDidChange(() => void this.refresh());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const scripts = vscode.Uri.joinPath(this.extensionUri, 'dist', 'media');
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [media, scripts] };
    view.webview.html = this.html(view.webview, media, scripts);
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseSidebarMessage(raw);
      if (message) void this.onMessage(message);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.describe();
  }

  /** Shown next to the view title. */
  describe(): void {
    if (this.view) this.view.description = this.allProjects ? 'all projects' : 'this workspace';
  }

  async refresh(): Promise<void> {
    const view = this.view;
    if (!view || !this.ready) return;
    const state = await this.build();
    const message: HostMessage = { type: 'state', state };
    void view.webview.postMessage(message);
  }

  private async build(): Promise<SidebarState> {
    const max = vscode.workspace.getConfiguration('ctxMan').get<number>('maxSessionsPerAccount') || 30;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const active = this.store.active;
    // The active account goes first, so the one in use is always at the top.
    const ordered = [...this.store.accounts].sort((a, b) => Number(b.dir === active?.dir) - Number(a.dir === active?.dir));
    const byKey = new Map<string, Session>();
    const accounts: AccountCard[] = [];
    for (const account of ordered) {
      const all = sessions.listSessions(account);
      const list = this.allProjects || !folders.length ? all : all.filter((s) => sessions.inWorkspace(s, folders));
      const rows = list.slice(0, max).map((s): SessionRow => {
        byKey.set(keyOf(s), s);
        return {
          key: keyOf(s),
          title: s.title,
          mtime: s.mtime,
          bytes: s.size,
          big: s.size > BIG_SESSION_BYTES,
          branch: s.branch,
          project: s.cwd ? path.basename(s.cwd) : '',
          lastPrompt: s.lastPrompt.replace(/\s+/g, ' ').slice(0, 220),
        };
      });
      accounts.push({
        dir: account.dir,
        label: account.label,
        email: account.email,
        org: account.org,
        initials: initials(account.label),
        hue: hueOf(account.dir, HUES),
        active: account.dir === active?.dir,
        loggedIn: await this.store.loginState(account),
        total: list.length,
        sessions: rows,
      });
    }
    this.byKey = byKey;
    return { allProjects: this.allProjects, hasWorkspace: folders.length > 0, accounts, hidden: this.store.all.length - this.store.accounts.length };
  }

  private async onMessage(message: ClientMessage): Promise<void> {
    const run = (command: string, target?: Target): Thenable<unknown> => vscode.commands.executeCommand(command, target);
    switch (message.type) {
      case 'ready':
        this.ready = true;
        await this.refresh();
        return;
      case 'scope':
        await vscode.commands.executeCommand(message.all ? 'ctxMan.showAllProjects' : 'ctxMan.showWorkspaceOnly');
        return;
      case 'tool': {
        const command = { statusline: 'ctxMan.configureStatusLine', aiFiles: 'ctxMan.setupAiFiles', addAccount: 'ctxMan.addAccount', showHidden: 'ctxMan.showHiddenAccounts', refresh: 'ctxMan.refresh' }[message.tool];
        await run(command);
        return;
      }
      case 'account': {
        const account = this.store.byDir(message.dir);
        if (!account) return;
        const target: Target = { kind: 'account', account };
        await run({ use: 'ctxMan.activateAccount', new: 'ctxMan.openTerminal', hide: 'ctxMan.hideAccount' }[message.action], target);
        return;
      }
      case 'session': {
        const session = this.byKey.get(message.key);
        if (!session) return;
        const target: Target = { kind: 'session', session };
        await run({ resume: 'ctxMan.resumeHere', continue: 'ctxMan.continueOnAccount', handoff: 'ctxMan.exportHandoff', copy: 'ctxMan.copySessionId', reveal: 'ctxMan.revealSession' }[message.action], target);
        return;
      }
      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri, scripts: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'sidebar.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Claude Accounts</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
