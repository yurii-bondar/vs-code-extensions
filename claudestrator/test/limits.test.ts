// What the engine does when the account's usage limit is used up.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { workspace, harness, waitFor } from './helpers/e2e';

test('limits: no agent starts while Claude Code reports the account limit as used up', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    h.engine.limits = { fiveHour: { pct: 100, resetsAt, status: 'rejected' }, sevenDay: { pct: 40, resetsAt: resetsAt + 86400, status: 'allowed' }, at: Date.now() };
    const { taskId } = h.engine.start({ text: 'Do a thing' });
    h.engine.launch(taskId);
    const err = await waitFor(() => h.engine.lastError(taskId));
    assert.equal(err.code, 'limit_reached');
    assert.match(err.message, /5-hour limit is used up until .*; resume the task then/);
    assert.ok(!fs.existsSync(path.join(h.state, 'calls.ndjson')), 'no Claude Code session was started');

    // Once the window has reset, the same task runs.
    h.engine.limits = { fiveHour: { pct: 100, resetsAt: Math.round(Date.now() / 1000) - 1, status: 'rejected' }, sevenDay: undefined, at: Date.now() };
    const s = await h.engine.run(taskId);
    assert.equal(s!.checkpoint!.id, 'approve-plan');
  } finally {
    h.hooks.dispose();
  }
});
