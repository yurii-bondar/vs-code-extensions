// Intake: what the user typed → a task source, and a Jira issue or Confluence page → the ticket the agents read.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { adfToText, classifyInput, extractAcceptanceCriteria, planFromTicket, projectAllowed, runIntake, storageToText } from '../src/core/intake';
import { branchName } from '../src/core/machine';
import { commitSubject, prTitle } from '../src/core/pr';
import { validateConfigLayer } from '../src/core/protocol';
import type { Source, TaskState } from '../src/core/types';

test('intake: a Jira key with _ in its project is a Jira issue, bare, in a link, in a sentence and in a group', async () => {
  assert.deepEqual(classifyInput('MY_PROJ-12'), { kind: 'jira', key: 'MY_PROJ-12' });
  assert.deepEqual(classifyInput('https://acme.atlassian.net/browse/MY_PROJ-12'), { kind: 'jira', key: 'MY_PROJ-12', site: 'acme.atlassian.net' });
  assert.deepEqual(classifyInput('https://acme.atlassian.net/jira/software/projects/MY_PROJ/boards/1?selectedIssue=MY_PROJ-12'), { kind: 'jira', key: 'MY_PROJ-12', site: 'acme.atlassian.net' });
  assert.deepEqual(classifyInput('is MY_PROJ-12 ready?', { embedded: true }), { kind: 'jira', key: 'MY_PROJ-12', note: 'is ready?' });
  assert.equal(classifyInput('does $LIMIT_MAX-1 hold?', { embedded: true }).kind, 'text', 'a shell variable is no issue');
  assert.deepEqual(validateConfigLayer({ groups: { g: { type: 'epic', label: 'G', jira: 'MY_PROJ-12' } } }), []);
  assert.ok(validateConfigLayer({ groups: { g: { type: 'epic', label: 'G', jira: 'my proj-12' } } }).length > 0);
});

test('intake: allowed Jira projects match in any case', async () => {
  assert.equal(projectAllowed('PROJ-1', ['proj']), true);
  assert.equal(projectAllowed('MY_PROJ-1', [' My_Proj ']), true);
  assert.equal(projectAllowed('OPS-1', ['proj']), false);
  assert.equal(projectAllowed('OPS-1', []), true, 'no list allows every project');
  assert.deepEqual(classifyInput('PROJ-7 ready?', { embedded: true, projects: ['proj'] }), { kind: 'jira', key: 'PROJ-7', note: 'ready?' });
  // The project check comes before any request: no client is needed to refuse, and one in another case passes it.
  await assert.rejects(runIntake('OPS-1', { kind: 'jira', key: 'OPS-1' }, { allowedProjects: ['proj'] }), /Jira project OPS is not allowed/);
  await assert.rejects(runIntake('PROJ-1', { kind: 'jira', key: 'PROJ-1' }, { allowedProjects: ['proj'] }), /Connect Atlassian/);
});

test('intake: a Jira task without a planner names its branch and PR after the summary, with the key once', () => {
  const jira: Source = { kind: 'jira', key: 'CP-12' };
  const named = (title: string, source: Source = jira, taskId = 'CP-12') => {
    const plan = planFromTicket({ title, source }, '', ['api']);
    const s = { taskId, source, plan } as unknown as TaskState;
    return { slug: plan.slug, branch: branchName(s), subject: commitSubject(s), pr: prTitle(s) };
  };
  assert.deepEqual(named('CP-12 Fix login'), { slug: 'fix-login', branch: 'fix/CP-12-fix-login', subject: 'fix: Fix login', pr: 'fix: Fix login (CP-12)' });
  assert.equal(named('[CP-12] Fix login').branch, 'fix/CP-12-fix-login', 'as an MCP read may write it');
  assert.equal(named('CP-12: Add export').branch, 'feat/CP-12-add-export');
  // A summary without latin letters: a valid branch all the same, with the key once.
  assert.deepEqual(named('CP-12 Виправити вхід'), { slug: 'change', branch: 'fix/CP-12-change', subject: 'fix: Виправити вхід', pr: 'fix: Виправити вхід (CP-12)' });
  assert.equal(named('CP-12').branch, 'feat/CP-12-change');
  assert.equal(named('CP-123 Other issue').slug, 'cp-123-other-issue', 'another key is part of the summary');
  // Free text keeps its words.
  assert.equal(named('CP-12 Fix login', { kind: 'text', text: 'CP-12 Fix login' }, 'T-1').branch, 'fix/cp-12-fix-login');
});

test('intake: Confluence code keeps its text, its angle brackets and its language', () => {
  const code = (body: string, language = ''): string =>
    `<ac:structured-macro ac:name="code" ac:schema-version="1">${language && `<ac:parameter ac:name="language">${language}</ac:parameter>`}<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`;
  assert.equal(storageToText(`<p>Change it:</p>${code('List<String> xs = load();\nif (a < b && c > d) {}', 'java')}<p>Done.</p>`), 'Change it:\n\n```java\nList<String> xs = load();\nif (a < b && c > d) {}\n```\n\nDone.');
  assert.equal(storageToText(code('<div class="x">hi</div>')), '```\n<div class="x">hi</div>\n```');
  assert.equal(storageToText(code('x &lt; y')), '```\nx &lt; y\n```', 'code is not decoded: it is written as it is');
  assert.equal(storageToText(code('a]]]]><![CDATA[>b')), '```\na]]>b\n```', 'code with ]]> in it comes in two sections');
  assert.equal(storageToText(code('```md\nx\n```')), '````\n```md\nx\n```\n````', 'a fence longer than the code has');
  // A code macro without a body takes nothing after it.
  assert.equal(storageToText('<ac:structured-macro ac:name="code"><ac:plain-text-body/></ac:structured-macro><p>After</p><ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[x < y]]></ac:plain-text-body></ac:structured-macro>'), 'After\n\n```\nx < y\n```');
  // <pre> and <code>, whose text is written with entities: decoded once.
  assert.equal(storageToText('<pre>if (a &lt; b) {<br/>  run();<br/>}</pre>'), '```\nif (a < b) {\n  run();\n}\n```');
  assert.equal(storageToText('<p>Use <code>Map&lt;K, V&gt;</code> here &amp; there, not <code>a`b</code>.</p>'), 'Use `Map<K, V>` here & there, not ``a`b``.');
  assert.equal(storageToText('<p>&amp;lt;b&amp;gt; is written as text</p>'), '&lt;b&gt; is written as text');
  assert.equal(storageToText('<p>It&rsquo;s done &mdash; ship it</p>'), 'It’s done — ship it');
  // Jira's code blocks carry their language too.
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const xs: Array<number> = [];' }] }] }), '```typescript\nconst xs: Array<number> = [];\n```');
});

test('intake: acceptance criteria are found under any way of naming them, and never taken from the next part', () => {
  const ac = extractAcceptanceCriteria;
  // A colon inside or outside the bold, a heading in any case, AC:, the definition of done.
  assert.deepEqual(ac('Fix it\n\n**Acceptance criteria:**\n- a\n- b'), ['a', 'b']);
  assert.deepEqual(ac('**Acceptance criteria**:\n- a'), ['a']);
  assert.deepEqual(ac('*Acceptance criteria:*\n- a'), ['a']);
  assert.deepEqual(ac('## Acceptance Criteria\n\n1. a\n2. b'), ['a', 'b']);
  assert.deepEqual(ac('AC:\n- a'), ['a']);
  assert.deepEqual(ac('Definition of done\n- [ ] tests pass\n- [x] docs'), ['tests pass', 'docs']);
  assert.deepEqual(ac('Account-wide AC: none\n- a'), [], 'a sentence that mentions them is no heading');
  // Jira writes a heading node and a bold paragraph that way.
  const t = (text: string) => ({ type: 'text', text });
  const list =(...xs: string[]) => ({ type: 'bulletList', content: xs.map((x) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [t(x)] }] })) });
  assert.deepEqual(ac(adfToText({ type: 'doc', content: [{ type: 'heading', attrs: { level: 3 }, content: [t('Acceptance Criteria')] }, list('a', 'b')] })), ['a', 'b']);
  // A section of sentences gives its lines, never the next part's list.
  assert.deepEqual(ac('## Acceptance criteria\nUsers can log in.\n\n**Notes**\n- unrelated note'), ['Users can log in.']);
  assert.deepEqual(ac('## Acceptance criteria\nUsers can log in.\n\n**Notes:**\n- unrelated note'), ['Users can log in.']);
  assert.deepEqual(ac('## Acceptance criteria\nUsers can log in.\n\nNotes\n- unrelated note'), ['Users can log in.']);
  assert.deepEqual(ac('## Acceptance criteria\nUsers can log in.\nAdmins can too.\n\nThey see the dashboard.\n\n---\n\nUnrelated'), ['Users can log in.', 'Admins can too.', 'They see the dashboard.']);
  // A line that leads into the list is not a criterion; a paragraph after the list ends it.
  assert.deepEqual(ac('## Acceptance criteria\n\nThe user can:\n\n- log in\n- log out\n  of every device\n\nMore context.\n- not this'), ['log in', 'log out of every device']);
  assert.deepEqual(ac('No criteria here\n- a'), []);
  // A long run of spaces costs nothing.
  const started = Date.now();
  ac(`AC${' '.repeat(50000)}x\n**x${' '.repeat(50000)}y`);
  assert.ok(Date.now() - started < 500);
});

test('intake: a Jira link keeps its address, a card its URL and a file its name, and text keeps its marks', () => {
  type Mark = { type: string; attrs?: Record<string, unknown> };
  const t = (text: string, ...marks: Mark[]) => ({ type: 'text', text, ...(marks.length && { marks }) });
  const link = (href: string): Mark => ({ type: 'link', attrs: { href } });
  const doc = (...content: unknown[]) => adfToText({ type: 'doc', content });
  const p = (...content: unknown[]) => ({ type: 'paragraph', content });

  assert.equal(doc(p(t('Read '), t('the API spec', link('https://acme.example/spec')), t(' first.'))), 'Read [the API spec](https://acme.example/spec) first.');
  // One link over words formatted differently is one link.
  assert.equal(doc(p(t('the ', link('https://a.example')), t('API', link('https://a.example'), { type: 'strong' }), t(' spec', link('https://a.example')))), '[the **API** spec](https://a.example)');
  assert.equal(doc(p(t('mail us', link('mailto:dev@acme.example')))), '[mail us](mailto:dev@acme.example)');
  assert.equal(doc(p(t('https://a.example/x', link('https://a.example/x')))), 'https://a.example/x', 'a bare address once');
  assert.equal(doc(p(t('the doc', link('https://a.example/a b(1)')))), '[the doc](https://a.example/a%20b%281%29)');
  assert.equal(doc(p(t('click', link('javascript:alert(1)')), t(' or '), t('there', link('/relative')))), 'click or there', 'only web and mail addresses');
  // Code, bold, italics and struck-out text, with spaces outside the marks.
  assert.equal(doc(p(t('Call '), t('login()', { type: 'code' }), t(' — '), t('must ', { type: 'strong' }), t('now', { type: 'em' }), t(', '), t('or by mail', { type: 'strike' }))), 'Call `login()` — **must** *now*, ~~or by mail~~');
  // Cards, inline and as blocks of their own.
  assert.equal(doc(p(t('See '), { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/CP-2' } }), { type: 'blockCard', attrs: { url: 'https://figma.com/file/x' } }, { type: 'embedCard', attrs: { url: 'https://loom.com/v/1' } }, p(t('End'))), 'See https://acme.atlassian.net/browse/CP-2\n\nhttps://figma.com/file/x\n\nhttps://loom.com/v/1\n\nEnd');
  // Files: by alt text, file name or id, each in its place.
  const media = (attrs: Record<string, unknown>) => ({ type: 'media', attrs: { type: 'file', collection: 'c', ...attrs } });
  assert.equal(
    doc(
      { type: 'mediaSingle', content: [media({ id: 'a1', alt: 'mockup.png' }), { type: 'caption', content: [t('The login screen')] }] },
      { type: 'mediaGroup', content: [media({ id: 'b2', __fileName: 'spec.pdf' }), media({ id: 'c3' })] },
      p(t('Log: '), { type: 'mediaInline', attrs: { id: 'd4', __fileName: 'error.log' } }),
    ),
    '[attachment: mockup.png] The login screen\n\n[attachment: spec.pdf] [attachment: c3]\n\nLog: [attachment: error.log]'
  );
  // A bold "Acceptance criteria:" paragraph still names the list under it.
  const list = { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('a'))] }] };
  assert.deepEqual(extractAcceptanceCriteria(doc(p(t('Acceptance criteria:', { type: 'strong' })), list)), ['a']);
});

test('intake: a Confluence link keeps its address, a page link its title and a file its name', () => {
  assert.equal(storageToText('<p>See <a href="https://figma.com/file/x?a=1&amp;b=2">the mockup</a>.</p>'), 'See [the mockup](https://figma.com/file/x?a=1&b=2).');
  assert.equal(storageToText('<p><a href="https://acme.example"><code>run()</code> it</a></p>'), '[`run()` it](https://acme.example)');
  assert.equal(storageToText('<p><a href="javascript:alert(1)">x</a> <a href="/wiki/spaces/DEV">y</a> <a name="top">z</a></p>'), 'x y z', 'only web and mail addresses');
  // Links to pages and files, whose text is CDATA: not code.
  assert.equal(storageToText('<p>Read <ac:link><ri:page ri:space-key="DEV" ri:content-title="Q&amp;A" /><ac:plain-text-link-body><![CDATA[the FAQ]]></ac:plain-text-link-body></ac:link> first.</p>'), 'Read [page: Q&A] first.');
  assert.equal(storageToText('<p><ac:link><ri:attachment ri:filename="spec.pdf" /></ac:link></p>'), '[attachment: spec.pdf]');
  assert.equal(storageToText('<p><ac:link><ri:url ri:value="https://acme.example" /><ac:plain-text-link-body><![CDATA[the site]]></ac:plain-text-link-body></ac:link></p>'), '[the site](https://acme.example)');
  assert.equal(storageToText('<p>Ask <ac:link><ri:user ri:account-id="5b10" /></ac:link>.</p>'), 'Ask .');
  // Images and files a macro shows.
  assert.equal(storageToText('<p><ac:image ac:alt="flow"><ri:attachment ri:filename="flow.png" /></ac:image></p><p><ac:image><ri:url ri:value="https://acme.example/a.png" /></ac:image></p>'), '[attachment: flow.png]\n[attachment: https://acme.example/a.png]');
  assert.equal(storageToText('<ac:structured-macro ac:name="view-file"><ac:parameter ac:name="name"><ri:attachment ri:filename="data.xlsx" /></ac:parameter></ac:structured-macro>'), '[attachment: data.xlsx]');
  // Bold and italics, so a bold line ends the acceptance criteria as it does in Jira.
  const page = storageToText('<h2>Acceptance criteria</h2><p>Users can <em>log in</em>.</p><p><strong>Notes</strong></p><ul><li>unrelated</li></ul>');
  assert.equal(page, '## Acceptance criteria\n\nUsers can *log in*.\n**Notes**\n\n- unrelated');
  assert.deepEqual(extractAcceptanceCriteria(page), ['Users can *log in*.']);
  // Text that would look like what is set aside is only text.
  assert.equal(storageToText('<p>a &#xE000;0&#xE000; b <code>x</code></p>'), 'a 0 b `x`');
});
