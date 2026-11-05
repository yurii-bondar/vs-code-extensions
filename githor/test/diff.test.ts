import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { fileDiff } from '../src/core/file-diff';
import { commitDetails, readLog } from '../src/core/log';
import { parseHunks, sideBySide, wordDiff } from '../src/core/side-by-side';
import type { DiffSegment } from '../src/core/types';
import { git, makeRepo } from './repo';
import type { TestRepo } from './repo';

const marked = (segs: readonly DiffSegment[]): string[] => segs.filter((s) => s.changed).map((s) => s.text);

const DIFF = `diff --git a/s.ts b/s.ts
index 1..2 100644
--- a/s.ts
+++ b/s.ts
@@ -21,6 +21,7 @@ export function syncLabel(state: SyncState): string
   switch (state.kind) {
     case 'synced':
-      return 'Up to date';
+      return 'In sync';
     case 'gone':
-      // the upstream branch was removed
-      return 'gone';
+      return 'deleted on remote';
+      // and more
   }
\\ No newline at end of file
@@ -48,2 +49,3 @@
   if (a) return 'push';
+  if (b) return 'compare';
   return null;
`;

test('parseHunks reads the hunks and their starts, and skips the file header', () => {
  const hunks = parseHunks(DIFF);
  assert.deepEqual(hunks.map((h) => [h.oldStart, h.newStart, h.lines.length]), [[21, 21, 10], [48, 49, 3]]);
});

test('sideBySide pairs removed with added lines, numbers both sides, and leaves the rest across from nothing', () => {
  const [first, second] = sideBySide(DIFF);
  assert.deepEqual(first?.rows.map((r) => [r.kind, r.left?.n ?? null, r.right?.n ?? null]), [
    ['same', 21, 21],
    ['same', 22, 22],
    ['change', 23, 23],
    ['same', 24, 24],
    ['change', 25, 25],
    ['change', 26, 26],
    ['same', 27, 27],
  ]);
  assert.deepEqual(second?.rows.map((r) => [r.kind, r.left?.n ?? null, r.right?.n ?? null]), [
    ['same', 48, 49],
    ['add', null, 50],
    ['same', 49, 51],
  ]);
});

test('wordDiff marks only the words that changed', () => {
  const { left, right } = wordDiff("      return 'Up to date';", "      return 'In sync';");
  assert.deepEqual(marked(left), ['Up to date']);
  assert.deepEqual(marked(right), ['In sync']);
  const same = wordDiff('if (state.kind === a) return x;', 'if (state.kind === a || only) return x;');
  assert.deepEqual(marked(same.left), []);
  assert.deepEqual(marked(same.right), [' || only']);
});

test('wordDiff leaves a line that shares almost nothing unmarked', () => {
  const { left, right } = wordDiff('// the upstream branch was removed', "return 'deleted on remote';");
  assert.deepEqual([marked(left), marked(right)], [[], []]);
});

let repo: TestRepo;
before(async () => {
  repo = await makeRepo();
  await repo.commit('add s', { 's.ts': 'a\nb\nc\n' });
  await repo.commit('change s', { 's.ts': 'a\nB\nc\nd\n' });
});
after(() => fs.rm(repo.dir, { recursive: true, force: true }));

test('fileDiff reads one file of a commit against its parent, and of the first commit against nothing', async () => {
  const { commits } = await readLog({ git, root: repo.work, limit: 5 });
  const change = await commitDetails(git, repo.work, commits[0]?.sha ?? '');
  const diff = await fileDiff(git, repo.work, { sha: change.sha, parent: change.parent, file: change.files[0] ?? { status: 'M', path: 's.ts', oldPath: null, add: 0, del: 0, binary: false } });
  assert.equal(diff.before, change.parent?.slice(0, diff.before?.length ?? 7));
  assert.deepEqual(diff.hunks[0]?.rows.map((r) => r.kind), ['same', 'change', 'same', 'add']);

  const first = await commitDetails(git, repo.work, commits.at(-1)?.sha ?? '');
  const readme = await fileDiff(git, repo.work, { sha: first.sha, parent: null, file: first.files[0] ?? { status: 'A', path: 'README.md', oldPath: null, add: 1, del: 0, binary: false } });
  assert.deepEqual([readme.before, readme.hunks[0]?.rows.map((r) => r.kind)], [null, ['add']]);
});
