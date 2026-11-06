import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addMissing, applyEdit, buildRows, humanize, parseDefaultKeybindings, toBinding } from './core/keybindings';
import { errorMessage, isRecord, str } from './core/json';
import { KeybindingsFile } from './core/keybindingsFile';
import type { Binding } from './core/keybindings';
import type { JsonObject } from './core/json';
import type { FileSystem } from './core/keybindingsFile';
import type { KeybindingEdit, KeybindingsState } from './core/types';

const DEFAULTS_URI = 'vscode://defaultsettings/keybindings.json';
const PLATFORM_KEY = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';

/** Every command and the titles extensions give them; they change only when extensions do. */
interface Commands {
  readonly ids: readonly string[];
  readonly titles: ReadonlyMap<string, string>;
}

interface Defaults {
  readonly list: readonly Binding[];
  /** Commands VS Code lists without a shortcut. */
  readonly unbound: readonly string[];
  readonly fromVscode: boolean;
}

/** A contribution point of an extension's package.json, always as a list. */
function contributed(packageJSON: unknown, point: string): unknown[] {
  const contributes = isRecord(packageJSON) ? packageJSON.contributes : undefined;
  const value = isRecord(contributes) ? contributes[point] : undefined;
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

const nodeFs: FileSystem = {
  readFile: (file) => fs.readFile(file, 'utf8'),
  writeFile: (file, text) => fs.writeFile(file, text),
  rename: (from, to) => fs.rename(from, to),
  copyFile: (from, to) => fs.copyFile(from, to),
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  },
  realpath: (file) => fs.realpath(file),
};

/** The user's keybindings.json, edited in place, plus the defaults it overrides. */
export class KeybindingStore {
  private defaults: Defaults | undefined;
  private commands: Commands | undefined;
  /** The text the last state was built from; null when the file could not be read. */
  private shownText: string | null = null;
  readonly disk: KeybindingsFile;

  constructor(private readonly globalStorage: vscode.Uri) {
    this.disk = new KeybindingsFile(nodeFs, () => this.file);
  }

  get file(): string {
    const custom = str(vscode.workspace.getConfiguration('personify').get<unknown>('keybindingsPath'));
    if (custom) return custom.replace(/^~(?=$|[\\/])/, os.homedir());
    // globalStorage is <user dir>/globalStorage/<extension id>; keybindings.json sits in <user dir>.
    return path.join(this.globalStorage.fsPath, '..', '..', 'keybindings.json');
  }

  apply(edit: KeybindingEdit): Promise<void> {
    return this.disk.update(({ text, list }) => applyEdit(text, list, edit));
  }

  /** Adds the entries the file does not have yet, in one write; how many were added. */
  async addMissing(entries: readonly JsonObject[]): Promise<number> {
    let added = 0;
    await this.disk.update(({ text, list }) => {
      const next = addMissing(text, list, entries);
      added = next.added;
      return next.text;
    });
    return added;
  }

  /** Drops what was read from extensions, after one was installed, removed or switched. */
  invalidate(): void {
    this.defaults = undefined;
    this.commands = undefined;
  }

  /** True while the file still holds what the last state showed, e.g. when the watcher sees Personify's own write. */
  async showsCurrentFile(): Promise<boolean> {
    try {
      return this.shownText !== null && (await this.disk.readText()) === this.shownText;
    } catch {
      return false;
    }
  }

  private extensionDefaults(): Binding[] {
    const list: Binding[] = [];
    for (const ext of vscode.extensions.all) {
      for (const kb of contributed(ext.packageJSON, 'keybindings')) {
        if (!isRecord(kb)) continue;
        const binding = toBinding({ key: kb[PLATFORM_KEY] || kb.key, command: kb.command, when: kb.when });
        if (binding) list.push(binding);
      }
    }
    return list;
  }

  private async loadDefaults(force: boolean): Promise<Defaults> {
    if (this.defaults && !force) return this.defaults;
    let parsed: { list: Binding[]; unbound: string[] } = { list: [], unbound: [] };
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(DEFAULTS_URI));
      parsed = parseDefaultKeybindings(doc.getText());
    } catch {
      // virtual document not available; fall back to extension manifests
    }
    const fromVscode = parsed.list.length > 0;
    this.defaults = { list: fromVscode ? parsed.list : this.extensionDefaults(), unbound: parsed.unbound, fromVscode };
    return this.defaults;
  }

  private async loadCommands(force: boolean): Promise<Commands> {
    if (this.commands && !force) return this.commands;
    const ids = (await vscode.commands.getCommands(true)).filter((c) => !c.startsWith('_'));
    this.commands = { ids, titles: this.commandTitles() };
    return this.commands;
  }

  private commandTitles(): Map<string, string> {
    const titles = new Map<string, string>();
    for (const ext of vscode.extensions.all) {
      for (const c of contributed(ext.packageJSON, 'commands')) {
        if (!isRecord(c)) continue;
        const command = str(c.command);
        const title = str(c.title);
        if (!command || title === null || title.startsWith('%')) continue;
        const category = str(c.category);
        titles.set(command, (category && !category.startsWith('%') ? `${category}: ` : '') + title);
      }
    }
    return titles;
  }

  async state(force = false): Promise<KeybindingsState> {
    const defaults = await this.loadDefaults(force);
    const known = await this.loadCommands(force);
    let user: unknown[] = [];
    let error: string | null = null;
    try {
      const read = await this.disk.read();
      user = read.list;
      this.shownText = read.text;
    } catch (e) {
      error = errorMessage(e);
      this.shownText = null;
    }
    const title = (id: string): string => known.titles.get(id) || humanize(id);
    const rows = buildRows({ defaults: defaults.list, user, title });

    const all = new Set([...known.ids, ...defaults.unbound]);
    const commands = [...all].sort().map((id) => ({ id, title: title(id) }));
    return { rows, commands, file: this.file, error, defaultsFromVscode: defaults.fromVscode };
  }
}
