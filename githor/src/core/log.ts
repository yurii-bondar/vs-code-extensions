// The commit log (design `01`, `14`): commits of every branch and tag with the refs pointing at them, and one commit's
// details with its changed files.
import type { GitRunner } from './git';
import type { CommitDetails, CommitView, FileChange, RefChip, RepoRoot } from './types';

// One commit per record, fields split by NUL, records by the unit separator: a subject cannot hold either.
const FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%ct', '%s', '%D'].join('%x00') + '%x1f';

/** `HEAD -> main, origin/main, tag: v1.0, origin/HEAD` → chips: a branch here and on its remote is one chip. */
export function parseDecoration(decoration: string, remotes: readonly string[]): RefChip[] {
  const chips = new Map<string, RefChip>();
  const branch = (name: string): RefChip => {
    let chip = chips.get(`b:${name}`);
    if (!chip) chips.set(`b:${name}`, (chip = { name, kind: 'branch', local: false, remote: false, head: false }));
    return chip;
  };
  for (const raw of decoration.split(', ').map((s) => s.trim()).filter(Boolean)) {
    if (raw === 'HEAD') continue;
    if (raw.startsWith('tag: ')) {
      const name = raw.slice(5);
      chips.set(`t:${name}`, { name, kind: 'tag', local: true, remote: false, head: false });
      continue;
    }
    if (raw.startsWith('HEAD -> ')) {
      const chip = branch(raw.slice(8));
      chip.local = chip.head = true;
      continue;
    }
    const remote = remotes.find((r) => raw.startsWith(`${r}/`));
    if (remote) {
      const name = raw.slice(remote.length + 1);
      if (name !== 'HEAD') branch(name).remote = true;
    } else {
      branch(raw).local = true;
    }
  }
  const order = (c: RefChip): number => (c.head ? 0 : c.kind === 'branch' ? 1 : 2);
  return [...chips.values()].sort((a, b) => order(a) - order(b));
}

export function parseLog(output: string, remotes: readonly string[]): CommitView[] {
  return output
    .split('\x1f')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha = '', short = '', parents = '', author = '', email = '', time = '0', subject = '', refs = ''] = record.split('\0');
      return { sha, short, parents: parents.split(' ').filter(Boolean), author, email, committedAt: Number(time) * 1000, subject, refs: parseDecoration(refs, remotes) };
    });
}

export interface ReadLogArgs {
  git: GitRunner;
  root: RepoRoot;
  /** How many commits, newest first. */
  limit: number;
}

/** The newest `limit` commits of all branches, remote branches and tags, in an order the graph can draw. */
export async function readLog({ git, root, limit }: ReadLogArgs): Promise<{ commits: CommitView[]; hasMore: boolean }> {
  const remotes = (await git.run(root, ['remote'])).split('\n').filter(Boolean);
  const hasHead = await git.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    () => true,
    () => false
  );
  if (!hasHead) return { commits: [], hasMore: false };
  const out = await git.run(root, ['log', '--topo-order', `--max-count=${limit + 1}`, `--format=${FORMAT}`, '--decorate=short', '--branches', '--remotes', '--tags', 'HEAD']);
  const commits = parseLog(out, remotes);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

/** `git diff --numstat` and `--name-status` together, one entry per file. */
export function parseChanges(numstat: string, nameStatus: string): FileChange[] {
  const stats = numstat.split('\n').filter(Boolean).map((l) => l.split('\t'));
  return nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const [code = '', first = '', second] = line.split('\t');
      const status = (code[0] ?? 'M') as FileChange['status'];
      const [add = '0', del = '0'] = stats[i] ?? [];
      const binary = add === '-';
      return { status, path: second ?? first, oldPath: second ? first : null, add: binary ? 0 : Number(add), del: binary ? 0 : Number(del), binary };
    });
}

/** A commit's message and the files it changed, against its first parent (the empty tree for the first commit). */
export async function commitDetails(git: GitRunner, root: RepoRoot, sha: string): Promise<CommitDetails> {
  const [head, body] = await Promise.all([git.run(root, ['show', '-s', '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%ct%x00%s', sha]), git.run(root, ['show', '-s', '--format=%b', sha])]);
  const [full = sha, short = '', parents = '', author = '', email = '', time = '0', subject = ''] = head.trim().split('\0');
  const parent = parents.split(' ').filter(Boolean)[0] ?? null;
  const range = parent ? [parent, full] : ['--root', full];
  const diff = parent ? ['diff', '-M'] : ['diff-tree', '-r', '-M', '--no-commit-id'];
  const [numstat, nameStatus] = await Promise.all([git.run(root, [...diff, '--numstat', ...range]), git.run(root, [...diff, '--name-status', ...range])]);
  return { sha: full, short, parent, author, email, committedAt: Number(time) * 1000, subject, body: body.trim(), files: parseChanges(numstat, nameStatus) };
}

/** The address git commits with in this repository, to tell "mine". Null when none is set. */
export async function userEmail(git: GitRunner, root: RepoRoot): Promise<string | null> {
  return git.run(root, ['config', 'user.email']).then(
    (s) => s.trim() || null,
    () => null
  );
}
