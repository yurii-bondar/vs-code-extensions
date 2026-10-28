import * as vscode from 'vscode';
import { kindOf } from './core/command';
import type { Group, Hue, Script } from './core/types';
import type { Store } from './store';

export type TreeNode = { kind: 'group'; group: Group; count: number } | { kind: 'script'; script: Script };

const COLOR: Readonly<Record<Hue, string>> = {
  violet: 'charts.purple',
  blue: 'charts.blue',
  cyan: 'terminal.ansiCyan',
  green: 'charts.green',
  amber: 'charts.yellow',
  orange: 'charts.orange',
  rose: 'charts.red',
  pink: 'terminal.ansiMagenta',
};

const tint = (hue: Hue): vscode.ThemeColor => new vscode.ThemeColor(COLOR[hue]);

/** The Scripts view: groups first, then the scripts that have none. */
export class ScriptTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: Store) {
    this.subscription = store.onDidChange(() => this.changed.fire());
  }

  getChildren(node?: TreeNode): TreeNode[] {
    const { groups, scripts } = this.store.get();
    if (!node) {
      return [
        ...groups.map((group): TreeNode => ({ kind: 'group', group, count: scripts.filter((s) => s.groupId === group.id).length })),
        ...scripts.filter((s) => !s.groupId).map((script): TreeNode => ({ kind: 'script', script })),
      ];
    }
    return node.kind === 'group' ? scripts.filter((s) => s.groupId === node.group.id).map((script): TreeNode => ({ kind: 'script', script })) : [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.group.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `g:${node.group.id}`;
      item.description = String(node.count);
      item.iconPath = new vscode.ThemeIcon('folder', tint(node.group.hue));
      item.contextValue = 'group';
      return item;
    }
    const { script } = node;
    const kind = kindOf(script.path);
    const item = new vscode.TreeItem(script.name, vscode.TreeItemCollapsibleState.None);
    item.id = `s:${script.id}`;
    item.description = kind.label;
    item.tooltip = new vscode.MarkdownString([`**${script.name}**`, script.description, `\`${script.path}\``].filter(Boolean).join('\n\n'));
    item.iconPath = new vscode.ThemeIcon('play-circle', tint(kind.hue));
    item.contextValue = 'script';
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
