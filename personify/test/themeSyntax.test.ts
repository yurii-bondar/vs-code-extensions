import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES } from '../src/catalog';
import { customizationRules, itemStyles, loadTheme, selectorScore, styleFor } from '../src/core/themeSyntax';
import type { ThemeFiles, ThemeRule } from '../src/core/themeSyntax';

const rule = (scope: string | string[], foreground: string | null, fontStyle: string | null = null): ThemeRule => ({ scopes: Array.isArray(scope) ? scope : [scope], foreground, fontStyle });

test('a selector matches a dot-prefix of the token scope, its other parts match ancestors, and "-" excludes', () => {
  assert.equal(selectorScore('keyword', ['source.ts', 'keyword.control.flow']), 100);
  assert.equal(selectorScore('keyword.control', ['source.ts', 'keyword.control.flow']), 200);
  assert.equal(selectorScore('keyword.con', ['source.ts', 'keyword.control']), null);
  assert.equal(selectorScore('source.go keyword', ['source.ts', 'keyword.control']), null);
  assert.equal(selectorScore('meta.definition.function entity.name', ['source.ts', 'meta.definition.function', 'entity.name.function']), 201);
  assert.equal(selectorScore('keyword - keyword.operator', ['source.ts', 'keyword.operator.new']), null);
  assert.equal(selectorScore('keyword - keyword.operator', ['source.ts', 'keyword.control']), 100);
});

test('color and font style are resolved apart: the most specific rule wins, a later one on a tie', () => {
  const rules = [rule('keyword', '#111111', 'italic'), rule('keyword.control', '#222222'), rule('keyword.control', '#333333')];
  assert.deepEqual(styleFor(rules, ['source.ts', 'keyword.control.flow']), { fg: '#333333', fontStyle: 'italic' });
  assert.deepEqual(styleFor(rules, ['source.ts', 'string.quoted']), { fg: null, fontStyle: null });
});

class Files implements ThemeFiles {
  constructor(private readonly map: Record<string, string>) {}
  async read(file: string): Promise<string> {
    const text = this.map[file];
    if (text === undefined) throw new Error(`no ${file}`);
    return text;
  }
}

test('a theme is read with what it includes (the including theme wins), comments and trailing commas allowed', async () => {
  const files = new Files({
    '/t/dark.json': '{ "include": "./base.json", // base first\n "tokenColors": [{ "scope": "string, comment", "settings": { "foreground": "#aa0000" } },], "semanticHighlighting": true, "semanticTokenColors": { "variable.readonly": { "foreground": "#00aa00", "bold": true } } }',
    '/t/base.json': '{ "tokenColors": [{ "scope": "string", "settings": { "foreground": "#0000aa" } }, { "settings": { "foreground": "#ffffff" } }] }',
  });
  const { tokens, problem } = await loadTheme('/t/dark.json', files);
  assert.equal(problem, null);
  assert.deepEqual(styleFor(tokens.rules, ['source.ts', 'string.quoted']), { fg: '#aa0000', fontStyle: null });
  assert.equal(tokens.semanticHighlighting, true);
  assert.deepEqual(tokens.semantic['variable.readonly'], { fg: '#00aa00', fontStyle: 'bold' });
});

test('a .tmTheme or a file that is not there is reported, not guessed at', async () => {
  assert.equal((await loadTheme('/t/old.json', new Files({ '/t/old.json': '{ "tokenColors": "./old.tmTheme" }' }))).problem, 'tmTheme');
  assert.equal((await loadTheme('/t/missing.json', new Files({}))).problem, 'unreadable');
});

test("the user's own token colors count, shorthands too, but Personify's rules are left to the panel", () => {
  const raw = {
    comments: '#777777',
    textMateRules: [{ scope: 'string', settings: { foreground: '#123456' } }, { name: 'personify:jsts/lit.string', scope: 'string', settings: { foreground: '#ffffff' } }],
    '[Monokai]': { strings: { foreground: '#654321', fontStyle: 'italic' } },
  };
  const rules = customizationRules(raw, 'Monokai', (name) => name.startsWith('personify:'));
  assert.deepEqual(styleFor(rules, ['source.ts', 'comment.line']), { fg: '#777777', fontStyle: null });
  assert.deepEqual(styleFor(rules, ['source.ts', 'string.quoted']), { fg: '#654321', fontStyle: 'italic' });
  assert.deepEqual(customizationRules(raw, 'Dark+', () => false).length, 3);
});

test('catalog tokens get the theme style of their first styled scope, semantic colors on top when they apply', () => {
  const tokens = {
    rules: [rule('keyword.control', '#f92672'), rule('entity.name.function', '#a6e22e'), rule('variable', '#f8f8f2')],
    semantic: { 'variable.readonly': { fg: '#ae81ff', fontStyle: null } },
    semanticHighlighting: true,
  };
  const off = itemStyles({ tokens, extra: [rule('variable', '#eeeeee')], languages: LANGUAGES, semantic: false });
  assert.deepEqual(off['jsts/kw.import'], { fg: '#f92672', fontStyle: null });
  assert.deepEqual(off['go/fn.decl'], { fg: '#a6e22e', fontStyle: null });
  assert.equal(off['jsts/lit.string'], undefined);
  const on = itemStyles({ tokens, extra: [], languages: LANGUAGES, semantic: true });
  const readonlyItem = LANGUAGES[0]?.groups.flatMap((g) => g.items).find((i) => i.semantic.includes('variable.readonly'));
  assert.ok(readonlyItem, 'the catalog has a token for readonly variables');
  assert.equal(on[`jsts/${readonlyItem.id}`]?.fg, '#ae81ff');
});
