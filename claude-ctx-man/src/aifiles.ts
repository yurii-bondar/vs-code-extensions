import * as fs from 'fs';
import * as path from 'path';

/** The AI tools that can share one set of rules and skills. JetBrains AI Assistant is not listed: its folders are the shared source. */
export type Tool = 'claude' | 'cursor' | 'agents';

export type Preset = { kind: 'claude-only' } | { kind: 'several'; tools: readonly Tool[] };

/** One thing to put in the project. Paths are relative to the project root and use `/`. */
export type Step =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; content: string }
  /** `target` is relative to the folder of the link, so the project can be moved or cloned. */
  | { kind: 'link'; path: string; target: string; dir: boolean };

const SHARED_RULES = '.aiassistant/rules';
const SHARED_SKILLS = '.aiassistant/skills';

const link = (from: string, to: string, dir: boolean): Step => ({ kind: 'link', path: from, target: path.posix.relative(path.posix.dirname(from), to), dir });

function instructions(project: string, rules: string, skills: string): string {
  return `# ${project}

What an AI coding assistant needs to know about this project.

## Commands

## Conventions

## Rules and skills

Rules are in \`${rules}\`, skills in \`${skills}\`.
`;
}

/** What the preset puts where: a real file or folder first, the links to it after. */
export function planSteps(preset: Preset, project: string): Step[] {
  if (preset.kind === 'claude-only') {
    return [
      { kind: 'file', path: 'CLAUDE.md', content: instructions(project, '.claude/rules', '.claude/skills') },
      { kind: 'dir', path: '.claude/rules' },
      { kind: 'dir', path: '.claude/skills' },
    ];
  }
  const has = (tool: Tool): boolean => preset.tools.includes(tool);
  const steps: Step[] = [
    { kind: 'dir', path: SHARED_RULES },
    { kind: 'dir', path: SHARED_SKILLS },
  ];
  // AGENTS.md is a link to CLAUDE.md, so it needs the file even when Claude Code is not picked.
  if (has('claude') || has('agents')) steps.push({ kind: 'file', path: 'CLAUDE.md', content: instructions(project, SHARED_RULES, SHARED_SKILLS) });
  if (has('claude')) steps.push(link('.claude/rules', SHARED_RULES, true), link('.claude/skills', SHARED_SKILLS, true));
  if (has('cursor')) steps.push(link('.cursor/rules', SHARED_RULES, true), link('.cursor/skills', SHARED_SKILLS, true));
  if (has('agents')) steps.push(link('AGENTS.md', 'CLAUDE.md', false));
  return steps;
}

/** The path a link points at, relative to the project root: it has to exist for the link to work. */
export function needsOf(step: Step): string | undefined {
  return step.kind === 'link' ? path.posix.normalize(path.posix.join(path.posix.dirname(step.path), step.target)) : undefined;
}

const HINTS: Record<string, string> = {
  'CLAUDE.md': 'Main instructions for the AI',
  'AGENTS.md': 'Read by Codex and other tools; it is CLAUDE.md',
  '.aiassistant/rules': 'Shared rules; JetBrains AI Assistant reads them here',
  '.aiassistant/skills': 'Shared skills',
  '.claude/rules': 'Rules for Claude Code',
  '.claude/skills': 'Skills for Claude Code',
  '.cursor/rules': 'Rules for Cursor',
  '.cursor/skills': 'Skills for Cursor',
};

export const hintFor = (stepPath: string): string => HINTS[stepPath] ?? '';

export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'dir':
      return `${step.path}/`;
    case 'file':
      return step.path;
    case 'link':
      return `${step.path} → ${step.target}`;
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

/** `create`: nothing there. `exists`: already what the step wants. `conflict`: something else is there; it is never touched. */
export type Status = 'create' | 'exists' | 'conflict';

const isKind = (abs: string, kind: 'dir' | 'file'): boolean => {
  try {
    const stat = fs.statSync(abs);
    return kind === 'dir' ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
};

export function inspect(root: string, step: Step): Status {
  const abs = path.join(root, ...step.path.split('/'));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return 'create';
  }
  switch (step.kind) {
    case 'dir':
    case 'file':
      return isKind(abs, step.kind) ? 'exists' : 'conflict';
    case 'link': {
      if (!stat.isSymbolicLink()) return 'conflict';
      const dir = path.dirname(abs);
      return path.resolve(dir, fs.readlinkSync(abs)) === path.resolve(dir, step.target) ? 'exists' : 'conflict';
    }
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

export interface Outcome {
  step: Step;
  /** `skipped`: left out on purpose, or a link whose target was left out and is not there. */
  status: 'created' | 'exists' | 'conflict' | 'failed' | 'skipped';
  /** Why a step failed. */
  error?: string;
}

function create(root: string, step: Step): void {
  const abs = path.join(root, ...step.path.split('/'));
  switch (step.kind) {
    case 'dir':
      fs.mkdirSync(abs, { recursive: true });
      // Git does not keep an empty folder.
      fs.writeFileSync(path.join(abs, '.gitkeep'), '', { flag: 'wx' });
      return;
    case 'file':
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, step.content, { flag: 'wx' });
      return;
    case 'link': {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // A junction needs no privileges on Windows, but wants an absolute target.
      const win = process.platform === 'win32';
      if (step.dir && win) fs.symlinkSync(path.resolve(path.dirname(abs), step.target), abs, 'junction');
      else fs.symlinkSync(step.target, abs, step.dir ? 'dir' : 'file');
      return;
    }
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

/** Does the steps in order, except the ones in `skip`. Anything that is already there is left alone, and a failed step does not stop the rest. */
export function applySteps(root: string, steps: readonly Step[], skip: ReadonlySet<string> = new Set()): Outcome[] {
  const target = (step: Step): Step | undefined => steps.find((s) => s.path === needsOf(step));
  return steps.map((step): Outcome => {
    if (skip.has(step.path)) return { step, status: 'skipped' };
    const need = target(step);
    if (need && skip.has(need.path) && inspect(root, need) !== 'exists') return { step, status: 'skipped' };
    const status = inspect(root, step);
    if (status !== 'create') return { step, status: status === 'exists' ? 'exists' : 'conflict' };
    try {
      create(root, step);
      return { step, status: 'created' };
    } catch (e) {
      return { step, status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  });
}
