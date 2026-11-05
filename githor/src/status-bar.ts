import * as vscode from 'vscode';
import { marksOf, marksText } from './core/marks';
import type { Branch } from './core/types';
import type { RepoModel } from './model';

/** What the marks mean, for the tooltip. */
function describe(branch: Branch): string {
  const { ahead, behind, end } = marksOf(branch);
  if (end === 'in-sync') return 'In sync with its remote branch.';
  if (end === 'diverged') return `${ahead} to push and ${behind} to pull: local and remote both moved.`;
  if (branch.sync === 'unpushed') return ahead ? `${ahead} commits not on any remote yet.` : 'Not on any remote yet.';
  if (branch.sync === 'gone') return 'Its remote branch was deleted.';
  return [ahead ? `${ahead} to push` : '', behind ? `${behind} to pull` : ''].filter(Boolean).join(', ') + '.';
}

/** What a click does (design `06`). */
function clickHint(branch: Branch): string {
  if (branch.sync === 'unpushed' || branch.sync === 'gone') return 'Click to publish it.';
  if (branch.sync === 'ahead') return 'Click to push.';
  if (branch.sync === 'behind') return 'Click to pull.';
  return 'Click to switch to another branch.';
}

/** The current branch and its sync marks in the status bar (design `06`); a click pushes, pulls or publishes, else opens the branch picker. */
export class BranchStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('githor.branch', vscode.StatusBarAlignment.Left, 100);
  private readonly listener: vscode.Disposable;

  constructor(private readonly model: RepoModel) {
    this.item.name = 'Githor Branch';
    this.item.command = 'githor.statusAction';
    this.listener = model.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const branch = this.model.current;
    if (!branch) {
      this.item.hide();
      return;
    }
    const marks = marksText(branch);
    const icon = this.model.busy ? '$(sync~spin)' : '$(git-branch)';
    this.item.text = `${icon} ${branch.name}${marks === 'in sync' ? ' $(check) in sync' : marks ? ` ${marks}` : ''}`;
    this.item.tooltip = `${branch.name}: ${describe(branch)}\n${clickHint(branch)}`;
    this.item.show();
  }

  dispose(): void {
    this.listener.dispose();
    this.item.dispose();
  }
}
