// Gates run in a process group of their own: a timeout or a stopped task ends everything they started.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { runGates, runShell } from '../src/core/gates';
import { setChildEnv } from '../src/core/git';
import { workspace, harness, waitFor } from './helpers/e2e';
import type { RepoConfig } from '../src/core/types';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A repo with one uncommitted change, so its gates run. */
function changedRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gates-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  return dir;
}

test('gates: a gate that runs out of time is killed with everything it started', { skip: process.platform === 'win32' }, async () => {
  const dir = changedRepo();
  const pidFile = path.join(dir, 'child.pid');
  const r = await runShell(`sleep 30 & echo $! > "${pidFile}"; wait`, { cwd: dir, env: process.env, timeoutMs: 300 });
  assert.equal(r.killed, 'timeout');
  assert.equal(r.code, 124);
  assert.match(r.output, /killed after 0s/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => !alive(pid), 5000);
});

test('gates: stdout and stderr both kept, non-ASCII intact, and a stopped run skips the gates after it', { skip: process.platform === 'win32' }, async () => {
  const dir = changedRepo();
  const out = await runShell('echo один; echo два >&2; echo три', { cwd: dir, env: process.env, timeoutMs: 5000 });
  assert.equal(out.code, 0);
  assert.deepEqual(out.output.trim().split('\n').sort(), ['два', 'один', 'три']);

  setChildEnv({ ...process.env });
  const repo: RepoConfig = { name: 'api', path: dir, baseBranch: 'main', gates: [{ name: 'slow', cmd: 'sleep 30' }, { name: 'lint', cmd: 'true' }] };
  const abort = new AbortController();
  const started = Date.now();
  setTimeout(() => abort.abort(), 200);
  const r = await runGates({ repo, dir, logDir: path.join(dir, 'logs'), signal: abort.signal });
  assert.ok(Date.now() - started < 5000, 'stopping does not wait for the gate');
  assert.deepEqual(r.results.map((x) => [x.gate, x.status]), [['slow', 'fail'], ['lint', 'skipped']]);
  assert.match(fs.readFileSync(path.join(dir, 'logs', 'api.slow.log'), 'utf8'), /stopped with the task/);
});

test('gates: Stop during the gates ends them and leaves the step to resume', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'repos:\n  api:\n    gates:\n      - { name: slow, cmd: sleep 30 }\npipeline: [planner, developer]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Do a thing', auto: true });
    h.engine.launch(taskId);
    await waitFor(() => h.engine.live(taskId) && h.engine.live(taskId)!.phase === 'gates' && h.engine.gateRuns.has(taskId));
    const started = Date.now();
    await h.engine.stop(taskId);
    await waitFor(() => !h.engine.isRunning(taskId), 10000);
    assert.ok(Date.now() - started < 8000, 'the task stopped without waiting for the gate');
    assert.equal(h.engine.svc.state(taskId).status, 'stopped');
  } finally {
    h.hooks.dispose();
  }
});
