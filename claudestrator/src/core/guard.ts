// The Bash guard. Commands are split into simple commands and tokenized, so words inside quotes,
// comments or heredoc bodies never trigger a rule, and `bash -c` / `$(…)` are checked inside.
import * as os from 'os';
import * as path from 'path';
import { tokenize } from './intake';
import type { Policy } from './types';

type Verdict = { allow: true } | { allow: false; reason: string };

/** What the guard knows about the call: the policy, where it runs, and how to look at git and files. */
interface GuardContext {
  policy: Policy;
  cwd: string;
  workspace: string;
  home?: string | undefined;
  task?: { taskId: string; canPush: boolean } | undefined;
  agent?: boolean | undefined;
  repoDirs?: string[] | undefined;
  branchOf(dir: string): string | null;
  isRepoRoot(dir: string): boolean;
  readFile(file: string): string | null;
}

const allow: Verdict = { allow: true };
const deny = (reason: string): Verdict => ({ allow: false, reason });

const AI_CREDIT = /co-authored-by:[^\n]*(claude|anthropic|copilot|cursor|openai|codex|gemini)|generated (with|by)[^\n]*(claude|\bai\b)|claude\.com\/claude-code|🤖/i;

/**
 * ctx: { policy, cwd, workspace, home?, task?: { taskId, canPush }, agent?: boolean,
 *        branchOf(dir) → string|null, isRepoRoot(dir) → boolean, readFile(file) → string|null }
 */
function guardBash(command: string, ctx: GuardContext): Verdict {
  let dir = ctx.cwd;
  for (const segment of simpleCommands(command)) {
    let argv: string[];
    try {
      argv = tokenize(segment);
    } catch {
      argv = segment.trim().split(/\s+/);
    }
    argv = stripPrefixes(argv);
    const [cmd, ...args] = argv;
    if (!cmd) continue;
    if (cmd === 'cd') {
      dir = resolveIn(dir, args[0] ?? '~', ctx);
      continue;
    }
    if (['bash', 'sh', 'zsh'].includes(cmd) && args.includes('-c')) {
      const inner = guardBash(args[args.indexOf('-c') + 1] ?? '', { ...ctx, cwd: dir });
      if (!inner.allow) return inner;
      continue;
    }
    const verdict = cmd === 'git' ? checkGit(args, dir, ctx) : cmd === 'gh' ? checkGh(args, dir, ctx) : cmd === 'rm' ? checkRm(args, dir, ctx) : allow;
    if (!verdict.allow) return verdict;
  }
  return allow;
}

/** Splits on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes; drops heredoc bodies and comments. */
function simpleCommands(command: string): string[] {
  const lines = command.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);
    const heredoc = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (heredoc) {
      const end = heredoc[2];
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== end) i++;
      i++; // the terminator line
    }
  }

  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  const text = kept.join('\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') current += text[++i] ?? '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === '#' && (current === '' || /\s$/.test(current))) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      segments.push(current);
      current = '';
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i++;
    } else if (ch === '(' || ch === ')' || ch === '`') {
      // Subshells and unquoted command substitutions are commands of their own.
      segments.push(current.replace(/\$$/, ''));
      current = '';
    } else current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function stripPrefixes(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) || ['sudo', 'command', 'env', 'time', 'exec', 'nohup'].includes(a)) i++;
    else break;
  }
  return argv.slice(i);
}

function resolveIn(dir: string, p: string, ctx: GuardContext): string {
  const home = ctx.home ?? os.homedir();
  const expanded = p.replace(/^~(?=$|\/)/, home).replace(/^\$\{?HOME\}?(?=$|\/)/, home);
  return path.resolve(dir, expanded);
}

/** Flags of a subcommand, with `--x=y` split and combined short flags (`-rf`) expanded. */
function flagSet(args: string[]): Set<string> {
  const set = new Set<string>();
  for (const a of args) {
    if (a === '--') break;
    if (a.startsWith('--')) set.add(a.split('=')[0]!);
    else if (/^-[A-Za-z]+$/.test(a)) for (const c of a.slice(1)) set.add(`-${c}`);
  }
  return set;
}

function optionValues(args: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n && args[i + 1] !== undefined) out.push(args[i + 1]!);
      else if (a.startsWith(`${n}=`)) out.push(a.slice(n.length + 1));
    }
  }
  return out;
}

function attributionIn(texts: string[], files: string[], dir: string, ctx: GuardContext): Verdict {
  if (!ctx.policy.forbidAiAttribution) return allow;
  if (texts.some((t) => AI_CREDIT.test(t))) return deny('no AI attribution in commits or PRs (policy.forbidAiAttribution); remove the Co-Authored-By / Generated-with lines');
  for (const f of files) {
    if (f === '-') continue;
    const content = ctx.readFile(path.resolve(dir, f));
    if (content && AI_CREDIT.test(content)) return deny(`no AI attribution in ${f} (policy.forbidAiAttribution)`);
  }
  return allow;
}

/** Git subcommands that change refs, the index or discard work: never an agent's business. */
const AGENT_GIT_WRITES = new Set<string>([
  'commit', 'push', 'pull', 'stash', 'reset', 'rebase', 'merge', 'switch', 'checkout', 'restore', 'cherry-pick',
  'revert', 'am', 'tag', 'worktree', 'clean', 'rm', 'mv', 'update-ref', 'filter-branch', 'filter-repo', 'notes', 'gc', 'prune',
]);

function checkGit(all: string[], cwd: string, ctx: GuardContext): Verdict {
  let dir = cwd;
  let i = 0;
  while (i < all.length && all[i]!.startsWith('-')) {
    const opt = all[i];
    if (opt === '-C') {
      dir = resolveIn(dir, all[i + 1] ?? '.', ctx);
      i += 2;
    } else if (opt === '-c' || opt === '--git-dir' || opt === '--work-tree') i += 2;
    else i++;
  }
  const [sub, ...args] = all.slice(i);
  const flags = flagSet(args);
  const protectedBranches = ctx.policy.protectedBranches;

  if (ctx.agent && sub && AGENT_GIT_WRITES.has(sub)) return deny(`agents do not run git ${sub}; Claudestrator owns git (commits, branches, pushes)`);
  if (ctx.agent && sub === 'branch' && args.some((a) => !a.startsWith('-') || ['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy'].includes(a))) {
    return deny('agents do not create, rename or delete branches; Claudestrator owns git');
  }

  if (!ctx.policy.allowNoVerify && sub !== undefined && ['commit', 'push', 'merge', 'am'].includes(sub) && (flags.has('--no-verify') || (sub === 'commit' && flags.has('-n')))) {
    return deny('skipping git hooks is not allowed; the hooks are part of the gates (policy.allowNoVerify)');
  }

  switch (sub) {
    case 'push': {
      if (['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror'].some((f) => flags.has(f))) return deny('force-push is not allowed; do it by hand if it is really needed');
      if (flags.has('--delete') || flags.has('-d')) return deny('deleting remote branches is not allowed');
      const positional = args.filter((a) => !a.startsWith('-'));
      const refspecs = positional.slice(1);
      if (refspecs.some((r) => r.startsWith('+'))) return deny('forced refspecs (+branch) are not allowed');
      if (refspecs.some((r) => r.startsWith(':'))) return deny('deleting remote branches is not allowed');
      const targets = refspecs.map((r) => r.split(':').pop()!.replace(/^refs\/heads\//, ''));
      if (refspecs.length === 0) {
        const b = ctx.branchOf(dir);
        if (b) targets.push(b);
      }
      const hit = targets.find((t) => protectedBranches.includes(t) || (t === 'HEAD' && protectedBranches.includes(ctx.branchOf(dir) ?? '')));
      if (hit) return deny(`pushing to ${hit === 'HEAD' ? ctx.branchOf(dir) : hit} is not allowed; push the feature branch`);
      if (ctx.task && !ctx.task.canPush) return deny(`task ${ctx.task.taskId} has not reached publish: push only after the user confirms it`);
      return allow;
    }
    case 'commit': {
      const b = ctx.branchOf(dir);
      if (b && protectedBranches.includes(b)) return deny(`refusing to commit on ${b} in ${dir}; create the task branch first`);
      return attributionIn(optionValues(args, ['-m', '--message']), optionValues(args, ['-F', '--file']), dir, ctx);
    }
    case 'branch':
      if (ctx.task && (flags.has('-D') || (flags.has('-d') && flags.has('--force')))) return deny('force-deleting branches is not allowed during a task');
      return allow;
  }

  if (!ctx.task) return allow;
  if (sub === 'reset' && flags.has('--hard')) return deny('git reset --hard would discard work; not allowed during a task');
  if (sub === 'clean' && (flags.has('-f') || flags.has('--force'))) return deny('git clean would delete untracked files; not allowed during a task');
  if (sub === 'worktree' && args[0] === 'remove' && (flags.has('--force') || flags.has('-f'))) return deny('force-removing a worktree would discard its work; not allowed during a task');
  if (sub === 'stash' && !['list', 'show'].includes(args[0] ?? '')) return deny('git stash is not allowed during a task; the orchestrator never hides your work');
  if ((sub === 'checkout' || sub === 'restore') && args.includes('.') && !flags.has('--staged')) return deny(`git ${sub} . would discard changes; not allowed during a task`);
  return allow;
}

/** gh actions an agent may use, for reading only. */
const AGENT_GH_READ = new Set<string>(['view', 'list', 'diff', 'checks', 'status']);

function checkGh(all: string[], dir: string, ctx: GuardContext): Verdict {
  const [group, action, ...args] = all;
  if (ctx.agent && group !== 'api' && !AGENT_GH_READ.has(action ?? '')) return deny(`agents only read with gh (view, list, diff, checks, status); gh ${group} ${action ?? ''} is the orchestrator's`);
  if (ctx.agent && group === 'api' && all.some((a) => /^-X$|^--method$/.test(a))) {
    const method = (all[all.findIndex((a) => /^-X$|^--method$/.test(a)) + 1] || '').toUpperCase();
    if (method && method !== 'GET') return deny('agents only read with gh api (GET)');
  }
  if (group === 'pr' && action === 'merge') return deny('merging PRs is for humans');
  if (group === 'api' && all.some((a) => /\/merges?(\b|$)/.test(a) && a.includes('/'))) return deny('merging PRs is for humans');
  if (group === 'repo' && ['delete', 'edit', 'archive', 'rename'].includes(action ?? '')) return deny('repository settings are out of scope');
  if (group === 'pr' && (action === 'create' || action === 'edit')) {
    if (action === 'create') {
      const flags = flagSet(args);
      if (ctx.policy.draftPrsOnly && !flags.has('--draft') && !flags.has('-d')) return deny('PRs are opened as drafts only: add --draft (policy.draftPrsOnly)');
      if (ctx.task && !ctx.task.canPush) return deny(`task ${ctx.task.taskId} has not reached publish: open PRs only after the user confirms the push`);
    }
    return attributionIn(optionValues(args, ['--body', '-b', '--title', '-t']), optionValues(args, ['--body-file', '-F']), dir, ctx);
  }
  return allow;
}

function checkRm(args: string[], dir: string, ctx: GuardContext): Verdict {
  const flags = flagSet(args);
  const recursive = flags.has('-r') || flags.has('-R') || flags.has('--recursive');
  if (!recursive) return allow;
  const home = ctx.home ?? os.homedir();
  const ws = path.resolve(ctx.workspace);
  // Repos configured outside the workspace folder are as much the task's ground as the workspace itself.
  const roots = [ws, ...(ctx.repoDirs || []).map((d) => path.resolve(d))];
  const tmp = path.resolve(os.tmpdir());
  const dashdash = args.indexOf('--');
  const targets = args.filter((a, i) => (dashdash !== -1 && i > dashdash) || (!a.startsWith('-') && (dashdash === -1 || i < dashdash)));

  for (const t of targets) {
    if (/^(\.\/?)?\*$|^\.{1,2}\/?$|^\/\*?$|^~\/?\*?$|^\$\{?HOME\}?\/?\*?$/.test(t)) return deny(`rm -r ${t} is not allowed`);
    const abs = resolveIn(dir, t.replace(/\/\*$/, ''), ctx);
    const inside = (root: string): boolean => abs === root || abs.startsWith(root + path.sep);
    const contains = (root: string): boolean => root === abs || root.startsWith(abs + path.sep);
    if (abs === '/' || abs === home || roots.some(contains)) return deny(`rm -r ${t} would delete ${abs}, which contains the workspace, a repository or your home`);
    const ground = roots.some(inside);
    if (ground && ctx.isRepoRoot(abs)) return deny(`rm -r ${t} would delete the repository ${abs}`);
    if (ground && abs.split(path.sep).includes('.git')) return deny(`rm -r ${t} would delete git metadata`);
    if (!ground && !inside(tmp) && !inside('/tmp') && !inside('/private/tmp')) return deny(`rm -r outside the workspace and its repos (${abs}) is not allowed; ask the user`);
  }
  return allow;
}

export type { GuardContext, Verdict as GuardVerdict };
export { guardBash, simpleCommands };
