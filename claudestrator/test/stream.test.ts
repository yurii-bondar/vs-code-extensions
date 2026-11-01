// What the task screen keeps of an agent's streamed output (media/stream.ts), run here as the page runs it, on a
// `window` of its own.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

import type { TranscriptItem } from '../src/core/wire';

interface LoadedEdge {
  has(item: TranscriptItem): boolean;
}
const page: { loadedEdge?: (items: TranscriptItem[]) => LoadedEdge } = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'media', 'stream.js'), 'utf8'), { window: page });

test('stream: an item pushed while its transcript was read shows once, and another of the same millisecond shows', () => {
  const read: TranscriptItem = { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.ts' }, t: 1000 };
  const loaded: TranscriptItem[] = [{ type: 'prompt', text: 'Do it', t: 900 }, { type: 'text', text: 'Reading', t: 1000 }, read];
  const edge = page.loadedEdge!(structuredClone(loaded));
  assert.equal(edge.has({ type: 'prompt', text: 'Do it', t: 900 }), true, 'written before the last one');
  assert.equal(edge.has({ ...read }), true, 'the last one, on its way while the transcript was read');
  assert.equal(edge.has({ ...read }), false, 'found once: the same again is another item');
  assert.equal(edge.has({ type: 'tool_result', id: 'r', isError: false, text: 'x', t: 1000 }), false, 'written after the read, in the same millisecond');
  assert.equal(edge.has({ type: 'text', text: 'Next', t: 1001 }), false, 'written after');
  assert.equal(edge.has({ type: 'thinking', t: 500 }), false, 'thinking is never in a transcript');
  assert.equal(edge.has({ type: 'text_delta', text: 'a', t: 500 }), false, 'nor are pieces of text');
  assert.equal(page.loadedEdge!([]).has({ type: 'text', text: 'First', t: 5 }), false, 'an empty transcript holds nothing');
});
