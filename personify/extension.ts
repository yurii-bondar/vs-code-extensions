import * as vscode from 'vscode';
import { PersonifyPanel } from './src/panel';
import { KeybindingStore } from './src/keybindings';
import type { Tab } from './src/core/types';

export function activate(context: vscode.ExtensionContext): void {
  const store = new KeybindingStore(context.globalStorageUri);
  const open = (tab?: Tab): void => PersonifyPanel.show(context, store, tab);

  context.subscriptions.push(
    vscode.commands.registerCommand('personify.open', () => open()),
    vscode.commands.registerCommand('personify.openHotkeys', () => open('hotkeys')),
    vscode.commands.registerCommand('personify.openAppearance', () => open('appearance')),
    vscode.commands.registerCommand('personify.openSyntax', () => open('syntax'))
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(paintcan) Personify';
  status.tooltip = 'Customize hotkeys, colors, fonts and syntax';
  status.command = 'personify.open';
  const syncStatus = (): void => {
    // Any value but false shows it, as the default does.
    if (vscode.workspace.getConfiguration('personify').get<unknown>('showStatusBarItem') !== false) status.show();
    else status.hide();
  };
  syncStatus();
  context.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('personify.showStatusBarItem')) syncStatus();
    })
  );
}

export function deactivate(): void {}
