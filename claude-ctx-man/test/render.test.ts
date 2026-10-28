import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, format, normalizeConfig, profileFromEmail } from '../statusline/render';
import type { RenderData } from '../statusline/render';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const data = (extra: Partial<RenderData> = {}): RenderData => ({
  profile: { label: 'work', color: '', email: 'me@x.io' },
  project: 'acme',
  git: { branch: 'main', ahead: 2, behind: 0, modified: 3, untracked: 1 },
  model: 'Opus 5.5',
  effort: 'high',
  ctxPct: 50,
  tokens: 1_250_000,
  cost: 1.5,
  linesAdded: 0,
  linesRemoved: 0,
  durationMs: 0,
  fiveHour: { pct: 80, resetsAt: NOW / 1000 + 3600 + 120 },
  sevenDay: null,
  outputStyle: 'default',
  version: '1',
  ...extra,
});
// The ANSI colors are not what is under test here.
// eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC
const plain = (s: string): string => s.replace(/\x1b\[[\d;]*m/g, '');

test('the default config renders two lines, with what has no data left out', () => {
  const lines = plain(format(data(), normalizeConfig(undefined), NOW)).split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '👤 profile: work | 📁 acme 🌿 main ↑2 !3 ?1');
  assert.equal(lines[1], 'Opus 5.5 high | ctx 50% | tok 1.3M | 5h (1h 2m) 80%');
});

test('the bar format draws filled and empty cells, and both shows the number too', () => {
  const cfg = normalizeConfig({ segments: [{ id: 'context', format: 'both' }], barWidth: 4 });
  assert.match(plain(format(data({ ctxPct: 50 }), cfg, NOW)), /ctx ▰▰▱▱ 50%/);
});

test('usage colors switch at the warn and danger levels', () => {
  const cfg = normalizeConfig({ segments: [{ id: 'context', thresholds: true, color: 'green' }], thresholds: { warn: 60, danger: 85, warnColor: 'yellow', dangerColor: 'red' } });
  const at = (ctxPct: number): string => format(data({ ctxPct }), cfg, NOW);
  assert.ok(at(10).includes('\x1b[32m'), 'below warn keeps the own color');
  assert.ok(at(70).includes('\x1b[33m'), 'warn');
  assert.ok(at(90).includes('\x1b[31m'), 'danger');
});

test('a hex color becomes a true-color escape', () => {
  const cfg = normalizeConfig({ segments: [{ id: 'model', color: '#112233' }] });
  assert.ok(format(data(), cfg, NOW).includes('\x1b[38;2;17;34;51m'));
});

test('normalizeConfig keeps the user order, drops unknown segments and appends new ones', () => {
  const cfg = normalizeConfig({ segments: [{ id: 'model', enabled: true }, { id: 'nope' }, { id: 'model' }] });
  assert.equal(cfg.segments[0]?.id, 'model');
  assert.equal(cfg.segments.length, DEFAULT_CONFIG.segments.length);
  assert.equal(cfg.segments.filter((s) => s.id === 'model').length, 1);
});

test('normalizeConfig ignores values of the wrong type and clamps the bar width', () => {
  const cfg = normalizeConfig({ separator: 5, barWidth: 999, thresholds: { warn: 'x' }, segments: [{ id: 'git', color: 7, enabled: 'yes', format: 'nope' }] });
  assert.equal(cfg.separator, DEFAULT_CONFIG.separator);
  assert.equal(cfg.barWidth, 30);
  assert.equal(cfg.thresholds.warn, 60);
  const git = cfg.segments.find((s) => s.id === 'git');
  assert.equal(git?.color, 'yellow');
  assert.equal(git?.enabled, true);
  assert.equal(git?.format, undefined);
});

test('normalizeConfig survives anything', () => {
  for (const raw of [null, 'x', 3, [], { segments: 'no' }]) assert.equal(normalizeConfig(raw).segments.length, DEFAULT_CONFIG.segments.length);
});

test('an account name and color are found by email first, then by folder', () => {
  const cfg = normalizeConfig({ accounts: { 'me@x.io': { label: 'Me', color: 'cyan' }, '/h/.claude-b': { label: 'B' } } });
  assert.deepEqual(profileFromEmail('me@x.io', '/h/.claude-a', cfg), { label: 'Me', color: 'cyan', email: 'me@x.io' });
  assert.equal(profileFromEmail('', '/h/.claude-b', cfg).label, 'B');
  assert.equal(profileFromEmail('', '/h/.claude-c', cfg).label, 'c');
  assert.equal(profileFromEmail('ann@x.io', '/h/.claude-c', cfg).label, 'ann');
});
