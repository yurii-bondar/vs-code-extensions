import * as vscode from 'vscode';
import { BranchesView } from './branches-view';
import { GIT_OFF } from './vscode-git';
import type { Services } from './services';

/** The Githor page in its sidebar view. */
export class BranchesSidebar implements vscode.WebviewViewProvider {
  static readonly viewId = 'githor.branches';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly services: () => Promise<Services | undefined>
  ) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    const services = await this.services();
    if (!services) {
      webviewView.webview.html = `<!DOCTYPE html><html lang="en"><body><p>${GIT_OFF}</p></body></html>`;
      return;
    }
    const view = new BranchesView({ webview: webviewView.webview, extensionUri: this.extensionUri, ...services, place: 'sidebar' });
    const closed = webviewView.onDidDispose(() => {
      view.dispose();
      closed.dispose();
    });
  }
}
