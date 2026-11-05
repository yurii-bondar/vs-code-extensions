import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createBranch, deleteBranch, deleteOnRemote, nameProblem, onlyHere, renameBranch } from '../src/core/branch-ops';
import { listBranches } from '../src/core/branches';
import { isMergedInto } from '../src/core/merged';
import type { Branch, RepoRoot } from '../src/core/types';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

let repo: TestRepo;
const find = async (name: string, local = true): Promise<Branch> => {
  const b = (await listBranches(git, repo.work)).find((x) => x.name === name && x.local === local);
  assert.ok(b, `no branch ${name}`);
  return b;
};
const names = async (): Promise<string[]> => (await repo.run('for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin')).split('\n').filter(Boolean);

before(async () => {
  repo = await makeRepo();
});
after(() => fs.rm(repo.dir, { recursive: true, force: true }));

test('nameProblem rejects invalid and taken names', async () => {
  assert.equal(await nameProblem(git, repo.work, 'feat/ok'), null);
  assert.equal(await nameProblem(git, repo.work, ''), 'Type a name.');
  assert.match((await nameProblem(git, repo.work, 'bad name')) ?? '', /Not a valid branch name/);
  assert.match((await nameProblem(git, repo.work, 'feat/')) ?? '', /Not a valid branch name/);
  assert.equal(await nameProblem(git, repo.work, 'main'), 'A branch with this name already exists.');
});

test('createBranch makes a branch at a start point, and switches to it only when asked', async () => {
  await createBranch(git, repo.work, { name: 'feat/a', start: 'refs/heads/main', switchTo: false });
  assert.equal((await repo.run('branch', '--show-current')).trim(), 'main');
  await createBranch(git, repo.work, { name: 'feat/b', start: 'refs/heads/main', switchTo: true });
  assert.equal((await repo.run('branch', '--show-current')).trim(), 'feat/b');
  await repo.run('switch', 'main');
});

test('renameBranch renames locally, and on origin when asked, tracking the new name', async () => {
  await repo.run('push', '-u', 'origin', 'feat/a');
  await renameBranch(git, repo.work, { branch: await find('feat/a'), to: 'feat/a2', onRemote: true });
  const renamed = await find('feat/a2');
  assert.equal(renamed.upstream, 'origin/feat/a2');
  assert.ok(!(await names()).includes('origin/feat/a'));

  await renameBranch(git, repo.work, { branch: await find('feat/b'), to: 'feat/b2', onRemote: false });
  assert.ok((await names()).includes('feat/b2') && !(await names()).includes('feat/b'));
});

test('onlyHere lists the commits deleting a branch loses, here and on its remote', async () => {
  await repo.run('switch', 'feat/a2');
  await repo.commit('only local');
  await repo.run('switch', 'main');
  const a2 = await find('feat/a2');
  const lost = await onlyHere(git, repo.work, { branch: a2, withUpstream: true });
  assert.deepEqual(lost.local.map((c) => c.subject), ['only local']);
  assert.deepEqual(lost.remote, []);

  // pushed: the commit is on origin, so deleting the local branch alone loses nothing, deleting both loses it
  await repo.run('push', 'origin', 'feat/a2');
  const pushed = await onlyHere(git, repo.work, { branch: await find('feat/a2'), withUpstream: true });
  assert.deepEqual(pushed.local, []);
  assert.deepEqual(pushed.remote.map((c) => [c.subject, c.author]), [['only local', 'Test']]);
});

test('isMergedInto sees a squash merge, and deleteBranch removes local and remote', async () => {
  await repo.run('merge', '--squash', 'feat/a2');
  await repo.commit('squash a2');
  const a2 = await find('feat/a2');
  assert.equal(await isMergedInto({ git, root: repo.work, ref: a2.ref, target: 'main' }), true);
  assert.equal(await isMergedInto({ git, root: repo.work, ref: (await find('feat/b2')).ref, target: 'main' }), true);
  await deleteBranch(git, repo.work, { branch: a2, onRemote: true });
  assert.ok(!(await names()).some((n) => n.includes('feat/a2')));
});

test('deleteOnRemote removes a remote-only branch', async () => {
  await repo.run('push', 'origin', 'main:refs/heads/review');
  await repo.run('fetch');
  await deleteOnRemote(git, repo.work, (await find('review', false)).upstream ?? '');
  await repo.run('fetch', '--prune');
  assert.ok(!(await names()).includes('origin/review'));
  assert.equal(path.basename(repo.work as RepoRoot), 'work');
});
