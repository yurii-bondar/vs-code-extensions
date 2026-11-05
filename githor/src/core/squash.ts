// Squash several commits of the current branch into one (design `12`–`22`). The new commit is made with commit-tree,
// so the index and working copy are never touched; commits after the squashed ones are put back on top with
// `rebase --onto`, which is what can stop at a conflict.
import { promises as fs } from 'fs';
import * as path from 'path';
import { commitDetails, parseChanges } from './log';
import { worktreeBranches } from './merged';
import type { GitRunner } from './git';
import type { RepoRoot, SquashPlan } from './types';

const lines = (out: string): string[] => out.split('\n').filter(Boolean);
const short = (sha: string): string => sha.slice(0, 7);

/** Marks a rebase as the second half of a squash, so the conflict screens say so; it holds what Undo needs. */
const MARKER = 'githor-squash.json';

interface Marker {
  oldHead: string;
  count: number;
}

const markerPath = async (git: GitRunner, root: RepoRoot): Promise<string> => path.resolve(root, (await git.run(root, ['rev-parse', '--git-path', MARKER])).trim());

export async function readSquashMarker(git: GitRunner, root: RepoRoot): Promise<Marker | null> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(await markerPath(git, root), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const { oldHead, count } = raw as Record<string, unknown>;
    return typeof oldHead === 'string' && typeof count === 'number' ? { oldHead, count } : null;
  } catch {
    return null;
  }
}

export async function clearSquashMarker(git: GitRunner, root: RepoRoot): Promise<void> {
  await fs.rm(await markerPath(git, root), { force: true });
}

export interface PlanArgs {
  git: GitRunner;
  root: RepoRoot;
  shas: readonly string[];
  /** The checked-out branch, or null on no branch. */
  branch: string | null;
  defaultBranch: string | null;
}

/** git's empty tree: what the first commit's files are compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface Line {
  /** The branch, or null for a detached HEAD. */
  branch: string | null;
  current: boolean;
  /** Its own line of commits (first parents), oldest first. */
  chain: string[];
}

/**
 * The branch to squash on: the current one when its own line holds every selected commit, else the local branch whose
 * line does with the fewest commits after them. Null when no branch's line holds them all, as with the commits of a
 * branch that was merged and deleted.
 */
async function lineFor(git: GitRunner, root: RepoRoot, { full, current }: { full: readonly string[]; current: string | null }): Promise<Line | null> {
  const chainOf = async (ref: string): Promise<string[]> => lines(await git.run(root, ['rev-list', '--first-parent', '--reverse', ref]));
  const holds = (chain: readonly string[]): boolean => full.every((s) => chain.includes(s));
  const own = await chainOf('HEAD');
  if (holds(own)) return { branch: current, current: true, chain: own };
  const names = lines(await git.run(root, ['for-each-ref', '--format=%(refname:short)', ...full.map((s) => `--contains=${s}`), 'refs/heads/'])).filter((n) => n !== current);
  let best: Line | null = null;
  let bestAfter = Infinity;
  for (const name of names) {
    const chain = await chainOf(`refs/heads/${name}`);
    if (!holds(chain)) continue;
    const after = chain.length - 1 - Math.max(...full.map((s) => chain.indexOf(s)));
    if (after < bestAfter) [best, bestAfter] = [{ branch: name, current: false, chain }, after];
  }
  return best;
}

/** Checks a selection and says what squashing it does: where, on what base, the result's files, and what stops it. */
export async function squashPlan({ git, root, shas, branch, defaultBranch }: PlanArgs): Promise<SquashPlan> {
  const full = await Promise.all(shas.map(async (s) => (await git.run(root, ['rev-parse', '--verify', `${s}^{commit}`])).trim()));
  const line = await lineFor(git, root, { full, current: branch });
  const chain = line?.chain ?? [];
  const order = (s: string): number => (chain.includes(s) ? chain.indexOf(s) : -1);
  const commits = await Promise.all([...full].sort((a, b) => order(b) - order(a)).map((s) => commitDetails(git, root, s)));
  const empty: SquashPlan = { commits, branch: line?.branch ?? branch, switchFirst: false, base: null, baseShort: null, problem: null, gap: [], pushed: [], after: 0, files: [] };
  if (!line) return { ...empty, problem: "These commits are not on one branch's own line: they may come from a branch that was merged and deleted." };

  const at = full.map(order);
  const first = Math.min(...at);
  const last = Math.max(...at);
  const gap = chain.slice(first, last + 1).filter((s) => !full.includes(s));
  const base = first > 0 ? (chain[first - 1] ?? null) : null;
  const newest = chain[last] as string;
  const after = chain.length - 1 - last;
  const unpushed = new Set(lines(await git.run(root, ['rev-list', newest, '--not', '--remotes'])));
  const pushed = full.filter((s) => !unpushed.has(s)).map(short);
  const from = base ?? EMPTY_TREE;
  const files = parseChanges(await git.run(root, ['diff', '-M', '--numstat', from, newest]), await git.run(root, ['diff', '-M', '--name-status', from, newest]));
  const plan: SquashPlan = { ...empty, switchFirst: !line.current && after > 0, base, baseShort: base ? short(base) : null, gap: gap.map(short), pushed, after, files };

  const elsewhere = line.current || !line.branch ? null : (await worktreeBranches(git, root)).get(line.branch);
  let problem: string | null = null;
  if (line.branch !== null && line.branch === defaultBranch) problem = `Squash is off on ${line.branch}: it rewrites shared history.`;
  else if (full.length < 2) problem = 'Select two or more commits to squash.';
  else if (gap.length) problem = `${gap.map(short).join(', ')} ${gap.length === 1 ? 'sits' : 'sit'} between these. Add ${gap.length === 1 ? 'it' : 'them'} to the selection to continue.`;
  else if (elsewhere) problem = `${line.branch} is checked out in ${elsewhere}. Squash it there.`;
  return { ...plan, problem };
}

export interface SquashResult {
  /** Where the branch was, for Undo. */
  oldHead: string;
  /** The branch ref moved without being checked out; null when the checked-out branch (or HEAD) moved. */
  movedRef: string | null;
  /** Putting later commits back stopped at a conflict: Continue finishes the squash. */
  paused: boolean;
}

/**
 * Squashes the plan's commits into one with `message`. On a branch that is not checked out and ends with them, only
 * its ref moves; one with commits after them is switched to first. Later commits are put back on top, merges kept,
 * which can pause at a conflict.
 */
export async function squash(git: GitRunner, root: RepoRoot, { plan, message }: { plan: SquashPlan; message: string }): Promise<SquashResult> {
  if (plan.problem) throw new Error(plan.problem);
  const newest = plan.commits[0]?.sha as string;
  const oldest = plan.commits[plan.commits.length - 1] as (typeof plan.commits)[number];
  // the squashed commit keeps the oldest commit's author, as a squash in the log should read
  const env = ['-c', `user.name=${oldest.author}`, '-c', `user.email=${oldest.email}`];
  const tree = (await git.run(root, ['rev-parse', `${newest}^{tree}`])).trim();
  // the first commit of the repository has no parent, and neither has the squash of it
  const squashed = (await git.run(root, [...env, 'commit-tree', tree, ...(plan.base ? ['-p', plan.base] : []), '-m', message])).trim();

  const current = (await git.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim() || null;
  if (plan.branch && plan.branch !== current) {
    if (plan.after === 0) {
      // the branch ends with these commits and is not checked out: moving its ref touches no file anywhere
      const ref = `refs/heads/${plan.branch}`;
      const oldTip = (await git.run(root, ['rev-parse', ref])).trim();
      await git.run(root, ['update-ref', ref, squashed, oldTip]);
      return { oldHead: oldTip, movedRef: ref, paused: false };
    }
    await git.run(root, ['switch', plan.branch]);
  }

  const oldHead = (await git.run(root, ['rev-parse', 'HEAD'])).trim();
  const branchRef = (await git.run(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (plan.after === 0) {
    // the squashed commits end at HEAD: the new commit has HEAD's tree, so moving the branch changes no file
    await git.run(root, branchRef ? ['update-ref', branchRef, squashed, oldHead] : ['update-ref', '--no-deref', 'HEAD', squashed, oldHead]);
    return { oldHead, movedRef: null, paused: false };
  }
  await fs.writeFile(await markerPath(git, root), JSON.stringify({ oldHead, count: plan.commits.length } satisfies Marker));
  try {
    await git.run(root, ['-c', 'core.editor=true', 'rebase', '--rebase-merges', '--onto', squashed, newest]);
  } catch (e) {
    const paused = await git.run(root, ['rev-parse', '--git-path', 'rebase-merge']).then(async (p) => fs.access(path.resolve(root, p.trim())).then(() => true, () => false));
    if (paused) return { oldHead, movedRef: null, paused: true };
    await clearSquashMarker(git, root);
    throw e;
  }
  await clearSquashMarker(git, root);
  return { oldHead, movedRef: null, paused: false };
}
