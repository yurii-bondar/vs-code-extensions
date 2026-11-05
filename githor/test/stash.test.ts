import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { applyStash, dropStash, listStashes, parseStashSubject, renameStash, restoreStash, stashCount, stashFileDiff, stashPush } from '../src/core/stash';
import { readWorking } from '../src/core/working';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

test('parseStashSubject reads a named stash and git\'s WIP one', () => {
  assert.deepEqual(parseStashSubject('On fix/fetch-timeout: WIP: fetch retry'), { branch: 'fix/fetch-timeout', message: 'WIP: fetch retry' });
  assert.deepEqual(parseStashSubject('WIP on main: 1a2b3c4 feat: sort'), { branch: 'main', message: 'WIP: feat: sort' });
});

let repo: TestRepo;
const write = (file: string, text: string): Promise<void> => fs.writeFile(path.join(repo.work, file), text);
before(async () => {
  repo = await makeRepo();
  await repo.commit('base', { 'a.ts': 'one\n', 'b.ts': 'b\n' });
});
after(() => fs.rm(repo.dir, { recursive: true, force: true }));

test('stashPush stashes only the chosen files, untracked ones on request, and listStashes shows them', async () => {
  await write('a.ts', 'one\ntwo\n');
  await write('b.ts', 'B\n');
  await write('new.ts', 'n\n');
  const sha = await stashPush(git, repo.work, { message: 'try a and new', paths: ['a.ts', 'new.ts'], includeUntracked: true });
  assert.ok(sha);
  assert.deepEqual((await readWorking(git, repo.work)).map((f) => f.path), ['b.ts']);
  const [stash] = await listStashes(git, repo.work);
  assert.deepEqual([stash?.message, stash?.branch, stash?.files.map((f) => [f.status, f.path])], ['try a and new', 'main', [['M', 'a.ts'], ['A', 'new.ts']]]);
  assert.equal(await stashCount(git, repo.work), 1);
  // nothing left to stash: null, and no new stash
  await repo.run('checkout', '--', 'b.ts');
  assert.equal(await stashPush(git, repo.work, { message: 'empty', paths: null, includeUntracked: false }), null);
});

test('a stashed file opens side by side, a tracked one against its commit and an untracked one against nothing', async () => {
  const [stash] = await listStashes(git, repo.work);
  assert.ok(stash);
  const a = await stashFileDiff(git, repo.work, { sha: stash.sha, file: stash.files[0] as (typeof stash.files)[number] });
  assert.deepEqual(a.hunks[0]?.rows.map((r) => r.kind), ['same', 'add']);
  const n = await stashFileDiff(git, repo.work, { sha: stash.sha, file: stash.files[1] as (typeof stash.files)[number] });
  assert.deepEqual([n.sha, n.hunks[0]?.rows.map((r) => r.kind)], [stash.sha, ['add']]);
});

test('Apply keeps the stash; Rename keeps its changes; Delete is undone by storing it again', async () => {
  const [stash] = await listStashes(git, repo.work);
  assert.ok(stash);
  await applyStash(git, repo.work, stash.sha);
  assert.deepEqual((await readWorking(git, repo.work)).map((f) => f.path).sort(), ['a.ts', 'new.ts']);
  assert.equal(await stashCount(git, repo.work), 1);

  await renameStash(git, repo.work, { sha: stash.sha, message: 'renamed' });
  const [renamed] = await listStashes(git, repo.work);
  assert.deepEqual([renamed?.sha, renamed?.message, renamed?.branch], [stash.sha, 'renamed', 'main']);

  const dropped = await dropStash(git, repo.work, stash.sha);
  assert.equal(await stashCount(git, repo.work), 0);
  await restoreStash(git, repo.work, dropped);
  const [back] = await listStashes(git, repo.work);
  assert.deepEqual([back?.sha, back?.message], [stash.sha, 'renamed']);
});
