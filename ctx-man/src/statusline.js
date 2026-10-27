const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const renderer = require('../statusline/render');

const DIR = path.join(os.homedir(), '.ctx-man');
const SCRIPT = path.join(DIR, 'statusline.js');
const META = path.join(DIR, 'statusline.meta.json');
const MARK = '.ctx-man/statusline.js';
const clone = (v) => JSON.parse(JSON.stringify(v));

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

// ---------- config ----------

// Keeps the user's order and settings, and adds segments introduced by newer versions.
function readConfig() {
  const def = clone(renderer.DEFAULT_CONFIG);
  const user = readJson(renderer.CONFIG_FILE, null);
  if (!user) return def;
  const segments = (user.segments || []).filter((s) => s && def.segments.some((d) => d.id === s.id));
  for (const d of def.segments) if (!segments.some((s) => s.id === d.id)) segments.push(d);
  return {
    ...def,
    ...user,
    thresholds: { ...def.thresholds, ...user.thresholds },
    compat: { ...def.compat, ...user.compat },
    segments: segments.map((s) => ({ ...def.segments.find((d) => d.id === s.id), ...s })),
  };
}

const writeConfig = (cfg) => writeJson(renderer.CONFIG_FILE, cfg);

function presets() {
  const base = renderer.DEFAULT_CONFIG;
  const make = (layout, extra = {}) => {
    const cfg = clone({ ...base, ...extra });
    const order = layout.map(([id]) => id);
    cfg.segments = cfg.segments
      .map((s) => {
        const hit = layout.find(([id]) => id === s.id);
        return hit ? { ...s, enabled: true, line: hit[1], ...hit[2] } : { ...s, enabled: false };
      })
      .sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : 99) - (order.includes(b.id) ? order.indexOf(b.id) : 99));
    return cfg;
  };
  const bars = { format: 'both', thresholds: true };
  return {
    current: { label: 'Your current style', config: clone(base) },
    enhanced: {
      label: 'Enhanced: bars, colors by usage, cost',
      config: make([
        ['profile', 1, { accountColor: true }],
        ['project', 1],
        ['git', 1, { join: true }],
        ['lines', 1],
        ['duration', 1],
        ['model', 2],
        ['effort', 2, { join: true }],
        ['context', 2, { ...bars }],
        ['tokens', 2],
        ['cost', 2],
        ['five_hour', 2, { ...bars }],
        ['seven_day', 2, { ...bars }],
      ]),
    },
    compact: {
      label: 'Compact: one line',
      config: make(
        [
          ['profile', 1, { icon: '', label: '' }],
          ['model', 1],
          ['effort', 1, { join: true }],
          ['context', 1, { thresholds: true }],
          ['five_hour', 1, { thresholds: true, showReset: false }],
          ['seven_day', 1, { thresholds: true, showReset: false }],
        ],
        { separator: ' · ', separatorColor: 'gray' }
      ),
    },
    minimal: {
      label: 'Minimal: model and context',
      config: make([
        ['model', 1],
        ['context', 1, { format: 'both', thresholds: true, label: '' }],
      ]),
    },
  };
}

// ---------- install / restore ----------

function nodePath() {
  const candidates = [];
  const win = process.platform === 'win32';
  try {
    const out = win
      ? execFileSync('where.exe', ['node'], { encoding: 'utf8', timeout: 5000 })
      : execFileSync(process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh'), ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 5000 });
    candidates.push(...out.trim().split(/\r?\n/).reverse());
  } catch {
    // fall back to common locations
  }
  if (win) candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  else candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  return candidates.find((p) => p && path.isAbsolute(p) && fs.existsSync(p));
}

function settingsFile(dir) {
  return path.join(dir, 'settings.json');
}

function statusOf(dir) {
  const settings = readJson(settingsFile(dir), {});
  const sl = settings && settings.statusLine;
  if (!sl) return { kind: 'none' };
  if (String(sl.command || '').includes(MARK)) return { kind: 'ctxman' };
  return { kind: 'custom', command: sl.command || JSON.stringify(sl) };
}

function install() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'statusline', 'render.js'), SCRIPT);
  fs.chmodSync(SCRIPT, 0o755);
}

function updateSettings(dir, mutate) {
  const file = settingsFile(dir);
  let settings = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    try {
      settings = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${file} is not valid JSON; fix it first.`);
    }
    const backup = `${file}.ctx-man-backup`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
  }
  mutate(settings);
  writeJson(file, settings);
}

// Remembers each folder's previous statusLine so "Restore" can put it back.
function apply(dirs) {
  const node = nodePath();
  if (!node) throw new Error('Could not find node. Set it up so `command -v node` works in a login shell.');
  install();
  const meta = readJson(META, { previous: {} });
  const command = `"${node}" "${SCRIPT}"`;
  for (const dir of dirs) {
    updateSettings(dir, (s) => {
      const current = s.statusLine;
      if (!(current && String(current.command || '').includes(MARK))) meta.previous[dir] = current === undefined ? null : current;
      s.statusLine = { type: 'command', command, padding: 0 };
    });
  }
  writeJson(META, meta);
}

function restore(dirs) {
  const meta = readJson(META, { previous: {} });
  for (const dir of dirs) {
    if (!(dir in meta.previous)) continue;
    updateSettings(dir, (s) => {
      if (meta.previous[dir] === null) delete s.statusLine;
      else s.statusLine = meta.previous[dir];
    });
    delete meta.previous[dir];
  }
  writeJson(META, meta);
}

const hasPrevious = (dir) => dir in readJson(META, { previous: {} }).previous;

// ---------- preview data ----------

function latestSnapshot(dirs) {
  let best;
  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(dir, 'statusline')).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, 'statusline', f);
      const mtime = fs.statSync(full).mtimeMs;
      if (best && best.mtime >= mtime) continue;
      const snap = readJson(full, null);
      if (snap && snap.model) best = { mtime, snap, dir };
    }
  }
  return best;
}

// Snapshot (written by the status line itself) → renderer data, with stale reset times moved forward.
function previewData(account, cfg, allDirs) {
  const found = latestSnapshot(account ? [account.dir] : allDirs);
  const snap = found ? found.snap : {};
  const dir = account ? account.dir : found ? found.dir : allDirs[0];
  const now = Date.now() / 1000;
  const limit = (l, windowSec, fallbackPct) => {
    const pct = l && l.used_percentage != null ? l.used_percentage : fallbackPct;
    let resetsAt = l && l.resets_at ? l.resets_at : now + windowSec / 3;
    while (resetsAt < now) resetsAt += windowSec;
    return { pct, resetsAt };
  };
  // A real session outside a git repo has git "", which must stay empty rather than fall back to sample data.
  const gitText = found ? snap.git : 'main !2 ?1';
  const gitParts = String(gitText || '').split(' ');
  const count = (prefix) => Number((gitParts.find((p) => p.startsWith(prefix)) || `${prefix}0`).slice(1));
  const email = snap.email || (account && account.email) || '';
  return {
    profile: renderer.profileFromEmail(email, dir, cfg),
    project: snap.project || 'my-project',
    git: gitText ? { branch: gitParts[0], ahead: found ? 0 : 1, behind: 0, modified: count('!'), untracked: count('?') } : null,
    model: snap.model || 'Opus 5.5',
    effort: snap.effort || 'medium',
    ctxPct: snap.context_pct != null ? snap.context_pct : 26,
    tokens: snap.tokens || 31500000,
    cost: snap.cost_usd != null ? snap.cost_usd : 8.32,
    linesAdded: 214,
    linesRemoved: 37,
    durationMs: 65 * 60000,
    fiveHour: limit(snap.five_hour, 5 * 3600, 77),
    sevenDay: limit(snap.seven_day, 7 * 86400, 72),
    outputStyle: 'default',
    version: snap.version || '2.1.310',
    source: found ? `latest session of ${path.basename(found.dir)}` : 'sample data',
  };
}

// ---------- panel ----------

class StatusLinePanel {
  static show(context, store) {
    if (StatusLinePanel.current) return StatusLinePanel.current.panel.reveal();
    StatusLinePanel.current = new StatusLinePanel(context, store);
  }

  constructor(context, store) {
    this.store = store;
    this.config = readConfig();
    this.previewDir = '';
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('ctxManStatusLine', 'Claude Status Line', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.webview.html = this.html(media);
    this.disposables = [
      this.panel.onDidDispose(() => {
        StatusLinePanel.current = undefined;
        this.disposables.forEach((d) => d.dispose());
      }),
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
    ];
  }

  post(msg) {
    this.panel.webview.postMessage(msg);
  }

  accounts() {
    return this.store.all.map((a) => ({ dir: a.dir, label: a.label, email: a.email || '', status: statusOf(a.dir), canRestore: hasPrevious(a.dir), hidden: this.store.isHidden(a) }));
  }

  preview() {
    const account = this.store.all.find((a) => a.dir === this.previewDir);
    const data = previewData(account, this.config, this.store.all.map((a) => a.dir));
    this.post({ type: 'preview', ansi: renderer.format(data, this.config), source: data.source });
  }

  async onMessage(msg) {
    try {
      switch (msg.type) {
        case 'ready':
          this.post({ type: 'init', config: this.config, accounts: this.accounts(), presets: presets(), configFile: renderer.CONFIG_FILE });
          return this.preview();
        case 'update':
          this.config = msg.config;
          writeConfig(this.config);
          return this.preview();
        case 'previewAccount':
          this.previewDir = msg.dir;
          return this.preview();
        case 'apply': {
          writeConfig(this.config);
          apply(msg.dirs);
          this.post({ type: 'accounts', accounts: this.accounts() });
          this.post({ type: 'toast', kind: 'success', text: `Status line installed for ${msg.dirs.length} account${msg.dirs.length > 1 ? 's' : ''}. Running Claude sessions pick it up on the next render.` });
          return;
        }
        case 'restore':
          restore(msg.dirs);
          this.post({ type: 'accounts', accounts: this.accounts() });
          this.post({ type: 'toast', kind: 'success', text: 'Previous status line restored.' });
          return;
        case 'openConfig':
          writeConfig(this.config);
          return vscode.window.showTextDocument(vscode.Uri.file(renderer.CONFIG_FILE));
      }
    } catch (e) {
      this.post({ type: 'toast', kind: 'error', text: e.message });
    }
  }

  html(media) {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(media, 'statusline.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(media, 'statusline.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Claude Status Line</title>
</head>
<body>
  <div id="app"></div>
  <div id="toasts"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

module.exports = { StatusLinePanel, readConfig, presets, apply, restore, statusOf, previewData };
