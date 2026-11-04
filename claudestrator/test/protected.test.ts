// Changes agents make to a repo's Claude Code and VS Code settings: never written by them, kept and put to you.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { applyEdit, contentAfter, humanFinding, isInstructionsOnly, isProtectedFile, refusedSettings } from '../src/core/protected';
import { guardBash } from '../src/core/guard';
import { transition } from '../src/core/machine';
import { buildPipeline } from '../src/core/pipeline';
import * as config from '../src/core/config';
import { buildAgentPrompt } from '../src/core/prompt';
import { scanDiff } from '../src/core/secrets';
import { workspace, harness, runTask, waitFor } from './helpers/e2e';
import type { EventBody, OrchEvent, PlanMeta, ProtectedChange, Spec, TaskState } from '../src/core/types';
import type { RunAction } from '../src/core/machine';

test('protected: the settings by their place in the repo, and which of them are only instructions', () => {
  for (const f of ['.claude/settings.json', '.claude/rules/forms.md', './.claude/hooks/x.sh', '.mcp.json', '.vscode/tasks.json', '.Claude/agents/a.md']) assert.ok(isProtectedFile(f), f);
  for (const f of ['CLAUDE.md', 'src/.claude.ts', '.claude', 'docs/.mcp.json.md', '.husky/pre-commit', 'CLAUDE.local.md']) assert.ok(!isProtectedFile(f), f);
  assert.ok(isInstructionsOnly('.claude/rules/forms.md'));
  assert.ok(isInstructionsOnly('.claude/rules/web/forms.md'));
  for (const f of ['.claude/settings.json', '.claude/rules/run.sh', '.claude/agents/x.md', '.claude/rules/../settings.md', '.mcp.json']) assert.ok(!isInstructionsOnly(f), f);
});

test("protected: a finding about the settings is yours, wherever its path starts", () => {
  for (const file of ['.claude/rules/forms.md', 'game-client/.claude/rules/forms.md', './.mcp.json', 'web/.vscode/settings.json', 'CLAUDE.local.md']) assert.ok(humanFinding({ file }), file);
  for (const file of [undefined, 'src/claude.ts', 'CLAUDE.md', '.claude']) assert.ok(!humanFinding(file === undefined ? {} : { file }), String(file));
});

test('protected: an Edit as Claude Code applies it, and refuses what it would refuse', () => {
  assert.equal(applyEdit('a b a', { old_string: 'b', new_string: 'c' }), 'a c a');
  assert.equal(applyEdit('a b a', { old_string: 'a', new_string: 'x' }), null, 'there twice');
  assert.equal(applyEdit('a b a', { old_string: 'a', new_string: 'x', replace_all: true }), 'x b x');
  assert.equal(applyEdit('a', { old_string: 'z', new_string: 'x' }), null, 'not there');
  assert.equal(contentAfter('Write', { content: 'new' }, null), 'new');
  assert.equal(contentAfter('Edit', { old_string: 'a', new_string: 'b' }, null), null, 'no file to edit');
  assert.equal(contentAfter('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b c', new_string: 'd' }] }, 'a c'), 'd');
  assert.equal(contentAfter('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'zz', new_string: 'd' }] }, 'a c'), null, 'one edit that does not apply: none does');
  assert.equal(contentAfter('NotebookEdit', {}, 'x'), null);
});

test('protected: the settings files a command the sandbox refused names, as it names them', () => {
  assert.deepEqual(refusedSettings('error: unable to create file .claude/rules/forms.md: Operation not permitted\nerror: patch failed'), ['.claude/rules/forms.md']);
  assert.deepEqual(refusedSettings("Error: EPERM: operation not permitted, open '/ws/api/.mcp.json'"), ['/ws/api/.mcp.json']);
  assert.deepEqual(refusedSettings('cp: .vscode/tasks.json: Read-only file system'), ['.vscode/tasks.json']);
  assert.deepEqual(refusedSettings('wrote .claude/rules/forms.md\nsrc/a.ts: Operation not permitted'), [], 'a refusal on another line, of another file');
  assert.deepEqual(refusedSettings('cat: .claude/x.md: No such file or directory'), [], 'not a refusal');
});

test('guard: a command that writes the settings tells the agent the way that works', async () => {
  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: false, allowNoVerify: false, sandbox: true, localPorts: false, network: [], writable: [], checkEnv: [], protectedChanges: 'ask' as const };
  const api = '/ws/api';
  const ctx = { policy, cwd: api, workspace: '/ws', agent: true, writeRoots: [api], runsOutside: [`${api}/.claude`, `${api}/.mcp.json`, `${api}/.husky/_`], branchOf: async () => 'feat/x', isRepoRoot: async () => true, readFile: async () => null };
  const settings = await guardBash('cp /tmp/forms.md .claude/rules/forms.md', ctx);
  assert.ok(!settings.allow && /use the Write or Edit tool instead/.test(settings.reason), JSON.stringify(settings));
  const hooks = await guardBash('echo x > .husky/_/pre-commit', ctx);
  assert.ok(!hooks.allow && !/Write or Edit/.test(hooks.reason), 'the hooks folder has no such way');
});

// ---------- the state machine ----------

const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const spec: Spec = { id: 'T-1', source: { kind: 'text', text: 'x' }, title: 'x', description: 'x', acceptanceCriteria: [], links: [] };
const PLAN: PlanMeta = { type: 'feat', slug: 'forms', title: 'forms', repos: [{ name: 'api', mode: 'full' }, { name: 'web', mode: 'full' }], openQuestions: [] };
const RULE: ProtectedChange = { repo: 'web', file: '.claude/rules/forms.md', artifact: 'proposed/r1/web/.claude/rules/forms.md' };

/** A task of the built-in pipeline through its approved plan, and a way to send it more events. */
function task() {
  const r = config.resolveConfig([config.builtinLayer()]);
  assert.ok(r.ok);
  let s: TaskState | null = null;
  let n = 0;
  const apply = (e: EventBody): TaskState => {
    const t = transition(s, { ...e, at: at(++n) } as OrchEvent);
    assert.ok(t.ok, t.ok ? undefined : t.error.message);
    s = t.state;
    return t.state;
  };
  apply({ type: 'task_created', taskId: 'T-1', input: 'x', source: { kind: 'text', text: 'x' }, auto: false, pipeline: buildPipeline(r.config), limits: { reviewRounds: 3, gateAttempts: 3 }, knownRepos: ['api', 'web'] });
  apply({ type: 'intake_completed', spec });
  apply({ type: 'stage_started', agent: 'planner' });
  apply({ type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: PLAN });
  apply({ type: 'checkpoint_answered', id: 'approve-plan', option: 'approve' });
  return apply;
}

test('machine: a step that changed the settings stops for you before the next one, and goes on as you answer', () => {
  for (const option of ['apply', 'skip']) {
    const apply = task();
    apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
    let s = apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'reports/r1/developer-api.md', gates: 'pass' });
    assert.equal(s.checkpoint, null, 'a step without such changes goes on');
    apply({ type: 'stage_started', agent: 'developer', repo: 'web' });
    s = apply({ type: 'stage_completed', agent: 'developer', repo: 'web', artifact: 'reports/r1/developer-web.md', gates: 'pass', protectedChanges: [RULE] });
    assert.equal(s.checkpoint!.id, 'protected-changes');
    assert.deepEqual(s.checkpoint!.options, ['apply', 'retry', 'skip', 'stop']);
    assert.deepEqual(s.checkpoint!.step, { stage: 1, agent: 'developer', repo: 'web' });
    assert.deepEqual(s.proposed, [RULE]);
    s = apply({ type: 'checkpoint_answered', id: 'protected-changes', option });
    assert.equal(s.proposed, undefined, `${option}: no longer waiting`);
    assert.deepEqual(s.next, { stage: 2, agent: 'tester' }, `${option}: the tester is next`);
  }
});

test('machine: red checks first, then the settings changes of the same step', () => {
  const apply = task();
  apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  let s = apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'reports/r1/developer-api.md', gates: 'fail', protectedChanges: [{ ...RULE, repo: 'api' }] });
  assert.equal(s.checkpoint!.id, 'gate-failure');
  s = apply({ type: 'checkpoint_answered', id: 'gate-failure', option: 'continue' });
  assert.equal(s.checkpoint!.id, 'protected-changes', 'going on past red checks still asks about them');
  // Run again, a step proposes the same file anew: the later change replaces the earlier one.
  const retry = task();
  retry({ type: 'stage_started', agent: 'developer', repo: 'api' });
  retry({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'reports/r1/developer-api.md', gates: 'fail', protectedChanges: [{ ...RULE, repo: 'api' }] });
  retry({ type: 'checkpoint_answered', id: 'gate-failure', option: 'retry' });
  retry({ type: 'stage_started', agent: 'developer', repo: 'api' });
  s = retry({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'reports/r1/developer-api.md', gates: 'pass', protectedChanges: [{ ...RULE, repo: 'api', artifact: 'proposed/r1/api/.claude/rules/forms.md#2' }] });
  assert.deepEqual(s.proposed!.map((c) => c.artifact), ['proposed/r1/api/.claude/rules/forms.md#2']);
});

test('machine: what a failed step kept waits for the retry, and a try with a command does not replace a written change', () => {
  const apply = task();
  apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  let s = apply({ type: 'stage_failed', agent: 'developer', repo: 'api', error: 'blocked', blocked: true, protectedChanges: [{ ...RULE, repo: 'api' }] });
  assert.equal(s.checkpoint!.id, 'agent-failure');
  assert.deepEqual(s.proposed!.map((c) => c.file), ['.claude/rules/forms.md'], 'kept, not lost');
  apply({ type: 'checkpoint_answered', id: 'agent-failure', option: 'retry' });
  apply({ type: 'stage_started', agent: 'developer', repo: 'api' });
  s = apply({ type: 'stage_completed', agent: 'developer', repo: 'api', artifact: 'reports/r1/developer-api.md', gates: 'pass', protectedChanges: [{ repo: 'api', file: '.claude/rules/forms.md' }, { repo: 'api', file: '.mcp.json' }] });
  assert.equal(s.checkpoint!.id, 'protected-changes', 'they come up when the step ends well');
  assert.deepEqual(s.proposed!.map((c) => [c.file, c.artifact ?? null]), [['.claude/rules/forms.md', 'proposed/r1/web/.claude/rules/forms.md'], ['.mcp.json', null]]);
  // Retry: the step runs again to write what it tried with a command; what it kept still waits.
  s = apply({ type: 'checkpoint_answered', id: 'protected-changes', option: 'retry' });
  assert.deepEqual(s.next, { stage: 1, agent: 'developer', repo: 'api' });
  assert.equal(s.nextMode, 'retry');
  assert.equal(s.proposed!.length, 2);
});

/** The task through its first review, with these findings. */
function reviewed(findings: { severity: 'blocker' | 'major' | 'minor'; repo?: string; file?: string; problem: string; yours?: boolean }[]) {
  const apply = task();
  for (const repo of ['api', 'web']) {
    apply({ type: 'stage_started', agent: 'developer', repo });
    apply({ type: 'stage_completed', agent: 'developer', repo, artifact: `reports/r1/developer-${repo}.md`, gates: 'pass' });
  }
  apply({ type: 'stage_started', agent: 'tester' });
  apply({ type: 'stage_completed', agent: 'tester', artifact: 'reports/r1/tester.md', gates: 'pass' });
  apply({ type: 'stage_started', agent: 'reviewer' });
  return { apply, s: apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'reviews/r1/reviewer.md', verdict: { status: 'changes_requested', summary: 'x', findings } }) };
}

test('machine: blocking findings only about the settings go to you, not into a fix round no agent could do', () => {
  const { apply, s } = reviewed([{ severity: 'major', repo: 'web', file: '.claude/rules/forms.md', problem: 'missing', yours: true }, { severity: 'minor', repo: 'api', file: 'src/a.ts', problem: 'naming' }]);
  assert.equal(s.checkpoint!.id, 'review-limit');
  assert.match(s.checkpoint!.reason!, /web\/\.claude\/rules\/forms\.md\), which no agent changes/);
  assert.equal(s.review.round, 1, 'no fix round was started');
  // You made the change: another round reviews again without sending a developer back.
  const again = apply({ type: 'checkpoint_answered', id: 'review-limit', option: 'retry' });
  assert.deepEqual(again.review.fixRepos, []);
  assert.deepEqual(again.next, { stage: 2, agent: 'tester' });
});

test('machine: with findings an agent can fix too, the fix round goes to their repos only', () => {
  const { s } = reviewed([{ severity: 'major', repo: 'web', file: '.claude/rules/forms.md', problem: 'missing', yours: true }, { severity: 'major', repo: 'api', file: 'src/a.ts', problem: 'bug' }]);
  assert.equal(s.checkpoint, null);
  assert.equal(s.review.round, 2);
  assert.deepEqual(s.review.fixRepos, ['api']);
});

test('machine: a log written before findings were marked yours replays as it was decided: a fix round', () => {
  // T-20261102-1010: a major finding about .claude/skills, then the fix round that version started.
  const { apply, s } = reviewed([{ severity: 'major', repo: 'web', file: '.claude/skills', problem: 'missing' }, { severity: 'minor', repo: 'web', file: 'a.spec.ts', problem: 'naming' }]);
  assert.equal(s.checkpoint, null, 'no question the old log never answered');
  assert.equal(s.review.round, 2);
  assert.deepEqual(s.review.fixRepos, ['web']);
  apply({ type: 'stage_started', agent: 'developer', repo: 'web' });
});

// ---------- prompts and the push question ----------

test('prompt: code, plan and review stages hear that the settings go to the user', () => {
  const state = { taskId: 'T-1', spec: { title: 'x' }, instructions: [], source: { kind: 'text' } } as unknown as TaskState;
  const run = (output: string): string => buildAgentPrompt({ state, next: { step: { stage: 0, agent: 'a', repo: 'api' }, mode: 'initial', round: 1, inputs: [], output, feedback: null } as unknown as RunAction, taskDir: '/ws/.orch/tasks/T-1', language: 'English', repoDir: '/ws/api' });
  assert.match(run('code'), /\.claude\/, \.mcp\.json, \.vscode\/\) are not yours to write.*make it with the Write or Edit tool all the same.*it is no blocker/);
  assert.match(run('tests'), /make it with the Write or Edit tool all the same/);
  assert.match(run('plan'), /goes to the user to apply/);
  assert.match(run('verdict'), /a finding about one goes to the user\. Give such a finding its file/);
});

test('secrets: a pushed change to the settings is named with the hooks', () => {
  const diff = ['.claude/rules/forms.md', '.mcp.json', '.vscode/tasks.json', 'src/.claude.ts'].map((f) => `+++ b/${f}\n@@ -0,0 +1 @@\n+x\n`).join('');
  assert.deepEqual(scanDiff(diff).hooks, ['.claude/rules/forms.md', '.mcp.json', '.vscode/tasks.json']);
});

// ---------- the engine, end to end ----------

const FILES = { '.claude/rules/forms.md': 'Forms use the shared validator.\n', '.mcp.json': '{"mcpServers": {}}\n' };

test('engine: what an agent writes of the settings is refused, kept and applied as you confirm', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_DEV_FILES: JSON.stringify(FILES) });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'protected-changes', JSON.stringify(h.engine.lastError(taskId)));
    const api = path.join(ws, 'api');
    for (const f of Object.keys(FILES)) assert.ok(!fs.existsSync(path.join(api, f)), `${f} was not written by the agent`);
    const ctx = await h.engine.checkpointContext(s, s.checkpoint);
    assert.equal(ctx.canApply, true);
    assert.deepEqual(ctx.protectedChanges!.map((c) => [c.file, c.before, c.after, c.instructionsOnly]), [
      ['.claude/rules/forms.md', null, FILES['.claude/rules/forms.md'], true],
      ['.mcp.json', null, FILES['.mcp.json'], false],
    ]);
    await h.engine.answer(taskId, 'protected-changes', 'apply');
    for (const [f, content] of Object.entries(FILES)) assert.equal(fs.readFileSync(path.join(api, f), 'utf8'), content, f);
    s = await waitFor(async () => {
      const st = await h.engine.svc.state(taskId);
      return !h.engine.isRunning(taskId) && st.checkpoint ? st : null;
    }, 60000);
    assert.equal(s.checkpoint!.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    const push = await h.engine.checkpointContext(s, s.checkpoint);
    assert.deepEqual(push.hooks!.map((x) => x.file).sort(), ['.claude/rules/forms.md', '.mcp.json'], 'the push question names them');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: policy.protectedChanges rules applies a rule at once and asks about the rest; off applies nothing', { skip: process.platform === 'win32' }, async () => {
  const rules = workspace(['api'], 'repos:\n  api: {}\npolicy:\n  protectedChanges: rules\n');
  const h = await harness(rules, { FAKE_REPOS: 'api', FAKE_DEV_FILES: JSON.stringify(FILES) });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(fs.readFileSync(path.join(rules, 'api', '.claude/rules/forms.md'), 'utf8'), FILES['.claude/rules/forms.md'], 'the rule is in');
    assert.deepEqual(s.proposed!.map((c) => c.file), ['.mcp.json'], 'the MCP config waits for you');
    assert.ok((await h.engine.svc.events(taskId)).some((e) => e.type === 'note' && /Applied api\/\.claude\/rules\/forms\.md/.test(e.message)));
  } finally {
    h.hooks.dispose();
  }
  const off = workspace(['api'], 'repos:\n  api: {}\npolicy:\n  protectedChanges: off\n');
  const o = await harness(off, { FAKE_REPOS: 'api', FAKE_DEV_FILES: JSON.stringify(FILES) });
  try {
    const { taskId } = await o.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(o.engine, taskId);
    assert.equal(s.checkpoint!.id, 'protected-changes', 'you still hear of them');
    assert.equal((await o.engine.checkpointContext(s, s.checkpoint)).canApply, false);
    await assert.rejects(o.engine.answer(taskId, 'protected-changes', 'apply'), /does not apply changes/);
    assert.ok(!fs.existsSync(path.join(off, 'api', '.mcp.json')));
    assert.equal((await o.engine.svc.state(taskId)).checkpoint!.id, 'protected-changes', 'the question stays open');
  } finally {
    o.hooks.dispose();
  }
});

test('engine: a change tried with a command the sandbox refused comes up without content; a retry is told to use the file tools', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const shell = [{ command: 'git apply forms.patch', output: 'error: unable to create file .claude/rules/forms.md: Operation not permitted' }];
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_DEV_SHELL: JSON.stringify(shell), FAKE_DEV_FILES: JSON.stringify({ '.mcp.json': '{}\n' }) });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'protected-changes', JSON.stringify(h.engine.lastError(taskId)));
    const ctx = await h.engine.checkpointContext(s, s.checkpoint);
    assert.deepEqual(ctx.protectedChanges!.map((c) => [c.file, c.after]), [['.mcp.json', '{}\n'], ['.claude/rules/forms.md', null]]);
    await h.engine.answer(taskId, 'protected-changes', 'retry');
    s = await waitFor(async () => {
      const st = await h.engine.svc.state(taskId);
      return !h.engine.isRunning(taskId) && st.checkpoint ? st : null;
    }, 60000);
    const prompts = h.outputs.filter((o) => o.item.type === 'prompt').map((o) => String((o.item as { text?: unknown }).text));
    assert.ok(prompts.some((p) => /Your last attempt changed api\/\.claude\/rules\/forms\.md with a shell command, which the sandbox refused/.test(p)), 'the retry heard what to do differently');
    assert.equal(s.checkpoint!.id, 'protected-changes', 'the kept change still waits');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: the review records which findings are yours, and such a review comes to you', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_REVIEW: 'fail-once', FAKE_REVIEW_FILE: '.claude/rules/forms.md' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'review-limit', JSON.stringify(h.engine.lastError(taskId)));
    const review = (await h.engine.svc.events(taskId)).find((e) => e.type === 'stage_completed' && e.agent === 'reviewer');
    assert.ok(review && review.type === 'stage_completed');
    assert.deepEqual(review.verdict!.findings.map((f) => [f.file, f.yours ?? false]), [['.claude/rules/forms.md', true]]);
    assert.deepEqual((await h.engine.checkpointContext(s, s.checkpoint)).humanFiles, ['api/.claude/rules/forms.md']);
  } finally {
    h.hooks.dispose();
  }
});

test('engine: applying writes only in the repo, never through a link', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, {});
  try {
    const api = path.join(ws, 'api');
    fs.mkdirSync(path.join(api, '.claude'));
    fs.symlinkSync(path.join(ws, 'elsewhere.json'), path.join(api, '.claude', 'settings.json'));
    await assert.rejects(h.engine.writeProtected(api, '.claude/settings.json', '{}'), /leads out of the repo/);
    fs.writeFileSync(path.join(ws, 'inside.json'), '');
    fs.mkdirSync(path.join(api, '.vscode'));
    fs.symlinkSync('../README.md', path.join(api, '.vscode', 'settings.json'));
    await assert.rejects(h.engine.writeProtected(api, '.vscode/settings.json', '{}'), /a link/, 'nor through one that stays in the repo');
    assert.equal(fs.readFileSync(path.join(api, 'README.md'), 'utf8'), '# api\n');
    assert.ok(!fs.existsSync(path.join(ws, 'elsewhere.json')));
    await assert.rejects(h.engine.writeProtected(api, '.claude/../../x.md', 'x'), /not a file of the repo's settings/);
    await assert.rejects(h.engine.writeProtected(api, 'src/a.ts', 'x'), /not a file of the repo's settings/);
    await h.engine.writeProtected(api, '.claude/rules/web/forms.md', 'ok\n');
    assert.equal(fs.readFileSync(path.join(api, '.claude/rules/web/forms.md'), 'utf8'), 'ok\n');
  } finally {
    h.hooks.dispose();
  }
});
