// "Fix in chat": which failure a chat is asked to fix, where it starts, and what its command line holds.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

import { fixProblem, fixableCheckpoint, fixDirs, fixPrompt, fixArgs, clip, MODEL_ID } from '../src/core/fix';
import { parsePageRequest } from '../src/core/requests';

const hook = { id: 'hook-failure' as const, at: '2026-11-02T10:00:00Z', reason: 'hook output' };

test('fix: a failure the task waits at comes first, then an error the run ended with; decisions and sign-ins are not fixes', () => {
  const lint = 'api: /src/a.ts\n  12:3  warning  More than two parameters';
  const atHook = fixProblem({ status: 'waiting', error: null, checkpoint: hook, checkpointText: lint });
  assert.deepEqual(atHook, { source: 'checkpoint', what: 'a git hook rejected the commit', retry: 'the commit', text: lint });

  const atAgent = fixProblem({ status: 'stopped', error: null, checkpoint: { id: 'agent-failure', step: { stage: 2, agent: 'developer', repo: 'web' } }, checkpointText: 'exit 1' });
  assert.deepEqual(atAgent && atAgent.step, { agent: 'developer', repo: 'web' }, 'a paused task still waits at it');
  assert.equal(fixProblem({ status: 'waiting', error: null, checkpoint: { id: 'gate-failure', reason: 'lint failed' }, checkpointText: '' })?.text, 'lint failed', 'the reason when there is no output');

  for (const id of ['approve-plan', 'confirm-push', 'review-limit'] as const) {
    assert.equal(fixProblem({ status: 'waiting', error: null, checkpoint: { id }, checkpointText: 'text' }), null, id);
    assert.equal(fixableCheckpoint({ id }), false, id);
  }
  assert.equal(fixableCheckpoint(hook), true);
  assert.equal(fixableCheckpoint(null), false);

  const branch = fixProblem({ status: 'failed', error: { code: 'wrong_branch', message: 'api is on main, not the task branch feat/x' }, checkpoint: null, checkpointText: '' });
  assert.deepEqual(branch, { source: 'error', what: 'the run failed', retry: 'the task', text: 'api is on main, not the task branch feat/x' });
  const blocked = fixProblem({ status: 'failed', error: { code: 'repos_not_ready', message: 'repos not ready', blocked: [{ repo: 'api', problem: 'uncommitted changes', files: ['a.ts', 'b.ts'] }] }, checkpoint: null, checkpointText: '' });
  assert.equal(blocked?.text, 'repos not ready\napi: uncommitted changes\n  a.ts\n  b.ts', 'the repos that block it, with their files');

  assert.equal(fixProblem({ status: 'done', error: { message: 'old' }, checkpoint: null, checkpointText: '' }), null, 'an error from before is not shown, so not fixed');
  for (const code of ['busy', 'claude_login', 'atlassian_auth', 'atlassian_not_configured']) {
    assert.equal(fixProblem({ status: 'failed', error: { code, message: 'x' }, checkpoint: null, checkpointText: '' }), null, code);
  }
  assert.equal(fixProblem({ status: 'failed', error: { message: '  ' }, checkpoint: null, checkpointText: '' }), null, 'nothing to say, nothing to fix');
});

test('fix: the chat starts in the repo the failure is in; the other repos are added', () => {
  const root = path.resolve('/ws');
  const api = { name: 'api', dir: path.join(root, 'api') };
  const web = { name: 'web', dir: path.join(root, 'web') };
  const far = { name: 'billing', dir: path.resolve('/elsewhere/billing') };
  const problem = (text: string, repo?: string) => ({ source: 'checkpoint' as const, what: 'w', retry: 'r', text, ...(repo && { step: { agent: 'developer', repo } }) });

  assert.deepEqual(fixDirs({ root, repos: [api, web], problem: problem('x', 'web') }), { cwd: web.dir, addDirs: [api.dir] }, "the step's repo");
  assert.deepEqual(fixDirs({ root, repos: [api, web], problem: problem('api: hook said no') }), { cwd: api.dir, addDirs: [web.dir] }, "the repo a hook's output names");
  assert.deepEqual(fixDirs({ root, repos: [api], problem: problem('x') }), { cwd: api.dir, addDirs: [] }, 'the only repo');
  assert.deepEqual(fixDirs({ root, repos: [api, web, far], problem: problem('x') }), { cwd: root, addDirs: [far.dir] }, 'the workspace, and a repo outside it');
});

test('fix: the prompt names the failure, where it is and what not to do; long output keeps its start and end', () => {
  const prompt = fixPrompt({
    taskId: 'CP-1151',
    title: 'Risk thresholds',
    branch: 'feat/CP-1151-risk',
    repos: [{ name: 'api', dir: '/ws/api' }],
    taskDir: '/ws/.orch/tasks/CP-1151',
    problem: { source: 'checkpoint', what: 'a git hook rejected the commit', retry: 'the commit', text: '\x1b[33mwarning\x1b[0m too many params', step: { agent: 'committer', repo: 'api' } },
  });
  assert.match(prompt, /^Claudestrator task CP-1151 \("Risk thresholds"\) stopped: a git hook rejected the commit\./);
  assert.match(prompt, /Step: committer in api/);
  assert.match(prompt, /- api: \/ws\/api/);
  assert.match(prompt, /```\nwarning too many params\n```/, 'without terminal colours');
  assert.match(prompt, /I retry the commit in Claudestrator/);
  assert.match(prompt, /do not commit, push or open a PR/);
  assert.match(prompt, /leave every repo on feat\/CP-1151-risk/);

  const long = `${'a'.repeat(20000)}END`;
  const cut = clip(long, 1000);
  assert.ok(cut.length < 1100);
  assert.ok(cut.startsWith('aaa') && cut.endsWith('END'));
  assert.match(cut, /\[… 19003 characters cut …\]/);
  assert.equal(clip('a\0b'), 'ab', 'no NUL reaches a command line');
});

test('fix: the prompt goes first (--add-dir takes every word after it), the default model and effort add nothing', () => {
  assert.deepEqual(fixArgs({ prompt: 'p', model: 'opus', effort: 'high', addDirs: ['/a', '/b'] }), ['p', '--model', 'opus', '--effort', 'high', '--add-dir', '/a', '/b']);
  assert.deepEqual(fixArgs({ prompt: 'p', model: 'inherit', addDirs: [] }), ['p']);
  assert.deepEqual(fixArgs({ prompt: 'p', addDirs: [] }), ['p']);

  for (const m of ['opus', 'opus[1m]', 'claude-opus-5-5', 'inherit']) assert.ok(MODEL_ID.test(m), m);
  for (const m of ['--dangerously-skip-permissions', '', 'a b', '-x']) assert.equal(MODEL_ID.test(m), false, m);

  assert.ok(parsePageRequest({ type: 'req', id: 1, method: 'fixInChat', params: { taskId: 'CP-1', model: 'sonnet', effort: 'max' } })?.ok);
  const bad = parsePageRequest({ type: 'req', id: 2, method: 'fixInChat', params: { taskId: 'CP-1', model: '--print', effort: 'huge' } });
  assert.ok(bad && !bad.ok);
  assert.match(bad.error, /model: a model alias or id/);
  assert.match(bad.error, /effort: expected one of/);
});
