const vscode = require('vscode');
const { PersonifyPanel } = require('./src/panel');
const { KeybindingStore } = require('./src/keybindings');

function activate(context) {
  const store = new KeybindingStore(context);
  const open = (tab) => PersonifyPanel.show(context, store, tab);

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
  const syncStatus = () => {
    if (vscode.workspace.getConfiguration('personify').get('showStatusBarItem')) status.show();
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

function deactivate() {}

module.exports = { activate, deactivate };
