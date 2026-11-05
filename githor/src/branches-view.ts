import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { parseClientMessage } from './protocol';
import type { Actions } from './actions';
import type { RepoModel } from './model';
import type { ClientMessage, HostMessage } from './protocol';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Where a page sits: the sidebar shows the compact layout (design `05`), the editor tab the full one (`01`). */
export type Place = 'editor' | 'sidebar';

export interface BranchesViewArgs {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  model: RepoModel;
  actions: Actions;
  place: Place;
}

/** The Githor page in one webview: renders the model's state and runs what the page asks for. */
export class BranchesView implements vscode.Disposable {
  private ready = false;
  /** Messages for the page that arrived before it was up. */
  private readonly queued: HostMessage[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly webview: vscode.Webview;
  private readonly model: RepoModel;
  private readonly actions: Actions;

  constructor({ webview, extensionUri, model, actions, place }: BranchesViewArgs) {
    this.webview = webview;
    this.model = model;
    this.actions = actions;
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    const scripts = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    webview.options = { enableScripts: true, localResourceRoots: [media, scripts] };
    webview.html = this.html({ media, scripts, place });
    this.disposables.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseClientMessage(raw);
        if (message) void this.handle(message).catch((e: unknown) => this.post({ type: 'error', text: errorText(e) }));
      }),
      model.onDidChange(() => this.sendState()),
      model.onDidFail((text) => this.post({ type: 'error', text }))
    );
  }

  /** Sends `message` to the page now, or as soon as it is up. */
  request(message: HostMessage): void {
    if (this.ready) this.post(message);
    else this.queued.push(message);
  }

  private post(message: HostMessage): void {
    void this.webview.postMessage(message);
  }

  private sendState(): void {
    if (this.ready) this.post({ type: 'state', state: this.model.state() });
  }

  private async handle(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        // Sent again each time a hidden sidebar view is shown, because VS Code reloads its page.
        this.ready = true;
        this.sendState();
        for (const m of this.queued.splice(0)) this.post(m);
        if (!this.model.loaded) await this.model.refresh();
        return;
      case 'fetch':
        return this.actions.fetch({ all: message.all });
      case 'switch':
        return this.actions.switchTo(message.ref);
      case 'pickBranch':
        await vscode.commands.executeCommand('githor.switchBranch');
        return;
      case 'openEditor':
        await vscode.commands.executeCommand('githor.open');
        return;
      case 'showOutput':
        await vscode.commands.executeCommand('githor.showOutput');
        return;
      case 'scanMerged':
        this.post({ type: 'merged', view: await this.actions.scanMerged(message.target) });
        return;
      case 'deleteMerged': {
        const outcome = await this.actions.deleteMerged(message);
        this.post({ type: 'mergedDone' });
        this.post({ type: 'toast', text: outcome.text, undo: outcome.undo });
        return;
      }
      case 'undo': {
        const outcome = await this.actions.undo(message.id);
        this.post({ type: 'toast', text: outcome.text, undo: outcome.undo });
        return;
      }
      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }

  private html({ media, scripts, place }: { media: vscode.Uri; scripts: vscode.Uri; place: Place }): string {
    const webview = this.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'media', 'main.js'));
    // The page is ES modules: the entry is allowed by its nonce, the modules it imports by their origin.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Githor</title>
</head>
<body class="gt-scope gt-in-${place}" data-place="${place}">
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
