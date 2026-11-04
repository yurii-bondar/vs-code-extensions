// A group's base branch: the tasks of an epic start from its branch, in each repo whose origin has it.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as config from '../src/core/config';
import { validateConfigLayer } from '../src/core/protocol';
import { git, workspace, harness, runTask, text } from './helpers/e2e';

test('groups: a base branch is a branch name, saved with the group', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-groups-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-groups-h-'));
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), '');
  const id = await config.saveGroup({ workspace: ws, home, type: 'epic', label: 'Checkout revamp', baseBranch: ' feat/checkout-revamp ' });
  const r = await config.loadConfig({ workspace: ws, home });
  assert.ok(r.ok);
  assert.equal(r.config.groups[id]!.baseBranch, 'feat/checkout-revamp');
  await assert.rejects(() => config.saveGroup({ workspace: ws, home, type: 'epic', label: 'Other', baseBranch: 'feat/a b' }), /not a branch name/);
  await config.saveGroup({ workspace: ws, home, id, type: 'epic', label: 'Checkout revamp' });
  const cleared = await config.loadConfig({ workspace: ws, home });
  assert.ok(cleared.ok);
  assert.equal(cleared.config.groups[id]!.baseBranch, undefined, 'saved without one, it has none');
  assert.deepEqual(validateConfigLayer({ groups: { x: { type: 'epic', label: 'X', baseBranch: 'feat/x' } } }), []);
  assert.match(validateConfigLayer({ groups: { x: { type: 'epic', label: 'X', baseBranch: '../x' } } }).join('\n'), /baseBranch: a branch name/);
});

test("groups: a group's task starts from its branch where origin has it, and from the repo's base elsewhere", { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api', 'web'], 'repos:\n  api: {}\n  web: {}\ngroups:\n  checkout-revamp: { type: epic, label: Checkout revamp, baseBranch: feat/checkout-revamp }\n');
  for (const name of ['api', 'web']) {
    const dir = path.join(ws, name);
    const origin = path.join(ws, `${name}-origin.git`);
    git(ws, 'init', '-q', '--bare', origin);
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', 'origin', 'main');
  }
  // Only api has the epic's branch, with the rule the tasks need on it.
  const api = path.join(ws, 'api');
  git(api, 'switch', '-q', '-c', 'feat/checkout-revamp');
  fs.mkdirSync(path.join(api, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(api, '.claude', 'rules', 'forms.md'), 'Forms use the shared validator.\n');
  git(api, 'add', '.');
  git(api, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'forms rule');
  git(api, 'push', '-q', 'origin', 'feat/checkout-revamp');
  git(api, 'switch', '-q', 'main');
  git(api, 'branch', '-q', '-D', 'feat/checkout-revamp');
  const h = await harness(ws, { FAKE_REPOS: 'api,web' });
  try {
    const { taskId } = await h.engine.start({ text: 'Show the order total with taxes', auto: true, group: 'checkout-revamp' });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.deepEqual(s.repos.map((r) => [r.name, r.baseBranch ?? null]), [['api', 'feat/checkout-revamp'], ['web', null]]);
    assert.ok(fs.existsSync(path.join(api, '.claude', 'rules', 'forms.md')), "the task branch has what is only on the epic's branch");
    const ctx = await h.engine.checkpointContext(s, s.checkpoint!);
    assert.deepEqual(ctx.repos!.map((r) => [r.name, r.base]), [['api', 'feat/checkout-revamp'], ['web', 'main']], 'the PRs go into the epic branch where it is');
    const prompts = h.outputs.filter((o) => o.item.type === 'prompt').map((o) => text((o.item as { text?: unknown }).text));
    assert.ok(prompts.some((p) => /Tasks of "Checkout revamp" start from feat\/checkout-revamp in each repo where origin has that branch/.test(p)), 'the planner hears it');
  } finally {
    h.hooks.dispose();
  }
});
