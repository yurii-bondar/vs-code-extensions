import * as vscode from 'vscode';
import { marksOf } from './core/marks';
import type { Branch } from './core/types';
import type { Actions } from './actions';
import type { RepoModel } from './model';

/** The chips and marks of a branch row, as quick pick text: `local ↑2   remote ↓3`. */
function describe(branch: Branch): string {
  const { local, ahead, remote, behind, end } = marksOf(branch);
  const parts = [local ? `$(device-desktop) local${ahead ? ` ↑${ahead}` : ''}` : '', remote ? `$(cloud) remote${behind ? ` ↓${behind}` : ''}` : ''];
  if (end === 'in-sync') parts.push('$(check) in sync');
  if (end === 'diverged') parts.push('$(arrow-swap)');
  return parts.filter(Boolean).join('   ');
}

/** The branch switcher (design `07`): every branch with its marks; Enter switches. */
export async function pickBranch(model: RepoModel, actions: Actions): Promise<void> {
  const items = model.branches.map((branch) => ({ label: `$(git-branch) ${branch.name}`, description: `${branch.current ? '$(check) current   ' : ''}${describe(branch)}`, branch }));
  if (!items.length) {
    void vscode.window.showInformationMessage('Githor: this repository has no branches yet.');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Switch to a branch', matchOnDescription: false });
  if (!picked || picked.branch.current) return;
  try {
    await actions.switchTo(picked.branch.ref);
  } catch (e) {
    void vscode.window.showErrorMessage(`Githor: ${e instanceof Error ? e.message : String(e)}`);
  }
}
