// What the dashboard panel posts of an agent's streamed output: in batches, and nothing half a sentence long.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import Module from 'module';

import type { HostMessage } from '../src/core/wire';

// panel.ts loads `vscode`; the methods tested here never reach it.
/* eslint-disable @typescript-eslint/no-require-imports */
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const load = loader._load;
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? {} : load.call(this, request, ...rest);
};
const { DashboardPanel } = require('../src/panel') as typeof import('../src/panel');
loader._load = load;

/** A panel without a webview: what it posts, and whether it is in view. */
function panel() {
  const posted: HostMessage[] = [];
  const view = { visible: true };
  const p = Object.assign(Object.create(DashboardPanel.prototype) as InstanceType<typeof DashboardPanel>, {
    panel: view,
    outputQueue: [],
    outputTimer: undefined,
    missedText: new Set<string>(),
    post: (m: HostMessage) => (posted.push(m), Promise.resolve(true)),
  });
  return { p, posted, view };
}

const delta = (key: string, text: string) => ({ type: 'output' as const, taskId: 'T', key, item: { type: 'text_delta' as const, text } });
const flushed = () => new Promise((r) => setTimeout(r, 80));

test('panel: streamed text goes in one message per batch, merged, in order with the rest', async () => {
  const { p, posted } = panel();
  for (const piece of ['Reading ', 'the ', 'plan']) p.queueOutput(delta('a', piece));
  p.queueOutput({ type: 'output', taskId: 'T', key: 'a', item: { type: 'tool_use', id: '1', name: 'Read', input: {} } });
  assert.equal(posted.length, 0, 'nothing goes before the batch is due');
  await flushed();
  assert.deepEqual(posted.map((m) => (m.type === 'output' ? [m.item.type, 'text' in m.item ? m.item.text : ''] : m.type)), [['text_delta', 'Reading the plan'], ['tool_use', '']]);
});

test('panel: a hidden panel gets no text pieces, and none of that message after it shows again until the whole text', async () => {
  const { p, posted, view } = panel();
  view.visible = false;
  p.queueOutput(delta('a', 'Half a '));
  view.visible = true;
  p.queueOutput(delta('a', 'sentence'));
  p.queueOutput(delta('b', 'Another step'));
  p.queueOutput({ type: 'output', taskId: 'T', key: 'a', item: { type: 'text', text: 'Half a sentence.' } });
  p.queueOutput(delta('a', 'Next '));
  await flushed();
  assert.deepEqual(posted.map((m) => (m.type === 'output' && 'text' in m.item ? [m.key, m.item.type, m.item.text] : null)), [['b', 'text_delta', 'Another step'], ['a', 'text', 'Half a sentence.'], ['a', 'text_delta', 'Next ']]);
});
