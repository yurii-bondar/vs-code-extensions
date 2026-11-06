import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit } from '../src/core/keybindings';
import { BACKUP_SUFFIX, KeybindingsFile } from '../src/core/keybindingsFile';
import type { FileSystem } from '../src/core/keybindingsFile';

const fsError = (code: string): Error => Object.assign(new Error(code), { code });

/** Files in memory; `links` maps a symlink to its target, `failRead` makes reading a path fail with that code. */
class FakeFs implements FileSystem {
  readonly files = new Map<string, string>();
  readonly links = new Map<string, string>();
  readonly failRead = new Map<string, string>();
  readonly writes: string[] = [];
  /** Resolves each read only on the next tick, so two updates would interleave without the queue. */
  slow = false;

  async readFile(file: string): Promise<string> {
    if (this.slow) await new Promise((r) => setTimeout(r, 5));
    const code = this.failRead.get(file);
    if (code) throw fsError(code);
    const text = this.files.get(this.links.get(file) ?? file);
    if (text === undefined) throw fsError('ENOENT');
    return text;
  }
  async writeFile(file: string, text: string): Promise<void> {
    this.writes.push(file);
    this.files.set(file, text);
  }
  async rename(from: string, to: string): Promise<void> {
    const text = this.files.get(from);
    if (text === undefined) throw fsError('ENOENT');
    this.files.delete(from);
    this.files.set(to, text);
  }
  async copyFile(from: string, to: string): Promise<void> {
    const text = this.files.get(from);
    if (text === undefined) throw fsError('ENOENT');
    this.files.set(to, text);
  }
  async mkdir(): Promise<void> {}
  async realpath(file: string): Promise<string> {
    const target = this.links.get(file) ?? file;
    if (!this.files.has(target)) throw fsError('ENOENT');
    return target;
  }
}

const FILE = '/u/keybindings.json';
const add = (command: string) => (current: { text: string; list: unknown[] }): string => applyEdit(current.text, current.list, { op: 'add', command, key: 'a', when: '', args: undefined });

test('a missing or empty file reads as an empty list; any other read error throws and nothing is written', async () => {
  const fs = new FakeFs();
  const disk = new KeybindingsFile(fs, () => FILE);
  assert.equal(await disk.readText(), '[]');
  fs.files.set(FILE, '  \n');
  assert.equal(await disk.readText(), '[]');

  fs.files.set(FILE, '[{"key":"x","command":"keep"}]');
  fs.failRead.set(FILE, 'EACCES');
  await assert.rejects(disk.update(add('new')), /EACCES/);
  assert.equal(fs.files.get(FILE), '[{"key":"x","command":"keep"}]');
});

test('updates run one after another, so quick edits do not overwrite each other', async () => {
  const fs = new FakeFs();
  fs.slow = true;
  const disk = new KeybindingsFile(fs, () => FILE);
  await Promise.all([disk.update(add('one')), disk.update(add('two'))]);
  assert.deepEqual(
    (await disk.read()).list.map((k) => (k as { command: string }).command),
    ['one', 'two']
  );
});

test('writes go through a temp file, back up once, follow a symlink, and skip unchanged text', async () => {
  const fs = new FakeFs();
  fs.files.set('/dotfiles/kb.json', '[]');
  fs.links.set(FILE, '/dotfiles/kb.json');
  const disk = new KeybindingsFile(fs, () => FILE);
  await disk.update(add('one'));
  await disk.update(add('two'));
  assert.equal(fs.files.get(`/dotfiles/kb.json${BACKUP_SUFFIX}`), '[]');
  assert.ok(!fs.files.has(FILE), 'the link is not replaced by a file');
  assert.deepEqual(fs.writes, ['/dotfiles/kb.json.personify-tmp', '/dotfiles/kb.json.personify-tmp']);
  assert.ok(![...fs.files.keys()].some((f) => f.endsWith('.personify-tmp')));

  await disk.update((current) => current.text);
  await disk.restore(FILE, (await disk.read()).text);
  assert.equal(fs.writes.length, 2);
});

test('restore writes the text back into the file it came from', async () => {
  const fs = new FakeFs();
  let location = FILE;
  const disk = new KeybindingsFile(fs, () => location);
  fs.files.set(FILE, '[]');
  location = '/other/keybindings.json';
  await disk.restore(FILE, '[{"key":"a","command":"x"}]');
  assert.equal(fs.files.get(FILE), '[{"key":"a","command":"x"}]');
  assert.ok(!fs.files.has(location));
});
