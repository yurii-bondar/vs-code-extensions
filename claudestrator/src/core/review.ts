// A pull request's review, as it goes to the PR: each finding on a line the PR changed becomes a comment there, and
// the rest goes into one summary with the reviewers' verdicts. Pure: the engine reads the diff and the reports, the
// forges post.
import { AI_CREDIT } from './guard';
import type { Finding, RecordedVerdict } from './types';

/** A comment on a line of the PR's head, by its path in the repo. */
interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/** A reviewer's verdict and summary, as the summary comment opens with them. */
interface ReviewerSummary {
  agent: string;
  status: RecordedVerdict['status'];
  summary: string;
}

/** What goes to the PR: the comments on its lines, and the summary, given those a forge would not place on a line. */
interface ReviewPost {
  inline: InlineComment[];
  summary: (missed: InlineComment[]) => string;
}

/**
 * The lines of each file that the PR's head has in its diff (added, or shown around a change): the lines a forge takes
 * a comment on. From a unified diff, `+++ b/<path>` and its hunks.
 */
function changedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let lines: Set<number> | null = null;
  let at = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const file = raw.slice(4).trim();
      if (file === '/dev/null') lines = null;
      else {
        const name = file.replace(/^"?b\//, '').replace(/"$/, '');
        lines = out.get(name) ?? new Set<number>();
        out.set(name, lines);
      }
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      at = Number(hunk[1]);
      continue;
    }
    if (!lines || raw.startsWith('diff ') || raw.startsWith('--- ') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+') || raw.startsWith(' ')) lines.add(at++);
  }
  return out;
}

/** A finding's file as the repo has it: without the repo's name, a `./` or the checkout's path before it. */
function repoPath(file: string, repo: string, dir: string | undefined, known: ReadonlyMap<string, unknown>): string {
  let f = file.trim().replace(/\\/g, '/');
  if (dir && f.startsWith(`${dir.replace(/\\/g, '/')}/`)) f = f.slice(dir.length + 1);
  f = f.replace(/^\.\//, '');
  // Reviewers are told to leave the repo's name out; one that did not meant the repo, unless the diff has the path so.
  if (!known.has(f) && f.startsWith(`${repo}/`)) f = f.slice(repo.length + 1);
  return f;
}

/** Lines that credit an AI, left out where `forbid` says so (`policy.forbidAiAttribution`): the human posts the review. */
const clean = (text: string, forbid: boolean): string => (forbid ? text.split('\n').filter((l) => !AI_CREDIT.test(l)).join('\n') : text).trim();

const SEVERITY_LABEL: Record<Finding['severity'], string> = { blocker: 'Blocker', major: 'Major', minor: 'Minor' };

/** A finding as a comment on its line: severity, problem, the fix. */
function commentBody(f: Finding, forbid: boolean): string {
  return clean(`**${SEVERITY_LABEL[f.severity]}:** ${f.problem}${f.fix ? `\n\n**Fix:** ${f.fix}` : ''}`, forbid);
}

/** A finding in the summary's list, with where it is. */
function listItem(f: Finding, forbid: boolean, path?: string): string {
  const where = path ? `\`${path}${f.line ? `:${f.line}` : ''}\` ` : '';
  return clean(`- **${SEVERITY_LABEL[f.severity]}** ${where}${f.problem.replace(/\s*\n+\s*/g, ' ')}${f.fix ? ` → ${f.fix.replace(/\s*\n+\s*/g, ' ')}` : ''}`, forbid);
}

const ORDER: Record<Finding['severity'], number> = { blocker: 0, major: 1, minor: 2 };
const VERDICT: Record<RecordedVerdict['status'], string> = { approved: 'no blocking findings', changes_requested: 'changes requested' };

interface PlaceArgs {
  verdicts: readonly RecordedVerdict[];
  summaries: readonly ReviewerSummary[];
  /** The PR's diff, as the reviewers read it. */
  diff: string;
  /** The workspace's repo the PR is on, and where it was checked out. */
  repo: string;
  dir?: string | undefined;
  forbidAttribution?: boolean;
}

/**
 * What the review posts: a finding on a line in the diff is a comment there (the first of several on the same line
 * keeps it, the others join it); every other one is listed in the summary, the most severe first.
 */
function reviewPost({ verdicts, summaries, diff, repo, dir, forbidAttribution = false }: PlaceArgs): ReviewPost {
  const lines = changedLines(diff);
  const findings = verdicts.flatMap((v) => v.findings).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const inline: InlineComment[] = [];
  const rest: { f: Finding; path?: string }[] = [];
  for (const f of findings) {
    const path = f.file ? repoPath(f.file, repo, dir, lines) : undefined;
    const onLine = path !== undefined && f.line !== undefined && Boolean(lines.get(path)?.has(f.line));
    if (!onLine) {
      rest.push({ f, ...(path && { path }) });
      continue;
    }
    const same = inline.find((c) => c.path === path && c.line === f.line);
    if (same) same.body = `${same.body}\n\n---\n\n${commentBody(f, forbidAttribution)}`;
    else inline.push({ path: path!, line: f.line!, body: commentBody(f, forbidAttribution) });
  }
  const summary = (missed: InlineComment[]): string => {
    const head = summaries.map((s) => clean(`**${s.agent}** (${VERDICT[s.status]}): ${s.summary}`, forbidAttribution)).join('\n\n');
    const listed = rest.map(({ f, path }) => listItem(f, forbidAttribution, path));
    const placed = inline.length - missed.length;
    const parts = [
      '## Review',
      head || '_No summary._',
      ...(placed > 0 ? [`${placed} comment${placed === 1 ? '' : 's'} on the changed lines.`] : []),
      ...(listed.length ? ['### Findings', listed.join('\n')] : []),
      ...(missed.length ? ['### On lines that could not take a comment', missed.map((c) => `- \`${c.path}:${c.line}\` ${c.body.replace(/\s*\n+\s*/g, ' ')}`).join('\n')] : []),
    ];
    return `${parts.join('\n\n')}\n`;
  };
  return { inline, summary };
}

/** What you read before it goes: where each comment lands, then the summary as it would be posted. */
function postPreview(post: ReviewPost, url: string): string {
  const onLines = post.inline.length ? ['### On the changed lines', ...post.inline.map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body}`)].join('\n\n') : '';
  return [`Posted to ${url} as you choose, not before.`, onLines, '### The summary comment', post.summary([])].filter(Boolean).join('\n\n');
}

export type { InlineComment, ReviewerSummary, ReviewPost };
export { changedLines, reviewPost, postPreview };
