import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyEdit, buildRows, humanize, parseDefaultKeybindings, parseKeybindings, toBinding } from './core/keybindings';
import { isRecord, str } from './core/json';
import type { Binding } from './core/keybindings';
import type { KeybindingEdit, KeybindingsState } from './core/types';

const DEFAULTS_URI = 'vscode://defaultsettings/keybindings.json';
const PLATFORM_KEY = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';

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

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The user's keybindings.json, edited in place, plus the defaults it overrides. */
export class KeybindingStore {
  private defaults: Defaults | undefined;
  private backedUp = false;

  constructor(private readonly globalStorage: vscode.Uri) {}

  get file(): string {
    const custom = str(vscode.workspace.getConfiguration('personify').get<unknown>('keybindingsPath'));
    if (custom) return custom.replace(/^~(?=$|[\\/])/, os.homedir());
    // globalStorage is <user dir>/globalStorage/<extension id>; keybindings.json sits in <user dir>.
    return path.join(this.globalStorage.fsPath, '..', '..', 'keybindings.json');
  }

  async readText(): Promise<string> {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      return text.trim() ? text : '[]';
    } catch {
      return '[]';
    }
  }

  async read(): Promise<{ text: string; list: unknown[] }> {
    const text = await this.readText();
    const list = parseKeybindings(text);
    if (!list) throw new Error('keybindings.json has syntax errors. Open it, fix them, then try again.');
    return { text, list };
  }

  /** The first write of a session saves a copy next to the file. */
  async writeText(text: string): Promise<void> {
    const file = this.file;
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (!this.backedUp) {
      try {
        await fs.copyFile(file, `${file}.personify-backup`);
        this.backedUp = true;
      } catch {
        // no file yet, nothing to back up
      }
    }
    await fs.writeFile(file, text);
  }

  async apply(edit: KeybindingEdit): Promise<void> {
    const { text, list } = await this.read();
    await this.writeText(applyEdit(text, list, edit));
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
    let user: unknown[] = [];
    let error: string | null = null;
    try {
      user = (await this.read()).list;
    } catch (e) {
      error = errorMessage(e);
    }
    const titles = this.commandTitles();
    const title = (id: string): string => titles.get(id) || humanize(id);
    const rows = buildRows({ defaults: defaults.list, user, title });

    const all = new Set([...(await vscode.commands.getCommands(true)).filter((c) => !c.startsWith('_')), ...defaults.unbound]);
    const commands = [...all].sort().map((id) => ({ id, title: title(id) }));
    return { rows, commands, file: this.file, error, defaultsFromVscode: defaults.fromVscode };
  }
}
