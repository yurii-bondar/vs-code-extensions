import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandHome, interpreterOf, kindOf } from './core/command';
import { saveGroup, saveScript, validateGroup, validateScript } from './core/library';
import type { GroupId, ScriptId } from './core/types';
import { parseClientMessage } from './protocol';
import type { ClientMessage, GroupView, HostMessage, ScriptView } from './protocol';
import type { Actions } from './actions';
import type { Store } from './store';

const exists = (file: string): Promise<boolean> => fs.promises.access(file).then(() => true, () => false);

/** The Scriptor dashboard: one panel for the whole window. */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private ready = false;
  private queued: HostMessage[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly panel: vscode.WebviewPanel;

  /** Opens the dashboard, or brings it forward; `request` is shown once the page is up. */
  static show(context: vscode.ExtensionContext, store: Store, actions: Actions, request?: HostMessage): void {
    const open = DashboardPanel.current ?? (DashboardPanel.current = new DashboardPanel(context, store, actions));
    open.panel.reveal(undefined, false);
    if (request) open.post(request);
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly actions: Actions
  ) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const scripts = vscode.Uri.joinPath(context.extensionUri, 'dist', 'media');
    this.panel = vscode.window.createWebviewPanel('scriptor.dashboard', 'Scriptor', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media, scripts],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'tab.svg');
    this.panel.webview.html = this.html(media, scripts);
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseClientMessage(raw);
        if (message) void this.handle(message).catch((e: unknown) => this.toast('error', e instanceof Error ? e.message : String(e)));
      }),
      this.store.onDidChange(() => void this.sendState())
    );
  }

  private post(message: HostMessage): void {
    if (this.ready) void this.panel.webview.postMessage(message);
    else this.queued.push(message);
  }

  private toast(kind: 'ok' | 'error', text: string): void {
    this.post({ type: 'toast', kind, text });
  }

  private async sendState(): Promise<void> {
    const { groups, scripts } = this.store.get();
    const missing = await Promise.all(scripts.map(async (s) => !(await exists(s.path))));
    const groupViews: GroupView[] = groups.map((g) => ({ id: g.id, name: g.name, hue: g.hue }));
    const scriptViews: ScriptView[] = scripts.map((s, i) => {
      const kind = kindOf(s.path);
      return {
        id: s.id,
        name: s.name,
        path: s.path,
        dir: path.dirname(s.path),
        description: s.description,
        groupId: s.groupId,
        interpreter: s.interpreter,
        args: s.args,
        cwd: s.cwd,
        lastRunAt: s.lastRunAt,
        missing: missing[i] ?? false,
        kind: { label: kind.label, short: kind.short, hue: kind.hue },
        detected: interpreterOf({ path: s.path, interpreter: '' }, process.platform) ?? '',
      };
    });
    this.post({ type: 'state', groups: groupViews, scripts: scriptViews });
  }

  private async handle(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        await this.sendState();
        for (const m of this.queued.splice(0)) void this.panel.webview.postMessage(m);
        return;
      case 'run':
        return this.actions.run([message.id as ScriptId]);
      case 'runGroup':
        return this.actions.runGroup(message.id as GroupId);
      case 'openFile':
        return this.actions.openFile(message.id as ScriptId);
      case 'reveal':
        return this.actions.reveal(message.id as ScriptId);
      case 'removeScript':
        await this.actions.removeScript(message.id as ScriptId);
        return;
      case 'removeGroup':
        await this.actions.removeGroup(message.id as GroupId);
        return;
      case 'pick': {
        const picked = await this.actions.pick(message.target, os.homedir());
        if (picked) this.post({ type: 'picked', target: message.target, path: picked });
        return;
      }
      case 'saveScript': {
        const draft = { ...message.draft, path: expandHome(message.draft.path, os.homedir()), cwd: expandHome(message.draft.cwd, os.homedir()) };
        const problem = validateScript(draft);
        if (problem) return this.toast('error', problem);
        await this.store.update((lib) => saveScript(lib, draft));
        this.post({ type: 'saved' });
        return;
      }
      case 'saveGroup': {
        const problem = validateGroup(message.draft);
        if (problem) return this.toast('error', problem);
        await this.store.update((lib) => saveGroup(lib, message.draft));
        this.post({ type: 'saved' });
        return;
      }
      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }

  private html(media: vscode.Uri, scripts: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'app.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Scriptor</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
