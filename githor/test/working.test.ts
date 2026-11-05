import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { listBranches } from '../src/core/branches';
import { commitFiles, commitsToPush, parseNumstat, parseStatus, readWorking, uncommit, workingDiff } from '../src/core/working';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

test('parseStatus reads changed, renamed, unmerged and untracked entries', () => {
  const out = [
    '1 .M N... 100644 100644 100644 a b src/core/x.ts',
    '1 A. N... 000000 100644 100644 0 b new file.ts',
    '2 R. N... 100644 100644 100644 a b R100 renamed.ts',
    'old.ts',
    'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
    '? notes.md',
    '',
  ].join('\0');
  assert.deepEqual(parseStatus(out).map((f) => [f.status, f.path, f.oldPath, f.conflicted]), [
    ['M', 'src/core/x.ts', null, false],
    ['A', 'new file.ts', null, false],
    ['R', 'renamed.ts', 'old.ts', false],
    ['M', 'conflict.ts', null, true],
    ['U', 'notes.md', null, false],
  ]);
});

test('parseNumstat files a rename under its new path, and a binary file with no counts', () => {
  const stats = parseNumstat(['3\t1\ta.ts', '0\t0\t', 'old.ts', 'new.ts', '-\t-\tlogo.png', ''].join('\0'));
  assert.deepEqual(Object.fromEntries(stats), { 'a.ts': { add: 3, del: 1, binary: false }, 'new.ts': { add: 0, del: 0, binary: false }, 'logo.png': { add: 0, del: 0, binary: true } });
});

let repo: TestRepo;
const write = (file: string, text: string): Promise<void> => fs.writeFile(path.join(repo.work, file), text);

before(async () => {
  repo = await makeRepo();
  await repo.commit('base', { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' });
  await repo.run('push');
});
after(() => fs.rm(repo.dir, { recursive: true, force: true }));

test('readWorking lists the changes with counts, and commitFiles commits only the chosen ones', async () => {
  await write('a.txt', 'one\nTWO\nthree\n');
  await write('b.txt', 'b changed\n');
  await repo.run('add', 'b.txt');
  await write('notes.md', 'todo\n');
  const working = await readWorking(git, repo.work);
  assert.deepEqual(working.map((f) => [f.status, f.path, f.add, f.del]), [
    ['M', 'a.txt', 2, 1],
    ['M', 'b.txt', 1, 1],
    ['U', 'notes.md', 0, 0],
  ]);

  // b.txt was staged, but it is not chosen: it stays out of the commit and stays staged
  const chosen = working.filter((f) => f.path !== 'b.txt');
  const { parent } = await commitFiles(git, repo.work, { files: chosen, message: 'feat: a and notes' });
  assert.deepEqual((await repo.run('show', '--name-only', '--format=', 'HEAD')).trim().split('\n'), ['a.txt', 'notes.md']);
  assert.deepEqual((await readWorking(git, repo.work)).map((f) => f.path), ['b.txt']);
  assert.equal((await repo.run('diff', '--cached', '--name-only')).trim(), 'b.txt');

  const branch = (await listBranches(git, repo.work)).find((b) => b.current);
  assert.ok(branch);
  assert.equal((await commitsToPush(git, repo.work, branch)).length, 1);

  await uncommit(git, repo.work, parent ?? '');
  assert.deepEqual((await readWorking(git, repo.work)).map((f) => [f.status, f.path]), [['M', 'a.txt'], ['M', 'b.txt'], ['A', 'notes.md']]);
});

test('workingDiff compares a tracked file with the last commit, and shows an untracked one as all added', async () => {
  const working = await readWorking(git, repo.work);
  const a = working.find((f) => f.path === 'a.txt');
  assert.ok(a);
  const diff = await workingDiff(git, repo.work, a);
  assert.deepEqual(diff.hunks[0]?.rows.map((r) => r.kind), ['same', 'change', 'add']);

  await write('fresh.txt', 'x\ny\n');
  const fresh = (await readWorking(git, repo.work)).find((f) => f.path === 'fresh.txt');
  assert.ok(fresh && fresh.status === 'U');
  const added = await workingDiff(git, repo.work, fresh);
  assert.deepEqual(added.hunks[0]?.rows.map((r) => [r.kind, r.right?.n]), [['add', 1], ['add', 2]]);
});

test('commitTree puts tracked files under Changes and untracked ones under Unversioned Files, grouped by directory on request', async () => {
  const { commitTree, nextTicked } = await import('../src/core/commit-groups');
  const f = (p: string, status: 'M' | 'A' | 'U', conflicted = false): Parameters<typeof commitTree>[0][number] => ({ path: p, oldPath: null, status, conflicted, add: 0, del: 0, binary: false });
  const files = [f('src/core/sort.ts', 'A'), f('media/a.css', 'M'), f('README.md', 'M'), f('docs/notes.md', 'U'), f('x.ts', 'M', true)];
  const ticked = nextTicked({ files, ticked: new Set(), known: new Set() });
  assert.deepEqual([...ticked], ['src/core/sort.ts', 'media/a.css', 'README.md']);

  const flat = commitTree(files, { grouping: 'none', ticked: new Set(['media/a.css']) });
  assert.deepEqual(flat.map((n) => (n.kind === 'file' ? `  ${n.file.path}` : `${n.label} ${n.tick}`)), ['Changes some', '  src/core/sort.ts', '  media/a.css', '  README.md', 'Unversioned Files none', '  docs/notes.md']);

  const tree = commitTree(files, { grouping: 'directory', ticked });
  assert.deepEqual(tree.map((n) => `${'.'.repeat(n.depth)}${n.kind === 'file' ? n.file.path : `${n.label} ${n.tick}`}`), [
    'Changes all',
    '.README.md',
    '.media all',
    '..media/a.css',
    '.src/core all',
    '..src/core/sort.ts',
    'Unversioned Files none',
    '.docs none',
    '..docs/notes.md',
  ]);

  // a file the person unticked stays unticked; a new tracked file comes ticked
  const later = nextTicked({ files: [...files, f('new.ts', 'M')], ticked: new Set(['README.md']), known: new Set(files.map((x) => x.path)) });
  assert.deepEqual([...later], ['README.md', 'new.ts']);
});
