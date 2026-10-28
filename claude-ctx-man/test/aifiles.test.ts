import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applySteps, describeStep, inspect, needsOf, planSteps } from '../src/aifiles';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'aifiles-'));
const paths = (steps: ReturnType<typeof planSteps>): string[] => steps.map((s) => s.path);

test('claude-only creates CLAUDE.md and the two folders, no links', () => {
  const steps = planSteps({ kind: 'claude-only' }, 'demo');
  assert.deepEqual(paths(steps), ['CLAUDE.md', '.claude/rules', '.claude/skills']);
  assert.ok(steps.every((s) => s.kind !== 'link'));
});

test('several: shared folders are real, tool folders link to them relatively', () => {
  const steps = planSteps({ kind: 'several', tools: ['claude', 'cursor', 'agents'] }, 'demo');
  assert.deepEqual(paths(steps), ['.aiassistant/rules', '.aiassistant/skills', 'CLAUDE.md', '.claude/rules', '.claude/skills', '.cursor/rules', '.cursor/skills', 'AGENTS.md']);
  assert.deepEqual(steps.map(describeStep).slice(3), ['.claude/rules → ../.aiassistant/rules', '.claude/skills → ../.aiassistant/skills', '.cursor/rules → ../.aiassistant/rules', '.cursor/skills → ../.aiassistant/skills', 'AGENTS.md → CLAUDE.md']);
});

test('several: only the picked tools get links; AGENTS.md alone still gets CLAUDE.md', () => {
  assert.deepEqual(paths(planSteps({ kind: 'several', tools: ['cursor'] }, 'x')), ['.aiassistant/rules', '.aiassistant/skills', '.cursor/rules', '.cursor/skills']);
  assert.deepEqual(paths(planSteps({ kind: 'several', tools: ['agents'] }, 'x')), ['.aiassistant/rules', '.aiassistant/skills', 'CLAUDE.md', 'AGENTS.md']);
});

test('applySteps creates the layout and the links resolve', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const steps = planSteps({ kind: 'several', tools: ['claude', 'cursor', 'agents'] }, 'demo');
  const out = applySteps(root, steps);
  assert.ok(out.every((o) => o.status === 'created'), JSON.stringify(out));
  fs.writeFileSync(path.join(root, '.aiassistant/rules/a.md'), 'rule');
  assert.equal(fs.readFileSync(path.join(root, '.claude/rules/a.md'), 'utf8'), 'rule');
  assert.equal(fs.readFileSync(path.join(root, '.cursor/rules/a.md'), 'utf8'), 'rule');
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'));
  assert.ok(fs.lstatSync(path.join(root, 'AGENTS.md')).isSymbolicLink());
});

test('a second run changes nothing', () => {
  const root = tmp();
  const steps = planSteps({ kind: 'claude-only' }, 'demo');
  applySteps(root, steps);
  assert.ok(applySteps(root, steps).every((o) => o.status === 'exists'));
});

test('existing different content is a conflict and is left untouched', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'mine');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude/rules'), 'a file where a folder should be');
  const steps = planSteps({ kind: 'claude-only' }, 'demo');
  const out = applySteps(root, steps);
  assert.deepEqual(out.map((o) => o.status), ['exists', 'conflict', 'created']);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'mine');
});

test('a link to somewhere else is a conflict, a real folder in its place too', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.symlinkSync('/elsewhere', path.join(root, '.claude/rules'));
  fs.mkdirSync(path.join(root, '.claude/skills'));
  const [rules, skills] = planSteps({ kind: 'several', tools: ['claude'] }, 'x').filter((s) => s.kind === 'link');
  assert.ok(rules && skills);
  assert.equal(inspect(root, rules), 'conflict');
  assert.equal(inspect(root, skills), 'conflict');
});

test('a link needs what it points at', () => {
  const steps = planSteps({ kind: 'several', tools: ['claude', 'agents'] }, 'x');
  const needs = Object.fromEntries(steps.map((s) => [s.path, needsOf(s)]));
  assert.equal(needs['.claude/rules'], '.aiassistant/rules');
  assert.equal(needs['AGENTS.md'], 'CLAUDE.md');
  assert.equal(needs['CLAUDE.md'], undefined);
});

test('skipped steps are not created, and neither are links that would dangle', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const steps = planSteps({ kind: 'several', tools: ['claude', 'cursor', 'agents'] }, 'x');
  const out = applySteps(root, steps, new Set(['.aiassistant/rules', 'CLAUDE.md', '.cursor/skills']));
  const status = Object.fromEntries(out.map((o) => [o.step.path, o.status]));
  assert.equal(status['.aiassistant/rules'], 'skipped');
  assert.equal(status['.aiassistant/skills'], 'created');
  assert.equal(status['.claude/rules'], 'skipped');
  assert.equal(status['.cursor/rules'], 'skipped');
  assert.equal(status['.cursor/skills'], 'skipped');
  assert.equal(status['.claude/skills'], 'created');
  assert.equal(status['AGENTS.md'], 'skipped');
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')));
  assert.ok(!fs.existsSync(path.join(root, '.aiassistant/rules')));
});

test('a link is still made when its target is skipped but already there', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.aiassistant/rules'), { recursive: true });
  const steps = planSteps({ kind: 'several', tools: ['claude'] }, 'x');
  const out = applySteps(root, steps, new Set(['.aiassistant/rules']));
  assert.equal(out.find((o) => o.step.path === '.claude/rules')?.status, 'created');
});
