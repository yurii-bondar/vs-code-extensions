// Which branches are already merged into a target, so deleting them loses no work. A port of the checks in
// delete-merged-main-branches.sh: git's own `branch --merged` sees only regular merges, and misses squash merges,
// rebase merges, merged stacks and drafts the target holds in a reworked form. Every check below is one of the script's,
// in its order.
import { refExists } from './branches';
import { unfinishedTask } from './tasks';
import type { GitRunner } from './git';
import type { Branch, KeptBranch, MergedBranch, MergedScan, RepoRoot } from './types';

const succeeds = (p: Promise<unknown>): Promise<boolean> => p.then(
  () => true,
  () => false
);
const output = (p: Promise<string>): Promise<string | null> => p.then(
  (s) => s,
  () => null
);

/** Branches never offered for deletion, whatever their state. */
const ALWAYS_KEPT = ['main', 'master', 'HEAD'];
/** How many branches are checked at once: each check runs several git commands. */
const PARALLEL = 4;

/**
 * Identifiers, numbers and string literals of a file, counted. A package.json `version` line is left out, since
 * every release commit bumps it.
 */
export function countTokens(text: string, file: string): Map<string, number> {
  const source = file.endsWith('package.json') ? text.replace(/^[ \t]*"version"[ \t]*:.*$/gm, '') : text;
  const counts = new Map<string, number>();
  for (const [token] of source.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*|[0-9][0-9.]*|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * True when every token the branch adds (against the merge base) the base adds at least as often, and every token it
 * removes the base removes at least as often: a conflict between them is the base going further, never the branch
 * going elsewhere.
 */
export function baseGoesFurther({ mergeBase, branch, base }: { mergeBase: Map<string, number>; branch: Map<string, number>; base: Map<string, number> }): boolean {
  for (const token of new Set([...mergeBase.keys(), ...branch.keys(), ...base.keys()])) {
    const before = mergeBase.get(token) ?? 0;
    const ours = (branch.get(token) ?? 0) - before;
    const theirs = (base.get(token) ?? 0) - before;
    if ((ours > 0 && theirs < ours) || (ours < 0 && theirs > ours)) return false;
  }
  return true;
}

/** Decides, with caches, whether refs are merged into one base ref. */
class MergeCheck {
  private readonly verdicts = new Map<string, Promise<boolean>>();
  private readonly treeLogs = new Map<string, Promise<Set<string>>>();
  private baseTree: Promise<string> | undefined;
  private refs: Promise<string[]> | undefined;

  constructor(
    private readonly git: GitRunner,
    private readonly root: RepoRoot,
    private readonly base: string
  ) {}

  private run(args: readonly string[]): Promise<string> {
    return this.git.run(this.root, args);
  }

  /** `nested`: checking a branch above a stack level, which skips the stack search so it never recurses. */
  isMerged(ref: string, nested = false): Promise<boolean> {
    const key = `${nested ? 'nested ' : ''}${ref}`;
    let verdict = this.verdicts.get(key);
    if (!verdict) this.verdicts.set(key, (verdict = this.check(ref, nested)));
    return verdict;
  }

  private async check(ref: string, nested: boolean): Promise<boolean> {
    const base = this.base;
    // plain merge or fast-forward: the tip itself is part of the base's history
    if (await succeeds(this.run(['merge-base', '--is-ancestor', ref, base]))) return true;

    const mergeBase = (await output(this.run(['merge-base', base, ref])))?.trim();
    if (!mergeBase) return false;

    // the very same content as the base: nothing unique left
    if (await succeeds(this.run(['diff', '--quiet', base, ref]))) return true;

    // squash merge: replay the whole branch as one commit off the merge base, and ask git whether that patch is in
    // the base. The commit is never referenced; the identity only lets commit-tree run where none is configured.
    const tree = (await output(this.run(['rev-parse', `${ref}^{tree}`])))?.trim();
    if (!tree) return false;
    const squashed = (await output(this.run(['-c', 'user.name=Githor', '-c', 'user.email=githor@localhost', 'commit-tree', tree, '-p', mergeBase, '-m', '_'])))?.trim();
    if (squashed && (await output(this.run(['cherry', base, squashed])))?.startsWith('-')) return true;

    // rebase or cherry-pick: every commit has an equivalent patch in the base
    const cherry = (await output(this.run(['cherry', base, ref])))?.trim();
    if (cherry && !/^\+/m.test(cherry)) return true;

    // a squash merge of a stack, or one that also carries conflict resolutions: no patch matches, yet merging the
    // branch would change nothing
    if (await this.addsNothing(ref)) return true;

    // an early draft of work that reached the base in a later, reworked form
    if (await this.superseded(ref, mergeBase)) return true;

    // an older point of a branch that is itself contained: a stack level left behind below it
    for (const other of await this.containing(ref)) {
      if (other !== ref && other !== base && (await this.addsNothing(other))) return true;
    }

    // a stack level squash-merged into the branch above it, which then reached the base on its own: that branch holds
    // no commit of this one, only one with the very same tree. One level deep.
    if (nested) return false;
    for (const other of await this.allRefs()) {
      if (other === ref || other === base) continue;
      if (!(await this.treesOf(other)).has(tree)) continue;
      if (await this.isMerged(other, true)) return true;
    }
    return false;
  }

  private treeOfBase(): Promise<string> {
    return (this.baseTree ??= this.run(['rev-parse', `${this.base}^{tree}`]).then((s) => s.trim()));
  }

  /** The tree of merging `ref` into the base; with `ours`, the base wins every conflict. Null when git cannot. */
  private async mergedTree(ref: string, ours: boolean): Promise<string | null> {
    const merged = await output(this.run(['merge-tree', '--write-tree', ...(ours ? ['-X', 'ours'] : []), this.base, ref]));
    return merged?.split('\n')[0]?.trim() ?? null;
  }

  /** Merging `ref` into the base leaves the base's tree as it is. */
  private async addsNothing(ref: string): Promise<boolean> {
    const merged = await this.mergedTree(ref, false);
    return merged !== null && merged === (await this.treeOfBase());
  }

  /**
   * The branch's work reached the base in a later, reworked form, so merging it would only conflict. Both must hold:
   * with the base winning every conflict the merge changes nothing, and in every file the branch touches the base
   * goes further (`baseGoesFurther`).
   */
  private async superseded(ref: string, mergeBase: string): Promise<boolean> {
    const merged = await this.mergedTree(ref, true);
    if (merged === null || merged !== (await this.treeOfBase())) return false;
    const files = (await output(this.run(['diff', '--name-only', '-z', mergeBase, ref]))) ?? '';
    for (const file of files.split('\0').filter(Boolean)) {
      const [mergeBaseText, branchText, baseText] = await Promise.all([mergeBase, ref, this.base].map((rev) => this.fileAt(rev, file)));
      const counts = { mergeBase: countTokens(mergeBaseText ?? '', file), branch: countTokens(branchText ?? '', file), base: countTokens(baseText ?? '', file) };
      if (!baseGoesFurther(counts)) return false;
    }
    return true;
  }

  private fileAt(rev: string, file: string): Promise<string | null> {
    return output(this.run(['show', `${rev}:${file}`]));
  }

  /** Local and remote-tracking branches that contain `ref`. */
  private async containing(ref: string): Promise<string[]> {
    const refs = await output(this.run(['for-each-ref', '--contains', ref, '--format=%(if)%(symref)%(then)%(else)%(refname)%(end)', 'refs/heads/', 'refs/remotes/']));
    return (refs ?? '').split('\n').filter(Boolean);
  }

  private allRefs(): Promise<string[]> {
    return (this.refs ??= this.run(['for-each-ref', '--format=%(if)%(symref)%(then)%(else)%(refname)%(end)', 'refs/heads/', 'refs/remotes/']).then((s) => s.split('\n').filter(Boolean)));
  }

  /** The trees of the commits `other` has and the base does not. */
  private treesOf(other: string): Promise<Set<string>> {
    let trees = this.treeLogs.get(other);
    if (!trees) {
      trees = output(this.run(['log', '--format=%T', `${this.base}..${other}`])).then((s) => new Set((s ?? '').split('\n').filter(Boolean)));
      this.treeLogs.set(other, trees);
    }
    return trees;
  }
}

/**
 * What the target picker offers: the default branch, then the long-lived ones (`develop`, `dev`, `staging`,
 * `release/*`), then the current branch.
 */
export function mergeTargets(branches: readonly Branch[], main: string | null): string[] {
  const longLived = branches.map((b) => b.name).filter((n) => /^(develop|dev|staging)$|^release\//.test(n));
  const current = branches.find((b) => b.current)?.name;
  return [...new Set([main, ...longLived, current].filter((n): n is string => Boolean(n)))];
}

/** The ref a target branch is compared against: its copy on origin when there is one, as the script does. */
export async function targetRef(git: GitRunner, root: RepoRoot, target: string): Promise<string> {
  for (const ref of [`refs/remotes/origin/${target}`, `refs/heads/${target}`]) {
    if (await refExists(git, root, ref)) return ref;
  }
  throw new Error(`There is no branch ${target}.`);
}

/** Whether `ref` (a full ref) is merged into the branch `target`, by every check above. */
export async function isMergedInto({ git, root, ref, target }: { git: GitRunner; root: RepoRoot; ref: string; target: string }): Promise<boolean> {
  return new MergeCheck(git, root, await targetRef(git, root, target)).isMerged(ref);
}

/** Branch name → path of the other worktree it is checked out in. */
async function worktreeBranches(git: GitRunner, root: RepoRoot): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  const list = (await output(git.run(root, ['worktree', 'list', '--porcelain']))) ?? '';
  for (const block of list.split('\n\n')) {
    const worktree = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (worktree && branch && worktree !== root) held.set(branch, worktree);
  }
  return held;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ScanMergedArgs {
  git: GitRunner;
  root: RepoRoot;
  /** The branch to compare against, e.g. `main`. */
  target: string;
  /** The checked-out branch: never listed. */
  current: string | null;
  /** More branches never listed, such as the default branch. */
  protect?: readonly string[];
  /** Where Claudestrator may keep task records, see `unfinishedTask`. */
  taskDirs: readonly string[];
}

/**
 * The local branches merged into `target`. Never listed: the target, `main`, `master`, the protected branches and the
 * current branch. Kept, with the reason: a merged branch checked out in another worktree, or one an unfinished
 * Claudestrator task made.
 */
export async function scanMerged({ git, root, target, current, protect = [], taskDirs }: ScanMergedArgs): Promise<MergedScan> {
  const check = new MergeCheck(git, root, await targetRef(git, root, target));
  const never = new Set([...ALWAYS_KEPT, target, ...protect, ...(current ? [current] : [])]);
  const worktrees = await worktreeBranches(git, root);
  const lines = await git.run(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(upstream:short)', 'refs/heads/']);
  const candidates = lines
    .split('\n')
    .map((line) => line.split('\0'))
    .flatMap(([ref, sha, time, upstream]) => (ref && sha && time !== undefined ? [{ name: ref.slice('refs/heads/'.length), sha, committedAt: Number(time) * 1000, upstream: upstream || null }] : []))
    .filter((b) => !never.has(b.name));

  const verdicts = await mapLimit(candidates, PARALLEL, async (b): Promise<MergedBranch | KeptBranch | null> => {
    if (!(await check.isMerged(`refs/heads/${b.name}`))) return null;
    const worktree = worktrees.get(b.name);
    if (worktree) return { name: b.name, reason: `checked out in ${worktree}` };
    const task = await unfinishedTask({ git, root, branch: b.name, taskDirs });
    if (task) return { name: b.name, reason: `Claudestrator task ${task} is not finished` };
    const upstreamRef = b.upstream ? `refs/remotes/${b.upstream}` : null;
    const upstreamMerged = upstreamRef !== null && (await refExists(git, root, upstreamRef)) && (await check.isMerged(upstreamRef));
    return { ...b, upstreamMerged };
  });

  const merged = verdicts.filter((v): v is MergedBranch => v !== null && 'sha' in v).sort((a, b) => b.committedAt - a.committedAt);
  const kept = verdicts.filter((v): v is KeptBranch => v !== null && 'reason' in v);
  return { target, merged, kept };
}
