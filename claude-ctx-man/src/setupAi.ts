import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { applySteps, hintFor, inspect, needsOf, planSteps } from './aifiles';
import { parseAiMessage } from './aiMessages';
import type { Preset, Step } from './aifiles';
import type { ClientMessage, HostMessage, ItemView, PresetId, ResultView, RootView, ToolId } from './aiWire';

const roots = (): RootView[] => (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));

const presetOf = (id: PresetId, tools: readonly ToolId[]): Preset => (id === 'claude-only' ? { kind: 'claude-only' } : { kind: 'several', tools });

/** The root must be one of the open folders: the page only names it, it does not get to pick any path. */
const known = (root: string): string | undefined => roots().find((r) => r.path === root)?.path;

function items(root: string, steps: readonly Step[]): ItemView[] {
  return steps.map((step): ItemView => {
    const needs = needsOf(step) ?? '';
    const need = steps.find((s) => s.path === needs);
    return {
      path: step.path,
      kind: step.kind,
      target: step.kind === 'link' ? step.target : '',
      status: inspect(root, step),
      hint: hintFor(step.path),
      needs,
      needsOk: !need || inspect(root, need) === 'exists',
    };
  });
}

/** The page where the person picks a preset and ticks what to create. Opens one panel, shared by repeated runs. */
export class AiFilesPanel {
  private static current: AiFilesPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext): void {
    if (!roots().length) {
      vscode.window.showWarningMessage('Open a folder first: AI config files go into the project.');
      return;
    }
    if (AiFilesPanel.current) AiFilesPanel.current.panel.reveal();
    else AiFilesPanel.current = new AiFilesPanel(context);
  }

  private constructor(context: vscode.ExtensionContext) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const scripts = vscode.Uri.joinPath(context.extensionUri, 'dist', 'media');
    this.panel = vscode.window.createWebviewPanel('ctxManAiFiles', 'Set Up AI Config Files', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [media, scripts],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.png');
    this.panel.webview.html = this.html(media, scripts);
    this.disposables.push(
      this.panel.onDidDispose(() => {
        AiFilesPanel.current = undefined;
        this.disposables.forEach((d) => d.dispose());
      }),
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseAiMessage(raw);
        if (message) void this.onMessage(message);
      })
    );
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private plan(root: string, preset: PresetId, tools: readonly ToolId[]): void {
    this.post({ type: 'plan', root, preset, tools: [...tools], items: items(root, planSteps(presetOf(preset, tools), path.basename(root))) });
  }

  private async onMessage(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'init', roots: roots(), platform: process.platform });
        return;
      case 'plan': {
        const root = known(message.root);
        if (root) this.plan(root, message.preset, message.tools);
        return;
      }
      case 'create': {
        const root = known(message.root);
        if (!root) return;
        const steps = planSteps(presetOf(message.preset, message.tools), path.basename(root));
        const outcomes = applySteps(root, steps, new Set(message.skip));
        const results = outcomes.map((o): ResultView => ({ path: o.step.path, status: o.status, error: o.error ?? '' }));
        this.post({ type: 'result', root, results });
        this.plan(root, message.preset, message.tools);
        return;
      }
      case 'open': {
        const root = known(message.root);
        const file = root ? path.resolve(root, message.path) : '';
        // Only files inside the project: the path comes from the page.
        if (root && file.startsWith(root + path.sep)) await vscode.window.showTextDocument(vscode.Uri.file(file));
        return;
      }
      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }

  private html(media: vscode.Uri, scripts: vscode.Uri): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(media, 'aifiles.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(scripts, 'aifiles.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Set Up AI Config Files</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

export const setupAiFiles = (context: vscode.ExtensionContext): void => AiFilesPanel.show(context);
