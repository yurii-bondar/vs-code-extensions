// The first user message of an agent run, and the report parsing that checks what it hands back.
import * as path from 'path';
import { parsePlanMeta, parseVerdict, parseReadiness, parseAudit } from './protocol';
import type { RunAction } from './machine';
import type { Audit, GroupType, NextMode, Output, ParseResult, PlanMeta, Readiness, TaskState, Verdict } from './types';

/** Outputs whose report ends with a JSON block a program validates. */
const JSON_OUTPUTS = new Set(['plan', 'verdict', 'readiness', 'audit']);

/** Outputs only other agents read (and the next review round), so they stay in English: it costs fewer tokens than most languages. */
const AGENT_ONLY_OUTPUTS = new Set<Output>(['code', 'tests', 'verdict']);

/** The language a stage writes its report in: the task's language when a human reads it, English when only agents do. */
const reportLanguage = (output: Output, language: string): string => (AGENT_ONLY_OUTPUTS.has(output) ? 'English' : language);

const GROUP_TYPE: Record<GroupType, string> = { epic: 'epic', story: 'story', group: 'group of tasks' };

const MODE: Record<NextMode, string> = {
  initial: "initial: do this stage's work for the first time.",
  replan: "replan: start from your previous plan (among the inputs) and change what the user's feedback asks for.",
  retry: 'retry: the previous attempt failed; the feedback says why. Fix that.',
  fix: 'fix: fix the blocker and major findings of the previous review round (among the inputs) and nothing else.',
};

/**
 * `repos`: for task-wide stages, the repositories they may read: `[{ name, dir, role?, baseBranch }]`.
 * `workRepos`: for a stage across the plan's repos (the tester), the ones it works in: `[{ name, dir }]`.
 */
interface PromptRepo {
  name: string;
  dir: string;
  role?: string | undefined;
  baseBranch?: string;
}

interface PromptArgs {
  state: TaskState;
  next: RunAction;
  taskDir: string;
  language: string;
  repoDir?: string | undefined;
  workRepos?: PromptRepo[] | undefined;
  diffPath?: string | undefined;
  repos?: PromptRepo[] | undefined;
}

function buildAgentPrompt({ state, next, taskDir, language, repoDir, workRepos, diffPath, repos }: PromptArgs): string {
  const inputs = next.inputs.map((p) => path.resolve(taskDir, p));
  if (diffPath) inputs.push(diffPath);
  const lines = [
    `You are the \`${next.step.agent}\` stage of Claudestrator task ${state.taskId}${state.spec ? ` (${state.spec.title})` : ''}.`,
    '',
    `Mode: ${MODE[next.mode]}`,
    `Review round: ${next.round}.`,
  ];
  if (state.group) lines.push(`Part of the ${GROUP_TYPE[state.group.type]} "${state.group.label}"${state.group.jira ? ` (Jira ${state.group.jira})` : ''}.`);
  if (next.step.repo) lines.push(`Repository: ${next.step.repo} at ${repoDir}. Work only there.`);
  if (workRepos && workRepos.length) {
    lines.push('', 'Repositories of this task (cover the changes in every one of them; work only there):', ...workRepos.map((r) => `- ${r.name} at ${r.dir}`));
  }
  if (repos && repos.length) {
    lines.push('', 'Repositories (read them where they are; change nothing):', ...repos.map((r) => `- ${r.name} at ${r.dir} (base branch ${r.baseBranch})${r.role ? `: ${r.role}` : ''}`));
  }
  if (state.source && state.source.kind === 'jira' && next.output === 'readiness') {
    lines.push('', `Jira issue: ${state.source.key}. Search branches, commits and PRs for this key.`);
  }
  lines.push('', 'Read these files first, in this order:', ...inputs.map((p) => `- ${p}`));
  // The group's instructions first: they hold for every task in it, the task's own add to them.
  const instructions = [...(state.group && state.group.instructions ? [{ label: `For every task in "${state.group.label}"`, text: state.group.instructions }] : []), ...state.instructions];
  if (instructions.length) {
    lines.push('', "The user's instructions for this task, verbatim. Follow them in this stage's work:");
    for (const x of instructions) lines.push('', `### ${x.label}`, x.text);
  }
  if (next.feedback) lines.push('', 'Feedback from the user, verbatim:', next.feedback);
  lines.push('', `Write your report in ${reportLanguage(next.output, language)}. Code, identifiers and anything a program reads stay in English.`);
  if (JSON_OUTPUTS.has(next.output)) lines.push('End your reply with the fenced ```json block your instructions describe; a program validates it.');
  lines.push('Do not commit, push, stash or switch branches: Claudestrator owns git.', 'Your final message is your report; nothing may follow it.');
  return lines.join('\n');
}

/** The last fenced ```json block of an agent's reply: the part a program reads. */
function lastJsonBlock(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const blocks = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)\n\s*```/g)];
  const body = blocks.length ? blocks[blocks.length - 1]![1] : undefined;
  if (body === undefined) return { ok: false, error: 'the report has no ```json block' };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e) {
    return { ok: false, error: `the report's json block is not valid JSON: ${(e as Error).message}` };
  }
}

const PARSERS: Partial<Record<Output, (raw: unknown) => ParseResult<PlanMeta | Verdict | Readiness | Audit>>> = { plan: parsePlanMeta, verdict: parseVerdict, readiness: parseReadiness, audit: parseAudit };

/** `{ ok: true }` plus the validated value under the name of its output, or why the report is rejected. */
type StageReport = { ok: true; plan?: PlanMeta; verdict?: Verdict; readiness?: Readiness; audit?: Audit } | { ok: false; error: string };

/**
 * Plan, verdict, readiness and audit stages must end with a JSON block matching their schema; code and tests stages need none.
 * Returns `{ ok, [output]: value }`, e.g. `{ ok: true, plan }`.
 */
function parseStageReport(output: Output, text: string): StageReport {
  if (!JSON_OUTPUTS.has(output)) return { ok: true };
  const block = lastJsonBlock(text);
  if (!block.ok) return block;
  const parsed = PARSERS[output]!(block.value);
  if (!parsed.ok) return { ok: false, error: `the ${output} json block does not match the schema: ${parsed.issues.join('; ')}` };
  return { ok: true, [output]: parsed.value } as StageReport;
}

export type { StageReport };
export { buildAgentPrompt, lastJsonBlock, parseStageReport, reportLanguage };
