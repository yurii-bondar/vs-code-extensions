// Commit subject, PR title and PR body. No AI attribution: the policy may forbid it, and the human owns the PR.
import * as fs from 'fs';
import * as path from 'path';
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

/** The first section of the plan's Markdown (its summary), for the PR body. */
function planSummary(taskDir: string, state: TaskState): string {
  const plans = state.artifacts.filter((a) => a.output === 'plan');
  const plan = plans[plans.length - 1];
  if (!plan) return '';
  try {
    const text = fs.readFileSync(path.join(taskDir, plan.path), 'utf8');
    const m = text.match(/^##\s+[^\n]+\n+([\s\S]*?)(?=\n##\s|\n```json|$)/m);
    return ((m && m[1]) || '').trim();
  } catch {
    return '';
  }
}

const planTitle = (state: TaskState): string => state.plan!.title || state.plan!.slug.replace(/-/g, ' ');
const commitSubject = (state: TaskState): string => `${state.plan!.type}: ${planTitle(state)}`;
const prTitle = (state: TaskState): string => `${state.plan!.type}: ${planTitle(state)}${state.source.kind === 'jira' ? ` (${state.taskId})` : ''}`;

function prBody(state: TaskState, repo: string, taskDir: string, language: string, prs: Record<string, string> = {}): string {
  const t = /ukrain|україн/i.test(language) ? UK : EN;
  const link = state.spec && state.spec.links[0];
  const order = state.repos.map((r, i) => `${i + 1}. ${r.name === repo ? `**${r.name}** ←` : r.name}`).join('\n');
  const related = Object.entries(prs).filter(([r]) => r !== repo).map(([r, url]) => `- ${r}: ${url}`).join('\n') || `_${t.none}_`;
  // A step across all repos (the tester) left its checks red in some of them; each PR mentions it.
  const failed = state.gateFailures.filter((g) => !g.repo || g.repo === repo);
  const findings = state.review.openFindings.filter((f) => !f.repo || f.repo === repo);
  return [
    `## ${t.what}`,
    planSummary(taskDir, state) || (state.spec && state.spec.title) || '',
    `## ${t.why}`,
    link ? `[${link.title}](${link.url})` : (state.spec && state.spec.title) || state.input,
    `## ${t.gates}`,
    failed.length ? failed.map((g) => `- ${g.agent}: ${t.failed}`).join('\n') : `_${t.none}_`,
    `## ${t.findings}`,
    findings.length ? findings.map((f) => `- [${f.severity}] ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : ''}${f.problem}${f.fix ? ` → ${f.fix}` : ''}`).join('\n') : `_${t.none}_`,
    `## ${t.related}`,
    related,
    `## ${t.repos}`,
    order,
    '',
  ].join('\n\n');
}

export { commitSubject, prTitle, prBody, planSummary };
