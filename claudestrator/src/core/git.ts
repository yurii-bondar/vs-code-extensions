// Git for the orchestrator: async everywhere (gates and fetches take seconds, the extension host must stay
// responsive), with every read degrading to a safe answer when git fails.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { exists } from './files';
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

/**
 * What an npm shim on Windows (`claude.cmd`) really runs. Node refuses to spawn a `.cmd` without a shell, and a shell
 * would mangle arguments such as a multi-line system prompt, so the probe reads the shim and child processes start
 * its target directly.
 */
const shims = new Map<string, { file: string; args: string[] }>();
function setShim(command: string, target: { file: string; args: string[] }): void {
  shims.set(command, target);
}

/** The file to spawn and its arguments: a shim's target, else the command as it is. */
function launch(command: string, args: readonly string[]): [string, string[]] {
  const shim = shims.get(command);
  return shim ? [shim.file, [...shim.args, ...args]] : [command, [...args]];
}

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
  /** The most of its output read; MAX_OUTPUT unless a caller needs less. */
  maxBytes?: number | undefined;
}

/** The most a command's output is read into memory; more is cut, and the result says so (code 125). */
const MAX_OUTPUT = 64 * 1024 * 1024;

/** Never rejects: `{ code, stdout, stderr }`, code 127 when the binary is missing, 124 on timeout, 125 when cut. */
function exec(cmd: string, args: readonly string[], { cwd, timeoutMs = 60000, env, input, maxBytes = MAX_OUTPUT }: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const [file, argv] = launch(cmd, args);
    const child = execFile(file, argv, { cwd, timeout: timeoutMs, maxBuffer: maxBytes, env: env || childEnv }, (err, stdout, stderr) => {
      let code = 0;
      const overflow = Boolean(err && (err.code as unknown) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      if (err) code = err.code === 'ENOENT' ? 127 : overflow ? 125 : err.killed ? 124 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: String(stdout ?? ''), stderr: `${stderr ?? ''}${err && err.code === 'ENOENT' ? `${cmd}: not found` : ''}${overflow ? `\n${cmd}: its output passed ${maxBytes} bytes and was cut there` : err && err.killed ? `\nkilled after ${Math.round(timeoutMs / 1000)}s` : ''}` });
    });
    if (input !== undefined) {
      child.stdin!.on('error', () => {}); // a git that exits before reading it all
      child.stdin!.end(input);
    }
  });
}

/**
 * What Claudestrator's own git calls run with. They run on your machine, outside the sandbox, with your credentials,
 * so they run no hook and no fsmonitor: husky's `core.hooksPath` points into the working tree, which agents and checks
 * write, and `git switch` would run a post-checkout left there. The repo's hooks run in the sandbox instead: the
 * commit's through `git commit` there, pre-push on its own (`Engine.prePush`).
 */
const HOST_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];

/**
 * The paths of a `-z` listing. Without `-z` git quotes a path with characters outside ASCII (`"src/\320\272…"`), and a
 * check's `when: src/` or the diff of a new file would miss it.
 */
const paths = (stdout: string): string[] => stdout.split('\0').filter(Boolean);

/**
 * Submodules are not the task's: an agent commits nothing, so it never moves one, and a submodule at another commit
 * than the branch says is the checkout's (origin moved it; you have not updated it). Counting it would commit it back.
 */
const NO_SUBMODULES = '--ignore-submodules=all';

// Machine state and config of the orchestrator never count as the user's changes.
const OWN = [`${ORCH_DIR}/`, '.claudestrator/'];
const isOwn = (file: string): boolean => OWN.some((p) => file === p.slice(0, -1) || file.startsWith(p));
const EXCLUDE = OWN.map((p) => `:(exclude)${p.slice(0, -1)}`);

class GitRepo {
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async git(...args: string[]): Promise<ExecResult> {
    return this.gitWith({}, ...args);
  }

  /** `git(...)` with more in its environment, text on its stdin, or longer than two minutes to run. */
  async gitWith({ env, input, timeoutMs = 120000 }: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }, ...args: string[]): Promise<ExecResult> {
    return exec('git', [...HOST_GIT, '-C', this.dir, ...args], { cwd: (await exists(this.dir)) ? this.dir : undefined, timeoutMs, ...(env && { env: { ...childEnv, ...env } }), ...(input !== undefined && { input }) });
  }

  /**
   * Whether this checkout keeps files in Git LFS: its attributes name the lfs filter, or its pre-push hook runs git lfs.
   * Their upload needs your credentials and the LFS server, which the sandboxed pre-push hook has neither of.
   */
  async usesLfs(): Promise<boolean> {
    const attributes = await fs.promises.readFile(path.join(this.dir, '.gitattributes'), 'utf8').catch(() => '');
    if (/filter=lfs/.test(attributes)) return true;
    const hooks = await this.hooksDir();
    const hook = hooks ? await fs.promises.readFile(path.join(hooks, 'pre-push'), 'utf8').catch(() => '') : '';
    return /git[ -]lfs/.test(hook);
  }

  /** Whether HEAD carries a signature (gpg, ssh or x509): git writes it as the commit's gpgsig header. */
  async headSigned(): Promise<boolean> {
    const r = await this.git('cat-file', 'commit', 'HEAD');
    return r.code === 0 && /^gpgsig(-sha256)? /m.test(r.stdout.split('\n\n')[0] ?? '');
  }

  /** The folder git runs this checkout's hooks from (`core.hooksPath`, else `.git/hooks`), absolute; null outside a repo. */
  async hooksDir(): Promise<string | null> {
    // Asked without HOST_GIT, whose hooksPath would answer for itself.
    const r = await exec('git', ['-c', 'core.fsmonitor=false', '-C', this.dir, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd: (await exists(this.dir)) ? this.dir : undefined, timeoutMs: 120000 });
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  async isRepo(): Promise<boolean> {
    if (!(await exists(this.dir))) return false;
    return (await this.git('rev-parse', '--is-inside-work-tree')).stdout.trim() === 'true';
  }

  async branch(): Promise<string | null> {
    const r = await this.git('rev-parse', '--abbrev-ref', 'HEAD');
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** `git status --porcelain` lines (`XY path`): uncommitted and untracked work. */
  async dirty(): Promise<string[]> {
    const entries = paths((await this.git('status', '--porcelain', '-z', NO_SUBMODULES)).stdout);
    const out: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      // A rename or copy is followed by the path it came from.
      if (/^[RC]/.test(e)) i++;
      if (!isOwn(e.slice(3))) out.push(e);
    }
    return out;
  }

  async hasBranch(name: string): Promise<boolean> {
    return (await this.git('rev-parse', '--verify', '--quiet', `refs/heads/${name}`)).code === 0;
  }

  /** Where `of` (HEAD, or a branch) left the base: merge-base with origin/<base>, else with <base>, else HEAD. */
  async baseRef(base: string, of = 'HEAD'): Promise<string> {
    for (const ref of [`origin/${base}`, base]) {
      const r = await this.git('merge-base', of, ref);
      if (r.code === 0) return r.stdout.trim();
    }
    return 'HEAD';
  }

  async untracked(): Promise<string[]> {
    return paths((await this.git('ls-files', '-z', '--others', '--exclude-standard')).stdout).filter((f) => !isOwn(f));
  }

  /** Files changed since the base, committed or not, plus untracked ones. */
  async changedFiles(base: string): Promise<string[]> {
    const tracked = paths((await this.git('diff', '--name-only', '-z', NO_SUBMODULES, await this.baseRef(base))).stdout).filter((f) => !isOwn(f));
    return [...new Set([...tracked, ...(await this.untracked())])].sort();
  }

  /**
   * Files a branch changes against the base, committed ones only: what pushing that branch publishes, whatever is
   * checked out at the moment. `branch...base` diffs from their merge-base.
   */
  async branchChanges(base: string, branch: string): Promise<string[]> {
    for (const ref of [`origin/${base}`, base]) {
      const r = await this.git('diff', '--name-only', '-z', `${ref}...${branch}`);
      if (r.code === 0) return paths(r.stdout).filter((f) => !isOwn(f));
    }
    return [];
  }

  /**
   * The checkout's changes against the base, as a stat and a patch, untracked files included as additions. One cut for
   * size says so, so a reviewer never takes it for whole.
   */
  async diff(base: string): Promise<string> {
    const ref = await this.baseRef(base);
    const untracked = await this.untracked();
    // Untracked files are marked intent-to-add in a copy of the index, which the checkout's own never sees: one
    // `git diff` then shows them as new files, where a `git diff --no-index` per file took a process each.
    const tmp = untracked.length ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cs-index-')) : null;
    try {
      let env: NodeJS.ProcessEnv = {};
      if (tmp) {
        const index = path.join(tmp, 'index');
        const own = (await this.git('rev-parse', '--path-format=absolute', '--git-path', 'index')).stdout.trim();
        await fs.promises.copyFile(own, index).catch(() => undefined); // no index yet: git starts an empty one
        env = { GIT_INDEX_FILE: index };
        await this.gitWith({ env, input: untracked.join('\0') }, 'add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul');
      }
      const runs = [await this.gitWith({ env }, '--no-pager', 'diff', NO_SUBMODULES, '--stat', ref, '--', '.', ...EXCLUDE), await this.gitWith({ env }, '--no-pager', 'diff', NO_SUBMODULES, ref, '--', '.', ...EXCLUDE)];
      const cut = runs.some((r) => r.code === 125);
      return [...runs.map((r) => r.stdout), cut ? `[this diff is larger than ${MAX_OUTPUT / 1024 / 1024} MB and was cut: review the rest with git diff in the repo, file by file]` : ''].filter((p) => p.trim()).join('\n');
    } finally {
      if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  }

  /** Where git keeps this checkout's metadata: its own folder and, for a worktree, the repository's shared one. */
  async gitDirs(): Promise<string[]> {
    const r = await this.git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir');
    return r.code === 0 ? [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean))] : [path.join(this.dir, '.git')];
  }

  /** Stages everything except the orchestrator's own folders and the submodules' pointers, which stay as the branch has them. */
  async addAll(): Promise<ExecResult> {
    const r = await this.git('add', '-A', '--', '.', ...EXCLUDE);
    if (r.code !== 0) return r;
    const submodules = (await this.git('ls-tree', '-r', '-z', '--full-tree', 'HEAD')).stdout
      .split('\0')
      .filter((e) => e.startsWith('160000 commit '))
      .map((e) => e.slice(e.indexOf('\t') + 1));
    return submodules.length ? this.gitWith({ input: submodules.join('\0') }, 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul') : r;
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

/**
 * The branch checked out where `dir` is, for the Bash guard, which decides inside a tool call: read from git's HEAD
 * file (a worktree's `.git` file points to its own), so no git process runs for it.
 * `HEAD` when detached, as `git rev-parse --abbrev-ref HEAD` says; null outside a repository.
 */
async function branchAt(dir: string): Promise<string | null> {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    const dotGit = path.join(cur, '.git');
    let gitDir: string | null = null;
    try {
      const st = await fs.promises.stat(dotGit);
      gitDir = st.isFile() ? path.resolve(cur, ((await fs.promises.readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+)$/m) || [])[1]?.trim() ?? '') : dotGit;
    } catch {
      // not here
    }
    if (gitDir) {
      try {
        const head = (await fs.promises.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
        return (head.match(/^ref:\s*refs\/heads\/(.+)$/) || [])[1] ?? 'HEAD';
      } catch {
        return null;
      }
    }
    if (path.dirname(cur) === cur) return null;
  }
}

const worktreeDir = (workspace: string, taskId: string, repo: string): string => path.join(workspace, ORCH_DIR, 'worktrees', taskId, repo);

/** A repo of a task: where its checkout is, where the task works, and the base branch. */
interface TaskRepo {
  name: string;
  checkout: string;
  dir: string;
  base: string;
  git: GitRepo;
}

type RepoLookup = Pick<Config, 'repos' | 'baseBranch'>;

/** Where each repo of a task lives. Repos missing from the config sit at `<workspace>/<name>` on the default base. */
function taskRepos(workspace: string, state: TaskState, config: RepoLookup | null | undefined, names: string[]): TaskRepo[] {
  return names.map((name) => {
    const r = config && config.repos[name];
    const checkout = path.resolve(workspace, (r && r.path) || name);
    const dir = state.gitMode === 'worktree' ? worktreeDir(workspace, state.taskId, name) : checkout;
    return { name, checkout, dir, base: (r && r.baseBranch) || (config && config.baseBranch) || 'main', git: new GitRepo(dir) };
  });
}

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

/**
 * Puts every plan repo on the task branch. All-or-nothing: if any repo is not ready, nothing changes.
 * Branch mode switches the user's checkout (which must be clean); worktree mode adds a worktree per repo
 * and never touches the checkout. Idempotent.
 */
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
    if ((await git.isRepo()) && (await git.branch()) === branch) continue;
    // A folder there already is someone's: a worktree a deleted task kept for its unsaved work, say. It is never
    // removed to make room.
    if (worktree) {
      if (await exists(dir)) blocked.push({ repo: name, dir, problem: `${dir} is there already (a worktree an earlier task with this id kept?); remove it, or commit or save its work first` });
      continue;
    }
    const dirty = await git.dirty();
    if (dirty.length) blocked.push({ repo: name, dir, problem: 'uncommitted changes', files: dirty.slice(0, 20) });
  }
  if (blocked.length) return { ok: false, code: 'repos_not_ready', error: 'some repos are not ready; nothing was changed', branch, blocked };

  const results: PrepareResult[] = [];
  /** What this call changed, to put back if a later repo fails: all or nothing. */
  const undo: (() => Promise<unknown>)[] = [];
  for (const { name, checkout, dir, base, git } of repos) {
    if ((await git.isRepo()) && (await git.branch()) === branch) {
      results.push({ repo: name, dir, status: 'ready' });
      continue;
    }
    const main = new GitRepo(checkout);
    const fetched = (await main.git('fetch', 'origin', base)).code === 0;
    const from = fetched || (await main.git('rev-parse', '--verify', '--quiet', `origin/${base}`)).code === 0 ? `origin/${base}` : base;
    const note = fetched ? {} : { note: 'fetch failed; branched from the local ref' };
    const had = await main.hasBranch(branch);
    const dropBranch = (): Promise<unknown> => (had ? Promise.resolve() : main.git('branch', '-D', branch));
    let r: ExecResult;
    if (worktree) {
      await fs.promises.mkdir(path.dirname(dir), { recursive: true });
      // Checked above; one that appeared since is not this call's to remove either.
      if (await exists(dir)) {
        results.push({ repo: name, dir, status: 'failed', error: `${dir} is there already` });
        break;
      }
      r = had ? await main.git('worktree', 'add', dir, branch) : await main.git('worktree', 'add', '-b', branch, dir, from);
      // A worktree half made (a timeout on a big repo) would make the next try fail with "already exists". The folder
      // was not there before this call, so what is in it now is that half-made worktree and nothing of yours.
      const removeWorktree = async (): Promise<void> => {
        await main.git('worktree', 'remove', '--force', dir);
        await fs.promises.rm(dir, { recursive: true, force: true });
        await main.git('worktree', 'prune');
      };
      if (r.code === 0) undo.push(async () => (await removeWorktree(), dropBranch()));
      else await removeWorktree();
    } else {
      // Where the checkout was: its branch, or the commit of a detached HEAD.
      const previous = await main.branch();
      const back = previous === 'HEAD' ? ['--detach', (await main.git('rev-parse', 'HEAD')).stdout.trim()] : previous ? [previous] : null;
      r = had ? await main.git('switch', branch) : await main.git('switch', '-c', branch, from);
      if (r.code === 0 && back) undo.push(async () => (await main.git('switch', ...back), dropBranch()));
    }
    results.push(r.code !== 0 ? { repo: name, dir, status: 'failed', error: r.stderr.trim() } : had && !worktree ? { repo: name, dir, status: 'switched' } : { repo: name, dir, status: 'created', from, ...note });
    if (r.code !== 0) break;
  }
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) {
    for (const step of undo.reverse()) await step();
    return { ok: false, code: 'switch_failed', error: `${failed.map((f) => `${f.repo}: ${f.error}`).join('\n')}\nThe repos prepared before it were put back as they were.`, branch };
  }
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
    if (!(await exists(dir))) {
      out.push({ repo: name, status: 'absent' });
      continue;
    }
    const r = await new GitRepo(checkout).git('worktree', 'remove', ...(force ? ['--force'] : []), dir);
    out.push(r.code === 0 ? { repo: name, status: 'removed' } : { repo: name, status: 'kept', error: r.stderr.trim() });
  }
  return out;
}

export type { ExecResult, ExecOptions, TaskRepo, Prepared, PrepareResult };
export { exec, launch, setShim, setChildEnv, getChildEnv, GitRepo, branchAt, worktreeDir, taskRepos, prepareRepos, taskDiff, removeWorktrees, isOwn };
