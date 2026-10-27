// The first user message of an agent run, and the report parsing that checks what it hands back.
const path = require('path');
const { parsePlanMeta, parseVerdict, parseReadiness, parseAudit } = require('./protocol');

/** Outputs whose report ends with a JSON block a program validates. */
const JSON_OUTPUTS = new Set(['plan', 'verdict', 'readiness', 'audit']);

const MODE = {
  initial: "initial: do this stage's work for the first time.",
  replan: "replan: start from your previous plan (among the inputs) and change what the user's feedback asks for.",
  retry: 'retry: the previous attempt failed; the feedback says why. Fix that.',
  fix: 'fix: fix the blocker and major findings of the previous review round (among the inputs) and nothing else.',
};

/** `repos`: for task-wide stages, the repositories they may read: `[{ name, dir, role?, baseBranch }]`. */
function buildAgentPrompt({ state, next, taskDir, language, repoDir, diffPath, repos }) {
  const inputs = next.inputs.map((p) => path.resolve(taskDir, p));
  if (diffPath) inputs.push(diffPath);
  const lines = [
    `You are the \`${next.step.agent}\` stage of Claudestrator task ${state.taskId}${state.spec ? ` (${state.spec.title})` : ''}.`,
    '',
    `Mode: ${MODE[next.mode]}`,
    `Review round: ${next.round}.`,
  ];
  if (next.step.repo) lines.push(`Repository: ${next.step.repo} at ${repoDir}. Work only there.`);
  if (repos && repos.length) {
    lines.push('', 'Repositories (read them where they are; change nothing):', ...repos.map((r) => `- ${r.name} at ${r.dir} (base branch ${r.baseBranch})${r.role ? `: ${r.role}` : ''}`));
  }
  if (state.source && state.source.kind === 'jira' && next.output === 'readiness') {
    lines.push('', `Jira issue: ${state.source.key}. Search branches, commits and PRs for this key.`);
  }
  lines.push('', 'Read these files first, in this order:', ...inputs.map((p) => `- ${p}`));
  if (next.feedback) lines.push('', 'Feedback from the user, verbatim:', next.feedback);
  lines.push('', `Write your report in ${language}. Code, identifiers and anything a program reads stay in English.`);
  if (JSON_OUTPUTS.has(next.output)) lines.push('End your reply with the fenced ```json block your instructions describe; a program validates it.');
  lines.push('Do not commit, push, stash or switch branches: Claudestrator owns git.', 'Your final message is your report; nothing may follow it.');
  return lines.join('\n');
}

/** The last fenced ```json block of an agent's reply: the part a program reads. */
function lastJsonBlock(text) {
  const blocks = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)\n\s*```/g)];
  const body = blocks.length ? blocks[blocks.length - 1][1] : undefined;
  if (body === undefined) return { ok: false, error: 'the report has no ```json block' };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e) {
    return { ok: false, error: `the report's json block is not valid JSON: ${e.message}` };
  }
}

const PARSERS = { plan: parsePlanMeta, verdict: parseVerdict, readiness: parseReadiness, audit: parseAudit };

/**
 * Plan, verdict, readiness and audit stages must end with a JSON block matching their schema; code and tests stages need none.
 * Returns `{ ok, [output]: value }`, e.g. `{ ok: true, plan }`.
 */
function parseStageReport(output, text) {
  if (!JSON_OUTPUTS.has(output)) return { ok: true };
  const block = lastJsonBlock(text);
  if (!block.ok) return block;
  const parsed = PARSERS[output](block.value);
  if (!parsed.ok) return { ok: false, error: `the ${output} json block does not match the schema: ${parsed.issues.join('; ')}` };
  return { ok: true, [output]: parsed.value };
}

module.exports = { buildAgentPrompt, lastJsonBlock, parseStageReport };
