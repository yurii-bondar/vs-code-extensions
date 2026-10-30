// The window's engines: the current one, and one replaced (the workspace folder changed) while its task still runs.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import Module from 'module';

import type { Engine } from '../src/core/engine';
import type { PermissionRequest } from '../src/core/wire';

// orchestrator.ts loads `vscode`; these methods never reach it.
/* eslint-disable @typescript-eslint/no-require-imports */
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const load = loader._load;
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? {} : load.call(this, request, ...rest);
};
const { Orchestrator } = require('../src/orchestrator') as typeof import('../src/orchestrator');
loader._load = load;

/** An engine as far as routing reads it: what runs in it and the questions it waits on. */
function engine(running: string[], waiting: PermissionRequest[]) {
  const answered: string[] = [];
  const stopped: string[] = [];
  const e = {
    running: new Set(running),
    pendingPermissions: () => waiting,
    permissionReply: (id: string) => (waiting.some((w) => w.requestId === id) ? (answered.push(id), true) : false),
    stop: async (taskId: string) => void stopped.push(taskId),
  };
  return { e: e as unknown as Engine, answered, stopped };
}

test('orchestrator: a question of a replaced engine\'s agent is listed and answered, and its task is stopped there', async () => {
  const ask = (requestId: string, taskId: string) => ({ requestId, taskId, agent: 'developer', tool: 'Bash', input: {}, at: 0 }) as PermissionRequest;
  const current = engine(['NEW-1'], [ask('r-new', 'NEW-1')]);
  const old = engine(['OLD-1'], [ask('r-old', 'OLD-1')]);
  const orch = Object.assign(Object.create(Orchestrator.prototype) as InstanceType<typeof Orchestrator>, { engine: current.e, retired: [old.e] });

  assert.deepEqual(orch.pendingPermissions().map((p) => p.requestId), ['r-new', 'r-old']);
  assert.equal(orch.permissionReply('r-old', true), true);
  assert.deepEqual(old.answered, ['r-old'], 'the engine that asked answers it');
  assert.equal(orch.permissionReply('gone', true), false);
  assert.equal(orch.engineOf('OLD-1'), old.e);
  assert.equal(orch.engineOf('NEW-1'), current.e);
  await orch.engineOf('OLD-1')!.stop('OLD-1');
  assert.deepEqual(old.stopped, ['OLD-1']);
});
