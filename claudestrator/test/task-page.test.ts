// The task screen of a task from an issue: the branch its plan will make, as the engine names it.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { taskScreen } from './helpers/task-page';

/** The plan waiting for approval, of a task from `source`. */
const planScreen = (taskId: string, source: Record<string, unknown> | null) => ({
  taskId,
  source,
  status: { key: 'waiting', tone: 'warn', label: 'Approve the plan', resumable: false },
  checkpointFull: { id: 'approve-plan' as const, options: ['approve', 'change', 'stop'], at: 'now' },
  checkpointContext: { format: 'markdown' as const, text: '## Summary\n\nDo it.' },
  plan: { type: 'feat', slug: 'validate-signup', title: 'validate signup', repos: [{ name: 'api', mode: 'full' }], openQuestions: [] },
});

/** The branch chip of the plan's checkpoint. */
const branchChip = (html: string): string => {
  const m = html.match(/<span class="chip mono"><i data-icon="branch"><\/i>([^<]*)<\/span>/);
  assert.ok(m, 'a branch chip');
  return m[1]!;
};

test('task page: a task from an issue shows the branch with its id, as the engine makes it', async () => {
  const cases: [string, Record<string, unknown> | null, string][] = [
    ['api-12', { kind: 'github', label: 'acme/api#12', url: 'https://github.com/acme/api/issues/12' }, 'feat/api-12-validate-signup'],
    ['web-3', { kind: 'gitlab', label: 'acme/web#3', url: 'https://gitlab.com/acme/web/-/issues/3' }, 'feat/web-3-validate-signup'],
    ['ENG-7', { kind: 'linear', label: 'ENG-7', url: 'https://linear.app/acme/issue/ENG-7' }, 'feat/ENG-7-validate-signup'],
    ['CP-1', { kind: 'jira', label: 'CP-1' }, 'feat/CP-1-validate-signup'],
    ['DOC-42', { kind: 'confluence', label: 'Confluence page' }, 'feat/validate-signup'],
    ['T-20261109-1200', { kind: 'text', label: 'Description' }, 'feat/validate-signup'],
    ['T-20261109-1201', null, 'feat/validate-signup'],
  ];
  for (const [taskId, source, branch] of cases) {
    const { regions } = await taskScreen(planScreen(taskId, source));
    assert.equal(branchChip(regions['task-checkpoint']!), branch, `${source ? String(source.kind) : 'no source'}`);
  }
});
