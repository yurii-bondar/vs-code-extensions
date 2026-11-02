// "Fix in chat": a failure the task screen shows (a hook that rejected the commit, red checks, an agent that failed,
// an error the run ended with) handed to an interactive Claude Code session, with what it needs to find the cause.
import * as path from 'path';
import type { Checkpoint, CheckpointId, Effort } from './types';
import type { FixSource } from './wire';

interface FixProblem {
  source: FixSource;
  /** What stopped the task, in a few words. */
  what: string;
  /** What to retry in Claudestrator once it is fixed. */
  retry: string;
  /** What it reported: a hook's or the checks' output, an agent's failure, the error. */
  text: string;
  /** The step it stopped at. */
  step?: { agent: string; repo?: string };
}

/** The checkpoints a fix by hand gets past: the others are decisions (a plan, a push, one more review round). */
const FIXABLE: Partial<Record<CheckpointId, { what: string; retry: string }>> = {
  'hook-failure': { what: 'a git hook rejected the commit', retry: 'the commit' },
  'gate-failure': { what: "the repo's checks failed", retry: 'the checks' },
  'agent-failure': { what: 'an agent failed', retry: 'the step' },
};

/** Errors a chat cannot fix: another run holds the task, or a sign-in is missing (the chat would need it too). */
const NOT_FIXABLE = new Set(['busy', 'claude_login', 'atlassian_not_configured', 'atlassian_auth']);

interface ProblemArgs {
  status: string;
  error: { code?: string | undefined; message?: string | undefined; blocked?: { repo: string; problem: string; files?: string[] | undefined }[] | undefined } | null | undefined;
  checkpoint: Pick<Checkpoint, 'id' | 'step' | 'reason'> | null;
  /** The checkpoint's output, as its screen shows it. */
  checkpointText: string;
}

/** Whether the task waits at a checkpoint whose failure a chat can fix: then its output is worth reading. */
const fixableCheckpoint = (cp: Pick<Checkpoint, 'id'> | null): boolean => Boolean(cp && FIXABLE[cp.id]);

/** The failure on the task screen a chat can fix, or null: the question the task waits at first, then a failed run. */
function fixProblem({ status, error, checkpoint, checkpointText }: ProblemArgs): FixProblem | null {
  const cp = checkpoint && FIXABLE[checkpoint.id];
  if (checkpoint && cp) {
    const text = checkpointText.trim() || (checkpoint.reason ?? '').trim();
    if (!text) return null;
    return { source: 'checkpoint', ...cp, text, ...(checkpoint.step && { step: { agent: checkpoint.step.agent, ...(checkpoint.step.repo && { repo: checkpoint.step.repo }) } }) };
  }
  if (status !== 'failed' || !error || (error.code && NOT_FIXABLE.has(error.code))) return null;
  const blocked = (error.blocked ?? []).map((b) => `${b.repo}: ${b.problem}${b.files && b.files.length ? `\n  ${b.files.join('\n  ')}` : ''}`);
  const text = [error.message ?? '', ...blocked].join('\n').trim();
  return text ? { source: 'error', what: 'the run failed', retry: 'the task', text } : null;
}

/** The most of a failure's output the prompt carries: it goes on a command line, and Windows allows 32k characters. */
const MAX_TEXT = 12000;

/** Without terminal colours and NULs (no command line takes one); a long output keeps its start and its end. */
function clip(text: string, max = MAX_TEXT): string {
  // eslint-disable-next-line no-control-regex -- terminal colour codes are what is removed
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\0/g, '');
  if (clean.length <= max) return clean;
  const head = Math.round(max * 0.75);
  const tail = max - head;
  return `${clean.slice(0, head)}\n[… ${clean.length - max} characters cut …]\n${clean.slice(-tail)}`;
}

interface FixRepo {
  name: string;
  dir: string;
}

/**
 * Where the chat starts: the repo the failure is in (its step's, or the one a hook's output starts with, `api: …`),
 * the only repo of the task, or the workspace. The other repos are added with `--add-dir`.
 */
function fixDirs({ root, repos, problem }: { root: string; repos: FixRepo[]; problem: FixProblem }): { cwd: string; addDirs: string[] } {
  const named = problem.step?.repo ?? repos.find((r) => problem.text.startsWith(`${r.name}:`))?.name;
  const home = repos.find((r) => r.name === named) ?? (repos.length === 1 ? repos[0] : undefined);
  const cwd = home ? home.dir : root;
  const inside = (dir: string): boolean => {
    const rel = path.relative(cwd, dir);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  return { cwd, addDirs: [...new Set(repos.map((r) => r.dir).filter((d) => !inside(d)))] };
}

interface PromptArgs {
  taskId: string;
  title: string;
  branch: string | null;
  repos: FixRepo[];
  taskDir: string;
  problem: FixProblem;
}

/** What the chat starts with: the failure, where it happened, and what not to do (Claudestrator commits and pushes). */
function fixPrompt({ taskId, title, branch, repos, taskDir, problem }: PromptArgs): string {
  const lines = [`Claudestrator task ${taskId} ("${title}") stopped: ${problem.what}.`, ''];
  if (problem.step) lines.push(`Step: ${problem.step.agent}${problem.step.repo ? ` in ${problem.step.repo}` : ''}`);
  if (branch) lines.push(`Task branch: ${branch}`);
  if (repos.length) lines.push('Repos:', ...repos.map((r) => `- ${r.name}: ${r.dir}`));
  lines.push(`Task folder (ticket, plan, agents' reports, events.ndjson): ${taskDir}`, '', 'What it reported:', '```', clip(problem.text), '```', '');
  lines.push(
    `Find the cause and fix it. I retry ${problem.retry} in Claudestrator afterwards, so:`,
    "- do not commit, push or open a PR: Claudestrator commits and pushes the task's work itself;",
    branch ? `- leave every repo on ${branch}, unless getting back to it is the fix;` : '- do not switch branches;',
    '- if the cause is outside the code (a setting, a permission, the sandbox, a tool that is missing), tell me what to change rather than work around it.'
  );
  return lines.join('\n');
}

/** A model as `claude --model` takes it: an alias (`opus`, `opus[1m]`) or a full id; never something read as an option. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

/** `claude`'s arguments: the prompt first (`--add-dir` takes every word after it), then the model and effort chosen. */
function fixArgs({ prompt, model, effort, addDirs }: { prompt: string; model?: string | undefined; effort?: Effort | undefined; addDirs: string[] }): string[] {
  return [prompt, ...(model && model !== 'inherit' ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(addDirs.length ? ['--add-dir', ...addDirs] : [])];
}

export type { FixProblem };
export { fixProblem, fixableCheckpoint, fixDirs, fixPrompt, fixArgs, clip, MODEL_ID };
