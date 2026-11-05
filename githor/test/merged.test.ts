import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { deleteBranches, restoreBranches } from '../src/core/cleanup';
import { baseGoesFurther, countTokens, scanMerged } from '../src/core/merged';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

let repo: TestRepo;

/**
 * One repository with a branch for every way of being merged, and some that are not:
 *   regular    merged with a merge commit
 *   squashed   squash-merged
 *   rebased    its commits cherry-picked onto main
 *   draft      an early form of a change main holds reworked (conflicts, but main goes further)
 *   pushed     merged, and its copy on origin too
 *   ahead-on-origin  merged locally, but origin's copy has a commit more
 *   open       a commit main does not have
 *   elsewhere  merged, checked out in another worktree
 *   tasked     merged, made by an unfinished Claudestrator task
 *   current    merged, and checked out
 */
before(async () => {
  repo = await makeRepo();
  const { run, commit } = repo;
  const branch = async (name: string, files: Record<string, string>): Promise<void> => {
    await run('switch', '-c', name, 'main');
    await commit(`${name} work`, files);
    await run('switch', 'main');
  };

  await branch('regular', { 'regular.txt': 'r\n' });
  await run('merge', '--no-ff', '-m', 'merge regular', 'regular');

  await branch('squashed', { 'squashed.txt': 'one\n' });
  await run('switch', 'squashed');
  await commit('squashed more', { 'squashed.txt': 'one\ntwo\n' });
  await run('switch', 'main');
  await run('merge', '--squash', 'squashed');
  await commit('squash of squashed');

  await branch('rebased', { 'rebased.txt': 'b\n' });
  await run('cherry-pick', 'rebased');

  await commit('call site', { 'app.js': 'call();\n' });
  await branch('draft', { 'app.js': 'call(alpha);\n' });
  await commit('reworked call', { 'app.js': 'call(alpha, beta);\n' });

  await branch('pushed', { 'pushed.txt': 'p\n' });
  await run('push', '-u', 'origin', 'pushed');
  await branch('ahead-on-origin', { 'aoo.txt': 'a\n' });
  await run('push', '-u', 'origin', 'ahead-on-origin');
  await run('switch', 'ahead-on-origin');
  await commit('only on origin', { 'aoo.txt': 'a\nb\n' });
  await run('push');
  await run('reset', '--hard', 'HEAD~1');
  await run('switch', 'main');
  await run('merge', '--no-ff', '-m', 'merge pushed and aoo', 'pushed', 'ahead-on-origin');

  await branch('open', { 'open.txt': 'o\n' });

  await run('branch', 'elsewhere', 'main');
  await run('worktree', 'add', path.join(repo.dir, 'elsewhere-wt'), 'elsewhere');

  await run('branch', 'tasked', 'main');
  await run('config', 'branch.tasked.claudestratorTask', 't1');
  await fs.mkdir(path.join(repo.work, '.orch', 'tasks', 't1'), { recursive: true });
  await fs.writeFile(path.join(repo.work, '.orch', 'tasks', 't1', 'events.ndjson'), '{"type":"created"}\n');

  await run('branch', 'current', 'main');
  await run('push', 'origin', 'main');
  await run('switch', 'current');
});

after(() => fs.rm(repo.dir, { recursive: true, force: true }));

const scan = (): ReturnType<typeof scanMerged> => scanMerged({ git, root: repo.work, target: 'main', current: 'current', taskDirs: [repo.work] });

test('scanMerged finds regular, squash, rebase and superseded merges, and nothing with work of its own', async () => {
  const { merged } = await scan();
  assert.deepEqual(merged.map((b) => b.name).sort(), ['ahead-on-origin', 'draft', 'pushed', 'rebased', 'regular', 'squashed']);
});

test('scanMerged keeps a branch in another worktree and one of an unfinished task, and says why', async () => {
  const { kept } = await scan();
  const reasons = Object.fromEntries(kept.map((k) => [k.name, k.reason]));
  assert.match(reasons['elsewhere'] ?? '', /checked out in .*elsewhere-wt/);
  assert.equal(reasons['tasked'], 'Claudestrator task t1 is not finished');
});

test('a task that published no longer guards its branch', async () => {
  await fs.appendFile(path.join(repo.work, '.orch', 'tasks', 't1', 'events.ndjson'), '{"type":"published"}\n');
  try {
    assert.ok((await scan()).merged.some((b) => b.name === 'tasked'));
  } finally {
    await fs.writeFile(path.join(repo.work, '.orch', 'tasks', 't1', 'events.ndjson'), '{"type":"created"}\n');
  }
});

test('the copy on origin counts only when it is merged too', async () => {
  const merged = new Map((await scan()).merged.map((b) => [b.name, b]));
  assert.equal(merged.get('pushed')?.upstreamMerged, true);
  assert.equal(merged.get('ahead-on-origin')?.upstreamMerged, false);
  assert.equal(merged.get('regular')?.upstreamMerged, false);
});

test('deleteBranches deletes locally and on origin, and restoreBranches brings the local ones back', async () => {
  const { merged } = await scan();
  const chosen = merged.filter((b) => b.name === 'pushed' || b.name === 'ahead-on-origin' || b.name === 'regular');
  const result = await deleteBranches(git, repo.work, { branches: chosen, onRemote: true });
  assert.deepEqual(result.deleted.map((b) => b.name).sort(), ['ahead-on-origin', 'pushed', 'regular']);
  // origin's ahead-on-origin has a commit more, so it stays
  assert.deepEqual(result.deletedOnRemote, ['origin/pushed']);
  assert.deepEqual(result.failed, []);
  const heads = async (): Promise<string[]> => (await repo.run('for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin')).split('\n').filter(Boolean);
  assert.ok(!(await heads()).includes('pushed') && !(await heads()).includes('origin/pushed'));

  assert.deepEqual(await restoreBranches(git, repo.work, result.deleted), []);
  const restored = await repo.run('for-each-ref', '--format=%(refname:short) %(upstream:short)', 'refs/heads/ahead-on-origin', 'refs/heads/regular');
  assert.deepEqual(restored.split('\n').filter(Boolean).map((l) => l.trimEnd()), ['ahead-on-origin origin/ahead-on-origin', 'regular']);
});

test('countTokens leaves out the version of a package.json, and baseGoesFurther compares what each side changed', () => {
  assert.equal(countTokens('{\n  "version": "1.2.3",\n  "name": "x"\n}', 'package.json').has('"1.2.3"'), false);
  const counts = (text: string): Map<string, number> => countTokens(text, 'app.js');
  const mergeBase = counts('call();');
  assert.equal(baseGoesFurther({ mergeBase, branch: counts('call(alpha);'), base: counts('call(alpha, beta);') }), true);
  assert.equal(baseGoesFurther({ mergeBase, branch: counts('call(gamma);'), base: counts('call(alpha, beta);') }), false);
});

test('mergeTargets offers the default branch, then long-lived branches, then the current one', async () => {
  const { mergeTargets } = await import('../src/core/merged');
  const b = (name: string, current = false): Parameters<typeof mergeTargets>[0][number] => ({ name, ref: `refs/heads/${name}`, current, pinned: false, local: true, upstream: null, sync: 'unpushed', ahead: 0, behind: 0, sha: 's', committedAt: 0 });
  assert.deepEqual(mergeTargets([b('feat/x', true), b('develop'), b('release/2.3'), b('main'), b('fix/y')], 'main'), ['main', 'develop', 'release/2.3', 'feat/x']);
  assert.deepEqual(mergeTargets([b('main', true)], 'main'), ['main']);
});
