// PR review end to end: a pull request's link, its head in a worktree of its own, the reviewers (two at once once the
// appsec reviewer is on), and the review posted to it only once you say so. Real git and engine, the fake Claude CLI,
// gh answered by a fake, and an origin that looks like GitHub but is a bare repo here with the PR's ref in it.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import * as view from '../src/core/view';
import { worktreeDir } from '../src/core/git';
import { git, harness, previewOf, runTask, waitFor, workspace } from './helpers/e2e';
import type { ExecResult } from '../src/core/git';
import type { Run } from '../src/core/forge';

const ok = (stdout: unknown): ExecResult => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });

/**
 * `api` with an origin at git@github.com:acme/api.git that is a bare repo here, and pull request #12 in it: a branch
 * adding src/cap.js, under GitHub's own ref for it. The checkout stays on main.
 */
function prWorkspace(config = 'repos:\n  api: {}\n') {
  const ws = workspace(['api'], config);
  const api = path.join(ws, 'api');
  const bare = path.join(ws, 'api-remote.git');
  git(ws, 'init', '-q', '--bare', bare);
  git(api, 'remote', 'add', 'origin', 'git@github.com:acme/api.git');
  git(api, 'config', `url.${bare}.insteadOf`, 'git@github.com:acme/api.git');
  git(api, 'push', '-q', 'origin', 'main');
  git(api, 'switch', '-q', '-c', 'feat/cap');
  fs.mkdirSync(path.join(api, 'src'));
  fs.writeFileSync(path.join(api, 'src', 'cap.js'), 'const CAP = 100;\nfunction bet(x) { return x; }\nmodule.exports = { bet, CAP };\n');
  git(api, 'add', '.');
  git(api, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'cap bets');
  const sha = git(api, 'rev-parse', 'HEAD');
  git(api, 'push', '-q', 'origin', 'HEAD:refs/pull/12/head');
  git(api, 'switch', '-q', 'main');
  git(api, 'branch', '-q', '-D', 'feat/cap');
  return { ws, api, sha };
}

/**
 * gh as GitHub would answer it about #12, recording the reviews posted and the line comments sent on their own.
 * `refuseLine`: a review with line comments is refused (422), and so is a line comment on that line.
 */
function fakeGh(sha: string, posted: Record<string, unknown>[], { refuseLine, single = [] }: { refuseLine?: number; single?: Record<string, unknown>[] } = {}): Run {
  return async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    if (/^gh pr view 12 --repo acme\/api --json /.test(line)) return ok({ title: 'Cap bets at 100', body: 'Bets above the cap must be refused.\n\n## Acceptance criteria\n- a bet over 100 is refused', url: 'https://github.com/acme/api/pull/12', baseRefName: 'main', headRefName: 'feat/cap', headRefOid: sha, comments: [{ author: { login: 'ann' }, createdAt: '2026-11-08T00:00:00Z', body: 'please check the cap' }] });
    if (/^gh api --hostname github\.com --method POST .* repos\/acme\/api\/pulls\/12\/reviews$/.test(line)) {
      const body = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1]!, 'utf8')) as Record<string, unknown>;
      posted.push(body);
      if (refuseLine !== undefined && (body.comments as unknown[]).length) return { code: 1, stdout: '', stderr: 'gh: Unprocessable Entity (HTTP 422): Line could not be resolved' };
      return ok({ html_url: 'https://github.com/acme/api/pull/12#pullrequestreview-1' });
    }
    if (/^gh api --hostname github\.com --method POST .* repos\/acme\/api\/pulls\/12\/comments$/.test(line)) {
      const body = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1]!, 'utf8')) as Record<string, unknown>;
      single.push(body);
      return body.line === refuseLine ? { code: 1, stdout: '', stderr: 'gh: Unprocessable Entity (HTTP 422): line must be part of the diff' } : ok({ id: 9 });
    }
    return { code: 1, stdout: '', stderr: `no rule for ${line}` };
  };
}

const FINDINGS = JSON.stringify([
  { severity: 'major', repo: 'api', file: 'src/cap.js', line: 2, problem: 'bet() never checks CAP', fix: 'refuse x > CAP' },
  { severity: 'minor', repo: 'api', file: 'api/README.md', line: 99, problem: 'the cap is not documented' },
]);
const PR = 'https://github.com/acme/api/pull/12';

test('PR review: a pull request link is reviewed in a worktree at its head, and posted with comments on its lines once you say so', async () => {
  const { ws, api, sha } = prWorkspace();
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_PR_FINDINGS: FINDINGS });
  const posted: Record<string, unknown>[] = [];
  h.engine.cli = fakeGh(sha, posted);
  try {
    const p = await previewOf(h.engine, { text: PR });
    assert.equal(p.scenarioName, 'pr-review', 'the link picks the PR review');
    assert.equal(p.taskId, 'api-pr-12');
    assert.deepEqual(p.source, { kind: 'pr', forge: 'github', host: 'github.com', project: 'acme/api', number: 12 });
    assert.deepEqual(p.pipeline.stages.map((st) => st.agent), ['reviewer'], 'the appsec reviewer is off by default');
    assert.equal(p.problem, undefined);

    const { taskId } = await h.engine.start({ text: PR });
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'post-review', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal(s.spec!.title, 'Cap bets at 100');
    assert.deepEqual(s.spec!.acceptanceCriteria, ['a bet over 100 is refused']);
    assert.deepEqual(s.spec!.pr, { url: PR, repo: 'api', base: 'main', head: 'feat/cap', headSha: sha });
    assert.deepEqual(s.repos, [{ name: 'api', mode: 'full', baseBranch: 'main' }]);

    // Read at the PR's head, in a worktree; your checkout stays on main, as it was.
    const dir = worktreeDir(ws, taskId, 'api');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), sha);
    assert.equal(git(api, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(api, 'status', '--porcelain'), '');
    const diff = await h.engine.svc.readArtifact(taskId, 'reviews/r1/diff.patch');
    assert.match(diff, /^################ api \(acme\/api#12: feat\/cap → main, at [0-9a-f]{12}\)\n/);
    assert.match(diff, /\+\+\+ b\/src\/cap\.js/);
    const prompt = fs.readFileSync(path.join(h.state, 'prompt-reviewer.txt'), 'utf8');
    assert.ok(prompt.includes(`The pull request under review: ${PR}, from feat/cap into main, in the repo api. Its code at the commit under review is checked out at ${dir}.`), prompt);
    assert.ok(JSON.stringify(h.calls()).includes('This is a pull request someone opened, not a task'), "the scenario's step instructions reach the reviewer");

    // What would be posted is in front of you before it is.
    const d = await view.detail(h.engine, taskId);
    assert.equal(d.status.label, 'Post the review');
    const ctx = await h.engine.checkpointContext(s, s.checkpoint);
    assert.match(ctx.text, /### On the changed lines\n\n\*\*`src\/cap\.js:2`\*\*\n\n\*\*Major:\*\* bet\(\) never checks CAP\n\n\*\*Fix:\*\* refuse x > CAP/);
    assert.match(ctx.text, /### Findings\n\n- \*\*Minor\*\* `README\.md:99` the cap is not documented/, 'off the diff: in the summary, without the repo before its path');
    assert.equal(posted.length, 0, 'nothing posted before you say so');
    assert.deepEqual(ctx.review!.items.map((i) => [i.severity, i.path, i.line, i.inline]), [['major', 'src/cap.js', 2, true], ['minor', 'README.md', 99, false]], 'each finding, where it would go, to untick');

    // The minor one unticked: it goes nowhere.
    const minor = ctx.review!.items.find((i) => i.severity === 'minor')!.id;
    await h.engine.answer(taskId, 'post-review', 'post', { omit: [minor] });
    s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)));
    assert.equal(s.outcome, 'posted', JSON.stringify(h.engine.lastError(taskId)));
    assert.deepEqual(s.reviewPosted, { url: 'https://github.com/acme/api/pull/12#pullrequestreview-1', inline: 1 });
    const review = posted[0]!;
    assert.equal(review.commit_id, sha, 'on the commit that was reviewed');
    assert.equal(review.event, 'COMMENT', 'neither an approval nor a request for changes: yours to give');
    assert.deepEqual(review.comments, [{ path: 'src/cap.js', line: 2, side: 'RIGHT', body: '**Major:** bet() never checks CAP\n\n**Fix:** refuse x > CAP' }]);
    assert.equal(String(review.body), '## Review\n\n**reviewer** (changes requested): reviewer read it\n\n1 comment on the changed lines.\n', 'the one you unticked is not in it');
    assert.deepEqual(s.reviewOmit, [minor]);
    assert.equal((await view.detail(h.engine, taskId)).status.label, 'Review posted');
    assert.ok(!fs.existsSync(dir), "the worktree is gone once it is done");
    assert.equal(git(api, 'worktree', 'list').split('\n').length, 1);
  } finally {
    h.hooks.dispose();
  }
});

test('PR review: with the appsec reviewer on, the two review at once; finishing without posting posts nothing; a second run is a new task', async () => {
  const { ws, sha } = prWorkspace('repos:\n  api: {}\nagents:\n  appsec-reviewer: { enabled: true }\n');
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_PR_FINDINGS: FINDINGS });
  const posted: Record<string, unknown>[] = [];
  h.engine.cli = fakeGh(sha, posted);
  try {
    const { taskId } = await h.engine.start({ text: PR });
    let s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint && s.checkpoint.id, 'post-review', JSON.stringify(h.engine.lastError(taskId)));
    const stages = s.pipeline.stages;
    assert.deepEqual(stages.map((st) => st.agent), ['reviewer', 'appsec-reviewer']);
    assert.ok(stages[0]!.group !== undefined && stages[0]!.group === stages[1]!.group, 'one Parallel');
    assert.deepEqual(s.review.verdicts.map((v) => v.agent).sort(), ['appsec-reviewer', 'reviewer']);
    assert.match((await h.engine.checkpointContext(s, s.checkpoint)).text, /\*\*appsec-reviewer\*\* \(no blocking findings\): appsec-reviewer read it/);

    await h.engine.answer(taskId, 'post-review', 'skip');
    s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)));
    assert.equal(s.outcome, 'completed');
    assert.equal(posted.length, 0);
    assert.equal((await view.detail(h.engine, taskId)).status.label, 'Reviewed');

    const again = await h.engine.start({ text: PR });
    assert.equal(again.taskId, 'api-pr-12-2', 'the pull request may have moved: a new review');
  } finally {
    h.hooks.dispose();
  }
});

test('PR review: a line GitHub refuses keeps its comment out of the review, and the other lines still get theirs', async () => {
  const { ws, sha } = prWorkspace();
  const two = JSON.stringify([
    { severity: 'major', repo: 'api', file: 'src/cap.js', line: 2, problem: 'bet() never checks CAP' },
    { severity: 'minor', repo: 'api', file: 'src/cap.js', line: 1, problem: 'name the cap' },
  ]);
  const h = await harness(ws, { FAKE_REPOS: 'api', FAKE_PR_FINDINGS: two });
  const posted: Record<string, unknown>[] = [];
  const single: Record<string, unknown>[] = [];
  h.engine.cli = fakeGh(sha, posted, { refuseLine: 1, single });
  try {
    const { taskId } = await h.engine.start({ text: PR });
    await runTask(h.engine, taskId);
    await h.engine.answer(taskId, 'post-review', 'post');
    const s = await waitFor(async () => (h.engine.isRunning(taskId) ? null : await h.engine.svc.state(taskId)));
    assert.equal(s.outcome, 'posted', JSON.stringify(h.engine.lastError(taskId)));
    assert.equal((posted[0]!.comments as unknown[]).length, 2, 'first as one review, which GitHub refused');
    assert.deepEqual(single.map((c) => [c.path, c.line, c.side, c.commit_id]), [['src/cap.js', 2, 'RIGHT', sha], ['src/cap.js', 1, 'RIGHT', sha]], 'then each line on its own');
    assert.deepEqual(posted[1]!.comments, [], 'the review carries the summary');
    const body = String(posted[1]!.body);
    assert.match(body, /1 comment on the changed lines\./);
    assert.match(body, /### On lines that could not take a comment\n\n- `src\/cap\.js:1` \*\*Minor:\*\* name the cap/);
    assert.doesNotMatch(body, /never checks CAP/, 'the line that took its comment is not repeated');
    assert.deepEqual(s.reviewPosted, { url: 'https://github.com/acme/api/pull/12#pullrequestreview-1', inline: 1 });
  } finally {
    h.hooks.dispose();
  }
});

test('PR review: a pull request is not delivered, PR review takes nothing else, and its repo must be one of the workspace', async () => {
  const { ws, sha } = prWorkspace();
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  h.engine.cli = fakeGh(sha, []);
  try {
    const deliver = await previewOf(h.engine, { text: PR, scenario: 'deliver' });
    assert.match(deliver.problem!, /acme\/api#12 is a pull request to review: choose PR review/);
    await assert.rejects(h.engine.start({ text: PR, scenario: 'deliver' }), (e: { code?: string }) => e.code === 'pr_review');

    const words = await previewOf(h.engine, { text: 'Add a cap on bets', scenario: 'pr-review' });
    assert.match(words.problem!, /PR review takes a pull request/);

    const ref = await previewOf(h.engine, { text: '#12', scenario: 'pr-review' });
    assert.deepEqual(ref.source, { kind: 'pr', forge: 'github', host: 'github.com', project: 'acme/api', number: 12 }, '#12 of the one repo, as a pull request');
    assert.equal(ref.problem, undefined);

    const elsewhere = await previewOf(h.engine, { text: 'https://github.com/other/lib/pull/3' });
    assert.match(elsewhere.problem!, /no repo of this workspace has other\/lib on github\.com as its origin/);

    const mr = await previewOf(h.engine, { text: 'https://gitlab.com/acme/web/-/merge_requests/7/diffs' });
    assert.equal(mr.taskId, 'web-mr-7');
    assert.equal(mr.scenarioName, 'pr-review');
  } finally {
    h.hooks.dispose();
  }
});
