// Sidebar: tasks by the epic, story or group they belong to; each task's icon says what it needs from you.
import * as vscode from 'vscode';
import * as view from './core/view';
import type { Orchestrator } from './orchestrator';

/** A row of the tree: a section of cards, or a card. */
type TreeNode = { section: view.Section } | { card: view.Card };

/** What a section's header shows per kind; `color` is one of the colors `package.json` contributes. */
const SECTION_LOOK: Record<view.SectionKind, { prefix: string; icon: string; color: string }> = {
  epic: { prefix: 'Epic', icon: 'zap', color: 'claudestrator.epicForeground' },
  story: { prefix: 'Story', icon: 'bookmark', color: 'claudestrator.storyForeground' },
  group: { prefix: 'Group', icon: 'folder', color: 'claudestrator.groupForeground' },
  ungrouped: { prefix: '', icon: 'inbox', color: 'claudestrator.ungroupedForeground' },
};

/** The scheme of a section header's resource: the only way a tree item's label takes a color is a file decoration. */
const SECTION_SCHEME = 'claudestrator-section';

const sectionUri = (s: view.Section): vscode.Uri => vscode.Uri.from({ scheme: SECTION_SCHEME, path: `/${s.kind}/${encodeURIComponent(s.key)}` });

/** Colors section headers by kind, read back from the path `sectionUri` writes. */
class SectionColors implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SECTION_SCHEME) return undefined;
    const kind = uri.path.split('/')[1];
    const look = kind && kind in SECTION_LOOK ? SECTION_LOOK[kind as view.SectionKind] : undefined;
    return look && new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor(look.color));
  }
}

const STATUS_ICON: Record<string, [string, string]> = {
  running: ['sync~spin', 'charts.blue'],
  waiting: ['bell-dot', 'charts.yellow'],
  failed: ['error', 'errorForeground'],
  interrupted: ['debug-disconnect', 'charts.orange'],
  elsewhere: ['window', 'charts.blue'],
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
  /** Refreshes started: the newest one's cards are the ones shown. */
  refreshes: number;

  constructor(orch: Orchestrator) {
    this.orch = orch;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.cards = [];
    this.refreshes = 0;
  }

  /** Reads the tasks again. A refresh that finishes after a later one started leaves the later one's cards. */
  async refresh(): Promise<void> {
    const n = ++this.refreshes;
    const engine = this.orch.engine;
    let cards: view.Card[] = [];
    try {
      cards = engine ? await Promise.all((await this.orch.list()).map((entry) => view.summary(engine, entry))) : [];
    } catch {
      // a task deleted while it was read; the next refresh lists the rest
      return;
    }
    if (n !== this.refreshes) return;
    this.cards = cards;
    this._onDidChangeTreeData.fire();
  }

  /** What a running task's agent does now, on its line: the card as it is otherwise. */
  setLive(taskId: string, live: view.Card['live']): void {
    const card = this.cards.find((c) => c.taskId === taskId);
    if (!card || JSON.stringify(card.live) === JSON.stringify(live)) return;
    card.live = live;
    this._onDidChangeTreeData.fire();
  }

  counts(): { attention: number; running: number; stopped: number; done: number; total: number } {
    const by = (g: string): number => this.cards.filter((c) => c.status.group === g).length;
    return { attention: by('attention'), running: by('running'), stopped: by('stopped'), done: by('done'), total: this.cards.length };
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!this.orch.engine) return [];
    if (!node) return view.sectionsOf(this.cards).map((section) => ({ section }));
    if ('section' in node) return node.section.cards.map((card) => ({ card }));
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if ('section' in node) return sectionItem(node.section);
    const c = node.card;
    const item = new vscode.TreeItem(c.title, vscode.TreeItemCollapsibleState.None);
    item.id = `task:${c.taskId}`;
    const live = c.live && c.live.text;
    item.description = [c.taskId, live || c.status.label, c.status.key === 'done' ? ago(c.updatedAt) : ''].filter(Boolean).join(' · ');
    const [icon, color] = STATUS_ICON[c.status.key] || STATUS_ICON.ready!;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    const tags = ['task', c.status.key];
    if (c.status.resumable) tags.push('resumable');
    if (c.status.key === 'running') tags.push('stoppable');
    if (c.status.key === 'waiting') tags.push('waiting');
    item.contextValue = tags.join(' ');
    item.command = { command: 'claudestrator.openTask', title: 'Open Task', arguments: [c.taskId] };
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(c.title)}**\n\n`);
    md.appendMarkdown(`\`${c.taskId}\` · ${escapeMd(c.status.label)}${live ? ` · ${escapeMd(live)}` : ''}\n\n`);
    if (c.group) md.appendMarkdown(`$(folder) ${escapeMd(c.group.label)}${c.group.jira ? ` · ${escapeMd(c.group.jira)}` : ''}\n\n`);
    if (c.checkpoint) md.appendMarkdown(`$(bell) ${escapeMd(c.checkpoint.hint)}\n\n`);
    if (c.error) md.appendMarkdown(`$(error) ${escapeMd(c.error.message)}\n\n`);
    if (c.branch) md.appendMarkdown(`$(git-branch) \`${c.branch}\`${c.repos.length ? ` in ${c.repos.join(', ')}` : ''}\n\n`);
    md.appendMarkdown(`Progress ${c.progress.done}/${c.progress.total} · $${c.cost.toFixed(2)} · updated ${ago(c.updatedAt)}`);
    item.tooltip = md;
    return item;
  }
}

/** A section's header: `Epic CP-12` with the epic's name beside it, open while any of its tasks is not finished. */
function sectionItem(s: view.Section): vscode.TreeItem {
  const look = SECTION_LOOK[s.kind];
  const name = s.kind === 'ungrouped' ? s.label : `${look.prefix} ${s.jira || s.label}`;
  const open = s.cards.some((c) => c.status.group !== 'done');
  const item = new vscode.TreeItem(name, open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `section:${s.key}`;
  item.resourceUri = sectionUri(s);
  item.description = [s.jira && s.label, String(s.cards.length)].filter(Boolean).join(' · ');
  item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
  item.contextValue = 'section';
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${escapeMd(name)}**${s.jira ? ` · ${escapeMd(s.label)}` : ''}\n\n`);
  const by = (g: string): number => s.cards.filter((c) => c.status.group === g).length;
  const parts: [number, string][] = [
    [by('attention'), 'need you'],
    [by('running'), 'running'],
    [by('stopped'), 'paused'],
    [by('done'), 'finished'],
  ];
  md.appendMarkdown(parts.filter(([n]) => n).map(([n, what]) => `${n} ${what}`).join(' · '));
  item.tooltip = md;
  return item;
}

const escapeMd = (s: unknown): string => String(s || '').replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

export type { TreeNode };
export { SectionColors, TaskTree, ago, escapeMd };
