import * as vscode from 'vscode';
import { Actions } from './actions';
import { createGitRunner } from './core/git';
import { RepoModel } from './model';
import { BranchStatusBar } from './status-bar';
import { gitApi } from './vscode-git';

/** What every view and command works with. */
export interface Services {
  model: RepoModel;
  actions: Actions;
}

/**
 * Builds the services once, on first use: they need the Git extension's API, which is async. Undefined when git is
 * turned off. Everything built is owned by `context`.
 */
export function lazyServices(context: vscode.ExtensionContext, output: vscode.OutputChannel): () => Promise<Services | undefined> {
  let services: Promise<Services | undefined> | undefined;
  return () =>
    (services ??= (async () => {
      const api = await gitApi();
      if (!api) return undefined;
      const model = new RepoModel(api, createGitRunner(api.git.path), context.workspaceState);
      const actions = new Actions(model, output);
      context.subscriptions.push(model, new BranchStatusBar(model));
      void model.refresh();
      return { model, actions };
    })());
}
