import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREAS, LANGUAGES, sampleText, textMateScopes } from '../src/catalog';
import { parseProfile, profileFile } from '../src/core/profile';
import { parseClientMessage, parsePrefs } from '../src/protocol';

test('parsePrefs falls back to user settings and all themes', () => {
  assert.deepEqual(parsePrefs(undefined), { scope: 'user', themeMode: 'all' });
  assert.deepEqual(parsePrefs({ scope: 'workspace', themeMode: 'nope' }), { scope: 'workspace', themeMode: 'all' });
});

test('parseClientMessage drops unknown messages and values of the wrong type', () => {
  assert.equal(parseClientMessage(null), null);
  assert.equal(parseClientMessage({ type: 'eval', code: '1' }), null);
  assert.deepEqual(parseClientMessage({ type: 'ready', extra: 1 }), { type: 'ready' });
  assert.deepEqual(parseClientMessage({ type: 'setColors', changes: { a: '#fff', b: '', c: 5 } }), { type: 'setColors', changes: { a: '#fff', b: null, c: null } });
  assert.deepEqual(parseClientMessage({ type: 'setSettings', changes: { a: 3, b: true, c: { x: 1 } } }), { type: 'setSettings', changes: { a: 3, b: true, c: null } });
  assert.deepEqual(parseClientMessage({ type: 'setSyntax', changes: [{ langId: 'go', itemId: 'x', style: { fg: '#f00' } }, { langId: 1 }] }), {
    type: 'setSyntax',
    changes: [{ langId: 'go', itemId: 'x', style: { fg: '#f00', fontStyle: null } }],
  });
  assert.equal(parseClientMessage({ type: 'openSample' }), null);
});

test('keybinding edits need a command, and an index where they edit in place', () => {
  assert.deepEqual(parseClientMessage({ type: 'kb', edit: { op: 'remove', index: 2, command: 'x' } }), { type: 'kb', edit: { op: 'remove', index: 2, command: 'x' } });
  assert.equal(parseClientMessage({ type: 'kb', edit: { op: 'remove', index: -1, command: 'x' } }), null);
  assert.equal(parseClientMessage({ type: 'kb', edit: { op: 'update', command: 'x', key: 'a' } }), null);
  assert.equal(parseClientMessage({ type: 'kb', edit: { op: 'writeText', command: 'x' } }), null);
  assert.deepEqual(parseClientMessage({ type: 'kb', edit: { op: 'add', command: 'x', key: 'a', args: [1] } }), { type: 'kb', edit: { op: 'add', command: 'x', key: 'a', when: '', args: [1] } });
});

test('a profile round-trips; other files are rejected', () => {
  const state = { colors: { a: '#fff' }, settings: { 'editor.fontSize': 14 }, textMateRules: [{ name: 'personify:go/x' }], semanticRules: { 'type:go': { bold: true } } };
  const file = JSON.parse(JSON.stringify(profileFile(state, [{ key: 'a', command: 'x' }, { command: 'noKey' }], new Date(0))));
  assert.equal(file.exportedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(parseProfile(file), { ...state, keybindings: [{ key: 'a', command: 'x' }] });
  assert.equal(parseProfile({ colors: {} }), null);
  assert.deepEqual(parseProfile({ personify: 1, colors: { a: 1 }, settings: 'x' }), { colors: {}, settings: {}, textMateRules: [], semanticRules: {}, keybindings: [] });
});

test('catalog: keys are unique, and every token in a sample is an item of its language', () => {
  const keys = AREAS.flatMap((a) => a.groups.flatMap((g) => g.items.flatMap((i) => (i.kind === 'note' ? [] : [i.key]))));
  assert.equal(new Set(keys).size, keys.length);
  for (const lang of LANGUAGES) {
    const ids = new Set(lang.groups.flatMap((g) => g.items.map((i) => i.id)));
    const used = lang.sample.flatMap((line) => [...line.matchAll(/⟦([^¦]*)¦/g)].map((m) => m[1]));
    assert.deepEqual(used.filter((id) => !ids.has(id ?? '')), [], lang.id);
    assert.ok(!sampleText(lang).includes('⟦'));
  }
  const jsts = LANGUAGES[0];
  const item = jsts?.groups[0]?.items[0];
  assert.ok(jsts && item);
  assert.deepEqual(textMateScopes(jsts, item).slice(0, 2), [`source.js ${item.scopes[0]}`, `source.ts ${item.scopes[0]}`]);
});
