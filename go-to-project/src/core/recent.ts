import { isRecord } from './types';

/** What `vscode.Uri.from` takes. */
export interface UriParts {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

function uriParts(value: unknown): UriParts | null {
  if (!isRecord(value) || typeof value.scheme !== 'string' || !value.scheme) return null;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return { scheme: value.scheme, authority: text(value.authority), path: text(value.path), query: text(value.query), fragment: text(value.fragment) };
}

/**
 * The folders and workspaces in what `_workbench.getRecentlyOpened` returns; null when it returns nothing.
 * That command is internal, so its result is checked rather than trusted.
 */
export function parseRecent(value: unknown): UriParts[] | null {
  if (!value) return null;
  const workspaces: unknown[] = isRecord(value) && Array.isArray(value.workspaces) ? value.workspaces : [];
  const uris: UriParts[] = [];
  for (const w of workspaces) {
    if (!isRecord(w)) continue;
    const uri = uriParts(w.folderUri) ?? (isRecord(w.workspace) ? uriParts(w.workspace.configPath) : null);
    if (uri) uris.push(uri);
  }
  return uris;
}
