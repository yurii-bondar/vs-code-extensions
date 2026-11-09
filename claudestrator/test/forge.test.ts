// GitHub, GitLab and Linear issues as task sources, and GitLab merge requests next to GitHub's pull requests.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { changeRequests, issueLine, parseRemote, readIssue, ForgeError, type Run } from '../src/core/forge';
import { classifyInput, deriveTaskId, planFromTicket, runIntake, sourceRef, IntakeError } from '../src/core/intake';
import { forgeCli } from '../src/core/env';
import { guardBash, type GuardContext } from '../src/core/guard';
import { branchName } from '../src/core/machine';
import { prBody, prTitle } from '../src/core/pr';
import { Engine } from '../src/core/engine';
import { HookServer } from '../src/core/hookserver';
import { ClaudeRunner } from '../src/core/runner';
import { loadConfig } from '../src/core/config';
import { git, workspace } from './helpers/e2e';
import type { ExecResult } from '../src/core/git';
import type { Source, TaskState } from '../src/core/types';

const ok = (stdout: unknown): ExecResult => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });

/** A fake gh/glab: answers by the first rule whose pattern the command line matches, and records every call. */
function fakeCli(rules: [RegExp, ExecResult | ((args: readonly string[]) => ExecResult)][]) {
  const calls: { cmd: string; args: readonly string[]; cwd: string | undefined }[] = [];
  const run: Run = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const line = [cmd, ...args].join(' ');
    const hit = rules.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: '', stderr: `no rule for ${line}` };
    return typeof hit[1] === 'function' ? hit[1](args) : hit[1];
  };
  return { run, calls };
}

test('intake: GitHub, GitLab and Linear issue links and references', () => {
  assert.deepEqual(classifyInput('https://github.com/acme/api/issues/12'), { kind: 'github', host: 'github.com', repo: 'acme/api', number: 12 });
  assert.deepEqual(classifyInput('https://github.acme.io/team/api/issues/7/'), { kind: 'github', host: 'github.acme.io', repo: 'team/api', number: 7 }, 'GitHub Enterprise');
  assert.equal(classifyInput('https://github.com/acme/api/pull/12').kind, 'pr', 'a PR is not an issue: it is reviewed');
  assert.deepEqual(classifyInput('https://gitlab.com/acme/platform/api/-/issues/42'), { kind: 'gitlab', host: 'gitlab.com', project: 'acme/platform/api', number: 42 });
  assert.deepEqual(classifyInput('https://git.acme.com/team/web/-/work_items/5'), { kind: 'gitlab', host: 'git.acme.com', project: 'team/web', number: 5 }, "GitLab's /-/ path on any host");
  assert.deepEqual(classifyInput('https://linear.app/acme/issue/ENG-123/fix-the-login'), { kind: 'linear', key: 'ENG-123', url: 'https://linear.app/acme/issue/ENG-123/fix-the-login' });
  assert.deepEqual(classifyInput('#12'), { kind: 'issue', number: 12 });
  assert.deepEqual(classifyInput('acme/api#12'), { kind: 'issue', number: 12, project: 'acme/api' });
  assert.deepEqual(classifyInput('group/sub/web#3'), { kind: 'issue', number: 3, project: 'group/sub/web' });
  assert.equal(classifyInput('#0').kind, 'text');
  assert.equal(classifyInput('fix #12 in the login form').kind, 'text', 'a reference inside a sentence is words');
  assert.equal(classifyInput('ENG-123').kind, 'jira', 'a bare key stays Jira');
});

test('intake: task ids and references of issues', () => {
  const gh: Source = { kind: 'github', host: 'github.com', repo: 'acme/api', number: 12 };
  const gl: Source = { kind: 'gitlab', host: 'gitlab.com', project: 'acme/platform/web.app', number: 3 };
  const li: Source = { kind: 'linear', key: 'ENG-9', url: 'https://linear.app/acme/issue/ENG-9' };
  const now = new Date();
  assert.equal(deriveTaskId(gh, now), 'api-12');
  assert.equal(deriveTaskId(gh, now, 'readiness'), 'api-12-check');
  assert.equal(deriveTaskId(gl, now), 'web.app-3');
  assert.equal(deriveTaskId({ ...gh, repo: 'acme/.github' }, now), 'github-12', 'an id starts with a letter or digit');
  assert.equal(deriveTaskId(li, now), 'ENG-9');
  assert.equal(sourceRef(gh), 'acme/api#12');
  assert.equal(sourceRef(gl), 'acme/platform/web.app#3');
  assert.equal(sourceRef(li), 'ENG-9');
  assert.equal(sourceRef({ kind: 'text', text: 'x' }), undefined);
});

test('forge: remotes over https, ssh and scp-like, by host or as configured', () => {
  assert.deepEqual(parseRemote('https://github.com/acme/api.git'), { forge: 'github', host: 'github.com', project: 'acme/api' });
  assert.deepEqual(parseRemote('git@github.com:acme/api.git'), { forge: 'github', host: 'github.com', project: 'acme/api' });
  assert.deepEqual(parseRemote('ssh://git@gitlab.acme.com:2222/group/sub/web.git'), { forge: 'gitlab', host: 'gitlab.acme.com', project: 'group/sub/web' }, "ssh's port is not the web's");
  assert.deepEqual(parseRemote('https://gitlab.acme.com:8443/group/web'), { forge: 'gitlab', host: 'gitlab.acme.com:8443', project: 'group/web' }, "an https port is the API's");
  assert.equal(parseRemote('git@git.acme.com:team/web.git'), null, 'a host that says neither');
  assert.deepEqual(parseRemote('git@git.acme.com:team/web.git', 'gitlab'), { forge: 'gitlab', host: 'git.acme.com', project: 'team/web' });
  assert.equal(parseRemote('/srv/git/web.git'), null);
  assert.equal(parseRemote('https://github.com/acme'), null, 'no project');
});

test('forge: a PR closes the issue on its own forge, and only refers to it when several PRs share it', () => {
  const issue: Source = { kind: 'github', host: 'github.com', repo: 'acme/api', number: 12 };
  const api = parseRemote('git@github.com:acme/api.git');
  const web = parseRemote('git@github.com:acme/web.git');
  assert.equal(issueLine(issue, api, 1), 'Closes #12');
  assert.equal(issueLine(issue, web, 1), 'Closes acme/api#12');
  assert.equal(issueLine(issue, api, 2), 'Refs #12');
  assert.equal(issueLine(issue, parseRemote('git@gitlab.com:acme/api.git'), 1), undefined, 'another forge');
  assert.equal(issueLine(issue, null, 1), undefined);
  assert.equal(issueLine({ kind: 'gitlab', host: 'gitlab.com', project: 'acme/api', number: 3 }, parseRemote('https://gitlab.com/acme/api.git'), 1), 'Closes #3');
  assert.equal(issueLine({ kind: 'jira', key: 'CP-1' }, api, 1), undefined);
});

test('forge: a GitHub issue is read with gh, a GitLab one with glab, without its system notes', async () => {
  const gh = fakeCli([
    [/^gh issue view 12 --repo acme\/api --json/, ok({ title: 'Validate signup', url: 'https://github.com/acme/api/issues/12', body: 'Do it.\n\n## Acceptance criteria\n\n- [ ] email format\n- [x] 12+ chars', labels: [{ name: 'bug' }], comments: [{ author: { login: 'ann' }, createdAt: '2026-11-01T10:00:00Z', body: 'also trim spaces' }] })],
  ]);
  const spec = await runIntake('api-12', { kind: 'github', host: 'github.com', repo: 'acme/api', number: 12 }, { run: gh.run });
  assert.equal(spec.title, 'Validate signup');
  assert.deepEqual(spec.acceptanceCriteria, ['email format', '12+ chars']);
  assert.deepEqual(spec.links, [{ title: 'acme/api#12', url: 'https://github.com/acme/api/issues/12' }]);
  assert.match(spec.context!, /## Labels\n\nbug/);
  assert.match(spec.context!, /\*\*ann\*\* \(2026-11-01\):\nalso trim spaces/);

  const ghe = fakeCli([[/^gh issue view 7 --repo github\.acme\.io\/team\/api /, ok({ title: 't', body: '' })]]);
  assert.equal((await readIssue({ kind: 'github', host: 'github.acme.io', repo: 'team/api', number: 7 }, ghe.run)).url, 'https://github.acme.io/team/api/issues/7', 'GitHub Enterprise by its host');

  const gl = fakeCli([
    [/^glab api --hostname gitlab\.acme\.com projects\/group%2Fweb\/issues\/3\/notes/, ok([{ body: 'changed the title', system: true, author: { username: 'bot' } }, { body: 'please hurry', author: { username: 'bob' }, created_at: '2026-11-02T00:00:00Z' }])],
    [/^glab api --hostname gitlab\.acme\.com projects\/group%2Fweb\/issues\/3$/, ok({ title: 'Dark mode', description: 'Add it', web_url: 'https://gitlab.acme.com/group/web/-/issues/3', labels: ['ui'] })],
  ]);
  const issue = await readIssue({ kind: 'gitlab', host: 'gitlab.acme.com', project: 'group/web', number: 3 }, gl.run);
  assert.deepEqual(issue, { title: 'Dark mode', url: 'https://gitlab.acme.com/group/web/-/issues/3', body: 'Add it', labels: ['ui'], comments: [{ author: 'bob', created: '2026-11-02T00:00:00Z', body: 'please hurry' }] });
});

test('forge: a CLI that is missing or signed out says what to do', async () => {
  const missing = fakeCli([[/./, { code: 127, stdout: '', stderr: 'glab: not found' }]]);
  await assert.rejects(readIssue({ kind: 'gitlab', host: 'gitlab.com', project: 'a/b', number: 1 }, missing.run), (e: ForgeError) => e.code === 'cli_missing' && /GitLab CLI \(glab\) is not installed/.test(e.message));
  const out = fakeCli([[/./, { code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }]]);
  await assert.rejects(runIntake('b-1', { kind: 'github', host: 'github.com', repo: 'a/b', number: 1 }, { run: out.run }), (e: IntakeError) => e.code === 'forge_auth' && /run gh auth login/.test(e.message));
  await assert.rejects(runIntake('ENG-1', { kind: 'linear', key: 'ENG-1', url: 'https://linear.app/a/issue/ENG-1' }), (e: IntakeError) => e.code === 'linear_mcp');
});

test('forge: GitLab merge requests over glab api, drafts by their title', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-forge-'));
  const body = path.join(dir, 'web.md');
  fs.writeFileSync(body, '## What\n\nDark mode');
  const sent: unknown[] = [];
  const cli = fakeCli([
    [/merge_requests\?state=opened&source_branch=feat%2Fweb-3-dark/, ok([])],
    [
      /--method POST .* projects\/group%2Fweb\/merge_requests$/,
      (args) => {
        sent.push(JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1]!, 'utf8')));
        return ok({ iid: 9, web_url: 'https://gitlab.acme.com/group/web/-/merge_requests/9' });
      },
    ],
    [
      /--method PUT .* projects\/group%2Fweb\/merge_requests\/9$/,
      (args) => {
        sent.push(JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1]!, 'utf8')));
        return ok({});
      },
    ],
    [/merge_requests\?state=all&in=title,description&per_page=50&search=ENG-1/, ok([{ iid: 4, title: 'ENG-1 x', web_url: 'u', state: 'merged', draft: false, source_branch: 'feat/ENG-1-x', target_branch: 'main', merged_at: '2026-10-01T00:00:00Z' }])],
  ]);
  const mrs = changeRequests({ remote: parseRemote('git@gitlab.acme.com:group/web.git'), dir, run: cli.run });
  assert.equal(mrs.noun, 'MR');
  assert.equal(await mrs.findOpen('feat/web-3-dark'), null);
  const created = await mrs.create({ base: 'main', head: 'feat/web-3-dark', title: 'feat: dark mode', bodyFile: body, draft: true });
  assert.deepEqual(created, { ok: true, value: 'https://gitlab.acme.com/group/web/-/merge_requests/9' });
  assert.deepEqual(sent[0], { source_branch: 'feat/web-3-dark', target_branch: 'main', title: 'Draft: feat: dark mode', description: '## What\n\nDark mode' });
  assert.deepEqual(await mrs.setBody('https://gitlab.acme.com/group/web/-/merge_requests/9', body), { ok: true, value: true });
  assert.deepEqual(sent[1], { description: '## What\n\nDark mode' });
  assert.ok(cli.calls.every((c) => c.cmd === 'glab' && c.args[1] === '--hostname' && c.args[2] === 'gitlab.acme.com' && c.cwd === dir), 'on the project\'s own host');
  const found = await mrs.search('ENG-1');
  assert.ok(found.ok);
  assert.deepEqual(found.value[0], { number: 4, title: 'ENG-1 x', url: 'u', state: 'merged', draft: false, head: 'feat/ENG-1-x', base: 'main', mergedAt: '2026-10-01T00:00:00Z' });

  // A repo whose origin is not on GitLab opens PRs with gh, as it always did.
  const gh = fakeCli([[/^gh pr create --draft --base main --head feat\/x --title t --body-file /, ok('Creating…\nhttps://github.com/acme/api/pull/5\n')]]);
  const prs = changeRequests({ remote: null, dir, run: gh.run });
  assert.deepEqual(await prs.create({ base: 'main', head: 'feat/x', title: 't', bodyFile: body, draft: true }), { ok: true, value: 'https://github.com/acme/api/pull/5' });
});

test('guard: agents only read with glab, and nobody merges an MR', async () => {
  const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: true, allowNoVerify: false, sandbox: true, localPorts: false, network: [], writable: [], checkEnv: [], protectedChanges: 'ask' as const };
  const ctx = (extra: Partial<GuardContext> = {}): GuardContext => ({ policy, cwd: '/ws/api', workspace: '/ws', home: '/home/u', agent: true, task: { taskId: 'T', canPush: false }, writeRoots: ['/ws/api'], branchOf: async () => 'feat/x', isRepoRoot: async (d) => d === '/ws/api', readFile: async () => null, ...extra });
  const allowed = async (command: string, c = ctx()): Promise<boolean> => (await guardBash(command, c)).allow;
  assert.ok(await allowed('glab mr view 3'));
  assert.ok(await allowed('glab issue list'));
  assert.ok(await allowed('glab api projects/1/merge_requests'));
  assert.ok(!(await allowed('glab auth status -t')), 'prints the token');
  assert.ok(!(await allowed('glab config get token')));
  assert.ok(!(await allowed('glab mr create --draft --fill')), "the orchestrator's");
  assert.ok(!(await allowed('glab mr note 3 -m hi')));
  assert.ok(!(await allowed('glab api -X POST projects/1/issues')));
  assert.ok(!(await allowed('glab api projects/1/issues -f title=x')));
  const human = ctx({ agent: false, task: { taskId: 'T', canPush: true } });
  assert.ok(!(await allowed('glab mr merge 3', human)));
  assert.ok(!(await allowed('glab api -X PUT projects/1/merge_requests/3/merge', human)));
  assert.ok(!(await allowed('glab mr create --fill', human)), 'drafts only');
  assert.ok(await allowed('glab mr create --draft --fill', human));
});

test('pr: an issue task branches with its id, a Linear PR title carries its key, a PR body closes its GitHub issue', async () => {
  const base = { taskId: 'api-12', plan: { type: 'feat', slug: 'validate-signup', title: 'validate signup', repos: [], openQuestions: [] } };
  const of = (source: Source, taskId = base.taskId) => ({ ...base, taskId, source }) as unknown as TaskState;
  assert.equal(branchName(of({ kind: 'github', host: 'github.com', repo: 'acme/api', number: 12 })), 'feat/api-12-validate-signup');
  assert.equal(branchName(of({ kind: 'linear', key: 'ENG-9', url: 'u' }, 'ENG-9')), 'feat/ENG-9-validate-signup');
  assert.equal(branchName(of({ kind: 'text', text: 'x' })), 'feat/validate-signup');
  assert.equal(prTitle(of({ kind: 'linear', key: 'ENG-9', url: 'u' }, 'ENG-9')), 'feat: validate signup (ENG-9)');
  assert.equal(prTitle(of({ kind: 'github', host: 'github.com', repo: 'acme/api', number: 12 })), 'feat: validate signup', 'GitHub ties it with the body');

  const state = { ...of({ kind: 'github', host: 'github.com', repo: 'acme/api', number: 12 }), input: '#12', artifacts: [], repos: [{ name: 'api' }], gateFailures: [], review: { openFindings: [] }, spec: { title: 'Validate signup', links: [{ title: 'acme/api#12', url: 'https://github.com/acme/api/issues/12' }] } } as unknown as TaskState;
  const body = await prBody({ state, repo: 'api', taskDir: os.tmpdir(), language: 'English', issueLine: 'Closes #12' });
  assert.match(body, /## Why\n\n\[acme\/api#12\]\(https:\/\/github\.com\/acme\/api\/issues\/12\)\n\nCloses #12\n/);
});

test('engine: #12 is an issue of the one project the repos are on, else it asks which', async () => {
  const ws = workspace(['api', 'web'], 'repos:\n  api: {}\n  web: {}\n');
  git(path.join(ws, 'api'), 'remote', 'add', 'origin', 'git@github.com:acme/api.git');
  const hooks = new HookServer();
  const runner = new ClaudeRunner({ command: () => 'claude', flags: () => new Set(), settingSources: () => [], env: () => ({}) });
  const gh = fakeCli([[/^gh issue view 12 --repo acme\/api /, ok({ title: 'Validate signup', url: 'https://github.com/acme/api/issues/12', body: 'b', labels: [], comments: [] })]]);
  const engine = new Engine({ workspace: ws, home: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-home-')), runner, hooks, cli: gh.run });
  const config = async () => {
    const r = await loadConfig({ workspace: ws, home: engine.home! });
    assert.ok(r.ok);
    return r.config;
  };

  assert.deepEqual(await engine.resolveSource({ kind: 'issue', number: 12 }, await config()), { kind: 'github', host: 'github.com', repo: 'acme/api', number: 12 }, 'web has no origin');
  const p = await engine.preview({ text: '#12' });
  assert.ok(p.ok && !('empty' in p));
  assert.equal(p.taskId, 'api-12');
  assert.equal(p.source.kind, 'github');

  const { taskId } = await engine.start({ text: '#12' });
  const spec = await engine.readTicket(await engine.svc.state(taskId));
  assert.equal(spec.title, 'Validate signup');

  git(path.join(ws, 'web'), 'remote', 'add', 'origin', 'https://gitlab.com/acme/web.git');
  await assert.rejects(engine.resolveSource({ kind: 'issue', number: 3 }, await config()), /#3 names no one project: the repos are in acme\/api \(github\.com\), acme\/web \(gitlab\.com\)/);
  assert.deepEqual(await engine.resolveSource({ kind: 'issue', number: 3, project: 'acme/web' }, await config()), { kind: 'gitlab', host: 'gitlab.com', project: 'acme/web', number: 3 });
  assert.deepEqual(await engine.resolveSource({ kind: 'issue', number: 3, project: 'other/lib' }, await config()), { kind: 'github', host: 'github.com', repo: 'other/lib', number: 3 }, "a project no repo is on: GitHub's notation");
  const ambiguous = await engine.preview({ text: '#3' });
  assert.ok(ambiguous.ok && !('empty' in ambiguous));
  assert.match(ambiguous.problem!, /names no one project/);
});

test('intake: links that only look like issues stay text; a Linear title loses its key in the branch', () => {
  assert.equal(classifyInput('https://linear.example.com/acme/issue/ENG-1').kind, 'text', 'Linear is linear.app');
  assert.equal(classifyInput('https://gitea.acme.com/acme/api/issues/3').kind, 'text', 'a host that is not GitHub, without GitLab\'s /-/');
  assert.equal(classifyInput('ftp://github.com/acme/api/issues/3').kind, 'text');
  const plan = planFromTicket({ title: 'ENG-9 Dark mode for the dashboard', source: { kind: 'linear', key: 'ENG-9', url: 'u' } }, '', ['web']);
  assert.equal(plan.slug, 'dark-mode-for-the-dashboard');
  assert.equal(plan.title, 'Dark mode for the dashboard');
});

test('forge: a GitLab issue whose comments cannot be read is still read; an MR glab cannot open says why', async () => {
  const cli = fakeCli([
    [/\/notes/, { code: 1, stdout: '', stderr: '403 Forbidden' }],
    [/issues\/3$/, ok({ title: 'Dark mode', description: 'x', web_url: 'https://gitlab.com/a/b/-/issues/3', labels: [] })],
    [/--method POST/, { code: 1, stdout: '', stderr: '{"message":["Another open merge request already exists for this source branch"]}' }],
    [/--method PUT/, { code: 1, stdout: '', stderr: '404 Not Found' }],
  ]);
  const issue = await readIssue({ kind: 'gitlab', host: 'gitlab.com', project: 'a/b', number: 3 }, cli.run);
  assert.equal(issue.title, 'Dark mode');
  assert.deepEqual(issue.comments, []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-forge-'));
  const body = path.join(dir, 'b.md');
  fs.writeFileSync(body, 'x');
  const mrs = changeRequests({ remote: parseRemote('git@gitlab.com:a/b.git'), dir, run: cli.run });
  const made = await mrs.create({ base: 'main', head: 'feat/x', title: 't', bodyFile: body, draft: false });
  assert.ok(!made.ok);
  assert.match(made.error, /glab could not open a merge request from feat\/x: .*Another open merge request already exists/);
  const set = await mrs.setBody('https://gitlab.com/a/b/-/merge_requests/9', body);
  assert.ok(!set.ok && /404 Not Found/.test(set.error));
  assert.deepEqual(await mrs.setBody('https://gitlab.com/a/b/-/issues/9', body), { ok: false, error: 'https://gitlab.com/a/b/-/issues/9 is not a merge request\'s address' });
});

test('forge: GitHub PRs as before: an open one is found, a description is set, a key is searched', async () => {
  const cli = fakeCli([
    [/^gh pr view feat\/x /, ok('https://github.com/a/b/pull/3\n')],
    [/^gh pr view feat\/y /, ok('')],
    [/^gh pr edit https:\/\/github\.com\/a\/b\/pull\/3 --body-file /, ok('')],
    [/^gh pr edit /, { code: 1, stdout: '', stderr: 'GraphQL: Resource not accessible' }],
    [/^gh pr list --search CP-1 --state all /, ok([{ number: 7, title: 'CP-1 x', url: 'u', state: 'OPEN', isDraft: true, headRefName: 'feat/CP-1-x', baseRefName: 'main', mergedAt: null }])],
  ]);
  const prs = changeRequests({ remote: parseRemote('git@github.com:a/b.git'), dir: '/ws/b', run: cli.run });
  assert.equal(prs.noun, 'PR');
  assert.equal(await prs.findOpen('feat/x'), 'https://github.com/a/b/pull/3');
  assert.equal(await prs.findOpen('feat/y'), null, 'none open');
  assert.deepEqual(await prs.setBody('https://github.com/a/b/pull/3', '/tmp/b.md'), { ok: true, value: true });
  assert.deepEqual(await prs.setBody('https://github.com/a/b/pull/4', '/tmp/b.md'), { ok: false, error: 'GraphQL: Resource not accessible' });
  const found = await prs.search('CP-1');
  assert.ok(found.ok);
  assert.deepEqual(found.value, [{ number: 7, title: 'CP-1 x', url: 'u', state: 'open', draft: true, head: 'feat/CP-1-x', base: 'main', mergedAt: '' }]);
  assert.ok(cli.calls.every((c) => c.cwd === '/ws/b'), 'in the repo, where gh finds its project');
});

test('env: a forge CLI is found, its version and account read, and what is wrong with it said', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cli-'));
  const script = (name: string, auth: string): void => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ncase "$1" in --version) echo "${name} 1.46.0 (2026-10-01)";; auth) ${auth};; esac\n`, { mode: 0o755 });
  script('glab', 'echo "gitlab.com\n  ✓ Logged in to gitlab.com as ann (keyring)" >&2; exit 0');
  script('gh', 'echo "You are not logged into any GitHub hosts." >&2; exit 1');
  const env = { ...process.env, PATH: bin };
  assert.deepEqual(await forgeCli('glab', bin, env, 'needed only for GitLab'), { path: path.join(bin, 'glab'), ok: true, version: '1.46.0 (2026-10-01)', account: 'ann' });
  const gh = await forgeCli('gh', bin, env, 'needed only for GitHub');
  assert.equal(gh.ok, false);
  assert.equal(gh.error, 'not logged in (run: gh auth login)');
  fs.rmSync(path.join(bin, 'glab'));
  assert.deepEqual(await forgeCli('glab', bin, env, 'needed only for GitLab'), { path: null, ok: false, error: 'not installed (needed only for GitLab)' });
});
