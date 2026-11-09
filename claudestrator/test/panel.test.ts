// What the dashboard panel posts of an agent's streamed output: in batches, and nothing half a sentence long.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import Module from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BitbucketClient } from '../src/core/bitbucket';
import type { HealthReport, HostMessage, SettingsData, TranscriptItem } from '../src/core/wire';

// panel.ts loads `vscode`: the dialogs a test answers, nothing else.
/* eslint-disable @typescript-eslint/no-require-imports */
/** Settings a test sets, as VS Code's configuration answers them. */
const settingValues = new Map<string, unknown>();
const vscodeStub = {
  window: {} as Record<string, unknown>,
  workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), getConfiguration: () => ({ get: (k: string) => settingValues.get(k), update: async (k: string, v: unknown) => void settingValues.set(k, v) }) },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  ThemeIcon: class {},
  ConfigurationTarget: { Global: 1 },
};
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const load = loader._load;
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};
const { DashboardPanel } = require('../src/panel') as typeof import('../src/panel');
loader._load = load;

/** A panel without a webview: what it posts, and whether it is in view. */
function panel() {
  const posted: HostMessage[] = [];
  const view = { visible: true };
  const p = Object.assign(Object.create(DashboardPanel.prototype) as InstanceType<typeof DashboardPanel>, {
    panel: view,
    booted: true,
    outputQueue: [],
    outputTimer: undefined,
    missedText: new Set<string>(),
    post: (m: HostMessage) => (posted.push(m), Promise.resolve(true)),
  });
  return { p, posted, view };
}

const delta = (key: string, text: string) => ({ type: 'output' as const, taskId: 'T', key, item: { type: 'text_delta' as const, text } });
const flushed = () => new Promise((r) => setTimeout(r, 80));

test('panel: streamed text goes in one message per batch, merged, in order with the rest', async () => {
  const { p, posted } = panel();
  for (const piece of ['Reading ', 'the ', 'plan']) p.queueOutput(delta('a', piece));
  p.queueOutput({ type: 'output', taskId: 'T', key: 'a', item: { type: 'tool_use', id: '1', name: 'Read', input: {} } });
  assert.equal(posted.length, 0, 'nothing goes before the batch is due');
  await flushed();
  assert.deepEqual(posted.map((m) => (m.type === 'output' ? [m.item.type, 'text' in m.item ? m.item.text : ''] : m.type)), [['text_delta', 'Reading the plan'], ['tool_use', '']]);
});

test('panel: a hidden panel gets no text pieces, and none of that message after it shows again until the whole text', async () => {
  const { p, posted, view } = panel();
  view.visible = false;
  p.queueOutput(delta('a', 'Half a '));
  view.visible = true;
  p.queueOutput(delta('a', 'sentence'));
  p.queueOutput(delta('b', 'Another step'));
  p.queueOutput({ type: 'output', taskId: 'T', key: 'a', item: { type: 'text', text: 'Half a sentence.' } });
  p.queueOutput(delta('a', 'Next '));
  await flushed();
  assert.deepEqual(posted.map((m) => (m.type === 'output' && 'text' in m.item ? [m.key, m.item.type, m.item.text] : null)), [['b', 'text_delta', 'Another step'], ['a', 'text', 'Half a sentence.'], ['a', 'text_delta', 'Next ']]);
});

test('panel: text missed while hidden holds back that step of that task only, until its message ends', async () => {
  const { p, posted, view } = panel();
  const of = (taskId: string, key: string, item: TranscriptItem) => ({ type: 'output' as const, taskId, key, item });
  view.visible = false;
  p.queueOutput(of('A', 'k', { type: 'text_delta', text: 'Half ' }));
  view.visible = true;
  p.queueOutput(of('A', 'k', { type: 'text_delta', text: 'a sentence' }));
  p.queueOutput(of('B', 'k', { type: 'text_delta', text: 'Another task, the same key' }));
  p.queueOutput(of('A', 'k', { type: 'turn_end', ok: false, costUsd: 0, turns: 1 }));
  p.queueOutput(of('A', 'k', { type: 'text_delta', text: 'Next turn' }));
  await flushed();
  assert.deepEqual(posted.map((m) => (m.type === 'output' ? `${m.taskId}:${m.item.type}${'text' in m.item ? `:${m.item.text}` : ''}` : m.type)), ['B:text_delta:Another task, the same key', 'A:turn_end', 'A:text_delta:Next turn']);
});

test('panel: a folder without library.yaml becomes a library once you say so', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lib-ws-')));
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'language: English\n');
  const lib = path.join(ws, 'agents-lib');
  fs.mkdirSync(lib);
  // The folder picked, "Start a library", then "This project".
  vscodeStub.window.showOpenDialog = async () => [{ fsPath: lib }];
  vscodeStub.window.showInformationMessage = async (_m: string, _o: unknown, ...items: string[]) => items[items.length - 1];
  const p = Object.assign(Object.create(DashboardPanel.prototype) as InstanceType<typeof DashboardPanel>, { orch: { root: ws } });
  const r = await p.$addLibrary();
  assert.ok(r.added, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(lib, 'library.yaml')), 'library.yaml is written');
  assert.match(fs.readFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'utf8'), /libraries:\n\s+- \.\.\/agents-lib/);
});

test('panel: a report that would load images from the web is opened as text, not in the preview', async () => {
  const { loadsRemote } = await import('../src/core/view');
  for (const md of ['![x](https://evil.example/?q=c2VjcmV0)', '![](//evil.example/a.png)', '<img src="https://evil.example/p">', '<img alt=x src=http://evil.example/p>', '![logo][l]\n\n[l]: https://evil.example/l.png', '<video poster="https://evil.example/p">']) {
    assert.equal(loadsRemote(md), true, md);
  }
  for (const md of ['# Plan\n\n[docs](https://docs.acme.com) and https://example.com', '![diagram](./diagram.png)', '[l]: https://example.com with no image']) {
    assert.equal(loadsRemote(md), false, md);
  }
});

test('panel: the page gets the streamed output of the task it shows, and of no other', async () => {
  let engine: ((e: { name: string; data: unknown }) => void) | undefined;
  const on = () => ({ dispose() {} });
  const orch = { onEngine: (fn: typeof engine) => ((engine = fn), { dispose() {} }), onDidChange: on, onDidChangeConfig: on };
  const { p, posted } = panel();
  Object.assign(p, { orch, disposables: [], viewing: null });
  p.listen();
  const item = { type: 'tool_use', id: '1', name: 'Write', input: { file_path: 'a.ts', content: 'x'.repeat(1000) } };
  engine!({ name: 'output', data: { taskId: 'A', key: 'k', item } });
  await flushed();
  assert.equal(posted.length, 0, 'the page shows no task');
  await p.$view({ taskId: 'B' });
  engine!({ name: 'output', data: { taskId: 'A', key: 'k', item } });
  engine!({ name: 'output', data: { taskId: 'B', key: 'k', item } });
  await flushed();
  assert.deepEqual(posted.map((m) => (m as { taskId?: string }).taskId), ['B']);
});

test('panel: Continue in terminal runs Claude itself, so no shell reads a path with spaces', async () => {
  const opened: Record<string, unknown>[] = [];
  vscodeStub.window.createTerminal = (options: Record<string, unknown>) => (opened.push(options), { show() {} });
  const { setShim } = await import('../src/core/git');
  const viewModule = require('../src/core/view') as { detail: unknown };
  const detail = viewModule.detail;
  const session = '0b7e1d7c-3f0e-4a8e-9d2b-5c1f6a7e8d90';
  viewModule.detail = async () => ({ steps: [{ key: 'k', agent: 'developer', repo: 'api', sessionId: session, configDir: 'C:\\Users\\me\\.claude-work' }] });
  try {
    for (const claude of ['C:\\Program Files\\Claude\\claude.exe', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd']) {
      const p = Object.assign(Object.create(DashboardPanel.prototype) as InstanceType<typeof DashboardPanel>, { orch: { engine: {}, root: 'C:\\ws', claudeCommand: () => claude, accountChoice: () => ({ dir: null }) } });
      await p.$resumeTerminal({ taskId: 'T-1', key: 'k' });
    }
    setShim('C:\\npm global\\claude.cmd', { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm global\\node_modules\\@anthropic-ai\\claude-code\\cli.js'] });
    const p = Object.assign(Object.create(DashboardPanel.prototype) as InstanceType<typeof DashboardPanel>, { orch: { engine: {}, root: 'C:\\ws', claudeCommand: () => 'C:\\npm global\\claude.cmd', accountChoice: () => ({ dir: null }) } });
    await p.$resumeTerminal({ taskId: 'T-1', key: 'k' });
  } finally {
    viewModule.detail = detail;
  }
  assert.deepEqual(opened.map((o) => [o.shellPath, o.shellArgs]), [
    ['C:\\Program Files\\Claude\\claude.exe', ['--resume', session]],
    ['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', ['--resume', session]],
    ['C:\\Program Files\\nodejs\\node.exe', ['C:\\npm global\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '--resume', session]],
  ]);
  assert.equal((opened[0]!.env as { CLAUDE_CONFIG_DIR?: string }).CLAUDE_CONFIG_DIR, 'C:\\Users\\me\\.claude-work', 'the account the step ran under');
});

test('panel: Fix in chat opens Claude in the repo of the failure, with it as the first message, the pick and the account', async () => {
  const opened: Record<string, unknown>[] = [];
  vscodeStub.window.createTerminal = (options: Record<string, unknown>) => (opened.push(options), { show() {} });
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fix-ws-')));
  for (const r of ['api', 'web']) fs.mkdirSync(path.join(ws, r));
  const viewModule = require('../src/core/view') as { detail: unknown };
  const detail = viewModule.detail;
  const lint = 'api: src/a.ts\n  12:3  warning  More than two parameters';
  let shown: { status: { key: string }; error: unknown } = { status: { key: 'waiting' }, error: null };
  viewModule.detail = async () => ({ ...shown, title: 'Risk thresholds', branch: 'feat/T-1-risk', taskDir: path.join(ws, '.orch', 'tasks', 'T-1') });
  let checkpoint: { id: string; at: string } | null = { id: 'hook-failure', at: 'now' };
  const contexts: string[] = [];
  const engine = {
    svc: { state: async () => ({ taskId: 'T-1', source: { kind: 'text', text: 'x' }, gitMode: 'branch', repos: [{ name: 'api' }, { name: 'web' }], checkpoint }) },
    checkpointContext: async (_s: unknown, cp: { id: string }) => (contexts.push(cp.id), { format: 'log', text: lint }),
  };
  const p = Object.assign(Object.create(DashboardPanel.prototype) as InstanceType<typeof DashboardPanel>, {
    orch: { engine, root: ws, claudeCommand: () => '/usr/local/bin/claude', accountChoice: () => ({ dir: '/home/me/.claude-work' }), config: async () => ({ ok: false }) },
  });
  try {
    await p.$fixInChat({ taskId: 'T-1', model: 'sonnet', effort: 'high' });
    const [o] = opened;
    assert.equal(o!.shellPath, '/usr/local/bin/claude', 'Claude itself, no shell');
    const args = o!.shellArgs as string[];
    assert.match(args[0]!, /^Claudestrator task T-1 \("Risk thresholds"\) stopped: a git hook rejected the commit\./, 'the failure is the first message');
    assert.ok(args[0]!.includes(lint) && args[0]!.includes('feat/T-1-risk'));
    assert.deepEqual(args.slice(1), ['--model', 'sonnet', '--effort', 'high', '--add-dir', path.join(ws, 'web')]);
    assert.equal(o!.cwd, path.join(ws, 'api'), "in the repo the hook's output names");
    assert.equal((o!.env as { CLAUDE_CONFIG_DIR?: string }).CLAUDE_CONFIG_DIR, '/home/me/.claude-work', "the agents' account");
    assert.equal(o!.name, 'Fix · T-1');

    // The account's defaults add nothing; a repo folder that is gone leaves the chat in the workspace.
    fs.rmSync(path.join(ws, 'api'), { recursive: true });
    await p.$fixInChat({ taskId: 'T-1', model: 'inherit' });
    assert.deepEqual((opened[1]!.shellArgs as string[]).slice(1), ['--add-dir', path.join(ws, 'web')]);
    assert.equal(opened[1]!.cwd, ws);

    // A failed run's error, once the task waits at no question.
    checkpoint = null;
    shown = { status: { key: 'failed' }, error: { code: 'wrong_branch', message: 'web is on main, not the task branch feat/T-1-risk' } };
    await p.$fixInChat({ taskId: 'T-1' });
    assert.match((opened[2]!.shellArgs as string[])[0]!, /stopped: the run failed\.[\s\S]*web is on main/);

    // Nothing to fix: a decision, a sign-in, a task that did not fail. No terminal, and no push context read for it.
    contexts.length = 0;
    checkpoint = { id: 'confirm-push', at: 'now' };
    shown = { status: { key: 'waiting' }, error: null };
    await assert.rejects(() => p.$fixInChat({ taskId: 'T-1' }), /T-1 has no failure to fix right now/);
    assert.deepEqual(contexts, [], "a push's context runs git in every repo: not read for nothing");
    checkpoint = null;
    shown = { status: { key: 'failed' }, error: { code: 'claude_login', message: 'signed out' } };
    await assert.rejects(() => p.$fixInChat({ taskId: 'T-1' }), /no failure to fix/);
    assert.equal(opened.length, 3);
  } finally {
    viewModule.detail = detail;
  }
});

test('panel: the task screen says where its failure has a Fix in chat', async () => {
  const viewModule = require('../src/core/view') as { detail: unknown };
  const detail = viewModule.detail;
  let shown: { status: { key: string }; error: unknown } = { status: { key: 'waiting' }, error: null };
  viewModule.detail = async () => shown;
  let checkpoint: { id: string; at: string } | null = { id: 'gate-failure', at: 'now' };
  const engine = {
    svc: { exists: async () => true, state: async () => ({ checkpoint, pipeline: { stages: [], reviewLoop: null } }), readArtifact: async () => '' },
    checkpointContext: async () => ({ format: 'log', text: 'lint: 1 error' }),
  };
  const p = Object.assign(Object.create(DashboardPanel.prototype) as InstanceType<typeof DashboardPanel>, { orch: { engine }, pipelineEdit: async () => null });
  try {
    assert.equal((await p.$task({ taskId: 'T-1' })).fix, 'checkpoint');
    checkpoint = { id: 'approve-plan', at: 'now' };
    assert.equal((await p.$task({ taskId: 'T-1' })).fix, null, 'a decision');
    checkpoint = null;
    shown = { status: { key: 'failed' }, error: { message: 'api is on main' } };
    assert.equal((await p.$task({ taskId: 'T-1' })).fix, 'error');
  } finally {
    viewModule.detail = detail;
  }
});

test('panel: the sidebar deletes a task and opens config.yaml without a dashboard', async () => {
  const { deleteTask, openConfig } = await import('../src/panel');
  const done: string[] = [];
  const engine = {
    svc: { state: async () => ({ source: { kind: 'text', text: 'x' }, gitMode: 'worktree', repos: [{ name: 'api' }] }), runsElsewhere: async () => null },
    isRunning: () => true,
    stop: async () => void done.push('stop'),
    settled: async () => void done.push('settled'),
    cleanup: async () => (done.push('cleanup'), []),
    remove: async () => void done.push('remove'),
  } as unknown as Parameters<typeof deleteTask>[0];
  vscodeStub.window.showWarningMessage = async () => undefined;
  assert.deepEqual(await deleteTask(engine, 'T-1'), { deleted: false }, 'nothing without your yes');
  assert.deepEqual(done, []);
  vscodeStub.window.showWarningMessage = async () => 'Delete';
  assert.deepEqual(await deleteTask(engine, 'T-1'), { deleted: true });
  assert.deepEqual(done, ['stop', 'settled', 'cleanup', 'remove'], 'stopped and settled before its worktrees go');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-open-config-'));
  const shown: string[] = [];
  vscodeStub.window.showTextDocument = async (uri: { fsPath: string }) => void shown.push(uri.fsPath);
  await openConfig(ws, 'project');
  assert.deepEqual(shown, [path.join(ws, '.claudestrator', 'config.yaml')]);
  assert.match(fs.readFileSync(shown[0]!, 'utf8'), /^# Claudestrator workspace config/);

  // A dashboard that shows the deleted task leaves it; one that shows another stays.
  const { p, posted } = panel();
  Object.assign(p, { viewing: 'T-2' });
  p.taskDeleted('T-1');
  Object.assign(p, { viewing: 'T-1' });
  p.taskDeleted('T-1');
  assert.deepEqual(posted, [{ type: 'navigate', route: { name: 'home' } }]);
});

test('panel: a page still loading starts on the last screen asked for, not the first', async () => {
  const { p, posted } = panel();
  Object.assign(p, { booted: false, initialRoute: { name: 'task', taskId: 'A' }, context: { extension: { packageJSON: { version: '1.0.0' } } } });
  p.navigate({ name: 'task', taskId: 'B' });
  assert.deepEqual(posted, [], 'nothing goes to a page that does not listen yet');
  assert.deepEqual((await p.$boot()).route, { name: 'task', taskId: 'B' });
  p.navigate({ name: 'task', taskId: 'C' });
  assert.deepEqual(posted, [{ type: 'navigate', route: { name: 'task', taskId: 'C' } }], 'a booted page is sent there');
});

test("panel: a deleted task's screen hears so, and goes home", async () => {
  const { p } = panel();
  const svc = { exists: async () => false };
  Object.assign(p, { orch: { engine: { svc } }, viewing: 'T-1' });
  await assert.rejects(() => p.$task({ taskId: 'T-1' }), (e: { code?: string }) => e.code === 'no_task');
});

/** A panel over an orchestrator with only what Settings and the tools' health read. */
function integrationsPanel(orch: Record<string, unknown>) {
  const base = {
    health: null,
    token: undefined,
    bitbucketToken: undefined,
    atlassianAuth: () => null,
    bitbucketAuth: () => null,
    accounts: async () => [],
    account: async () => null,
    mcpIntakeServer: async () => null,
    ensureReady: async () => {},
  };
  return Object.assign(Object.create(DashboardPanel.prototype) as InstanceType<typeof DashboardPanel>, { orch: { ...base, root: '/ws', ...orch } });
}

test('panel: Settings say whether Bitbucket has a token, from storage or the environment, without the token', async () => {
  settingValues.clear();
  const env = process.env.BITBUCKET_API_TOKEN;
  delete process.env.BITBUCKET_API_TOKEN;
  try {
    const none = (await integrationsPanel({}).$settings()) as SettingsData;
    assert.deepEqual(none.bitbucket, { email: '', hasToken: false, fromEnv: false, connected: false });

    settingValues.set('bitbucket.email', 'ci@acme.com');
    const saved = (await integrationsPanel({ bitbucketToken: 'bb-secret', bitbucketAuth: () => ({ email: 'ci@acme.com', token: 'bb-secret' }) }).$settings()) as SettingsData;
    assert.deepEqual(saved.bitbucket, { email: 'ci@acme.com', hasToken: true, fromEnv: false, connected: true });
    assert.ok(!JSON.stringify(saved).includes('bb-secret'), 'the page never gets the token');

    process.env.BITBUCKET_API_TOKEN = 'from-env';
    const fromEnv = (await integrationsPanel({ bitbucketAuth: () => ({ email: 'ci@acme.com', token: 'from-env' }) }).$settings()) as SettingsData;
    assert.deepEqual(fromEnv.bitbucket, { email: 'ci@acme.com', hasToken: false, fromEnv: true, connected: true });
  } finally {
    if (env === undefined) delete process.env.BITBUCKET_API_TOKEN;
    else process.env.BITBUCKET_API_TOKEN = env;
  }
});

test('panel: Bitbucket is saved trimmed, and tested only once it can be', async () => {
  const saves: unknown[] = [];
  const p = integrationsPanel({ saveBitbucket: async (x: unknown) => void saves.push(x), bitbucket: () => null });
  await p.$saveBitbucket({ email: '  ci@acme.com ', token: 'tok' });
  await p.$saveBitbucket({ email: 'ci@acme.com' });
  assert.deepEqual(saves, [{ email: 'ci@acme.com', token: 'tok' }, { email: 'ci@acme.com', token: undefined }], 'no token given: the saved one stays');
  await assert.rejects(p.$testBitbucket(), /Fill in the email and API token first/);

  const fetch = (async () => new Response(JSON.stringify({ display_name: 'CI Bot' }), { status: 200 })) as unknown as typeof globalThis.fetch;
  const ready = integrationsPanel({ bitbucket: () => new BitbucketClient({ email: 'ci@acme.com', token: 'tok-123456789' }, { fetch }) });
  assert.deepEqual(await ready.$testBitbucket(), { name: 'CI Bot', email: 'ci@acme.com' });
});

test("panel: the tools' health has GitLab's CLI and the Linear MCP server, next to GitHub's and Atlassian's", async () => {
  const cli = (ok: boolean, extra: Record<string, unknown> = {}) => ({ ok, path: ok ? '/usr/bin/x' : null, version: ok ? '1.0' : undefined, account: ok ? 'ann' : undefined, error: ok ? undefined : 'not installed (needed only for GitLab)', ...extra });
  const health = { checkedAt: 'now', claude: { ok: true }, git: { ok: true, version: '2' }, gh: cli(true), glab: cli(false) };
  const p = integrationsPanel({ health, mcpIntakeServer: async (t: string) => (t === 'linear' ? { server: 'linear' } : { server: 'Atlassian', site: 'acme.atlassian.net' }) });
  const h = (await p.healthSummary()) as HealthReport;
  assert.deepEqual(h.glab, { ok: false, version: undefined, account: undefined, error: 'not installed (needed only for GitLab)', installed: false });
  assert.deepEqual(h.gh, { ok: true, version: '1.0', account: 'ann', error: undefined, installed: true });
  assert.equal(h.linearMcp, 'linear');
  assert.equal(h.atlassianMcp, 'Atlassian');
});
