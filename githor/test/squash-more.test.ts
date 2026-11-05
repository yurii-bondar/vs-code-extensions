import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { squash, squashPlan } from '../src/core/squash';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

let repo: TestRepo;
const repos: TestRepo[] = [];
const fresh = async (): Promise<TestRepo> => {
  repo = await makeRepo();
  repos.push(repo);
  return repo;
};
afterEach(async () => {
  for (const r of repos.splice(0)) await fs.rm(r.dir, { recursive: true, force: true });
});

const shaOf = async (subject: string, ref = '--all'): Promise<string> => (await repo.run('log', '--format=%H', `--grep=^${subject}$`, '-1', ref)).trim();
const subjects = async (ref: string, n: number): Promise<string[]> => (await repo.run('log', '--format=%s', '--first-parent', `-${n}`, ref)).trim().split('\n');
const current = async (): Promise<string> => (await repo.run('branch', '--show-current')).trim();
const plan = async (names: string[], branch: string | null): ReturnType<typeof squashPlan> => squashPlan({ git, root: repo.work, shas: await Promise.all(names.map((n) => shaOf(n))), branch, defaultBranch: 'main' });

test('a merge commit among the squashed ones is squashed with them, and a merge after them is kept', async () => {
  await fresh();
  await repo.run('switch', '-c', 'feat');
  await repo.commit('a', { 'a.ts': '1\n' });
  await repo.run('switch', '-c', 'side');
  await repo.commit('s', { 's.ts': 's\n' });
  await repo.run('switch', 'feat');
  await repo.run('merge', '--no-ff', '-m', 'merge side', 'side');
  await repo.commit('b', { 'b.ts': '1\n' });
  await repo.run('switch', '-c', 'other', 'feat~1');
  await repo.commit('o', { 'o.ts': 'o\n' });
  await repo.run('switch', 'feat');
  await repo.run('merge', '--no-ff', '-m', 'merge other', 'other');
  const tree = (await repo.run('rev-parse', 'HEAD^{tree}')).trim();

  const p = await plan(['a', 'merge side'], 'feat');
  assert.equal(p.problem, null);
  assert.equal(p.after, 2);
  await squash(git, repo.work, { plan: p, message: 'a with side' });
  assert.deepEqual(await subjects('HEAD', 3), ['merge other', 'b', 'a with side']);
  // the merge after the squashed commits is still a merge, and the content at the tip is the same
  assert.equal((await repo.run('rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ').length, 3);
  assert.equal((await repo.run('rev-parse', 'HEAD^{tree}')).trim(), tree);
});

test('the first commit of the repository can be squashed: the result has no parent', async () => {
  await fresh();
  await repo.run('switch', '-c', 'feat');
  await repo.commit('one', { 'one.ts': '1\n' });
  await repo.commit('two', { 'two.ts': '2\n' });
  const p = await plan(['first', 'one'], 'feat');
  assert.equal(p.problem, null);
  assert.deepEqual([p.base, p.after], [null, 1]);
  assert.deepEqual(p.files.map((f) => [f.status, f.path]).sort(), [['A', 'README.md'], ['A', 'one.ts']]);
  // the first commit is on origin already: the squash says a force-push follows
  assert.ok(p.pushed.length > 0);
  await squash(git, repo.work, { plan: p, message: 'start' });
  assert.deepEqual(await subjects('HEAD', 5), ['two', 'start']);
  const root = (await repo.run('rev-list', '--max-parents=0', 'HEAD')).trim();
  assert.equal((await repo.run('log', '--format=%s', '-1', root)).trim(), 'start');
});

test('commits of a branch that is not checked out: its tip moves without switching when they end it', async () => {
  await fresh();
  await repo.run('switch', '-c', 'side');
  await repo.commit('s1', { 's.ts': '1\n' });
  await repo.commit('s2', { 's.ts': '2\n' });
  await repo.run('switch', 'main');
  await repo.commit('m1');
  const p = await plan(['s1', 's2'], 'main');
  assert.deepEqual([p.problem, p.branch, p.switchFirst, p.after], [null, 'side', false, 0]);
  const { oldHead, movedRef } = await squash(git, repo.work, { plan: p, message: 's1 and s2' });
  assert.equal(movedRef, 'refs/heads/side');
  assert.equal(await current(), 'main');
  assert.deepEqual(await subjects('side', 2), ['s1 and s2', 'first']);
  // Undo moves the ref back
  await repo.run('update-ref', 'refs/heads/side', oldHead);
  assert.deepEqual(await subjects('side', 2), ['s2', 's1']);
});

test('commits of a branch that is not checked out, with commits after them: it is switched to first', async () => {
  await fresh();
  await repo.run('switch', '-c', 'side');
  await repo.commit('s1', { 's.ts': '1\n' });
  await repo.commit('s2', { 's.ts': '2\n' });
  await repo.commit('s3', { 't.ts': '3\n' });
  await repo.run('switch', 'main');
  const p = await plan(['s1', 's2'], 'main');
  assert.deepEqual([p.problem, p.branch, p.switchFirst, p.after], [null, 'side', true, 1]);
  await squash(git, repo.work, { plan: p, message: 's1 and s2' });
  assert.equal(await current(), 'side');
  assert.deepEqual(await subjects('side', 3), ['s3', 's1 and s2', 'first']);
});

test("commits on no branch's own line, such as a deleted branch's, say why they cannot be squashed", async () => {
  await fresh();
  await repo.run('switch', '-c', 'gone');
  await repo.commit('g1', { 'g.ts': '1\n' });
  await repo.commit('g2', { 'g.ts': '2\n' });
  await repo.run('switch', 'main');
  await repo.run('merge', '--no-ff', '-m', 'merge gone', 'gone');
  await repo.run('branch', '-D', 'gone');
  assert.match((await plan(['g1', 'g2'], 'main')).problem ?? '', /not on one branch's own line/);
});

test('a branch checked out in another worktree is left to be squashed there', async () => {
  await fresh();
  await repo.run('switch', '-c', 'side');
  await repo.commit('s1');
  await repo.commit('s2');
  await repo.run('switch', 'main');
  await repo.run('worktree', 'add', `${repo.dir}/wt`, 'side');
  assert.match((await plan(['s1', 's2'], 'main')).problem ?? '', /checked out in .*wt/);
});
