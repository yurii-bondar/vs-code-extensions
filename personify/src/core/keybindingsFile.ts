// keybindings.json on disk: read, changed one write at a time, and replaced atomically so a crash never leaves half a file.
import * as path from 'path';
import { isRecord } from './json';
import { parseKeybindings } from './keybindings';

/** The file operations the store needs; Node's `fs.promises` in the extension, a map in tests. */
export interface FileSystem {
  readFile(file: string): Promise<string>;
  writeFile(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  /** Creates the folder and its parents; no error when it exists. */
  mkdir(dir: string): Promise<void>;
  realpath(file: string): Promise<string>;
}

export interface KeybindingsText {
  readonly file: string;
  readonly text: string;
  /** `text` parsed. */
  readonly list: unknown[];
}

const isMissing = (e: unknown): boolean => isRecord(e) && e.code === 'ENOENT';

export const BACKUP_SUFFIX = '.personify-backup';

export class KeybindingsFile {
  // Every write is read-modify-write; running them one after another keeps two quick edits from losing one.
  private queue: Promise<void> = Promise.resolve();
  private readonly backedUp = new Set<string>();

  constructor(
    private readonly fs: FileSystem,
    private readonly location: () => string
  ) {}

  get file(): string {
    return this.location();
  }

  /** `[]` for a file that does not exist yet or is empty. Any other error throws, so a write never replaces a file that could not be read. */
  async readText(file = this.file): Promise<string> {
    try {
      const text = await this.fs.readFile(file);
      return text.trim() ? text : '[]';
    } catch (e) {
      if (isMissing(e)) return '[]';
      throw e;
    }
  }

  async read(file = this.file): Promise<KeybindingsText> {
    const text = await this.readText(file);
    const list = parseKeybindings(text);
    if (!list) throw new Error('keybindings.json has syntax errors. Open it, fix them, then try again.');
    return { file, text, list };
  }

  /** Writes what `change` makes of the current file; nothing when it returns the same text. */
  update(change: (current: KeybindingsText) => string): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.read();
      const next = change(current);
      if (next !== current.text) await this.write(current.file, next);
    });
  }

  /** Puts `text` back into `file` unless it already holds it. */
  restore(file: string, text: string): Promise<void> {
    return this.enqueue(async () => {
      if ((await this.readText(file)) !== text) await this.write(file, text);
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // The first write to a file in a session saves a copy next to it. A symlinked file (dotfiles) is written through the link.
  private async write(file: string, text: string): Promise<void> {
    let target = file;
    try {
      target = await this.fs.realpath(file);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    await this.fs.mkdir(path.dirname(target));
    if (!this.backedUp.has(target)) {
      try {
        await this.fs.copyFile(target, `${target}${BACKUP_SUFFIX}`);
        this.backedUp.add(target);
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
    const tmp = `${target}.personify-tmp`;
    await this.fs.writeFile(tmp, text);
    await this.fs.rename(tmp, target);
  }
}
