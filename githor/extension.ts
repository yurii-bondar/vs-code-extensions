import * as vscode from 'vscode';
import { GIT_SCHEME, GitContentProvider } from './src/git-content';
import { AccountProblem } from './src/account-git';
import { accountMenu, explainProblem } from './src/account-ui';
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

  /** Runs a command's git work; a refused account is explained with what can fix it, anything else is an error. */
  const reporting = (s: Services, run: () => Promise<string | null>): Promise<void> =>
    run().then(
      (text) => void (text && vscode.window.setStatusBarMessage(`Githor: ${text}`, 5000)),
      (e: unknown) => {
        if (e instanceof AccountProblem) return explainProblem({ problem: e, store: s.accounts, model: s.model, retry: () => reporting(s, run), addAccount: () => openEditor(s, { type: 'openAccounts', add: true }) });
        void vscode.window.showErrorMessage(`Githor: ${e instanceof Error ? e.message : String(e)}`, 'Show Git Output').then((pick) => pick && output.show());
        return undefined;
      }
    );

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
        return reporting(s, async () => (await action()).text);
      })
    ),
    vscode.commands.registerCommand('githor.fetch', withServices((s) => reporting(s, () => s.actions.fetch({ all: false }).then(() => null)))),
    vscode.commands.registerCommand('githor.fetchAll', withServices((s) => reporting(s, () => s.actions.fetch({ all: true }).then(() => null)))),
    vscode.commands.registerCommand('githor.deleteMerged', withServices((s) => openEditor(s, { type: 'openDeleteMerged' }))),
    vscode.commands.registerCommand('githor.compare', (ref: unknown) =>
      withServices((s) => {
        const branch = typeof ref === 'string' ? s.model.branches.find((b) => b.ref === ref) : s.model.branches.find((b) => b.current && b.sync === 'diverged');
        if (branch) openEditor(s, { type: 'openCompare', ref: branch.ref });
        else void vscode.window.showInformationMessage('Githor: the current branch has not moved on both sides.');
      })()
    ),
    vscode.commands.registerCommand(
      'githor.pickAccount',
      withServices(async (s) => {
        const next = await accountMenu({ store: s.accounts, model: s.model });
        if (next) openEditor(s, { type: 'openAccounts', add: next === 'add' });
      })
    ),
    vscode.commands.registerCommand('githor.addAccount', withServices((s) => openEditor(s, { type: 'openAccounts', add: true }))),
    vscode.commands.registerCommand('githor.manageAccounts', withServices((s) => openEditor(s, { type: 'openAccounts', add: false }))),
    vscode.commands.registerCommand('githor.showOutput', () => output.show())
  );
  // The status bar item belongs on screen from the start, so the services are built now rather than on first use.
  void services();
}
