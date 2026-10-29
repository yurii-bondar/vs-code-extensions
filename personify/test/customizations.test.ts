import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, Customizations, SEMANTIC, TOKENS } from '../src/core/customizations';
import type { Config } from '../src/core/customizations';
import type { Scope, Target } from '../src/core/types';

/** Settings in memory, with the same rules as VS Code's: undefined removes, workspace beats user beats default. */
class FakeConfig implements Config {
  readonly values: Record<Scope, Map<string, unknown>> = { user: new Map(), workspace: new Map() };
  readonly defaults = new Map<string, unknown>();
  workspaceOpen = true;

  read(key: string, scope: Scope): unknown {
    return this.values[scope].get(key);
  }
  effective(key: string): unknown {
    return this.values.workspace.get(key) ?? this.values.user.get(key) ?? this.defaults.get(key);
  }
  defaultValue(key: string): unknown {
    return this.defaults.get(key);
  }
  async write(key: string, value: unknown, scope: Scope): Promise<void> {
    if (value === undefined) this.values[scope].delete(key);
    else this.values[scope].set(key, JSON.parse(JSON.stringify(value)));
  }
  canWriteWorkspace(): boolean {
    return this.workspaceOpen;
  }
}

const USER: Target = { scope: 'user', theme: null };
const DARK: Target = { scope: 'user', theme: 'Dark+' };

function setup(): { config: FakeConfig; c: Customizations } {
  const config = new FakeConfig();
  return { config, c: new Customizations(config) };
}

test('colors go under "[Theme]" for one theme, and the block goes away when emptied', async () => {
  const { config, c } = setup();
  await c.setColors(DARK, { 'sideBar.background': '#111111' });
  assert.deepEqual(config.read(COLORS, 'user'), { '[Dark+]': { 'sideBar.background': '#111111' } });
  assert.deepEqual(c.appearanceState(DARK).colors, { 'sideBar.background': '#111111' });
  assert.deepEqual(c.appearanceState(USER).colors, {});
  await c.setColors(DARK, { 'sideBar.background': null });
  assert.equal(config.read(COLORS, 'user'), undefined);
});

test('settings report their own, effective and default values; null or empty removes them', async () => {
  const { config, c } = setup();
  config.defaults.set('editor.fontSize', 12);
  await c.setSettings(USER, { 'editor.fontSize': 14, 'editor.fontFamily': '' });
  assert.deepEqual(c.appearanceState(USER).settings['editor.fontSize'], { value: 14, effective: 14, def: 12 });
  assert.equal(config.read('editor.fontFamily', 'user'), undefined);
  await c.setSettings(USER, { 'editor.fontSize': null });
  assert.deepEqual(c.appearanceState(USER).settings['editor.fontSize'], { value: null, effective: 12, def: 12 });
});

test('a token style writes a TextMate rule and semantic rules, and reads back; reset removes both', async () => {
  const { config, c } = setup();
  await c.setSyntax(USER, [{ langId: 'jsts', itemId: 'fn.decl', style: { fg: '#ff0000', fontStyle: 'bold' } }]);
  const tokens = config.read(TOKENS, 'user') as { textMateRules: { name: string; scope: string[]; settings: unknown }[] };
  assert.equal(tokens.textMateRules[0]?.name, 'personify:jsts/fn.decl');
  assert.ok(tokens.textMateRules[0]?.scope.includes('source.ts meta.definition.function entity.name.function'));
  assert.deepEqual(tokens.textMateRules[0]?.settings, { foreground: '#ff0000', fontStyle: 'bold' });
  const semantic = config.read(SEMANTIC, 'user') as { rules: Record<string, unknown> };
  assert.deepEqual(semantic.rules['function.declaration:typescript'], { foreground: '#ff0000', bold: true, italic: false, underline: false, strikethrough: false });
  assert.deepEqual(c.syntaxState(USER).items, { 'jsts/fn.decl': { fg: '#ff0000', fontStyle: 'bold' } });

  await c.setSyntax(USER, [{ langId: 'jsts', itemId: 'fn.decl', style: null }]);
  assert.equal(config.read(TOKENS, 'user'), undefined);
  assert.equal(config.read(SEMANTIC, 'user'), undefined);
});

test('an empty fontStyle is a style of its own: it clears the theme italic', async () => {
  const { config, c } = setup();
  await c.setSyntax(USER, [{ langId: 'jsts', itemId: 'kw.flow', style: { fg: null, fontStyle: '' } }]);
  const tokens = config.read(TOKENS, 'user') as { textMateRules: { settings: unknown }[] };
  assert.deepEqual(tokens.textMateRules[0]?.settings, { fontStyle: '' });
});

test('custom rules replace each other, skip drafts, and leave hand-written rules alone', async () => {
  const { config, c } = setup();
  await config.write(TOKENS, { textMateRules: [{ scope: 'comment', settings: { foreground: '#888888' } }] }, 'user');
  await c.setCustom(USER, [
    { id: 'a', scope: 'source.go comment, string', fg: '#00ff00', fontStyle: null },
    { id: 'draft', scope: '', fg: '#00ff00', fontStyle: null },
  ]);
  assert.deepEqual(c.syntaxState(USER).custom, [{ id: 'a', scope: 'source.go comment, string', fg: '#00ff00', fontStyle: null }]);
  await c.setCustom(USER, []);
  assert.deepEqual(config.read(TOKENS, 'user'), { textMateRules: [{ scope: 'comment', settings: { foreground: '#888888' } }] });
});

test('export then import with replace restores exactly what Personify wrote', async () => {
  const { config, c } = setup();
  await c.setColors(USER, { 'sideBar.background': '#111111' });
  await c.setSettings(USER, { 'editor.fontSize': 15 });
  await c.setSyntax(USER, [{ langId: 'jsts', itemId: 'fn.decl', style: { fg: '#ff0000', fontStyle: null } }]);
  const exported = c.exportState(USER);

  await c.setColors(USER, { 'sideBar.foreground': '#222222' });
  await c.importState(USER, exported, { replace: true });
  assert.deepEqual(c.exportState(USER), exported);
  assert.equal(config.read('editor.fontSize', 'user'), 15);
});

test('import with merge keeps what the profile does not mention; resetAll keeps hand-written settings', async () => {
  const { config, c } = setup();
  await config.write(COLORS, { 'editor.background': '#000000', 'my.own': '#123456' }, 'user');
  await c.importState(USER, { colors: { 'sideBar.background': '#111111' }, settings: {}, textMateRules: [], semanticRules: {} }, { replace: false });
  assert.deepEqual(config.read(COLORS, 'user'), { 'editor.background': '#000000', 'my.own': '#123456', 'sideBar.background': '#111111' });
  await c.resetAll(USER);
  assert.deepEqual(config.read(COLORS, 'user'), { 'my.own': '#123456' });
});

test('restoreSnapshot puts back both levels, and skips the workspace when none is open', async () => {
  const { config, c } = setup();
  await config.write('editor.fontSize', 13, 'user');
  const snap = c.snapshot();
  await c.setSettings(USER, { 'editor.fontSize': 20 });
  await config.write('editor.fontSize', 18, 'workspace');
  config.workspaceOpen = false;
  await c.restoreSnapshot(snap);
  assert.equal(config.read('editor.fontSize', 'user'), 13);
  assert.equal(config.read('editor.fontSize', 'workspace'), 18);
});
