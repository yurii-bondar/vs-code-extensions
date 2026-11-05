import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { gitUri } from './git-content';
import { parseClientMessage } from './protocol';
import type { Actions } from './actions';
import type { RepoModel } from './model';
import type { ClientMessage, HostMessage } from './protocol';

/** The `sha` the page uses for the working copy. */
const WORKTREE = 'WORKTREE';

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

  private async toast(outcome: Promise<{ text: string; undo: number | null }>): Promise<void> {
    const { text, undo } = await outcome;
    this.post({ type: 'toast', text, undo });
  }

  /** A dialog's action: on success the dialog closes and the toast says what happened. */
  private async toastAndClose(outcome: Promise<{ text: string; undo: number | null }>): Promise<void> {
    const { text, undo } = await outcome;
    this.post({ type: 'branchDone' });
    this.post({ type: 'toast', text, undo });
  }

  /** A changed file side by side in VS Code's diff editor: before on the left, the commit on the right. */
  private async openDiff({ sha, parent, file }: Extract<ClientMessage, { type: 'openDiff' }>): Promise<void> {
    const root = this.model.root;
    if (!root) return;
    const left = gitUri({ root, ref: file.status === 'A' ? null : parent, path: file.oldPath ?? file.path });
    // the working copy opens as the file itself, so it can be edited right there
    const right = sha === WORKTREE ? vscode.Uri.file(path.join(root, file.path)) : gitUri({ root, ref: file.status === 'D' ? null : sha, path: file.path });
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path} (${sha.slice(0, 7)})`, { preview: true });
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
      case 'push':
        return this.toast(this.actions.push(message));
      case 'pull':
        return this.toast(this.actions.pull(message.ref));
      case 'publish':
        return this.toast(this.actions.publish(message.ref));
      case 'sync':
        return this.toast(this.actions.sync(message.ref ?? undefined));
      case 'checkName':
        this.post({ type: 'nameCheck', name: message.name, problem: await this.actions.checkName(message.name) });
        return;
      case 'newBranch':
        await this.toastAndClose(this.actions.newBranch(message));
        return;
      case 'rename':
        await this.toastAndClose(this.actions.rename(message));
        return;
      case 'deleteInfo':
        this.post({ type: 'deleteInfo', ref: message.ref, ...(await this.actions.deleteInfo(message.ref)) });
        return;
      case 'deleteBranch':
        await this.toastAndClose(this.actions.deleteBranch(message));
        return;
      case 'pin':
        return this.actions.pin(message.ref, message.pinned);
      case 'log':
        this.post({ type: 'log', ...(await this.actions.commitLog(message.limit)) });
        return;
      case 'commitDetails':
        this.post({ type: 'commitDetails', details: await this.actions.commitDetails(message.shas) });
        return;
      case 'switchCommit':
        return this.toast(this.actions.switchCommit(message.sha));
      case 'cherryPick':
        return this.toast(this.actions.cherryPick(message.shas));
      case 'revert':
        return this.toast(this.actions.revert(message.sha));
      case 'openDiff':
        return this.openDiff(message);
      case 'fileDiff':
        this.post({ type: 'fileDiff', diff: await this.actions.fileDiff(message) });
        return;
      case 'workingDiff':
        this.post({ type: 'fileDiff', diff: await this.actions.workingDiff(message.path) });
        return;
      case 'setGrouping':
        return this.model.setGrouping(message.grouping);
      case 'commit': {
        const outcome = await this.actions.commit(message);
        this.post({ type: 'committed', push: message.push, ref: this.model.current?.ref ?? null });
        this.post({ type: 'toast', text: outcome.text, undo: outcome.undo });
        return;
      }
      case 'pushReview':
        this.post({ type: 'pushReview', ref: message.ref, ...(await this.actions.pushReview(message.ref)) });
        return;
      case 'copyName':
        await vscode.env.clipboard.writeText(message.name);
        this.post({ type: 'toast', text: `Copied ${message.name}`, undo: null });
        return;
      case 'forceInfo':
        this.post({ type: 'forceInfo', ref: message.ref, ...(await this.actions.forceInfo(message.ref)) });
        return;
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
