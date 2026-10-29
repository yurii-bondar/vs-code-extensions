import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Commands } from './src/commands';
import { ProjectItems } from './src/items';
import { WindowRegistry } from './src/windows';
import { ownProject } from './src/workspace';
import type { WindowId } from './src/core/types';

const HEARTBEAT_MS = 5000;

let windows: WindowRegistry | undefined;
let timer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const dir = context.globalStorageUri.fsPath;
  const iconDir = path.join(dir, 'icons');
  await fs.mkdir(iconDir, { recursive: true });
  const registry = new WindowRegistry({ dir, windowId: vscode.env.sessionId as WindowId });
  const commands = new Commands(registry, new ProjectItems(iconDir));
  windows = registry;

  async function heartbeat(): Promise<void> {
    const own = ownProject();
    await registry.heartbeat(own);
    // Drives the `when` clause that enables "Go To Last Project".
    await vscode.commands.executeCommand('setContext', 'goToProject.hasLast', (await registry.last(own)) !== null);
  }

  async function onFocused(): Promise<void> {
    const own = ownProject();
    if (own) await registry.focus(own);
  }

  timer = setInterval(() => void heartbeat(), HEARTBEAT_MS);

  context.subscriptions.push(
    vscode.commands.registerCommand('goToProject.open', () => commands.open()),
    vscode.commands.registerCommand('goToProject.recent', () => commands.recent()),
    vscode.commands.registerCommand('goToProject.last', () => commands.last()),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void onFocused().then(heartbeat);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void heartbeat()),
    { dispose: () => clearInterval(timer) }
  );

  void heartbeat().then(() => (vscode.window.state.focused ? onFocused() : undefined));
}

export function deactivate(): Promise<void> | undefined {
  clearInterval(timer);
  return windows?.leave();
}
