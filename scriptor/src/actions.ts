import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCommand, shellKind } from './core/command';
import { markRun, removeGroup, removeScript } from './core/library';
import type { Group, GroupId, Script, ScriptId } from './core/types';
import type { Store } from './store';

const exists = (file: string): Promise<boolean> => fs.promises.access(file).then(() => true, () => false);

/** What can be done to a script or a group; the tree, the commands and the dashboard all go through here. */
export class Actions {
  constructor(private readonly store: Store) {}

  script(id: ScriptId): Script | undefined {
    return this.store.get().scripts.find((s) => s.id === id);
  }

  group(id: GroupId): Group | undefined {
    return this.store.get().groups.find((g) => g.id === id);
  }

  /** Runs the scripts, each in a terminal of its own, the same as opening it by hand. */
  async run(ids: readonly ScriptId[]): Promise<void> {
    const scripts = ids.map((id) => this.script(id)).filter((s): s is Script => !!s);
    const started: ScriptId[] = [];
    for (const [i, script] of scripts.entries()) {
      if (!(await exists(script.path))) {
        vscode.window.showErrorMessage(`Scriptor: "${script.name}" was not found at ${script.path}.`);
        continue;
      }
      const terminal = vscode.window.createTerminal({ name: `▶ ${script.name}`, cwd: script.cwd || path.dirname(script.path), iconPath: new vscode.ThemeIcon('play-circle') });
      terminal.show(i < scripts.length - 1);
      terminal.sendText(buildCommand({ script, shell: shellKind(vscode.env.shell), platform: process.platform }));
      started.push(script.id);
    }
    if (started.length) await this.store.update((lib) => markRun(lib, started, Date.now()));
  }

  runGroup(id: GroupId): Promise<void> {
    return this.run(this.store.get().scripts.filter((s) => s.groupId === id).map((s) => s.id));
  }

  async openFile(id: ScriptId): Promise<void> {
    const script = this.script(id);
    if (script) await vscode.window.showTextDocument(vscode.Uri.file(script.path));
  }

  async reveal(id: ScriptId): Promise<void> {
    const script = this.script(id);
    if (script) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(script.path));
  }

  /** Asks first; true when the script was removed. The file itself is never touched. */
  async removeScript(id: ScriptId): Promise<boolean> {
    const script = this.script(id);
    if (!script) return false;
    const yes = await vscode.window.showWarningMessage(`Remove "${script.name}" from Scriptor?`, { modal: true, detail: 'The file stays where it is.' }, 'Remove');
    if (yes !== 'Remove') return false;
    await this.store.update((lib) => removeScript(lib, id));
    return true;
  }

  async removeGroup(id: GroupId): Promise<boolean> {
    const group = this.group(id);
    if (!group) return false;
    const count = this.store.get().scripts.filter((s) => s.groupId === id).length;
    const detail = count ? `Its ${count} script${count === 1 ? '' : 's'} stay in Scriptor, without a group.` : undefined;
    const yes = await vscode.window.showWarningMessage(`Remove the group "${group.name}"?`, { modal: true, ...(detail ? { detail } : {}) }, 'Remove');
    if (yes !== 'Remove') return false;
    await this.store.update((lib) => removeGroup(lib, id));
    return true;
  }

  /** Asks for a file or a folder; undefined when cancelled. */
  async pick(target: 'file' | 'folder', from: string): Promise<string | undefined> {
    const [uri] =
      (await vscode.window.showOpenDialog({
        canSelectFiles: target === 'file',
        canSelectFolders: target === 'folder',
        canSelectMany: false,
        defaultUri: vscode.Uri.file(from || os.homedir()),
        openLabel: target === 'file' ? 'Select script' : 'Select folder',
      })) ?? [];
    return uri?.fsPath;
  }
}
