const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { transition, replay, nextAction, passSteps } = require('../src/core/machine');
const { buildPipeline, outline } = require('../src/core/pipeline');
const config = require('../src/core/config');
const { parseStageReport } = require('../src/core/prompt');
const { guardBash } = require('../src/core/guard');
const { parseInvocation, classifyInput, extractAcceptanceCriteria, adfToText } = require('../src/core/intake');
const { TaskService } = require('../src/core/store');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function defaultPipeline(opts) {
  const r = config.resolveConfig([config.builtinLayer()]);
  assert.ok(r.ok);
  return { config: r.config, pipeline: buildPipeline(r.config, opts) };
}

const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function createdEvent(pipeline, { source = { kind: 'text', text: 'x' }, knownRepos = ['api', 'web'] } = {}) {
  return { type: 'task_created', taskId: 'T-1', input: 'x', source, auto: false, pipeline, limits: { reviewRounds: 2, gateAttempts: 3 }, knownRepos, at: at(0) };
}

const PLAN = { type: 'feat', slug: 'max-bet', title: 'add max bet', repos: [{ name: 'api', mode: 'full' }, { name: 'web', mode: 'full' }], openQuestions: [] };
const spec = { id: 'T-1', source: { kind: 'text', text: 'x' }, title: 'x', description: 'x', acceptanceCriteria: [], links: [] };

test('pipeline: the built-in agents make a full pipeline with a review loop', () => {
  const { pipeline } = defaultPipeline();
  assert.equal(pipeline.mode, 'full');
  assert.deepEqual(pipeline.stages.map((s) => [s.agent, s.scope, s.approval]), [
    ['planner', 'task', true],
    ['developer', 'repo', false],
    ['tester', 'repo', false],
    ['reviewer', 'task', false],
  ]);
  assert.deepEqual(pipeline.reviewLoop, { restartAt: 1, end: 3, fixers: ['developer', 'tester'], reviewers: ['reviewer'], maxRounds: 2 });
  assert.deepEqual(outline(pipeline).map((o) => o.kind), ['stage', 'human', 'loop-start', 'repo-block', 'stage', 'loop-end', 'finish', 'human', 'finish']);
  assert.equal(buildPipeline(defaultPipeline().config, { auto: true }).stages[0].approval, false);
});

test('machine: plan → approval → per-repo work → review fix round → commit → push', () => {
  const { pipeline } = defaultPipeline();
  let s = null;
  let n = 0;
  const apply = (e) => {
    const r = transition(s, { ...e, at: at(++n) });
    assert.ok(r.ok, r.error && r.error.message);
    s = r.state;
    return s;
  };
  apply(createdEvent(pipeline));
  assert.equal(nextAction(s).kind, 'intake');
  apply({ type: 'intake_completed', spec });
  assert.deepEqual(s.next, { stage: 0, agent: 'planner' });

  // Out-of-order events are rejected.
  assert.equal(transition(s, { type: 'stage_started', agent: 'developer', repo: 'api', at: at(99) }).ok, false);

  apply({ type: 'stage_started', agent: 'planner' });
  assert.equal(transition(s, { type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', at: at(99) }).error.code, 'plan_meta_required');
  apply({ type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: PLAN });
  assert.equal(s.status, 'waiting');
  assert.deepEqual(s.checkpoint.options, ['approve', 'change', 'stop'], 'jira-only options are dropped for text tasks');
  assert.equal(transition(s, { type: 'stage_started', agent: 'developer', repo: 'api', at: at(99) }).error.code, 'awaiting_checkpoint');

  apply({ type: 'checkpoint_answered', id: 'approve-plan', option: 'approve' });
  assert.deepEqual(passSteps(s).map((p) => `${p.agent}@${p.repo || ''}`), ['planner@', 'developer@api', 'tester@api', 'developer@web', 'tester@web', 'reviewer@']);
  for (const repo of ['api', 'web']) {
    for (const agent of ['developer', 'tester']) {
      apply({ type: 'stage_started', agent, repo });
      apply({ type: 'stage_completed', agent, repo, artifact: `reports/r1/${agent}-${repo}.md`, gates: 'pass' });
    }
  }
  apply({ type: 'stage_started', agent: 'reviewer' });
  apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'reviews/r1/reviewer.md', verdict: { status: 'changes_requested', summary: 'x', findings: [{ severity: 'major', repo: 'web', problem: 'no test' }, { severity: 'minor', problem: 'naming' }] } });
  // Fix round 2 targets only the repo with blocking findings.
  assert.equal(s.review.round, 2);
  assert.deepEqual(s.review.fixRepos, ['web']);
  const run = nextAction(s);
  assert.equal(run.kind, 'run');
  assert.equal(run.mode, 'fix');
  assert.ok(run.inputs.includes('reviews/r1/reviewer.md'));
  for (const agent of ['developer', 'tester']) {
    apply({ type: 'stage_started', agent, repo: 'web' });
    apply({ type: 'stage_completed', agent, repo: 'web', artifact: `reports/r2/${agent}-web.md`, gates: 'pass' });
  }
  apply({ type: 'stage_started', agent: 'reviewer' });
  apply({ type: 'stage_completed', agent: 'reviewer', artifact: 'reviews/r2/reviewer.md', verdict: { status: 'approved', summary: 'ok', findings: [{ severity: 'minor', repo: 'web', problem: 'typo' }] } });
  assert.equal(s.phase, 'finish');
  assert.equal(nextAction(s).kind, 'commit');
  assert.equal(s.review.openFindings.length, 1);

  assert.equal(transition(s, { type: 'published', prs: {}, at: at(99) }).error.code, 'push_not_confirmed');
  apply({ type: 'committed', repos: ['api', 'web'] });
  assert.equal(s.checkpoint.id, 'confirm-push');
  apply({ type: 'checkpoint_answered', id: 'confirm-push', option: 'push' });
  assert.equal(nextAction(s).kind, 'publish');
  apply({ type: 'published', prs: { api: 'https://x/1', web: 'https://x/2' } });
  assert.equal(s.status, 'done');
  assert.equal(s.outcome, 'published');
});

test('machine: review limit, stop keeps the question, resume asks again', () => {
  const { pipeline } = defaultPipeline();
  const events = [createdEvent(pipeline, { knownRepos: [] }), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_completed', agent: 'planner', artifact: 'p', plan: { ...PLAN, repos: [{ name: 'api', mode: 'full' }] } }];
  events.push({ type: 'checkpoint_answered', id: 'approve-plan', option: 'stop' });
  let s = replay(events.map((e, i) => ({ ...e, at: at(i) })));
  assert.equal(s.status, 'stopped');
  assert.equal(nextAction(s).kind, 'stopped');
  s = transition(s, { type: 'resumed', at: at(50) }).state;
  assert.equal(s.status, 'waiting');
  assert.equal(s.checkpoint.id, 'approve-plan');
});

test('machine: a failed agent opens agent-failure and retry runs the same step', () => {
  const { pipeline } = defaultPipeline();
  let s = replay([createdEvent(pipeline), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_failed', agent: 'planner', error: 'boom' }].map((e, i) => ({ ...e, at: at(i) })));
  assert.equal(s.checkpoint.id, 'agent-failure');
  assert.equal(s.checkpoint.reason, 'boom');
  s = transition(s, { type: 'checkpoint_answered', id: 'agent-failure', option: 'retry', feedback: 'try harder', at: at(9) }).state;
  const next = nextAction(s);
  assert.equal(next.mode, 'retry');
  assert.equal(next.feedback, 'try harder');
});

test('config: project layer overrides, extends, flags and comment-preserving edits', () => {
  const ws = tmp('cs-config-');
  const home = tmp('cs-home-');
  fs.mkdirSync(path.join(ws, '.claudestrator', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claudestrator', 'prompts', 'security.md'), 'Look for security holes.');
  fs.writeFileSync(
    path.join(ws, '.claudestrator', 'config.yaml'),
    `# team config
agents:
  tester: { enabled: false }
  security:
    extends: reviewer
    instructions: { mode: append, file: ./prompts/security.md }
pipeline: [planner, developer, tester, reviewer, security]
language: Ukrainian
repos:
  api:
    role: Backend
    gates:
      - { name: lint, cmd: npm run lint }
`
  );
  const r = config.loadConfig({ workspace: ws, home });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.config.language, 'Ukrainian');
  assert.equal(r.config.agents.tester.enabled, false);
  assert.equal(r.config.agents.security.output, 'verdict');
  assert.deepEqual(r.config.agents.security.lineage, ['reviewer', 'security']);
  assert.match(r.config.agents.security.instructions, /fresh eyes[\s\S]*security holes/);
  assert.equal(r.config.repos.api.baseBranch, 'main');
  assert.equal(buildPipeline(r.config).reviewLoop.reviewers.join(','), 'reviewer,security');

  const flagged = config.loadConfig({ workspace: ws, home, flags: { no: ['nope'] } });
  assert.equal(flagged.ok, false);

  config.updateAgentConfig(ws, 'planner', { model: 'sonnet' });
  config.setProjectValue(ws, ['limits', 'reviewRounds'], 3);
  config.setPipeline(ws, ['planner', 'developer', 'reviewer']);
  const text = fs.readFileSync(config.projectConfigFile(ws), 'utf8');
  assert.match(text, /# team config/);
  assert.match(text, /pipeline: \[ planner, developer, reviewer \]/);
  const again = config.loadConfig({ workspace: ws, home });
  assert.equal(again.config.agents.planner.model, 'sonnet');
  assert.equal(again.config.limits.reviewRounds, 3);
  assert.throws(() => config.setProjectValue(ws, ['limits', 'reviewRounds'], 99), /invalid/);
  config.setProjectValue(ws, ['limits', 'reviewRounds'], undefined);
  assert.doesNotMatch(fs.readFileSync(config.projectConfigFile(ws), 'utf8'), /limits/);

  const file = config.ensureInstructionsFile(ws, 'developer', again.config.agents.developer);
  assert.equal(file, path.join(ws, '.claudestrator', 'prompts', 'developer.md'));
  assert.match(fs.readFileSync(file, 'utf8'), /You implement one repository/);
  assert.deepEqual(config.readProjectLayer(ws).agents.developer.instructions, { mode: 'replace', file: './prompts/developer.md' });

  fs.writeFileSync(config.projectConfigFile(ws), 'agents:\n  planner: { modle: opus }\n');
  const bad = config.loadConfig({ workspace: ws, home });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /agents\.planner\.modle: unknown field/);
});

test('reports: plan and verdict blocks are validated, nulls tolerated', () => {
  const plan = parseStageReport('plan', 'Plan...\n```json\n{"type":"feat","slug":"a-b","title":null,"repos":[{"name":"api"}],"openQuestions":[]}\n```');
  assert.ok(plan.ok);
  assert.deepEqual(plan.plan.repos, [{ name: 'api', mode: 'full' }]);
  assert.match(parseStageReport('plan', 'no block').error, /no ```json block/);
  assert.match(parseStageReport('plan', '```json\n{"type":"feat","slug":"Bad Slug","repos":[]}\n```').error, /slug must be kebab-case[\s\S]*repos: needs at least 1/);
  const v = parseStageReport('verdict', '```json\n{"status":"approved","summary":"s","findings":[{"severity":"major","problem":"p","line":null}]}\n```');
  assert.equal(v.ok, false);
  assert.match(v.error, /changes_requested exactly when/);
  assert.ok(parseStageReport('code', 'anything').ok);
});

test('guard: agents never touch git history, destructive commands are refused', () => {
  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: true, allowNoVerify: false };
  const ctx = (extra = {}) => ({ policy, cwd: '/ws/api', workspace: '/ws', home: '/home/u', agent: true, task: { taskId: 'T', canPush: false }, branchOf: () => 'feat/x', isRepoRoot: (d) => d === '/ws/api', readFile: () => null, ...extra });
  assert.equal(guardBash('npm test && git status', ctx()).allow, true);
  assert.match(guardBash('git commit -m "x"', ctx()).reason, /agents do not run git commit/);
  assert.match(guardBash('echo hi; bash -c "git push origin feat/x"', ctx()).reason, /git push/);
  assert.equal(guardBash('echo "git push --force"', ctx()).allow, true, 'quoted text is not a command');
  assert.match(guardBash('rm -rf ../api', ctx()).reason, /repository/);
  assert.match(guardBash('rm -rf ~', ctx()).reason, /not allowed/);
  assert.equal(guardBash('rm -rf node_modules', ctx()).allow, true);
  assert.match(guardBash('gh pr create --title x', ctx()).reason, /only read with gh/);
  const orchestrator = ctx({ agent: false, task: { taskId: 'T', canPush: true } });
  assert.match(guardBash('git push --force', orchestrator).reason, /force-push/);
  assert.match(guardBash('gh pr create --title x --body y', orchestrator).reason, /drafts only/);
  assert.match(guardBash('git commit -m "x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"', ctx({ agent: false, branchOf: () => 'feat/x' })).reason, /AI attribution/);
  assert.match(guardBash('git commit --no-verify -m x', ctx({ agent: false })).reason, /hooks/);
});

test('intake: invocations, sources and acceptance criteria', () => {
  assert.deepEqual(parseInvocation('PROJ-123 --no tester --auto'), { input: 'PROJ-123', flags: { no: ['tester'] }, auto: true });
  assert.deepEqual(parseInvocation("Don't break the dice game"), { input: "Don't break the dice game", flags: {}, auto: false });
  assert.deepEqual(classifyInput('PROJ-12'), { kind: 'jira', key: 'PROJ-12' });
  assert.deepEqual(classifyInput('https://acme.atlassian.net/browse/PROJ-7'), { kind: 'jira', key: 'PROJ-7', site: 'acme.atlassian.net' });
  assert.equal(classifyInput('https://acme.atlassian.net/wiki/spaces/X/pages/12345/Title').pageId, '12345');
  assert.equal(classifyInput('Add a cap https://x.y/z').kind, 'text');
  assert.deepEqual(extractAcceptanceCriteria('Intro\n\n## Acceptance criteria\n- one\n- two\n  continued\n\n## Notes\n- not this'), ['one', 'two continued']);
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'AC' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }] }), '## AC\n\n- a');
});

test('store: tasks persist, rejections are logged, torn tails are ignored', () => {
  const ws = tmp('cs-store-');
  const { pipeline, config: cfg } = defaultPipeline();
  const svc = new TaskService({ workspace: ws });
  const started = svc.start({ input: 'x', source: { kind: 'text', text: 'x' }, auto: false, pipeline, config: cfg });
  assert.ok(started.created);
  assert.ok(fs.existsSync(path.join(ws, '.orch', '.gitignore')));
  const second = svc.start({ input: 'y', source: { kind: 'text', text: 'y' }, auto: false, pipeline, config: cfg });
  assert.notEqual(second.taskId, started.taskId);
  const bad = svc.dispatch(started.taskId, { type: 'stage_started', agent: 'planner' });
  assert.equal(bad.ok, false);
  assert.equal(svc.events(started.taskId).at(-1).type, 'transition_rejected');
  fs.appendFileSync(path.join(svc.dir(started.taskId), 'events.ndjson'), '{"seq": 3, "type": "no');
  assert.equal(svc.state(started.taskId).phase, 'intake');
  assert.ok(svc.dispatch(started.taskId, { type: 'intake_completed', spec }).ok);
  assert.equal(svc.list().length, 2);
});

test('view: the step timeline continues after the step a checkpoint stopped at', () => {
  const { stepsOf } = require('../src/core/view');
  const { pipeline } = defaultPipeline();
  const events = [createdEvent(pipeline), { type: 'intake_completed', spec }, { type: 'stage_started', agent: 'planner' }, { type: 'stage_completed', agent: 'planner', artifact: 'plan/planner.md', plan: PLAN }].map((e, i) => ({ ...e, at: at(i), seq: i + 1 }));
  const state = replay(events);
  const steps = stepsOf(events, state, { running: false });
  assert.deepEqual(steps.map((s) => `${s.kind}:${s.agent || s.label}${s.repo ? `@${s.repo}` : ''}:${s.status}`), [
    'intake:Ticket:done',
    'agent:planner:done',
    'human:Plan approval:waiting',
    'agent:developer@api:pending',
    'agent:tester@api:pending',
    'agent:developer@web:pending',
    'agent:tester@web:pending',
    'agent:reviewer:pending',
    'finish:Commit:pending',
    'human:Confirm push:pending',
    'finish:Draft PRs:pending',
  ]);
});

test('config: effort is validated and inherited along extends', () => {
  const ws = tmp('cs-effort-');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(config.projectConfigFile(ws), 'agents:\n  reviewer: { effort: high }\n  security: { extends: reviewer, description: Security }\n');
  const r = config.loadConfig({ workspace: ws, home: tmp('cs-h-') });
  assert.ok(r.ok);
  assert.equal(r.config.agents.security.effort, 'high');
  assert.equal(r.config.agents.planner.effort, undefined);
  config.updateAgentConfig(ws, 'planner', { effort: 'xhigh' });
  assert.equal(config.loadConfig({ workspace: ws }).config.agents.planner.effort, 'xhigh');
  config.updateAgentConfig(ws, 'planner', { effort: null });
  assert.equal(config.loadConfig({ workspace: ws }).config.agents.planner.effort, undefined);
  assert.throws(() => config.updateAgentConfig(ws, 'planner', { effort: 'huge' }), /effort: expected one of low, medium, high, xhigh, max/);
  const { buildArgs, limitsOf } = require('../src/core/runner');
  const args = buildArgs({ agent: { model: 'opus', effort: 'low', instructions: 'x' } }, { flags: () => new Set(['--effort']), settingSources: () => null, hookSettings: () => '/h.json' });
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.ok(!buildArgs({ agent: { effort: 'low' } }, { flags: () => new Set(), settingSources: () => null, hookSettings: () => '/h' }).includes('--effort'), 'old CLIs without --effort still run');
  assert.deepEqual(limitsOf({ rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 9 }), { fiveHour: undefined, sevenDay: { pct: 50, resetsAt: 9, status: undefined } });
});

test('task effort: --effort in the text, per-agent choices, and the override reaching the agent', () => {
  assert.deepEqual(parseInvocation('Fix it --effort high').effort, { '*': 'high' });
  assert.deepEqual(parseInvocation('Fix it --effort developer=max,tester=low').effort, { developer: 'max', tester: 'low' });
  const { Engine } = require('../src/core/engine');
  const ws = tmp('cs-teff-');
  const engine = new Engine({ workspace: ws, home: tmp('cs-h-'), runner: {}, hooks: {} });
  const r = engine.start({ text: 'Do it --effort medium --no tester', effort: { developer: 'max' } });
  const s = engine.svc.state(r.taskId);
  assert.deepEqual(s.effort, { planner: 'medium', developer: 'max', reviewer: 'medium' }, 'all enabled agents, a named one wins, skipped ones get nothing');
  assert.equal(engine.svc.events(r.taskId)[0].effort.developer, 'max', 'frozen in the task log');
  assert.throws(() => engine.start({ text: 'x --effort huge' }), /not one of low/);
  assert.throws(() => engine.start({ text: 'x', effort: { nobody: 'high' } }), /unknown agent "nobody"/);
  assert.match(engine.preview({ text: 'x --effort huge' }).problem, /not one of/);
  assert.deepEqual(engine.preview({ text: 'x', effort: { '*': 'low' } }).effort, { planner: 'low', developer: 'low', tester: 'low', reviewer: 'low' });
});

test('defaults: what "default" really means is asked from the CLI, and shown per agent', async () => {
  const { resolveDefaults, effectiveFor, modelName } = require('../src/core/defaults');
  const fake = path.join(__dirname, 'fixtures', 'fake-claude.js');
  const d = await resolveDefaults({ command: fake, cwd: os.tmpdir(), env: { ...process.env, FAKE_DEFAULT_EFFORT: 'high' }, aliases: ['inherit', 'sonnet'] });
  assert.deepEqual(d.byModel, { inherit: { model: 'claude-opus-5-5', effort: 'high' }, sonnet: { model: 'claude-sonnet-5-5', effort: 'high' } });
  assert.deepEqual(effectiveFor({ model: 'inherit' }, d), { model: 'claude-opus-5-5', modelName: 'Opus 5.5', modelIsDefault: true, effort: 'high', effortIsDefault: true, defaultEffort: 'high' });
  assert.equal(effectiveFor({ model: 'sonnet', effort: 'low' }, d).effort, 'low');
  assert.equal(effectiveFor({ model: 'sonnet', effort: 'low' }, d, 'max').effort, 'max', 'the task override wins');
  assert.equal(effectiveFor({ model: 'haiku' }, d).modelName, 'Haiku 5.5', 'names come from the CLI model list');
  assert.equal(effectiveFor({ model: 'claude-custom-9' }, d).modelName, 'Custom 9', 'unknown ids fall back to a readable name');
  assert.equal(modelName('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(await resolveDefaults({ command: '/nonexistent/claude', cwd: os.tmpdir(), env: process.env }), null);
});

test('mcp: states from claude mcp list, configured servers, masked details and sign-in', async () => {
  const mcp = require('../src/core/mcp');
  const list = mcp.parseMcpList(`Checking MCP server health…

claude.ai Docs: https://api.anthropic.com/mcp - ✔ Connected
Atlassian: https://mcp.atlassian.com/v1/sse (SSE) - ! Needs authentication
Grafana: http://localhost:8765/mcp (HTTP) - ✗ Failed to connect
shadcn: npx shadcn mcp - ⏸ Pending approval
`);
  assert.deepEqual(list.map((s) => [s.name, s.state, s.transport, s.scope]), [
    ['claude.ai Docs', 'connected', 'http', 'claude.ai'],
    ['Atlassian', 'needs_auth', 'sse', 'config'],
    ['Grafana', 'failed', 'http', 'config'],
    ['shadcn', 'installed', 'stdio', 'config'],
  ]);
  assert.ok(list[3].pending);
  assert.deepEqual(list.map(mcp.canLogin), [true, true, true, false]);

  const ws = tmp('cs-mcp-');
  const cfg = tmp('cs-mcp-cfg-');
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { Grafana: { type: 'http', url: 'http://x', headers: { Authorization: 'secret' } } }, projects: { [ws]: { mcpServers: { db: { command: 'npx' } }, disabledMcpServers: ['db'] } } }));
  fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { sentry: { type: 'sse', url: 'https://s' } } }));
  const configured = mcp.configuredMcpServers(ws, cfg);
  assert.deepEqual(configured.map((s) => [s.name, s.scope, s.transport, Boolean(s.disabled)]), [['Grafana', 'user', 'http', false], ['db', 'local', 'stdio', true], ['sentry', 'project', 'sse', false]]);
  assert.ok(!JSON.stringify(configured).includes('secret'), 'server configs carry secrets; only names leave the file');
  const merged = mcp.mergeMcp(configured, list);
  assert.equal(merged.find((s) => s.name === 'Grafana').scope, 'user');
  assert.equal(merged.find((s) => s.name === 'db').state, 'installed', 'configured but not in the check still shows');
  const afterOkCheck = mcp.mergeMcp(configured, list, true);
  const sentry = afterOkCheck.find((s) => s.name === 'sentry');
  assert.ok(sentry.missing, 'in a file but not loaded by Claude Code');
  assert.equal(mcp.canLogin(sentry), false, 'no sign-in for a server the CLI does not know');
  assert.ok(!afterOkCheck.find((s) => s.name === 'db').missing, 'disabled servers are not missing');
  const home = tmp('cs-home-');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { real: { type: 'http', url: 'x' } } }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ mcpServers: { stale: { type: 'http', url: 'x' } } }));
  const realHome = os.homedir;
  os.homedir = () => home;
  try {
    assert.deepEqual(mcp.configuredMcpServers(ws, undefined).map((s) => s.name).filter((n) => n !== 'sentry'), ['real'], 'the default account reads ~/.claude.json, not ~/.claude/.claude.json');
  } finally {
    os.homedir = realHome;
  }

  const masked = mcp.redactMcpDetails('  Authorization: Bearer abc.def\n  API_TOKEN=supersecret\n  URL: https://x');
  assert.ok(!/abc\.def|supersecret/.test(masked) && /URL: https:\/\/x/.test(masked));
  assert.equal(mcp.isMcpName('Atlassian'), true);
  assert.equal(mcp.isMcpName('x; rm -rf /'), false);

  const fake = path.join(__dirname, 'fixtures', 'fake-claude.js');
  const state = tmp('cs-mcp-state-');
  const env = { ...process.env, FAKE_STATE: state };
  let r = await mcp.checkMcpServers({ command: fake, workspace: ws, configDir: cfg, env });
  assert.equal(r.servers.find((s) => s.name === 'Atlassian').state, 'needs_auth');
  const lines = [];
  const code = await mcp.mcpLogin({ command: fake, workspace: ws, env, name: 'Atlassian', onLine: (l) => lines.push(l) }).done;
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /https:\/\/auth\.example\.com/);
  r = await mcp.checkMcpServers({ command: fake, workspace: ws, configDir: cfg, env });
  assert.equal(r.servers.find((s) => s.name === 'Atlassian').state, 'connected', 'connected after signing in');
});

test('repos outside the workspace: picked folders, paths and the guard', () => {
  const { reposFromFolders } = require('../src/core/setup');
  const { execFileSync } = require('child_process');
  const ws = tmp('cs-ws-');
  const outer = tmp('cs-outer-');
  for (const d of [path.join(ws, 'inner'), path.join(outer, 'billing'), path.join(outer, 'group', 'auth')]) {
    fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: d });
  }
  fs.writeFileSync(path.join(outer, 'billing', 'go.mod'), 'module billing\n');
  fs.mkdirSync(path.join(outer, 'plain'));
  const r = reposFromFolders(ws, [path.join(ws, 'inner'), outer, path.join(outer, 'plain')], { names: ['inner'], dirs: [] });
  assert.deepEqual(r.repos.map((x) => [x.name, x.outside, path.isAbsolute(x.path)]), [['inner-2', false, false], ['billing', true, true], ['auth', true, true]]);
  assert.equal(r.repos[0].path, 'inner');
  assert.deepEqual(r.repos[1].gates.map((g) => g.name), ['vet', 'test']);
  assert.deepEqual(r.notRepos, [path.join(outer, 'plain')]);
  assert.equal(reposFromFolders(ws, [outer], { names: [], dirs: [path.join(outer, 'billing'), path.join(outer, 'group', 'auth')] }).repos.length, 0, 'already configured repos are skipped');

  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: false, allowNoVerify: false };
  const ctx = { policy, cwd: path.join(outer, 'billing'), workspace: ws, repoDirs: [path.join(outer, 'billing')], agent: true, branchOf: () => 'feat/x', isRepoRoot: (d) => d === path.join(outer, 'billing'), readFile: () => null };
  assert.equal(guardBash('rm -rf dist', ctx).allow, true, 'cleaning inside an outside repo is fine');
  assert.match(guardBash(`rm -rf ${path.join(outer, 'billing')}`, ctx).reason, /contains the workspace, a repository/);
  assert.match(guardBash('rm -rf .git', ctx).reason, /git metadata/);
  assert.match(guardBash('rm -rf /opt/elsewhere/plain', ctx).reason, /outside the workspace and its repos/);
});

test('scenarios: built-in readiness and audit agents, validated config, read-only pipelines', () => {
  const r = config.resolveConfig([config.builtinLayer()]);
  assert.ok(r.ok);
  assert.deepEqual(r.config.scenarios, { readiness: ['verifier'], audit: ['auditor'] });
  assert.deepEqual(r.warnings, [], 'scenario agents are not "enabled but never run"');
  for (const [sc, agent, output] of [['readiness', 'verifier', 'readiness'], ['audit', 'auditor', 'audit']]) {
    const p = buildPipeline(r.config, { scenario: sc });
    assert.equal(p.mode, sc);
    assert.deepEqual(p.stages, [{ agent, output, scope: 'task', approval: false }]);
    assert.equal(p.reviewLoop, null);
    assert.equal(outline(p).pop().text, sc === 'audit' ? 'audit report' : 'readiness report');
  }

  const layer = (c) => ({ name: 'project', baseDir: '/ws/.claudestrator', config: c });
  const bad = config.resolveConfig([config.builtinLayer(), layer({ scenarios: { audit: ['reviewer', 'ghost'] }, pipeline: ['planner', 'auditor'] })]);
  assert.equal(bad.ok, false);
  const codes = bad.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['report_agent_in_pipeline', 'scenario_unknown_agent', 'scenario_wrong_output']);

  const two = config.resolveConfig([config.builtinLayer(), layer({ agents: { 'perf-auditor': { extends: 'auditor', instructions: { mode: 'append', text: 'Performance only.' } } }, scenarios: { audit: ['auditor', 'perf-auditor'] } })]);
  assert.ok(two.ok, JSON.stringify(two.errors));
  assert.deepEqual(buildPipeline(two.config, { scenario: 'audit' }).stages.map((s) => s.agent), ['auditor', 'perf-auditor']);
  assert.match(two.config.agents['perf-auditor'].instructions, /You audit code[\s\S]*Performance only\.$/);
});

test('scenarios: readiness verdicts come from the criteria, audit findings are sorted, reports render', () => {
  const { parseReadiness, parseAudit } = require('../src/core/protocol');
  const { renderReport, jiraText } = require('../src/core/report');
  const crit = (status) => ({ criterion: `c-${status}`, status, evidence: 'e' });
  assert.equal(parseReadiness({ summary: 's', criteria: [crit('met')] }).value.verdict, 'ready');
  assert.equal(parseReadiness({ summary: 's', criteria: [crit('met'), crit('unverifiable')] }).value.verdict, 'needs_check');
  assert.equal(parseReadiness({ summary: 's', criteria: [crit('met')], gaps: [{ severity: 'high', problem: 'p' }] }).value.verdict, 'not_ready');
  assert.equal(parseReadiness({ summary: 's', criteria: [crit('partial')], verdict: 'ready' }).value.verdict, 'not_ready', "the agent's own verdict does not count");
  assert.equal(parseReadiness({ summary: 's', criteria: [] }).ok, false, 'at least one criterion');
  assert.equal(parseReadiness({ summary: 's', criteria: [{ criterion: 'x', status: 'done' }] }).ok, false);

  const a = parseAudit({ summary: 's', findings: [{ severity: 'low', title: 'l', problem: 'p' }, { severity: 'critical', title: 'c', problem: 'p', line: null }] });
  assert.deepEqual(a.value.findings.map((f) => f.severity), ['critical', 'low']);
  assert.equal(parseAudit({ summary: 's', findings: [{ severity: 'blocker', title: 't', problem: 'p' }] }).ok, false);
  assert.equal(parseStageReport('audit', `x\n\`\`\`json\n${JSON.stringify({ summary: 's', findings: [] })}\n\`\`\``).audit.findings.length, 0);
  assert.match(parseStageReport('readiness', 'no block').error, /no ```json block/);

  const state = { taskId: 'PROJ-1-check', scenario: 'readiness', spec: { title: 'PROJ-1 Cap bets' }, reports: [{ agent: 'verifier', value: parseReadiness({ summary: 'Close.', criteria: [crit('met'), crit('not_met')] }).value }] };
  assert.match(renderReport(state, 'Ukrainian'), /^# Перевірка готовності: PROJ-1 Cap bets\n\n\*\*❌ Не готово\*\* · 1\/2 виконано/);
  assert.match(jiraText(state, 'English'), /❌ c-not_met — e/);
  assert.equal(jiraText(state, 'English', 40).length, 40, 'a comment stays within the limit');
});

test('scenarios: the state machine finishes a report scenario without git; intake reads issues named in a sentence', () => {
  const { config: c } = defaultPipeline();
  const pipeline = buildPipeline(c, { scenario: 'audit' });
  let s = transition(null, { ...createdEvent(pipeline), scenario: 'audit' }).state;
  assert.equal(s.scenario, 'audit');
  s = transition(s, { type: 'intake_completed', spec, at: at(1) }).state;
  assert.equal(nextAction(s).kind, 'run');
  assert.deepEqual(nextAction(s).inputs, ['ticket.md']);
  assert.equal(nextAction(s).artifact, 'audit/auditor.md');
  s = transition(s, { type: 'stage_started', agent: 'auditor', at: at(2) }).state;
  assert.equal(transition(s, { type: 'stage_completed', agent: 'auditor', artifact: 'audit/auditor.md', at: at(3) }).error.code, 'audit_required');
  s = transition(s, { type: 'stage_completed', agent: 'auditor', artifact: 'audit/auditor.md', audit: { summary: 's', scope: [], findings: [] }, at: at(3) }).state;
  assert.equal(s.status, 'done');
  assert.equal(s.outcome, 'completed');
  assert.equal(s.reports.length, 1);
  assert.equal(transition(null, createdEvent(buildPipeline(c))).state.scenario, 'deliver', 'old logs are deliveries');

  const { detectScenario } = require('../src/core/intake');
  assert.equal(detectScenario('перевір готовність виконання таски'), 'readiness');
  assert.equal(detectScenario('Check the acceptance criteria of PROJ-3'), 'readiness');
  assert.equal(detectScenario('Зроби аудит проекту'), 'audit');
  assert.equal(detectScenario('Add a health check'), 'deliver');
  assert.deepEqual(classifyInput('PROJ-7: перевір готовність', { embedded: true }), { kind: 'jira', key: 'PROJ-7', note: 'перевір готовність' });
  assert.deepEqual(classifyInput('Is https://acme.atlassian.net/browse/PROJ-8 ready?', { embedded: true }), { kind: 'jira', key: 'PROJ-8', site: 'acme.atlassian.net', note: 'Is ready?' });
  assert.equal(classifyInput('PROJ-7 перевір готовність').kind, 'text', 'only report scenarios look inside a sentence');
  assert.equal(classifyInput('XY-1 ready?', { embedded: true, projects: ['PROJ'] }).kind, 'text', 'outside the allowed projects it is no issue');
  assert.equal(classifyInput('switch to UTF-8, ready?', { embedded: true }).kind, 'text');
  assert.equal(parseInvocation('x --scenario audit').scenario, 'audit');
  assert.throws(() => parseInvocation('x --scenario nope'), /--scenario is one of/);

  const ws = tmp('cs-ids-');
  const svc = new TaskService({ workspace: ws });
  const jira = { kind: 'jira', key: 'PROJ-9' };
  assert.deepEqual(svc.idFor({ source: jira, scenario: 'readiness' }), { taskId: 'PROJ-9-check', exists: false });
  svc.start({ input: 'PROJ-9', source: jira, scenario: 'readiness', auto: false, pipeline: buildPipeline(c, { scenario: 'readiness' }), config: c });
  assert.deepEqual(svc.idFor({ source: jira, scenario: 'readiness' }), { taskId: 'PROJ-9-check', exists: true }, 'an unfinished check continues');
  assert.deepEqual(svc.idFor({ source: jira }), { taskId: 'PROJ-9', exists: false }, 'the delivery task has its own id');
  assert.equal(svc.state('PROJ-9-check').scenario, 'readiness');
});
