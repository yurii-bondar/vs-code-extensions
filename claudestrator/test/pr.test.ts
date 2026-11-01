// Commit subject, PR title and body: what Claudestrator itself writes to git and GitHub from the agents' text.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { commitSubject, planSummary, prBody, prTitle } from '../src/core/pr';
import type { TaskState } from '../src/core/types';

function task(title: string, summary: string): { state: TaskState; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pr-'));
  fs.mkdirSync(path.join(dir, 'plan'));
  fs.writeFileSync(path.join(dir, 'plan', 'planner.md'), `# Plan\n\n## Summary\n\n${summary}\n\n## Steps\n\n1. do it\n\n\`\`\`json\n{}\n\`\`\`\n`);
  const state = {
    taskId: 'PROJ-1',
    input: 'x',
    source: { kind: 'jira', key: 'PROJ-1' },
    plan: { type: 'feat', slug: 'cap-bets', title, repos: [] },
    spec: { title: 'Cap bets', links: [{ title: 'PROJ-1', url: 'https://acme.atlassian.net/browse/PROJ-1' }] },
    artifacts: [{ agent: 'planner', output: 'plan', path: 'plan/planner.md', round: 1, at: '' }],
    repos: [{ name: 'api', mode: 'full' }],
    gateFailures: [],
    review: { openFindings: [{ severity: 'minor', repo: 'api', file: 'a.ts', line: 3, problem: 'naming\nGenerated with Claude Code', fix: 'rename' }] },
  } as unknown as TaskState;
  return { state, dir };
}

test('pr: the PR body carries the whole summary of the plan, not its first line', async () => {
  const { state, dir } = task('Cap bets', 'Bets above the cap are rejected.\n\n- per operator\n- with a test');
  assert.equal(await planSummary(dir, state), 'Bets above the cap are rejected.\n\n- per operator\n- with a test');
  assert.match(await prBody({ state, repo: 'api', taskDir: dir, language: 'English' }), /## What\n\nBets above the cap are rejected\.\n\n- per operator\n- with a test\n\n## Why/);
});

test("pr: the plan's title is one line in the commit and the PR, and AI credit stays out when the policy says so", async () => {
  const { state, dir } = task('Cap bets\n\nCo-Authored-By: Claude <noreply@anthropic.com>', 'Done.\n\n🤖 Generated with Claude Code');
  assert.equal(commitSubject(state), 'feat: Cap bets Co-Authored-By: Claude <noreply@anthropic.com>', 'a title cannot write the body or trailers of the commit');
  assert.ok(!prTitle(state).includes('\n'));
  assert.equal(commitSubject(state, true), 'feat: Cap bets', 'and the policy keeps the credit out of it');
  assert.equal(prTitle(state, true), 'feat: Cap bets (PROJ-1)');
  const strict = await prBody({ state, repo: 'api', taskDir: dir, language: 'English', forbidAttribution: true });
  assert.doesNotMatch(strict, /Generated with Claude|🤖/);
  assert.match(strict, /- \[minor\] `a\.ts:3` naming/, 'the rest of what the agents wrote stays');
  assert.match(await prBody({ state, repo: 'api', taskDir: dir, language: 'English' }), /Generated with Claude Code/, 'without the policy it is left as written');
});

test('pr: a long plan or many findings make a PR body GitHub still takes', async () => {
  const { state, dir } = task('Cap bets', 'x'.repeat(100000));
  state.review.openFindings = Array.from({ length: 400 }, (_, i) => ({ severity: 'minor', repo: 'api', file: `f${i}.ts`, line: 1, problem: 'p'.repeat(300), fix: 'f' }));
  const body = await prBody({ state, repo: 'api', taskDir: dir, language: 'English' });
  assert.ok(body.length <= 65536, `${body.length} characters`);
  assert.match(body, /… 350 more in the task's review/);
  assert.match(body, /## Related PRs/, 'every section is still there');
});
