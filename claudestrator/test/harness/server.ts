// UI preview: serves the dashboard in a browser, backed by the real Orchestrator, DashboardPanel handlers
// and engine, with a stubbed `vscode` module and the fake Claude CLI. `npm run preview`, then open the URL.
//   PREVIEW_PORT=4780  PREVIEW_DELAY=600 (ms the fake agent waits per tool call)  PREVIEW_SETUP=1 (start configured)
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module from 'module';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import type * as vscodeApi from 'vscode';

// The stub below is loaded before the modules that `require('vscode')`, so they are required, not imported.
/* eslint-disable @typescript-eslint/no-require-imports */

// Runs from the build output (dist/test/harness): `DIST` is the compiled tree, `ROOT` the extension folder.
const DIST = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(DIST, '..');
const FAKE = path.join(DIST, 'test', 'fixtures', 'fake-claude.js');
const PORT = Number(process.env.PREVIEW_PORT || 4780);

// ---------- a throwaway workspace with two repos ----------
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-preview-')));
const repos: [string, object][] = [
  ['api', { name: 'api', description: 'Public REST API', scripts: { lint: 'eslint .', test: 'node -e "process.exit(0)"' }, devDependencies: { typescript: '5' } }],
  ['web', { name: 'web', description: 'Customer web app', scripts: { lint: 'node -e 0', 'test:unit': 'node -e 0' }, dependencies: { nuxt: '4' } }],
];
for (const [name, pkg] of repos) {
  const dir = path.join(ws, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}
// Repos somewhere else on disk, for the folder picker.
const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-elsewhere-')));
const elsewhereRepos: [string, string, string][] = [['billing', 'go.mod', 'module billing\n'], ['auth-service', 'package.json', JSON.stringify({ name: 'auth', scripts: { lint: 'eslint .', test: 'vitest run' }, devDependencies: { typescript: '5' } })]];
for (const [name, file, body] of elsewhereRepos) {
  const dir = path.join(elsewhere, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-preview-state-'));
Object.assign(process.env, { FAKE_STATE: state, FAKE_REPOS: 'api,web', FAKE_REVIEW: 'fail-once', FAKE_DELAY: process.env.PREVIEW_DELAY || '600', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' });

// ---------- vscode stub ----------
interface Disposable {
  dispose(): unknown;
}
interface FsUri {
  fsPath: string;
}
interface ConfigChange {
  affectsConfiguration(section: string): boolean;
}
interface Terminal {
  show(): void;
  sendText(text: string): void;
  dispose(): void;
  exitStatus: { code?: number | undefined } | undefined;
  proc?: ChildProcess;
}
interface TerminalOptions {
  name: string;
  shellPath?: string;
  shellArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

let savedFile: string | undefined;
const settingsStore: Record<string, unknown> = { claudePath: FAKE, settingSources: ['project', 'local'], askPermissions: false, notifications: 'all', claudeConfigDir: '', workspaceFolder: '', nodePath: '', 'atlassian.site': '', 'atlassian.email': '' };
const listeners: ((e: ConfigChange) => void)[] = [];
class EventEmitter<T = void> {
  fns: Set<(v: T) => void>;
  event: (fn: (v: T) => void, thisArg?: unknown, disposables?: Disposable[]) => Disposable;

  constructor() {
    this.fns = new Set();
    this.event = (fn, thisArg, disposables) => {
      const f = thisArg ? fn.bind(thisArg) : fn;
      this.fns.add(f);
      const d = { dispose: () => this.fns.delete(f) };
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    };
  }
  fire(v: T) {
    for (const f of this.fns) f(v);
  }
  dispose() {
    this.fns.clear();
  }
}
const disposable: Disposable = { dispose() {} };
const log = (...a: unknown[]) => console.log('[vscode]', ...a);
const vscode = {
  EventEmitter,
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }), parse: (u: string) => ({ toString: () => u }), joinPath: (u: FsUri, ...p: string[]) => ({ fsPath: path.join(u.fsPath, ...p) }) },
  RelativePattern: class {},
  ViewColumn: { Active: -1, Beside: -2 },
  ConfigurationTarget: { Global: 1 },
  ThemeIcon: class {},
  ThemeColor: class {},
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ws } }],
    getConfiguration: () => ({
      get: (k: string) => settingsStore[k],
      update: async (k: string, v: unknown) => {
        settingsStore[k] = v;
        listeners.forEach((fn) => fn({ affectsConfiguration: (s) => s === 'claudestrator' || s === `claudestrator.${k}` }));
      },
    }),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    onDidChangeConfiguration: (fn: (e: ConfigChange) => void, thisArg?: unknown, disposables?: Disposable[]) => {
      listeners.push(thisArg ? fn.bind(thisArg) : fn);
      if (Array.isArray(disposables)) disposables.push(disposable);
      return disposable;
    },
    openTextDocument: async (u: unknown) => ({ uri: u }),
  },
  window: {
    showWarningMessage: async (msg: string, ...items: unknown[]) => {
      const choice = items.find((i) => typeof i === 'string');
      log('warning:', msg, '→', choice);
      return choice;
    },
    // Like the warning: a question with buttons is answered with the first one.
    showInformationMessage: async (msg: string, ...items: unknown[]) => {
      const choice = items.find((i) => typeof i === 'string');
      log('info:', msg, ...(choice ? ['→', choice] : []));
      return choice;
    },
    showErrorMessage: async (msg: string) => log('error:', msg),
    showTextDocument: async (d: { uri?: FsUri; fsPath?: string }) => log('open', (d.uri || d).fsPath || d),
    // A file picked for saving is the one offered; opening a file picks the last one saved.
    showSaveDialog: async (o?: { defaultUri?: FsUri }) => (savedFile = o && o.defaultUri ? o.defaultUri.fsPath : undefined, savedFile ? { fsPath: savedFile } : undefined),
    showOpenDialog: async (o?: { canSelectFolders?: boolean }) => (o && o.canSelectFolders ? [{ fsPath: elsewhere }] : savedFile ? [{ fsPath: savedFile }] : undefined),
    // A terminal with shellPath runs that process; exitStatus appears when it ends, like VS Code's.
    createTerminal: (o: TerminalOptions) => {
      const t: Terminal = { show() {}, sendText: (x) => log('terminal', o.name, x), dispose() { if (t.proc) t.proc.kill(); }, exitStatus: undefined };
      if (o.shellPath) {
        t.proc = spawn(o.shellPath, o.shellArgs || [], { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: 'ignore' });
        t.proc.on('exit', (code) => (t.exitStatus = { code: code ?? undefined }));
      }
      return t;
    },
    onDidCloseTerminal: () => disposable,
  },
  commands: { executeCommand: async (...a: unknown[]) => log('command', ...a) },
  env: { openExternal: async (u: unknown) => log('openExternal', String(u)), clipboard: { writeText: async () => {} } },
  languages: { setTextDocumentLanguage: async () => {} },
};
const moduleLoader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const load = moduleLoader._load;
moduleLoader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};

// Loaded only now: they `require('vscode')`, which the loader above answers with the stub.
const { Orchestrator } = require(path.join(DIST, 'src', 'orchestrator.js')) as typeof import('../../src/orchestrator');
const { DashboardPanel } = require(path.join(DIST, 'src', 'panel.js')) as typeof import('../../src/panel');

const secrets = new Map<string, unknown>();
const context = {
  globalStorageUri: { fsPath: path.join(state, 'global') },
  extensionPath: ROOT,
  extensionUri: { fsPath: ROOT },
  extension: { packageJSON: require(path.join(ROOT, 'package.json')) as unknown },
  globalState: { get: (k: string) => secrets.get(`gs:${k}`), update: async (k: string, v: unknown) => secrets.set(`gs:${k}`, v) },
  secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => secrets.set(k, v), delete: async (k: string) => secrets.delete(k) },
  subscriptions: [],
} as unknown as vscodeApi.ExtensionContext;

const clients = new Set<http.ServerResponse>();
const broadcast = (msg: unknown) => {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(line);
};

(async () => {
  const orch = new Orchestrator(context);
  await orch.init();
  await orch.ensureReady();
  if (process.env.PREVIEW_SETUP) {
    const { createProjectConfig } = require(path.join(DIST, 'src', 'core', 'config.js')) as typeof import('../../src/core/config');
    createProjectConfig(ws, { repos: { api: { gates: [{ name: 'lint', cmd: 'true' }] }, web: { gates: [{ name: 'flaky', cmd: 'test -f "$FAKE_STATE/ok" || { touch "$FAKE_STATE/ok"; echo "lint: 1 error in pages/index.vue"; exit 1; }' }] } } });
  }
  // A panel without a webview: same handlers, messages go to the browser over SSE.
  const panel: InstanceType<typeof DashboardPanel> = Object.create(DashboardPanel.prototype);
  Object.assign(panel, { context, orch, initialRoute: null, disposables: [], post: (m: unknown) => broadcast(m) });
  orch.onEngine(({ name, data: payload }) => {
    const data = payload as Record<string, unknown>;
    if (name === 'output') broadcast({ type: 'output', ...data });
    else if (name === 'live') broadcast({ type: 'live', ...data });
    else if (name === 'permission') broadcast({ type: 'permission', request: data });
    else if (name === 'permissionDone') broadcast({ type: 'permissionDone', requestId: data });
    else if (name === 'log' && data.level !== 'info') broadcast({ type: 'toast', kind: data.level === 'error' ? 'error' : 'warn', text: data.message, taskId: data.taskId });
  });
  orch.onDidChange(() => broadcast({ type: 'changed' }));
  orch.onDidChangeConfig(() => broadcast({ type: 'config' }));

  const theme = fs.readFileSync(path.join(ROOT, 'test', 'harness', 'theme-dark.css'), 'utf8');
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Claudestrator preview</title>
<style>${theme}</style><link rel="stylesheet" href="/media/app.css"></head><body>
<div id="app"><div class="boot"><div class="spinner"></div></div></div><div id="toasts"></div><div id="modal-root"></div>
<script>
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => fetch('/rpc', { method: 'POST', body: JSON.stringify(m) }),
    getState: () => { try { return JSON.parse(sessionStorage.getItem('cs') || 'null'); } catch { return null; } },
    setState: (s) => sessionStorage.setItem('cs', JSON.stringify(s)),
  });
  const es = new EventSource('/events');
  es.onmessage = (e) => window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(e.data) }));
</script>
<script src="/media/markdown.js"></script><script src="/media/app.js"></script><script src="/media/task.js"></script><script src="/media/config.js"></script>
</body></html>`;

  http
    .createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(page);
        return;
      }
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': hi\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.url === '/rpc' && req.method === 'POST') {
        let body = '';
        req.on('data', (d: Buffer) => (body += d));
        req.on('end', () => {
          panel.onMessage(JSON.parse(body));
          res.writeHead(204).end();
        });
        return;
      }
      if (req.url!.startsWith('/media/')) {
        // Styles and icons are served from media/, the compiled scripts from dist/media.
        const name = path.basename(req.url!);
        const file = path.join(ROOT, name.endsWith('.js') ? path.join('dist', 'media') : 'media', name);
        if (!fs.existsSync(file)) {
          res.writeHead(404).end();
          return;
        }
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
        return;
      }
      res.writeHead(404).end();
    })
    .listen(PORT, '127.0.0.1', () => console.log(`Claudestrator preview: http://127.0.0.1:${PORT}\nworkspace: ${ws}`));
})();
