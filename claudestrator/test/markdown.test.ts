// The dashboard's Markdown renderer (media/markdown.ts), which shows plans, tickets, reports and agent replies: text
// anyone could write in Jira or steer an agent into. It runs here as the page runs it, on a `window` of its own.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const page: { renderMarkdown?: (src: string) => string } = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'media', 'markdown.js'), 'utf8'), { window: page });
const render = page.renderMarkdown!;

/** Every attribute of every tag the renderer made, as `tag name`. */
const attributes = (html: string): string[] => [...html.matchAll(/<([a-z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>/gi)].flatMap((m) => [...m[2]!.matchAll(/\s+([^\s=>]+)/g)].map((a) => `${m[1]} ${a[1]}`));

test('markdown: text cannot give the links it makes attributes of its own', () => {
  for (const src of [
    '[docs](https://a/(https://evil.example/x/style=position:fixed;inset:0;z-index:9;opacity:0;x:y)',
    'see (https://evil.example/" style="position:fixed)',
    'https://x.example/a_b_c and https://y.example/**z**',
    '[**bold** label](https://x.example/a_b_c) and `code [x](https://y.example)`',
    '\u00000\u0000 [a](https://x.example/`code`)',
  ]) {
    const html = render(src);
    const odd = attributes(html).filter((a) => !['a href', 'a data-href', 'div class', 'span class', 'button class', 'button data-action', 'button title'].includes(a));
    assert.deepEqual(odd, [], `${src}\n→ ${html}`);
    assert.doesNotMatch(html, /href="[^"]*<(em|strong|a|code)/, `nothing is made inside an address: ${html}`);
  }
  assert.match(render('[**bold** label](https://x.example/p)'), /<a href="https:\/\/x\.example\/p" data-href="https:\/\/x\.example\/p"><strong>bold<\/strong> label<\/a>/);
  assert.match(render('see https://x.example/a_b_c.'), /<a href="https:\/\/x\.example\/a_b_c" data-href="https:\/\/x\.example\/a_b_c">https:\/\/x\.example\/a_b_c<\/a>\./);
  assert.equal(render('`a` and `<b>`'), '<p><code>a</code> and <code>&lt;b&gt;</code></p>');
});

test('markdown: a long line of spaces, hashes or quote marks renders at once, and nothing throws', () => {
  const quick = (src: string, what: string): string => {
    const started = Date.now();
    const html = render(src);
    assert.ok(Date.now() - started < 300, `${what}: ${Date.now() - started} ms`);
    return html;
  };
  quick(`a | b\n${' '.repeat(100000)}`, 'a table head over a line of spaces');
  quick(`# ${' '.repeat(100000)}x`, 'a heading of spaces');
  quick(`# ${'#'.repeat(100000)}x`, 'a heading of hashes');
  assert.match(quick(`${'>'.repeat(12000)} deep`, 'a quote nested twelve thousand times'), /deep/);
  assert.equal(render('# C# and F# #'), '<h2>C# and F#</h2>', 'closing hashes go, the ones of the text stay');
  assert.equal(render('> > nested'), '<blockquote><blockquote><p>nested</p></blockquote></blockquote>');
  assert.match(render('| a | b |\n|---|:---:|\n| 1 | 2 |'), /<th>a<\/th><th>b<\/th>.*<td>1<\/td><td>2<\/td>/s);
});
