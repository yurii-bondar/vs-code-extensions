// End to end: tasks from GitHub, GitLab and Linear issues, through the real engine, git and the fake Claude CLI, with
// gh and glab answered by a fake and origins that look like the forges but push to a bare repo here.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as view from '../src/core/view';
import { BitbucketClient } from '../src/core/bitbucket';
import { Engine } from '../src/core/engine';
import { HookServer } from '../src/core/hookserver';
import { ClaudeRunner } from '../src/core/runner';
import { loadConfig, setRepo } from '../src/core/config';
import { git, harness, runTask, waitFor, workspace } from './helpers/e2e';
import type { ExecResult } from '../src/core/git';
import type { Run } from '../src/core/forge';

const ok = (stdout: unknown): ExecResult => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });

/** A fake gh/glab answering by the first rule whose pattern the command line matches. */
function fakeCli(rules: [RegExp, (args: readonly string[]) => ExecResult][]): Run {
  return async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    const hit = rules.find(([re]) => re.test(line));
    return hit ? hit[1](args) : { code: 1, stdout: '', stderr: `no rule for ${line}` };
  };
}

/** `name`'s origin at `url`, which git pushes to a bare repo here (`url.<bare>.insteadOf`). */
function origin(ws: string, name: string, url: string): string {
  const bare = path.join(ws, `${name}-remote.git`);
  git(ws, 'init', '-q', '--bare', bare);
  const dir = path.join(ws, name);
  git(dir, 'remote', 'add', 'origin', url);
  git(dir, 'config', `url.${bare}.insteadOf`, url);
  git(dir, 'push', '-q', 'origin', 'main');
  return bare;
}

const ISSUE_BODY = 'Signup accepts anything.\n\n## Acceptance criteria\n\n- [ ] email format is checked\n- [ ] passwords have 12+ characters';

test('engine: a GitHub issue (#12) becomes a ticket, a branch and a commit that name it, and a PR that closes it', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  const bare = origin(ws, 'api', 'git@github.com:acme/api.git');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  const created: { args: readonly string[]; body: string }[] = [];
  h.engine.cli = fakeCli([
    [/^gh issue view 12 --repo acme\/api /, () => ok({ title: 'Validate signup', url: 'https://github.com/acme/api/issues/12', body: ISSUE_BODY, labels: [{ name: 'bug' }], comments: [{ author: { login: 'pm' }, createdAt: '2026-11-01T00:00:00Z', body: 'inline errors please' }] })],
    [/^gh pr view /, () => ({ code: 1, stdout: '', stderr: 'no pull requests found' })],
    [
      /^gh pr create /,
      (args) => {
        created.push({ args, body: fs.readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf8') });
        return ok('https://github.com/acme/api/pull/5\n');
      },
    ],
  ]);
  try {
    const { taskId } = await h.engine.start({ text: '#12', auto: true });
    assert.equal(taskId, 'api-12');
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'confirm-push', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(s.spec!.title, 'Validate signup');
    assert.deepEqual(s.spec!.acceptanceCriteria, ['email format is checked', 'passwords have 12+ characters']);
    const ticket = await h.engine.svc.readArtifact(taskId, 'ticket.md');
    assert.match(ticket, /## Labels\n\nbug/);
    assert.match(ticket, /\*\*pm\*\* \(2026-11-01\):\ninline errors please/);
    assert.deepEqual(await h.engine.svc.readTranscript(taskId, '0000-intake'), [], 'no agent reads it: gh does');

    const branch = 'feat/api-12-add-feature';
    const api = path.join(ws, 'api');
    assert.match(git(api, 'log', '-1', '--format=%B', branch), /\n\nRefs: acme\/api#12$/);
    const d = await view.detail(h.engine, taskId);
    assert.deepEqual(d.source, { kind: 'github', label: 'acme/api#12', url: 'https://github.com/acme/api/issues/12' });

    await h.engine.answer(taskId, 'confirm-push', 'push');
    s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)));
    assert.equal(s.outcome, 'published', JSON.stringify(h.engine.lastError(taskId)));
    assert.deepEqual(s.prs, { api: 'https://github.com/acme/api/pull/5' });
    assert.equal(git(bare, 'rev-parse', branch), git(api, 'rev-parse', branch), 'pushed to origin');
    const pr = created[0]!;
    assert.equal(pr.args[pr.args.indexOf('--title') + 1], 'feat: add the feature', 'GitHub ties it with the body, not the title');
    assert.ok(pr.args.includes('--draft'));
    assert.match(pr.body, /## Why\n\n\[acme\/api#12\]\(https:\/\/github\.com\/acme\/api\/issues\/12\)\n\nCloses #12\n/);
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a GitLab issue link becomes a task whose draft MR closes it, opened with glab on its host', async () => {
  const ws = workspace(['api'], 'pipeline: [planner, developer]\nrepos:\n  api: {}\n');
  origin(ws, 'api', 'git@gitlab.com:acme/api.git');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  const sent: Record<string, unknown>[] = [];
  h.engine.cli = fakeCli([
    [/^glab api --hostname gitlab\.com projects\/acme%2Fapi\/issues\/3\/notes/, () => ok([])],
    [/^glab api --hostname gitlab\.com projects\/acme%2Fapi\/issues\/3$/, () => ok({ title: 'Dark mode', description: ISSUE_BODY, web_url: 'https://gitlab.com/acme/api/-/issues/3', labels: [] })],
    [/merge_requests\?state=opened&source_branch=/, () => ok([])],
    [
      /^glab api --hostname gitlab\.com --method POST .* projects\/acme%2Fapi\/merge_requests$/,
      (args) => {
        sent.push(JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1]!, 'utf8')) as Record<string, unknown>);
        return ok({ iid: 8, web_url: 'https://gitlab.com/acme/api/-/merge_requests/8' });
      },
    ],
  ]);
  try {
    const { taskId } = await h.engine.start({ text: 'https://gitlab.com/acme/api/-/issues/3', auto: true });
    assert.equal(taskId, 'api-3');
    await runTask(h.engine, taskId);
    await h.engine.answer(taskId, 'confirm-push', 'push');
    const s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)));
    assert.equal(s.outcome, 'published', JSON.stringify(h.engine.lastError(taskId)));
    assert.deepEqual(s.prs, { api: 'https://gitlab.com/acme/api/-/merge_requests/8' });
    assert.equal(sent[0]!.title, 'Draft: feat: add the feature');
    assert.equal(sent[0]!.source_branch, 'feat/api-3-add-feature');
    assert.equal(sent[0]!.target_branch, 'main');
    assert.match(String(sent[0]!.description), /\n\nCloses #3\n/);
    assert.deepEqual((await view.detail(h.engine, taskId)).source, { kind: 'gitlab', label: 'acme/api#3', url: 'https://gitlab.com/acme/api/-/issues/3' });
  } finally {
    h.hooks.dispose();
  }
});

test("engine: a Linear issue is read through Linear's MCP server, read-only and on its own host; without one the task says how", async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner]\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  const asked: string[] = [];
  h.engine.mcpIntake = async (tracker) => (asked.push(tracker), tracker === 'linear' ? { server: 'linear', site: undefined } : { server: 'Atlassian', site: 'acme.atlassian.net' });
  const url = 'https://linear.app/acme/issue/ENG-12/dark-mode';
  try {
    const { taskId } = await h.engine.start({ text: url });
    assert.equal(taskId, 'ENG-12');
    await h.engine.run(taskId);
    const s = await h.engine.svc.state(taskId);
    assert.equal(s.phase, 'done', JSON.stringify(h.engine.lastError(taskId)));
    assert.ok(asked.includes('linear') && !asked.includes('atlassian'), `asked for ${asked.join(', ')}`);
    assert.equal(s.spec!.title, 'ENG-12 Dark mode');
    assert.deepEqual(s.spec!.acceptanceCriteria, ['follows the OS setting']);
    assert.deepEqual(s.spec!.links[0], { title: 'ENG-12', url });
    const intake = await h.engine.svc.readTranscript(taskId, '0000-intake');
    assert.ok(intake.some((i) => i.type === 'tool_use' && i.name === 'mcp__linear__get_issue'));
    assert.ok(intake.some((i) => i.type === 'blocked' && i.tool === 'mcp__linear__update_issue'), 'a write is blocked');
    assert.ok(intake.some((i) => i.type === 'blocked' && i.tool === 'mcp__linear__get_document' && /evil\.example/.test(String(i.reason))), 'another host is blocked');
    assert.deepEqual((await view.detail(h.engine, taskId)).source, { kind: 'linear', label: 'ENG-12', url });

    h.engine.mcpIntake = async () => null;
    const other = await h.engine.start({ text: 'https://linear.app/acme/issue/ENG-13' });
    await assert.rejects(h.engine.run(other.taskId), (e: { code?: string; message: string }) => e.code === 'linear_not_connected' && /claude mcp add --transport http linear/.test(e.message));
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a readiness check of a GitHub issue looks for the branches and commits its tasks make', async () => {
  const ws = workspace(['api'], 'repos:\n  api:\n    role: Betting API\n');
  origin(ws, 'api', 'https://github.com/acme/api.git');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  h.engine.cli = fakeCli([[/^gh issue view 12 --repo acme\/api /, () => ok({ title: 'Validate signup', url: 'https://github.com/acme/api/issues/12', body: ISSUE_BODY })]]);
  try {
    const { taskId } = await h.engine.start({ text: '#12', scenario: 'readiness' });
    assert.equal(taskId, 'api-12-check');
    const s = await runTask(h.engine, taskId);
    assert.equal(s.status, 'done', JSON.stringify(h.engine.lastError(taskId)));
    const prompt = fs.readFileSync(path.join(h.state, 'prompt-verifier.txt'), 'utf8');
    assert.match(prompt, /GitHub issue: acme\/api#12\. Its work is on branches named <type>\/api-12-<slug>, and its commits say "Refs: acme\/api#12"/);
    assert.ok(!/prs\.md/.test(prompt), 'no key to search PRs for');
  } finally {
    h.hooks.dispose();
  }
});

test('engine: a readiness check lists the PRs and MRs of a key on GitHub, GitLab and Bitbucket; a repo it cannot ask says so', async () => {
  const ws = workspace(['api', 'web', 'shop'], 'repos:\n  api: {}\n  web: {}\n  shop: {}\n');
  git(path.join(ws, 'api'), 'remote', 'add', 'origin', 'git@github.com:acme/api.git');
  git(path.join(ws, 'web'), 'remote', 'add', 'origin', 'git@gitlab.com:acme/web.git');
  git(path.join(ws, 'shop'), 'remote', 'add', 'origin', 'git@bitbucket.org:acme/shop.git');
  const runner = new ClaudeRunner({ command: () => 'claude', flags: () => new Set(), settingSources: () => [], env: () => ({}) });
  const engine = new Engine({ workspace: ws, home: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-home-')), runner, hooks: new HookServer() });
  engine.cli = fakeCli([
    [/^gh pr list --search ENG-1 /, () => ok([{ number: 42, title: 'ENG-1 api', url: 'https://github.com/acme/api/pull/42', state: 'MERGED', isDraft: false, headRefName: 'feat/ENG-1-x', baseRefName: 'main', mergedAt: '2026-10-01T00:00:00Z' }])],
    [/^glab api --hostname gitlab\.com projects\/acme%2Fweb\/merge_requests\?state=all.*search=ENG-1/, () => ok([{ iid: 4, title: 'ENG-1 web', web_url: 'https://gitlab.com/acme/web/-/merge_requests/4', state: 'opened', draft: true, source_branch: 'feat/ENG-1-x', target_branch: 'main' }])],
  ]);
  const r = await loadConfig({ workspace: ws, home: engine.home! });
  assert.ok(r.ok);
  const repos = ['api', 'web', 'shop'].map((name) => ({ name, dir: path.join(ws, name) }));
  const { taskId } = await engine.start({ text: 'check it' });

  const noToken = await engine.listPrs(taskId, 'ENG-1', repos, r.config);
  const text = fs.readFileSync(noToken, 'utf8');
  assert.match(text, /## api\n\n- #42 \[merged, merged 2026-10-01\] ENG-1 api: feat\/ENG-1-x → main, https:\/\/github\.com\/acme\/api\/pull\/42/);
  assert.match(text, /## web\n\n- !4 \[opened, draft\] ENG-1 web: feat\/ENG-1-x → main, https:\/\/gitlab\.com\/acme\/web\/-\/merge_requests\/4/);
  assert.match(text, /## shop\n\nBitbucket could not be asked: acme\/shop is on Bitbucket.*API token.*Judge the branches and commits\./);

  const fetch = (async () => new Response(JSON.stringify({ values: [{ id: 3, title: 'ENG-1 shop', state: 'MERGED', links: { html: { href: 'https://bitbucket.org/acme/shop/pull-requests/3' } }, source: { branch: { name: 'feat/ENG-1-x' } }, destination: { branch: { name: 'main' } } }] }), { status: 200 })) as unknown as typeof globalThis.fetch;
  engine.bitbucket = () => new BitbucketClient({ email: 'dev@acme.com', token: 'bb-token-123456789' }, { fetch });
  const withToken = fs.readFileSync(await engine.listPrs(taskId, 'ENG-1', repos, r.config), 'utf8');
  assert.match(withToken, /## shop\n\n- #3 \[merged\] ENG-1 shop: feat\/ENG-1-x → main, https:\/\/bitbucket\.org\/acme\/shop\/pull-requests\/3/);
});

test('engine: repos.<name>.forge names the forge of an origin whose host does not say', async () => {
  const ws = workspace(['web'], 'repos:\n  web:\n    forge: gitlab\n');
  git(path.join(ws, 'web'), 'remote', 'add', 'origin', 'git@git.acme.com:team/web.git');
  const runner = new ClaudeRunner({ command: () => 'claude', flags: () => new Set(), settingSources: () => [], env: () => ({}) });
  const engine = new Engine({ workspace: ws, home: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-home-')), runner, hooks: new HookServer() });
  const r = await loadConfig({ workspace: ws, home: engine.home! });
  assert.ok(r.ok);
  assert.equal(r.config.repos.web!.forge, 'gitlab');
  assert.deepEqual(await engine.remoteOf('web', path.join(ws, 'web'), r.config), { forge: 'gitlab', host: 'git.acme.com', project: 'team/web' });
  assert.deepEqual(await engine.resolveSource({ kind: 'issue', number: 5 }, r.config), { kind: 'gitlab', host: 'git.acme.com', project: 'team/web', number: 5 });

  // The Repos page writes the entry as it has it, which has no forge: the one written stays.
  await setRepo(ws, 'web', { role: 'Web app', gates: [{ name: 'lint', cmd: 'npm run lint' }] });
  const saved = await loadConfig({ workspace: ws, home: engine.home! });
  assert.ok(saved.ok);
  assert.equal(saved.config.repos.web!.forge, 'gitlab');
  assert.equal(saved.config.repos.web!.role, 'Web app');
  await setRepo(ws, 'site', { role: 'Web app' }, 'web');
  assert.match(fs.readFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'utf8'), /site:\n(\s+\w+: .*\n)*\s+forge: gitlab/, 'renamed, still on GitLab');

  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'repos:\n  web:\n    forge: gitea\n');
  const bad = await loadConfig({ workspace: ws, home: engine.home! });
  assert.ok(!bad.ok);
  assert.match(bad.errors.map((e) => e.message).join('\n'), /repos\.web\.forge/);
});
