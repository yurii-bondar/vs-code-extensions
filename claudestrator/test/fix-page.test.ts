// The task screen's "Fix in chat" (media/task.ts), run here as the page runs it: the compiled script on a `window`
// of its own, with the shell (window.CS) reduced to what records what the screen draws and asks the host.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { sent, taskScreen } from './helpers/task-page';

const hookFailure = {
  status: { key: 'waiting', tone: 'warn', label: 'Commit failed', resumable: false },
  checkpointFull: { id: 'hook-failure' as const, options: ['retry', 'stop'], at: 'now' },
  checkpointContext: { format: 'log' as const, text: 'api: lint said no' },
  fix: 'checkpoint' as const,
};

/** The options of the `<select data-change="…">` in some HTML: values, and which one is selected. */
function options(html: string, change: string): { values: string[]; selected: string | undefined } {
  const select = html.match(new RegExp(`<select[^>]*data-change="${change}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(select, `a ${change} select`);
  const all = [...select[1]!.matchAll(/<option value="([^"]*)"\s*(selected)?/g)];
  return { values: all.map((m) => m[1]!), selected: all.find((m) => m[2])?.[1] };
}

test('fix page: a failure the task waits at gets Fix in chat next to its answers, with a model and an effort to pick', async () => {
  const { regions } = await taskScreen(hookFailure);
  const cp = regions['task-checkpoint']!;
  const actions = cp.match(/<div class="cp-actions">([\s\S]*?)<span class="muted small kbd-hint">/)![1]!;
  assert.match(actions, /data-option="retry"[\s\S]*data-option="stop"[\s\S]*data-action="fix-in-chat"/, 'after the answers, as one of the actions');
  assert.match(actions, /<button class="btn" data-action="fix-in-chat"[^>]*>[\s\S]*?Fix in chat<span class="fix-pick muted"><\/span><\/button>/, 'the size of the answers next to it, and nothing picked yet');
  assert.match(actions, /class="btn split-caret" data-action="eff-menu"/, 'the caret opens the menu as every menu of the page does');
  assert.deepEqual(options(cp, 'fix-model'), { values: ['inherit', 'opus', 'sonnet', 'haiku'], selected: 'inherit' });
  assert.deepEqual(options(cp, 'fix-effort'), { values: ['', 'low', 'medium', 'high', 'xhigh', 'max'], selected: '' });
  assert.match(cp, /<div class="menu fix-menu">[\s\S]*data-action="fix-in-chat"[\s\S]*Open the chat/, 'the menu starts the chat too');
  assert.doesNotMatch(regions['task-alerts']!, /fix-in-chat/, 'once: not in the banner too');
});

test('fix page: an error a run ended with gets a small Fix in chat before Retry; a decision or a sign-in gets none', async () => {
  const failed = { status: { key: 'failed', tone: 'error', label: 'Run failed', resumable: true }, error: { code: 'wrong_branch', message: 'api is on main, not the task branch feat/T-1-risk' }, fix: 'error' as const };
  const { regions } = await taskScreen(failed);
  assert.match(regions['task-alerts']!, /<div class="banner-actions"><span class="menu-wrap fix-wrap">[\s\S]*class="btn sm" data-action="fix-in-chat"[\s\S]*data-action="run">[\s\S]*Retry<\/button><\/div>/);

  const signedOut = await taskScreen({ ...failed, error: { code: 'claude_login', message: 'signed out' }, fix: null });
  assert.doesNotMatch(signedOut.regions['task-alerts']!, /fix-in-chat/);
  assert.match(signedOut.regions['task-alerts']!, /data-action="claude-login"/);

  const push = await taskScreen({ status: hookFailure.status, checkpointFull: { id: 'confirm-push', options: ['push', 'local'], at: 'now' }, checkpointContext: { format: 'log', text: '' }, fix: null });
  assert.doesNotMatch(push.regions['task-checkpoint']!, /fix-in-chat/);
});

test('fix page: the pick is remembered, shown on the button, and sent with the click', async () => {
  const { view, S, calls, picks } = await taskScreen(hookFailure);
  view.changes['fix-model']!({ value: 'sonnet' });
  view.changes['fix-effort']!({ value: 'high' });
  assert.deepEqual([S.ui.fixModel, S.ui.fixEffort], ['sonnet', 'high']);
  assert.equal(calls.persisted, 2, 'kept for the next failure');
  assert.deepEqual(picks.map((p) => p.textContent), ['sonnet · high', 'sonnet · high'], 'every Fix button says it, without drawing the checkpoint again');

  await view.actions['fix-in-chat']!({ closest: () => null });
  assert.deepEqual(sent(calls), [['fixInChat', { taskId: 'T-1', model: 'sonnet', effort: 'high' }]]);

  // Drawn again with the pick: it is selected, and the button says it.
  const again = await taskScreen(hookFailure, { fixModel: 'sonnet', fixEffort: 'high' });
  assert.equal(options(again.regions['task-checkpoint']!, 'fix-model').selected, 'sonnet');
  assert.equal(options(again.regions['task-checkpoint']!, 'fix-effort').selected, 'high');
  assert.match(again.regions['task-checkpoint']!, /<span class="fix-pick muted">sonnet · high<\/span>/);
});

test("fix page: the account's defaults send no model and no effort; a model the CLI list lacks stays a choice", async () => {
  const { view, calls } = await taskScreen(hookFailure, { fixModel: 'inherit', fixEffort: 'bogus' });
  await view.actions['fix-in-chat']!({ closest: () => null });
  assert.deepEqual(sent(calls), [['fixInChat', { taskId: 'T-1', model: 'inherit' }]], 'an effort the page does not know is not sent');

  const pinned = await taskScreen(hookFailure, { fixModel: 'claude-opus-5-5' });
  const models = options(pinned.regions['task-checkpoint']!, 'fix-model');
  assert.equal(models.selected, 'claude-opus-5-5', 'picked before the list had it: still selected, not silently the default');
  assert.equal(models.values.at(-1), 'claude-opus-5-5');
});
