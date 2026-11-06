// Parallel, Branch and Loop blocks of a custom scenario: read from config.yaml into one list of steps, checked,
// written back as they were, carried by backups, and run as the pipeline's groups, conditions and loop.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as config from '../src/core/config';
import * as backups from '../src/core/backup';
import * as libraries from '../src/core/library';
import { buildPipeline, fixedFlow, scenarioPipeline } from '../src/core/pipeline';
import { flattenSteps, nestSteps } from '../src/core/steps';
import { validateConfigLayer } from '../src/core/protocol';
import type { ScenarioStepLayer } from '../src/core/steps';

const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function workspace(yaml: string): string {
  const ws = tmp('cs-blocks-');
  fs.mkdirSync(path.join(ws, config.CONFIG_DIR));
  fs.writeFileSync(config.projectConfigFile(ws), yaml);
  return ws;
}

const AGENTS = `agents:
  security-reviewer: { extends: reviewer, description: Security only }
  security-fixer: { extends: developer, description: Fixes security findings }
`;

const SHIP = `${AGENTS}scenarios:
  ship:
    label: Ship with security review
    agents:
      - planner
      - loop:
          rounds: 3
          steps:
            - developer
            - parallel:
                - reviewer
                - agent: security-reviewer
                  model: opus
      - branch:
          on: security-reviewer
          if: { severity: minor }
          then: [security-fixer]
`;

test('blocks: config.yaml\'s parallel, branch and loop become one list of marked steps', async () => {
  const home = tmp('cs-blocks-h-');
  const r = await config.loadConfig({ workspace: workspace(SHIP), home });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  assert.deepEqual(r.config.custom.ship!.agents, [
    { name: 'planner' },
    { name: 'developer', loop: { rounds: 3 } },
    { name: 'reviewer', parallel: 1, loop: { rounds: 3 } },
    { name: 'security-reviewer', model: 'opus', parallel: 1, loop: { rounds: 3 } },
    { name: 'security-fixer', when: { on: 'security-reviewer', if: { severity: 'minor' } } },
  ]);

  const p = buildPipeline(r.config, { scenario: 'ship' });
  assert.deepEqual(p.stages.map((s) => [s.agent, s.group ?? null, s.when ? s.when.on : null]), [
    ['planner', null, null],
    ['developer', null, null],
    ['reviewer', 1, null],
    ['security-reviewer', 1, null],
    ['security-fixer', null, 'security-reviewer'],
  ]);
  assert.deepEqual(p.reviewLoop, { restartAt: 1, end: 3, fixers: ['developer'], reviewers: ['reviewer', 'security-reviewer'], maxRounds: 3, explicit: true });
  assert.ok(p.warnings.some((w) => w.code === 'unreviewed_work'), 'the fixer after the loop is never reviewed');
  assert.ok(fixedFlow(p));
});

test('blocks: saving the steps writes the blocks back as they were', async () => {
  const home = tmp('cs-blocks-h-');
  const ws = workspace(SHIP);
  const r = await config.loadConfig({ workspace: ws, home });
  assert.ok(r.ok);
  await config.saveCustomScenario({ workspace: ws, home, id: 'ship', label: 'Ship with security review', agents: r.config.custom.ship!.agents });
  const again = await config.loadConfig({ workspace: ws, home });
  assert.ok(again.ok);
  assert.deepEqual(again.config.custom.ship!.agents, r.config.custom.ship!.agents);
  const text = fs.readFileSync(config.projectConfigFile(ws), 'utf8');
  assert.match(text, /- loop:\n\s+rounds: 3\n\s+steps:/);
  assert.match(text, /- parallel:\n\s+- reviewer/);
  assert.match(text, /- branch:\n\s+on: security-reviewer/);

  const layers: ScenarioStepLayer[] = [{ branch: { on: 'reviewer', if: { verdict: 'approved' }, then: ['a'], else: ['b', 'c'] } }, { parallel: ['x', 'y'] }, { parallel: ['z', 'w'] }];
  assert.deepEqual(nestSteps(flattenSteps(layers)), layers, 'two Parallels side by side stay two');
});

test('blocks: a backup carries them, and restoring writes them back', async () => {
  const home = tmp('cs-blocks-h-');
  const made = await backups.createBackup({ workspace: workspace(SHIP), now: new Date('2026-11-06T12:00:00Z') });
  const parsed = backups.parseBackup(made.text);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const other = workspace('');
  await backups.restoreBackup({ workspace: other, home, backup: parsed.backup });
  const r = await config.loadConfig({ workspace: other, home });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  assert.equal(r.config.custom.ship!.agents[3]!.parallel, 1);
  assert.deepEqual(r.config.custom.ship!.agents[4]!.when, { on: 'security-reviewer', if: { severity: 'minor' } });
});

test('blocks: a backup and a library take no text from a file a project\'s config may not name', async () => {
  const home = tmp('cs-blocks-h-');
  // A file outside the workspace, as a repo someone else wrote could name for an agent and for a scenario's step.
  const secret = path.join(tmp('cs-blocks-secret-'), 'credentials');
  fs.writeFileSync(secret, 'TOP SECRET\n');
  const ws = workspace(`agents:
  leaky: { extends: reviewer, description: Reads too much, instructions: { file: ${JSON.stringify(secret)} } }
scenarios:
  ship:
    label: Ship
    agents:
      - developer
      - { agent: reviewer, instructions: { file: ${JSON.stringify(secret)} } }
`);
  const made = await backups.createBackup({ workspace: ws, home, now: new Date('2026-11-06T12:00:00Z') });
  assert.doesNotMatch(made.text, /TOP SECRET/);
  assert.match(made.text, /credentials/, 'the files stay named');

  // A project whose config still loads (the agent does not run) moves the agent into a library: not the file's text.
  const own = workspace(`agents:\n  leaky: { extends: reviewer, description: Reads too much, instructions: { file: ${JSON.stringify(secret)} } }\n`);
  const shared = path.join(own, 'shared-agents');
  await libraries.addLibrary({ workspace: own, home, dir: shared, scope: 'project', create: true });
  assert.deepEqual(await libraries.moveToLibrary({ workspace: own, home, library: path.join(shared, 'library.yaml'), agents: ['leaky'] }), { agents: ['leaky'], scenarios: [] });
  assert.equal(fs.existsSync(path.join(shared, 'prompts')), false, 'nothing copied into the library');
  assert.doesNotMatch(fs.readFileSync(path.join(shared, 'library.yaml'), 'utf8'), /TOP SECRET/);
});

test('blocks: what a scenario may not do with them is an error of that scenario', async () => {
  const home = tmp('cs-blocks-h-');
  const errors = async (steps: string): Promise<string[]> => {
    const r = await config.loadConfig({ workspace: workspace(`${AGENTS}scenarios:\n  s:\n    label: S\n    agents:\n${steps}`), home });
    return r.ok ? [] : r.errors.map((e) => e.code);
  };
  assert.deepEqual(await errors('      - parallel: [developer, reviewer]\n'), ['parallel_writes']);
  assert.deepEqual(await errors('      - developer\n      - branch: { on: reviewer, if: { verdict: approved }, then: [security-fixer] }\n      - reviewer\n'), ['branch_source']);
  assert.deepEqual(await errors('      - developer\n      - branch: { on: developer, if: { verdict: approved }, then: [reviewer] }\n'), ['branch_condition']);
  assert.deepEqual(await errors('      - loop: { steps: [reviewer, developer] }\n'), ['loop_without_review']);
  assert.deepEqual(await errors('      - loop: { steps: [developer, reviewer] }\n      - security-fixer\n      - loop: { steps: [security-reviewer] }\n'), ['loop_twice']);
  assert.match(validateConfigLayer({ scenarios: { s: { label: 'S', agents: [{ branch: { on: 'reviewer', if: { mood: 'good' } } }] } } }).join(), /expected one of verdict, severity, readiness, audit, gates/);
  assert.match(validateConfigLayer({ scenarios: { s: { label: 'S', agents: [{ parallel: ['reviewer'] }] } } }).join(), /at least 2/);
});

test('blocks: a Parallel left with one agent runs it alone, a branch on a step that does not run takes its other arm', async () => {
  const home = tmp('cs-blocks-h-');
  const r = await config.loadConfig({ workspace: workspace(`${SHIP.replace('security-reviewer: { extends: reviewer,', 'security-reviewer: { extends: reviewer, enabled: false,')}`), home });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  const p = scenarioPipeline(r.config, r.config.custom.ship!.agents);
  assert.equal(p.stages.find((s) => s.agent === 'reviewer')!.group, undefined);
  assert.ok(p.warnings.some((w) => w.code === 'branch_source_off'));
});

test('blocks: You approve after a turned-off agent waits after the step before it in its block, and says so', async () => {
  const home = tmp('cs-blocks-h-');
  const yaml = `${AGENTS.replace('security-reviewer: { extends: reviewer,', 'security-reviewer: { extends: reviewer, enabled: false,')}scenarios:
  ship:
    label: Ship
    agents:
      - developer
      - parallel: [reviewer, security-reviewer]
      - approve: Read both reviews
      - security-fixer
`;
  const r = await config.loadConfig({ workspace: workspace(yaml), home });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  const p = scenarioPipeline(r.config, r.config.custom.ship!.agents);
  assert.deepEqual(p.stages.find((s) => s.agent === 'reviewer')!.approve, { text: 'Read both reviews' }, 'the Parallel still waits for you');
  assert.ok(p.warnings.some((w) => w.code === 'approve_moved' && w.agent === 'security-reviewer'));

  // Nothing before it in its block runs: the approval goes, and the route says so.
  const alone = scenarioPipeline(r.config, [{ name: 'developer' }, { name: 'security-reviewer', when: { on: 'developer', if: { gates: 'fail' } }, approve: {} }]);
  assert.ok(alone.stages.every((s) => !s.approve));
  assert.ok(alone.warnings.some((w) => w.code === 'approve_dropped'));
});

test('blocks: a Loop whose reviewer is turned off says so, not that it has nothing to fix', async () => {
  const home = tmp('cs-blocks-h-');
  const r = await config.loadConfig({ workspace: workspace(SHIP), home });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  const agents = { ...r.config.agents, reviewer: { ...r.config.agents.reviewer!, enabled: false }, 'security-reviewer': { ...r.config.agents['security-reviewer']!, enabled: false } };
  const p = scenarioPipeline({ ...r.config, agents }, r.config.custom.ship!.agents);
  assert.equal(p.reviewLoop, null);
  assert.deepEqual(p.warnings.filter((w) => w.code.startsWith('loop_')).map((w) => w.code), ['loop_without_review']);
});

test('blocks: approve after a step, after a block and in a branch\'s arm marks the step before it, and writes back', async () => {
  const layers: ScenarioStepLayer[] = [
    'developer',
    { approve: 'Look at the migration' },
    { parallel: ['reviewer', 'security-reviewer'] },
    { approve: true },
    { branch: { on: 'security-reviewer', if: { severity: 'minor' }, then: ['security-fixer', { approve: 'You check the fixes' }] } },
  ];
  const flat = flattenSteps(layers);
  assert.deepEqual(flat.map((f) => [f.step, f.approve ?? null]), [
    ['developer', { text: 'Look at the migration' }],
    ['reviewer', null],
    ['security-reviewer', {}],
    ['security-fixer', { text: 'You check the fixes' }],
  ]);
  assert.deepEqual(nestSteps(flat), layers);

  const home = tmp('cs-blocks-h-');
  const ws = workspace(`${AGENTS}scenarios:\n  s:\n    label: S\n    agents:\n      - developer\n      - approve: Look at the migration\n      - reviewer\n`);
  const r = await config.loadConfig({ workspace: ws, home });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  const p = buildPipeline(r.config, { scenario: 's' });
  assert.deepEqual(p.stages[0]!.approve, { text: 'Look at the migration' });
  assert.ok(fixedFlow(p));
  await config.saveCustomScenario({ workspace: ws, home, id: 's', label: 'S', agents: r.config.custom.s!.agents });
  assert.match(fs.readFileSync(config.projectConfigFile(ws), 'utf8'), /- developer\n\s+- approve: Look at the migration\n\s+- reviewer/);
});
