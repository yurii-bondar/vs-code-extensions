// End to end: the real engine, runner, hook server and hook script against a fake Claude CLI and real git repos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { Engine } = require('../src/core/engine');
const { ClaudeRunner } = require('../src/core/runner');
const { HookServer, writeHookSettings } = require('../src/core/hookserver');
const { setChildEnv } = require('../src/core/git');
const view = require('../src/core/view');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const HOOK = path.join(__dirname, '..', 'hook', 'pretooluse.js');
fs.chmodSync(FAKE, 0o755);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function workspace(repos, configYaml) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-')));
  for (const name of repos) {
    const dir = path.join(ws, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  }
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), configYaml);
  return ws;
}

async function harness(ws, env = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fake-state-'));
  setChildEnv({ ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', FAKE_STATE: state, FAKE_LOG: path.join(state, 'calls.ndjson'), ...env });
  const hooks = new HookServer();
  await hooks.listen();
  const settings = writeHookSettings(path.join(state, 'hook-settings.json'), { node: process.execPath, script: HOOK });
  const runner = new ClaudeRunner({ command: () => FAKE, flags: () => new Set(['--include-partial-messages', '--tools', '--setting-sources', '--name', '--effort']), settingSources: () => ['project'], hookSettings: () => settings, env: () => ({}) });
  const engine = new Engine({ workspace: ws, home: state, runner, hooks });
  const outputs = [];
  engine.on('output', (o) => outputs.push(o));
  const calls = () => fs.readFileSync(path.join(state, 'calls.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { engine, hooks, outputs, state, calls };
}

const waitFor = async (fn, ms = 20000) => {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
};

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
    const { taskId, created } = h.engine.start({ text: 'Add the feature everywhere', effort: { reviewer: 'low' } });
    assert.ok(created);
    assert.match(taskId, /^T-\d{8}-\d{4}$/);

    let s = await h.engine.run(taskId);
    assert.equal(s.checkpoint.id, 'approve-plan');
    const ctx = await h.engine.checkpointContext(s, s.checkpoint);
    assert.match(ctx.text, /## Summary/);

    await h.engine.answer(taskId, 'approve-plan', 'approve');
    s = await waitFor(() => {
      const st = h.engine.svc.state(taskId);
      return !h.engine.isRunning(taskId) && st.checkpoint ? st : null;
    }, 60000);
    assert.equal(s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));

    // Branches, commits and what was kept out of them.
    for (const repo of ['api', 'web']) {
      const dir = path.join(ws, repo);
      assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/add-feature');
      assert.equal(git(dir, 'log', '-1', '--format=%s'), 'feat: add the feature');
      assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['feature.test.txt', 'feature.txt']);
    }
    assert.ok(!fs.existsSync(path.join(ws, 'outside.txt')), 'a write outside the repo was denied');

    const events = h.engine.svc.events(taskId);
    const gates = events.filter((e) => e.type === 'gates_ran' && e.repo === 'web').map((e) => e.status);
    assert.ok(gates.includes('fail') && gates.includes('pass'), `web gates went red then green: ${gates}`);
    assert.equal(events.filter((e) => e.type === 'stage_started' && e.agent === 'reviewer').length, 2, 'one fix round');
    const fixRound = events.filter((e) => e.type === 'stage_started' && e.agent === 'developer').map((e) => e.repo);
    assert.deepEqual(fixRound, ['api', 'web', 'web'], 'the fix round only re-ran the repo with findings');
    const testers = events.filter((e) => e.type === 'stage_started' && e.agent === 'tester');
    assert.deepEqual(testers.map((e) => e.repo), [undefined, undefined], 'one tester per round, across all repos');
    const order = events.filter((e) => e.type === 'stage_started').map((e) => `${e.agent}${e.repo ? `@${e.repo}` : ''}`);
    assert.deepEqual(order.slice(0, 5), ['planner', 'developer@api', 'developer@web', 'tester', 'reviewer']);
    const testerPrompt = h.engine.svc.readTranscript(taskId, view.detail(h.engine, taskId).steps.find((st) => st.agent === 'tester').key).find((i) => i.type === 'prompt').text;
    assert.match(testerPrompt, /Repositories of this task[^\n]*\n- api at .+\n- web at /);

    // The guard fed denials back into the transcript.
    const blocked = h.outputs.filter((o) => o.item.type === 'blocked').map((o) => o.item.reason);
    assert.ok(blocked.some((r) => /agents do not run git commit/.test(r)));
    assert.ok(blocked.some((r) => /outside/.test(r)));
    assert.ok(h.outputs.some((o) => o.item.type === 'text_delta'));

    // Agent CLI calls carried the agent's settings.
    const planner = h.calls().find((c) => c.args.includes('--model') && c.args[c.args.indexOf('--model') + 1] === 'opus');
    assert.ok(planner.args.includes('--tools'));
    assert.equal(planner.args[planner.args.indexOf('--effort') + 1], 'max', 'the agent runs at its effort');
    const efforts = h.calls().filter((c) => c.args.includes('--append-system-prompt')).map((c) => (c.args.includes('--effort') ? c.args[c.args.indexOf('--effort') + 1] : null));
    assert.ok(efforts.includes('low'), 'the task override reached the reviewer');
    assert.ok(efforts.every((e) => e === null || e === 'max' || e === 'low'), `agents without an effort use the default: ${efforts}`);
    assert.equal(view.detail(h.engine, taskId).steps.find((st) => st.agent === 'reviewer').effort, 'low');
    assert.deepEqual(h.engine.limits.fiveHour, { pct: 31, resetsAt: 1900000000, status: 'allowed' });
    assert.equal(h.engine.limits.sevenDay.pct, 26);
    assert.ok(h.outputs.some((o) => o.item.type === 'usage' && o.item.ctxPct > 0 && o.item.tokens > 0));
    assert.equal(planner.args[planner.args.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash');

    const d = view.detail(h.engine, taskId);
    assert.equal(d.status.key, 'waiting');
    assert.ok(d.cost > 0);
    assert.ok(d.steps.some((st) => st.kind === 'agent' && st.agent === 'reviewer' && st.verdict && st.verdict.status === 'changes_requested'));
    const plannerStep = d.steps.find((st) => st.agent === 'planner');
    assert.equal(plannerStep.effort, 'max');
    assert.equal(plannerStep.model, 'claude-opus-5-5', 'the model the session really ran, not the alias');
    const devStep = d.steps.find((st) => st.agent === 'developer');
    assert.equal(devStep.effort, 'medium', 'an agent left at the default shows the effort it really ran with');
    assert.ok(plannerStep.ctxPct > 0 && plannerStep.tokens > 0);
    const transcript = h.engine.svc.readTranscript(taskId, d.steps.find((st) => st.agent === 'developer').key);
    assert.ok(transcript.some((i) => i.type === 'prompt'));
    const web = h.engine.svc.readTranscript(taskId, d.steps.filter((st) => st.agent === 'developer' && st.repo === 'web')[0].key);
    assert.ok(web.some((i) => i.type === 'gates' && i.status === 'fail'));
    assert.ok(web.some((i) => i.type === 'user' && i.from === 'orchestrator' && /Gates failed/.test(i.text)));

    await h.engine.answer(taskId, 'confirm-push', 'local');
    s = await waitFor(() => (h.engine.isRunning(taskId) ? null : h.engine.svc.state(taskId)));
    assert.equal(s.status, 'done');
    assert.equal(s.outcome, 'local');
    assert.equal(view.summary(h.engine, { taskId, state: s }).status.label, 'Kept local');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: dirty checkouts block branch mode, stop interrupts a hanging agent, resume re-runs the step', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  fs.writeFileSync(path.join(ws, 'api', 'wip.txt'), 'uncommitted');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = h.engine.start({ text: 'Do a thing --auto' });
    h.engine.launch(taskId);
    await waitFor(() => h.engine.lastError(taskId));
    assert.equal(h.engine.lastError(taskId).code, 'repos_not_ready');
    assert.equal(h.engine.lastError(taskId).blocked[0].problem, 'uncommitted changes');
    assert.equal(view.summary(h.engine, { taskId, state: h.engine.svc.state(taskId) }).status.key, 'failed');

    fs.rmSync(path.join(ws, 'api', 'wip.txt'));
    setChildEnv({ ...require('../src/core/git').getChildEnv(), FAKE_HANG: 'developer' });
    h.engine.launch(taskId);
    await waitFor(() => h.engine.sessions.has(taskId) && h.engine.live(taskId) && h.engine.live(taskId).phase === 'agent' && h.engine.live(taskId).step.agent === 'developer');
    await h.engine.stop(taskId);
    await waitFor(() => !h.engine.isRunning(taskId));
    let s = h.engine.svc.state(taskId);
    assert.equal(s.status, 'stopped');
    assert.equal(s.running.agent, 'developer', 'the interrupted step stays the running one');
    assert.equal(view.summary(h.engine, { taskId, state: s }).mini.find((m) => m.agent === 'developer').status, 'paused');

    setChildEnv({ ...require('../src/core/git').getChildEnv(), FAKE_HANG: '' });
    h.engine.resume(taskId);
    s = await waitFor(() => (!h.engine.isRunning(taskId) && h.engine.svc.state(taskId).checkpoint ? h.engine.svc.state(taskId) : null), 30000);
    assert.equal(s.checkpoint.id, 'confirm-push');
    assert.equal(h.engine.svc.events(taskId).filter((e) => e.type === 'stage_started' && e.agent === 'developer').length, 1, 'resume continued the same step');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: ask-me mode routes tool calls to the user', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner, developer]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  h.engine.askPermissions = () => true;
  const asked = [];
  h.engine.on('permission', (req) => {
    asked.push(req);
    h.engine.permissionReply(req.requestId, req.tool !== 'Write' || !/feature\.txt$/.test(req.input.file_path), 'not this file');
  });
  try {
    const { taskId } = h.engine.start({ text: 'Small thing', auto: true });
    const s = await h.engine.run(taskId);
    assert.equal(s.checkpoint.id, 'confirm-push');
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
    const { taskId } = h.engine.start({ text: 'Outside repo', auto: true });
    const s = await h.engine.run(taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/add-feature');
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'feat: add the feature');
    assert.equal(h.engine.svc.events(taskId).find((e) => e.type === 'gates_ran').status, 'pass');
    assert.ok(!fs.existsSync(path.join(ws, 'billing')), 'nothing was created inside the workspace for it');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a Jira task is read through an Atlassian MCP server when there is no API token, read-only', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  h.engine.mcpIntake = () => ({ server: 'Atlassian', site: 'acme.atlassian.net' });
  try {
    const { taskId } = h.engine.start({ text: 'PROJ-805' });
    assert.equal(taskId, 'PROJ-805');
    await h.engine.run(taskId);
    const s = h.engine.svc.state(taskId);
    assert.equal(s.phase, 'done', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(s.spec.title, 'PROJ-805 Cap the max bet');
    assert.deepEqual(s.spec.acceptanceCriteria, ['bets above the cap are rejected'], 'criteria fall back to the description');
    assert.equal(s.spec.links[0].url, 'https://acme.atlassian.net/browse/PROJ-805');
    assert.match(h.engine.svc.readArtifact(taskId, 'ticket.md'), /per operator, not global/);
    const intake = h.engine.svc.readTranscript(taskId, '0000-intake');
    assert.ok(intake.some((i) => i.type === 'tool_use' && i.name === 'mcp__Atlassian__getJiraIssue'));
    assert.ok(intake.some((i) => i.type === 'blocked' && i.tool === 'mcp__Atlassian__addCommentToJiraIssue'), 'writes to Jira are blocked');
    const step = view.detail(h.engine, taskId).steps[0];
    assert.equal(step.kind, 'intake');
    assert.equal(step.key, '0000-intake');
    assert.equal(step.model, 'claude-haiku-5-5');
    const call = h.calls().find((c) => c.args.includes('--effort') && c.args[c.args.indexOf('--effort') + 1] === 'low');
    assert.ok(call, 'the intake runs on a small, quick setting');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a signed-out Claude Code is reported as such, and agents get the account MCP servers', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_AUTH_FAIL: '1' });
  h.engine.mcpIntake = () => ({ server: 'Atlassian' });
  try {
    const { taskId } = h.engine.start({ text: 'PROJ-9' });
    h.engine.launch(taskId);
    await waitFor(() => h.engine.lastError(taskId));
    assert.equal(h.engine.lastError(taskId).code, 'claude_login');
    assert.match(h.engine.lastError(taskId).message, /signed out/);
  } finally {
    h.hooks.dispose();
  }
  const { buildArgs } = require('../src/core/runner');
  const base = { flags: () => new Set(['--mcp-config']), hookSettings: () => '/h.json', mcpConfig: () => '/m.json' };
  assert.ok(buildArgs({ agent: {} }, { ...base, settingSources: () => ['project', 'local'] }).includes('/m.json'), 'without the user source, MCP servers come in explicitly');
  assert.ok(!buildArgs({ agent: {} }, { ...base, settingSources: () => ['user', 'project'] }).includes('--mcp-config'), 'with it, Claude Code loads them itself');
  const { writeUserMcpConfig } = require('../src/core/mcp');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-acc-'));
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { Grafana: { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer t' } } } }));
  const file = writeUserMcpConfig(path.join(cfg, 'out', 'mcp.json'), cfg);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers), ['Grafana']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'it carries tokens, so only you can read it');
});

test('engine: "PROJ-805 перевір готовність…" runs a read-only readiness check, writes the report and posts it to Jira via MCP', async () => {
  const ws = workspace(['api'], 'repos:\n  api: { role: Betting API }\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  h.engine.mcpIntake = () => ({ server: 'Atlassian', site: 'acme.atlassian.net' });
  try {
    const text = 'PROJ-805 перевір готовність виконання таски і закриття всіх критеріїв приймання';
    const p = h.engine.preview({ text });
    assert.equal(p.scenario, 'readiness');
    assert.ok(p.scenarioDetected, 'picked from the words');
    assert.equal(p.source.kind, 'jira');
    assert.equal(p.taskId, 'PROJ-805-check', 'next to the delivery task PROJ-805, not on top of it');
    assert.deepEqual(p.pipeline.stages.map((st) => st.agent), ['verifier']);

    const { taskId } = h.engine.start({ text });
    const s = await h.engine.run(taskId);
    assert.equal(s.status, 'done', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(s.scenario, 'readiness');
    assert.equal(s.reports[0].value.verdict, 'not_ready', 'a criterion is not met and a gap is high');
    assert.match(h.engine.svc.readArtifact(taskId, 'ticket.md'), /## What the user asked\n\nперевір готовність/);

    const prompt = fs.readFileSync(path.join(h.state, 'prompt-verifier.txt'), 'utf8');
    assert.match(prompt, new RegExp(`- api at ${path.join(ws, 'api').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(base branch main\\): Betting API`));
    assert.match(prompt, /Jira issue: PROJ-805/);
    assert.ok(!fs.existsSync(path.join(ws, 'api', 'audit-notes.txt')), 'the verifier cannot write');
    assert.ok(h.outputs.some((o) => o.item.type === 'blocked' && /does not change files/.test(o.item.reason)));
    assert.equal(git(path.join(ws, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'no branch was made');

    const report = h.engine.svc.readArtifact(taskId, 'report.md');
    assert.match(report, /Not ready/);
    assert.match(report, /\| ❌ \| the cap is per operator \| not met \|/);
    const d = view.detail(h.engine, taskId);
    assert.equal(d.status.label, 'Not ready');
    assert.equal(d.result.kind, 'readiness');
    assert.equal(d.result.met, 1);
    assert.equal(d.steps.find((st) => st.agent === 'verifier').readiness.verdict, 'not_ready');
    assert.ok(!d.steps.some((st) => st.kind === 'finish'), 'no commit or PR steps');

    const r = await h.engine.postReport(taskId);
    assert.ok(r.ok, JSON.stringify(r));
    const posted = fs.readFileSync(path.join(h.state, 'comment-PROJ-805.txt'), 'utf8');
    assert.match(posted, /^Readiness check: ❌ Not ready \(1\/2 met\)/);
    assert.match(posted, /\[high\] no test for the cap/);
    const comments = view.detail(h.engine, taskId).comments;
    assert.deepEqual(comments.map((c) => [c.what, c.ok, c.via]), [['report', true, 'mcp:Atlassian']]);
    const commentLog = h.engine.svc.readTranscript(taskId, 'comment-1');
    assert.ok(commentLog.some((i) => i.type === 'blocked' && i.tool === 'mcp__Atlassian__editJiraIssue'), 'nothing but the comment is written');
    assert.equal(commentLog.filter((i) => i.type === 'blocked' && i.tool === 'mcp__Atlassian__addCommentToJiraIssue').length, 1, 'and only once');

    // Checking again after it finished is a new run.
    assert.equal(h.engine.preview({ text }).taskId, 'PROJ-805-check-2');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: an audit finds bugs and bottlenecks, rates them and reports; a Jira comment without a connection is recorded as failed', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const text = 'Аудит проекту на вузькі місця, перформанс і помилки';
    assert.equal(h.engine.preview({ text }).scenario, 'audit');
    assert.equal(h.engine.preview({ text: 'Add caching to the report endpoint' }).scenario, 'deliver');
    assert.equal(h.engine.preview({ text: 'Add caching', scenario: 'audit' }).scenario, 'audit', 'a choice in the composer wins');
    const { taskId } = h.engine.start({ text });
    assert.match(taskId, /^AUDIT-\d{8}-\d{4}$/);
    const s = await h.engine.run(taskId);
    assert.equal(s.status, 'done', JSON.stringify(h.engine.lastError(taskId)));
    const d = view.detail(h.engine, taskId);
    assert.deepEqual(d.result.findings.map((f) => f.severity), ['critical', 'medium'], 'worst first');
    assert.deepEqual(d.result.counts, { critical: 1, high: 0, medium: 1, low: 0 });
    assert.equal(d.status.label, '2 findings · 1 serious');
    assert.equal(d.status.tone, 'error');
    const report = h.engine.svc.readArtifact(taskId, 'report.md');
    assert.match(report, /\*\*Critical: 1\*\* · \*\*High: 0\*\* · \*\*Medium: 1\*\* · \*\*Low: 0\*\*/);
    assert.match(report, /### 1\. Payout can be negative/);
    assert.ok(d.files.some((f) => f.path === 'audit/auditor.md'));

    await assert.rejects(h.engine.postReport(taskId), /not come from a Jira issue/);
    const r = await h.engine.comment({ ...s, source: { kind: 'jira', key: 'PROJ-1' } }, 'hello', 'report');
    assert.equal(r.ok, false);
    assert.match(r.error, /Jira is not connected/);
    assert.equal(view.detail(h.engine, taskId).comments[0].ok, false, 'a failure is visible on the task, not only in a log');
  } finally {
    h.hooks.dispose();
  }
});
