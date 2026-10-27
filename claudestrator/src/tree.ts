// Sidebar: tasks grouped by what they need from you.
import * as vscode from 'vscode';
import * as view from './core/view';
import type { Orchestrator } from './orchestrator';

interface Group {
  id: string;
  label: string;
  icon: string;
  expanded: boolean;
}

/** A row of the tree: a group of cards, or a card. */
type TreeNode = { group: Group } | { card: view.Card };

const GROUPS: Group[] = [
  { id: 'attention', label: 'Needs you', icon: 'bell-dot', expanded: true },
  { id: 'running', label: 'Running', icon: 'sync', expanded: true },
  { id: 'stopped', label: 'Paused', icon: 'debug-pause', expanded: true },
  { id: 'done', label: 'Finished', icon: 'pass', expanded: false },
];

const STATUS_ICON: Record<string, [string, string]> = {
  running: ['sync~spin', 'charts.blue'],
  waiting: ['bell-dot', 'charts.yellow'],
  failed: ['error', 'errorForeground'],
  interrupted: ['debug-disconnect', 'charts.orange'],
  corrupt: ['warning', 'errorForeground'],
  stopped: ['debug-pause', 'descriptionForeground'],
  ready: ['debug-continue', 'descriptionForeground'],
  done: ['pass-filled', 'testing.iconPassed'],
};

function ago(iso?: string): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

class TaskTree implements vscode.TreeDataProvider<TreeNode> {
  orch: Orchestrator;
  _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | void>;
  onDidChangeTreeData: vscode.Event<TreeNode | undefined | void>;
  cards: view.Card[];

  constructor(orch: Orchestrator) {
    this.orch = orch;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.cards = [];
  }

  refresh(): void {
    const engine = this.orch.engine;
    this.cards = engine ? this.orch.list().map((entry) => view.summary(engine, entry)) : [];
    this._onDidChangeTreeData.fire();
  }

  counts(): { attention: number; running: number; stopped: number; done: number; total: number } {
    const by = (g: string): number => this.cards.filter((c) => c.status.group === g).length;
    return { attention: by('attention'), running: by('running'), stopped: by('stopped'), done: by('done'), total: this.cards.length };
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!this.orch.engine) return [];
    if (!node) {
      if (!this.cards.length) return [];
      return GROUPS.filter((g) => this.cards.some((c) => c.status.group === g.id)).map((g) => ({ group: g }));
    }
    if ('group' in node) return this.cards.filter((c) => c.status.group === node.group.id).map((card) => ({ card }));
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if ('group' in node) {
      const n = this.cards.filter((c) => c.status.group === node.group.id).length;
      const item = new vscode.TreeItem(node.group.label, node.group.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${node.group.id}`;
      item.description = String(n);
      item.iconPath = new vscode.ThemeIcon(node.group.icon);
      item.contextValue = 'group';
      return item;
    }
    const c = node.card;
    const item = new vscode.TreeItem(c.title, vscode.TreeItemCollapsibleState.None);
    item.id = `task:${c.taskId}`;
    const live = c.live && c.live.text;
    item.description = [c.taskId, live || c.status.label, c.status.key === 'done' ? ago(c.updatedAt) : ''].filter(Boolean).join(' · ');
    const [icon, color] = STATUS_ICON[c.status.key] || STATUS_ICON.ready!;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    const tags = ['task', c.status.key];
    if (['stopped', 'failed', 'interrupted', 'ready'].includes(c.status.key)) tags.push('resumable');
    if (c.status.key === 'running') tags.push('stoppable');
    if (c.status.key === 'waiting') tags.push('waiting');
    item.contextValue = tags.join(' ');
    item.command = { command: 'claudestrator.openTask', title: 'Open Task', arguments: [c.taskId] };
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(c.title)}**\n\n`);
    md.appendMarkdown(`\`${c.taskId}\` · ${escapeMd(c.status.label)}${live ? ` · ${escapeMd(live)}` : ''}\n\n`);
    if (c.checkpoint) md.appendMarkdown(`$(bell) ${escapeMd(c.checkpoint.hint)}\n\n`);
    if (c.error) md.appendMarkdown(`$(error) ${escapeMd(c.error.message)}\n\n`);
    if (c.branch) md.appendMarkdown(`$(git-branch) \`${c.branch}\`${c.repos.length ? ` in ${c.repos.join(', ')}` : ''}\n\n`);
    md.appendMarkdown(`Progress ${c.progress.done}/${c.progress.total} · $${c.cost.toFixed(2)} · updated ${ago(c.updatedAt)}`);
    item.tooltip = md;
    return item;
  }
}

const escapeMd = (s: unknown): string => String(s || '').replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

export type { TreeNode };
export { TaskTree, ago };
