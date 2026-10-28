// The Bash guard. Commands are split into simple commands and tokenized, so words inside quotes,
// comments or heredoc bodies never trigger a rule, and `bash -c` / `$(…)` / `eval` / `find -exec` are checked inside.
// A command is recognised by its name whatever path it is called by (`/usr/bin/git`), after shell keywords
// (`if`, `then`, `do`, `{`, `!`) and wrappers that run their arguments (`timeout 60`, `nice -n 5`, `env -i`, `xargs`).
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
  /**
   * Where the command may write files (redirections, `tee`, `sed -i`, `cp`, `mv`, `touch`…), besides the temp folders.
   * Empty: a stage that changes nothing. Undefined: not checked (not an agent's stage).
   */
  writeRoots?: string[] | undefined;
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
    const [first, ...args] = argv;
    if (!first) continue;
    const cmd = path.basename(first);
    if (cmd === 'cd') {
      dir = resolveIn(dir, args[0] ?? '~', ctx);
      continue;
    }
    const writes = checkWrites([...redirectTargets(segment), ...writeTargets(cmd, args)], cmd, dir, ctx);
    if (!writes.allow) return writes;
    const verdict = checkCommand(cmd, args, dir, ctx);
    if (!verdict.allow) return verdict;
  }
  return allow;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

/** The files a segment redirects output to (`> f`, `>> f`, `2> f`, `&> f`); `/dev/null` and `>&2` are not files. */
function redirectTargets(segment: string): string[] {
  const out: string[] = [];
  const blanked = unquoted(segment);
  for (const m of blanked.matchAll(/(?:^|[^<>])(?:[0-9]|&)?>>?\|?(?!&)/g)) {
    // The target is read from the real text: in `blanked` a quoted target is only spaces.
    const rest = segment.slice(m.index + m[0].length).trimStart();
    let word: string | undefined;
    try {
      word = tokenize(rest)[0];
    } catch {
      word = rest.split(/\s+/)[0];
    }
    if (word && !/^\/dev\/(null|stdout|stderr|tty)$/.test(word)) out.push(word.replace(/[;&|)]+$/, ''));
  }
  return out;
}

/** Files a command writes by what it is: not what a build or a test run writes on the side. */
function writeTargets(cmd: string, args: string[]): string[] {
  const plain = args.filter((a) => !a.startsWith('-'));
  switch (cmd) {
    case 'tee':
    case 'touch':
    case 'mkdir':
    case 'rmdir':
    case 'truncate':
    case 'rm':
    case 'mv':
    case 'unlink':
    case 'shred':
      return plain;
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync': {
      const t = args.findIndex((a) => a === '-t' || a === '--target-directory');
      return t !== -1 && args[t + 1] ? [args[t + 1]!] : plain.slice(-1);
    }
    case 'chmod':
    case 'chown':
    case 'chgrp':
      return plain.slice(1);
    case 'dd':
      return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
    case 'sed':
    case 'perl': {
      if (!args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))) return [];
      // The files are the plain arguments after the script: the one given with -e/-f, else the first plain one.
      const files: string[] = [];
      let script = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === '-e' || a === '--expression' || a === '-f' || a === '--file') {
          i++;
          script = true;
        } else if (a.startsWith('-')) continue;
        else if (!script) script = true;
        else files.push(a);
      }
      return files;
    }
    default:
      return [];
  }
}

const TEMP_DIRS = (): string[] => [...new Set([path.resolve(os.tmpdir()), '/tmp', '/private/tmp'])];

/** An agent writes only where its stage works (or a temp folder), and never into git metadata. */
function checkWrites(targets: string[], cmd: string, dir: string, ctx: GuardContext): Verdict {
  if (!ctx.writeRoots || !targets.length) return allow;
  const roots = ctx.writeRoots.map((r) => path.resolve(r));
  const within = (abs: string, root: string): boolean => abs === root || abs.startsWith(root + path.sep);
  for (const t of targets) {
    if (/\$(?!\{?HOME\}?(\/|$))|`/.test(t)) return deny(`${cmd} writes to ${t}: spell out the path instead of a variable`);
    const abs = resolveIn(dir, t, ctx);
    if (abs.split(path.sep).includes('.git')) return deny(`${cmd} would write into git metadata (${abs}); Claudestrator owns git`);
    if (TEMP_DIRS().some((tmp) => within(abs, tmp))) continue;
    if (roots.some((root) => within(abs, root))) continue;
    return deny(roots.length ? `${cmd} writes ${abs}, outside ${roots.join(', ')}: this stage works only there` : `${cmd} writes ${abs}: this stage does not change files (a temp folder is fine)`);
  }
  return allow;
}

function checkCommand(cmd: string, args: string[], dir: string, ctx: GuardContext): Verdict {
  const inner = (script: string): Verdict => guardBash(script, { ...ctx, cwd: dir });
  if (SHELLS.has(cmd)) {
    // `-c`, also combined with other flags: `-lc`, `-ec`, `-xc`.
    const c = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    return c === -1 ? allow : inner(args[c + 1] ?? '');
  }
  if (cmd === 'eval') return inner(args.join(' '));
  if (cmd === 'find') return checkFind(args, dir, ctx);
  if (cmd === 'git') return checkGit(args, dir, ctx);
  if (cmd === 'gh') return checkGh(args, dir, ctx);
  if (cmd === 'rm') return checkRm(args, dir, ctx);
  return allow;
}

/** Tests that narrow what `find` matches. */
const FIND_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-regex', '-iregex', '-type', '-newer', '-mtime', '-mmin', '-atime', '-ctime', '-size', '-empty', '-user', '-perm']);

/** `find … -exec cmd {} ;` runs cmd; `find … -delete` is a recursive delete of what it searches. */
function checkFind(args: string[], dir: string, ctx: GuardContext): Verdict {
  for (let i = 0; i < args.length; i++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i]!)) continue;
    const end = args.findIndex((a, j) => j > i && (a === ';' || a === '+' || a === '\\;'));
    const argv = args.slice(i + 1, end === -1 ? undefined : end).filter((a) => a !== '{}' && a !== '\\');
    const [first, ...rest] = stripPrefixes(argv);
    if (!first) continue;
    const verdict = checkCommand(path.basename(first), rest, dir, ctx);
    if (!verdict.allow) return verdict;
  }
  if (args.includes('-delete')) {
    const firstTest = args.findIndex((a) => a.startsWith('-') || a === '!' || a === '(');
    const listed = (firstTest === -1 ? args : args.slice(0, firstTest)).filter(Boolean);
    const roots = listed.length ? listed : ['.'];
    // Without a test (`find dir -delete`) the whole folder goes, as with `rm -r dir`. With one (`-name '*.log'`) only
    // matches inside it do: that folder must be where `rm -r` of something inside it would be allowed.
    const filtered = args.some((a) => FIND_TESTS.has(a));
    if (!filtered) return checkRm(['-r', ...roots], dir, ctx);
    for (const root of roots) {
      const verdict = checkRm(['-r', path.join(resolveIn(dir, root, ctx), 'x')], dir, ctx);
      if (!verdict.allow) return deny(`find ${root} … -delete: ${verdict.reason}`);
    }
  }
  return allow;
}

/** Splits on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes; drops heredoc bodies and comments. */
function simpleCommands(command: string): string[] {
  // A `\` at the end of a line continues the command: `git \⏎ push -f` is one command.
  const lines = command.replace(/\\\r?\n/g, ' ').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);
    const heredoc = unquoted(line).match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (heredoc) {
      const end = heredoc[2];
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== end) i++;
      i++; // the terminator line
    }
  }

  // `$(…)` and `` `…` `` run as commands of their own, inside double quotes too; in the command around them they leave
  // `$SUBST`, a value nobody can check (so `rm -r $(pwd)/..` is refused). A plain `( … )` subshell leaves nothing.
  const segments: string[] = [];
  const stack: { outer: string; quote: string | null; close: string; sub: boolean }[] = [];
  let current = '';
  let quote: string | null = null;
  const open = (close: string, sub: boolean): void => {
    stack.push({ outer: current, quote, close, sub });
    current = '';
    quote = null;
  };
  const text = kept.join('\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const top = stack[stack.length - 1];
    if (top && quote === null && ch === top.close) {
      segments.push(current);
      stack.pop();
      current = top.outer + (top.sub ? '$SUBST' : '');
      quote = top.quote;
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') current += ch + (text[++i] ?? '');
      else if (ch === '`') open('`', true);
      else if (ch === '$' && text[i + 1] === '(') {
        i++;
        open(')', true);
      } else {
        current += ch;
        if (ch === '"') quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === '\\') {
      current += ch + (text[++i] ?? '');
    } else if (ch === '#' && (current === '' || /\s$/.test(current))) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (ch === '`') {
      open('`', true);
    } else if (ch === '$' && text[i + 1] === '(') {
      i++;
      open(')', true);
    } else if (ch === '(') {
      open(')', false);
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === ')') {
      segments.push(current);
      current = '';
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i++;
    } else current += ch;
  }
  segments.push(current);
  // Unclosed substitutions: what was around them is still a command.
  while (stack.length) segments.push(stack.pop()!.outer);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** The line with quoted text blanked out, so `echo "<<EOF"` is not taken for a heredoc. */
function unquoted(line: string): string {
  return line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length));
}

/** Words that come before the command itself: shell keywords. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '}', 'time']);

/**
 * Commands that run the command in their arguments, and the options of theirs that take a value. `positional` is how
 * many plain arguments come before the command (`timeout DURATION cmd`).
 */
const WRAPPERS: Record<string, { valued: string[]; positional?: number }> = {
  sudo: { valued: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U'] },
  command: { valued: [] },
  builtin: { valued: [] },
  exec: { valued: ['-a'] },
  env: { valued: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'] },
  nohup: { valued: [] },
  nice: { valued: ['-n', '--adjustment'] },
  ionice: { valued: ['-c', '-n', '-p', '--class', '--classdata'] },
  timeout: { valued: ['-s', '-k', '--signal', '--kill-after'], positional: 1 },
  stdbuf: { valued: ['-i', '-o', '-e'] },
  xargs: { valued: ['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'] },
  caffeinate: { valued: ['-t', '-w'] },
  chrt: { valued: [], positional: 1 },
  taskset: { valued: [], positional: 1 },
  doas: { valued: ['-u', '-C'] },
};

/** Drops what runs before the command: `VAR=value`, shell keywords, and wrappers with their options. */
function stripPrefixes(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) || KEYWORDS.has(a)) {
      i++;
      continue;
    }
    const wrapper = WRAPPERS[path.basename(a)];
    if (!wrapper) break;
    i++;
    let positional = wrapper.positional ?? 0;
    while (i < argv.length) {
      const opt = argv[i]!;
      if (opt === '--') {
        i++;
        break;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(opt)) i++; // env VAR=value cmd
      else if (opt.startsWith('-')) i += wrapper.valued.includes(opt) ? 2 : 1;
      else if (positional > 0) {
        positional--;
        i++;
      } else break;
    }
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

/** Git's own commands. Anything else is an alias or an add-on, which the guard cannot see into. */
const GIT_COMMANDS = new Set<string>([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore',
  'check-mailmap', 'check-ref-format', 'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'count-objects',
  'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'filter-branch', 'for-each-ref', 'format-patch',
  'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'merge-file',
  'merge-tree', 'mv', 'name-rev', 'notes', 'prune', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack',
  'replace', 'rerere', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref',
  'sparse-checkout', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var',
  'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree', 'lfs',
]);

/** `git config` options that only read. */
const GIT_CONFIG_READS = new Set<string>(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope', '--name-only', 'get', 'list']);

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

  if (ctx.agent) {
    // `-c alias.x=…` or `-c core.hooksPath=…` would change what a later command does.
    if (all.slice(0, i).some((o) => o === '-c' || o === '--config-env' || o.startsWith('--config-env=') || o === '--exec-path' || o.startsWith('--exec-path='))) {
      return deny('agents do not override git config (-c); Claudestrator owns git');
    }
    if (sub && !GIT_COMMANDS.has(sub)) return deny(`git ${sub} is not a git command an agent may run (aliases are not allowed)`);
    if (sub === 'config' && !args.some((a) => GIT_CONFIG_READS.has(a.split('=')[0]!))) return deny('agents only read git config (--get, --list); Claudestrator owns git');
    if (sub === 'remote' && args[0] !== undefined && !['-v', '--verbose', 'show', 'get-url'].includes(args[0])) return deny('agents do not change git remotes');
  }
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
  if (ctx.agent && group === 'api' && ghApiWrites(all)) return deny('agents only read with gh api (GET)');
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

/** Whether a `gh api` call changes something: a method other than GET, or fields / input (which make it a POST). */
function ghApiWrites(all: string[]): boolean {
  let method: string | undefined;
  for (let i = 0; i < all.length; i++) {
    const a = all[i]!;
    if (a === '-X' || a === '--method') method = all[i + 1];
    else if (a.startsWith('--method=')) method = a.slice('--method='.length);
    else if (/^-X[A-Za-z]+$/.test(a)) method = a.slice(2);
  }
  if (method !== undefined) return method.toUpperCase() !== 'GET';
  return all.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF].+/.test(a));
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
    // A variable or command substitution could be anything; its value is not known here.
    if (/\$(?!\{?HOME\}?(\/|$))|`/.test(t)) return deny(`rm -r ${t}: spell out the path instead of a variable`);
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
