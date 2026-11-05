import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { defaultBranch, listBranches, parseRefs, sortBranches, switchBranch } from '../src/core/branches';
import { GitError } from '../src/core/git';
import { lastFetchedAt } from '../src/core/remote';
import type { Branch } from '../src/core/types';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

const byName = (branches: Branch[]): Map<string, Branch> => new Map(branches.map((b) => [b.name, b]));

test('parseRefs reads local branches, their sync state, and remote branches nobody tracks', () => {
  const line = (...fields: string[]): string => fields.join('\0');
  const output = [
    line('refs/heads/main', 'a1', '*', 'origin/main', '', '1700000000', ''),
    line('refs/heads/feat/x', 'b2', ' ', 'origin/feat/x', 'ahead 2, behind 1', '1700000100', ''),
    line('refs/heads/old', 'c3', ' ', 'origin/old', 'gone', '1700000050', ''),
    line('refs/heads/wip', 'd4', ' ', '', '', '1700000200', ''),
    line('refs/remotes/origin/HEAD', 'a1', ' ', '', '', '1700000000', 'refs/remotes/origin/main'),
    line('refs/remotes/origin/main', 'a1', ' ', '', '', '1700000000', ''),
    line('refs/remotes/origin/feat/x', 'e5', ' ', '', '', '1700000090', ''),
    line('refs/remotes/origin/review/one', 'f6', ' ', '', '', '1700000300', ''),
    '',
  ].join('\n');

  const branches = parseRefs(output);
  assert.deepEqual(branches.map((b) => [b.name, b.sync, b.local]), [
    ['main', 'synced', true],
    ['wip', 'unpushed', true],
    ['feat/x', 'diverged', true],
    ['old', 'gone', true],
    ['review/one', 'remote', false],
  ]);
  assert.deepEqual(branches[0], { name: 'main', ref: 'refs/heads/main', current: true, pinned: false, local: true, upstream: 'origin/main', sync: 'synced', ahead: 0, behind: 0, sha: 'a1', committedAt: 1700000000000 });
  const review = byName(branches).get('review/one');
  assert.deepEqual([review?.ref, review?.upstream], ['refs/remotes/origin/review/one', 'origin/review/one']);
  assert.deepEqual([byName(branches).get('feat/x')?.ahead, byName(branches).get('feat/x')?.behind], [2, 1]);
});

test('sortBranches puts the current branch first, then pinned ones, then the rest newest first, remote-only last', () => {
  const b = (name: string, o: Partial<Branch> = {}): Branch => ({ name, ref: `refs/heads/${name}`, current: false, pinned: false, local: true, upstream: null, sync: 'unpushed', ahead: 0, behind: 0, sha: 's', committedAt: 0, ...o });
  const sorted = sortBranches([b('old', { committedAt: 1 }), b('new', { committedAt: 9 }), b('cur', { current: true }), b('pin', { committedAt: 2 }), b('far', { local: false, sync: 'remote', committedAt: 99 })], new Set(['pin', 'far']));
  assert.deepEqual(sorted.map((x) => [x.name, x.pinned]), [['cur', false], ['pin', true], ['new', false], ['old', false], ['far', false]]);
});

// ---------- against a real repository ----------

let repo: TestRepo;

before(async () => {
  repo = await makeRepo();
  const { run, commit } = repo;
  await run('switch', '-c', 'ahead');
  await run('push', '-u', 'origin', 'ahead');
  await commit('not pushed yet');

  for (const name of ['behind', 'diverged']) {
    await run('switch', '-c', name, 'main');
    await commit(`${name} one`);
    await run('push', '-u', 'origin', name);
    await run('reset', '--hard', 'HEAD~1');
  }
  await commit('diverged two');

  await run('switch', '-c', 'gone', 'main');
  await run('push', '-u', 'origin', 'gone');
  await run('push', 'origin', '--delete', 'gone');

  await run('switch', '-c', 'review', 'main');
  await run('push', 'origin', 'review');
  await run('switch', '-c', 'wip', 'main');
  await commit('wip one');
  await commit('wip two');
  await run('branch', '-D', 'review');
  await run('switch', 'main');
});

after(() => fs.rm(repo.dir, { recursive: true, force: true }));

test('listBranches reports every sync state, and counts the commits of a branch that was never pushed', async () => {
  const branches = await listBranches(git, repo.work);
  assert.equal(branches[0]?.name, 'main');
  assert.equal(branches[0]?.current, true);
  assert.deepEqual(Object.fromEntries(branches.map((b) => [b.name, [b.sync, b.ahead, b.behind]])), {
    main: ['synced', 0, 0],
    ahead: ['ahead', 1, 0],
    behind: ['behind', 0, 1],
    diverged: ['diverged', 1, 1],
    gone: ['gone', 0, 0],
    wip: ['unpushed', 2, 0],
    review: ['remote', 0, 0],
  });
});

test('switchBranch checks out a local branch, and a remote-only one as a new tracking branch', async () => {
  const before = byName(await listBranches(git, repo.work));
  const wip = before.get('wip');
  const review = before.get('review');
  assert.ok(wip && review && !review.local);

  await switchBranch(git, repo.work, wip);
  assert.equal((await listBranches(git, repo.work))[0]?.name, 'wip');

  await switchBranch(git, repo.work, review);
  const after = await listBranches(git, repo.work);
  assert.deepEqual([after[0]?.name, after[0]?.local, after[0]?.upstream, after[0]?.sync], ['review', true, 'origin/review', 'synced']);
  assert.equal(after.filter((b) => b.name === 'review').length, 1);
  await repo.run('switch', 'main');
});

test('defaultBranch falls back to main when origin/HEAD is not set, and reads origin/HEAD when it is', async () => {
  assert.equal(await defaultBranch(git, repo.work), 'main');
  await repo.run('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/ahead');
  assert.equal(await defaultBranch(git, repo.work), 'ahead');
  await repo.run('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
});

test('lastFetchedAt is null before the first fetch and the time of FETCH_HEAD after it', async () => {
  const fresh = await makeRepo();
  try {
    assert.equal(await lastFetchedAt(git, fresh.work), null);
    await fresh.run('fetch');
    const at = await lastFetchedAt(git, fresh.work);
    assert.ok(at !== null && Math.abs(Date.now() - at) < 60_000);
  } finally {
    await fs.rm(fresh.dir, { recursive: true, force: true });
  }
});

test("a failing git command rejects with GitError and git's own message", async () => {
  await assert.rejects(repo.run('switch', 'no-such-branch'), (e: unknown) => {
    assert.ok(e instanceof GitError);
    assert.notEqual(e.exitCode, 0);
    assert.match(e.message, /no-such-branch/);
    return true;
  });
});

test('GitRunner passes environment for one call only, as config git reads', async () => {
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'githor.probe', GIT_CONFIG_VALUE_0: 'yes' };
  assert.equal((await git.run(repo.work, ['config', '--get', 'githor.probe'], { env })).trim(), 'yes');
  await assert.rejects(git.run(repo.work, ['config', '--get', 'githor.probe']));
});
