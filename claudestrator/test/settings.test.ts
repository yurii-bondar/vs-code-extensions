// What Claude Code itself enforces for an agent session, whatever the guard answers: deny rules and the sandbox.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { sessionSettings, REGISTRIES } from '../src/core/settings';
import { workspace, harness, runTask } from './helpers/e2e';

interface Sandbox {
  enabled: boolean;
  allowUnsandboxedCommands: boolean;
  filesystem: { denyRead: string[]; denyWrite: string[] };
  network: { allowedDomains: string[] };
}
const sandboxOf = (s: Record<string, unknown>): Sandbox => s.sandbox as Sandbox;
const denyOf = (s: Record<string, unknown>): string[] => (s.permissions as { deny: string[] }).deny;

test('settings: secrets are never read and pushes never run, also when the guard is bypassed', () => {
  const s = sessionSettings({ hooks: { PreToolUse: [] }, writeRoots: ['/ws/api'], cwd: '/ws/api', sandbox: true, network: [] });
  assert.deepEqual(s.hooks, { PreToolUse: [] });
  const deny = denyOf(s);
  for (const rule of ['Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(//**/.env)', 'Read(~/.claude*/.credentials.json)', 'Bash(git push *)', 'Bash(gh pr merge *)']) assert.ok(deny.includes(rule), rule);
  assert.ok(!deny.some((r) => /\.env\.example/.test(r)), 'an example env file stays readable');
});

test('settings: the sandbox lets a stage write only its repos, never their git metadata, and reach only the registries', () => {
  const code = sandboxOf(sessionSettings({ hooks: {}, writeRoots: ['/ws/api', '/elsewhere/web'], cwd: '/ws/api', sandbox: true, network: ['npm.acme.corp'] }));
  assert.equal(code.enabled, true);
  assert.equal(code.allowUnsandboxedCommands, false, 'a command blocked by the sandbox is not run again outside it');
  assert.deepEqual(code.filesystem.denyWrite, [path.join('/ws/api', '.git'), path.join('/elsewhere/web', '.git')]);
  assert.ok(code.filesystem.denyRead.includes('~/.ssh'));
  assert.deepEqual(code.network.allowedDomains, [...REGISTRIES, 'npm.acme.corp']);
  assert.ok(!code.network.allowedDomains.includes('github.com'), 'git over github.com is how a push would leave');

  const readOnly = sandboxOf(sessionSettings({ hooks: {}, writeRoots: [], cwd: '/ws', sandbox: true, network: [] }));
  assert.deepEqual(readOnly.filesystem.denyWrite, ['/ws'], 'a stage that changes nothing does not write its working directory');

  assert.equal(sessionSettings({ hooks: {}, writeRoots: [], cwd: '/ws', sandbox: false, network: [] }).sandbox, undefined, 'policy.sandbox: false');
});

test('settings: each session gets its own, and a stage writes only in the repos it works in', async () => {
  const ws = workspace(['api', 'web'], 'repos:\n  api: {}\n  web: {}\npolicy: { network: [npm.acme.corp] }\npipeline: [planner, developer, tester, reviewer]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api,web' });
  try {
    const { taskId } = h.engine.start({ text: 'Do a thing', auto: true });
    await runTask(h.engine, taskId);
    const calls = h.calls().filter((c: { args: string[] }) => c.args.includes('-p'));
    const of = (c: { args: string[] }) => JSON.parse(c.args[c.args.indexOf('--settings') + 1]!) as Record<string, unknown>;
    const dirs = (c: { args: string[] }) => c.args.flatMap((a, i) => (c.args[i - 1] === '--add-dir' ? [a] : []));
    const tester = calls.find((c: { args: string[] }) => /tester/.test(c.args[c.args.indexOf('--name') + 1]!))!;
    assert.equal(tester.cwd, path.join(ws, 'api'), 'a stage across repos starts in the first of them');
    assert.deepEqual(dirs(tester), [path.join(ws, 'web')], 'and gets the others, not the workspace around them');
    assert.deepEqual(sandboxOf(of(tester)).filesystem.denyWrite, [path.join(ws, 'api', '.git'), path.join(ws, 'web', '.git')]);
    const reviewer = calls.find((c: { args: string[] }) => /reviewer/.test(c.args[c.args.indexOf('--name') + 1]!))!;
    assert.deepEqual(dirs(reviewer), [], 'a reviewer reads through the guard and writes nowhere');
    assert.deepEqual(sandboxOf(of(reviewer)).filesystem.denyWrite, [ws]);
    assert.ok(sandboxOf(of(reviewer)).network.allowedDomains.includes('npm.acme.corp'), 'policy.network adds hosts');
    assert.ok(fs.existsSync(path.join(ws, 'web', 'feature.test.txt')), 'the tester still wrote in both repos');
  } finally {
    h.hooks.dispose();
  }
});
