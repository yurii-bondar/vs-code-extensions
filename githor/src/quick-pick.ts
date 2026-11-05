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

interface Item extends vscode.QuickPickItem {
  branch?: Branch;
  /** Set on the "Create branch" item: the typed name. */
  create?: string;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The branch switcher (design `07`): every branch with its marks; Enter switches. Typing a name no branch has offers
 * to create it from the current branch and switch to it.
 */
export function pickBranch(model: RepoModel, actions: Actions): Promise<void> {
  const branches: Item[] = model.branches.map((branch) => ({ label: `$(git-branch) ${branch.name}`, description: `${branch.current ? '$(check) current   ' : ''}${describe(branch)}`, branch }));
  const current = model.current;
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = current ? 'Switch to a branch, or type a new name' : 'Switch to a branch';
  qp.items = branches;
  qp.onDidChangeValue((value) => {
    const name = value.trim();
    const exists = model.branches.some((b) => b.name === name);
    qp.items = current && name && !exists ? [{ label: `$(add) Create branch ${name}`, description: `from ${current.name}, and switch to it`, create: name, alwaysShow: true }, ...branches] : branches;
  });
  return new Promise((resolve) => {
    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      qp.hide();
      try {
        if (picked?.create && current) await actions.newBranch({ name: picked.create, start: current.ref, switchTo: true });
        else if (picked?.branch && !picked.branch.current) await actions.switchTo(picked.branch.ref);
      } catch (e) {
        void vscode.window.showErrorMessage(`Githor: ${errorText(e)}`);
      }
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve();
    });
    qp.show();
  });
}
