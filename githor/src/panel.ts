import * as vscode from 'vscode';
import { BranchesView } from './branches-view';
import type { Actions } from './actions';
import type { AccountStore } from './account-store';
import type { RepoModel } from './model';
import type { HostMessage } from './protocol';

/** The Githor page in an editor tab: one for the whole window. */
export class BranchesPanel {
  private static current: BranchesPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly view: BranchesView;

  /** Opens the tab, or brings it forward; `request` reaches the page once it is up. */
  static show({ extensionUri, model, actions, accounts, request }: { extensionUri: vscode.Uri; model: RepoModel; actions: Actions; accounts: AccountStore; request?: HostMessage }): void {
    const open = BranchesPanel.current ?? (BranchesPanel.current = new BranchesPanel(extensionUri, model, actions, accounts));
    open.panel.reveal(undefined, false);
    if (request) open.view.request(request);
  }

  private constructor(extensionUri: vscode.Uri, model: RepoModel, actions: Actions, accounts: AccountStore) {
    this.panel = vscode.window.createWebviewPanel('githor.branchesTab', 'Githor', vscode.ViewColumn.One, { retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'tab.svg');
    this.view = new BranchesView({ webview: this.panel.webview, extensionUri, model, actions, accounts, place: 'editor' });
    const closed = this.panel.onDidDispose(() => {
      BranchesPanel.current = undefined;
      this.view.dispose();
      closed.dispose();
    });
  }
}
