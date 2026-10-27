const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initials, iconColor, iconSvg, readBranch, tildify, isUnder, previousFirst } = require('./lib');

const HEARTBEAT_MS = 5000;
const STALE_MS = 15000;
const BRANCH_TTL_MS = 5000;

let registryFile;
let focusFile;
let iconDir;
let timer;
const windowId = vscode.env.sessionId;
const branchCache = new Map();

function currentTarget() {
  const ws = vscode.workspace;
  if (ws.workspaceFile && ws.workspaceFile.scheme !== 'untitled') return ws.workspaceFile;
  return ws.workspaceFolders && ws.workspaceFolders[0] ? ws.workspaceFolders[0].uri : undefined;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Windows share the extension's global storage dir, so a small file works as a cross-window registry.
function writeJson(file, data) {
  try {
    const tmp = `${file}.${windowId}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch {
    // best effort; another window may be writing
  }
}

function heartbeat() {
  const target = currentTarget();
  const registry = readJson(registryFile, {});
  const now = Date.now();
  for (const id of Object.keys(registry)) {
    if (now - registry[id].ts > STALE_MS) delete registry[id];
  }
  if (target) registry[windowId] = { uri: target.toString(), ts: now };
  else delete registry[windowId];
  writeJson(registryFile, registry);
  updateHasLast();
}

// Drives the `when` clause that enables "Go To Last Project".
function updateHasLast() {
  const { previous } = readJson(focusFile, {});
  const own = currentTarget();
  const hasLast = !!previous && (!own || previous !== own.toString());
  vscode.commands.executeCommand('setContext', 'goToProject.hasLast', hasLast);
}

function onFocused() {
  const target = currentTarget();
  if (!target) return;
  const uri = target.toString();
  const state = readJson(focusFile, {});
  if (state.current !== uri) writeJson(focusFile, { current: uri, previous: state.current });
}

function branchOf(uri) {
  if (uri.scheme !== 'file' || !vscode.workspace.getConfiguration('goToProject').get('showBranch')) return undefined;
  const key = uri.fsPath;
  const hit = branchCache.get(key);
  if (hit && Date.now() - hit.ts < BRANCH_TTL_MS) return hit.branch;
  let branch;
  try {
    branch = readBranch(fs.statSync(key).isDirectory() ? key : path.dirname(key));
  } catch {
    // unreadable path or no git
  }
  branchCache.set(key, { branch, ts: Date.now() });
  return branch;
}

const HOME = os.homedir();

function describe(uri) {
  const base = path.posix.basename(uri.path).replace(/\.code-workspace$/, '');
  const location = uri.scheme === 'file' ? uri.fsPath : uri.toString();
  return {
    label: base || uri.toString(),
    location: tildify(location, HOME),
  };
}

function projectIcon(name) {
  const text = initials(name);
  const color = iconColor(name);
  const file = path.join(iconDir, `${text}-${color.slice(1)}.svg`);
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, iconSvg(text, color));
    } catch {
      return new vscode.ThemeIcon('folder');
    }
  }
  return vscode.Uri.file(file);
}

// Recent entries that cannot be (or should not be) opened: deleted folders, the Trash, temp folders.
const HIDDEN = [path.join(HOME, '.Trash'), os.tmpdir(), '/tmp', '/private/tmp', '/private/var/folders', '/var/folders'];

function worthListing(uri) {
  if (uri.scheme !== 'file') return true;
  const p = uri.fsPath;
  if (isUnder(p, HIDDEN)) return false;
  return fs.existsSync(p);
}

// `_workbench.getRecentlyOpened` is internal (there is no public API for the recent list): null when it is gone.
async function recentUris() {
  try {
    const recent = await vscode.commands.executeCommand('_workbench.getRecentlyOpened');
    if (!recent) return null;
    return ((recent && recent.workspaces) || [])
      .map((w) => {
        const u = w.folderUri || w.workspace?.configPath;
        return u && vscode.Uri.from(u);
      })
      .filter(Boolean);
  } catch {
    return null;
  }
}

function openUris() {
  const own = currentTarget();
  const ownUri = own && own.toString();
  const registry = readJson(registryFile, {});
  const now = Date.now();
  const open = new Map();
  for (const [id, entry] of Object.entries(registry)) {
    if (id !== windowId && now - entry.ts > STALE_MS) continue;
    open.set(entry.uri, vscode.Uri.parse(entry.uri));
  }
  if (ownUri) open.set(ownUri, own);
  return open;
}

function projectItem(uri) {
  const own = currentTarget();
  const { label, location } = describe(uri);
  const branch = branchOf(uri);
  const isCurrent = !!own && uri.toString() === own.toString();
  return {
    label,
    iconPath: projectIcon(label),
    description: [branch && `$(git-branch) ${branch}`, isCurrent && '$(check) this window'].filter(Boolean).join('  '),
    detail: location,
    uri,
    current: isCurrent,
  };
}

const RECENT_KEY = process.platform === 'darwin' ? '⌥⌘E' : 'Ctrl+Alt+E';

/** Open windows, the one focused before this one first so Enter jumps straight back; then a way to the recent list. */
function openItems() {
  const { previous } = readJson(focusFile, {});
  const items = previousFirst(openUris().values(), previous).map((u) => projectItem(u));
  if (vscode.workspace.getConfiguration('goToProject').get('includeRecent')) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    // Shown whatever is typed, so a project that is not open is one Enter away.
    items.push({ label: 'Recent projects…', iconPath: new vscode.ThemeIcon('history'), description: RECENT_KEY, alwaysShow: true, recent: true });
  }
  return items;
}

async function recentItems() {
  const open = openUris();
  const recent = await recentUris();
  return recent && recent.filter((u) => !open.has(u.toString()) && worthListing(u)).map((u) => projectItem(u));
}

// VS Code focuses the existing window when the target is already open there.
function openTarget(uri) {
  return vscode.commands.executeCommand('vscode.openFolder', uri, {
    forceNewWindow: false,
    forceReuseWindow: false,
    noRecentEntry: false,
  });
}

/** Resolves to the picked item and what was typed, or undefined when dismissed. */
function pick(items, { title, placeholder, value = '' }) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    Object.assign(qp, { title, placeholder, value, items, matchOnDescription: true, matchOnDetail: true });
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
      qp.dispose();
    };
    qp.onDidAccept(() => finish({ item: qp.selectedItems[0], value: qp.value }));
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

async function goToProject() {
  const r = await pick(openItems(), { title: 'Open Project Windows', placeholder: 'Type a project name, branch or path' });
  if (!r || !r.item) return;
  if (r.item.recent) return goToRecent(r.value);
  if (r.item.uri && !r.item.current) await openTarget(r.item.uri);
}

async function goToRecent(value = '') {
  const items = await recentItems();
  if (!items) {
    // This VS Code does not hand out the recent list: its own picker still works.
    await vscode.commands.executeCommand('workbench.action.openRecent');
    return;
  }
  if (!items.length) {
    vscode.window.showInformationMessage('Go To Project: no recent projects.');
    return;
  }
  const r = await pick(items, { title: 'Recent Projects', placeholder: 'Type a project name, branch or path', value });
  if (r && r.item && r.item.uri) await openTarget(r.item.uri);
}

async function goToLast() {
  const { previous } = readJson(focusFile, {});
  const own = currentTarget();
  if (!previous || (own && previous === own.toString())) {
    vscode.window.showInformationMessage('Go To Project: no previous project yet.');
    return;
  }
  await openTarget(vscode.Uri.parse(previous));
}

function activate(context) {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  registryFile = path.join(dir, 'windows.json');
  focusFile = path.join(dir, 'focus.json');
  iconDir = path.join(dir, 'icons');
  fs.mkdirSync(iconDir, { recursive: true });

  heartbeat();
  if (vscode.window.state.focused) onFocused();
  timer = setInterval(heartbeat, HEARTBEAT_MS);

  context.subscriptions.push(
    vscode.commands.registerCommand('goToProject.open', goToProject),
    vscode.commands.registerCommand('goToProject.recent', () => goToRecent()),
    vscode.commands.registerCommand('goToProject.last', goToLast),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        onFocused();
        heartbeat();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(heartbeat),
    { dispose: () => clearInterval(timer) },
  );
}

function deactivate() {
  clearInterval(timer);
  if (!registryFile) return;
  const registry = readJson(registryFile, {});
  delete registry[windowId];
  writeJson(registryFile, registry);
}

module.exports = { activate, deactivate };
