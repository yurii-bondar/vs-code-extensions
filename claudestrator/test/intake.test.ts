// Intake: what the user typed → a task source, and a Jira issue or Confluence page → the ticket the agents read.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { classifyInput, projectAllowed, runIntake } from '../src/core/intake';
import { validateConfigLayer } from '../src/core/protocol';

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
