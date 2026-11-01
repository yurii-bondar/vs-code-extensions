// The git the engine does itself: branches and worktrees for a task, the diff a reviewer reads, cleaning up.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { exec, GitRepo, prepareRepos, removeWorktrees, taskDiff, taskRepos } from '../src/core/git';
import { runGates } from '../src/core/gates';
import { git, workspace } from './helpers/e2e';
import type { Config, RepoConfig, TaskState } from '../src/core/types';

const config = { repos: {}, baseBranch: 'main' } as unknown as Pick<Config, 'repos' | 'baseBranch'>;

/** A task whose plan names these repos, in this git mode. */
const task = (repos: string[], gitMode: 'branch' | 'worktree'): TaskState =>
  ({ taskId: 'T-1', source: { kind: 'text', text: 'x' }, gitMode, plan: { type: 'feat', slug: 'cap-bets', title: 'Cap bets', repos: [] }, repos: repos.map((name) => ({ name, mode: 'full' })) }) as unknown as TaskState;

test('git: branch mode branches clean checkouts, and refuses to touch one with uncommitted work', async () => {
  const ws = workspace(['api', 'web'], '');
  fs.writeFileSync(path.join(ws, 'web', 'wip.txt'), 'mine');
  const blocked = await prepareRepos(ws, task(['api', 'web'], 'branch'), config);
  assert.ok(!blocked.ok && blocked.code === 'repos_not_ready');
  assert.deepEqual(blocked.blocked!.map((b) => [b.repo, b.problem]), [['web', 'uncommitted changes']]);
  assert.equal(git(path.join(ws, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'nothing was changed, not even the clean one');

  fs.rmSync(path.join(ws, 'web', 'wip.txt'));
  const ok = await prepareRepos(ws, task(['api', 'web'], 'branch'), config);
  assert.ok(ok.ok, JSON.stringify(ok));
  for (const repo of ['api', 'web']) assert.equal(git(path.join(ws, repo), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/cap-bets');
  const again = await prepareRepos(ws, task(['api'], 'branch'), config);
  assert.ok(again.ok && again.repos.every((r) => r.status === 'ready'), 'a second time finds it ready');
});

test("git: worktree mode leaves your checkouts alone, the diff covers new files but not Claudestrator's, and cleanup keeps unsaved work", async () => {
  const ws = workspace(['api'], '');
  fs.writeFileSync(path.join(ws, 'api', 'wip.txt'), 'mine: worktrees do not mind');
  const s = task(['api'], 'worktree');
  const p = await prepareRepos(ws, s, config);
  assert.ok(p.ok, JSON.stringify(p));
  const [repo] = taskRepos(ws, s, config, ['api']);
  assert.equal(repo!.dir, path.join(ws, '.orch', 'worktrees', 'T-1', 'api'));
  assert.equal(git(repo!.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/cap-bets');
  assert.equal(git(path.join(ws, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'your checkout stays on its branch');

  let diff = await taskDiff([repo!]);
  assert.ok(diff.empty, 'nothing changed yet');
  fs.writeFileSync(path.join(repo!.dir, 'README.md'), '# api\n\nCaps bets.\n');
  fs.writeFileSync(path.join(repo!.dir, 'cap.ts'), 'export const CAP = 100;\n');
  fs.mkdirSync(path.join(repo!.dir, '.claudestrator'));
  fs.writeFileSync(path.join(repo!.dir, '.claudestrator', 'config.yaml'), 'language: German\n');
  diff = await taskDiff([repo!]);
  assert.equal(diff.empty, false);
  assert.match(diff.text, /\+Caps bets\./);
  assert.match(diff.text, /\+export const CAP = 100;/, 'a new file is in the diff');
  assert.doesNotMatch(diff.text, /language: German/, "Claudestrator's own folder is not the user's change");

  const kept = await removeWorktrees(ws, s, config);
  assert.equal(kept[0]!.status, 'kept', 'a worktree with work not committed stays');
  assert.ok(fs.existsSync(repo!.dir));
  const forced = await removeWorktrees(ws, s, config, true);
  assert.equal(forced[0]!.status, 'removed');
  assert.ok(!fs.existsSync(repo!.dir));
  assert.deepEqual((await removeWorktrees(ws, s, config)).map((r) => r.status), ['absent']);
});

test("git: Claudestrator's own git runs no hook, also not one husky keeps in the working tree", async () => {
  for (const mode of ['branch', 'worktree'] as const) {
    const ws = workspace(['api'], '');
    const api = path.join(ws, 'api');
    // husky: core.hooksPath points into the working tree, where agents and checks write, and `.husky/_` is git-ignored.
    const marker = path.join(ws, 'hook-ran');
    fs.mkdirSync(path.join(api, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(api, '.husky', '_', '.gitignore'), '*\n');
    fs.writeFileSync(path.join(api, '.husky', '_', 'post-checkout'), `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
    git(api, 'config', 'core.hooksPath', '.husky/_');
    assert.equal(await new GitRepo(api).hooksDir(), path.join(api, '.husky', '_'), 'where git runs them from, absolute');

    const p = await prepareRepos(ws, task(['api'], mode), config);
    assert.ok(p.ok, JSON.stringify(p));
    assert.equal(fs.existsSync(marker), false, `${mode}: switching the branch ran no post-checkout`);
    git(api, 'switch', '-q', mode === 'branch' ? 'main' : '-c', ...(mode === 'branch' ? [] : ['other']));
    assert.equal(fs.existsSync(marker), true, 'git run by you still runs it');
  }
});

test('git: a file named outside ASCII is a change like any other, for the checks and in the review diff', async () => {
  const ws = workspace(['api'], '');
  const api = path.join(ws, 'api');
  fs.mkdirSync(path.join(api, 'src'));
  fs.writeFileSync(path.join(api, 'src', 'компонент.tsx'), 'export const a = 1;\n');
  const repo = new GitRepo(api);
  assert.deepEqual(await repo.changedFiles('main'), ['src/компонент.tsx'], 'not "src/\\320\\272…"');
  assert.deepEqual(await repo.dirty(), ['?? src/']);
  const gates = await runGates({ repo: { name: 'api', baseBranch: 'main', gates: [{ name: 'lint', cmd: 'true', when: 'src/' }] } as unknown as RepoConfig, dir: api, logDir: path.join(ws, 'logs') });
  assert.equal(gates.status, 'pass', 'a check for src/ runs');
  const diff = await taskDiff(taskRepos(ws, task(['api'], 'branch'), config, ['api']));
  assert.match(diff.text, /\+export const a = 1;/, 'the new file is in the diff');
  git(api, 'add', '.');
  git(api, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add');
  git(api, 'mv', 'src/компонент.tsx', 'src/віджет.tsx');
  assert.deepEqual(await repo.dirty(), ['R  src/віджет.tsx'], 'a rename is one entry');
});

test("git: the review diff takes in many new files at once and leaves the checkout's index as it was", async () => {
  const ws = workspace(['api'], '');
  const api = path.join(ws, 'api');
  fs.mkdirSync(path.join(api, 'gen'));
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(api, 'gen', `f${i}.txt`), `line ${i}\n`);
  fs.appendFileSync(path.join(api, 'README.md'), 'more\n');
  const started = Date.now();
  const diff = await taskDiff(taskRepos(ws, task(['api'], 'branch'), config, ['api']));
  const ms = Date.now() - started;
  assert.equal((diff.text.match(/^new file mode/gm) || []).length, 300, 'every new file, as a new file');
  assert.match(diff.text, /\+line 299/);
  assert.match(diff.text, /\+more/);
  assert.ok(ms < 5000, `${ms} ms: not a process per file`);
  assert.equal(git(api, 'status', '--porcelain', '--', 'gen').split('\n').filter(Boolean).length, 1, 'still untracked: ?? gen/');
  assert.equal(git(api, 'diff', '--cached', '--name-only'), '', 'nothing staged in your index');
});

test('git: when one repo cannot be put on the task branch, the ones before it are put back', async () => {
  for (const mode of ['branch', 'worktree'] as const) {
    const ws = workspace(['api', 'web'], '');
    // web's base does not exist, so its branch cannot be made from it.
    const cfg = { repos: { api: { name: 'api', path: 'api', baseBranch: 'main' }, web: { name: 'web', path: 'web', baseBranch: 'develop' } }, baseBranch: 'main' } as unknown as Pick<Config, 'repos' | 'baseBranch'>;
    const p = await prepareRepos(ws, task(['api', 'web'], mode), cfg);
    assert.ok(!p.ok && p.code === 'switch_failed' && /web:/.test(p.error), JSON.stringify(p));
    const api = path.join(ws, 'api');
    assert.equal(git(api, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', `${mode}: api is where it was`);
    assert.equal(git(api, 'branch', '--list', 'feat/cap-bets'), '', `${mode}: the branch it got is gone`);
    assert.equal(fs.existsSync(path.join(ws, '.orch', 'worktrees', 'T-1', 'api')), false, `${mode}: no worktree left`);
    assert.doesNotMatch(git(api, 'worktree', 'list'), /worktrees/, `${mode}: none registered either`);
  }
});

test('git: a worktree an earlier task with the same id kept is never removed to make room', async () => {
  const ws = workspace(['api'], '');
  const first = task(['api'], 'worktree');
  assert.ok((await prepareRepos(ws, first, config)).ok);
  const [repo] = taskRepos(ws, first, config, ['api']);
  // Deleting that task kept its worktree for the work it had not committed.
  fs.writeFileSync(path.join(repo!.dir, 'precious.txt'), 'unsaved work');
  assert.equal((await removeWorktrees(ws, first, config))[0]!.status, 'kept');

  // The same Jira key again: the same folder, another branch.
  const again = { ...first, plan: { ...first.plan!, slug: 'cap-bets-again' } } as TaskState;
  const p = await prepareRepos(ws, again, config);
  assert.ok(!p.ok && p.code === 'repos_not_ready', JSON.stringify(p));
  assert.match(p.blocked![0]!.problem, /is there already/);
  assert.equal(fs.readFileSync(path.join(repo!.dir, 'precious.txt'), 'utf8'), 'unsaved work', 'the work is still there');
  assert.equal(git(repo!.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/cap-bets', 'and on its own branch');
  assert.ok((await prepareRepos(ws, first, config)).ok, 'the task it belongs to finds it ready');
});

test("git: a submodule at another commit than the branch says is the checkout's, never the task's change", async () => {
  const ws = workspace(['api', 'lib'], '');
  const api = path.join(ws, 'api');
  const lib = path.join(ws, 'lib');
  const x = git(lib, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(lib, 'v2.txt'), 'two\n');
  git(lib, 'add', '.');
  git(lib, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v2');
  const y = git(lib, 'rev-parse', 'HEAD');
  git(api, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
  git(api, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add lib at v2');
  // Your submodule checkout is still at the older commit: the branch says y, the folder holds x.
  git(path.join(api, 'vendor', 'lib'), 'checkout', '-q', x);
  const repo = new GitRepo(api);
  assert.deepEqual(await repo.dirty(), [], 'not uncommitted work of the task');
  assert.deepEqual(await repo.changedFiles('main'), []);

  fs.writeFileSync(path.join(api, 'feature.txt'), 'new\n');
  assert.equal((await repo.addAll()).code, 0);
  assert.deepEqual(git(api, 'diff', '--cached', '--name-only').split('\n'), ['feature.txt'], 'the agent\'s file, not the submodule');
  assert.equal(git(api, 'ls-files', '-s', 'vendor/lib').split(' ')[1], y, 'the branch keeps the commit it had');
  assert.doesNotMatch((await taskDiff(taskRepos(ws, task(['api'], 'branch'), config, ['api']))).text, /Subproject commit/);
});

test('git: the diff shows a file as it is, whatever .gitattributes says of it', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const dir = path.join(ws, 'api');
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'config.js -diff\nkeys.txt binary\n');
  fs.writeFileSync(path.join(dir, 'config.js'), 'module.exports = { token: "ghp_planted" };\n');
  fs.writeFileSync(path.join(dir, 'keys.txt'), 'AKIA-planted\n');
  const diff = await new GitRepo(dir).diff('main');
  assert.match(diff, /\+module\.exports = \{ token: "ghp_planted" \};/);
  assert.match(diff, /\+AKIA-planted/);
  assert.doesNotMatch(diff, /Binary files/);
});

test('git: a checkout lists its dotenv files, also git-ignored ones and those in ignored folders, not the templates', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const dir = path.join(ws, 'api');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nsecrets/\n');
  for (const f of ['.env', '.env.example', '.envrc', 'secrets/.env', 'web/.env.production', 'web/.env.sample', 'src/environment.ts']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'X=1\n');
  }
  assert.deepEqual((await new GitRepo(dir).envFiles()).map((f) => path.relative(dir, f)).sort(), ['.env', '.envrc', 'secrets/.env', 'web/.env.production'].map((f) => path.join(...f.split('/'))).sort());
});

test('git: a command a Stop aborts ends at once with code 130', { skip: process.platform === 'win32' }, async () => {
  const abort = new AbortController();
  const started = Date.now();
  const run = exec('sleep', ['10'], { signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  const r = await run;
  assert.equal(r.code, 130);
  assert.ok(Date.now() - started < 5000);
  assert.equal((await exec('sleep', ['10'], { signal: abort.signal })).code, 130, 'not started once stopped');
});
