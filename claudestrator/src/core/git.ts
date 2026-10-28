// Git for the orchestrator: async everywhere (gates and fetches take seconds, the extension host must stay
// responsive), with every read degrading to a safe answer when git fails.
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawnSync } from 'child_process';
import { ORCH_DIR } from './store';
import { branchName } from './machine';
import type { Config, TaskState } from './types';
import type { BlockedRepo as Blocked } from './wire';

/** The environment child processes get. Set once by the extension (login-shell PATH etc.). */
let childEnv: NodeJS.ProcessEnv = { ...process.env };
function setChildEnv(env: NodeJS.ProcessEnv): void {
  childEnv = env;
}
const getChildEnv = (): NodeJS.ProcessEnv => childEnv;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecOptions {
  cwd?: string | undefined;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv | undefined;
  input?: string | undefined;
}

/** Never rejects: `{ code, stdout, stderr }`, code 127 when the binary is missing, 124 on timeout. */
function exec(cmd: string, args: readonly string[], { cwd, timeoutMs = 60000, env, input }: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: env || childEnv }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = err.code === 'ENOENT' ? 127 : err.killed ? 124 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: String(stdout ?? ''), stderr: `${stderr ?? ''}${err && err.code === 'ENOENT' ? `${cmd}: not found` : ''}${err && err.killed ? `\nkilled after ${Math.round(timeoutMs / 1000)}s` : ''}` });
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

// Machine state and config of the orchestrator never count as the user's changes.
const OWN = [`${ORCH_DIR}/`, '.claudestrator/'];
const isOwn = (file: string): boolean => OWN.some((p) => file === p.slice(0, -1) || file.startsWith(p));
const EXCLUDE = OWN.map((p) => `:(exclude)${p.slice(0, -1)}`);

class GitRepo {
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  git(...args: string[]): Promise<ExecResult> {
    return exec('git', ['-C', this.dir, ...args], { cwd: fs.existsSync(this.dir) ? this.dir : undefined, timeoutMs: 120000 });
  }

  async isRepo(): Promise<boolean> {
    if (!fs.existsSync(this.dir)) return false;
    return (await this.git('rev-parse', '--is-inside-work-tree')).stdout.trim() === 'true';
  }

  async branch(): Promise<string | null> {
    const r = await this.git('rev-parse', '--abbrev-ref', 'HEAD');
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** `git status --porcelain` lines: uncommitted and untracked work. */
  async dirty(): Promise<string[]> {
    const r = await this.git('status', '--porcelain');
    return r.stdout.split('\n').filter(Boolean).filter((l) => !isOwn(l.slice(3).replace(/^"|"$/g, '')));
  }

  async hasBranch(name: string): Promise<boolean> {
    return (await this.git('rev-parse', '--verify', '--quiet', `refs/heads/${name}`)).code === 0;
  }

  /** Where the task's changes start: merge-base with origin/<base>, else with <base>, else HEAD. */
  async baseRef(base: string): Promise<string> {
    for (const ref of [`origin/${base}`, base]) {
      const r = await this.git('merge-base', 'HEAD', ref);
      if (r.code === 0) return r.stdout.trim();
    }
    return 'HEAD';
  }

  async untracked(): Promise<string[]> {
    return (await this.git('ls-files', '--others', '--exclude-standard')).stdout.split('\n').filter(Boolean).filter((f) => !isOwn(f));
  }

  /** Files changed since the base, committed or not, plus untracked ones. */
  async changedFiles(base: string): Promise<string[]> {
    const tracked = (await this.git('diff', '--name-only', await this.baseRef(base))).stdout.split('\n').filter(Boolean).filter((f) => !isOwn(f));
    return [...new Set([...tracked, ...(await this.untracked())])].sort();
  }

  /** Stat and full diff against the base, untracked files included as additions. */
  async diff(base: string): Promise<string> {
    const ref = await this.baseRef(base);
    const parts = [(await this.git('--no-pager', 'diff', '--stat', ref, '--', '.', ...EXCLUDE)).stdout, (await this.git('--no-pager', 'diff', ref, '--', '.', ...EXCLUDE)).stdout];
    for (const f of await this.untracked()) parts.push((await this.git('--no-pager', 'diff', '--no-index', '--', '/dev/null', f)).stdout);
    return parts.filter((p) => p.trim()).join('\n');
  }

  /** Stages everything except the orchestrator's own folders. */
  addAll(): Promise<ExecResult> {
    return this.git('add', '-A', '--', '.', ...EXCLUDE);
  }

  async aheadBehind(base: string): Promise<{ ahead: number | undefined; behind: number | undefined } | null> {
    const r = await this.git('rev-list', '--left-right', '--count', `origin/${base}...HEAD`);
    if (r.code !== 0) return null;
    const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }

  async lastCommit(): Promise<{ hash: string | undefined; subject: string | undefined; when: string | undefined } | null> {
    const r = await this.git('log', '-1', '--format=%h%x09%s%x09%cr');
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const [hash, subject, when] = r.stdout.trim().split('\t');
    return { hash, subject, when };
  }
}

/** Synchronous branch lookup for the Bash guard, which decides inside a hook round-trip. */
function branchSync(dir: string): string | null {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000, env: childEnv });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

const worktreeDir = (workspace: string, taskId: string, repo: string): string => path.join(workspace, ORCH_DIR, 'worktrees', taskId, repo);

/** Where each repo of a task lives. Repos missing from the config sit at `<workspace>/<name>` on the default base. */
/** A repo of a task: where its checkout is, where the task works, and the base branch. */
interface TaskRepo {
  name: string;
  checkout: string;
  dir: string;
  base: string;
  git: GitRepo;
}

type RepoLookup = Pick<Config, 'repos' | 'baseBranch'>;

function taskRepos(workspace: string, state: TaskState, config: RepoLookup | null | undefined, names: string[]): TaskRepo[] {
  return names.map((name) => {
    const r = config && config.repos[name];
    const checkout = path.resolve(workspace, (r && r.path) || name);
    const dir = state.gitMode === 'worktree' ? worktreeDir(workspace, state.taskId, name) : checkout;
    return { name, checkout, dir, base: (r && r.baseBranch) || (config && config.baseBranch) || 'main', git: new GitRepo(dir) };
  });
}

/**
 * Puts every plan repo on the task branch. All-or-nothing: if any repo is not ready, nothing changes.
 * Branch mode switches the user's checkout (which must be clean); worktree mode adds a worktree per repo
 * and never touches the checkout. Idempotent.
 */
interface PrepareResult {
  repo: string;
  dir: string;
  status: string;
  from?: string;
  note?: string;
  error?: string;
}
type Prepared =
  | { ok: true; branch: string; repos: PrepareResult[] }
  | { ok: false; code: string; error: string; branch?: string; blocked?: Blocked[] };

async function prepareRepos(workspace: string, state: TaskState, config: RepoLookup | null | undefined): Promise<Prepared> {
  const branch = branchName(state);
  if (!branch) return { ok: false, code: 'no_plan', error: 'no plan yet, so no branch name; prepare repos after the plan is approved' };
  const repos = taskRepos(workspace, state, config, state.repos.map((r) => r.name));
  const worktree = state.gitMode === 'worktree';

  const blocked: Blocked[] = [];
  for (const { name, checkout, dir, git } of repos) {
    const main = new GitRepo(checkout);
    if (!(await main.isRepo())) {
      blocked.push({ repo: name, dir: checkout, problem: 'not a git repository' });
      continue;
    }
    if (worktree) continue;
    if ((await git.branch()) === branch) continue;
    const dirty = await git.dirty();
    if (dirty.length) blocked.push({ repo: name, dir, problem: 'uncommitted changes', files: dirty.slice(0, 20) });
  }
  if (blocked.length) return { ok: false, code: 'repos_not_ready', error: 'some repos are not ready; nothing was changed', branch, blocked };

  const results: PrepareResult[] = [];
  for (const { name, checkout, dir, base, git } of repos) {
    if (fs.existsSync(dir) && (await git.isRepo()) && (await git.branch()) === branch) {
      results.push({ repo: name, dir, status: 'ready' });
      continue;
    }
    const main = new GitRepo(checkout);
    const fetched = (await main.git('fetch', 'origin', base)).code === 0;
    const from = fetched || (await main.git('rev-parse', '--verify', '--quiet', `origin/${base}`)).code === 0 ? `origin/${base}` : base;
    const note = fetched ? {} : { note: 'fetch failed; branched from the local ref' };
    let r: ExecResult;
    if (worktree) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      r = (await main.hasBranch(branch)) ? await main.git('worktree', 'add', dir, branch) : await main.git('worktree', 'add', '-b', branch, dir, from);
    } else if (await main.hasBranch(branch)) {
      r = await main.git('switch', branch);
      if (r.code === 0) {
        results.push({ repo: name, dir, status: 'switched' });
        continue;
      }
    } else r = await main.git('switch', '-c', branch, from);
    results.push(r.code === 0 ? { repo: name, dir, status: 'created', from, ...note } : { repo: name, dir, status: 'failed', error: r.stderr.trim() });
  }
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) return { ok: false, code: 'switch_failed', error: failed.map((f) => `${f.repo}: ${f.error}`).join('\n'), branch };
  return { ok: true, branch, repos: results };
}

/**
 * The combined diff of a task's repos against their bases, untracked files included: what a reviewer reads.
 * `empty` is true when no repo has a changed file: there is nothing to review.
 */
async function taskDiff(repos: TaskRepo[]): Promise<{ text: string; empty: boolean; repos: { repo: string; files: number; branch: string | null }[] }> {
  const parts: string[] = [];
  const stats: { repo: string; files: number; branch: string | null }[] = [];
  for (const { name, git, base } of repos) {
    if (!(await git.isRepo())) {
      parts.push(`################ ${name}: not a git repository`);
      continue;
    }
    const branch = await git.branch();
    stats.push({ repo: name, files: (await git.changedFiles(base)).length, branch });
    parts.push(`################ ${name} (${branch} vs ${base})\n${await git.diff(base)}`);
  }
  return { text: `${parts.join('\n\n')}\n`, empty: stats.length > 0 && stats.every((r) => r.files === 0), repos: stats };
}

/** Removes a finished task's worktrees. Refuses a worktree with uncommitted work unless `force`. */
async function removeWorktrees(workspace: string, state: TaskState, config: RepoLookup | null | undefined, force = false): Promise<{ repo: string; status: string; error?: string }[]> {
  if (state.gitMode !== 'worktree') return [];
  const out: { repo: string; status: string; error?: string }[] = [];
  for (const { name, checkout, dir } of taskRepos(workspace, state, config, state.repos.map((r) => r.name))) {
    if (!fs.existsSync(dir)) {
      out.push({ repo: name, status: 'absent' });
      continue;
    }
    const r = await new GitRepo(checkout).git('worktree', 'remove', ...(force ? ['--force'] : []), dir);
    out.push(r.code === 0 ? { repo: name, status: 'removed' } : { repo: name, status: 'kept', error: r.stderr.trim() });
  }
  return out;
}

export type { ExecResult, ExecOptions, TaskRepo, Prepared, PrepareResult };
export { exec, setChildEnv, getChildEnv, GitRepo, branchSync, worktreeDir, taskRepos, prepareRepos, taskDiff, removeWorktrees, isOwn };
