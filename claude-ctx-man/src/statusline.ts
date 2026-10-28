import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as renderer from '../statusline/render';
import { isRecord, readJson, writeJson } from './json';
import { parseClientMessage } from './messages';
import type { RenderData } from '../statusline/render';
import type { SegmentConfig, SegmentId, StatusLineConfig } from '../statusline/types';
import type { Account } from './types';
import type { AccountView, ClientMessage, HostMessage, InstallStatus, PresetView } from './wire';

const DIR = path.join(os.homedir(), '.ctx-man');
const SCRIPT = path.join(DIR, 'statusline.js');
const META = path.join(DIR, 'statusline.meta.json');
const MARK = '.ctx-man/statusline.js';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---------- config ----------

export const readConfig = (): StatusLineConfig => renderer.normalizeConfig(readJson(renderer.CONFIG_FILE));

const writeConfig = (cfg: StatusLineConfig): void => writeJson(renderer.CONFIG_FILE, cfg);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Layout = [id: SegmentId, line: number, extra?: Partial<SegmentConfig>][];

/** The default config with only the listed segments on, in that order. */
function arrange(layout: Layout, extra: Partial<StatusLineConfig> = {}): StatusLineConfig {
  const cfg: StatusLineConfig = { ...clone(renderer.DEFAULT_CONFIG), ...extra };
  const order = layout.map(([id]) => id);
  const rank = (id: SegmentId): number => (order.includes(id) ? order.indexOf(id) : 99);
  cfg.segments = cfg.segments
    .map((s): SegmentConfig => {
      const hit = layout.find(([id]) => id === s.id);
      return hit ? { ...s, enabled: true, line: hit[1], ...hit[2] } : { ...s, enabled: false };
    })
    .sort((a, b) => rank(a.id) - rank(b.id));
  return cfg;
}

export function presets(): PresetView[] {
  const bars: Partial<SegmentConfig> = { format: 'both', thresholds: true };
  return [
    { id: 'current', label: 'Classic', hint: 'The two-line footer it starts with', config: clone(renderer.DEFAULT_CONFIG) },
    {
      id: 'enhanced',
      label: 'Enhanced',
      hint: 'Bars, colors by usage and cost',
      config: arrange([
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
    {
      id: 'compact',
      label: 'Compact',
      hint: 'Everything on one line',
      config: arrange(
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
    {
      id: 'minimal',
      label: 'Minimal',
      hint: 'Just the model and the context',
      config: arrange([
        ['model', 1],
        ['context', 1, { format: 'both', thresholds: true, label: '' }],
      ]),
    },
  ];
}

// ---------- install / restore ----------

function nodePath(): string | undefined {
  const candidates: string[] = [];
  const win = process.platform === 'win32';
  try {
    const out = win
      ? execFileSync('where.exe', ['node'], { encoding: 'utf8', timeout: 5000 })
      : execFileSync(process.env['SHELL'] || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh'), ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 5000 });
    candidates.push(...out.trim().split(/\r?\n/).reverse());
  } catch {
    // fall back to common locations
  }
  if (win) candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'nodejs', 'node.exe'));
  else candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  return candidates.find((p) => p && path.isAbsolute(p) && fs.existsSync(p));
}

const settingsFile = (dir: string): string => path.join(dir, 'settings.json');

type Settings = Record<string, unknown>;

function readSettings(dir: string): Settings {
  const json = readJson(settingsFile(dir), {});
  return isRecord(json) ? json : {};
}

export function statusOf(dir: string): InstallStatus {
  const sl = readSettings(dir)['statusLine'];
  if (!sl) return { kind: 'none' };
  const command = isRecord(sl) ? text(sl['command']) : '';
  if (command.includes(MARK)) return { kind: 'ctxman' };
  return { kind: 'custom', command: command || JSON.stringify(sl) };
}

/** Puts the renderer where Claude Code runs it from: one file, built from statusline/render.ts. */
function install(): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'statusline', 'render.js'), SCRIPT);
  fs.chmodSync(SCRIPT, 0o755);
}

function updateSettings(dir: string, mutate: (settings: Settings) => void): void {
  const file = settingsFile(dir);
  let settings: Settings = {};
  if (fs.existsSync(file)) {
    const original = fs.readFileSync(file, 'utf8');
    try {
      const parsed: unknown = original.trim() ? JSON.parse(original) : {};
      if (!isRecord(parsed)) throw new Error('not an object');
      settings = parsed;
    } catch {
      throw new Error(`${file} is not valid JSON; fix it first.`);
    }
    const backup = `${file}.ctx-man-backup`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  }
  mutate(settings);
  writeJson(file, settings);
}

/** Each folder's `statusLine` from before ours; `null` means there was none. */
interface Meta {
  previous: Record<string, unknown>;
}

function readMeta(): Meta {
  const json = readJson(META);
  return { previous: isRecord(json) && isRecord(json['previous']) ? json['previous'] : {} };
}

/** Remembers each folder's previous statusLine so Restore can put it back. */
export function apply(dirs: readonly string[]): void {
  const node = nodePath();
  if (!node) throw new Error('Could not find node. Set it up so `command -v node` works in a login shell.');
  install();
  const meta = readMeta();
  const command = `"${node}" "${SCRIPT}"`;
  for (const dir of dirs) {
    updateSettings(dir, (s) => {
      const current = s['statusLine'];
      if (!(isRecord(current) && text(current['command']).includes(MARK))) meta.previous[dir] = current === undefined ? null : current;
      s['statusLine'] = { type: 'command', command, padding: 0 };
    });
  }
  writeJson(META, meta);
}

export function restore(dirs: readonly string[]): void {
  const meta = readMeta();
  for (const dir of dirs) {
    if (!(dir in meta.previous)) continue;
    updateSettings(dir, (s) => {
      const before = meta.previous[dir];
      if (before === null) delete s['statusLine'];
      else s['statusLine'] = before;
    });
    delete meta.previous[dir];
  }
  writeJson(META, meta);
}

const hasPrevious = (dir: string): boolean => dir in readMeta().previous;

// ---------- preview data ----------

/** What a running status line wrote about a session, in `<account>/statusline/<session>.json`. */
interface Snapshot {
  model: string;
  email: string;
  project: string;
  git: string;
  effort: string;
  version: string;
  ctxPct: number | null;
  tokens: number;
  cost: number | null;
  fiveHour: unknown;
  sevenDay: unknown;
}

function readSnapshot(file: string): Snapshot | null {
  const j = readJson(file);
  if (!isRecord(j) || !text(j['model'])) return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    model: text(j['model']),
    email: text(j['email']),
    project: text(j['project']),
    git: text(j['git']),
    effort: text(j['effort']),
    version: text(j['version']),
    ctxPct: num(j['context_pct']),
    tokens: num(j['tokens']) ?? 0,
    cost: num(j['cost_usd']),
    fiveHour: j['five_hour'],
    sevenDay: j['seven_day'],
  };
}

function latestSnapshot(dirs: readonly string[]): { mtime: number; snap: Snapshot; dir: string } | undefined {
  let best: { mtime: number; snap: Snapshot; dir: string } | undefined;
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(dir, 'statusline')).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, 'statusline', f);
      const mtime = fs.statSync(full).mtimeMs;
      if (best && best.mtime >= mtime) continue;
      const snap = readSnapshot(full);
      if (snap) best = { mtime, snap, dir };
    }
  }
  return best;
}

/** Snapshot (written by the status line itself) as renderer data, with stale reset times moved forward. */
export function previewData(account: Account | undefined, cfg: StatusLineConfig, allDirs: readonly string[]): { data: RenderData; source: string } {
  const found = latestSnapshot(account ? [account.dir] : allDirs);
  const snap = found?.snap;
  const dir = account ? account.dir : found ? found.dir : (allDirs[0] ?? os.homedir());
  const now = Date.now() / 1000;
  const limit = (raw: unknown, windowSec: number, fallbackPct: number): { pct: number; resetsAt: number } => {
    const l = isRecord(raw) ? raw : {};
    const pct = typeof l['used_percentage'] === 'number' ? l['used_percentage'] : fallbackPct;
    let resetsAt = typeof l['resets_at'] === 'number' && l['resets_at'] ? l['resets_at'] : now + windowSec / 3;
    while (resetsAt < now) resetsAt += windowSec;
    return { pct, resetsAt };
  };
  // A real session outside a git repo has git "", which must stay empty rather than fall back to sample data.
  const gitText = snap ? snap.git : 'main !2 ?1';
  const gitParts = gitText.split(' ');
  const count = (prefix: string): number => Number((gitParts.find((p) => p.startsWith(prefix)) ?? `${prefix}0`).slice(1));
  const email = snap?.email || account?.email || '';
  const data: RenderData = {
    profile: renderer.profileFromEmail(email, dir, cfg),
    project: snap?.project || 'my-project',
    git: gitText ? { branch: gitParts[0] ?? '', ahead: snap ? 0 : 1, behind: 0, modified: count('!'), untracked: count('?') } : null,
    model: snap?.model || 'Opus 5.5',
    effort: snap?.effort || 'medium',
    ctxPct: snap?.ctxPct ?? 26,
    tokens: snap?.tokens || 31500000,
    cost: snap?.cost ?? 8.32,
    linesAdded: 214,
    linesRemoved: 37,
    durationMs: 65 * 60000,
    fiveHour: limit(snap?.fiveHour, 5 * 3600, 77),
    sevenDay: limit(snap?.sevenDay, 7 * 86400, 72),
    outputStyle: 'default',
    version: snap?.version || '2.1.310',
  };
  return { data, source: found ? `latest session of ${path.basename(found.dir)}` : 'sample data' };
}

// ---------- panel ----------

/** The status line editor: one panel for the whole window. */
export class StatusLinePanel {
  private static current: StatusLinePanel | undefined;
  private config: StatusLineConfig = readConfig();
  private previewDir = '';
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, store: { all: Account[]; isHidden(a: Account): boolean }): void {
    if (StatusLinePanel.current) StatusLinePanel.current.panel.reveal();
    else StatusLinePanel.current = new StatusLinePanel(context, store);
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly store: { all: Account[]; isHidden(a: Account): boolean }
  ) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const scripts = vscode.Uri.joinPath(context.extensionUri, 'dist', 'media');
    this.panel = vscode.window.createWebviewPanel('ctxManStatusLine', 'Claude Status Line', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media, scripts],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.png');
    this.panel.webview.html = this.html(media, scripts);
    this.disposables.push(
      this.panel.onDidDispose(() => {
        StatusLinePanel.current = undefined;
        this.disposables.forEach((d) => d.dispose());
      }),
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseClientMessage(raw);
        if (message) this.onMessage(message);
      })
    );
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private accounts(): AccountView[] {
    return this.store.all.map((a) => ({ dir: a.dir, label: a.label, email: a.email, status: statusOf(a.dir), canRestore: hasPrevious(a.dir), hidden: this.store.isHidden(a) }));
  }

  private preview(): void {
    const account = this.store.all.find((a) => a.dir === this.previewDir);
    const { data, source } = previewData(account, this.config, this.store.all.map((a) => a.dir));
    this.post({ type: 'preview', ansi: renderer.format(data, this.config), source });
  }

  private onMessage(msg: ClientMessage): void {
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
        case 'apply':
          writeConfig(this.config);
          apply(msg.dirs);
          this.post({ type: 'accounts', accounts: this.accounts() });
          this.post({ type: 'toast', kind: 'success', text: `Status line installed for ${msg.dirs.length} account${msg.dirs.length === 1 ? '' : 's'}. Running Claude sessions pick it up on the next render.` });
          return;
        case 'restore':
          restore(msg.dirs);
          this.post({ type: 'accounts', accounts: this.accounts() });
          this.post({ type: 'toast', kind: 'success', text: 'Previous status line restored.' });
          return;
        case 'openConfig':
          writeConfig(this.config);
          void vscode.window.showTextDocument(vscode.Uri.file(renderer.CONFIG_FILE));
          return;
        default: {
          const unreachable: never = msg;
          return unreachable;
        }
      }
    } catch (e) {
      this.post({ type: 'toast', kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  private html(media: vscode.Uri, scripts: vscode.Uri): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(media, 'statusline.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(scripts, 'statusline.js'));
    // style-src allows inline styles because colors (swatches, the terminal preview) are set per element.
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
  <div id="toasts" aria-live="polite"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
