// A stand-in for the `vscode` module, only as much of it as the Claudestrator engine (claudestrator/src/orchestrator.ts
// and panel.ts) touches. Anything that needs an editor (dialogs, opening a file, terminals, secrets) is asked of the
// IDE plugin over the transport; settings and file watching live here. The engine's code is not modified.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { request, send } from './transport';
import type { Settings } from './protocol';

interface Disposable {
  dispose(): unknown;
}
type Listener<T> = (value: T) => unknown;

class EventEmitter<T = void> {
  private readonly fns = new Set<Listener<T>>();

  readonly event = (fn: Listener<T>, thisArg?: unknown, disposables?: Disposable[]): Disposable => {
    const bound = thisArg ? fn.bind(thisArg) : fn;
    this.fns.add(bound);
    const d = { dispose: () => void this.fns.delete(bound) };
    if (Array.isArray(disposables)) disposables.push(d);
    return d;
  };

  fire(value: T): void {
    for (const fn of [...this.fns]) fn(value);
  }

  dispose(): void {
    this.fns.clear();
  }
}

// ---------- Uri ----------

interface Uri {
  fsPath: string;
  path: string;
  scheme: string;
  toString(): string;
}
const Uri = {
  file: (p: string): Uri => ({ fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` }),
  parse: (u: string): Uri => ({ fsPath: u, path: u, scheme: u.split(':')[0] || '', toString: () => u }),
  joinPath: (base: Uri, ...parts: string[]): Uri => Uri.file(path.join(base.fsPath, ...parts)),
};

// ---------- settings ----------

let settings: Settings = {};
const configListeners = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();

const lookup = (key: string): unknown => settings[key];

function setSettings(next: Settings, changed: string[]): void {
  settings = next;
  const affects = (section: string): boolean => changed.some((k) => k === section || k.startsWith(`${section}.`) || section.startsWith(`${k}.`));
  if (changed.length) configListeners.fire({ affectsConfiguration: affects });
}

const workspace = {
  workspaceFolders: [] as { uri: Uri }[],
  getConfiguration: (section?: string) => {
    const full = (key: string): string => (section ? `${section}.${key}` : key);
    return {
      get: <T>(key: string): T | undefined => lookup(full(key)) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        await request('setSetting', { key: full(key), value });
        // Taken after the round trip: a change the IDE pushed meanwhile is kept, not overwritten with an old copy.
        setSettings({ ...settings, [full(key)]: value }, [full(key)]);
      },
    };
  },
  onDidChangeConfiguration: configListeners.event,
  createFileSystemWatcher: (pattern: RelativePattern): FileSystemWatcher => watchFiles(pattern),
  openTextDocument: async (uri: Uri): Promise<{ uri: Uri; languageId?: string }> => ({ uri }),
  asRelativePath: (p: Uri | string): string => {
    const abs = typeof p === 'string' ? p : p.fsPath;
    const root = workspace.workspaceFolders[0];
    return root ? path.relative(root.uri.fsPath, abs) : abs;
  },
};

// ---------- file watching ----------

class RelativePattern {
  readonly base: string;
  constructor(base: Uri | string, readonly pattern: string) {
    this.base = typeof base === 'string' ? base : base.fsPath;
  }
}

interface FileSystemWatcher extends Disposable {
  onDidChange: EventEmitter<Uri>['event'];
  onDidCreate: EventEmitter<Uri>['event'];
  onDidDelete: EventEmitter<Uri>['event'];
}

/** `*` stays within a folder, `**` crosses folders. Enough for the two patterns the engine watches. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('/')
    .map((seg) => (seg === '**' ? '(?:.*)' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
    .join('/')
    .replace(/\/\(\?:\.\*\)$/, '(?:/.*)?');
  return new RegExp(`^${body}$`);
}

/** The folders of a glob before its first wildcard: `.orch/tasks` for the task logs, `.claudestrator` for the config. */
function staticPrefix(glob: string): string {
  const segments = glob.split('/');
  const wild = segments.findIndex((seg) => /[*?[{]/.test(seg));
  return segments.slice(0, wild === -1 ? segments.length - 1 : wild).join('/');
}

/** How often a folder that does not exist yet (`.orch/tasks` before the first task) is looked for. */
const APPEAR_POLL_MS = 2000;

/**
 * Watches only the folder the pattern can match in, not the whole workspace: a recursive watch of the workspace would
 * walk node_modules, .git and the agents' worktrees (on Linux, one inotify watch per folder). Recursive watching works
 * on macOS, Windows and, from Node 20 (the minimum, see main.ts), Linux.
 */
function watchFiles(pattern: RelativePattern): FileSystemWatcher {
  const changed = new EventEmitter<Uri>();
  const created = new EventEmitter<Uri>();
  const deleted = new EventEmitter<Uri>();
  const glob = pattern.pattern.replace(/\\/g, '/');
  const match = globToRegExp(glob);
  const prefix = staticPrefix(glob);
  const dir = path.join(pattern.base, prefix);
  let watcher: fs.FSWatcher | undefined;
  let poll: NodeJS.Timeout | undefined;

  const start = (): void => {
    try {
      watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, name) => {
        if (!name) return;
        const rel = [prefix, name.toString().replace(/\\/g, '/')].filter(Boolean).join('/');
        if (!match.test(rel)) return;
        const full = path.join(pattern.base, rel);
        const uri = Uri.file(full);
        // fs.watch does not say which it was; look. The engine treats a new file as a changed one.
        fs.stat(full, (err) => (err ? deleted.fire(uri) : changed.fire(uri)));
      });
      watcher.on('error', (e) => console.error('[sidecar] watching', dir, 'failed:', e.message));
    } catch (e) {
      console.error('[sidecar] cannot watch', dir, (e as Error).message);
    }
  };
  if (fs.existsSync(dir)) start();
  else {
    poll = setInterval(() => {
      if (!fs.existsSync(dir)) return;
      clearInterval(poll);
      poll = undefined;
      start();
    }, APPEAR_POLL_MS);
    poll.unref();
  }
  return {
    onDidChange: changed.event,
    onDidCreate: created.event,
    onDidDelete: deleted.event,
    dispose: () => {
      if (poll) clearInterval(poll);
      watcher?.close();
      [changed, created, deleted].forEach((e) => e.dispose());
    },
  };
}

// ---------- window: messages, dialogs, files ----------

type Level = 'info' | 'warning' | 'error';
interface MessageOptions {
  modal?: boolean;
  detail?: string;
}

/** `showWarningMessage(message, [options], ...items)`: the choice that was made, else undefined. */
async function showMessage(level: Level, message: string, args: unknown[]): Promise<string | undefined> {
  const options: MessageOptions = args[0] && typeof args[0] === 'object' ? (args[0] as MessageOptions) : {};
  const items = args.filter((a): a is string => typeof a === 'string');
  return request<string | undefined>('showMessage', { level, message, modal: Boolean(options.modal), detail: options.detail, items });
}

interface OpenDialogOptions {
  canSelectFolders?: boolean;
  canSelectFiles?: boolean;
  canSelectMany?: boolean;
  defaultUri?: Uri;
  openLabel?: string;
  title?: string;
  filters?: Record<string, string[]>;
}

interface TextDocument {
  uri: Uri;
  languageId?: string;
}

// ---------- window: terminals ----------

interface TerminalOptions {
  name: string;
  shellPath?: string;
  shellArgs?: string[];
  cwd?: string;
  env?: Record<string, string | null | undefined>;
}

class Terminal {
  exitStatus: { code: number | undefined } | undefined;
  private static count = 0;
  readonly id = ++Terminal.count;

  constructor(private readonly options: TerminalOptions) {
    // A terminal that runs one process (a sign-in) is run by the IDE and reports when it ends; one without is a shell
    // the engine types a command into.
    const { shellPath, shellArgs, ...rest } = options;
    void request('terminalOpen', { id: this.id, ...rest, command: shellPath ? [shellPath, ...(shellArgs || [])] : null }).catch((e) => console.error('[sidecar] terminal', (e as Error).message));
    terminals.set(this.id, this);
  }

  show(): void {
    void request('terminalShow', { id: this.id }).catch(() => undefined);
  }

  sendText(text: string): void {
    void request('terminalSend', { id: this.id, text: withEnv(text, this.options.env) }).catch(() => undefined);
  }

  /** As in VS Code, a disposed terminal is a closed one: `onDidCloseTerminal` fires (the engine waits for it). */
  dispose(): void {
    void request('terminalClose', { id: this.id }).catch(() => undefined);
    terminalClosed(this.id, undefined);
  }
}

const terminals = new Map<number, Terminal>();
const closeListeners = new EventEmitter<Terminal>();

/** A shell started by the IDE has no per-terminal env, so what the engine set for it is put in front of the command. */
function withEnv(command: string, env: TerminalOptions['env']): string {
  const entries = Object.entries(env || {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '');
  if (!entries.length) return command;
  if (process.platform === 'win32') return `${entries.map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}'`).join('; ')}; ${command}`;
  return `${entries.map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`).join(' ')} ${command}`;
}

function terminalClosed(id: number, code: number | undefined): void {
  const t = terminals.get(id);
  if (!t) return;
  t.exitStatus = { code };
  terminals.delete(id);
  closeListeners.fire(t);
}

// ---------- window: the dashboard panel ----------

interface Webview {
  html: string;
  options: unknown;
  cspSource: string;
  asWebviewUri(uri: Uri): Uri;
  postMessage(msg: unknown): Promise<boolean>;
  onDidReceiveMessage: EventEmitter<unknown>['event'];
}

/** False while a panel is made for a dashboard the IDE already shows (after an engine restart): nothing to bring forward. */
let revealPanels = true;

function quietly<T>(fn: () => T): T {
  revealPanels = false;
  try {
    return fn();
  } finally {
    revealPanels = true;
  }
}

const revealDashboard = (): void => {
  if (revealPanels) send({ type: 'revealDashboard' });
};

/** What the engine's DashboardPanel needs of a webview panel; the IDE shows the page and relays messages. */
function createWebviewPanel(): unknown {
  const disposed = new EventEmitter<void>();
  const viewState = new EventEmitter<{ webviewPanel: { active: boolean } }>();
  const received = new EventEmitter<unknown>();
  pageInbox = received;
  const webview: Webview = {
    html: '',
    options: {},
    cspSource: '',
    asWebviewUri: (uri) => uri,
    postMessage: async (msg) => {
      send({ type: 'post', msg });
      return true;
    },
    onDidReceiveMessage: received.event,
  };
  revealDashboard();
  const panel = {
    webview,
    visible: true,
    active: true,
    viewColumn: 1,
    iconPath: undefined as unknown,
    onDidDispose: disposed.event,
    onDidChangeViewState: viewState.event,
    reveal: revealDashboard,
    dispose: () => disposed.fire(),
  };
  panelDisposed = () => {
    pageInbox = undefined;
    disposed.fire();
  };
  return panel;
}

/** Where messages from the page go, and what runs when the IDE closes the page. Set while a panel exists. */
let pageInbox: EventEmitter<unknown> | undefined;
let panelDisposed: (() => void) | undefined;
const deliverPageMessage = (msg: unknown): void => pageInbox?.fire(msg);
const closeDashboard = (): void => panelDisposed?.();

const window = {
  createWebviewPanel,
  showInformationMessage: (message: string, ...args: unknown[]) => showMessage('info', message, args),
  showWarningMessage: (message: string, ...args: unknown[]) => showMessage('warning', message, args),
  showErrorMessage: (message: string, ...args: unknown[]) => showMessage('error', message, args),
  showTextDocument: async (target: TextDocument | Uri, options?: { viewColumn?: number; preview?: boolean }): Promise<void> => {
    const doc = 'uri' in target ? target : { uri: target };
    await request('openFile', { path: doc.uri.fsPath, language: doc.languageId, beside: options?.viewColumn === ViewColumn.Beside });
  },
  showOpenDialog: async (options: OpenDialogOptions = {}): Promise<Uri[] | undefined> => {
    const picked = await request<string[] | undefined>('openDialog', { ...options, defaultPath: options.defaultUri?.fsPath });
    return picked?.map(Uri.file);
  },
  createTerminal: (options: TerminalOptions): Terminal => new Terminal(options),
  onDidCloseTerminal: closeListeners.event,
};

const languages = {
  setTextDocumentLanguage: async (doc: TextDocument, languageId: string): Promise<TextDocument> => {
    doc.languageId = languageId;
    return doc;
  },
};

const commands = {
  executeCommand: async (command: string, ...args: unknown[]): Promise<void> => {
    const target = args[0] as Uri | undefined;
    if (command === 'markdown.showPreviewToSide' && target) await request('openFile', { path: target.fsPath, preview: true, beside: true });
    else if (command === 'revealInExplorer' && target) await request('reveal', { path: target.fsPath, inOS: false });
    else if (command === 'revealFileInOS' && target) await request('reveal', { path: target.fsPath, inOS: true });
    else if (command !== 'setContext') console.error('[sidecar] ignored command', command);
  },
};

const env = {
  openExternal: async (uri: Uri): Promise<boolean> => {
    await request('openExternal', { url: uri.toString() });
    return true;
  },
  clipboard: { writeText: async (text: string): Promise<void> => void (await request('clipboard', { text })) },
};

// ---------- the extension context ----------

interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

/** Small JSON file; what the engine keeps here (the last known usage limits) is cheap to lose. */
function fileMemento(file: string): Memento {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // first run, or unreadable: start empty
  }
  return {
    get: <T>(key: string) => data[key] as T | undefined,
    update: async (key, value) => {
      data = { ...data, [key]: value };
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(data));
    },
  };
}

interface ExtensionContext {
  globalStorageUri: Uri;
  extensionPath: string;
  extensionUri: Uri;
  extension: { packageJSON: { version: string } };
  globalState: Memento;
  secrets: { get(key: string): Promise<string | undefined>; store(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
  subscriptions: Disposable[];
}

/** Secrets (the Atlassian token) go to the IDE's password safe, not to a file. */
function createContext(options: { storageDir: string; extensionDir: string; version: string }): ExtensionContext {
  fs.mkdirSync(options.storageDir, { recursive: true });
  return {
    globalStorageUri: Uri.file(options.storageDir),
    extensionPath: options.extensionDir,
    extensionUri: Uri.file(options.extensionDir),
    extension: { packageJSON: { version: options.version } },
    globalState: fileMemento(path.join(options.storageDir, 'global-state.json')),
    secrets: {
      get: (key) => request<string | undefined>('secret', { op: 'get', key }),
      store: async (key, value) => void (await request('secret', { op: 'store', key, value })),
      delete: async (key) => void (await request('secret', { op: 'delete', key })),
    },
    subscriptions: [],
  };
}

// ---------- the rest of the API the engine names ----------

const ViewColumn = { Active: -1, Beside: -2 } as const;
const ConfigurationTarget = { Global: 1 } as const;
class ThemeIcon {
  constructor(readonly id: string) {}
}
class ThemeColor {
  constructor(readonly id: string) {}
}

function setWorkspaceFolders(folders: string[]): void {
  workspace.workspaceFolders = folders.map((f) => ({ uri: Uri.file(f) }));
}

export {
  EventEmitter,
  Uri,
  RelativePattern,
  ViewColumn,
  ConfigurationTarget,
  ThemeIcon,
  ThemeColor,
  workspace,
  window,
  languages,
  commands,
  env,
  // not part of vscode: how main.ts feeds the shim
  createContext,
  setSettings,
  setWorkspaceFolders,
  deliverPageMessage,
  closeDashboard,
  quietly,
  terminalClosed,
};
export type { ExtensionContext };
