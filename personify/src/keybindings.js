const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jsonc = require('jsonc-parser');

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
const PARSE = { allowTrailingComma: true, disallowComments: false };
const DEFAULTS_URI = 'vscode://defaultsettings/keybindings.json';
const PLATFORM_KEY = { darwin: 'mac', win32: 'win' }[process.platform] || 'linux';

const edit = (text, p, value, extra) => jsonc.applyEdits(text, jsonc.modify(text, p, value, { ...FORMAT, ...extra }));
const append = (text, entry) => edit(text, [-1], entry, { isArrayInsertion: true });

// "cmd+shift+p" and "shift+cmd+p" are the same binding.
function normalizeKey(key) {
  return String(key || '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.split('+');
      const last = parts.pop();
      return [...parts.sort(), last].join('+');
    })
    .join(' ');
}

function humanize(id) {
  const rest = id.replace(/^(workbench\.action|editor\.action|workbench\.view|workbench)\./, '');
  const parts = rest.split('.');
  const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const name = cap(words(parts.pop()));
  return parts.length ? `${parts.map((p) => cap(words(p))).join(' ')}: ${name}` : name;
}

class KeybindingStore {
  constructor(context) {
    this.context = context;
    this.defaults = undefined;
    this.backedUp = false;
  }

  get file() {
    const custom = vscode.workspace.getConfiguration('personify').get('keybindingsPath');
    if (custom) return custom.replace(/^~(?=$|[\\/])/, os.homedir());
    // globalStorage is <user dir>/globalStorage/<extension id>; keybindings.json sits in <user dir>.
    return path.join(this.context.globalStorageUri.fsPath, '..', '..', 'keybindings.json');
  }

  readText() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      return text.trim() ? text : '[]';
    } catch {
      return '[]';
    }
  }

  read() {
    const text = this.readText();
    const errors = [];
    const list = jsonc.parse(text, errors, PARSE);
    if (errors.length || !Array.isArray(list)) {
      throw new Error('keybindings.json has syntax errors. Open it, fix them, then try again.');
    }
    return { text, list };
  }

  writeText(text) {
    const file = this.file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!this.backedUp && fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.personify-backup`);
      this.backedUp = true;
    }
    fs.writeFileSync(file, text);
  }

  extensionDefaults() {
    const list = [];
    for (const ext of vscode.extensions.all) {
      for (const kb of [].concat(ext.packageJSON?.contributes?.keybindings || [])) {
        const key = kb[PLATFORM_KEY] || kb.key;
        if (key && kb.command) list.push({ key, command: kb.command, when: kb.when });
      }
    }
    return list;
  }

  async loadDefaults(force) {
    if (this.defaults && !force) return this.defaults;
    let list = [];
    let unbound = [];
    let fromVscode = false;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(DEFAULTS_URI));
      const text = doc.getText();
      list = jsonc.parse(text, [], PARSE);
      // The file ends with commented-out "// - command.id" lines for commands that have no key.
      unbound = [...text.matchAll(/^\s*\/\/\s*-\s*([^\s]+)\s*$/gm)].map((m) => m[1]);
      fromVscode = Array.isArray(list) && list.length > 0;
    } catch {
      // virtual document not available; fall back to extension manifests
    }
    if (!fromVscode) list = this.extensionDefaults();
    this.defaults = { list: list.filter((k) => k && k.key && k.command), unbound, fromVscode };
    return this.defaults;
  }

  commandTitles() {
    const titles = new Map();
    for (const ext of vscode.extensions.all) {
      for (const c of [].concat(ext.packageJSON?.contributes?.commands || [])) {
        if (!c || !c.command || typeof c.title !== 'string' || c.title.startsWith('%')) continue;
        const category = typeof c.category === 'string' && !c.category.startsWith('%') ? `${c.category}: ` : '';
        titles.set(c.command, category + c.title);
      }
    }
    return titles;
  }

  async state(force) {
    const defaults = await this.loadDefaults(force);
    let user = [];
    let error;
    try {
      user = this.read().list;
    } catch (e) {
      error = e.message;
    }
    const titles = this.commandTitles();
    const title = (id) => titles.get(id) || humanize(id);

    const removals = user
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry && typeof entry.command === 'string' && entry.command.startsWith('-'));

    const rows = defaults.list.map((d, i) => {
      const removal = removals.find(
        ({ entry }) =>
          entry.command === `-${d.command}` &&
          (!entry.key || normalizeKey(entry.key) === normalizeKey(d.key)) &&
          (entry.when === undefined || entry.when === d.when)
      );
      return {
        id: `d${i}`,
        source: 'default',
        command: d.command,
        title: title(d.command),
        key: d.key,
        when: d.when || '',
        args: d.args,
        removed: Boolean(removal),
        removalIndex: removal ? removal.index : undefined,
      };
    });
    user.forEach((u, index) => {
      if (!u || typeof u.command !== 'string' || u.command.startsWith('-') || !u.key) return;
      rows.push({ id: `u${index}`, source: 'user', command: u.command, title: title(u.command), key: u.key, when: u.when || '', args: u.args, index });
    });

    const all = new Set([...(await vscode.commands.getCommands(true)).filter((c) => !c.startsWith('_')), ...defaults.unbound]);
    const commands = [...all].sort().map((id) => ({ id, title: title(id) }));

    return { rows, commands, file: this.file, error, defaultsFromVscode: defaults.fromVscode, platform: process.platform };
  }

  // ---- edits (each re-reads the file and checks the entry still matches) ----

  entryAt(list, index, command) {
    const entry = list[index];
    if (!entry || entry.command !== command) throw new Error('keybindings.json changed outside Personify. The list has been refreshed, please try again.');
    return entry;
  }

  add({ command, key, when, args }) {
    const { text } = this.read();
    const entry = { key, command };
    if (when) entry.when = when;
    if (args !== undefined) entry.args = args;
    this.writeText(append(text, entry));
  }

  update({ index, command, key, when }) {
    const { text, list } = this.read();
    this.entryAt(list, index, command);
    let next = edit(text, [index, 'key'], key);
    next = edit(next, [index, 'when'], when || undefined);
    this.writeText(next);
  }

  remove({ index, command }) {
    const { text, list } = this.read();
    this.entryAt(list, index, command);
    this.writeText(edit(text, [index], undefined));
  }

  disableDefault({ command, key, when }) {
    const { text } = this.read();
    const entry = { key, command: `-${command}` };
    if (when) entry.when = when;
    this.writeText(append(text, entry));
  }

  // Changing a default = disable the original + add the new one.
  replaceDefault({ command, oldKey, oldWhen, key, when, args }) {
    const { text } = this.read();
    const removal = { key: oldKey, command: `-${command}` };
    if (oldWhen) removal.when = oldWhen;
    const entry = { key, command };
    if (when) entry.when = when;
    if (args !== undefined) entry.args = args;
    this.writeText(append(append(text, removal), entry));
  }

  restoreDefault({ index, command }) {
    this.remove({ index, command: `-${command}` });
  }

  resetCommand({ command }) {
    const { text, list } = this.read();
    let next = text;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i] && list[i].command;
      if (c === command || c === `-${command}`) next = edit(next, [i], undefined);
    }
    this.writeText(next);
  }
}

module.exports = { KeybindingStore };
