import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { listBranches } from '../src/core/branches';
import { compareWithRemote } from '../src/core/compare';
import { applyResolutions, parseConflicts } from '../src/core/conflict';
import { abortOperation, bringTogether, continueOperation, readConflict, readOperation, reopenConflict, resolveFile } from '../src/core/operation';
import type { Branch, RepoRoot } from '../src/core/types';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

test('parseConflicts puts your side on the left: the first marker side in a merge, the second in a rebase', () => {
  const text = ['a', '<<<<<<< HEAD', 'mine', '||||||| base', 'old', '=======', 'theirs', '>>>>>>> other', 'z'].join('\n');
  const merge = parseConflicts(text, { localIsFirst: true });
  assert.deepEqual(merge, [
    { kind: 'common', lines: ['a'] },
    { kind: 'conflict', line: 2, local: ['mine'], remote: ['theirs'] },
    { kind: 'common', lines: ['z'] },
  ]);
  assert.deepEqual(parseConflicts(text, { localIsFirst: false })[1], { kind: 'conflict', line: 2, local: ['theirs'], remote: ['mine'] });
  assert.equal(applyResolutions(merge, [{ take: 'both' }]), 'a\nmine\ntheirs\nz');
  assert.equal(applyResolutions(merge, [{ take: 'edit', text: 'one\ntwo' }]), 'a\none\ntwo\nz');
  assert.throws(() => applyResolutions(merge, []), /no choice/);
});

let repo: TestRepo;
let other: RepoRoot;
const branch = async (name: string): Promise<Branch> => {
  const b = (await listBranches(git, repo.work)).find((x) => x.name === name && x.local);
  assert.ok(b);
  return b;
};
const read = (file: string): Promise<string> => fs.readFile(path.join(repo.work, file), 'utf8');

/** main on origin and here both changed line 2 of fetch.ts; a test file changed only on origin. */
async function diverge(): Promise<void> {
  await git.run(other, ['pull', '--quiet']);
  await fs.writeFile(path.join(other, 'fetch.ts'), 'line one\nremote change\nline three\n');
  await fs.writeFile(path.join(other, 'fetch.test.ts'), 'test\n');
  await git.run(other, ['add', '.']);
  await git.run(other, ['commit', '-m', 'remote: change fetch', '--author', 'Marek <m@example.com>']);
  await git.run(other, ['push', '--quiet']);
  await repo.commit('local: change fetch', { 'fetch.ts': 'line one\nlocal change\nline three\n' });
  await repo.run('fetch', '--quiet');
}

before(async () => {
  repo = await makeRepo();
  await repo.commit('base', { 'fetch.ts': 'line one\nline two\nline three\n' });
  await repo.run('push', '--quiet');
  other = path.join(repo.dir, 'other') as RepoRoot;
  await git.run(repo.dir as RepoRoot, ['clone', '--quiet', repo.remote, other]);
});
after(() => fs.rm(repo.dir, { recursive: true, force: true }));

test('compareWithRemote lists each side, the start point, and the file that will conflict', async () => {
  await diverge();
  const cmp = await compareWithRemote(git, repo.work, await branch('main'));
  assert.deepEqual(cmp.local.map((c) => c.subject), ['local: change fetch']);
  assert.deepEqual(cmp.remote.map((c) => [c.subject, c.author]), [['remote: change fetch', 'Marek']]);
  assert.equal(cmp.base?.subject, 'base');
  assert.deepEqual(cmp.conflicts, ['fetch.ts']);
});

test('a merge pauses at the conflict with your branch on the left; resolving and Continue make the merge commit', async () => {
  assert.deepEqual(await bringTogether(git, repo.work, { how: 'merge', other: 'origin/main' }), { paused: true });
  const op = await readOperation(git, repo.work);
  assert.deepEqual(op, { kind: 'merge', local: 'main', remote: 'origin/main', conflicted: ['fetch.ts'], staged: ['fetch.test.ts'] });

  const parts = await readConflict(git, repo.work, { file: 'fetch.ts', kind: 'merge' });
  assert.deepEqual(parts.filter((p) => p.kind === 'conflict').map((p) => p.kind === 'conflict' && [p.local, p.remote]), [[['local change'], ['remote change']]]);

  await resolveFile(git, repo.work, { file: 'fetch.ts', kind: 'merge', resolutions: [{ take: 'remote' }] });
  assert.equal(await read('fetch.ts'), 'line one\nremote change\nline three\n');
  assert.deepEqual((await readOperation(git, repo.work))?.conflicted, []);

  // Change: back to the conflict, then choose again
  await reopenConflict(git, repo.work, 'fetch.ts');
  assert.deepEqual((await readOperation(git, repo.work))?.conflicted, ['fetch.ts']);
  await resolveFile(git, repo.work, { file: 'fetch.ts', kind: 'merge', resolutions: [{ take: 'both' }] });
  assert.equal(await read('fetch.ts'), 'line one\nlocal change\nremote change\nline three\n');

  assert.deepEqual(await continueOperation(git, repo.work, 'merge'), { paused: false });
  assert.equal(await readOperation(git, repo.work), null);
  assert.equal((await repo.run('rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ').length, 3);
});

test('in a rebase the left side is still your commit, and Abort puts the branch back', async () => {
  await repo.run('reset', '--hard', '--quiet', 'HEAD~1');
  const before = (await repo.run('rev-parse', 'HEAD')).trim();
  assert.deepEqual(await bringTogether(git, repo.work, { how: 'rebase', other: 'origin/main' }), { paused: true });
  const op = await readOperation(git, repo.work);
  assert.deepEqual([op?.kind, op?.local, op?.remote, op?.conflicted], ['rebase', 'main', 'origin/main', ['fetch.ts']]);

  const parts = await readConflict(git, repo.work, { file: 'fetch.ts', kind: 'rebase' });
  const region = parts.find((p) => p.kind === 'conflict');
  assert.ok(region && region.kind === 'conflict');
  // git's `<<<<<<<` side is origin/main here; the screens still show your commit's line on the left
  assert.deepEqual([region.local, region.remote], [['local change'], ['remote change']]);

  await abortOperation(git, repo.work, 'rebase');
  assert.equal(await readOperation(git, repo.work), null);
  assert.equal((await repo.run('rev-parse', 'HEAD')).trim(), before);
});
