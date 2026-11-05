import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { abortOperation, readConflict, readOperation } from '../src/core/operation';
import { readSquashMarker, squash, squashPlan } from '../src/core/squash';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

let repo: TestRepo;
const shaOf = async (subject: string): Promise<string> => (await repo.run('log', '--format=%H', `--grep=^${subject}$`, '-1')).trim();
const subjects = async (n: number): Promise<string[]> => (await repo.run('log', '--format=%s', `-${n}`)).trim().split('\n');
const plan = async (names: string[], branch = 'feat'): ReturnType<typeof squashPlan> => squashPlan({ git, root: repo.work, shas: await Promise.all(names.map(shaOf)), branch, defaultBranch: 'main' });

before(async () => {
  repo = await makeRepo();
  await repo.run('switch', '-c', 'feat');
  await repo.commit('one', { 's.ts': 'a\nb\nc\n' });
  await repo.commit('two', { 's.ts': 'a\nB\nc\n' });
  await repo.commit('three', { 's.ts': 'a\nB\nC\n' });
  await repo.commit('four', { 't.ts': 'x\n' });
});
after(() => fs.rm(repo.dir, { recursive: true, force: true }));

test('squashPlan finds the base and the result files, and says what stops a squash', async () => {
  const ok = await plan(['three', 'four']);
  assert.equal(ok.problem, null);
  assert.deepEqual([ok.commits.map((c) => c.subject), ok.after, ok.pushed], [['four', 'three'], 0, []]);
  assert.equal(ok.base, await shaOf('two'));
  assert.deepEqual(ok.files.map((f) => f.path).sort(), ['s.ts', 't.ts']);

  const gap = await plan(['two', 'four']);
  assert.match(gap.problem ?? '', /sits between these/);
  assert.equal(gap.gap.length, 1);
  assert.match((await plan(['two', 'three'], 'main')).problem ?? '', /Squash is off on main/);
  assert.match((await plan(['four'])).problem ?? '', /two or more/);
});

test('a squash of the newest commits makes one commit with their changes and touches no file', async () => {
  const before = (await repo.run('rev-parse', 'HEAD^{tree}')).trim();
  const { oldHead, paused } = await squash(git, repo.work, { plan: await plan(['three', 'four']), message: 'three and four' });
  assert.equal(paused, false);
  assert.deepEqual(await subjects(3), ['three and four', 'two', 'one']);
  assert.equal((await repo.run('rev-parse', 'HEAD^{tree}')).trim(), before);
  assert.equal((await repo.run('status', '--porcelain')).trim(), '');
  // Undo: back to the old tip
  await repo.run('reset', '--keep', oldHead);
  assert.deepEqual(await subjects(2), ['four', 'three']);
});

test('squashing older commits puts the later ones back on top, and the content at HEAD stays the same', async () => {
  const before = (await repo.run('rev-parse', 'HEAD^{tree}')).trim();
  // the squashed commit has the newest selected commit's tree, so the later ones apply to the very same content
  await squash(git, repo.work, { plan: await plan(['one', 'two']), message: 'one and two' });
  assert.deepEqual(await subjects(3), ['four', 'three', 'one and two']);
  assert.equal((await repo.run('rev-parse', 'HEAD^{tree}')).trim(), before);
  assert.equal(await readSquashMarker(git, repo.work), null);
});

test('a paused squash shows the squashed result on the left and the commit being put back on the right; Abort clears it', async () => {
  // a rebase that stops at a conflict, marked as a squash's second half, as squash() does when one happens
  await repo.run('switch', '-c', 'clash', 'main');
  await repo.commit('c1', { 'v.ts': '1\n' });
  await repo.commit('c2', { 'v.ts': '2\n' });
  await repo.commit('c3', { 'v.ts': '3\n' });
  const tip = (await repo.run('rev-parse', 'HEAD')).trim();
  const c3 = (await shaOf('c3')).slice(0, 7);
  const marker = (await repo.run('rev-parse', '--git-path', 'githor-squash.json')).trim();
  await fs.writeFile(`${repo.work}/${marker}`, JSON.stringify({ oldHead: tip, count: 2 }));
  await assert.rejects(repo.run('-c', 'core.editor=true', 'rebase', '--onto', await shaOf('c1'), await shaOf('c2')));

  const op = await readOperation(git, repo.work);
  assert.deepEqual([op?.kind, op?.local, op?.remote, op?.conflicted], ['squash', 'squashed commits', c3, ['v.ts']]);
  const [part] = (await readConflict(git, repo.work, { file: 'v.ts', kind: 'squash' })).filter((x) => x.kind === 'conflict');
  assert.deepEqual(part && part.kind === 'conflict' && [part.local, part.remote], [['1'], ['3']]);

  await abortOperation(git, repo.work, 'squash');
  assert.equal((await repo.run('rev-parse', 'HEAD')).trim(), tip);
  assert.equal(await readSquashMarker(git, repo.work), null);
  assert.equal(await readOperation(git, repo.work), null);
});
