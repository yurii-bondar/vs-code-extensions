#!/usr/bin/env node
// Ctx Man status line for Claude Code.
// Claude Code runs this on every footer render with a JSON payload on stdin; it prints the footer.
// Layout and colors come from ~/.ctx-man/statusline.json (written by the Ctx Man extension),
// so edits apply on the next render. Installed copy: ~/.ctx-man/statusline.js (built from this file).
// It must stay one self-contained file: only Node's own modules are loaded.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { AccountStyle, BarFormat, SegmentConfig, SegmentId, StatusLineConfig } from './types';

const HOME = os.homedir();
export const CONFIG_FILE = path.join(HOME, '.ctx-man', 'statusline.json');
const CACHE_DIR = path.join(os.tmpdir(), 'ctx-man-statusline');
const expand = (p: string): string => p.replace(/^~(?=$|[\\/])/, HOME);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------- defaults ----------

const seg = (id: SegmentId, line: number, extra: Partial<SegmentConfig> = {}): SegmentConfig => ({ id, line, enabled: true, icon: '', label: '', color: '', bold: false, join: false, ...extra });

export const DEFAULT_CONFIG: StatusLineConfig = {
  version: 1,
  separator: ' | ',
  separatorColor: '',
  thresholds: { warn: 60, danger: 85, okColor: '', warnColor: '#e5c07b', dangerColor: '#e06c75' },
  barWidth: 8,
  accounts: {},
  compat: { tmuxStateFile: true, sessionSnapshots: true, disableFile: true },
  segments: [
    seg('profile', 1, { icon: '👤', label: 'profile: ', color: 'magenta', accountColor: true }),
    seg('project', 1, { icon: '📁', color: 'magenta' }),
    seg('git', 1, { icon: '🌿', color: 'yellow', join: true, showDirty: true, showAheadBehind: true }),
    seg('model', 2, { color: 'cyan' }),
    seg('effort', 2, { join: true, colorByLevel: true }),
    seg('context', 2, { label: 'ctx ', color: 'green', format: 'pct', thresholds: false }),
    seg('tokens', 2, { label: 'tok ', color: '#87afd7' }),
    seg('five_hour', 2, { label: '5h', color: '#ffaf00', format: 'pct', showReset: true, thresholds: false }),
    seg('seven_day', 2, { label: 'wk', color: '#ffaf00', format: 'pct', showReset: true, thresholds: false }),
    seg('cost', 2, { enabled: false, label: '$', color: 'green' }),
    seg('lines', 2, { enabled: false, color: '' }),
    seg('duration', 2, { enabled: false, label: '⏱ ', color: 'gray' }),
    seg('clock', 1, { enabled: false, color: 'gray' }),
    seg('output_style', 2, { enabled: false, label: 'style ', color: 'gray' }),
    seg('version', 1, { enabled: false, label: 'v', color: 'gray' }),
    seg('text', 1, { enabled: false, text: '', color: '' }),
  ],
};

// ---------- reading the config file ----------

const OPTION_KEYS = ['accountColor', 'showAheadBehind', 'showDirty', 'colorByLevel', 'thresholds', 'showReset', 'format', 'text'] as const;
const FORMATS: readonly BarFormat[] = ['pct', 'bar', 'both'];

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** The default segment with the user's values laid over it; a value of the wrong type is ignored. */
function mergeSegment(base: SegmentConfig, user: Record<string, unknown>): SegmentConfig {
  const out: SegmentConfig = {
    ...base,
    line: num(user['line'], base.line),
    enabled: bool(user['enabled'], base.enabled),
    icon: str(user['icon'], base.icon),
    label: str(user['label'], base.label),
    color: str(user['color'], base.color),
    bold: bool(user['bold'], base.bold),
    join: bool(user['join'], base.join),
  };
  for (const key of OPTION_KEYS) {
    const v = user[key];
    if (key === 'format') {
      const format = FORMATS.find((f) => f === v);
      if (format) out.format = format;
    } else if (key === 'text') {
      if (typeof v === 'string') out.text = v;
    } else if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

function mergeAccounts(raw: unknown): Record<string, AccountStyle> {
  const out: Record<string, AccountStyle> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const style: AccountStyle = {};
    if (typeof value['label'] === 'string') style.label = value['label'];
    if (typeof value['color'] === 'string') style.color = value['color'];
    out[key] = style;
  }
  return out;
}

/**
 * Any JSON as a valid config: the user's order and settings are kept, anything of the wrong type falls back to the
 * default, and segments that newer versions added are appended.
 */
export function normalizeConfig(raw: unknown): StatusLineConfig {
  const def: StatusLineConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as StatusLineConfig;
  if (!isRecord(raw)) return def;
  const segments: SegmentConfig[] = [];
  for (const user of Array.isArray(raw['segments']) ? raw['segments'] : []) {
    const base = isRecord(user) ? def.segments.find((d) => d.id === user['id']) : undefined;
    if (isRecord(user) && base && !segments.some((s) => s.id === base.id)) segments.push(mergeSegment(base, user));
  }
  for (const d of def.segments) if (!segments.some((s) => s.id === d.id)) segments.push(d);
  const t = isRecord(raw['thresholds']) ? raw['thresholds'] : {};
  const c = isRecord(raw['compat']) ? raw['compat'] : {};
  return {
    version: def.version,
    separator: str(raw['separator'], def.separator),
    separatorColor: str(raw['separatorColor'], def.separatorColor),
    thresholds: {
      warn: num(t['warn'], def.thresholds.warn),
      danger: num(t['danger'], def.thresholds.danger),
      okColor: str(t['okColor'], def.thresholds.okColor),
      warnColor: str(t['warnColor'], def.thresholds.warnColor),
      dangerColor: str(t['dangerColor'], def.thresholds.dangerColor),
    },
    barWidth: Math.min(30, Math.max(3, Math.round(num(raw['barWidth'], def.barWidth)))),
    accounts: mergeAccounts(raw['accounts']),
    compat: {
      tmuxStateFile: bool(c['tmuxStateFile'], def.compat.tmuxStateFile),
      sessionSnapshots: bool(c['sessionSnapshots'], def.compat.sessionSnapshots),
      disableFile: bool(c['disableFile'], def.compat.disableFile),
    },
    segments,
  };
}

function loadConfig(): StatusLineConfig {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return normalizeConfig(undefined);
  }
}

// ---------- colors ----------

const NAMED: Readonly<Record<string, number>> = { black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90, grey: 90, brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97 };
const RESET = '\x1b[0m';

function sgr(color: string | undefined, bold: boolean): string {
  const codes: number[] = [];
  if (bold) codes.push(1);
  if (color) {
    const named = NAMED[color];
    if (named !== undefined) codes.push(named);
    else if (/^#[0-9a-f]{6}$/i.test(color)) codes.push(38, 2, parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16));
    else if (/^\d{1,3}$/.test(color)) codes.push(38, 5, Number(color));
  }
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

const paint = (value: string, color: string | undefined, bold = false): string => {
  const open = sgr(color, bold);
  return open ? `${open}${value}${RESET}` : value;
};

// ---------- formatting helpers ----------

function fmtTokens(n: number): string {
  if (!n) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtRemaining(resetsAt: number, now: number): string {
  if (!resetsAt) return '';
  const diff = Math.max(0, Math.floor(resetsAt - now / 1000));
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d >= 1) return `${d}d ${h}h`;
  return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDuration(ms: number): string {
  if (!ms) return '';
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function bar(pct: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function levelColor(pct: number, s: SegmentConfig, cfg: StatusLineConfig): string {
  if (!s.thresholds) return s.color;
  const t = cfg.thresholds;
  if (pct >= t.danger) return t.dangerColor;
  if (pct >= t.warn) return t.warnColor;
  return t.okColor || s.color;
}

function pctText(pct: number, s: SegmentConfig, cfg: StatusLineConfig): string {
  const p = `${Math.round(pct)}%`;
  if (s.format === 'bar') return bar(pct, cfg.barWidth);
  if (s.format === 'both') return `${bar(pct, cfg.barWidth)} ${p}`;
  return p;
}

const EFFORT_COLORS: Readonly<Record<string, string>> = { low: 'green', medium: 'yellow', high: 'red', xhigh: 'red', max: 'brightRed' };

// ---------- what a render needs ----------

export interface Profile {
  label: string;
  color: string;
  email: string;
}

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
  modified: number;
  untracked: number;
}

/** A usage window; `resetsAt` is unix seconds, 0 when unknown. */
export interface Limit {
  pct: number;
  resetsAt: number;
}

export interface RenderData {
  profile: Profile | null;
  project: string;
  git: GitInfo | null;
  model: string;
  effort: string;
  ctxPct: number | null;
  tokens: number;
  cost: number | null;
  linesAdded: number;
  linesRemoved: number;
  durationMs: number;
  fiveHour: Limit | null;
  sevenDay: Limit | null;
  outputStyle: string;
  version: string;
}

interface Value {
  text: string;
  color?: string | undefined;
  /** `text` is already painted. */
  plain?: boolean;
}

/** The text and color of a segment, or null when there is nothing to show. */
function segmentValue(s: SegmentConfig, d: RenderData, cfg: StatusLineConfig, now: number): Value | null {
  switch (s.id) {
    case 'profile':
      return d.profile ? { text: d.profile.label, color: s.accountColor && d.profile.color ? d.profile.color : s.color } : null;
    case 'project':
      return d.project ? { text: d.project } : null;
    case 'git': {
      if (!d.git || !d.git.branch) return null;
      let t = d.git.branch;
      if (s.showAheadBehind && d.git.ahead) t += ` ↑${d.git.ahead}`;
      if (s.showAheadBehind && d.git.behind) t += ` ↓${d.git.behind}`;
      if (s.showDirty && d.git.modified) t += ` !${d.git.modified}`;
      if (s.showDirty && d.git.untracked) t += ` ?${d.git.untracked}`;
      return { text: t };
    }
    case 'model':
      return d.model ? { text: d.model } : null;
    case 'effort':
      return d.effort ? { text: d.effort, color: s.colorByLevel ? EFFORT_COLORS[d.effort] ?? s.color : s.color } : null;
    case 'context':
      return d.ctxPct == null ? null : { text: pctText(d.ctxPct, s, cfg), color: levelColor(d.ctxPct, s, cfg) };
    case 'five_hour':
    case 'seven_day': {
      const lim = s.id === 'five_hour' ? d.fiveHour : d.sevenDay;
      if (!lim) return null;
      const reset = s.showReset ? fmtRemaining(lim.resetsAt, now) : '';
      return { text: `${reset ? ` (${reset})` : ''} ${pctText(lim.pct, s, cfg)}`, color: levelColor(lim.pct, s, cfg) };
    }
    case 'tokens':
      return d.tokens ? { text: fmtTokens(d.tokens) } : null;
    case 'cost':
      return d.cost != null ? { text: d.cost.toFixed(2) } : null;
    case 'lines':
      if (!d.linesAdded && !d.linesRemoved) return null;
      return { text: `${paint(`+${d.linesAdded}`, 'green')} ${paint(`-${d.linesRemoved}`, 'red')}`, plain: true };
    case 'duration':
      return d.durationMs ? { text: fmtDuration(d.durationMs) } : null;
    case 'clock': {
      const t = new Date(now);
      return { text: `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` };
    }
    case 'output_style':
      return d.outputStyle && d.outputStyle !== 'default' ? { text: d.outputStyle } : null;
    case 'version':
      return d.version ? { text: d.version } : null;
    case 'text':
      return s.text ? { text: s.text } : null;
    default: {
      const unreachable: never = s.id;
      return unreachable;
    }
  }
}

/** Pure: data and config in, ANSI text out (one string, lines separated by `\n`). */
export function format(d: RenderData, cfg: StatusLineConfig, now = Date.now()): string {
  const lines = new Map<number, { piece: string; join: boolean }[]>();
  for (const s of cfg.segments) {
    if (!s.enabled) continue;
    const v = segmentValue(s, d, cfg, now);
    if (!v || v.text === '') continue;
    const color = v.color !== undefined ? v.color : s.color;
    const body = v.plain ? `${s.label}${v.text}` : paint(`${s.label}${v.text}`, color, s.bold);
    const piece = `${s.icon ? `${s.icon} ` : ''}${body}`;
    const line = Number(s.line) || 1;
    const list = lines.get(line) ?? [];
    list.push({ piece, join: s.join });
    lines.set(line, list);
  }
  const sep = paint(cfg.separator, cfg.separatorColor);
  return [...lines.keys()]
    .sort((a, b) => a - b)
    .map((k) => (lines.get(k) ?? []).reduce((acc, p, i) => (i === 0 ? p.piece : acc + (p.join ? ' ' : sep) + p.piece), ''))
    .filter(Boolean)
    .join('\n');
}

// ---------- data collection ----------

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** A value deep in the payload Claude Code sends, or undefined. */
function dig(source: unknown, ...keys: string[]): unknown {
  let at: unknown = source;
  for (const key of keys) {
    if (!isRecord(at)) return undefined;
    at = at[key];
  }
  return at;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function accountEmail(cfgDir: string): string {
  const files = [path.join(cfgDir, '.claude.json')];
  if (cfgDir === path.join(HOME, '.claude')) files.push(path.join(HOME, '.claude.json'));
  for (const f of files) {
    const account = dig(readJson(f), 'oauthAccount');
    if (isRecord(account)) return text(account['emailAddress']);
  }
  return '';
}

/** Names and colors are keyed by email first, so a second folder logged into the same account shows the same name. */
export function profileFromEmail(email: string, cfgDir: string, cfg: StatusLineConfig): Profile {
  const accounts = cfg.accounts;
  const hit: AccountStyle = (email && accounts[email]) || accounts[cfgDir] || {};
  const base = path.basename(cfgDir);
  const fallback = cfgDir === path.join(HOME, '.claude') ? 'default' : base.replace(/^\.claude-?/, '') || base;
  return { label: hit.label || (email ? email.split('@')[0] ?? fallback : fallback), color: hit.color ?? '', email };
}

const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });

function gitInfo(cwd: string): GitInfo | null {
  try {
    const out = git(cwd, ['status', '--porcelain=v2', '--branch']);
    const info: GitInfo = { branch: '', ahead: 0, behind: 0, modified: 0, untracked: 0 };
    for (const line of out.split('\n')) {
      if (line.startsWith('# branch.head ')) info.branch = line.slice(14);
      else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+) -(\d+)/);
        if (m) [info.ahead, info.behind] = [Number(m[1]), Number(m[2])];
      } else if (/^[12u] /.test(line)) info.modified++;
      else if (line.startsWith('? ')) info.untracked++;
    }
    return info;
  } catch {
    return null;
  }
}

function projectName(cwd: string): string {
  try {
    return path.basename(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    return cwd ? path.basename(cwd) : '';
  }
}

interface TokenCache {
  offset: number;
  total: number;
  file?: string;
}

const tokenCache = (v: unknown): TokenCache => (isRecord(v) && typeof v['offset'] === 'number' && typeof v['total'] === 'number' ? { offset: v['offset'], total: v['total'], ...(typeof v['file'] === 'string' ? { file: v['file'] } : {}) } : { offset: 0, total: 0 });

/** Sums usage over assistant messages, reading only the bytes appended since the last render. */
function sessionTokens(sessionId: string, transcript: string): number {
  if (!transcript || !/^[A-Za-z0-9-]+$/.test(sessionId)) return 0;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcript);
  } catch {
    return 0;
  }
  const cacheFile = path.join(CACHE_DIR, `${sessionId}.json`);
  let cache = tokenCache(readJson(cacheFile));
  if (cache.file !== transcript || stat.size < cache.offset) cache = { offset: 0, total: 0 };
  if (stat.size > cache.offset) {
    const fd = fs.openSync(transcript, 'r');
    const buf = Buffer.alloc(stat.size - cache.offset);
    fs.readSync(fd, buf, 0, buf.length, cache.offset);
    fs.closeSync(fd);
    const lastNl = buf.lastIndexOf(10);
    if (lastNl >= 0) {
      for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
        if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
        try {
          const e: unknown = JSON.parse(line);
          const u = dig(e, 'message', 'usage');
          if (dig(e, 'type') === 'assistant' && isRecord(u)) {
            cache.total += ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((sum, k) => sum + (finite(u[k]) ?? 0), 0);
          }
        } catch {
          // ignore malformed line
        }
      }
      cache.offset += lastNl + 1;
    }
    cache.file = transcript;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
    } catch {
      // cache is an optimization only
    }
  }
  return cache.total;
}

const isEnabled = (cfg: StatusLineConfig, id: SegmentId): boolean => cfg.segments.some((s) => s.enabled && s.id === id);

interface Collected extends RenderData {
  cfgDir: string;
  cwd: string;
  sessionId: string;
  modelId: string;
  payload: unknown;
}

function limit(l: unknown): Limit | null {
  const pct = finite(dig(l, 'used_percentage'));
  return pct === null ? null : { pct, resetsAt: finite(dig(l, 'resets_at')) ?? 0 };
}

function collect(payload: unknown, cfg: StatusLineConfig, env: NodeJS.ProcessEnv): Collected {
  const cfgDir = path.resolve(expand(env['CLAUDE_CONFIG_DIR'] || '~/.claude'));
  const cwd = text(dig(payload, 'workspace', 'current_dir')) || text(dig(payload, 'cwd')) || process.cwd();
  const sessionId = text(dig(payload, 'session_id'));
  const needsRepo = cfg.compat.sessionSnapshots;
  const needsTokens = isEnabled(cfg, 'tokens') || cfg.compat.sessionSnapshots;
  return {
    cfgDir,
    cwd,
    sessionId,
    profile: profileFromEmail(accountEmail(cfgDir), cfgDir, cfg),
    project: isEnabled(cfg, 'project') || needsRepo ? projectName(cwd) : '',
    git: isEnabled(cfg, 'git') || needsRepo ? gitInfo(cwd) : null,
    model: text(dig(payload, 'model', 'display_name')),
    modelId: text(dig(payload, 'model', 'id')),
    effort: text(dig(payload, 'effort', 'level')),
    ctxPct: finite(dig(payload, 'context_window', 'used_percentage')),
    tokens: needsTokens ? sessionTokens(sessionId, text(dig(payload, 'transcript_path'))) : 0,
    cost: finite(dig(payload, 'cost', 'total_cost_usd')),
    linesAdded: finite(dig(payload, 'cost', 'total_lines_added')) ?? 0,
    linesRemoved: finite(dig(payload, 'cost', 'total_lines_removed')) ?? 0,
    durationMs: finite(dig(payload, 'cost', 'total_duration_ms')) ?? 0,
    fiveHour: limit(dig(payload, 'rate_limits', 'five_hour')),
    sevenDay: limit(dig(payload, 'rate_limits', 'seven_day')),
    outputStyle: text(dig(payload, 'output_style', 'name')),
    version: text(dig(payload, 'version')),
    payload,
  };
}

// ---------- compatibility with the previous native-statusline.sh ----------

function gitString(g: GitInfo | null): string {
  if (!g || !g.branch) return '';
  return `${g.branch}${g.modified ? ` !${g.modified}` : ''}${g.untracked ? ` ?${g.untracked}` : ''}`;
}

function writeCompat(d: Collected, cfg: StatusLineConfig): void {
  const now = Date.now();
  if (cfg.compat.tmuxStateFile) {
    const lines = [`EFFORT=${d.effort || '—'}`];
    if (d.ctxPct != null) lines.push(`CTX_PCT=${Math.round(d.ctxPct)}`);
    if (d.fiveHour) lines.push(`HOURLY_PCT=${Math.round(d.fiveHour.pct)}`);
    if (d.sevenDay) lines.push(`WEEKLY_PCT=${Math.round(d.sevenDay.pct)}`);
    if (d.fiveHour?.resetsAt) lines.push(`HOURLY_REMAIN=${fmtRemaining(d.fiveHour.resetsAt, now)}`);
    if (d.sevenDay?.resetsAt) lines.push(`WEEKLY_REMAIN=${fmtRemaining(d.sevenDay.resetsAt, now)}`);
    const tmp = `/tmp/claude_state.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`);
    fs.renameSync(tmp, '/tmp/claude_state');
  }
  if (cfg.compat.sessionSnapshots && /^[A-Za-z0-9-]+$/.test(d.sessionId)) {
    const dir = path.join(d.cfgDir, 'statusline');
    fs.mkdirSync(dir, { recursive: true });
    const snap = {
      session_id: d.sessionId, updated_at: Math.floor(now / 1000), profile: d.profile?.label, email: d.profile?.email,
      model: d.model, model_id: d.modelId, effort: d.effort, cwd: d.cwd, project: d.project, git: gitString(d.git),
      context_pct: d.ctxPct, tokens: d.tokens, cost_usd: d.cost, five_hour: dig(d.payload, 'rate_limits', 'five_hour'), seven_day: dig(d.payload, 'rate_limits', 'seven_day'), version: d.version,
    };
    const file = path.join(dir, `${d.sessionId}.json`);
    fs.writeFileSync(`${file}.tmp.${process.pid}`, JSON.stringify(snap));
    fs.renameSync(`${file}.tmp.${process.pid}`, file);
    // Old snapshots are pruned now and then rather than on every render.
    if (Math.random() < 0.02) {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        try {
          if (now - fs.statSync(full).mtimeMs > 2 * 86400000) fs.unlinkSync(full);
        } catch {
          // already gone
        }
      }
    }
  }
}

function main(): void {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => (input += chunk));
  process.stdin.on('end', () => {
    const cfg = loadConfig();
    if (cfg.compat.disableFile && fs.existsSync(path.join(HOME, '.claude', 'statusline_disabled'))) return;
    let payload: unknown = {};
    try {
      payload = JSON.parse(input || '{}');
    } catch {
      // render what we can
    }
    let data: Collected;
    try {
      data = collect(payload, cfg, process.env);
    } catch (e) {
      process.stdout.write(`statusline error: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    try {
      writeCompat(data, cfg);
    } catch {
      // side files must never break the footer
    }
    process.stdout.write(`${format(data, cfg)}\n`);
  });
}

if (require.main === module) main();
