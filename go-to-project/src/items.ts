import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { iconColor, iconSvg, initials } from './core/icon';
import { readBranch } from './core/git';
import { tildify } from './core/paths';
import { ownProject, projectUri, settings } from './workspace';

const BRANCH_TTL_MS = 5000;
const HOME = os.homedir();

export interface ProjectItem extends vscode.QuickPickItem {
  readonly action: 'project';
  readonly uri: vscode.Uri;
  /** The project of this window. */
  readonly current: boolean;
}

function describe(uri: vscode.Uri): { label: string; location: string } {
  const base = path.posix.basename(uri.path).replace(/\.code-workspace$/, '');
  const location = uri.scheme === 'file' ? uri.fsPath : uri.toString();
  return { label: base || uri.toString(), location: tildify(location, HOME) };
}

const isFileExists = (err: unknown): boolean => err instanceof Error && 'code' in err && err.code === 'EEXIST';

/** Quick pick rows for projects: an icon from the name, the git branch, and where the project lives. */
export class ProjectItems {
  private readonly branches = new Map<string, { branch: string | undefined; ts: number }>();

  constructor(private readonly iconDir: string) {}

  async list(uris: readonly vscode.Uri[]): Promise<ProjectItem[]> {
    const own = ownProject();
    const { showBranch } = settings();
    return Promise.all(
      uris.map(async (uri) => {
        const { label, location } = describe(uri);
        const branch = showBranch ? await this.branchOf(uri) : undefined;
        const current = projectUri(uri) === own;
        const description: string[] = [];
        if (branch) description.push(`$(git-branch) ${branch}`);
        if (current) description.push('$(check) this window');
        return { action: 'project', label, iconPath: await this.icon(label), description: description.join('  '), detail: location, uri, current };
      })
    );
  }

  private async branchOf(uri: vscode.Uri): Promise<string | undefined> {
    if (uri.scheme !== 'file') return undefined;
    const key = uri.fsPath;
    const hit = this.branches.get(key);
    if (hit && Date.now() - hit.ts < BRANCH_TTL_MS) return hit.branch;
    let branch: string | undefined;
    try {
      branch = await readBranch((await fs.stat(key)).isDirectory() ? key : path.dirname(key));
    } catch {
      // unreadable path or no git
    }
    this.branches.set(key, { branch, ts: Date.now() });
    return branch;
  }

  private async icon(name: string): Promise<vscode.Uri | vscode.ThemeIcon> {
    const text = initials(name);
    const color = iconColor(name);
    const file = path.join(this.iconDir, `${text}-${color.slice(1)}.svg`);
    try {
      await fs.writeFile(file, iconSvg(text, color), { flag: 'wx' });
    } catch (err) {
      if (!isFileExists(err)) return new vscode.ThemeIcon('folder');
    }
    return vscode.Uri.file(file);
  }
}
