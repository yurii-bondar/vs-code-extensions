// What a custom scenario's step adds to its agent's instructions: written inline or in a file, kept by every edit,
// carried into a task as it was when the task started, and into backups and libraries as text.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as config from '../src/core/config';
import * as backups from '../src/core/backup';
import * as libraries from '../src/core/library';
import { Engine } from '../src/core/engine';
import { withStepInstructions } from '../src/core/prompt';
import type { EngineOptions } from '../src/core/engine';

const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** A workspace whose .claudestrator/config.yaml holds `yaml`, with `files` (paths inside .claudestrator/) beside it. */
function workspace(yaml: string, files: Record<string, string> = {}): string {
  const ws = tmp('cs-steps-');
  fs.mkdirSync(path.join(ws, config.CONFIG_DIR));
  fs.writeFileSync(config.projectConfigFile(ws), yaml);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(ws, config.CONFIG_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return ws;
}

async function resolved(ws: string, home: string) {
  const r = await config.loadConfig({ workspace: ws, home });
  assert.ok(r.ok, JSON.stringify(r));
  return r.config;
}

const SHIP = `scenarios:
  ship:
    label: Ship
    agents:
      - planner
      - agent: developer
        instructions: Keep the change minimal.
      - agent: reviewer
        effort: low
        instructions: { file: ./prompts/ship/reviewer.md }
`;

test('scenario steps: instructions inline or in a file, read with the config', async () => {
  const home = tmp('cs-steps-h-');
  const ws = workspace(SHIP, { 'prompts/ship/reviewer.md': 'Check {{dir}} too.\n' });
  const steps = (await resolved(ws, home)).custom.ship!.agents;
  const dir = path.join(ws, config.CONFIG_DIR);
  assert.deepEqual(steps, [
    { name: 'planner' },
    { name: 'developer', instructions: 'Keep the change minimal.' },
    { name: 'reviewer', effort: 'low', instructions: `Check ${dir} too.`, instructionsFile: path.join(dir, 'prompts/ship/reviewer.md') },
  ]);
  const r = await config.loadConfig({ workspace: ws, home });
  assert.ok(r.ok && r.config.sources.includes(path.join(dir, 'prompts/ship/reviewer.md')), 'an edit of the file reads the config again');

  // A file that is not there, or one a project's config may not name, is an error of that step.
  const missing = await config.loadConfig({ workspace: workspace(SHIP), home });
  assert.ok(!missing.ok);
  assert.deepEqual(missing.errors.map((e) => [e.code, e.agent]), [['step_instructions_unreadable', 'reviewer']]);
  const outside = await config.loadConfig({ workspace: workspace(SHIP.replace('./prompts/ship/reviewer.md', '../../outside.md')), home });
  assert.ok(!outside.ok);
  assert.match(outside.errors[0]!.message, /outside the workspace/);
});

test('scenario steps: saving keeps a file in the config folder as a file and writes other text inline', async () => {
  const home = tmp('cs-steps-h-');
  const ws = workspace(SHIP, { 'prompts/ship/reviewer.md': 'Look at the auth code.\n' });
  const sc = (await resolved(ws, home)).custom.ship!;
  // The chip editor sends back the steps it got, in a new order.
  await config.saveCustomScenario({ workspace: ws, home, id: 'ship', label: 'Ship', agents: [sc.agents[1]!, sc.agents[2]!, sc.agents[0]!] });
  const text = fs.readFileSync(config.projectConfigFile(ws), 'utf8');
  assert.match(text, /- agent: developer\n\s+instructions: Keep the change minimal\.\n/);
  assert.match(text, /- agent: reviewer\n\s+effort: low\n\s+instructions: \{ file: \.\/prompts\/ship\/reviewer\.md \}\n\s+- planner/, 'still the file, written as it was');

  // A file outside the project's config folder (a library's) is not named from the project: its text is.
  const elsewhere = path.join(tmp('cs-steps-lib-'), 'reviewer.md');
  await config.saveCustomScenario({ workspace: ws, home, id: 'ship', label: 'Ship', agents: [{ name: 'reviewer', instructions: 'From the library.', instructionsFile: elsewhere }] });
  assert.match(fs.readFileSync(config.projectConfigFile(ws), 'utf8'), /- agent: reviewer\n\s+instructions: From the library\.\n/);
});

test('scenario steps: Open in editor moves the text into prompts/<scenario>/<agent>.md', async () => {
  const home = tmp('cs-steps-h-');
  const ws = workspace(SHIP, { 'prompts/ship/reviewer.md': 'Look at the auth code.\n' });
  const file = await config.ensureStepInstructionsFile({ workspace: ws, home, scenario: 'ship', agent: 'developer' });
  assert.equal(file, path.join(ws, config.CONFIG_DIR, config.PROMPTS_DIR, 'ship', 'developer.md'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'Keep the change minimal.\n');
  assert.match(fs.readFileSync(config.projectConfigFile(ws), 'utf8'), /- agent: developer\n\s+instructions:\n\s+file: \.\/prompts\/ship\/developer\.md/);
  fs.writeFileSync(file, 'Keep it small.\n');
  assert.equal((await resolved(ws, home)).custom.ship!.agents[1]!.instructions, 'Keep it small.', 'the file is what the step reads now');

  // A step that has its file keeps it; a step without instructions starts an empty file.
  assert.equal(await config.ensureStepInstructionsFile({ workspace: ws, home, scenario: 'ship', agent: 'reviewer' }), path.join(ws, config.CONFIG_DIR, 'prompts/ship/reviewer.md'));
  assert.equal(fs.readFileSync(await config.ensureStepInstructionsFile({ workspace: ws, home, scenario: 'ship', agent: 'planner' }), 'utf8'), '\n');
  await assert.rejects(() => config.ensureStepInstructionsFile({ workspace: ws, home, scenario: 'nope', agent: 'planner' }), /no scenario "nope"/);
  await assert.rejects(() => config.ensureStepInstructionsFile({ workspace: ws, home, scenario: 'ship', agent: 'tester' }), /no step "tester"/);
});

test('scenario steps: a task keeps the instructions it started with, after the agent\'s own', async () => {
  const home = tmp('cs-steps-h-');
  const ws = workspace(SHIP, { 'prompts/ship/reviewer.md': 'Look at the auth code.\n' });
  const engine = new Engine({ workspace: ws, home, runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'] });
  const { taskId } = await engine.start({ text: 'Fix the login', scenario: 'ship' });
  const s = await engine.svc.state(taskId);
  assert.deepEqual(s.stepInstructions, { developer: 'Keep the change minimal.', reviewer: 'Look at the auth code.' });
  fs.writeFileSync(path.join(ws, config.CONFIG_DIR, 'prompts/ship/reviewer.md'), 'Changed later.\n');
  assert.equal((await engine.svc.state(taskId)).stepInstructions.reviewer, 'Look at the auth code.', 'a running task does not change');

  assert.equal(withStepInstructions('You write code.', 'Keep it small.', 'Ship'), 'You write code.\n\n## In this scenario (Ship)\n\nKeep it small.');
  assert.equal(withStepInstructions('', 'Keep it small.', undefined), '## In this scenario\n\nKeep it small.');
});

test('scenario steps: backups and libraries carry the text of a step file', async () => {
  const home = tmp('cs-steps-h-');
  const ws = workspace(SHIP, { 'prompts/ship/reviewer.md': 'Look at the auth code.\n' });
  const made = await backups.createBackup({ workspace: ws, now: new Date('2026-11-06T12:00:00Z') });
  assert.match(made.text, /- agent: reviewer\n\s+effort: low\n\s+instructions: Look at the auth code\.\n/);
  const parsed = backups.parseBackup(made.text);
  assert.ok(parsed.ok);
  const other = workspace('');
  await backups.restoreBackup({ workspace: other, home, backup: parsed.backup });
  assert.deepEqual((await resolved(other, home)).custom.ship!.agents[2], { name: 'reviewer', effort: 'low', instructions: 'Look at the auth code.' });

  const lib = tmp('cs-steps-lib-');
  fs.writeFileSync(path.join(lib, 'library.yaml'), 'agents: {}\n');
  await libraries.addLibrary({ workspace: ws, home, dir: lib, scope: 'project' });
  await libraries.moveToLibrary({ workspace: ws, home, library: path.join(lib, 'library.yaml'), scenarios: ['ship'] });
  assert.match(fs.readFileSync(path.join(lib, 'library.yaml'), 'utf8'), /- agent: reviewer\n\s+effort: low\n\s+instructions: Look at the auth code\.\n/);
  assert.deepEqual((await resolved(ws, home)).custom.ship!.agents[1], { name: 'developer', instructions: 'Keep the change minimal.' });
});

test('scenario steps: the agent runs with the step\'s instructions after its own', async () => {
  const home = tmp('cs-steps-h-');
  const ws = workspace(`scenarios:
  plan-only:
    label: Plan only
    agents:
      - agent: planner
        instructions: Plan in three steps at most.
`);
  let started: { agent: { instructions: string } } | undefined;
  const runner = {
    start: async (opts: { agent: { instructions: string } }) => {
      started = opts;
      throw new Error('enough');
    },
  } as unknown as EngineOptions['runner'];
  const hooks = { listen: async () => {}, host: () => '127.0.0.1', settings: () => ({}), register: () => ({ token: 't', url: 'http://127.0.0.1:1' }), unregister: () => {} } as unknown as EngineOptions['hooks'];
  const engine = new Engine({ workspace: ws, home, runner, hooks });
  const { taskId } = await engine.start({ text: 'Plan the login page', scenario: 'plan-only' });
  await engine.run(taskId).catch(() => {});
  assert.ok(started, JSON.stringify(engine.lastError(taskId)));
  assert.match(started.agent.instructions, /\n\n## In this scenario \(Plan only\)\n\nPlan in three steps at most\.$/);
  const own = (await resolved(ws, home)).agents.planner!.instructions.trim();
  assert.ok(own && started.agent.instructions.startsWith(own), "the agent's own instructions come first");
});
