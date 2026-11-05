import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { graphWidth, layoutGraph, reachable } from '../src/core/graph';
import { commitDetails, parseDecoration, readLog, userEmail } from '../src/core/log';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

test('parseDecoration joins a branch here and on its remote into one chip, and keeps tags', () => {
  assert.deepEqual(parseDecoration('HEAD -> main, origin/main, origin/HEAD, tag: v1.0, feat/x', ['origin']), [
    { name: 'main', kind: 'branch', local: true, remote: true, head: true },
    { name: 'feat/x', kind: 'branch', local: true, remote: false, head: false },
    { name: 'v1.0', kind: 'tag', local: true, remote: false, head: false },
  ]);
  assert.deepEqual(parseDecoration('origin/review', ['origin']), [{ name: 'review', kind: 'branch', local: false, remote: true, head: false }]);
  assert.deepEqual(parseDecoration('HEAD', ['origin']), []);
});

test('layoutGraph keeps a straight line, branches off and merges back', () => {
  // m3 merges f1 into m2; f1 and m2 both come from m1
  const rows = layoutGraph([
    { sha: 'm3', parents: ['m2', 'f1'] },
    { sha: 'f1', parents: ['m1'] },
    { sha: 'm2', parents: ['m1'] },
    { sha: 'm1', parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 0]);
  // the merge sends lines to both parents' lanes
  assert.deepEqual(rows[0]?.down.map((l) => [l.from, l.to]), [[0, 0], [0, 1]]);
  // f1 leads to m1 in its own lane; at m2, m1 moves over to the main lane and f1's line bends into it
  assert.deepEqual(rows[1]?.down.map((l) => [l.from, l.to]), [[1, 1], [0, 0]]);
  assert.deepEqual(rows[2]?.down.map((l) => [l.from, l.to]), [[0, 0], [1, 0]]);
  assert.deepEqual(rows[3]?.up.map((l) => [l.from, l.to]), [[0, 0]]);
  assert.equal(graphWidth(rows), 2);
  // colours: the main line keeps one colour, the side branch gets its own
  assert.notEqual(rows[1]?.color, rows[0]?.color);
  assert.equal(rows[2]?.color, rows[0]?.color);
});

test('layoutGraph gives a second tip its own lane and reuses a freed one', () => {
  const rows = layoutGraph([
    { sha: 'a2', parents: ['a1'] },
    { sha: 'b1', parents: ['root'] },
    { sha: 'a1', parents: ['root'] },
    { sha: 'root', parents: [] },
    { sha: 'other', parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 0, 0]);
  // a tip has no line coming from above it: b1 only sees a2's lane passing
  assert.deepEqual(rows[1]?.up.map((l) => [l.from, l.to]), [[0, 0]]);
  assert.deepEqual(rows[0]?.up, []);
});

test('reachable follows parents among the loaded commits', () => {
  const commits = [
    { sha: 'm3', parents: ['m2', 'f1'] },
    { sha: 'x', parents: ['m2'] },
    { sha: 'f1', parents: ['m1'] },
    { sha: 'm2', parents: ['m1'] },
    { sha: 'm1', parents: ['outside'] },
  ];
  assert.deepEqual([...reachable(commits, 'f1')].sort(), ['f1', 'm1']);
  assert.deepEqual([...reachable(commits, 'm3')].sort(), ['f1', 'm1', 'm2', 'm3']);
});

let repo: TestRepo;
before(async () => {
  repo = await makeRepo();
  await repo.run('switch', '-c', 'feat/x');
  await repo.commit('feat: add a and b', { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' });
  await repo.commit('feat: rename and change', { 'a.txt': 'one\n' });
  await repo.run('mv', 'b.txt', 'c.txt');
  await repo.run('commit', '-m', 'refactor: rename b', '-m', 'Because c reads better.');
  await repo.run('tag', 'v0.1.0');
  await repo.run('switch', 'main');
  await repo.run('config', 'user.email', 'me@example.com');
});
after(() => fs.rm(repo.dir, { recursive: true, force: true }));

test('readLog lists every branch with its refs, newest first, and says when there are more', async () => {
  const { commits, hasMore } = await readLog({ git, root: repo.work, limit: 3 });
  assert.equal(hasMore, true);
  assert.deepEqual(commits.map((c) => c.subject), ['refactor: rename b', 'feat: rename and change', 'feat: add a and b']);
  assert.deepEqual(commits[0]?.refs.map((r) => [r.name, r.kind, r.local]), [['feat/x', 'branch', true], ['v0.1.0', 'tag', true]]);
  const all = await readLog({ git, root: repo.work, limit: 10 });
  const first = all.commits.at(-1);
  assert.deepEqual([first?.subject, first?.parents, all.hasMore], ['first', [], false]);
  assert.deepEqual(first?.refs.map((r) => [r.name, r.local, r.remote, r.head]), [['main', true, true, true]]);
});

test('commitDetails gives the message and the files against the first parent, renames included', async () => {
  const { commits } = await readLog({ git, root: repo.work, limit: 10 });
  const rename = await commitDetails(git, repo.work, commits[0]?.sha ?? '');
  assert.equal(rename.body, 'Because c reads better.');
  assert.deepEqual(rename.files.map((f) => [f.status, f.path, f.oldPath]), [['R', 'c.txt', 'b.txt']]);
  const add = await commitDetails(git, repo.work, commits[2]?.sha ?? '');
  assert.deepEqual(add.files.map((f) => [f.status, f.path, f.add, f.del]), [['A', 'a.txt', 2, 0], ['A', 'b.txt', 1, 0]]);
  const first = await commitDetails(git, repo.work, commits.at(-1)?.sha ?? '');
  assert.deepEqual([first.parent, first.files.map((f) => f.path)], [null, ['README.md']]);
  assert.equal(await userEmail(git, repo.work), 'me@example.com');
});

test('cherryPick applies commits oldest first and returns the old tip for Undo; resetTo undoes it', async () => {
  const { cherryPick, resetTo } = await import('../src/core/commit-ops');
  const { commits } = await readLog({ git, root: repo.work, limit: 10 });
  const picked = commits.filter((c) => c.subject.startsWith('feat:')).map((c) => c.sha);
  const before = await cherryPick(git, repo.work, picked);
  const subjects = (await repo.run('log', '--format=%s', '-3')).trim().split('\n');
  assert.deepEqual(subjects, ['feat: rename and change', 'feat: add a and b', 'first']);
  await resetTo(git, repo.work, before);
  assert.equal((await repo.run('log', '--format=%s', '-1')).trim(), 'first');
});

test('a cherry-pick or revert that conflicts is aborted, leaving the branch as it was', async () => {
  const { ConflictError, cherryPick, revertCommit } = await import('../src/core/commit-ops');
  await repo.commit('main edits a', { 'a.txt': 'something else\n' });
  const tip = (await repo.run('rev-parse', 'HEAD')).trim();
  const { commits } = await readLog({ git, root: repo.work, limit: 10 });
  const change = commits.find((c) => c.subject === 'feat: rename and change')?.sha ?? '';
  await assert.rejects(cherryPick(git, repo.work, [change]), (e: unknown) => e instanceof ConflictError && e.files.includes('a.txt'));
  assert.equal((await repo.run('rev-parse', 'HEAD')).trim(), tip);
  assert.equal((await repo.run('status', '--porcelain')).trim(), '');

  const reverted = await revertCommit(git, repo.work, tip);
  assert.equal(reverted, tip);
  assert.match((await repo.run('log', '--format=%s', '-1')).trim(), /^Revert "main edits a"/);
});
