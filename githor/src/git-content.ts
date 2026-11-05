import * as vscode from 'vscode';
import type { GitRunner } from './core/git';
import type { RepoRoot } from './core/types';

export const GIT_SCHEME = 'githor-git';

interface Address {
  root: string;
  /** The commit to read the file at; null for "no file", the empty side of an added or deleted file. */
  ref: string | null;
  path: string;
}

/** A read-only document of `path` as it is at `ref`, for VS Code's diff editor. */
export function gitUri(address: Address): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${address.path}`, query: JSON.stringify(address) });
}

function parse(uri: vscode.Uri): Address | null {
  try {
    const raw: unknown = JSON.parse(uri.query);
    if (typeof raw !== 'object' || raw === null) return null;
    const { root, ref, path } = raw as Record<string, unknown>;
    return typeof root === 'string' && typeof path === 'string' && (ref === null || typeof ref === 'string') ? { root, ref, path } : null;
  } catch {
    return null;
  }
}

/** Serves `githor-git:` documents with `git show <ref>:<path>`. */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: () => GitRunner | undefined) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const address = parse(uri);
    const git = this.git();
    if (!address || address.ref === null || !git) return '';
    return git.run(address.root as RepoRoot, ['show', `${address.ref}:${address.path}`]).catch(() => '');
  }
}
