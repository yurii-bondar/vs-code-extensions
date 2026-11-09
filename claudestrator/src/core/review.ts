// A pull request's review, as it goes to the PR: each finding on a line the PR changed becomes a comment there, and
// the rest goes into one summary with the reviewers' verdicts. You may leave any finding out before it goes. Pure: the
// engine reads the diff and the reports, the forges post.
import { AI_CREDIT } from './guard';
import type { Finding, RecordedVerdict } from './types';

/**
 * A comment on a line of the PR's head, by its path in the repo. `oldLine`: the same line's number before the PR, for
 * a line the PR shows but did not change (GitLab names both); `oldPath`: the file's path before the PR renamed it.
 */
interface InlineComment {
  path: string;
  line: number;
  oldLine?: number;
  oldPath?: string;
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

/** A file of the PR's diff: its path before the PR, and its lines after it, each with its number before (null: added). */
interface DiffFile {
  oldPath: string;
  lines: Map<number, number | null>;
}

/**
 * The lines of each file that the PR's head has in its diff (added, or shown around a change): the lines a forge takes
 * a comment on, by the file's path after the PR. From a unified diff: `--- a/<old>`, `+++ b/<new>` and their hunks.
 */
function changedLines(diff: string): Map<string, DiffFile> {
  const out = new Map<string, DiffFile>();
  const unquote = (p: string): string => p.replace(/^"?[ab]\//, '').replace(/"$/, '');
  let file: DiffFile | null = null;
  let oldPath = '';
  let at = 0;
  let was = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('--- ')) {
      oldPath = raw.slice(4).trim() === '/dev/null' ? '' : unquote(raw.slice(4).trim());
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4).trim();
      if (name === '/dev/null') file = null;
      else {
        const path = unquote(name);
        file = out.get(path) ?? { oldPath: oldPath || path, lines: new Map() };
        out.set(path, file);
      }
      continue;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      was = Number(hunk[1]);
      at = Number(hunk[2]);
      continue;
    }
    if (!file || raw.startsWith('diff ') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) file.lines.set(at++, null);
    else if (raw.startsWith(' ')) file.lines.set(at++, was++);
    else if (raw.startsWith('-')) was++;
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

/**
 * A finding where it would go: `id` names it while the task lasts (`<verdict>.<finding>`, in the order the reviewers
 * recorded them), `inline` says it would be a comment on its line, `path` is its file as the repo has it.
 */
interface ReviewItem {
  id: string;
  agent: string;
  finding: Finding;
  path?: string;
  inline: boolean;
  oldLine?: number;
  oldPath?: string;
}

interface PlaceArgs {
  verdicts: readonly RecordedVerdict[];
  /** The PR's diff, as the reviewers read it. */
  diff: string;
  /** The workspace's repo the PR is on, and where it was checked out. */
  repo: string;
  dir?: string | undefined;
}

/** Every finding of the review, the most severe first, each where it would go. */
function placeFindings({ verdicts, diff, repo, dir }: PlaceArgs): ReviewItem[] {
  const files = changedLines(diff);
  const items: ReviewItem[] = [];
  verdicts.forEach((v, vi) =>
    v.findings.forEach((f, fi) => {
      const path = f.file ? repoPath(f.file, repo, dir, files) : undefined;
      const file = path !== undefined ? files.get(path) : undefined;
      const inline = Boolean(file && f.line !== undefined && file.lines.has(f.line));
      const was = inline ? file!.lines.get(f.line!) : null;
      items.push({
        id: `${vi}.${fi}`,
        agent: v.agent,
        finding: f,
        ...(path && { path }),
        inline,
        ...(was !== null && was !== undefined && { oldLine: was }),
        ...(inline && file!.oldPath !== path && { oldPath: file!.oldPath }),
      });
    })
  );
  return items.sort((a, b) => ORDER[a.finding.severity] - ORDER[b.finding.severity]);
}

interface PostArgs extends PlaceArgs {
  summaries: readonly ReviewerSummary[];
  forbidAttribution?: boolean;
  /** Findings you left out (their ids): they go nowhere. */
  omit?: readonly string[];
}

/**
 * What the review posts: a finding on a line in the diff is a comment there (the first of several on the same line
 * keeps it, the others join it); every other one is listed in the summary, the most severe first. What you left out
 * is in neither.
 */
function reviewPost({ summaries, forbidAttribution = false, omit = [], ...place }: PostArgs): ReviewPost {
  const items = placeFindings(place).filter((i) => !omit.includes(i.id));
  const inline: InlineComment[] = [];
  const rest: ReviewItem[] = [];
  for (const item of items) {
    const f = item.finding;
    if (!item.inline) {
      rest.push(item);
      continue;
    }
    const same = inline.find((c) => c.path === item.path && c.line === f.line);
    if (same) same.body = `${same.body}\n\n---\n\n${commentBody(f, forbidAttribution)}`;
    else inline.push({ path: item.path!, line: f.line!, ...(item.oldLine !== undefined && { oldLine: item.oldLine }), ...(item.oldPath && { oldPath: item.oldPath }), body: commentBody(f, forbidAttribution) });
  }
  const summary = (missed: InlineComment[]): string => {
    const head = summaries.map((s) => clean(`**${s.agent}** (${VERDICT[s.status]}): ${s.summary}`, forbidAttribution)).join('\n\n');
    const listed = rest.map((i) => listItem(i.finding, forbidAttribution, i.path));
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

export type { DiffFile, InlineComment, ReviewerSummary, ReviewItem, ReviewPost };
export { changedLines, placeFindings, reviewPost, postPreview };
