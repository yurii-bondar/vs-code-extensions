// An agent that shows no sign of work is stopped; one waiting for your answer is not.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { setChildEnv, getChildEnv } from '../src/core/git';
import { workspace, harness, runTask, waitFor } from './helpers/e2e';
import type { PermissionRequest } from '../src/core/engine';

test('watchdog: a hung agent is interrupted and the step fails with the reason', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner, developer]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  h.engine.stallMs = 1500; // wide enough for a slow start of the fake CLI on a busy machine
  try {
    setChildEnv({ ...getChildEnv(), FAKE_HANG: 'developer' });
    const { taskId } = await h.engine.start({ text: 'Do a thing', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'agent-failure');
    assert.match(s.checkpoint!.reason!, /no sign of work for 1 min and was stopped/);
    assert.equal(s.checkpoint!.step!.agent, 'developer');
  } finally {
    h.hooks.dispose();
  }
});

test('watchdog: a question waiting for you does not count as a hung agent', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner, developer]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  h.engine.stallMs = 1200;
  h.engine.askPermissions = () => true;
  h.engine.on('permission', (req: PermissionRequest) => setTimeout(() => h.engine.permissionReply(req.requestId, true), 2500));
  try {
    const { taskId } = await h.engine.start({ text: 'Do a thing', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'confirm-push', JSON.stringify(s.checkpoint));
  } finally {
    h.hooks.dispose();
  }
});

test('watchdog: a closing window kills an agent that ignores the stop, with its process group, before it returns', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner, developer]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    setChildEnv({ ...getChildEnv(), FAKE_HANG: 'planner', FAKE_STUBBORN: '1' });
    const { taskId } = await h.engine.start({ text: 'Do a thing', auto: true });
    h.engine.launch(taskId);
    const session = await waitFor(async () => h.engine.sessions.get(taskId)?.[0], 30000);
    const pid = session.proc.pid!;
    await h.engine.stopAll(300);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await waitFor(async () => !alive(), 2000);
  } finally {
    setChildEnv({ ...getChildEnv(), FAKE_HANG: '', FAKE_STUBBORN: '' });
    h.hooks.dispose();
  }
});
