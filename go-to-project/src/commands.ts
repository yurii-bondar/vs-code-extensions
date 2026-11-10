import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DIRECTORY_SLOTS, projectsIn } from './core/directory';
import { isUnder, tildify, untildify } from './core/paths';
import { parseRecent } from './core/recent';
import { previousFirst } from './core/state';
import { currentTarget, ownProject, projectUri, settings } from './workspace';
import type { ProjectItem, ProjectItems } from './items';
import type { WindowRegistry } from './windows';

const RECENT_KEY = process.platform === 'darwin' ? '⌥⌘E' : 'Ctrl+Alt+E';
const PLACEHOLDER = 'Type a project name, branch or path';
const HOME = os.homedir();
const ADD_DIRECTORY = 'Add Directory';

// Recent entries that cannot be (or should not be) opened: deleted folders, the Trash, temp folders.
const HIDDEN = [path.join(os.homedir(), '.Trash'), os.tmpdir(), '/tmp', '/private/tmp', '/private/var/folders', '/var/folders'];

interface RecentListItem extends vscode.QuickPickItem {
  readonly action: 'recent';
}
interface SeparatorItem extends vscode.QuickPickItem {
  readonly action: 'separator';
}
type OpenWindowsItem = ProjectItem | RecentListItem | SeparatorItem;

interface PickArgs {
  title: string;
  placeholder: string;
  value?: string;
}

interface Picked<T extends vscode.QuickPickItem> {
  readonly item: T | undefined;
  /** What was typed. */
  readonly value: string;
}

/** Resolves to the picked item and what was typed, or undefined when dismissed. */
function pick<T extends vscode.QuickPickItem>(items: readonly T[], { title, placeholder, value = '' }: PickArgs): Promise<Picked<T> | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<T>();
    qp.title = title;
    qp.placeholder = placeholder;
    qp.value = value;
    qp.items = items;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    let done = false;
    const finish = (r: Picked<T> | undefined): void => {
      if (done) return;
      done = true;
      resolve(r);
      qp.dispose();
    };
    qp.onDidAccept(() => finish({ item: qp.selectedItems[0], value: qp.value }));
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

// VS Code focuses the existing window when the target is already open there; otherwise it opens a new
// window. Without forceNewWindow it falls back to `window.openFoldersInNewWindow`, which by default
// replaces the current window.
async function openTarget(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openFolder', uri, {
    forceNewWindow: true,
    forceReuseWindow: false,
    noRecentEntry: false,
  });
}

async function worthListing(uri: vscode.Uri): Promise<boolean> {
  if (uri.scheme !== 'file') return true;
  if (isUnder(uri.fsPath, HIDDEN)) return false;
  return fs.access(uri.fsPath).then(
    () => true,
    () => false
  );
}

// `_workbench.getRecentlyOpened` is internal (there is no public API for the recent list): null when it is gone.
async function recentUris(): Promise<vscode.Uri[] | null> {
  try {
    return parseRecent(await vscode.commands.executeCommand<unknown>('_workbench.getRecentlyOpened'))?.map((parts) => vscode.Uri.from(parts)) ?? null;
  } catch {
    return null;
  }
}

export class Commands {
  constructor(
    private readonly windows: WindowRegistry,
    private readonly items: ProjectItems
  ) {}

  async open(): Promise<void> {
    const r = await pick(await this.openItems(), { title: 'Open Project Windows', placeholder: PLACEHOLDER });
    const item = r?.item;
    if (!r || !item) return;
    switch (item.action) {
      case 'recent':
        return this.recent(r.value);
      case 'project':
        if (!item.current) await openTarget(item.uri);
        return;
      case 'separator':
        return;
      default: {
        const unknownItem: never = item;
        return unknownItem;
      }
    }
  }

  async recent(value = ''): Promise<void> {
    const items = await this.recentItems();
    if (!items) {
      // This VS Code does not hand out the recent list: its own picker still works.
      await vscode.commands.executeCommand('workbench.action.openRecent');
      return;
    }
    if (!items.length) {
      vscode.window.showInformationMessage('Go To Project: no recent projects.');
      return;
    }
    const r = await pick(items, { title: 'Recent Projects', placeholder: PLACEHOLDER, value });
    if (r?.item) await openTarget(r.item.uri);
  }

  async last(): Promise<void> {
    const last = await this.windows.last(ownProject());
    if (!last) {
      vscode.window.showInformationMessage('Go To Project: no previous project yet.');
      return;
    }
    await openTarget(vscode.Uri.parse(last));
  }

  /** Projects inside the folder open in this window (the first one of a multi-root workspace). */
  async currentDirectory(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folder?.scheme !== 'file') {
      vscode.window.showInformationMessage('Go To Project: this window has no local folder open.');
      return;
    }
    return this.inDirectory(folder.fsPath);
  }

  /** Projects in the `slot`th entry of `goToProject.directories` (from 1). */
  async directory(slot: number): Promise<void> {
    const dir = settings().directories[slot - 1];
    if (dir) return this.inDirectory(untildify(dir, HOME));
    const answer = await vscode.window.showInformationMessage(`Go To Project: there is no directory ${slot} in goToProject.directories.`, ADD_DIRECTORY);
    if (answer === ADD_DIRECTORY) await this.addDirectory();
  }

  /** Appends a folder to `goToProject.directories`, then opens Keyboard Shortcuts at its command to give it a key. */
  async addDirectory(): Promise<void> {
    const { directories } = settings();
    if (directories.length >= DIRECTORY_SLOTS) {
      vscode.window.showWarningMessage(`Go To Project: ${DIRECTORY_SLOTS} directories is the most; remove one from goToProject.directories first.`);
      return;
    }
    const target = currentTarget();
    const picked = await vscode.window.showOpenDialog({
      title: 'Add a Projects Directory',
      openLabel: ADD_DIRECTORY,
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      ...(target?.scheme === 'file' ? { defaultUri: vscode.Uri.file(path.dirname(target.fsPath)) } : {}),
    });
    const dir = picked?.[0]?.fsPath;
    if (!dir) return;
    const shown = tildify(dir, HOME);
    const existing = directories.findIndex((d) => untildify(d, HOME) === dir);
    if (existing >= 0) {
      vscode.window.showInformationMessage(`Go To Project: ${shown} is already directory ${existing + 1}.`);
      return;
    }
    await vscode.workspace.getConfiguration('goToProject').update('directories', [...directories, shown], vscode.ConfigurationTarget.Global);
    const slot = directories.length + 1;
    await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', `goToProject.directory${slot}`);
    vscode.window.showInformationMessage(`Go To Project: ${shown} is directory ${slot}. Double-click "Go To Project in Directory ${slot}" to give it a key.`);
  }

  private async inDirectory(dir: string): Promise<void> {
    const shown = tildify(dir, HOME);
    let found: string[];
    try {
      found = await projectsIn(dir);
    } catch {
      vscode.window.showWarningMessage(`Go To Project: cannot read ${shown}.`);
      return;
    }
    if (!found.length) {
      vscode.window.showInformationMessage(`Go To Project: no projects in ${shown}.`);
      return;
    }
    const r = await pick(await this.items.list(found.map((f) => vscode.Uri.file(f))), { title: `Projects in ${shown}`, placeholder: PLACEHOLDER });
    if (r?.item && !r.item.current) await openTarget(r.item.uri);
  }

  /** Open windows, the one focused before this one first so Enter jumps straight back; then a way to the recent list. */
  private async openItems(): Promise<OpenWindowsItem[]> {
    const [open, { previous }] = await Promise.all([this.windows.open(ownProject()), this.windows.focusState()]);
    const items: OpenWindowsItem[] = await this.items.list(previousFirst(open, previous).map((u) => vscode.Uri.parse(u)));
    if (settings().includeRecent) {
      items.push({ action: 'separator', label: '', kind: vscode.QuickPickItemKind.Separator });
      // Shown whatever is typed, so a project that is not open is one Enter away.
      items.push({ action: 'recent', label: 'Recent projects…', iconPath: new vscode.ThemeIcon('history'), description: RECENT_KEY, alwaysShow: true });
    }
    return items;
  }

  private async recentItems(): Promise<ProjectItem[] | null> {
    const [open, recent] = await Promise.all([this.windows.open(ownProject()), recentUris()]);
    if (!recent) return null;
    const openSet = new Set(open);
    const candidates = recent.filter((u) => !openSet.has(projectUri(u)));
    const listed = await Promise.all(candidates.map(worthListing));
    return this.items.list(candidates.filter((_, i) => listed[i]));
  }
}
