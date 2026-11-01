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
interface LiveTexts {
  take(key: string, item: TranscriptItem): void;
  writing(key: string): string | null | undefined;
}
const page: { loadedEdge?: (items: TranscriptItem[]) => LoadedEdge; liveTexts?: () => LiveTexts } = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'media', 'stream.js'), 'utf8'), { window: page });

const piece = (text: string): TranscriptItem => ({ type: 'text_delta', text });

test('stream: a message the screen came in on after it started is not shown from the middle', () => {
  const live = page.liveTexts!();
  live.take('a', piece('tence.'));
  live.take('a', piece(' And more'));
  assert.equal(live.writing('a'), null, 'missed from its start: a placeholder, not "tence. And more"');
  live.take('a', { type: 'text', text: 'Half a sentence. And more' });
  assert.equal(live.writing('a'), undefined, 'its whole text arrived');
  live.take('a', piece('Next '));
  live.take('a', piece('one'));
  assert.equal(live.writing('a'), 'Next one', 'the next message is followed from its start');
  live.take('a', { type: 'user', text: 'use utils/date.ts', from: 'you' });
  live.take('a', piece('.'));
  assert.equal(live.writing('a'), 'Next one.', 'what you send it while it writes leaves its message going on');
  live.take('a', { type: 'tool_use', id: '1', name: 'Read', input: {} });
  assert.equal(live.writing('a'), undefined);
  live.take('a', { type: 'thinking' });
  assert.equal(live.writing('a'), '', 'thinking: a message starts, nothing written yet');
  live.take('a', piece('Done'));
  assert.equal(live.writing('a'), 'Done');

  // The page drops the bubble of a message nobody writes any more: thinking followed by tool calls leaves none.
  live.take('c', { type: 'thinking' });
  live.take('c', { type: 'tool_use', id: '2', name: 'Grep', input: {} });
  assert.equal(live.writing('c'), undefined, 'a thinking that ended in a tool call writes nothing');
  live.take('c', { type: 'tool_result', id: '2', isError: false, text: '' });
  live.take('c', piece('Found it'));
  assert.equal(live.writing('c'), 'Found it', 'the next turn\'s text is a message of its own');

  live.take('b', { type: 'prompt', text: 'Review it' });
  live.take('b', piece('Looking'));
  assert.equal(live.writing('b'), 'Looking', 'another step, followed from its first item');
  assert.equal(live.writing('a'), 'Done', 'each step on its own');
});

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
