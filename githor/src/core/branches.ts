import type { GitRunner } from './git';
import type { Branch, RepoRoot, SyncState } from './types';

// One ref per line, fields split by NUL: a ref name cannot hold either, so no field can break the split.
const FIELDS = ['%(refname)', '%(objectname)', '%(HEAD)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(symref)'];
const FORMAT = FIELDS.join('%00');

const LOCAL = 'refs/heads/';
const REMOTE = 'refs/remotes/';

function syncOf(upstream: string, track: string, counts: { ahead: number; behind: number }): SyncState {
  if (!upstream) return 'unpushed';
  if (track === 'gone') return 'gone';
  if (counts.ahead && counts.behind) return 'diverged';
  if (counts.ahead) return 'ahead';
  if (counts.behind) return 'behind';
  return 'synced';
}

const count = (track: string, word: 'ahead' | 'behind'): number => Number(new RegExp(`${word} (\\d+)`).exec(track)?.[1] ?? 0);

/**
 * Branches from `git for-each-ref --format=FORMAT refs/heads refs/remotes`: every local branch, then the remote
 * branches no local branch tracks. The current branch comes first, the rest newest first. A branch with no upstream
 * has `ahead` 0 here; `listBranches` counts its commits.
 */
export function parseRefs(output: string): Branch[] {
  const local: Branch[] = [];
  const remote: Branch[] = [];
  for (const line of output.split('\n')) {
    const [ref, sha, head, upstream, track, time, symref] = line.split('\0');
    if (ref === undefined || sha === undefined || time === undefined || symref === undefined) continue;
    const committedAt = Number(time) * 1000;
    if (ref.startsWith(LOCAL)) {
      const counts = { ahead: count(track ?? '', 'ahead'), behind: count(track ?? '', 'behind') };
      const sync = syncOf(upstream ?? '', track ?? '', counts);
      local.push({ name: ref.slice(LOCAL.length), ref, current: head === '*', local: true, upstream: upstream || null, sync, ...counts, sha, committedAt });
    } else if (ref.startsWith(REMOTE) && !symref) {
      const short = ref.slice(REMOTE.length);
      const name = short.slice(short.indexOf('/') + 1);
      remote.push({ name, ref, current: false, local: false, upstream: short, sync: 'remote', ahead: 0, behind: 0, sha, committedAt });
    }
  }
  const tracked = new Set(local.map((b) => b.upstream));
  const newestFirst = (a: Branch, b: Branch): number => Number(b.current) - Number(a.current) || b.committedAt - a.committedAt;
  return [...local.sort(newestFirst), ...remote.filter((b) => !tracked.has(b.upstream)).sort(newestFirst)];
}

export async function listBranches(git: GitRunner, root: RepoRoot): Promise<Branch[]> {
  const branches = parseRefs(await git.run(root, ['for-each-ref', `--format=${FORMAT}`, 'refs/heads', 'refs/remotes']));
  // A branch that was never pushed: its commits that no remote has yet, which is what `↑` means for it.
  await Promise.all(
    branches
      .filter((b) => b.sync === 'unpushed')
      .map(async (b) => {
        b.ahead = Number((await git.run(root, ['rev-list', '--count', b.ref, '--not', '--remotes'])).trim()) || 0;
      })
  );
  return branches;
}

/** Checks out `branch`; a remote-only branch gets a local branch that tracks it. */
export async function switchBranch(git: GitRunner, root: RepoRoot, branch: Branch): Promise<void> {
  await git.run(root, branch.local ? ['switch', branch.name] : ['switch', '--track', branch.upstream ?? branch.name]);
}

/**
 * The repository's default branch: what `origin/HEAD` points at, else `main` or `master` when one exists on origin
 * or locally. Null when none of these is there.
 */
export async function defaultBranch(git: GitRunner, root: RepoRoot): Promise<string | null> {
  const head = await git.run(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).then(
    (s) => s.trim(),
    () => ''
  );
  if (head) return head.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      if (await refExists(git, root, ref)) return name;
    }
  }
  return null;
}

export function refExists(git: GitRunner, root: RepoRoot, ref: string): Promise<boolean> {
  return git.run(root, ['rev-parse', '--verify', '--quiet', ref]).then(
    () => true,
    () => false
  );
}
