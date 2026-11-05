import * as vscode from 'vscode';
import { GIT_SCHEME, GitContentProvider } from './src/git-content';
import { BranchesPanel } from './src/panel';
import { pickBranch } from './src/quick-pick';
import { lazyServices } from './src/services';
import { BranchesSidebar } from './src/sidebar';
import { GIT_OFF } from './src/vscode-git';
import type { HostMessage } from './src/protocol';
import type { Services } from './src/services';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Githor');
  const services = lazyServices(context, output);

  /** A command body that needs the services; says why when git is off. */
  const withServices = (run: (s: Services) => unknown) => async (): Promise<void> => {
    const s = await services();
    if (s) await run(s);
    else void vscode.window.showErrorMessage(GIT_OFF);
  };
  const openEditor = (s: Services, request?: HostMessage): void => BranchesPanel.show({ extensionUri: context.extensionUri, ...s, ...(request ? { request } : {}) });

  let git: Services['model']['git'] | undefined;
  void services().then((s) => (git = s?.model.git));

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider(() => git)),
    vscode.window.registerWebviewViewProvider(BranchesSidebar.viewId, new BranchesSidebar(context.extensionUri, services)),
    vscode.commands.registerCommand('githor.open', withServices((s) => openEditor(s))),
    vscode.commands.registerCommand('githor.switchBranch', withServices((s) => pickBranch(s.model, s.actions))),
    vscode.commands.registerCommand(
      'githor.statusAction',
      withServices(async (s) => {
        const action = s.actions.primary();
        if (!action) return pickBranch(s.model, s.actions);
        try {
          vscode.window.setStatusBarMessage(`Githor: ${(await action()).text}`, 5000);
        } catch (e) {
          void vscode.window.showErrorMessage(`Githor: ${e instanceof Error ? e.message : String(e)}`, 'Show Git Output').then((pick) => pick && output.show());
        }
      })
    ),
    vscode.commands.registerCommand('githor.fetch', withServices((s) => s.actions.fetch({ all: false }))),
    vscode.commands.registerCommand('githor.fetchAll', withServices((s) => s.actions.fetch({ all: true }))),
    vscode.commands.registerCommand('githor.deleteMerged', withServices((s) => openEditor(s, { type: 'openDeleteMerged' }))),
    vscode.commands.registerCommand('githor.showOutput', () => output.show())
  );
  // The status bar item belongs on screen from the start, so the services are built now rather than on first use.
  void services();
}
