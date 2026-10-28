import * as vscode from 'vscode';
import { Store } from './src/store';
import { Actions } from './src/actions';
import { ScriptTree } from './src/tree';
import { DashboardPanel } from './src/panel';
import type { TreeNode } from './src/tree';
import type { GroupId, ScriptId } from './src/core/types';

/** What a command is given: an id, or the tree node it was run on. */
type Arg = string | TreeNode | undefined;

const isNode = (arg: Arg): arg is TreeNode => typeof arg === 'object';
const scriptIdOf = (arg: Arg): ScriptId | undefined => (typeof arg === 'string' ? (arg as ScriptId) : isNode(arg) && arg.kind === 'script' ? arg.script.id : undefined);
const groupIdOf = (arg: Arg): GroupId | undefined => (typeof arg === 'string' ? (arg as GroupId) : isNode(arg) && arg.kind === 'group' ? arg.group.id : undefined);

export function activate(context: vscode.ExtensionContext): void {
  const store = new Store(context.globalState);
  const actions = new Actions(store);
  const tree = new ScriptTree(store);
  const dashboard = (request?: Parameters<typeof DashboardPanel.show>[3]): void => DashboardPanel.show(context, store, actions, request);

  async function pickScript(placeHolder: string): Promise<ScriptId | undefined> {
    const { scripts, groups } = store.get();
    if (!scripts.length) {
      vscode.window.showInformationMessage('Scriptor has no scripts yet.', 'Add Script').then((a) => a && dashboard({ type: 'addScript', groupId: null }));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      scripts.map((s) => ({ label: s.name, description: groups.find((g) => g.id === s.groupId)?.name ?? '', detail: s.path, id: s.id })),
      { placeHolder, matchOnDescription: true, matchOnDetail: true }
    );
    return picked?.id;
  }

  async function pickGroup(placeHolder: string): Promise<GroupId | undefined> {
    const { groups, scripts } = store.get();
    if (!groups.length) {
      vscode.window.showInformationMessage('Scriptor has no groups yet.', 'New Group').then((a) => a && dashboard({ type: 'addGroup' }));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      groups.map((g) => ({ label: g.name, description: `${scripts.filter((s) => s.groupId === g.id).length} scripts`, id: g.id })),
      { placeHolder }
    );
    return picked?.id;
  }

  const on = (command: string, run: (arg: Arg) => unknown): vscode.Disposable => vscode.commands.registerCommand(command, run);

  context.subscriptions.push(
    store,
    tree,
    vscode.window.createTreeView('scriptor.scripts', { treeDataProvider: tree, showCollapseAll: true }),
    on('scriptor.open', () => dashboard()),
    on('scriptor.addScript', (arg) => dashboard({ type: 'addScript', groupId: groupIdOf(arg) ?? null })),
    on('scriptor.addGroup', () => dashboard({ type: 'addGroup' })),
    on('scriptor.run', async (arg) => {
      const id = scriptIdOf(arg) ?? (await pickScript('Run which script?'));
      if (id) await actions.run([id]);
    }),
    on('scriptor.runGroup', async (arg) => {
      const id = groupIdOf(arg) ?? (await pickGroup('Run all scripts of which group?'));
      if (id) await actions.runGroup(id);
    }),
    on('scriptor.editScript', (arg) => {
      const id = scriptIdOf(arg);
      if (id) dashboard({ type: 'editScript', id });
    }),
    on('scriptor.editGroup', (arg) => {
      const id = groupIdOf(arg);
      if (id) dashboard({ type: 'editGroup', id });
    }),
    on('scriptor.openFile', (arg) => {
      const id = scriptIdOf(arg);
      return id && actions.openFile(id);
    }),
    on('scriptor.reveal', (arg) => {
      const id = scriptIdOf(arg);
      return id && actions.reveal(id);
    }),
    on('scriptor.removeScript', (arg) => {
      const id = scriptIdOf(arg);
      return id && actions.removeScript(id);
    }),
    on('scriptor.removeGroup', (arg) => {
      const id = groupIdOf(arg);
      return id && actions.removeGroup(id);
    })
  );
}

export function deactivate(): void {}
