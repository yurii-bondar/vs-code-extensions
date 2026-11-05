// The part of the built-in Git extension's API (`vscode.git`, `getAPI(1)`) that Githor uses. Its full typing is
// extensions/git/src/api/git.d.ts in microsoft/vscode, which is not on npm: copy members from there as they are needed.
import type { Event, Uri } from 'vscode';

export interface GitExtension {
  /** False when the user turned git off (`git.enabled`). */
  readonly enabled: boolean;
  getAPI(version: 1): API;
}

export interface API {
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
}

export interface RepositoryState {
  /** Fires after the Git extension re-reads the repository: HEAD, refs, index or working tree changed. */
  readonly onDidChange: Event<void>;
}
