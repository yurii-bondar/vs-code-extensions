import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { pickRepo } from '../src/core/repos';
import type { RepoRoot } from '../src/core/types';

const root = (...parts: string[]): RepoRoot => path.join(path.sep, ...parts) as RepoRoot;
const app = root('code', 'app');
const lib = root('code', 'app', 'vendor', 'lib');
const other = root('code', 'other');
const roots = [app, lib, other];

test('pickRepo takes the innermost repository holding the active file', () => {
  assert.equal(pickRepo({ roots, file: path.join(lib, 'index.ts') }), lib);
  assert.equal(pickRepo({ roots, file: path.join(app, 'src', 'main.ts'), current: other }), app);
});

test('pickRepo does not take a sibling whose path only starts the same', () => {
  assert.equal(pickRepo({ roots: [app, other], file: root('code', 'apple', 'x.ts'), current: other }), other);
});

test('pickRepo keeps the shown repository while it is open, else falls back to the first', () => {
  assert.equal(pickRepo({ roots, current: other }), other);
  assert.equal(pickRepo({ roots, current: root('gone') }), app);
  assert.equal(pickRepo({ roots: [], file: '/x' }), null);
});
