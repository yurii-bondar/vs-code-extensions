const vscode = require('vscode');
const path = require('path');
const sessions = require('./sessions');

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

const size = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

class SessionTree {
  constructor(store) {
    this.store = store;
    this.allProjects = false;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    store.onDidChange(() => this.refresh());
  }

  refresh() {
    this.emitter.fire();
  }

  workspaceFolders() {
    return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  }

  sessionsFor(account) {
    const folders = this.workspaceFolders();
    const list = sessions.listSessions(account);
    return this.allProjects || !folders.length ? list : list.filter((s) => sessions.inWorkspace(s, folders));
  }

  async getChildren(node) {
    const max = vscode.workspace.getConfiguration('ctxMan').get('maxSessionsPerAccount') || 30;
    if (!node) return this.store.accounts.map((account) => ({ kind: 'account', account }));
    if (node.kind === 'account') {
      const list = this.sessionsFor(node.account);
      if (!this.allProjects) return list.slice(0, max).map((session) => ({ kind: 'session', session }));
      const byProject = new Map();
      for (const s of list) {
        if (!byProject.has(s.projectDir)) byProject.set(s.projectDir, []);
        byProject.get(s.projectDir).push(s);
      }
      return [...byProject.values()].map((items) => ({ kind: 'project', items: items.slice(0, max) }));
    }
    if (node.kind === 'project') return node.items.map((session) => ({ kind: 'session', session }));
    return [];
  }

  async getTreeItem(node) {
    if (node.kind === 'account') {
      const { account } = node;
      const active = this.store.active && this.store.active.dir === account.dir;
      const loggedIn = await this.store.loginState(account);
      const count = this.sessionsFor(account).length;
      const item = new vscode.TreeItem(account.label, active || count ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      const who = account.email || (loggedIn ? 'email unknown' : 'not logged in');
      item.description = [active ? '● active' : '', who, `${count} session${count === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
      // A Keychain login without a cached profile happens when .claude.json was lost; /status inside Claude shows the account.
      const unknown = loggedIn && !account.email ? '\n\nThe account email is not cached in this folder. Open a Claude terminal here and run `/status` to see it.' : '';
      item.tooltip = new vscode.MarkdownString(
        `**${account.label}**${active ? ' (active)' : ''}\n\n${account.email ? `${account.email}${account.org ? ` · ${account.org}` : ''}\n\n` : ''}Login: ${loggedIn ? 'yes' : 'no'}${unknown}\n\n\`${account.dir}\``
      );
      item.iconPath = new vscode.ThemeIcon(active ? 'pass-filled' : loggedIn ? 'account' : 'circle-slash');
      item.contextValue = active ? 'account-active' : 'account';
      return item;
    }
    if (node.kind === 'project') {
      const first = node.items[0];
      const label = first.cwd ? path.basename(first.cwd) : first.projectDir;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${node.items.length} · ${ago(first.mtime)}`;
      item.tooltip = first.cwd || first.projectDir;
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const s = node.session;
    const item = new vscode.TreeItem(short(s.title, 70), vscode.TreeItemCollapsibleState.None);
    item.description = `${ago(s.mtime)} · ${size(s.size)}`;
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${s.title}**\n\n`);
    if (s.lastPrompt) tip.appendMarkdown(`Last prompt: ${short(s.lastPrompt.replace(/\s+/g, ' '), 200)}\n\n`);
    tip.appendMarkdown(`${s.cwd ? `\`${s.cwd}\`` : ''}${s.branch ? ` · ${s.branch}` : ''}\n\n`);
    tip.appendMarkdown(`Account **${s.account.label}** · ${new Date(s.mtime).toLocaleString()} · ${size(s.size)}\n\n\`${s.id}\``);
    item.tooltip = tip;
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.contextValue = 'session';
    item.command = { command: 'ctxMan.sessionActions', title: 'Session actions', arguments: [node] };
    return item;
  }
}

module.exports = { SessionTree, ago };
