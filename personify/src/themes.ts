import * as vscode from 'vscode';
import * as path from 'path';
import { isRecord, records, str } from './core/json';
import { loadTheme } from './core/themeSyntax';
import type { ThemeFiles, ThemeTokens } from './core/themeSyntax';
import type { ThemeProblem } from './core/types';

const NONE: ThemeTokens = { rules: [], semantic: {}, semanticHighlighting: false };

const files: ThemeFiles = {
  read: async (file) => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file))),
};

/** The file of the installed color theme called `theme` (its id, or its label when it has none); null when none is. */
function themeFile(theme: string): string | null {
  for (const ext of vscode.extensions.all) {
    // packageJSON is whatever the extension ships, so it is narrowed here.
    const pkg: unknown = ext.packageJSON;
    const contributes = isRecord(pkg) ? pkg.contributes : undefined;
    for (const t of records(isRecord(contributes) ? contributes.themes : undefined)) {
      const file = str(t.path);
      if (file && (str(t.id) ?? str(t.label)) === theme) return path.join(ext.extensionPath, file);
    }
  }
  return null;
}

/** The syntax colors of the installed theme `theme`, read once per theme until extensions change. */
export class ThemeReader implements vscode.Disposable {
  private readonly cache = new Map<string, Promise<{ tokens: ThemeTokens; problem: ThemeProblem }>>();
  private readonly listener = vscode.extensions.onDidChange(() => this.cache.clear());

  read(theme: string): Promise<{ tokens: ThemeTokens; problem: ThemeProblem }> {
    let found = this.cache.get(theme);
    if (!found) {
      const file = themeFile(theme);
      found = file ? loadTheme(file, files) : Promise.resolve({ tokens: NONE, problem: 'notFound' as const });
      this.cache.set(theme, found);
    }
    return found;
  }

  dispose(): void {
    this.listener.dispose();
    this.cache.clear();
  }
}
