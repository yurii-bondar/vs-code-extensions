import * as vscode from 'vscode';
import type { API, GitExtension } from './git-api';

export const GIT_OFF = 'Githor works through VS Code\'s Git extension, which is turned off. Turn on the "git.enabled" setting.';

/** The built-in Git extension's API; undefined when git is turned off. */
export async function gitApi(): Promise<API | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  const git = extension && (extension.isActive ? extension.exports : await extension.activate());
  return git?.enabled ? git.getAPI(1) : undefined;
}
