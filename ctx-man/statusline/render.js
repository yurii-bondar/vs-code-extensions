#!/usr/bin/env node
// Ctx Man status line for Claude Code.
// Claude Code runs this on every footer render with a JSON payload on stdin; it prints the footer.
// Layout and colors come from ~/.ctx-man/statusline.json (written by the Ctx Man extension),
// so edits apply on the next render. Installed copy: ~/.ctx-man/statusline.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const CONFIG_FILE = path.join(HOME, '.ctx-man', 'statusline.json');
const CACHE_DIR = path.join(os.tmpdir(), 'ctx-man-statusline');
const expand = (p) => String(p).replace(/^~(?=$|[\\/])/, HOME);

// ---------- defaults ----------

const seg = (id, line, extra = {}) => ({ id, line, enabled: true, icon: '', label: '', color: '', bold: false, join: false, ...extra });

const DEFAULT_CONFIG = {
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

function loadConfig() {
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULT_CONFIG, ...user, thresholds: { ...DEFAULT_CONFIG.thresholds, ...user.thresholds }, compat: { ...DEFAULT_CONFIG.compat, ...user.compat } };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ---------- colors ----------

const NAMED = { black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90, grey: 90, brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97 };
const RESET = '\x1b[0m';

function sgr(color, bold) {
  const codes = [];
  if (bold) codes.push(1);
  if (color) {
    if (NAMED[color]) codes.push(NAMED[color]);
    else if (/^#[0-9a-f]{6}$/i.test(color)) codes.push(38, 2, parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16));
    else if (/^\d{1,3}$/.test(String(color))) codes.push(38, 5, Number(color));
  }
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}
const paint = (text, color, bold) => {
  const open = sgr(color, bold);
  return open ? `${open}${text}${RESET}` : text;
};

// ---------- formatting helpers ----------

function fmtTokens(n) {
  if (!n) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtRemaining(resetsAt, now) {
  if (!resetsAt) return '';
  const diff = Math.max(0, Math.floor(resetsAt - now / 1000));
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d >= 1) return `${d}d ${h}h`;
  return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDuration(ms) {
  if (!ms) return '';
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function bar(pct, width) {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function levelColor(pct, s, cfg) {
  if (!s.thresholds) return s.color;
  const t = cfg.thresholds;
  if (pct >= t.danger) return t.dangerColor;
  if (pct >= t.warn) return t.warnColor;
  return t.okColor || s.color;
}

function pctText(pct, s, cfg) {
  const p = `${Math.round(pct)}%`;
  if (s.format === 'bar') return bar(pct, cfg.barWidth);
  if (s.format === 'both') return `${bar(pct, cfg.barWidth)} ${p}`;
  return p;
}

const EFFORT_COLORS = { low: 'green', medium: 'yellow', high: 'red', xhigh: 'red', max: 'brightRed' };

// Returns { text, color } for a segment, or null when there is nothing to show.
function segmentValue(s, d, cfg, now) {
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
      return d.effort ? { text: d.effort, color: s.colorByLevel ? EFFORT_COLORS[d.effort] || s.color : s.color } : null;
    case 'context':
      return d.ctxPct == null ? null : { text: pctText(d.ctxPct, s, cfg), color: levelColor(d.ctxPct, s, cfg) };
    case 'five_hour':
    case 'seven_day': {
      const lim = s.id === 'five_hour' ? d.fiveHour : d.sevenDay;
      if (!lim || lim.pct == null) return null;
      const reset = s.showReset ? fmtRemaining(lim.resetsAt, now) : '';
      return { text: `${reset ? ` (${reset})` : ''} ${pctText(lim.pct, s, cfg)}`, color: levelColor(lim.pct, s, cfg) };
    }
    case 'tokens':
      return d.tokens ? { text: fmtTokens(d.tokens) } : null;
    case 'cost':
      return d.cost != null ? { text: d.cost.toFixed(2) } : null;
    case 'lines':
      if (!d.linesAdded && !d.linesRemoved) return null;
      return { text: `${paint(`+${d.linesAdded || 0}`, 'green')} ${paint(`-${d.linesRemoved || 0}`, 'red')}`, plain: true };
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
    default:
      return null;
  }
}

// Pure: data + config → ANSI text (one string, lines separated by \n).
function format(d, cfg, now = Date.now()) {
  const lines = new Map();
  for (const s of cfg.segments || []) {
    if (!s || !s.enabled) continue;
    const v = segmentValue(s, d, cfg, now);
    if (!v || v.text === '' || v.text == null) continue;
    const color = v.color !== undefined ? v.color : s.color;
    const body = v.plain ? `${s.label || ''}${v.text}` : paint(`${s.label || ''}${v.text}`, color, s.bold);
    const piece = `${s.icon ? `${s.icon} ` : ''}${body}`;
    const line = Number(s.line) || 1;
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line).push({ piece, join: s.join });
  }
  const sep = paint(cfg.separator, cfg.separatorColor);
  return [...lines.keys()]
    .sort((a, b) => a - b)
    .map((k) => lines.get(k).reduce((acc, p, i) => (i === 0 ? p.piece : acc + (p.join ? ' ' : sep) + p.piece), ''))
    .filter(Boolean)
    .join('\n');
}

// ---------- data collection ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function accountInfo(cfgDir) {
  const files = [path.join(cfgDir, '.claude.json')];
  if (cfgDir === path.join(HOME, '.claude')) files.push(path.join(HOME, '.claude.json'));
  for (const f of files) {
    const j = readJson(f);
    if (j && j.oauthAccount) return j.oauthAccount.emailAddress || '';
  }
  return '';
}

function profileFor(cfgDir, cfg) {
  return profileFromEmail(accountInfo(cfgDir), cfgDir, cfg);
}

// Names/colors are keyed by email first, so a second folder logged into the same account shows the same name.
function profileFromEmail(email, cfgDir, cfg) {
  const accounts = cfg.accounts || {};
  const hit = (email && accounts[email]) || accounts[cfgDir] || {};
  const base = path.basename(cfgDir);
  const fallback = cfgDir === path.join(HOME, '.claude') ? 'default' : base.replace(/^\.claude-?/, '') || base;
  return { label: hit.label || (email ? email.split('@')[0] : fallback), color: hit.color || '', email };
}

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });

function gitInfo(cwd) {
  try {
    const out = git(cwd, ['status', '--porcelain=v2', '--branch']);
    const info = { branch: '', ahead: 0, behind: 0, modified: 0, untracked: 0 };
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

function projectName(cwd) {
  try {
    return path.basename(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    return cwd ? path.basename(cwd) : '';
  }
}

// Sums usage over assistant messages, reading only bytes appended since the last render.
function sessionTokens(sessionId, transcript) {
  if (!transcript || !/^[A-Za-z0-9-]+$/.test(sessionId || '')) return 0;
  let stat;
  try {
    stat = fs.statSync(transcript);
  } catch {
    return 0;
  }
  const cacheFile = path.join(CACHE_DIR, `${sessionId}.json`);
  let cache = readJson(cacheFile) || { offset: 0, total: 0 };
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
          const e = JSON.parse(line);
          const u = e.type === 'assistant' && e.message && e.message.usage;
          if (u) cache.total += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
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

const enabled = (cfg, id) => (cfg.segments || []).some((s) => s && s.enabled && s.id === id);

function collect(p, cfg, env) {
  const cfgDir = path.resolve(expand(env.CLAUDE_CONFIG_DIR || '~/.claude'));
  const cwd = (p.workspace && p.workspace.current_dir) || p.cwd || process.cwd();
  const limit = (l) => (l && l.used_percentage != null ? { pct: Number(l.used_percentage), resetsAt: l.resets_at } : null);
  const rl = p.rate_limits || {};
  const cost = p.cost || {};
  const needsTokens = enabled(cfg, 'tokens') || (cfg.compat && cfg.compat.sessionSnapshots);
  return {
    cfgDir,
    cwd,
    sessionId: p.session_id,
    profile: profileFor(cfgDir, cfg),
    project: enabled(cfg, 'project') || cfg.compat.sessionSnapshots ? projectName(cwd) : '',
    git: enabled(cfg, 'git') || cfg.compat.sessionSnapshots ? gitInfo(cwd) : null,
    model: p.model && p.model.display_name,
    modelId: p.model && p.model.id,
    effort: p.effort && p.effort.level,
    ctxPct: p.context_window && p.context_window.used_percentage != null ? Number(p.context_window.used_percentage) : null,
    tokens: needsTokens ? sessionTokens(p.session_id, p.transcript_path) : 0,
    cost: cost.total_cost_usd,
    linesAdded: cost.total_lines_added,
    linesRemoved: cost.total_lines_removed,
    durationMs: cost.total_duration_ms,
    fiveHour: limit(rl.five_hour),
    sevenDay: limit(rl.seven_day),
    outputStyle: p.output_style && p.output_style.name,
    version: p.version,
    raw: p,
  };
}

// ---------- compatibility with the previous native-statusline.sh ----------

function gitString(g) {
  if (!g || !g.branch) return '';
  return `${g.branch}${g.modified ? ` !${g.modified}` : ''}${g.untracked ? ` ?${g.untracked}` : ''}`;
}

function writeCompat(d, cfg) {
  const now = Date.now();
  if (cfg.compat.tmuxStateFile) {
    const lines = [`EFFORT=${d.effort || '—'}`];
    if (d.ctxPct != null) lines.push(`CTX_PCT=${Math.round(d.ctxPct)}`);
    if (d.fiveHour) lines.push(`HOURLY_PCT=${Math.round(d.fiveHour.pct)}`);
    if (d.sevenDay) lines.push(`WEEKLY_PCT=${Math.round(d.sevenDay.pct)}`);
    if (d.fiveHour && d.fiveHour.resetsAt) lines.push(`HOURLY_REMAIN=${fmtRemaining(d.fiveHour.resetsAt, now)}`);
    if (d.sevenDay && d.sevenDay.resetsAt) lines.push(`WEEKLY_REMAIN=${fmtRemaining(d.sevenDay.resetsAt, now)}`);
    const tmp = `/tmp/claude_state.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`);
    fs.renameSync(tmp, '/tmp/claude_state');
  }
  if (cfg.compat.sessionSnapshots && /^[A-Za-z0-9-]+$/.test(d.sessionId || '')) {
    const dir = path.join(d.cfgDir, 'statusline');
    fs.mkdirSync(dir, { recursive: true });
    const r = d.raw.rate_limits || {};
    const snap = {
      session_id: d.sessionId, updated_at: Math.floor(now / 1000), profile: d.profile.label, email: d.profile.email,
      model: d.model, model_id: d.modelId, effort: d.effort, cwd: d.cwd, project: d.project, git: gitString(d.git),
      context_pct: d.ctxPct, tokens: d.tokens, cost_usd: d.cost, five_hour: r.five_hour, seven_day: r.seven_day, version: d.version,
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

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    const cfg = loadConfig();
    if (cfg.compat.disableFile && fs.existsSync(path.join(HOME, '.claude', 'statusline_disabled'))) return;
    let payload = {};
    try {
      payload = JSON.parse(input || '{}');
    } catch {
      // render what we can
    }
    let data;
    try {
      data = collect(payload, cfg, process.env);
    } catch (e) {
      process.stdout.write(`statusline error: ${e.message}`);
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

module.exports = { DEFAULT_CONFIG, CONFIG_FILE, format, profileFromEmail };
