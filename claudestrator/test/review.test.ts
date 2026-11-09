// A pull request's review: which findings land on its lines, the links that name one, reading and posting it on GitLab
// and Bitbucket, and the task's states from the review to the post.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { changedLines, postPreview, reviewPost } from '../src/core/review';
import { postReview, prFetchRef, prRef, readPullRequest, type Run } from '../src/core/forge';
import { BitbucketClient } from '../src/core/bitbucket';
import { classifyInput, deriveTaskId, sourceRef } from '../src/core/intake';
import { replay, transition, nextAction } from '../src/core/machine';
import { outline } from '../src/core/pipeline';
import type { ExecResult } from '../src/core/git';
import type { EventOf, OrchEvent, PullRequestInfo, RecordedVerdict, Source, StoredPipeline } from '../src/core/types';

const DIFF = `################ api (acme/api#12: feat/cap → main, at abc)
diff --git a/src/cap.js b/src/cap.js
new file mode 100644
--- /dev/null
+++ b/src/cap.js
@@ -0,0 +1,3 @@
+const CAP = 100;
+function bet(x) { return x; }
+module.exports = { bet, CAP };
diff --git a/src/old.js b/src/old.js
--- a/src/old.js
+++ b/src/old.js
@@ -10,4 +10,4 @@ function a() {
 keep();
-gone();
+added();
 tail();
diff --git a/src/removed.js b/src/removed.js
deleted file mode 100644
--- a/src/removed.js
+++ /dev/null
@@ -1,1 +0,0 @@
-x
`;

const verdict = (agent: string, findings: RecordedVerdict['findings'], status: RecordedVerdict['status'] = 'changes_requested'): RecordedVerdict => ({ agent, artifact: `reviews/r1/${agent}.md`, status, findings });

test('review: the lines a pull request shows, on its new side', () => {
  const lines = changedLines(DIFF);
  assert.deepEqual([...lines.get('src/cap.js')!], [1, 2, 3]);
  assert.deepEqual([...lines.get('src/old.js')!], [10, 11, 12], 'a removed line takes no number on the new side');
  assert.equal(lines.has('src/removed.js'), false, 'a deleted file has no new lines');
});

test("review: a finding on a changed line is a comment there, the rest the summary's, the most severe first", () => {
  const post = reviewPost({
    verdicts: [
      verdict('reviewer', [
        { severity: 'minor', repo: 'api', file: 'api/README.md', line: 4, problem: 'no docs' },
        { severity: 'major', repo: 'api', file: 'src/cap.js', line: 2, problem: 'no cap check', fix: 'check it' },
        { severity: 'blocker', repo: 'api', file: '/ws/.orch/worktrees/T/api/src/old.js', line: 11, problem: 'added() throws' },
        { severity: 'minor', problem: 'a general remark' },
        { severity: 'minor', repo: 'api', file: 'src/old.js', line: 50, problem: 'off the diff' },
      ]),
      verdict('appsec-reviewer', [{ severity: 'major', repo: 'api', file: './src/cap.js', line: 2, problem: 'x is not validated\nat all' }]),
    ],
    summaries: [
      { agent: 'reviewer', status: 'changes_requested', summary: 'Two problems.\n\nCo-Authored-By: Claude <noreply@anthropic.com>' },
      { agent: 'appsec-reviewer', status: 'changes_requested', summary: 'One.' },
    ],
    diff: DIFF,
    repo: 'api',
    dir: '/ws/.orch/worktrees/T/api',
    forbidAttribution: true,
  });
  assert.deepEqual(
    post.inline.map((c) => [c.path, c.line]),
    [['src/old.js', 11], ['src/cap.js', 2]],
    'the blocker first; the checkout path and ./ left out'
  );
  assert.equal(post.inline[1]!.body, '**Major:** no cap check\n\n**Fix:** check it\n\n---\n\n**Major:** x is not validated\nat all', 'two on one line share its comment');
  const summary = post.summary([]);
  assert.match(summary, /^## Review\n\n\*\*reviewer\*\* \(changes requested\): Two problems\.\n\n\*\*appsec-reviewer\*\* \(changes requested\): One\.\n\n2 comments on the changed lines\./);
  assert.doesNotMatch(summary, /Co-Authored-By/i, 'no AI credit where the policy forbids it');
  assert.match(summary, /### Findings\n\n- \*\*Minor\*\* `README\.md:4` no docs\n- \*\*Minor\*\* a general remark\n- \*\*Minor\*\* `src\/old\.js:50` off the diff\n/);
  assert.match(post.summary([post.inline[0]!]), /1 comment on the changed lines\.[\s\S]*### On lines that could not take a comment\n\n- `src\/old\.js:11` \*\*Blocker:\*\* added\(\) throws/);
  assert.match(postPreview(post, 'https://github.com/acme/api/pull/12'), /^Posted to https:\/\/github\.com\/acme\/api\/pull\/12 as you choose, not before\.\n\n### On the changed lines\n\n\*\*`src\/old\.js:11`\*\*/);

  const clean = reviewPost({ verdicts: [verdict('reviewer', [], 'approved')], summaries: [{ agent: 'reviewer', status: 'approved', summary: 'Fine.' }], diff: DIFF, repo: 'api' });
  assert.deepEqual(clean.inline, []);
  assert.equal(clean.summary([]), '## Review\n\n**reviewer** (no blocking findings): Fine.\n');
});

test('review: links and references name pull requests on the three forges', () => {
  assert.deepEqual(classifyInput('https://github.com/acme/api/pull/12/files'), { kind: 'pr', forge: 'github', host: 'github.com', project: 'acme/api', number: 12 });
  assert.deepEqual(classifyInput('https://gitlab.acme.com/group/sub/web/-/merge_requests/7'), { kind: 'pr', forge: 'gitlab', host: 'gitlab.acme.com', project: 'group/sub/web', number: 7 });
  assert.deepEqual(classifyInput('https://bitbucket.org/acme/shop/pull-requests/3/diff'), { kind: 'pr', forge: 'bitbucket', host: 'bitbucket.org', project: 'acme/shop', number: 3 });
  assert.equal(classifyInput('https://gitea.acme.com/acme/api/pull/3').kind, 'text', 'a host that is not GitHub');
  const gh: Source = { kind: 'pr', forge: 'github', host: 'github.com', project: 'acme/api', number: 12 };
  const gl: Source = { kind: 'pr', forge: 'gitlab', host: 'gitlab.com', project: 'group/web', number: 7 };
  const bb: Source = { kind: 'pr', forge: 'bitbucket', host: 'bitbucket.org', project: 'acme/shop', number: 3 };
  assert.deepEqual([deriveTaskId(gh, new Date()), deriveTaskId(gl, new Date()), deriveTaskId(bb, new Date())], ['api-pr-12', 'web-mr-7', 'shop-pr-3']);
  assert.deepEqual([sourceRef(gh), sourceRef(gl), prRef(bb)], ['acme/api#12', 'group/web!7', 'acme/shop#3']);
  assert.deepEqual([prFetchRef(gh, { head: 'f' }), prFetchRef(gl, { head: 'f' }), prFetchRef(bb, { head: 'feat/x' })], ['pull/12/head', 'merge-requests/7/head', 'refs/heads/feat/x']);
});

const ok = (stdout: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(stdout), stderr: '' });
const GL: Extract<Source, { kind: 'pr' }> = { kind: 'pr', forge: 'gitlab', host: 'gitlab.com', project: 'group/web', number: 7 };
const GL_PR: PullRequestInfo = { url: 'https://gitlab.com/group/web/-/merge_requests/7', repo: 'web', base: 'main', head: 'feat/dark', headSha: 'h', baseSha: 'b', startSha: 's' };

test('review: a GitLab merge request is read with its diff refs, and its review posted line by line, then the summary', async () => {
  const sent: { endpoint: string; body: Record<string, unknown> }[] = [];
  const run: Run = async (cmd, args) => {
    const endpoint = args[args.length - 1]!;
    if (args.includes('--input')) {
      const body = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1]!, 'utf8')) as Record<string, unknown>;
      sent.push({ endpoint, body });
      // The second line comment is refused (its line moved): it goes into the summary.
      if (endpoint.endsWith('/discussions') && sent.filter((x) => x.endpoint.endsWith('/discussions')).length === 2) return { code: 1, stdout: '', stderr: '400 Bad request - line_code can not be blank' };
      return ok({ id: 77 });
    }
    if (endpoint.endsWith('/notes?sort=asc&order_by=created_at&per_page=100')) return ok([{ body: 'merged main', system: true }, { body: 'looks risky', author: { username: 'bob' }, created_at: '2026-11-01' }]);
    return ok({ title: 'Dark mode', description: 'Adds it', web_url: GL_PR.url, target_branch: 'main', source_branch: 'feat/dark', sha: 'h', diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } });
  };
  const pr = await readPullRequest(GL, run, null);
  assert.deepEqual({ ...pr, comments: pr.comments.length }, { title: 'Dark mode', url: GL_PR.url, body: 'Adds it', labels: [], comments: 1, base: 'main', head: 'feat/dark', headSha: 'h', baseSha: 'b', startSha: 's' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-review-'));
  const post = { inline: [{ path: 'src/a.ts', line: 3, body: 'one' }, { path: 'src/b.ts', line: 9, body: 'two' }], summary: (missed: { path: string }[]) => `summary; missed ${missed.map((m) => m.path).join(',') || 'none'}` };
  const posted = await postReview({ src: GL, pr: GL_PR, post, run, bitbucket: null, tmp });
  assert.deepEqual(posted, { url: `${GL_PR.url}#note_77`, inline: 1 });
  assert.deepEqual(sent[0]!.body, { body: 'one', position: { position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h', new_path: 'src/a.ts', old_path: 'src/a.ts', new_line: 3 } });
  assert.equal(sent[2]!.endpoint, 'projects/group%2Fweb/merge_requests/7/notes');
  assert.deepEqual(sent[2]!.body, { body: 'summary; missed src/b.ts' }, 'the summary comes last, with what a line refused');
});

test('review: a Bitbucket pull request is read and reviewed over its API; without a token it says where to add one', async () => {
  const BB: Extract<Source, { kind: 'pr' }> = { kind: 'pr', forge: 'bitbucket', host: 'bitbucket.org', project: 'acme/shop', number: 3 };
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/pullrequests/3')) return new Response(JSON.stringify({ title: 'Promo codes', description: 'Adds them', links: { html: { href: 'https://bitbucket.org/acme/shop/pull-requests/3' } }, source: { branch: { name: 'feat/promo' }, commit: { hash: 'abc123def456' } }, destination: { branch: { name: 'main' } } }), { status: 200 });
    if (url.includes('/comments?pagelen')) return new Response(JSON.stringify({ values: [{ content: { raw: 'gone' }, deleted: true }, { content: { raw: 'ship it' }, user: { display_name: 'Ann' }, created_on: '2026-11-02' }] }), { status: 200 });
    const body = init.body ? (JSON.parse(String(init.body)) as { inline?: { to: number } }) : {};
    if (body.inline && body.inline.to === 9) return new Response(JSON.stringify({ error: { message: 'line not in the diff' } }), { status: 400 });
    return new Response(JSON.stringify({ id: 5, links: { html: { href: 'https://bitbucket.org/acme/shop/pull-requests/3/_/diff#comment-5' } } }), { status: 201 });
  }) as unknown as typeof globalThis.fetch;
  const client = new BitbucketClient({ email: 'dev@acme.com', token: 'tok-123456789' }, { fetch, sleep: async () => {} });
  const pr = await readPullRequest(BB, async () => ({ code: 1, stdout: '', stderr: '' }), client);
  assert.deepEqual({ ...pr, comments: pr.comments.map((c) => c.body) }, { title: 'Promo codes', url: 'https://bitbucket.org/acme/shop/pull-requests/3', body: 'Adds them', labels: [], comments: ['ship it'], base: 'main', head: 'feat/promo', headSha: 'abc123def456' });

  const post = { inline: [{ path: 'src/a.ts', line: 3, body: 'one' }, { path: 'src/b.ts', line: 9, body: 'two' }], summary: (missed: { path: string }[]) => `missed ${missed.map((m) => m.path).join(',')}` };
  const posted = await postReview({ src: BB, pr: { url: pr.url, repo: 'shop', base: 'main', head: 'feat/promo', headSha: pr.headSha }, post, run: async () => ({ code: 1, stdout: '', stderr: '' }), bitbucket: client, tmp: os.tmpdir() });
  assert.deepEqual(posted, { url: 'https://bitbucket.org/acme/shop/pull-requests/3/_/diff#comment-5', inline: 1 });
  const comments = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(comments[0]!.body, { content: { raw: 'one' }, inline: { path: 'src/a.ts', to: 3 } });
  assert.deepEqual(comments[2]!.body, { content: { raw: 'missed src/b.ts' } });

  await assert.rejects(readPullRequest(BB, async () => ({ code: 1, stdout: '', stderr: '' }), null), /save one in Integrations → Bitbucket/);
});

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const STAGES: StoredPipeline = { mode: 'review_only', scenario: 'deliver', stages: [{ agent: 'reviewer', output: 'verdict', scope: 'task', approval: false }], reviewLoop: null, warnings: [] };
const PR_SOURCE: Source = { kind: 'pr', forge: 'github', host: 'github.com', project: 'acme/api', number: 12 };

function reviewed(source: Source = PR_SOURCE): OrchEvent[] {
  const pr = source.kind === 'pr' ? { pr: { url: 'u', repo: 'api', base: 'main', head: 'f', headSha: 'h' } } : {};
  return [
    { type: 'task_created', taskId: 'api-pr-12', input: 'u', source, scenario: 'deliver', scenarioName: 'pr-review', scenarioLabel: 'PR review', auto: false, pipeline: STAGES, limits: { reviewRounds: 2, gateAttempts: 3 }, knownRepos: ['api'], at: at(0) },
    { type: 'intake_completed', spec: { id: 'api-pr-12', source, title: 't', description: '', acceptanceCriteria: [], links: [], ...pr }, repos: [{ name: 'api', mode: 'full', baseBranch: 'main' }], at: at(1) },
    { type: 'stage_started', agent: 'reviewer', at: at(2) },
    { type: 'stage_completed', agent: 'reviewer', artifact: 'reviews/r1/reviewer.md', verdict: { status: 'approved', summary: 'ok', findings: [] }, at: at(3) },
  ] as OrchEvent[];
}

test('machine: a pull request reviewed waits for you to post it; posting is recorded, skipping finishes', () => {
  const s = replay(reviewed());
  assert.equal(s.checkpoint && s.checkpoint.id, 'post-review');
  assert.deepEqual(s.checkpoint!.options, ['post', 'skip']);
  assert.equal(s.phase, 'finish');
  const early = transition(s, { type: 'review_posted', url: 'x', inline: 0, at: at(4) } as EventOf<'review_posted'>);
  assert.ok(!early.ok, 'not before you say so');

  const answered = replay([...reviewed(), { type: 'checkpoint_answered', id: 'post-review', option: 'post', at: at(4) } as OrchEvent]);
  assert.deepEqual(nextAction(answered), { kind: 'post-review' });
  const posted = replay([...reviewed(), { type: 'checkpoint_answered', id: 'post-review', option: 'post', at: at(4) }, { type: 'review_posted', url: 'https://x/pull/12#r', inline: 2, at: at(5) }] as OrchEvent[]);
  assert.equal(posted.status, 'done');
  assert.equal(posted.outcome, 'posted');
  assert.deepEqual(posted.reviewPosted, { url: 'https://x/pull/12#r', inline: 2 });

  const skipped = replay([...reviewed(), { type: 'checkpoint_answered', id: 'post-review', option: 'skip', at: at(4) } as OrchEvent]);
  assert.equal(skipped.outcome, 'completed');

  // A review-only task of another source (a log of before, or words) finishes as it always did.
  const words = replay(reviewed({ kind: 'text', text: 'review it' }));
  assert.equal(words.status, 'done');
  assert.equal(words.checkpoint, null);
});

test('pipeline: a pull request review ends with your decision and the review posted to it', () => {
  assert.deepEqual(outline(STAGES, { pr: true }).map((o) => o.text), ['reviewer', 'you decide', 'review posted to the PR']);
  assert.deepEqual(outline(STAGES).map((o) => o.text), ['reviewer']);
});
