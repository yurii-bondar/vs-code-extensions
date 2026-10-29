import * as vscode from 'vscode';
import type { Config } from './core/customizations';
import type { Scope } from './core/types';

const target = (scope: Scope): vscode.ConfigurationTarget => (scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration();

/** VS Code's settings behind the `Config` that `Customizations` works with. */
export const vscodeConfig: Config = {
  read(key, scope) {
    const info = cfg().inspect<unknown>(key);
    return scope === 'workspace' ? info?.workspaceValue : info?.globalValue;
  },
  effective: (key) => cfg().get<unknown>(key),
  defaultValue: (key) => cfg().inspect<unknown>(key)?.defaultValue,
  async write(key, value, scope) {
    await cfg().update(key, value, target(scope));
  },
  canWriteWorkspace: () => vscode.workspace.workspaceFolders !== undefined,
};
