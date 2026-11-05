import * as vscode from 'vscode';
import { AccountStore } from './account-store';
import { accountGit } from './account-git';
import { Actions } from './actions';
import { createGitRunner } from './core/git';
import { RepoModel } from './model';
import { AccountStatusBar } from './account-ui';
import { BranchStatusBar } from './status-bar';
import { gitApi } from './vscode-git';

/** What every view and command works with. */
export interface Services {
  model: RepoModel;
  actions: Actions;
  accounts: AccountStore;
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
      const base = createGitRunner(api.git.path);
      const model = new RepoModel(api, base, context.workspaceState);
      const accounts = new AccountStore(context);
      const actions = new Actions(model, output, accountGit({ base, store: accounts, model, fetch }));
      context.subscriptions.push(model, accounts, new BranchStatusBar(model), new AccountStatusBar(accounts, model));
      void model.refresh();
      return { model, actions, accounts };
    })());
}
