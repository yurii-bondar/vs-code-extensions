// Squash several commits of the current branch into one (design `12`–`22`). The new commit is made with commit-tree,
// so the index and working copy are never touched; commits after the squashed ones are put back on top with
// `rebase --onto`, which is what can stop at a conflict.
import { promises as fs } from 'fs';
import * as path from 'path';
import { commitDetails, parseChanges } from './log';
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

/** Checks a selection and says what squashing it does: the base, the result's files, and anything that stops it. */
export async function squashPlan({ git, root, shas, branch, defaultBranch }: PlanArgs): Promise<SquashPlan> {
  const head = (await git.run(root, ['rev-parse', 'HEAD'])).trim();
  const full = await Promise.all(shas.map(async (s) => (await git.run(root, ['rev-parse', '--verify', `${s}^{commit}`])).trim()));
  // the branch's own line of commits, oldest first: a squash takes a run of it
  const chain = lines(await git.run(root, ['rev-list', '--first-parent', '--reverse', head]));
  const at = full.map((s) => chain.indexOf(s));
  const commits = await Promise.all([...full].sort((a, b) => chain.indexOf(b) - chain.indexOf(a)).map((s) => commitDetails(git, root, s)));
  const empty: SquashPlan = { commits, base: null, baseShort: null, problem: null, gap: [], pushed: [], after: 0, files: [] };
  if (at.some((i) => i === -1)) return { ...empty, problem: `These commits are not all on ${branch ?? 'the checked-out commit'}.` };
  const first = Math.min(...at);
  const last = Math.max(...at);
  const gap = chain.slice(first, last + 1).filter((s) => !full.includes(s));
  const base = first > 0 ? (chain[first - 1] ?? null) : null;
  const newest = chain[last] as string;
  const parents = await Promise.all(full.map(async (s) => lines(await git.run(root, ['rev-list', '--parents', '-n', '1', s]))[0]?.split(' ').length ?? 1));
  const unpushed = new Set(lines(await git.run(root, ['rev-list', newest, '--not', '--remotes'])));
  const pushed = full.filter((s) => !unpushed.has(s)).map(short);
  const files = base ? parseChanges(await git.run(root, ['diff', '-M', '--numstat', base, newest]), await git.run(root, ['diff', '-M', '--name-status', base, newest])) : [];
  const plan: SquashPlan = { ...empty, base, baseShort: base ? short(base) : null, gap: gap.map(short), pushed, after: chain.length - 1 - last, files };

  let problem: string | null = null;
  if (branch !== null && branch === defaultBranch) problem = `Squash is off on ${branch}: it rewrites shared history.`;
  else if (full.length < 2) problem = 'Select two or more commits to squash.';
  else if (gap.length) problem = `${gap.map(short).join(', ')} ${gap.length === 1 ? 'sits' : 'sit'} between these. Add ${gap.length === 1 ? 'it' : 'them'} to the selection to continue.`;
  else if (!base) problem = 'The first commit of the repository cannot be squashed here.';
  else if (parents.some((n) => n > 2)) problem = 'A merge commit is among these: squashing it is not supported.';
  return { ...plan, problem };
}

/**
 * Squashes the plan's commits into one with `message`. When newer commits follow, they are put back on top, which can
 * pause at a conflict: then the result says so and the squash finishes with Continue. Returns the old tip, for Undo.
 */
export async function squash(git: GitRunner, root: RepoRoot, { plan, message }: { plan: SquashPlan; message: string }): Promise<{ oldHead: string; paused: boolean }> {
  if (plan.problem || !plan.base) throw new Error(plan.problem ?? 'Nothing to squash.');
  const oldHead = (await git.run(root, ['rev-parse', 'HEAD'])).trim();
  const newest = plan.commits[0]?.sha as string;
  const oldest = plan.commits[plan.commits.length - 1] as (typeof plan.commits)[number];
  // the squashed commit keeps the oldest commit's author and date, as a squash in the log should read
  const env = ['-c', `user.name=${oldest.author}`, '-c', `user.email=${oldest.email}`];
  const tree = (await git.run(root, ['rev-parse', `${newest}^{tree}`])).trim();
  const squashed = (await git.run(root, [...env, 'commit-tree', tree, '-p', plan.base, '-m', message])).trim();
  const branch = (await git.run(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();

  if (plan.after === 0) {
    // the squashed commits end at HEAD: the new commit has HEAD's tree, so moving the branch changes no file
    await git.run(root, branch ? ['update-ref', branch, squashed, oldHead] : ['update-ref', '--no-deref', 'HEAD', squashed, oldHead]);
    return { oldHead, paused: false };
  }
  await fs.writeFile(await markerPath(git, root), JSON.stringify({ oldHead, count: plan.commits.length } satisfies Marker));
  try {
    await git.run(root, ['-c', 'core.editor=true', 'rebase', '--onto', squashed, newest]);
  } catch (e) {
    const paused = await git.run(root, ['rev-parse', '--git-path', 'rebase-merge']).then(async (p) => fs.access(path.resolve(root, p.trim())).then(() => true, () => false));
    if (paused) return { oldHead, paused: true };
    await clearSquashMarker(git, root);
    throw e;
  }
  await clearSquashMarker(git, root);
  return { oldHead, paused: false };
}
