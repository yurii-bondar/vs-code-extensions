// Intake: what the user typed → a task source, and a Jira issue or Confluence page → the ticket the agents read.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { adfToText, classifyInput, planFromTicket, projectAllowed, runIntake, storageToText } from '../src/core/intake';
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
