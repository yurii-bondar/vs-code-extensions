import * as vscode from 'vscode';
import type { ProjectUri } from './core/types';

export const projectUri = (uri: vscode.Uri): ProjectUri => uri.toString() as ProjectUri;

/** This window's project: its `.code-workspace` file, else its first folder. */
export function currentTarget(): vscode.Uri | undefined {
  const { workspaceFile, workspaceFolders } = vscode.workspace;
  if (workspaceFile && workspaceFile.scheme !== 'untitled') return workspaceFile;
  return workspaceFolders?.[0]?.uri;
}

export function ownProject(): ProjectUri | null {
  const target = currentTarget();
  return target ? projectUri(target) : null;
}

export interface Settings {
  readonly includeRecent: boolean;
  readonly showBranch: boolean;
}

/** A setting of the wrong type falls back to its default from package.json (both are on). */
export function settings(): Settings {
  const config = vscode.workspace.getConfiguration('goToProject');
  const flag = (key: keyof Settings): boolean => {
    const value: unknown = config.get(key);
    return typeof value === 'boolean' ? value : true;
  };
  return { includeRecent: flag('includeRecent'), showBranch: flag('showBranch') };
}
