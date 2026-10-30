// The git the engine does itself: branches and worktrees for a task, the diff a reviewer reads, cleaning up.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { prepareRepos, removeWorktrees, taskDiff, taskRepos } from '../src/core/git';
import { git, workspace } from './helpers/e2e';
import type { Config, TaskState } from '../src/core/types';

const config = { repos: {}, baseBranch: 'main' } as unknown as Pick<Config, 'repos' | 'baseBranch'>;

/** A task whose plan names these repos, in this git mode. */
const task = (repos: string[], gitMode: 'branch' | 'worktree'): TaskState =>
  ({ taskId: 'T-1', source: { kind: 'text', text: 'x' }, gitMode, plan: { type: 'feat', slug: 'cap-bets', title: 'Cap bets', repos: [] }, repos: repos.map((name) => ({ name, mode: 'full' })) }) as unknown as TaskState;

test('git: branch mode branches clean checkouts, and refuses to touch one with uncommitted work', async () => {
  const ws = workspace(['api', 'web'], '');
  fs.writeFileSync(path.join(ws, 'web', 'wip.txt'), 'mine');
  const blocked = await prepareRepos(ws, task(['api', 'web'], 'branch'), config);
  assert.ok(!blocked.ok && blocked.code === 'repos_not_ready');
  assert.deepEqual(blocked.blocked!.map((b) => [b.repo, b.problem]), [['web', 'uncommitted changes']]);
  assert.equal(git(path.join(ws, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'nothing was changed, not even the clean one');

  fs.rmSync(path.join(ws, 'web', 'wip.txt'));
  const ok = await prepareRepos(ws, task(['api', 'web'], 'branch'), config);
  assert.ok(ok.ok, JSON.stringify(ok));
  for (const repo of ['api', 'web']) assert.equal(git(path.join(ws, repo), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/cap-bets');
  const again = await prepareRepos(ws, task(['api'], 'branch'), config);
  assert.ok(again.ok && again.repos.every((r) => r.status === 'ready'), 'a second time finds it ready');
});

test("git: worktree mode leaves your checkouts alone, the diff covers new files but not Claudestrator's, and cleanup keeps unsaved work", async () => {
  const ws = workspace(['api'], '');
  fs.writeFileSync(path.join(ws, 'api', 'wip.txt'), 'mine: worktrees do not mind');
  const s = task(['api'], 'worktree');
  const p = await prepareRepos(ws, s, config);
  assert.ok(p.ok, JSON.stringify(p));
  const [repo] = taskRepos(ws, s, config, ['api']);
  assert.equal(repo!.dir, path.join(ws, '.orch', 'worktrees', 'T-1', 'api'));
  assert.equal(git(repo!.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/cap-bets');
  assert.equal(git(path.join(ws, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'your checkout stays on its branch');

  let diff = await taskDiff([repo!]);
  assert.ok(diff.empty, 'nothing changed yet');
  fs.writeFileSync(path.join(repo!.dir, 'README.md'), '# api\n\nCaps bets.\n');
  fs.writeFileSync(path.join(repo!.dir, 'cap.ts'), 'export const CAP = 100;\n');
  fs.mkdirSync(path.join(repo!.dir, '.claudestrator'));
  fs.writeFileSync(path.join(repo!.dir, '.claudestrator', 'config.yaml'), 'language: German\n');
  diff = await taskDiff([repo!]);
  assert.equal(diff.empty, false);
  assert.match(diff.text, /\+Caps bets\./);
  assert.match(diff.text, /\+export const CAP = 100;/, 'a new file is in the diff');
  assert.doesNotMatch(diff.text, /language: German/, "Claudestrator's own folder is not the user's change");

  const kept = await removeWorktrees(ws, s, config);
  assert.equal(kept[0]!.status, 'kept', 'a worktree with work not committed stays');
  assert.ok(fs.existsSync(repo!.dir));
  const forced = await removeWorktrees(ws, s, config, true);
  assert.equal(forced[0]!.status, 'removed');
  assert.ok(!fs.existsSync(repo!.dir));
  assert.deepEqual((await removeWorktrees(ws, s, config)).map((r) => r.status), ['absent']);
});
