import * as vscode from 'vscode';
import { BranchesView } from './branches-view';
import type { Actions } from './actions';
import type { RepoModel } from './model';
import type { HostMessage } from './protocol';

/** The Githor page in an editor tab: one for the whole window. */
export class BranchesPanel {
  private static current: BranchesPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly view: BranchesView;

  /** Opens the tab, or brings it forward; `request` reaches the page once it is up. */
  static show({ extensionUri, model, actions, request }: { extensionUri: vscode.Uri; model: RepoModel; actions: Actions; request?: HostMessage }): void {
    const open = BranchesPanel.current ?? (BranchesPanel.current = new BranchesPanel(extensionUri, model, actions));
    open.panel.reveal(undefined, false);
    if (request) open.view.request(request);
  }

  private constructor(extensionUri: vscode.Uri, model: RepoModel, actions: Actions) {
    this.panel = vscode.window.createWebviewPanel('githor.branchesTab', 'Githor', vscode.ViewColumn.One, { retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'tab.svg');
    this.view = new BranchesView({ webview: this.panel.webview, extensionUri, model, actions, place: 'editor' });
    const closed = this.panel.onDidDispose(() => {
      BranchesPanel.current = undefined;
      this.view.dispose();
      closed.dispose();
    });
  }
}
