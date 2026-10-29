import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, buildRows, humanize, normalizeKey, parseDefaultKeybindings, parseKeybindings } from '../src/core/keybindings';
import type { KeybindingEdit } from '../src/core/types';

const apply = (text: string, edit: KeybindingEdit): unknown[] | null => parseKeybindings(applyEdit(text, parseKeybindings(text) ?? [], edit));

test('normalizeKey ignores modifier order and case', () => {
  assert.equal(normalizeKey('Shift+Cmd+P'), normalizeKey('cmd+shift+p'));
  assert.equal(normalizeKey(' cmd+k  shift+cmd+s '), 'cmd+k cmd+shift+s');
});

test('humanize turns a command id into a title', () => {
  assert.equal(humanize('workbench.action.files.saveAll'), 'Files: Save All');
  assert.equal(humanize('editor.action.formatDocument'), 'Format Document');
  assert.equal(humanize('git.commit_staged'), 'Git: Commit staged');
});

test('parseKeybindings accepts comments and trailing commas, and rejects broken JSON', () => {
  assert.deepEqual(parseKeybindings('// mine\n[{ "key": "a", "command": "x" },]'), [{ key: 'a', command: 'x' }]);
  assert.equal(parseKeybindings('[{ "key": '), null);
  assert.equal(parseKeybindings('{}'), null);
});

test('default keybindings: shortcuts with a key and command, and the commands listed without one', () => {
  const text = '[\n{ "key": "cmd+s", "command": "save" },\n{ "key": "cmd+p" },\n{ "key": "f1", "command": "help", "when": "x", "args": 1 }\n]\n// Here are other available commands:\n// - workbench.action.zoomIn\n//  - git.sync\n';
  const { list, unbound } = parseDefaultKeybindings(text);
  assert.deepEqual(list, [
    { key: 'cmd+s', command: 'save', when: '', args: undefined },
    { key: 'f1', command: 'help', when: 'x', args: 1 },
  ]);
  assert.deepEqual(unbound, ['workbench.action.zoomIn', 'git.sync']);
});

test('buildRows marks switched-off defaults and lists the user entries that have a key', () => {
  const defaults = [
    { key: 'cmd+s', command: 'save', when: '', args: undefined },
    { key: 'cmd+p', command: 'quickOpen', when: 'editorFocus', args: undefined },
  ];
  const user = [{ key: 'Shift+Cmd+P', command: '-quickOpen' }, { key: 'cmd+k', command: 'mine', when: 'x' }, { command: 'noKey' }, 'junk'];
  const rows = buildRows({ defaults, user, title: (id) => id.toUpperCase() });
  assert.deepEqual(
    rows.map((r) => [r.id, r.source, r.command, r.title, r.source === 'default' ? r.removalIndex : r.index]),
    [
      ['d0', 'default', 'save', 'SAVE', null],
      ['d1', 'default', 'quickOpen', 'QUICKOPEN', null],
      ['u1', 'user', 'mine', 'MINE', 1],
    ]
  );
  const removed = buildRows({ defaults, user: [{ key: 'cmd+p', command: '-quickOpen' }], title: (id) => id });
  assert.equal(removed[1]?.source === 'default' && removed[1].removalIndex, 0);
});

test('add, disable and replace append entries; when and args only when set', () => {
  assert.deepEqual(apply('[]', { op: 'add', command: 'x', key: 'cmd+1', when: '', args: undefined }), [{ key: 'cmd+1', command: 'x' }]);
  assert.deepEqual(apply('[]', { op: 'add', command: 'x', key: 'cmd+1', when: 'w', args: { a: 1 } }), [{ key: 'cmd+1', command: 'x', when: 'w', args: { a: 1 } }]);
  assert.deepEqual(apply('[]', { op: 'disableDefault', command: 'x', key: 'cmd+1', when: '' }), [{ key: 'cmd+1', command: '-x' }]);
  assert.deepEqual(apply('[]', { op: 'replaceDefault', command: 'x', oldKey: 'cmd+1', oldWhen: 'w', key: 'cmd+2', when: '', args: undefined }), [
    { key: 'cmd+1', command: '-x', when: 'w' },
    { key: 'cmd+2', command: 'x' },
  ]);
});

test('update, remove and restore keep the comments and check the entry did not move', () => {
  const text = '[\n  // keep me\n  { "key": "a", "command": "x", "when": "w" },\n  { "key": "b", "command": "-y" }\n]';
  const updated = applyEdit(text, parseKeybindings(text) ?? [], { op: 'update', index: 0, command: 'x', key: 'c', when: '' });
  assert.match(updated, /\/\/ keep me/);
  assert.deepEqual(parseKeybindings(updated), [{ key: 'c', command: 'x' }, { key: 'b', command: '-y' }]);
  assert.deepEqual(apply(text, { op: 'remove', index: 0, command: 'x' }), [{ key: 'b', command: '-y' }]);
  assert.deepEqual(apply(text, { op: 'restoreDefault', index: 1, command: 'y' }), [{ key: 'a', command: 'x', when: 'w' }]);
  assert.throws(() => applyEdit(text, parseKeybindings(text) ?? [], { op: 'remove', index: 1, command: 'x' }), /changed outside Personify/);
});

test('resetCommand drops every entry of a command and its removals', () => {
  const text = JSON.stringify([{ key: 'a', command: 'x' }, { key: 'b', command: 'y' }, { key: 'c', command: '-x' }], null, 2);
  assert.deepEqual(apply(text, { op: 'resetCommand', command: 'x' }), [{ key: 'b', command: 'y' }]);
});
