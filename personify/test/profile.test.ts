import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffProfile } from '../src/core/profile';
import type { Customization } from '../src/core/customizations';

const rule = (name: string, foreground: string, fontStyle?: string): Record<string, unknown> => ({ name, scope: ['source.ts entity.name.function'], settings: fontStyle === undefined ? { foreground } : { foreground, fontStyle } });

const current: Customization = {
  colors: { 'editor.background': '#1a1b26', 'sideBar.background': '#16161e' },
  settings: { 'editor.fontSize': 14, 'editor.fontLigatures': false },
  textMateRules: [rule('personify:jsts/fn.call', '#7aa2f7'), rule('personify:custom:a', '#737aa2', 'italic')],
  semanticRules: {},
};

const incoming: Customization = {
  colors: { 'editor.background': '#24283b', 'terminal.background': '#13131a', 'not.in.catalog': '#000000' },
  settings: { 'editor.fontSize': 14, 'editor.fontLigatures': true },
  textMateRules: [rule('personify:jsts/fn.call', '#82aaff', 'bold'), { name: 'someone else', settings: {} }],
  semanticRules: {},
};

test('merge lists what the file adds and overwrites, in catalog words, and counts what already matches', () => {
  const { entries, same } = diffProfile(current, incoming, { replace: false });
  assert.deepEqual(entries, [
    { kind: 'changed', label: 'Editor › Background', from: '#1a1b26', to: '#24283b' },
    { kind: 'added', label: 'Terminal › Background', from: null, to: '#13131a' },
    { kind: 'changed', label: 'Editor › Font ligatures', from: 'off', to: 'on' },
    { kind: 'changed', label: 'JS / TS › Function calls', from: '#7aa2f7', to: '#82aaff bold' },
  ]);
  assert.equal(same, 1);
});

test('replace also lists what is removed because the file does not have it', () => {
  const removed = diffProfile(current, incoming, { replace: true }).entries.filter((e) => e.kind === 'removed');
  assert.deepEqual(removed, [
    { kind: 'removed', label: 'Sidebar › Background', from: '#16161e', to: null },
    { kind: 'removed', label: 'Custom scope source.ts entity.name.function', from: '#737aa2 italic', to: null },
  ]);
});

test('a profile identical to the current setup changes nothing', () => {
  const diff = diffProfile(current, current, { replace: true });
  assert.deepEqual(diff.entries, []);
  assert.equal(diff.same, 6);
});
