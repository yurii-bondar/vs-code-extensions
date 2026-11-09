// Commit subject, PR title and PR body. No AI attribution: the policy may forbid it, and the human owns the PR.
import * as fs from 'fs';
import * as path from 'path';
import { AI_CREDIT } from './guard';
import type { TaskState } from './types';

interface PrLabels {
  what: string;
  why: string;
  repos: string;
  related: string;
  gates: string;
  findings: string;
  none: string;
  failed: string;
}

const UK: PrLabels = { what: 'Що', why: 'Навіщо', repos: 'Порядок мерджу', related: "Пов'язані PR", gates: 'Гейти', findings: "Нотатки рев'ю", none: 'немає', failed: 'червоні, відправлено за рішенням людини' };
const EN: PrLabels = { what: 'What', why: 'Why', repos: 'Merge order', related: 'Related PRs', gates: 'Gates', findings: 'Review notes', none: 'none', failed: "red, shipped by a human's decision" };

/** The first section of the plan's Markdown (its summary, every line of it), for the PR body. */
async function planSummary(taskDir: string, state: TaskState): Promise<string> {
  const plans = state.artifacts.filter((a) => a.output === 'plan');
  const plan = plans[plans.length - 1];
  if (!plan) return '';
  try {
    const text = await fs.promises.readFile(path.join(taskDir, plan.path), 'utf8');
    const m = text.match(/(?:^|\n)##\s+[^\n]+\n+([\s\S]*?)(?=\n##\s|\n```json|$)/);
    return ((m && m[1]) || '').trim();
  } catch {
    return '';
  }
}

/** Text without the lines that credit an AI (`Co-Authored-By: Claude`, "Generated with …"), for `policy.forbidAiAttribution`. */
const withoutAttribution = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !AI_CREDIT.test(line))
    .join('\n');

/**
 * The plan's title on one line: it is the agent's text, and a line break in a commit subject would let it write the
 * commit's body and trailers (a Co-Authored-By the policy forbids).
 */
function planTitle(state: TaskState, forbidAttribution: boolean): string {
  const slug = state.plan!.slug.replace(/-/g, ' ');
  const title = state.plan!.title || slug;
  return (forbidAttribution ? withoutAttribution(title) : title).replace(/\s+/g, ' ').trim() || slug;
}
const commitSubject = (state: TaskState, forbidAttribution = false): string => `${state.plan!.type}: ${planTitle(state, forbidAttribution)}`;
/** A Jira or Linear task's PR title ends with its key, which links the PR to the issue there (`… (CP-12)`). */
const prTitle = (state: TaskState, forbidAttribution = false): string => `${state.plan!.type}: ${planTitle(state, forbidAttribution)}${state.source.kind === 'jira' || state.source.kind === 'linear' ? ` (${state.taskId})` : ''}`;

interface PrBodyArgs {
  state: TaskState;
  repo: string;
  taskDir: string;
  language: string;
  /** The PRs opened so far, by repo: each body lists the others. */
  prs?: Record<string, string>;
  /** `policy.forbidAiAttribution`: what the agents wrote (plan, findings) goes in without lines crediting an AI. */
  forbidAttribution?: boolean;
  /** `Closes #12` (or `Refs …`): ties the PR to the task's issue on the same forge. */
  issueLine?: string;
}

/** GitHub refuses a PR body over 65,536 characters; a plan or a list of findings can be longer. */
const MAX_BODY = 60000;
const MAX_SUMMARY = 20000;
const MAX_FINDINGS = 50;

async function prBody({ state, repo, taskDir, language, prs = {}, forbidAttribution = false, issueLine }: PrBodyArgs): Promise<string> {
  const t = /ukrain|україн/i.test(language) ? UK : EN;
  const link = state.spec && state.spec.links[0];
  const order = state.repos.map((r, i) => `${i + 1}. ${r.name === repo ? `**${r.name}** ←` : r.name}`).join('\n');
  const related = Object.entries(prs).filter(([r]) => r !== repo).map(([r, url]) => `- ${r}: ${url}`).join('\n') || `_${t.none}_`;
  // A step across all repos (the tester) left its checks red in some of them; each PR mentions it.
  const failed = state.gateFailures.filter((g) => !g.repo || g.repo === repo);
  const findings = state.review.openFindings.filter((f) => !f.repo || f.repo === repo);
  const summary = (await planSummary(taskDir, state)) || (state.spec && state.spec.title) || '';
  const listed = findings.slice(0, MAX_FINDINGS).map((f) => `- [${f.severity}] ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : ''}${f.problem}${f.fix ? ` → ${f.fix}` : ''}`);
  if (findings.length > MAX_FINDINGS) listed.push(`- … ${findings.length - MAX_FINDINGS} more in the task's review`);
  const body = [
    `## ${t.what}`,
    summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY)}\n\n…` : summary,
    `## ${t.why}`,
    [link ? `[${link.title}](${link.url})` : (state.spec && state.spec.title) || state.input, issueLine].filter(Boolean).join('\n\n'),
    `## ${t.gates}`,
    failed.length ? failed.map((g) => `- ${g.agent}: ${t.failed}`).join('\n') : `_${t.none}_`,
    `## ${t.findings}`,
    listed.length ? listed.join('\n') : `_${t.none}_`,
    `## ${t.related}`,
    related,
    `## ${t.repos}`,
    order,
    '',
  ].join('\n\n');
  const out = forbidAttribution ? withoutAttribution(body) : body;
  return out.length > MAX_BODY ? `${out.slice(0, MAX_BODY)}\n\n…` : out;
}

export type { PrBodyArgs };
export { commitSubject, prTitle, prBody, planSummary };
