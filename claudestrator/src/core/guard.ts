// The Bash guard. Commands are split into simple commands and tokenized, so words inside quotes,
// comments or heredoc bodies never trigger a rule, and `bash -c` / `$(…)` / `eval` / `find -exec` are checked inside.
// A command is recognised by its name whatever path it is called by (`/usr/bin/git`), after shell keywords
// (`if`, `then`, `do`, `{`, `!`) and wrappers that run their arguments (`timeout 60`, `nice -n 5`, `env -i`, `xargs`).
import * as os from 'os';
import * as path from 'path';
import type { Policy } from './types';

type Verdict = { allow: true } | { allow: false; reason: string };

/** Where a command runs: a folder, or null after a `cd` the guard cannot follow (`cd $X`, `cd -`, `popd`, one in a loop). */
type Dir = string | null;

/** A simple command of a command line, and whether it runs only once the command before it succeeded, in its shell (`a && b`). */
interface Segment {
  text: string;
  and: boolean;
}

/**
 * A simple command as the shell runs it: its words without the redirections, the files those write, and the text a
 * here-string feeds it (`bash <<< 'cmd'`), if any.
 */
interface Simple {
  words: string[];
  redirects: string[];
  herestring: string | null;
}

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
  /** What a command never writes, inside the write roots too: Claudestrator's config and task state. */
  protect?: string[] | undefined;
  /**
   * What of the working tree runs outside the sandbox (`Engine.runsOutside`): the hooks folder git runs (husky's
   * `.husky/_`), Claude Code's settings (`.claude/`, `.mcp.json`). Never written, like git metadata.
   */
  runsOutside?: string[] | undefined;
  branchOf(dir: string): Promise<string | null>;
  isRepoRoot(dir: string): Promise<boolean>;
  readFile(file: string): Promise<string | null>;
}

/**
 * Whether a path is in git metadata: a `.git` folder in any case (macOS and Windows file systems ignore it) and with
 * the trailing dots or spaces Windows drops.
 */
const inGitMetadata = (p: string): boolean => p.split(/[\\/]/).some((s) => s.replace(/[. ]+$/, '').toLowerCase() === '.git');

/** A character of a word, and whether a quote or a backslash made it literal (no brace expansion, no pattern). */
interface Ch {
  c: string;
  q: boolean;
}

/** The most words one brace list may become: past it the word stays as written, and a command made of it is refused. */
const MAX_EXPANSION = 1000;

const ANSI_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/** The text of `$'…'` from `i` (just past the opening quote) to its closing quote: `[text, index after it]`. */
function ansiC(line: string, i: number): [string, number] {
  let out = '';
  while (i < line.length && line[i] !== "'") {
    if (line[i] !== '\\') {
      out += line[i++];
      continue;
    }
    const e = line[i + 1] ?? '';
    const hex = e === 'x' ? line.slice(i + 2).match(/^[0-9a-fA-F]{1,2}/) : e === 'u' ? line.slice(i + 2).match(/^[0-9a-fA-F]{1,4}/) : e === 'U' ? line.slice(i + 2).match(/^[0-9a-fA-F]{1,8}/) : null;
    const oct = line.slice(i + 1).match(/^[0-7]{1,3}/);
    if (hex) {
      out += String.fromCodePoint(parseInt(hex[0], 16));
      i += 2 + hex[0].length;
    } else if (oct) {
      out += String.fromCharCode(parseInt(oct[0], 8));
      i += 1 + oct[0].length;
    } else {
      out += ANSI_ESCAPES[e] ?? e;
      i += 2;
    }
  }
  if (i >= line.length) throw new Error("unclosed $' quote");
  return [out, i + 1];
}

/** `{a,b}` and `{1..3}` as the shell expands them, outside quotes; anything else stays as written. */
function expandBraces(w: Ch[]): Ch[][] {
  for (let i = 0; i < w.length; i++) {
    if (w[i]!.q || w[i]!.c !== '{') continue;
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let j = i; j < w.length; j++) {
      const x = w[j]!;
      if (x.q) continue;
      if (x.c === '{') depth++;
      else if (x.c === '}' && --depth === 0) {
        close = j;
        break;
      } else if (x.c === ',' && depth === 1) commas.push(j);
    }
    if (close === -1) return [w];
    const pre = w.slice(0, i);
    const post = w.slice(close + 1);
    let alts: Ch[][] | null = null;
    if (commas.length) {
      const bounds = [i, ...commas, close];
      alts = bounds.slice(0, -1).map((b, k) => w.slice(b + 1, bounds[k + 1]));
    } else {
      const range = w.slice(i + 1, close).map((x) => x.c).join('').match(/^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])$/);
      if (range) {
        const num = /\d/.test(range[1]!);
        const [a, b] = num ? [Number(range[1]), Number(range[2])] : [range[1]!.charCodeAt(0), range[2]!.charCodeAt(0)];
        if (Math.abs(b - a) < MAX_EXPANSION) {
          const step = a <= b ? 1 : -1;
          alts = [];
          for (let n = a; step > 0 ? n <= b : n >= b; n += step) alts.push([...(num ? String(n) : String.fromCharCode(n))].map((c) => ({ c, q: false })));
        }
      }
    }
    if (!alts) continue; // `{}`, `{x}`: as written
    const out = alts.flatMap((alt) => expandBraces([...pre, ...alt, ...post]));
    return out.length > MAX_EXPANSION ? [w] : out;
  }
  return [w];
}

/**
 * Splits a simple command into the words the shell would run: whitespace separates; quotes ('…', "…", $'…') group and
 * go; a backslash makes the next character literal (`\git` is git, `g\it` too); a brace list becomes a word per item
 * (`{git,clean,-fdx}` is three). A variable's value or what a pattern matches is not known here and stays as written.
 */
function tokenize(line: string): string[] {
  const words: Ch[][] = [];
  let cur: Ch[] = [];
  let has = false;
  const push = (c: string, q: boolean): void => {
    for (const ch of c) cur.push({ c: ch, q });
    has = true;
  };
  for (let i = 0; i < line.length; ) {
    const ch = line[i]!;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new Error("unclosed ' quote");
      push(line.slice(i + 1, end), true);
      i = end + 1;
    } else if (ch === '$' && line[i + 1] === "'") {
      const [text, next] = ansiC(line, i + 2);
      push(text, true);
      i = next;
    } else if (ch === '"') {
      let j = i + 1;
      let text = '';
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && '$`"\\\n'.includes(line[j + 1] ?? '')) text += line[++j];
        else text += line[j];
      }
      if (j >= line.length) throw new Error('unclosed " quote');
      push(text, true);
      i = j + 1;
    } else if (ch === '\\') {
      push(line[i + 1] ?? '', true);
      i += 2;
    } else if (/\s/.test(ch)) {
      if (has) words.push(cur);
      cur = [];
      has = false;
      i++;
    } else {
      push(ch, false);
      i++;
    }
  }
  if (has) words.push(cur);
  return words.flatMap(expandBraces).map((w) => w.map((x) => x.c).join(''));
}

const allow: Verdict = { allow: true };
const deny = (reason: string): Verdict => ({ allow: false, reason });

const AI_CREDIT = /co-authored-by:[^\n]*(claude|anthropic|copilot|cursor|openai|codex|gemini)|generated (with|by)[^\n]*(claude|\bai\b)|claude\.com\/claude-code|🤖/i;

/**
 * ctx: { policy, cwd, workspace, home?, task?: { taskId, canPush }, agent?: boolean,
 *        branchOf(dir) → string|null, isRepoRoot(dir) → boolean, readFile(file) → string|null }
 */
async function guardBash(command: string, ctx: GuardContext): Promise<Verdict> {
  return guardIn(command, ctx, ctx.cwd);
}

/** Commands that start a loop: a `cd` in one may run any number of times. */
const LOOPS = new Set(['for', 'while', 'until', 'select']);

/**
 * A command line run from start. A `cd` (`pushd`, `popd`) moves only the commands that run once it succeeded, in its
 * shell (`cd x && …`): after `;`, `||`, a pipe or a subshell they may run where the shell was before (the cd failed or
 * ran elsewhere), so they are checked in every folder the shell may be in by then.
 */
async function guardIn(command: string, ctx: GuardContext, start: Dir): Promise<Verdict> {
  // A folder in CDPATH comes first: `CDPATH=~ cd Documents` is ~/Documents, not ./Documents.
  const cdpath = /(^|\W)CDPATH=/.test(command);
  let here: Dir[] = [start];
  const anywhere = new Set<Dir>(here);
  const pushed: Dir[] = [];
  let loops = 0;
  for (const { text, and } of simpleCommands(command)) {
    const dirs = and ? here : [...anywhere];
    const simple: Simple = { ...withoutRedirects(wordsOf(text)), redirects: redirectTargets(text) };
    for (const w of simple.words) {
      if (LOOPS.has(w)) loops++;
      else if (w === 'done') loops = Math.max(0, loops - 1);
      else if (!KEYWORDS.has(w)) break;
    }
    for (const dir of dirs) {
      const verdict = await checkSimple(simple, dir, ctx);
      if (!verdict.allow) return verdict;
    }
    const [first, ...args] = stripPrefixes(simple.words);
    const cmd = first === undefined ? '' : path.basename(first);
    let next = dirs;
    if (cmd === 'cd' || cmd === 'pushd') {
      let to = cdTarget(cmd, args);
      if (to !== null && cdpath && !/^(\/|~|\$|\.{1,2}(\/|$))/.test(to)) to = null;
      next = loops ? [null] : [...new Set(dirs.map((d) => (to === null ? null : resolveIn(d, to, ctx))))];
      if (cmd === 'pushd') pushed.push(...dirs);
    } else if (cmd === 'popd') {
      // Back to where a pushd left from: any of them, as one that failed pushed nothing.
      next = loops || args.length || !pushed.length ? [null] : [...new Set(pushed)];
    } else if (cmd === 'eval') {
      next = [null]; // a cd in it moves this shell
    }
    here = next;
    for (const d of next) anywhere.add(d);
  }
  return allow;
}

/** The words of a simple command, as the shell splits them (or at whitespace if they do not parse). */
function wordsOf(text: string): string[] {
  try {
    return tokenize(text);
  } catch {
    return text.trim().split(/\s+/);
  }
}

/**
 * The folder `cd` or `pushd` goes to, as written; null for one the guard cannot follow: `cd -` and pushd's stack
 * (`+1`, `-2`), a variable or a substitution, `~-`, `~+` or `~user`, a pattern, zsh's `cd old new`.
 */
function cdTarget(cmd: string, args: string[]): string | null {
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      plain.push(...args.slice(i + 1));
      break;
    }
    if (cmd === 'cd' && /^-[LPe@qs]+$/.test(a)) continue;
    if (/^[-+]/.test(a)) return null;
    plain.push(a);
  }
  if (plain.length > 1) return null;
  // `pushd` alone swaps the top of its stack.
  const to = plain[0] ?? (cmd === 'cd' ? '~' : null);
  if (to === null || /\$(?!\{?HOME\}?(\/|$))|[`*?[]/.test(to) || /^~(?!\/|$)/.test(to)) return null;
  return to;
}

/** What a simple command does in dir: the files it writes or links, and what it runs. */
async function checkSimple(simple: Simple, dir: Dir, ctx: GuardContext): Promise<Verdict> {
  const split = splitPrefixes(simple.words);
  const [first, ...args] = split.argv;
  // A redirection with no command (`> f`, what `x &> f` was split into before) still writes its file.
  if (!first) return checkWrites(simple.redirects, 'a redirection', dir, ctx);
  // One word that is a whole command (`watch "git push"`): the shell splits it again. A path with spaces in its
  // folders (`"/Users/A B/bin/git"`) is still the command its name says.
  if (/\s/.test(path.basename(first))) {
    const writes = checkWrites(simple.redirects, 'a redirection', dir, ctx);
    return writes.allow ? guardIn(split.argv.join(' '), ctx, dir) : writes;
  }
  // A command named by what only the shell knows (`$CMD`, `$(which git)`, a pattern) cannot be checked.
  if (ctx.agent && first !== '[' && first !== '[[' && /[$`*?[\]{}]/.test(first)) return deny(`${first} is not a command the guard can read: spell out its name`);
  const cmd = path.basename(first);
  const env = ctx.agent ? gitEnvRefusal(cmd, split.env, args) : null;
  if (env) return env;
  // xargs and parallel add what they read from input to the command: a recursive delete of paths nobody sees.
  if (split.fed && cmd === 'rm' && recursive(args)) return deny('rm -r of paths xargs or parallel read from input is not allowed: the guard cannot see them; name them, or use find … -exec rm -r {} +');
  const writes = checkWrites([...simple.redirects, ...writeTargets(cmd, args)], cmd, dir, ctx);
  if (!writes.allow) return writes;
  const links = checkLinks(cmd, args, dir, ctx);
  if (!links.allow) return links;
  return checkCommand({ cmd, args, herestring: simple.herestring }, dir, ctx);
}

/** A path the guard cannot place: relative to a folder it lost track of. */
const lost = (what: string): Verdict =>
  deny(`${what}: after a cd the guard cannot follow ($VAR, cd -, popd, a cd in a loop or an eval) it does not know which folder that is; give the whole path, or cd to a path first`);

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
  // `>& file` and `>&file` write file too (stdout and stderr); `>&2` is a descriptor, not a file.
  for (const m of blanked.matchAll(/(?:^|[^<>])[0-9]?>&(?![0-9-]\s|[0-9-]$)/g)) {
    const rest = segment.slice(m.index + m[0].length).trimStart();
    const word = rest.split(/\s+/)[0];
    if (word && !/^[0-9]+$|^-$/.test(word) && !/^\/dev\/(null|stdout|stderr|tty)$/.test(word)) out.push(word.replace(/[;&|)]+$/, ''));
  }
  return out;
}

/** Options that take a value, of the commands that copy, move or link files. */
const COPY_VALUED: Record<string, string[]> = {
  cp: ['-t', '--target-directory', '-S', '--suffix'],
  mv: ['-t', '--target-directory', '-S', '--suffix'],
  ln: ['-t', '--target-directory', '-S', '--suffix'],
  install: ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '--strip-program'],
  rsync: ['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--files-from', '--exclude-from', '--include-from', '--chmod', '--chown', '--log-file', '--backup-dir', '-T', '--temp-dir', '--partial-dir', '--compare-dest', '--copy-dest', '--link-dest', '--suffix', '--rsync-path', '--password-file', '--port', '--bwlimit', '--timeout', '--max-size', '--min-size', '-B', '--block-size', '--out-format', '-M', '--remote-option'],
};

/** The folder of `-t DIR`, `-tDIR`, `-rt DIR`, `--target-directory=DIR`: where cp, mv, ln or install put what they are given. */
function targetDirectory(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return undefined;
    if (a === '--target-directory') return args[i + 1];
    if (a.startsWith('--target-directory=')) return a.slice('--target-directory='.length);
    // In a cluster of short options `t` takes the rest of it, or the next word.
    const t = a.match(/^-[A-Za-z]*?t(.*)$/s);
    if (t) return t[1] || args[i + 1];
  }
  return undefined;
}

/**
 * What cp, mv, ln, install, rsync or ditto write: the destination, and in it each source's name, as a destination
 * that is a folder takes it (`cp -r /tmp/e/.claude .` writes ./.claude), or the folder of `-t`.
 */
function copied(cmd: string, args: string[]): string[] {
  const words = plainWords(args, COPY_VALUED[cmd] ?? []);
  const into = cmd === 'rsync' || cmd === 'ditto' ? undefined : targetDirectory(args);
  // `ln -s ../x` makes ./x.
  if (into === undefined && words.length === 1 && cmd === 'ln') return [path.basename(words[0]!)];
  const dest = into ?? words[words.length - 1];
  if (dest === undefined) return [];
  const sources = into === undefined ? words.slice(0, -1) : words;
  return [dest, ...sources.map((s) => path.join(dest, path.basename(s.replace(/\/+$/, '')) || '.'))];
}

/**
 * Options parsed as a command does: `-o F`, `-oF`, `-sSLo F` (a cluster ends at its first option that takes a value),
 * `--output F`, `--output=F`. `short` holds the letters of the options that take a value, `long` the long ones.
 */
function parseOptions(args: string[], short: string, long: string[]): { values: (...names: string[]) => string[]; flags: Set<string>; plain: string[] } {
  const found: [string, string][] = [];
  const flags = new Set<string>();
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      plain.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) found.push([a.slice(0, eq), a.slice(eq + 1)]);
      else if (long.includes(a)) found.push([a, args[++i] ?? '']);
      else flags.add(a);
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!;
        if (!short.includes(c)) {
          flags.add(`-${c}`);
          continue;
        }
        found.push([`-${c}`, a.slice(j + 1) || (args[++i] ?? '')]);
        break;
      }
    } else plain.push(a);
  }
  return { values: (...names) => found.filter(([n]) => names.includes(n)).map(([, v]) => v), flags, plain };
}

/** The name a download takes from its address: the last part of its path (`https://x/a/pre-commit?y` → pre-commit). */
const urlName = (url: string): string => path.basename(url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/s, ''));

/** A file named by what a server sends (`curl -J`, `wget -r`): nobody can check it before. */
const FROM_SERVER = '$NAME_FROM_SERVER';

const CURL_LONG = ['--output', '--output-dir', '--dump-header', '--cookie-jar', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--libcurl', '--hsts', '--alt-svc', '--config', '--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--form', '--user', '--user-agent', '--referer', '--request', '--proxy', '--max-time', '--connect-timeout', '--retry', '--cookie', '--cacert', '--cert', '--key', '--upload-file', '--write-out', '--range', '--resolve', '--url'];
const WGET_LONG = ['--output-document', '--output-file', '--append-output', '--directory-prefix', '--execute', '--input-file', '--tries', '--timeout', '--wait', '--user-agent', '--header', '--post-data', '--post-file', '--body-data', '--method', '--user', '--password', '--level', '--accept', '--reject', '--domains', '--include-directories', '--exclude-directories', '--base', '--config', '--save-cookies', '--load-cookies', '--rejected-log', '--warc-file', '--quota', '--limit-rate', '--cut-dirs'];
const TAR_LONG = ['--file', '--directory', '--files-from', '--exclude-from', '--blocking-factor', '--format', '--starting-file', '--newer', '--label', '--listed-incremental', '--info-script', '--new-volume-script', '--use-compress-program', '--to-command', '--exclude', '--transform', '--xform', '--owner', '--group', '--mode', '--mtime', '--checkpoint-action', '--index-file', '--rsh-command', '--rmt-command', '--suffix', '--strip-components', '--record-size', '--tape-length', '--volno-file', '--warning', '--sort'];
const PATCH_LONG = ['--prefix', '--directory', '--ifdef', '--fuzz', '--input', '--output', '--strip', '--reject-file', '--version-control', '--basename-prefix', '--suffix', '--get', '--quoting-style', '--read-only'];

/** The files curl writes: -o (in --output-dir), the name -O takes from the address, headers, cookies, traces. */
function curlWrites(args: string[]): string[] {
  const p = parseOptions(args, 'AbcCdDeEFHKmoPQrtTuUwxXyYz', CURL_LONG);
  const [outDir] = p.values('--output-dir');
  const inDir = (f: string): string => (outDir !== undefined && !/^[/~$]/.test(f) ? path.join(outDir, f) : f);
  const files = p.values('-o', '--output').filter((f) => f !== '-').map(inDir);
  if (['-O', '--remote-name', '--remote-name-all'].some((f) => p.flags.has(f))) {
    const fromServer = p.flags.has('-J') || p.flags.has('--remote-header-name');
    files.push(...[...p.plain, ...p.values('--url')].map((u) => (fromServer ? FROM_SERVER : urlName(u))).filter(Boolean).map(inDir));
  }
  return [...files, ...p.values('-D', '--dump-header', '-c', '--cookie-jar', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--libcurl', '--hsts', '--alt-svc').filter((f) => f !== '-')];
}

/** The files wget writes: -O, logs and cookies, else each address's name in -P's folder (-e sets them too). */
function wgetWrites(args: string[]): string[] {
  const p = parseOptions(args, 'OoaPtTwQUeiBDIXARln', WGET_LONG);
  // `-e output_document=~/.zshrc` is -O as a wgetrc command.
  const settings = p.values('-e', '--execute').map((e) => e.match(/^\s*([\w-]+)\s*=\s*(.*)$/s)).filter((m): m is RegExpMatchArray => m !== null);
  const setting = (name: string): string[] => settings.filter((m) => m[1]!.replace(/[_-]/g, '').toLowerCase() === name).map((m) => m[2]!);
  const document = [...p.values('-O', '--output-document'), ...setting('outputdocument')].filter((f) => f !== '-');
  const logs = [...p.values('-o', '--output-file', '-a', '--append-output', '--save-cookies', '--rejected-log'), ...setting('logfile')];
  if (document.length || p.values('-O', '--output-document').length) return [...document, ...logs];
  const prefix = [...p.values('-P', '--directory-prefix'), ...setting('dirprefix')].pop() ?? '.';
  const fromServer = ['-r', '--recursive', '-m', '--mirror', '-p', '--page-requisites', '--content-disposition'].some((f) => p.flags.has(f));
  return [...logs, ...p.plain.map((u) => path.join(prefix, fromServer ? FROM_SERVER : urlName(u) || 'index.html'))];
}

/** tar's short options that take a value. */
const TAR_SHORT = 'fCTXbHKLNVgFI';
/** tar's arguments with the old style spelled out: `tar xzf a.tgz` is `tar -xzf a.tgz`. */
const tarArgs = (args: string[]): string[] => (args[0] && /^[A-Za-z]+$/.test(args[0]) ? [`-${args[0]}`, ...args.slice(1)] : args);

/** What tar writes: the folder it extracts into (anywhere with -P), or the archive it creates or adds to. */
function tarWrites(args: string[]): string[] {
  const p = parseOptions(tarArgs(args), TAR_SHORT, TAR_LONG);
  const has = (...f: string[]): boolean => f.some((x) => p.flags.has(x));
  if (has('-x', '--extract', '--get')) {
    if (has('-P', '--absolute-names')) return ['/'];
    const into = p.values('-C', '--directory');
    return (into.length ? into : ['.']).map((d) => path.join(d, 'x'));
  }
  if (has('-c', '--create', '-r', '--append', '-u', '--update', '-A', '--concatenate', '--catenate', '--delete')) return p.values('-f', '--file').filter((f) => f !== '-');
  return [];
}

/** What patch writes: the file it is given (in -d's folder), -o, the reject file, backups by -B, and what is in -d. */
function patchWrites(args: string[]): string[] {
  const p = parseOptions(args, 'BdDFiopVYzrg', PATCH_LONG);
  const [into] = p.values('-d', '--directory').slice(-1);
  const inDir = (f: string): string => (into !== undefined && !/^[/~$]/.test(f) ? path.join(into, f) : f);
  return [
    ...(into !== undefined ? [path.join(into, 'x')] : []),
    ...p.plain.slice(0, 1),
    ...p.values('-o', '--output', '-r', '--reject-file'),
    ...p.values('-B', '--prefix').map((b) => `${b}x`),
  ]
    .filter((f) => f !== '-')
    .map(inDir);
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
    case 'unlink':
    case 'shred':
    case 'sponge':
      return plain;
    case 'mv':
      return [...plain, ...copied(cmd, args)]; // and what it moves away
    case 'install':
      return flagSet(args).has('-d') ? plain : copied(cmd, args);
    case 'cp':
    case 'ln':
    case 'rsync':
    case 'ditto':
      return [...copied(cmd, args), ...(cmd === 'rsync' ? parseOptions(args, 'T', ['--log-file', '--backup-dir', '--temp-dir', '--partial-dir']).values('--log-file', '--backup-dir', '-T', '--temp-dir', '--partial-dir').map((d) => path.join(d, 'x')) : [])];
    case 'curl':
      return curlWrites(args);
    case 'wget':
      return wgetWrites(args);
    case 'sort':
      return parseOptions(args, 'kotST', ['--output', '--key', '--field-separator', '--buffer-size', '--temporary-directory', '--files0-from', '--batch-size', '--parallel', '--compress-program', '--random-source']).values('-o', '--output');
    case 'shuf':
      return parseOptions(args, 'ino', ['--output', '--input-range', '--head-count', '--random-source']).values('-o', '--output');
    case 'iconv':
      return parseOptions(args, 'fto', ['--output', '--from-code', '--to-code']).values('-o', '--output');
    case 'uniq':
      return plainWords(args, ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars']).slice(1, 2);
    case 'tar':
    case 'bsdtar':
      return tarWrites(args);
    case 'unzip': {
      const p = parseOptions(args, 'dP', []);
      if (['-p', '-l', '-t', '-v', '-Z', '-z'].some((f) => p.flags.has(f))) return [];
      return [path.join(p.values('-d').pop() ?? '.', 'x')];
    }
    case '7z':
    case '7za':
    case '7zz': {
      if (!['x', 'e'].includes(args[0] ?? '')) return [];
      const out = args.find((a) => a.startsWith('-o'));
      return [path.join(out ? out.slice(2) : '.', 'x')];
    }
    case 'patch':
      return patchWrites(args);
    // Each file is replaced by its archive or what it unpacks to, in its folder.
    case 'gzip':
    case 'gunzip':
    case 'bzip2':
    case 'bunzip2':
    case 'xz':
    case 'unxz':
      return ['-c', '--stdout', '--to-stdout', '-t', '--test', '-l', '--list'].some((f) => flagSet(args).has(f)) ? [] : plain;
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

const within = (abs: string, root: string): boolean => abs === root || abs.startsWith(root + path.sep);

/**
 * Paths as the file system compares them: macOS and Windows ignore case by default, so `.CLAUDE/settings.json` is
 * `.claude/settings.json` once written. Folding on a case-sensitive volume there only refuses a little more.
 */
const CASELESS = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p: string): string => (CASELESS ? p.toLowerCase() : p);
const inside = (abs: string, root: string): boolean => within(fold(abs), fold(root));

/**
 * Whether a path is a CLAUDE.local.md, at any depth and in any case (with the trailing dots or spaces Windows drops):
 * instructions the next agent's session loads, and git-ignored, so no diff shows a change.
 */
const localInstructions = (p: string): boolean => path.basename(p).replace(/[. ]+$/, '').toLowerCase() === 'claude.local.md';

/** What a path of `Engine.runsOutside` is: Claude Code's or VS Code's settings, its local instructions, or the hooks folder git runs. */
const outsideLabel = (p: string): string =>
  localInstructions(p)
    ? "Claude Code's local instructions (CLAUDE.local.md) of the repo"
    : /(^|[\\/])(\.claude|\.mcp\.json)$/i.test(p)
      ? "Claude Code's settings and MCP servers of the repo"
      : /(^|[\\/])\.vscode$/i.test(p)
        ? "VS Code's settings and tasks of the repo"
        : 'the hooks folder git runs';

/** Why an agent does not write a CLAUDE.local.md. */
const LOCAL_INSTRUCTIONS = "CLAUDE.local.md holds instructions the next agent's session loads, and it is git-ignored, so no diff shows a change; a change there is yours to make";

/** What a write there would change that is not an agent's: git metadata, or what runs outside the sandbox. Null: none. */
function ownedBy(abs: string, ctx: GuardContext): string | null {
  if (inGitMetadata(abs)) return 'git metadata';
  const root = (ctx.runsOutside || []).find((h) => inside(abs, path.resolve(h)));
  return root ? `${outsideLabel(root)}, which run outside the sandbox` : null;
}

/**
 * For an agent's command that writes the repo's Claude Code or VS Code settings: the way that works. Its Write or Edit
 * tool is refused too, but Claudestrator keeps that change and puts it to the user; a command's is lost.
 */
function settingsWay(abs: string, ctx: GuardContext): string {
  const root = ctx.agent ? (ctx.runsOutside || []).find((h) => inside(abs, path.resolve(h))) : undefined;
  return root && /^\.(claude|mcp\.json|vscode)$/i.test(path.basename(root)) ? '. To change it, use the Write or Edit tool instead: Claudestrator keeps that change and puts it to the user when your step ends' : '';
}

/** An agent writes only where its stage works (or a temp folder), and never into git metadata. */
function checkWrites(targets: string[], cmd: string, dir: Dir, ctx: GuardContext): Verdict {
  if (!ctx.writeRoots || !targets.length) return allow;
  const roots = ctx.writeRoots.map((r) => path.resolve(r));
  for (const t of targets) {
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(t)) continue;
    if (/\$(?!\{?HOME\}?(\/|$))|`/.test(t)) return deny(`${cmd} writes to ${t}: spell out the path instead of a variable`);
    const abs = resolveIn(dir, t, ctx);
    if (abs === null) return lost(`${cmd} writes ${t}`);
    if (localInstructions(abs)) return deny(`${cmd} writes ${abs}: ${LOCAL_INSTRUCTIONS}`);
    const owned = ownedBy(abs, ctx);
    if (owned) return deny(`${cmd} would write into ${owned} (${abs}); Claudestrator owns git${settingsWay(abs, ctx)}`);
    if ((ctx.protect || []).some((p) => inside(abs, path.resolve(p)))) return deny(`${cmd} writes ${abs}: Claudestrator's config and task state are not an agent's to change`);
    if (TEMP_DIRS().some((tmp) => within(abs, tmp))) continue;
    if (roots.some((root) => within(abs, root))) continue;
    return deny(roots.length ? `${cmd} writes ${abs}, outside ${roots.join(', ')}: this stage works only there` : `${cmd} writes ${abs}: this stage does not change files (a temp folder is fine)`);
  }
  return allow;
}

/** What `ln`, `link` and `cp -l`/`cp -s` make links to, where the link goes (undefined: here), and whether it is a symlink. */
function linkedTo(cmd: string, args: string[]): { sources: string[]; at: string | undefined; symbolic: boolean } | null {
  const flags = flagSet(args);
  if (cmd !== 'ln' && cmd !== 'link' && !(cmd === 'cp' && ['-l', '--link', '-s', '--symbolic-link'].some((f) => flags.has(f)))) return null;
  const symbolic = cmd !== 'link' && ['-s', '--symbolic', '--symbolic-link'].some((f) => flags.has(f));
  const plain = plainWords(args, COPY_VALUED.ln!);
  const into = targetDirectory(args);
  if (into !== undefined || plain.length === 1) return { sources: plain, at: into, symbolic };
  return { sources: plain.slice(0, -1), at: plain[plain.length - 1], symbolic };
}

/**
 * An agent links to nothing it may not write: Write and Edit run outside the sandbox, so a write through a link to
 * `.git/config` or Claudestrator's config would land there. Nor to a folder that holds the repository (`ln -s .. up`)
 * or to anything outside where the stage writes (`ln -s ~ h`): a write or an `rm -r h/` through it lands there.
 */
function checkLinks(cmd: string, args: string[], dir: Dir, ctx: GuardContext): Verdict {
  const link = ctx.writeRoots && linkedTo(cmd, args);
  if (!link || !ctx.writeRoots) return allow;
  const at = link.at === undefined ? dir : resolveIn(dir, link.at, ctx);
  if (at === null) return lost(`${cmd} makes a link`);
  const roots = ctx.writeRoots.map((r) => path.resolve(r));
  const kept = [...(ctx.runsOutside || []), ...(ctx.protect || [])].map((p) => path.resolve(p));
  for (const s of link.sources) {
    if (/\$(?!\{?HOME\}?(\/|$))|`/.test(s)) return deny(`${cmd} links to ${s}: spell out the path instead of a variable`);
    // A symlink's target counts from where the link is (`ln -s ../.git/config src/cfg`), a hard link's from here.
    const here = resolveIn(dir, s, ctx);
    if (here === null) return lost(`${cmd} links to ${s}`);
    const fromLink = [resolveIn(at, s, ctx)!, resolveIn(path.dirname(at), s, ctx)!];
    for (const abs of [here, ...fromLink]) {
      if (localInstructions(abs)) return deny(`${cmd} would link to ${abs}: ${LOCAL_INSTRUCTIONS}`);
      const owned = ownedBy(abs, ctx);
      if (owned) return deny(`${cmd} would link to ${owned} (${s}): a write through the link would change it, and Claudestrator owns git`);
      if ((ctx.protect || []).some((p) => inside(abs, path.resolve(p)))) return deny(`${cmd} would link to ${abs}: Claudestrator's config and task state are not an agent's to change`);
    }
    // Where the link really leads: from the folder it is made in (or, made in a folder, from that folder).
    const leads = !link.symbolic ? [here] : link.at === undefined ? [resolveIn(at, s, ctx)!] : fromLink;
    for (const abs of leads) {
      if (roots.some((r) => inside(r, abs)) || kept.some((p) => inside(p, abs))) return deny(`${cmd} would link to ${abs}, which holds the repository or what runs outside the sandbox: a write through the link would land there`);
      if (!roots.some((r) => within(abs, r)) && !TEMP_DIRS().some((t) => within(abs, t))) return deny(`${cmd} would link to ${abs}, outside ${roots.join(', ') || 'what this stage writes'}: a write or an rm -r through the link would land there`);
    }
  }
  return allow;
}

/** A path a shell or `source` reads its commands from that is its input: stdin, a pipe, a process substitution. */
const FROM_INPUT = /^(-|\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/self\/fd\/\d+)$/;

/** A command to judge: its name, its arguments, and the here-string it reads, if any. */
interface Call {
  cmd: string;
  args: string[];
  herestring: string | null;
}

async function checkCommand({ cmd, args, herestring }: Call, dir: Dir, ctx: GuardContext): Promise<Verdict> {
  const inner = (script: string): Promise<Verdict> => guardIn(script, ctx, dir);
  // What a shell or `source` reads on its input the guard never sees (`| bash`, `bash <<EOF`, `source <(…)`), except a
  // here-string, which it reads as the shell would: commands go with -c, in a here-string, or in a file.
  const fromInput = (): Promise<Verdict> => (herestring !== null ? inner(herestring) : Promise.resolve(deny(`${cmd} reading commands from its input is not allowed: pass them with -c, or write them to a script file`)));
  const unreadable = (file: string): boolean => /\$(?!\{?HOME\}?(\/|$))|`/.test(file);
  if (SHELLS.has(cmd)) {
    // `-c`, also combined with other flags: `-lc`, `-ec`, `-xc`.
    const c = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (c !== -1) return inner(args[c + 1] ?? '');
    const file = args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
    if (!ctx.agent || args.some((a) => a === '--version' || a === '--help')) return allow;
    if (!file || args.includes('-s') || FROM_INPUT.test(file)) return fromInput();
    if (unreadable(file)) return deny(`${cmd} ${file}: spell out the script's path`);
    return allow;
  }
  if (cmd === 'source' || cmd === '.') {
    const [file] = args;
    if (!ctx.agent || file === undefined) return allow;
    if (FROM_INPUT.test(file)) return fromInput();
    if (unreadable(file)) return deny(`${cmd} ${file}: spell out the script's path`);
    return allow;
  }
  if (cmd === 'eval') return inner(args.join(' '));
  // `trap 'cmd' EXIT` runs cmd later in this shell, `alias x='cmd'` when x is typed; `trap - INT` and `trap -p` run none.
  if (cmd === 'trap') {
    const rest = args[0] === '--' ? args.slice(1) : args;
    return rest.length >= 2 && !rest[0]!.startsWith('-') ? inner(rest[0]!) : allow;
  }
  if (cmd === 'alias') {
    for (const a of args) {
      const value = a.match(/^[^=\s]+=(.*)$/s)?.[1];
      const verdict = value === undefined ? allow : await inner(value);
      if (!verdict.allow) return verdict;
    }
    return allow;
  }
  if (cmd === 'tmux') return checkTmux(args, dir, ctx);
  if (cmd === 'tar' || cmd === 'bsdtar') {
    // Programs tar runs: on each file, to compress, at a checkpoint, between volumes, to reach a remote tape.
    const p = parseOptions(tarArgs(args), TAR_SHORT, TAR_LONG);
    const scripts = [...p.values('--to-command', '-I', '--use-compress-program', '-F', '--info-script', '--new-volume-script', '--rsh-command', '--rmt-command'), ...p.values('--checkpoint-action').filter((v) => v.startsWith('exec=')).map((v) => v.slice(5))];
    for (const script of scripts) {
      const verdict = await inner(script);
      if (!verdict.allow) return verdict;
    }
  }
  // They run commands later, outside any check.
  if (ctx.agent && ['at', 'batch', 'crontab'].includes(cmd) && !args.includes('-l')) return deny(`agents do not schedule commands (${cmd}): they would run later, unchecked`);
  if (cmd === 'find') return checkFind(args, dir, ctx);
  if (cmd === 'git') return checkGit(args, dir, ctx);
  if (cmd === 'gh') return checkGh(args, dir, ctx);
  if (cmd === 'glab') return checkGlab(args, dir, ctx);
  if (cmd === 'rm') return checkRm(args, dir, ctx);
  // `npm@10`, `yarn@4` (through corepack or npx) are npm and yarn.
  const tool = cmd.replace(/(?<=.)@.*$/, '');
  const run = runs(tool, args);
  if (run) {
    const verdict = await checkSimple({ words: run, redirects: [], herestring }, dir, ctx);
    if (!verdict.allow) return verdict;
  }
  if (ctx.agent && publishes(tool, args)) return deny(`${cmd} ${plainWords(args, VALUED[tool] ?? []).slice(0, 2).join(' ')} publishes a package or an image, or changes one in its registry; releases are for humans`);
  // The keychain holds gh's token and Claude Code's own; the sandbox does not close it. `security` reads it with any
  // option first (-q) or from stdin (-i), and git's credential helpers print what it holds for a host.
  if (ctx.agent && cmd === 'security') return deny('agents do not use the keychain (security)');
  if (ctx.agent && cmd.startsWith('git-credential')) return deny(`agents do not run ${cmd}: it prints stored credentials`);
  return allow;
}

/** tmux commands that run the shell command given after their options. */
const TMUX_RUNS = new Set(['new-session', 'new', 'new-window', 'neww', 'split-window', 'splitw', 'respawn-pane', 'respawnp', 'respawn-window', 'respawnw', 'run-shell', 'run', 'display-popup', 'popup', 'pipe-pane', 'pipep', 'if-shell', 'if']);
/** Options of those that take a value (`-d`, `-h` and `-b` do not in `new -d` and `splitw -h`, the common ones). */
const TMUX_VALUED = ['-c', '-e', '-F', '-n', '-s', '-t', '-x', '-y', '-f', '-l', '-p', '-S', '-T', '-w', '-L'];

/** tmux runs a shell command in a new session or pane, or types one (`send-keys`): the guard checks the first, refuses the second. */
async function checkTmux(args: string[], dir: Dir, ctx: GuardContext): Promise<Verdict> {
  let i = 0;
  for (; i < args.length && args[i]!.startsWith('-'); i++) {
    if (args[i] === '-c') return guardIn(args[i + 1] ?? '', ctx, dir); // tmux -c runs a shell command
    if (['-L', '-S', '-f', '-T'].includes(args[i]!)) i++;
  }
  // Commands are separated by `;` words (`tmux new -d \; send-keys …`).
  const commands: string[][] = [[]];
  for (const a of args.slice(i)) {
    if (a === ';') commands.push([]);
    else commands[commands.length - 1]!.push(a);
  }
  for (const [name, ...rest] of commands) {
    if (ctx.agent && ['send-keys', 'send', 'source-file', 'source', 'command-prompt', 'confirm-before'].includes(name ?? '')) return deny(`tmux ${name} types or runs tmux commands the guard cannot read`);
    if (name === undefined || !TMUX_RUNS.has(name)) continue;
    const words = plainWords(rest, TMUX_VALUED);
    const verdict = await guardIn(name === 'if-shell' || name === 'if' ? (words[0] ?? '') : words.join(' '), ctx, dir);
    if (!verdict.allow) return verdict;
    // if-shell's other words are tmux commands.
    for (const w of name === 'if-shell' || name === 'if' ? words.slice(1) : []) {
      const nested = await checkTmux(wordsOf(w), dir, ctx);
      if (!nested.allow) return nested;
    }
  }
  return allow;
}

/** Per tool, its options that take a value: its subcommand is the first word past them (`npm -w pkg publish`). */
const VALUED: Record<string, string[]> = {
  npm: ['-w', '--workspace', '-C', '--prefix', '--registry', '--tag', '--otp', '--access', '--userconfig', '--globalconfig', '--cache', '--loglevel', '--scope', '-p', '--package', '--include', '--omit'],
  pnpm: ['-C', '--dir', '-F', '--filter', '--filter-prod', '--workspace-dir', '--registry', '--tag', '--otp', '--access', '--reporter', '--loglevel', '--config', '--package'],
  yarn: ['--cwd', '--registry', '--tag', '--otp', '--access', '--include', '--exclude', '--from', '--since', '-j', '--jobs'],
  bun: ['--cwd', '--registry', '--tag', '--otp', '--access', '--config'],
  cargo: ['-Z', '-C', '--config', '--manifest-path', '--color', '-j', '--jobs', '-p', '--package', '--registry', '--index', '--token', '--target', '-F', '--features', '--target-dir'],
  poetry: ['-C', '--directory', '-P', '--project', '-r', '--repository', '-u', '--username', '-p', '--password', '--cert', '--client-cert'],
  uv: ['--directory', '--project', '--python', '-p', '--with', '--from', '--package', '--index', '--index-url', '--extra-index-url', '--cache-dir', '--config-file', '--color', '--env-file', '--extra', '--group'],
  pipx: ['--spec', '--python', '--pip-args', '--index-url'],
  docker: ['-H', '--host', '-c', '--context', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey', '-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory'],
  podman: ['--root', '--runroot', '--storage-driver', '--url', '-c', '--connection', '--log-level', '-f', '--file'],
  buildah: ['--root', '--runroot', '--storage-driver', '--log-level'],
  mvn: ['-f', '--file', '-s', '--settings', '-gs', '--global-settings', '-pl', '--projects', '-rf', '--resume-from', '-P', '--activate-profiles', '-T', '--threads', '-l', '--log-file', '-t', '--toolchains', '-b', '--builder', '-D'],
  gradle: ['-p', '--project-dir', '-x', '--exclude-task', '-b', '--build-file', '-c', '--settings-file', '-g', '--gradle-user-home', '-I', '--init-script', '--console', '--warning-mode', '--max-workers', '-D', '-P'],
};
VALUED.mvnw = VALUED.mvn!;
VALUED.gradlew = VALUED.gradle!;
VALUED.nerdctl = VALUED.docker!;

/** The plain words of a command line, past its options and the values they take. */
function plainWords(args: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return [...out, ...args.slice(i + 1)];
    if (!a.startsWith('-')) out.push(a);
    else if (valued.includes(a)) i++;
  }
  return out;
}

/** Per tool, the subcommands that run the command after them (`npm exec -- npm publish`, `pipx run twine upload`). */
const RUNNERS: Record<string, string[]> = {
  npm: ['exec', 'x'],
  pnpm: ['exec', 'dlx'],
  yarn: ['exec', 'dlx'],
  bun: ['x'],
  pipx: ['run'],
  uv: ['run'],
  poetry: ['run'],
  pdm: ['run'],
  hatch: ['run'],
  pipenv: ['run'],
  rye: ['run'],
  bundle: ['exec'],
  direnv: ['exec'],
};
/** Options of those subcommands that take a value, and those whose value is a command line for a shell. */
const RUNNER_VALUED = ['-p', '--package', '--spec', '--python', '--pip-args', '--with', '--from', '--index-url', '--env-file', '--extra', '--group'];
const RUNNER_SHELL = ['-c', '--call'];

/**
 * The command a tool runs of its arguments: `npm exec -- npm publish`, `pnpm dlx`, `yarn workspace x npm publish`,
 * `pipx run twine upload`, `uv tool run`, `python -m twine upload`. Null when it runs none.
 */
function runs(tool: string, args: string[]): string[] | null {
  if (/^(python|pypy)[\d.]*$|^py$/.test(tool)) return pythonModule(args);
  const words = plainWords(args, VALUED[tool] ?? []);
  const [sub, next] = words;
  if (sub === undefined) return null;
  const k = args.indexOf(sub);
  if (tool === 'yarn' && sub === 'workspace') return ['yarn', ...args.slice(k + 2)];
  if (tool === 'yarn' && sub === 'workspaces' && next === 'foreach') return ['yarn', ...args.slice(args.indexOf('foreach', k) + 1)];
  let rest = tool === 'uv' && sub === 'tool' && next === 'run' ? args.slice(args.indexOf('run', k) + 1) : (RUNNERS[tool] ?? []).includes(sub) ? args.slice(k + 1) : null;
  if (rest === null) return null;
  if (tool === 'direnv') rest = rest.slice(1); // the folder whose .envrc it loads
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') return rest.slice(i + 1);
    const call = a.match(/^(--call)=(.*)$/s);
    if (call || RUNNER_SHELL.includes(a)) return ['sh', '-c', call ? call[2]! : (rest[i + 1] ?? '')];
    if (!a.startsWith('-')) return rest.slice(i);
    if (RUNNER_VALUED.includes(a)) i++;
  }
  return [];
}

/** `python -m twine upload …` runs twine: the module and its arguments; null for a script or `-c`. */
function pythonModule(args: string[]): string[] | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-') || a === '-') return null;
    if (a.startsWith('--')) continue;
    // In `-Im twine` or `-mtwine` the first of c, m, W, X takes the rest of the word, or the next one.
    const at = a.slice(1).search(/[cmWX]/);
    if (at === -1) continue;
    const attached = a.slice(at + 2);
    const value = attached || (args[i + 1] ?? '');
    if (!attached) i++;
    if (a[at + 1] === 'c') return null;
    if (a[at + 1] === 'm') return [value, ...args.slice(i + 1)];
  }
  return null;
}

/** npm's commands that change a registry, always or with one of these actions (pnpm hands them to npm; yarn has most). */
const REGISTRY: Record<string, true | string[]> = {
  publish: true,
  unpublish: true,
  deprecate: true,
  undeprecate: true,
  'dist-tag': ['add', 'rm', 'set'],
  'dist-tags': ['add', 'rm', 'set'],
  tag: ['add', 'rm', 'remove'],
  owner: ['add', 'rm', 'remove'],
  author: ['add', 'rm'],
  access: ['grant', 'revoke', 'set', 'public', 'restricted', '2fa-required', '2fa-not-required', 'edit'],
  team: ['create', 'destroy', 'add', 'rm'],
  org: ['set', 'rm'],
  token: ['create', 'revoke'],
  profile: ['set', 'enable-2fa', 'disable-2fa'],
};
/** npm takes a command by any start of its name no other command shares (`npm pub`): the shortest it takes of these. */
const NPM_ABBREVIATIONS: Record<string, number> = { publish: 2, unpublish: 3, deprecate: 3, undeprecate: 3, 'dist-tag': 3, owner: 2, author: 3, access: 2, team: 3, org: 2, token: 2, profile: 4 };

const changesRegistry = (command: string, action: string): boolean => {
  const r = Object.hasOwn(REGISTRY, command) ? REGISTRY[command] : undefined;
  return r === true || (Array.isArray(r) && r.includes(action));
};

/** Maven goals and phases that upload: deploy, a release, a staging repository, an image jib pushes. */
const mavenUploads = (w: string): boolean => w === 'deploy' || w === 'site-deploy' || w === 'jib:build' || /^(release|deploy|nexus-staging|wagon):/.test(w) || /:(deploy(-file)?|sign-and-deploy-file|push)$/.test(w);
/** Gradle tasks that upload (`publish`, `:lib:publishAllPublicationsToX`, an abbreviation of one), but publishToMavenLocal. */
const gradleUploads = (task: string): boolean => (/^pu/.test(task) && !/ToMavenLocal$/.test(task)) || /^(uploadArchives|artifactoryPublish|bintrayUpload|jib|closeAndRelease\w*|release\w*StagingRepository)$/.test(task);

/** Whether docker, podman or buildah pushes an image: `push`, `image push`, `compose push`, `build --push`. */
function pushesImage(words: string[], args: string[]): boolean {
  const [a = '', b = '', c = ''] = words;
  if (a === 'push' || (['image', 'manifest', 'compose'].includes(a) && b === 'push') || (a === 'buildx' && b === 'imagetools' && c === 'create')) return true;
  const builds = a === 'build' || a === 'bud' || (['buildx', 'image', 'builder'].includes(a) && ['build', 'bake'].includes(b));
  return builds && args.some((x) => x === '--push' || /type=registry|push=true/.test(x));
}

/** Whether a command publishes a package or an image, or changes one in its registry: a registry the sandbox lets a command reach takes uploads too. */
function publishes(tool: string, args: string[]): boolean {
  const words = plainWords(args, VALUED[tool] ?? []);
  const [first = '', second = '', third = ''] = words;
  switch (tool) {
    case 'npm': {
      const command = Object.keys(NPM_ABBREVIATIONS).find((c) => c === first || (first.length >= NPM_ABBREVIATIONS[c]! && c.startsWith(first)));
      return changesRegistry(command ?? first, second);
    }
    case 'pnpm':
    case 'bun':
      return changesRegistry(first, second);
    case 'yarn':
      return first === 'npm' ? changesRegistry(second, third) : changesRegistry(first, second);
    case 'cargo': {
      const [sub] = words.filter((w) => !w.startsWith('+')); // +nightly
      return sub === 'publish' || sub === 'yank' || (sub === 'owner' && args.some((a) => /^(-a|--add|-r|--remove)(=|$)/.test(a)));
    }
    case 'poetry':
    case 'flit':
    case 'hatch':
    case 'uv':
    case 'pdm':
    case 'deno':
    case 'jsr':
      return first === 'publish';
    case 'vsce':
    case 'ovsx':
      return first === 'publish' || first === 'unpublish';
    case 'twine':
      return first === 'upload' || first === 'register';
    case 'gem':
      return first === 'push' || first === 'yank' || (first === 'owner' && args.some((a) => /^(-a|--add|-r|--remove)(=|$)/.test(a)));
    case 'dotnet':
      return first === 'nuget' && (second === 'push' || second === 'delete');
    case 'nuget':
      return first === 'push' || first === 'delete';
    case 'mvn':
    case 'mvnw':
      return words.some(mavenUploads);
    case 'gradle':
    case 'gradlew':
      return words.some((w) => gradleUploads(w.split(':').pop()!));
    case 'docker':
    case 'podman':
    case 'buildah':
    case 'nerdctl':
      return pushesImage(words, args);
    case 'docker-compose':
    case 'helm':
      return first === 'push';
    case 'pod':
      return first === 'trunk' && ['push', 'delete', 'deprecate'].includes(second);
    default:
      return false;
  }
}

/** Tests that narrow what `find` matches. */
const FIND_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-regex', '-iregex', '-type', '-newer', '-mtime', '-mmin', '-atime', '-ctime', '-size', '-empty', '-user', '-perm']);

/** Of a repository, what a find from its root must not match to delete: git's metadata and what keeps it a repository. */
const GIT_NAMES = ['.git', 'config', 'HEAD', 'index', 'objects', 'refs', 'hooks', 'packed-refs'];

/**
 * `find … -exec cmd {} ;` runs cmd; `find … -delete` and `find … -exec rm -r {} +` are recursive deletes of what it
 * searches.
 */
async function checkFind(args: string[], dir: Dir, ctx: GuardContext): Promise<Verdict> {
  let deletes = args.includes('-delete') ? '-delete' : '';
  for (let i = 0; i < args.length; i++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i]!)) continue;
    const end = args.findIndex((a, j) => j > i && (a === ';' || a === '+' || a === '\\;'));
    const argv = args.slice(i + 1, end === -1 ? undefined : end).filter((a) => a !== '{}' && a !== '\\');
    const verdict = await checkSimple({ words: argv, redirects: [], herestring: null }, dir, ctx);
    if (!verdict.allow) return verdict;
    const [first, ...rest] = stripPrefixes(argv);
    if (first !== undefined && path.basename(first) === 'rm' && recursive(rest)) deletes = `${args[i]} rm -r`;
  }
  if (!deletes) return allow;
  const firstTest = args.findIndex((a) => a.startsWith('-') || a === '!' || a === '(');
  const listed = (firstTest === -1 ? args : args.slice(0, firstTest)).filter(Boolean);
  const roots = listed.length ? listed : ['.'];
  // Without a test (`find dir -delete`) the whole folder goes, as with `rm -r dir`. With one (`-name '*.log'`) only
  // matches inside it do: that folder must be where `rm -r` of something inside it would be allowed.
  const filtered = args.some((a) => FIND_TESTS.has(a));
  if (!filtered) return checkRm(['-r', ...roots], dir, ctx);
  for (const root of roots) {
    const abs = resolveIn(dir, root, ctx);
    if (abs === null) return lost(`find ${root} … ${deletes}`);
    const verdict = await checkRm(['-r', path.join(abs, 'x')], dir, ctx);
    if (!verdict.allow) return deny(`find ${root} … ${deletes}: ${verdict.reason}`);
    // rm -r of a match takes all in it: from the workspace or above a repository, the match can be a repository.
    const holds = [ctx.workspace, ...(ctx.repoDirs || [])].some((r) => within(path.resolve(r), abs));
    if (deletes !== '-delete' && holds && !(await ctx.isRepoRoot(abs))) {
      return deny(`find ${root} … ${deletes} could delete a repository or the workspace (${abs} holds them): run it from inside the repository`);
    }
    // From a folder rm -r may not take whole (the repository's root, a folder above it) a match can be .git or what
    // is in it (`-name config`, `! -name src`, `-type d -empty`): only names that are none of git's are deleted there.
    if (!(await checkRm(['-r', '--', abs], dir, ctx)).allow && !sparesGit(args, root)) {
      return deny(`find ${root} … ${deletes} could delete .git or what is in it: match by -name (not .git, config, HEAD…), without ! or -o, or run it from a folder inside the repository`);
    }
  }
  return allow;
}

/**
 * Whether a find from root matches only by -name or -path patterns that fit nothing of git's there (`-name
 * node_modules`, `-path '*.pyc'`), with no `!` or `-o` to turn them around.
 */
function sparesGit(args: string[], root: string): boolean {
  if (args.some((a) => ['!', '-not', '-o', '-or', ',', '-regex', '-iregex', '-lname', '-ilname'].includes(a))) return false;
  const gitPaths = GIT_NAMES.map((n) => `${root.replace(/\/+$/, '')}/.git${n === '.git' ? '' : `/${n}`}`);
  const tests = [
    ...optionValues(args, ['-name']).map((p) => ({ p, caseless: false, samples: GIT_NAMES })),
    ...optionValues(args, ['-iname']).map((p) => ({ p, caseless: true, samples: GIT_NAMES })),
    ...optionValues(args, ['-path', '-wholename']).map((p) => ({ p, caseless: false, samples: gitPaths })),
    ...optionValues(args, ['-ipath', '-iwholename']).map((p) => ({ p, caseless: true, samples: gitPaths })),
  ];
  return tests.length > 0 && tests.every(({ p, caseless, samples }) => !samples.some((s) => globMatches(p, s, caseless)));
}

/** Whether a pattern of find's (`*`, `?`, `[…]`, a `\` escape; `*` also matches `/`) matches a name. */
function globMatches(pattern: string, name: string, caseless: boolean): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    const close = c === '[' ? pattern.indexOf(']', i + 2) : -1;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (close !== -1) {
      re += `[${pattern.slice(i + 1, close).replace(/^!/, '^').replace(/[\\\]]/g, '\\$&')}]`;
      i = close;
    } else re += (c === '\\' ? (pattern[++i] ?? '') : c).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`, caseless || CASELESS ? 'is' : 's').test(name);
  } catch {
    return true;
  }
}

/** Whether rm's options delete folders with what is in them. */
function recursive(args: string[]): boolean {
  const flags = flagSet(args);
  return flags.has('-r') || flags.has('-R') || flags.has('--recursive');
}

/**
 * Splits on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes; drops heredoc bodies and comments. A command after
 * `&&` is marked as one that runs only if the command before it succeeded, unless a subshell came between.
 */
function simpleCommands(command: string): Segment[] {
  // A `\` at the end of a line continues the command: `git \⏎ push -f` is one command.
  const lines = command.replace(/\\\r?\n/g, ' ').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);
    // `<<<` is a here-string, not a heredoc: the lines after it are commands.
    const heredoc = unquoted(line).match(/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (heredoc) {
      const end = heredoc[2];
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== end) i++;
      i++; // the terminator line
    }
  }

  // `$(…)` and `` `…` `` run as commands of their own, inside double quotes too; in the command around them they leave
  // `$SUBST`, a value nobody can check (so `rm -r $(pwd)/..` is refused). A process substitution (`<(…)`, `>(…)`)
  // leaves the path the shell gives it, `/dev/fd/63`. A plain `( … )` subshell leaves nothing, and an empty one `()`,
  // which is a function's definition (`f() { …; }`).
  const SUBST = '$SUBST';
  const PIPE = '/dev/fd/63';
  const segments: Segment[] = [];
  const stack: { outer: string; quote: string | null; close: string; leaves: string | null; and: boolean }[] = [];
  let current = '';
  let quote: string | null = null;
  // Whether current runs only once the command before it succeeded; whether a subshell ran inside it, so that what
  // follows its `&&` follows the subshell, not the last command in it (`(cd x && y) && z` runs z here).
  let and = false;
  let nested = false;
  const open = (close: string, leaves: string | null): void => {
    stack.push({ outer: current, quote, close, leaves, and });
    current = '';
    quote = null;
    and = false;
  };
  const text = kept.join('\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const top = stack[stack.length - 1];
    if (top && quote === null && ch === top.close) {
      const empty = !current.trim();
      segments.push({ text: current, and });
      stack.pop();
      current = top.outer + (top.leaves ?? (empty ? '()' : ''));
      quote = top.quote;
      and = top.and;
      nested = true;
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    // $'…' takes backslash escapes, so `$'\''` does not end it.
    if (quote === "$'") {
      if (ch === '\\') current += ch + (text[++i] ?? '');
      else {
        current += ch;
        if (ch === "'") quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') current += ch + (text[++i] ?? '');
      else if (ch === '`') open('`', SUBST);
      else if (ch === '$' && text[i + 1] === '(') {
        i++;
        open(')', SUBST);
      } else {
        current += ch;
        if (ch === '"') quote = null;
      }
      continue;
    }
    if (ch === '$' && text[i + 1] === "'") {
      quote = "$'";
      current += "$'";
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === '\\') {
      current += ch + (text[++i] ?? '');
    } else if (ch === '#' && (current === '' || /\s$/.test(current))) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (ch === '`') {
      open('`', SUBST);
    } else if (ch === '$' && text[i + 1] === '(') {
      i++;
      open(')', SUBST);
    } else if (ch === '(' && /[<>]$/.test(current)) {
      current = current.slice(0, -1);
      open(')', PIPE);
    } else if (ch === '(') {
      open(')', null);
    } else if ((ch === '&' && (text[i + 1] === '>' || current.endsWith('>'))) || (ch === '|' && current.endsWith('>'))) {
      // Part of a redirection, not a separator: `&> f`, `>& f`, `>| f` write f.
      current += ch;
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === ')') {
      segments.push({ text: current, and });
      const twice = (ch === '|' || ch === '&') && text[i + 1] === ch;
      and = ch === '&' && twice && !nested;
      nested = false;
      current = '';
      if (twice) i++;
      else if (ch === '|' && text[i + 1] === '&') i++; // |& pipes stderr too
    } else current += ch;
  }
  segments.push({ text: current, and });
  // Unclosed substitutions: what was around them is still a command.
  while (stack.length) segments.push({ text: stack.pop()!.outer, and: false });
  return segments.map((s) => ({ text: s.text.trim(), and: s.and })).filter((s) => s.text);
}

/** The line with quoted text blanked out, so `echo "<<EOF"` is not taken for a heredoc. */
function unquoted(line: string): string {
  return line.replace(/\$'(?:[^'\\]|\\.)*'|'[^']*'|"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length));
}

/**
 * The words of a command without its redirections (`2>/dev/null`, `> out.txt`, `2>&1`, `< in`, `<< EOF`): they are
 * not arguments, so `git branch -a 2>/dev/null` lists branches rather than creating one. The files written are checked
 * apart, from the segment's text. A here-string (`<<< 'text'`) is what the command reads.
 */
function withoutRedirects(argv: string[]): { words: string[]; herestring: string | null } {
  const out: string[] = [];
  let herestring: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const here = a.match(/^\d*<<<(.*)$/s);
    if (here) herestring = here[1] || (argv[++i] ?? '');
    else if (/^(?:\d*|&)(?:>>?|<<-?|<>?)[|&]?$/.test(a)) i++; // the operator alone: its target is the next word
    else if (!/^(?:\d*|&)(?:>>?|<<-?|<>?)[|&]?\S+$/.test(a)) out.push(a);
  }
  return { words: out, herestring };
}

/** Words that come before the command itself: shell keywords (`coproc` runs it in the background). */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '}', 'coproc']);

/**
 * Commands that run the command in their arguments, and the options of theirs that take a value. `positional` is how
 * many plain arguments come before the command (`timeout DURATION cmd`); `shell`, the options whose value is a
 * command line a shell runs (`script -c 'git push'`).
 */
const WRAPPERS: Record<string, { valued: string[]; positional?: number; shell?: string[] }> = {
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
  // `-i`, `-e` and `-l` take their value attached, if any.
  xargs: { valued: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--max-lines', '--max-chars', '--eof', '--process-slot-var'] },
  parallel: {
    valued: ['-j', '--jobs', '-S', '--sshlogin', '--sshloginfile', '--slf', '-a', '--arg-file', '--colsep', '-C', '-d', '--delimiter', '-E', '-I', '--joblog', '--results', '--res', '--tmpdir', '-n', '--max-args', '-N', '-L', '--max-lines', '--delay', '--timeout', '--memfree', '--load', '--tagstring', '--workdir', '--wd', '--basefile', '--bf', '--return', '--transferfile', '--tf', '--env', '--profile', '-J', '--halt', '--retries'],
  },
  caffeinate: { valued: ['-t', '-w'] },
  chrt: { valued: [], positional: 1 },
  taskset: { valued: [], positional: 1 },
  doas: { valued: ['-u', '-C'] },
  time: { valued: ['-f', '-o', '--format', '--output'] },
  watch: { valued: ['-n', '--interval', '-q', '--equexit'] },
  npx: { valued: ['-p', '--package', '-w', '--workspace', '--prefix', '--registry', '--cache', '--userconfig'], shell: ['-c', '--call'] },
  pnpx: { valued: [] },
  bunx: { valued: ['-p', '--package'] },
  uvx: { valued: ['--from', '--with', '--python', '-p', '--index', '--index-url', '--extra-index-url', '--env-file', '--directory', '--with-requirements'] },
  corepack: { valued: [] },
  flock: { valued: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'], positional: 1, shell: ['-c', '--command'] },
  script: { valued: ['-t', '-T', '-I', '-O', '-B', '-E', '--timing', '--log-io', '--log-in', '--log-out', '--echo'], positional: 1, shell: ['-c', '--command'] },
  setsid: { valued: [] },
  'ssh-agent': { valued: ['-a', '-E', '-t', '-P', '-O'] },
  strace: { valued: ['-e', '-o', '-p', '-s', '-u', '-E', '-a', '-b', '-I', '-O', '-P', '-S', '-X'] },
  ltrace: { valued: ['-e', '-o', '-p', '-s', '-u', '-a', '-A', '-D', '-l', '-n', '-F', '-x', '-w'] },
  fakeroot: { valued: ['-l', '--lib', '--faked', '-s', '-i', '-b'] },
  unbuffer: { valued: [] },
  chronic: { valued: [] },
  'sandbox-exec': { valued: ['-f', '-n', '-p', '-D'] },
  screen: { valued: ['-S', '-c', '-e', '-h', '-p', '-s', '-T', '-t', '-X', '-Logfile'] },
};

/** Drops what runs before the command: `VAR=value`, shell keywords, and wrappers with their options. */
function stripPrefixes(argv: string[]): string[] {
  return splitPrefixes(argv).argv;
}

/** What xargs or parallel fill in from their input, as the guard sees it: a value nobody can check. */
const INPUT = '$INPUT';

/** The replace string an option of xargs or parallel sets (`-I {}`, `-I%`, `-i`, `--replace=X`), if it sets one. */
function replaceString(opt: string, next: string | undefined): string | null {
  if (opt === '-I') return next ?? null;
  const m = opt.match(/^(?:-I(.+)|-i(.*)|--replace(?:=(.*))?)$/s);
  return m ? m[1] || m[2] || m[3] || '{}' : null;
}

/**
 * The command and the variables set for it (`GIT_DIR=x git …`, `env VAR=y …`), past keywords and wrappers; `fed`
 * when xargs or parallel add arguments they read from input. What their replace strings stand for (`xargs -I{} rm
 * {}`, parallel's `{}` and `{.}`) becomes $INPUT.
 */
function splitPrefixes(argv: string[]): { env: string[]; argv: string[]; fed: boolean } {
  const env: string[] = [];
  const holes: (string | RegExp)[] = [];
  const fill = (words: string[]): string[] => words.map((w) => holes.reduce<string>((s, h) => (typeof h === 'string' ? s.split(h).join(INPUT) : s.replace(h, INPUT)), w));
  let fed = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      env.push(a);
      i++;
      continue;
    }
    if (KEYWORDS.has(a)) {
      // `coproc NAME { …; }` names the coprocess.
      i += a === 'coproc' && argv[i + 2] === '{' ? 2 : 1;
      continue;
    }
    // A function's definition (`f() { …; }`, `function f { …; }`): its body is the command.
    if (a === 'function') {
      i += argv[i + 2] === '()' ? 3 : 2;
      continue;
    }
    if (/^[^\s=]+\(\)$/.test(a) || argv[i + 1] === '()') {
      i += argv[i + 1] === '()' ? 2 : 1;
      continue;
    }
    const name = path.basename(a);
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (!wrapper) break;
    i++;
    if (name === 'xargs' || name === 'parallel') fed = true;
    if (name === 'parallel') holes.push(/\{[^}]*\}/g);
    let positional = wrapper.positional ?? 0;
    while (i < argv.length) {
      const opt = argv[i]!;
      if (opt === '--') {
        i++;
        break;
      }
      // `env -S 'git push -f'` splits its value into the command and its arguments.
      const split = name === 'env' ? opt.match(/^(?:-S|--split-string)(?:=?)(.*)$/s) : null;
      if (split) {
        const value = split[1] || argv[i + 1] || '';
        const rest = argv.slice(i + (split[1] ? 1 : 2));
        const inner = splitPrefixes([...tokenize(value), ...rest]);
        return { env: [...env, ...inner.env], argv: fill(inner.argv), fed: fed || inner.fed };
      }
      // `script -c 'cmd'`, also at the end of a cluster (`-qc`), or `--command=cmd`.
      const long = opt.match(/^(--[^=]+)=(.*)$/s);
      const shell = wrapper.shell?.some((s) => s === (long ? long[1] : opt) || (/^-[A-Za-z]$/.test(s) && /^-[A-Za-z]+$/.test(opt) && opt.endsWith(s[1]!)));
      if (shell) return { env, argv: fill(['sh', '-c', long ? long[2]! : (argv[i + 1] ?? '')]), fed };
      const hole = name === 'xargs' || name === 'parallel' ? replaceString(opt, argv[i + 1]) : null;
      if (hole) holes.push(hole);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(opt)) {
        env.push(opt); // env VAR=value cmd
        i++;
      } else if (opt.startsWith('-')) {
        // A cluster of short options ending with one that takes a value (`screen -dmS name`) takes the next word.
        i += wrapper.valued.includes(opt) || (/^-[A-Za-z]{2,}$/.test(opt) && wrapper.valued.includes(`-${opt.slice(-1)}`)) ? 2 : 1;
      } else if (positional > 0) {
        positional--;
        i++;
      } else break;
    }
    // Without a command parallel runs its inputs as commands: the words after one `:::` (checked), or what it reads.
    if (name === 'parallel' && (i >= argv.length || /^:{3,4}\+?$/.test(argv[i]!))) {
      const inputs = argv.slice(i + 1);
      const one = argv[i] === ':::' && !inputs.some((w) => /^:{3,4}\+?$/.test(w));
      return { env, argv: one ? ['sh', '-c', inputs.join('\n')] : ['sh', '-s'], fed };
    }
  }
  return { env, argv: fill(argv.slice(i)), fed };
}

/**
 * Git's environment changes what a command does: GIT_EXTERNAL_DIFF or GIT_PAGER run a program, GIT_CONFIG_* is `-c`,
 * GIT_DIR points it at other metadata. An agent sets none of it, for a git command or for the shell's later ones
 * (`export GIT_…`), except harmless ones: no prompts, no locks, a pager that only prints.
 */
const GIT_ENV_OK = /^(GIT_TERMINAL_PROMPT|GIT_OPTIONAL_LOCKS|GIT_PAGER=(cat|less)?$|PAGER=(cat|less)?$)/;
const GIT_ENV = /^(GIT_[A-Z0-9_]*|PAGER)=/;
const DECLARES = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);

function gitEnvRefusal(cmd: string, env: string[], args: string[]): Verdict | null {
  const set = cmd === 'git' ? env : DECLARES.has(cmd) ? args.filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) : [];
  const bad = set.find((v) => GIT_ENV.test(v) && !GIT_ENV_OK.test(v));
  return bad ? deny(`agents do not set git's environment (${bad.split('=')[0]}); Claudestrator owns git`) : null;
}

/** A path as the shell finds it from dir (`~` and `$HOME` are your home); null if it is relative to a folder not known. */
function resolveIn(dir: Dir, p: string, ctx: GuardContext): string | null {
  const home = ctx.home ?? os.homedir();
  const expanded = p.replace(/^~(?=$|\/)/, home).replace(/^\$\{?HOME\}?(?=$|\/)/, home);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return dir === null ? null : path.resolve(dir, expanded);
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

async function attributionIn(texts: string[], files: string[], dir: Dir, ctx: GuardContext): Promise<Verdict> {
  if (!ctx.policy.forbidAiAttribution) return allow;
  if (texts.some((t) => AI_CREDIT.test(t))) return deny('no AI attribution in commits or PRs (policy.forbidAiAttribution); remove the Co-Authored-By / Generated-with lines');
  for (const f of files) {
    if (f === '-') continue;
    if (dir === null && !path.isAbsolute(f)) return lost(`the message in ${f}`);
    const content = await ctx.readFile(path.resolve(dir ?? '/', f));
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

/** `git config` actions that only read; `get` and `list` are the newer syntax's, as its first word. */
const GIT_CONFIG_READS = new Set<string>(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l']);
/** `git config` actions that write, in either syntax. */
const GIT_CONFIG_WRITES = new Set<string>(['--add', '--replace-all', '--unset', '--unset-all', '--rename-section', '--remove-section', '--edit', '-e', 'set', 'unset', 'rename-section', 'remove-section', 'edit']);
/** `git config` options that take a value: `--comment get` is a comment, not the `get` action. */
const GIT_CONFIG_VALUED = ['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url'];

/**
 * Whether `git config` only reads: a read action and no write one, or the old syntax with a key alone (`git config
 * user.name`). `--show-scope`, `--show-origin`, `--name-only`, `-z`, `--type`, `--global`, `--file` only say how or where.
 */
function gitConfigReads(args: string[]): boolean {
  const flags = [...flagSet(args)];
  const words = plainWords(args, GIT_CONFIG_VALUED);
  if (flags.some((f) => GIT_CONFIG_WRITES.has(f)) || GIT_CONFIG_WRITES.has(words[0] ?? '')) return false;
  if (words[0] === 'get' || words[0] === 'list' || flags.some((f) => GIT_CONFIG_READS.has(f))) return true;
  return words.length === 1;
}

/** `git branch` options that make, move, delete a branch or set its upstream. */
const GIT_BRANCH_WRITES = new Set<string>(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '-t', '--track', '--no-track', '--create-reflog', '--recurse-submodules']);
/** Options that make `git branch` list, its words then being patterns (`--list 'feat/*'`, `--merged main`). */
const GIT_BRANCH_LISTS = ['-l', '--list', '-a', '--all', '-r', '--remotes', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];

/** `git fetch` options that take a value. */
const GIT_FETCH_VALUED = ['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--negotiation-tip', '-o', '--server-option', '-j', '--jobs', '--filter', '--refmap', '--recurse-submodules-default'];

/** Git subcommands that change refs, the index or discard work: never an agent's business. */
const AGENT_GIT_WRITES = new Set<string>([
  'commit', 'push', 'pull', 'stash', 'reset', 'rebase', 'merge', 'switch', 'checkout', 'restore', 'cherry-pick',
  'revert', 'am', 'tag', 'worktree', 'clean', 'rm', 'mv', 'update-ref', 'filter-branch', 'filter-repo', 'notes', 'gc', 'prune',
]);

/**
 * What an agent may run of git: reading it, staging and applying a patch in its repo, fetching. Anything else
 * (symbolic-ref, bisect, update-index, submodule, clone, archive…) moves HEAD, hides changes from the commit or writes
 * outside the repo; with the sandbox off nothing else would stop it. `stash`, `worktree`, `reflog` and `lfs` only read.
 */
const AGENT_GIT = new Set<string>([
  'status', 'diff', 'log', 'show', 'blame', 'annotate', 'grep', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'rev-parse',
  'rev-list', 'describe', 'shortlog', 'show-ref', 'for-each-ref', 'name-rev', 'merge-base', 'diff-tree', 'diff-files',
  'diff-index', 'check-ignore', 'check-attr', 'check-mailmap', 'check-ref-format', 'count-objects', 'version', 'help', 'var',
  'whatchanged', 'range-diff', 'cherry', 'show-branch', 'branch', 'remote', 'config', 'add', 'apply', 'fetch', 'fsck',
  'stash', 'worktree', 'reflog', 'lfs',
]);
const AGENT_GIT_READ_ONLY: Record<string, string[]> = { stash: ['list', 'show'], worktree: ['list'], reflog: ['show'], lfs: ['ls-files', 'status', 'env', 'version'] };
/** Options that run a program or write a file: `--upload-pack=cmd`, `grep -O<cmd>`, `--output=<file>`. */
const AGENT_GIT_OPTIONS = /^(--upload-pack|--receive-pack|--exec|--output|--open-files-in-pager|-O)(=|$)|^-O./;

async function checkGit(all: string[], cwd: Dir, ctx: GuardContext): Promise<Verdict> {
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
    if (sub && !AGENT_GIT.has(sub) && !AGENT_GIT_WRITES.has(sub)) return deny(`agents do not run git ${sub}; they read git, stage and apply patches, and Claudestrator owns the rest`);
    const readOnly = sub ? AGENT_GIT_READ_ONLY[sub] : undefined;
    if (readOnly && sub !== 'stash' && sub !== 'worktree' && args[0] !== undefined && !args[0].startsWith('-') && !readOnly.includes(args[0])) return deny(`agents only read with git ${sub} (${readOnly.join(', ')})`);
    const option = args.find((a) => AGENT_GIT_OPTIONS.test(a));
    if (option) return deny(`git ${sub} ${option.split('=')[0]} runs a program or writes a file; redirect the output instead`);
    if (sub === 'config' && !gitConfigReads(args)) return deny('agents only read git config (--get, --list, get, list, or a key alone); Claudestrator owns git');
    const action = sub === 'remote' ? plainWords(args, [])[0] : undefined;
    if (action !== undefined && action !== 'show' && action !== 'get-url') return deny('agents do not change git remotes');
    if (sub === 'branch') {
      const branchFlags = [...flags];
      if (branchFlags.some((f) => GIT_BRANCH_WRITES.has(f)) || (plainWords(args, ['--sort', '--format', '--points-at']).length > 0 && !branchFlags.some((f) => GIT_BRANCH_LISTS.includes(f)))) {
        return deny('agents do not create, rename or delete branches, or set their upstream; Claudestrator owns git');
      }
    }
    // `git apply` writes where the patch says, under --directory, and with --unsafe-paths outside the repository too.
    if (sub === 'apply' && flags.has('--unsafe-paths')) return deny('git apply --unsafe-paths writes outside the repository; apply the patch inside it');
    if (sub === 'apply') {
      const writes = checkWrites(optionValues(args, ['--directory']).map((d) => path.join(d, 'x')), 'git apply', dir, ctx);
      if (!writes.allow) return writes;
    }
    // A refspec with a destination (`main:main`, `+sha:refs/heads/main`) writes that local ref; from stdin, any.
    if (sub === 'fetch' && (flags.has('--stdin') || [...plainWords(args, GIT_FETCH_VALUED).slice(1), ...optionValues(args, ['--refmap'])].some((r) => r.includes(':')))) {
      return deny('git fetch into a local branch (a refspec with :) is not allowed: fetch without one; Claudestrator owns git');
    }
  }
  if (ctx.agent && sub && AGENT_GIT_WRITES.has(sub) && !(AGENT_GIT_READ_ONLY[sub] || []).includes(args[0] ?? '')) return deny(`agents do not run git ${sub}; Claudestrator owns git (commits, branches, pushes)`);

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
      if (dir === null && (refspecs.length === 0 || targets.includes('HEAD'))) return lost('git push of the current branch');
      const current = dir === null ? null : await ctx.branchOf(dir);
      if (refspecs.length === 0 && current) targets.push(current);
      const hit = targets.find((t) => protectedBranches.includes(t) || (t === 'HEAD' && protectedBranches.includes(current ?? '')));
      if (hit) return deny(`pushing to ${hit === 'HEAD' ? current : hit} is not allowed; push the feature branch`);
      if (ctx.task && !ctx.task.canPush) return deny(`task ${ctx.task.taskId} has not reached publish: push only after the user confirms it`);
      return allow;
    }
    case 'commit': {
      if (dir === null) return lost('git commit');
      const b = await ctx.branchOf(dir);
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

async function checkGh(all: string[], dir: Dir, ctx: GuardContext): Promise<Verdict> {
  const [group, action, ...args] = all;
  // `gh auth status --show-token` and `gh auth token` print the token: no gh auth at all, whatever reads.
  if (ctx.agent && (group === 'auth' || all.some((a) => a.startsWith('--show-token')))) return deny('agents do not use gh auth: it can print your GitHub token');
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

/** glab actions an agent may use, for reading only (`ci trace` prints a job's log). */
const AGENT_GLAB_READ = new Set<string>(['view', 'list', 'diff', 'status', 'trace']);

/**
 * GitLab's CLI, as gh: agents only read (merge requests, issues, pipelines), never sign in or read glab's config (it
 * holds the token), and nobody merges. An MR is opened as a draft, and only once the task may push.
 */
async function checkGlab(all: string[], dir: Dir, ctx: GuardContext): Promise<Verdict> {
  const [group, action, ...args] = all;
  if (ctx.agent && (group === 'auth' || group === 'config' || group === 'token')) return deny(`agents do not use glab ${group}: it can print your GitLab token`);
  if (ctx.agent && group !== 'api' && !AGENT_GLAB_READ.has(action ?? '')) return deny(`agents only read with glab (view, list, diff, status); glab ${group ?? ''} ${action ?? ''} is the orchestrator's`);
  if (ctx.agent && group === 'api' && ghApiWrites(all)) return deny('agents only read with glab api (GET)');
  if (group === 'mr' && (action === 'merge' || action === 'approve')) return deny('merging MRs is for humans');
  if (group === 'api' && all.some((a) => /\/merge_requests\/[^/\s]+\/merge(\b|$)/.test(a))) return deny('merging MRs is for humans');
  if (group === 'repo' && ['delete', 'archive', 'transfer'].includes(action ?? '')) return deny('repository settings are out of scope');
  if (group === 'mr' && (action === 'create' || action === 'update')) {
    if (action === 'create') {
      const flags = flagSet(args);
      if (ctx.policy.draftPrsOnly && !flags.has('--draft') && !flags.has('--wip')) return deny('MRs are opened as drafts only: add --draft (policy.draftPrsOnly)');
      if (ctx.task && !ctx.task.canPush) return deny(`task ${ctx.task.taskId} has not reached publish: open MRs only after the user confirms the push`);
    }
    return attributionIn(optionValues(args, ['--description', '-d', '--title', '-t']), [], dir, ctx);
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

async function checkRm(args: string[], dir: Dir, ctx: GuardContext): Promise<Verdict> {
  if (!recursive(args)) return allow;
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
    // `~user`, `~+` and `~-` are other folders (a home, the current or the last one): the shell knows which.
    if (/^~(?!\/|$)/.test(t)) return deny(`rm -r ${t}: spell out the path instead of ${t.split('/')[0]}`);
    // A pattern (`*/`, `?*`, `[a-z]*`) matches what the shell finds: it deletes from the folder it starts in, which is
    // checked as if its whole content went. `build/*` is fine, `*/` in the repo's root is the repo.
    const glob = t.search(/[*?[]/);
    if (glob !== -1) {
      if (/\.\./.test(t.slice(glob))) return deny(`rm -r ${t}: a pattern that climbs out with .. is not allowed`);
      const from = resolveIn(dir, t.slice(0, glob).replace(/[^/]*$/, '') || '.', ctx);
      if (from === null) return lost(`rm -r ${t}`);
      const verdict = await checkRm(['-r', '--', from], dir, ctx);
      if (!verdict.allow) return deny(`rm -r ${t} deletes what is in ${from}: ${verdict.reason}`);
      continue;
    }
    const abs = resolveIn(dir, t.replace(/\/\*$/, ''), ctx);
    if (abs === null) return lost(`rm -r ${t}`);
    const inside = (root: string): boolean => abs === root || abs.startsWith(root + path.sep);
    const contains = (root: string): boolean => root === abs || root.startsWith(abs + path.sep);
    if (abs === '/' || abs === home || roots.some(contains)) return deny(`rm -r ${t} would delete ${abs}, which contains the workspace, a repository or your home`);
    const ground = roots.some(inside);
    if (ground && (await ctx.isRepoRoot(abs))) return deny(`rm -r ${t} would delete the repository ${abs}`);
    if (ground && inGitMetadata(abs)) return deny(`rm -r ${t} would delete git metadata`);
    if (!ground && !inside(tmp) && !inside('/tmp') && !inside('/private/tmp')) return deny(`rm -r outside the workspace and its repos (${abs}) is not allowed; ask the user`);
  }
  return allow;
}

export type { GuardContext, Verdict as GuardVerdict };
export { guardBash, inGitMetadata, inside, outsideLabel, simpleCommands, AI_CREDIT };
