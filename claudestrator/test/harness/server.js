// UI preview: serves the dashboard in a browser, backed by the real Orchestrator, DashboardPanel handlers
// and engine, with a stubbed `vscode` module and the fake Claude CLI. `npm run preview`, then open the URL.
//   PREVIEW_PORT=4780  PREVIEW_DELAY=600 (ms the fake agent waits per tool call)  PREVIEW_SETUP=1 (start configured)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const PORT = Number(process.env.PREVIEW_PORT || 4780);

// ---------- a throwaway workspace with two repos ----------
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-preview-')));
for (const [name, pkg] of [
  ['api', { name: 'api', description: 'Public REST API', scripts: { lint: 'eslint .', test: 'node -e "process.exit(0)"' }, devDependencies: { typescript: '5' } }],
  ['web', { name: 'web', description: 'Customer web app', scripts: { lint: 'node -e 0', 'test:unit': 'node -e 0' }, dependencies: { nuxt: '4' } }],
]) {
  const dir = path.join(ws, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}
// Repos somewhere else on disk, for the folder picker.
const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-elsewhere-')));
for (const [name, file, body] of [['billing', 'go.mod', 'module billing\n'], ['auth-service', 'package.json', JSON.stringify({ name: 'auth', scripts: { lint: 'eslint .', test: 'vitest run' }, devDependencies: { typescript: '5' } })]]) {
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
const settingsStore = { claudePath: FAKE, settingSources: ['project', 'local'], askPermissions: false, notifications: 'all', claudeConfigDir: '', workspaceFolder: '', nodePath: '', 'atlassian.site': '', 'atlassian.email': '' };
const listeners = [];
class EventEmitter {
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
  fire(v) {
    for (const f of this.fns) f(v);
  }
  dispose() {
    this.fns.clear();
  }
}
const disposable = { dispose() {} };
const log = (...a) => console.log('[vscode]', ...a);
const vscode = {
  EventEmitter,
  Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }), parse: (u) => ({ toString: () => u }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
  RelativePattern: class {},
  ViewColumn: { Active: -1, Beside: -2 },
  ConfigurationTarget: { Global: 1 },
  ThemeIcon: class {},
  ThemeColor: class {},
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ws } }],
    getConfiguration: () => ({
      get: (k) => settingsStore[k],
      update: async (k, v) => {
        settingsStore[k] = v;
        listeners.forEach((fn) => fn({ affectsConfiguration: (s) => s === 'claudestrator' || s === `claudestrator.${k}` }));
      },
    }),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    onDidChangeConfiguration: (fn, thisArg, disposables) => {
      listeners.push(thisArg ? fn.bind(thisArg) : fn);
      if (Array.isArray(disposables)) disposables.push(disposable);
      return disposable;
    },
    openTextDocument: async (u) => ({ uri: u }),
  },
  window: {
    showWarningMessage: async (msg, ...items) => {
      const choice = items.find((i) => typeof i === 'string');
      log('warning:', msg, '→', choice);
      return choice;
    },
    showInformationMessage: async (msg) => log('info:', msg),
    showErrorMessage: async (msg) => log('error:', msg),
    showTextDocument: async (d) => log('open', (d.uri || d).fsPath || d),
    showOpenDialog: async (o) => (o && o.canSelectFolders ? [{ fsPath: elsewhere }] : undefined),
    // A terminal with shellPath runs that process; exitStatus appears when it ends, like VS Code's.
    createTerminal: (o) => {
      const t = { show() {}, sendText: (x) => log('terminal', o.name, x), dispose() { if (t.proc) t.proc.kill(); }, exitStatus: undefined };
      if (o.shellPath) {
        t.proc = require('child_process').spawn(o.shellPath, o.shellArgs || [], { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: 'ignore' });
        t.proc.on('exit', (code) => (t.exitStatus = { code: code ?? undefined }));
      }
      return t;
    },
    onDidCloseTerminal: () => disposable,
  },
  commands: { executeCommand: async (...a) => log('command', ...a) },
  env: { openExternal: async (u) => log('openExternal', String(u)), clipboard: { writeText: async () => {} } },
  languages: { setTextDocumentLanguage: async () => {} },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};

const { Orchestrator } = require(path.join(ROOT, 'src', 'orchestrator.js'));
const { DashboardPanel } = require(path.join(ROOT, 'src', 'panel.js'));

const secrets = new Map();
const context = {
  globalStorageUri: { fsPath: path.join(state, 'global') },
  extensionPath: ROOT,
  extensionUri: { fsPath: ROOT },
  extension: { packageJSON: require(path.join(ROOT, 'package.json')) },
  globalState: { get: (k) => secrets.get(`gs:${k}`), update: async (k, v) => secrets.set(`gs:${k}`, v) },
  secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) },
  subscriptions: [],
};

const clients = new Set();
const broadcast = (msg) => {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(line);
};

(async () => {
  const orch = new Orchestrator(context);
  await orch.init();
  await orch.ensureReady();
  if (process.env.PREVIEW_SETUP) {
    const { createProjectConfig } = require(path.join(ROOT, 'src', 'core', 'config.js'));
    createProjectConfig(ws, { repos: { api: { gates: [{ name: 'lint', cmd: 'true' }] }, web: { gates: [{ name: 'flaky', cmd: 'test -f "$FAKE_STATE/ok" || { touch "$FAKE_STATE/ok"; echo "lint: 1 error in pages/index.vue"; exit 1; }' }] } } });
  }
  // A panel without a webview: same handlers, messages go to the browser over SSE.
  const panel = Object.create(DashboardPanel.prototype);
  Object.assign(panel, { context, orch, initialRoute: null, disposables: [], post: (m) => broadcast(m) });
  orch.onEngine(({ name, data }) => {
    if (name === 'output') broadcast({ type: 'output', ...data });
    else if (name === 'live') broadcast({ type: 'live', ...data });
    else if (name === 'permission') broadcast({ type: 'permission', request: data });
    else if (name === 'permissionDone') broadcast({ type: 'permissionDone', requestId: data });
    else if (name === 'log' && data.level !== 'info') broadcast({ type: 'toast', kind: data.level === 'error' ? 'error' : 'warn', text: data.message, taskId: data.taskId });
  });
  orch.onDidChange(() => broadcast({ type: 'changed' }));
  orch.onDidChangeConfig(() => broadcast({ type: 'config' }));

  const theme = fs.readFileSync(path.join(__dirname, 'theme-dark.css'), 'utf8');
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
      if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': hi\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.url === '/rpc' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          panel.onMessage(JSON.parse(body));
          res.writeHead(204).end();
        });
        return;
      }
      if (req.url.startsWith('/media/')) {
        const file = path.join(ROOT, 'media', path.basename(req.url));
        if (!fs.existsSync(file)) return res.writeHead(404).end();
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
        return res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
      }
      res.writeHead(404).end();
    })
    .listen(PORT, '127.0.0.1', () => console.log(`Claudestrator preview: http://127.0.0.1:${PORT}\nworkspace: ${ws}`));
})();
