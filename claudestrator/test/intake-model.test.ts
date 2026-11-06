// The model and effort of the agent that reads a Jira issue or Confluence page through an MCP server: haiku · low
// unless the config or the task's scenario says otherwise, and fixed when the task starts.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as config from '../src/core/config';
import { Engine } from '../src/core/engine';
import { replay } from '../src/core/machine';
import { validateConfigLayer } from '../src/core/protocol';
import type { EngineOptions } from '../src/core/engine';
import type { OrchEvent } from '../src/core/types';

const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function workspace(yaml: string): string {
  const ws = tmp('cs-intake-');
  fs.mkdirSync(path.join(ws, config.CONFIG_DIR));
  fs.writeFileSync(config.projectConfigFile(ws), yaml);
  return ws;
}

/** An engine whose runner records the agent it was asked to start, then fails it. */
function recording(ws: string, home: string) {
  const agents: { model: string; effort?: string }[] = [];
  const runner = {
    start: async (opts: { agent: { model: string; effort?: string } }) => {
      agents.push(opts.agent);
      throw new Error('enough');
    },
  } as unknown as EngineOptions['runner'];
  const hooks = { listen: async () => {}, host: () => '127.0.0.1', settings: () => ({}), register: () => ({ token: 't', url: 'http://127.0.0.1:1' }), unregister: () => {} } as unknown as EngineOptions['hooks'];
  const engine = new Engine({ workspace: ws, home, runner, hooks, mcpIntake: async () => ({ server: 'Atlassian' }) });
  return { engine, agents };
}

const CONFIG = `jira: { allowedProjects: [CP] }
intake: { model: sonnet }
scenarios:
  spec-review:
    label: Spec review
    intake: { effort: medium }
    agents: [planner]
`;

test('intake: the config sets the model, a scenario overrides it, and the task keeps what it started with', async () => {
  const home = tmp('cs-intake-h-');
  const ws = workspace(CONFIG);
  const r = await config.loadConfig({ workspace: ws, home });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.config.intake, { model: 'sonnet', effort: 'low' }, 'what the config leaves out stays the default');
  assert.deepEqual(r.config.custom['spec-review']!.intake, { effort: 'medium' });

  const { engine, agents } = recording(ws, home);
  const deliver = await engine.start({ text: 'CP-12' });
  assert.deepEqual((await engine.svc.state(deliver.taskId)).intake, { model: 'sonnet', effort: 'low' });
  const review = await engine.start({ text: 'CP-13', scenario: 'spec-review' });
  assert.deepEqual((await engine.svc.state(review.taskId)).intake, { model: 'sonnet', effort: 'medium' });

  await engine.run(review.taskId).catch(() => {});
  assert.deepEqual(agents.map((a) => [a.model, a.effort]), [['sonnet', 'medium']], 'the reading agent runs with the task\'s model and effort');

  // Text needs no reading agent, so the task records none.
  const text = await engine.start({ text: 'Fix the login page' });
  const events = await engine.svc.events(text.taskId);
  assert.equal((events[0] as Extract<OrchEvent, { type: 'task_created' }>).intake, undefined);
});

test('intake: logs from before it was set read with haiku · low', () => {
  const created = { type: 'task_created', taskId: 'T-1', input: 'CP-1', source: { kind: 'jira', key: 'CP-1' }, auto: false, pipeline: { mode: 'plan_only', stages: [], reviewLoop: null }, knownRepos: [], limits: { reviewRounds: 2, gateAttempts: 3 }, at: '2026-11-01T00:00:00Z' } as OrchEvent;
  assert.deepEqual(replay([created]).intake, { model: 'haiku', effort: 'low' });
  assert.match(validateConfigLayer({ intake: { effort: 'huge' } }).join(), /intake\.effort/);
});
