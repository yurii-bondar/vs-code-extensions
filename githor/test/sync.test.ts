import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { listBranches } from '../src/core/branches';
import { publish, pull, push, remoteOnlyCommits } from '../src/core/sync';
import { cannotForcePush, cannotPull, cannotPush } from '../src/core/sync-rules';
import type { Branch, RepoRoot } from '../src/core/types';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

let repo: TestRepo;
/** A second clone: a colleague pushing to the same remote. */
let other: RepoRoot;
const inOther = (...args: string[]): Promise<string> => git.run(other, args[0] === 'commit' ? [...args, '--author', 'Marek <marek@example.com>'] : args);

const branch = async (name: string): Promise<Branch> => {
  const found = (await listBranches(git, repo.work)).find((b) => b.name === name && b.local);
  assert.ok(found, `no local branch ${name}`);
  return found;
};

before(async () => {
  repo = await makeRepo();
  other = path.join(repo.dir, 'other') as RepoRoot;
  await git.run(repo.dir as RepoRoot, ['clone', repo.remote, other]);
});

after(() => fs.rm(repo.dir, { recursive: true, force: true }));

test('push sends the current branch, and a branch that is not checked out', async () => {
  await repo.commit('on main');
  await repo.run('branch', 'side', 'main');
  await repo.run('push', '-u', 'origin', 'side');
  await repo.run('switch', 'side');
  await repo.commit('on side');
  await repo.run('switch', 'main');
  await push(git, repo.work, { branch: await branch('main') });
  await push(git, repo.work, { branch: await branch('side') });
  assert.equal((await branch('main')).sync, 'synced');
  assert.equal((await branch('side')).sync, 'synced');
});

test('pull fast-forwards the current branch, and moves another branch without switching to it', async () => {
  await inOther('pull', '--quiet');
  await inOther('commit', '--allow-empty', '-m', 'from Marek on main');
  await inOther('switch', 'side');
  await inOther('commit', '--allow-empty', '-m', 'from Marek on side');
  await inOther('push', '--quiet', 'origin', 'main', 'side');
  await repo.run('fetch');

  const side = await branch('side');
  assert.deepEqual([side.sync, side.behind, side.current], ['behind', 1, false]);
  await pull(git, repo.work, side);
  await pull(git, repo.work, await branch('main'));
  assert.equal((await branch('side')).sync, 'synced');
  assert.equal((await branch('main')).sync, 'synced');
  assert.equal((await repo.run('branch', '--show-current')).trim(), 'main');
});

test('publish pushes a new branch and makes it track the remote branch', async () => {
  await repo.run('switch', '-c', 'fresh');
  await repo.commit('fresh work');
  assert.equal(cannotPush(await branch('fresh')), 'This branch is not on a remote yet: publish it.');
  assert.equal(await publish(git, repo.work, await branch('fresh')), 'origin/fresh');
  const fresh = await branch('fresh');
  assert.deepEqual([fresh.upstream, fresh.sync], ['origin/fresh', 'synced']);
  await repo.run('switch', 'main');
});

test('a diverged branch cannot be pushed or pulled plainly; force-push with lease replaces what only origin has', async () => {
  await inOther('switch', 'main');
  await inOther('pull', '--quiet');
  await inOther('commit', '--allow-empty', '-m', 'Marek again');
  await inOther('commit', '--allow-empty', '-m', 'and again');
  await inOther('push', '--quiet');
  await repo.commit('mine');
  await repo.run('fetch');

  const main = await branch('main');
  assert.equal(main.sync, 'diverged');
  assert.match(cannotPush(main) ?? '', /both moved/);
  assert.match(cannotPull(main) ?? '', /both moved/);
  assert.deepEqual(await remoteOnlyCommits(git, repo.work, main), { count: 2, authors: ['Marek'] });
  assert.match(cannotForcePush(main, 'main') ?? '', /Turned off on main/);
  assert.equal(cannotForcePush(main, 'develop'), null);

  await push(git, repo.work, { branch: main, force: true });
  assert.equal((await branch('main')).sync, 'synced');
});

test('force-push with lease stops when origin moved since the last fetch', async () => {
  await inOther('fetch', '--quiet');
  await inOther('reset', '--hard', '--quiet', 'origin/main');
  await inOther('commit', '--allow-empty', '-m', 'not fetched yet');
  await inOther('push', '--quiet');
  await repo.commit('rewrite');
  // no fetch: the lease is on what this clone last saw of origin/main
  await assert.rejects(push(git, repo.work, { branch: await branch('main'), force: true }), /stale info|rejected/);
});

test('push with tags also sends tags origin does not have', async () => {
  await repo.run('switch', 'side');
  await repo.commit('tagged');
  await repo.run('tag', 'v1.0.0');
  await push(git, repo.work, { branch: await branch('side'), tags: true });
  assert.match(await git.run(repo.dir as RepoRoot, ['--git-dir', repo.remote, 'tag']), /v1\.0\.0/);
  await repo.run('switch', 'main');
});
