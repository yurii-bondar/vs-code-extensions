import * as vscode from 'vscode';
import { parseLibrary } from './core/library';
import type { Library } from './core/types';

const KEY = 'scriptor.library';

/** The scripts and groups, kept in VS Code's global state: paths belong to this machine, so they are not synced. */
export class Store implements vscode.Disposable {
  private library: Library;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly memento: vscode.Memento) {
    this.library = parseLibrary(memento.get<unknown>(KEY));
  }

  get(): Library {
    return this.library;
  }

  async update(change: (library: Library) => Library): Promise<void> {
    this.library = change(this.library);
    this.changed.fire();
    await this.memento.update(KEY, this.library);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
