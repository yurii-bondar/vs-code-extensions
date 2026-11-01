// Config layers: built-in defaults, ~/.claudestrator/config.yaml, <workspace>/.claudestrator/config.yaml,
// then run flags. Later layers win field by field; arrays (tools, pipeline, gates) are replaced, never merged.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { AsyncLocalStorage } from 'async_hooks';
import { isDeepStrictEqual } from 'util';
import { validateConfigLayer, validateAgentPatch, validateLibraryLayer, SCENARIO_OUTPUT, JIRA_KEY } from './protocol';
import { ORCH_DIR } from './store';
import { ENV_FILE, SECRET_PATHS, GITHUB_TOKENS } from './settings';
import { signature, writeAtomic } from './files';
import type { Agent, Config, CustomScenario, Diagnostic, Effort, Gate, GitMode, GroupType, Output, Policy, RepoConfig, Runs, ScenarioStep, TaskGroup, TaskInstruction } from './types';

// ---------- the shapes of a config layer, as written in config.yaml ----------

type InstructionsInput = string | { mode?: string; file?: string; text?: string };

interface AgentLayer {
  enabled?: boolean;
  extends?: string;
  description?: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  mcp?: boolean;
  maxTurns?: number;
  effort?: Effort;
  runs?: Runs;
  color?: string;
  output?: Output;
  instructions?: InstructionsInput;
}

type ScenarioStepLayer = string | { agent: string; model?: string; effort?: Effort };

interface CustomScenarioLayer {
  label?: string;
  description?: string;
  agents: ScenarioStepLayer[];
}

type GroupLayer = Omit<TaskGroup, 'id'>;
type InstructionLayer = Omit<TaskInstruction, 'id'>;

interface RepoLayer {
  role?: string;
  path?: string;
  baseBranch?: string;
  gates?: Gate[];
}

interface ConfigLayer {
  agents?: Record<string, AgentLayer>;
  pipeline?: string[];
  scenarios?: Record<string, string[] | false | CustomScenarioLayer>;
  /** Folders (or files) of agents and scenarios kept apart from this config, merged in before it. */
  libraries?: string[];
  limits?: { reviewRounds?: number; gateAttempts?: number; budgetUsd?: number; parallelTasks?: number };
  language?: string;
  baseBranch?: string;
  repos?: Record<string, RepoLayer>;
  jira?: { allowedProjects?: string[] };
  policy?: Partial<Policy>;
  git?: { mode?: GitMode };
  /** The claudestrator CLI's; the extension leaves it to it. */
  editor?: string;
  context?: string[];
  groups?: Record<string, GroupLayer>;
  instructions?: Record<string, InstructionLayer>;
}

interface Layer {
  name: string;
  baseDir: string;
  config: ConfigLayer;
  /** The file it was read from; the built-in layer has none. */
  file?: string | undefined;
  /** A library's: the config that lists it (yours first, when both do). */
  listedBy?: 'user' | 'project' | undefined;
}

/** One piece of an agent's instructions: inline text or a file, and how it combines with what came before. */
interface InstructionOp {
  mode: string;
  text?: string;
  file?: string;
  source: string;
  /** The folder of the config that names these instructions: `{{dir}}` in them becomes this path. */
  dir: string;
  /** The layer that names them: `project`, `user`, `library:<name>` or `builtin`. */
  layer: string;
}

/** An agent while the layers are merged: its fields so far, before `extends` is followed. */
interface Draft extends Omit<AgentLayer, 'instructions'> {
  ops: InstructionOp[];
  layers: string[];
}

interface ScenarioEntry {
  value: string[] | false | CustomScenarioLayer;
  source: string;
}

interface Merged {
  agents: Map<string, Draft>;
  limits: NonNullable<ConfigLayer['limits']>;
  repos: Map<string, RepoLayer>;
  jira: NonNullable<ConfigLayer['jira']>;
  policy: Partial<Policy>;
  scenarios: Record<string, ScenarioEntry>;
  groups: Record<string, GroupLayer>;
  instructions: Record<string, InstructionLayer>;
  origins: Record<string, unknown>;
  pipeline?: { names: string[]; source: string };
  language?: string;
  baseBranch?: string;
  gitMode?: GitMode;
  context?: string[];
}

interface Flags {
  no?: string[] | undefined;
  only?: string[] | undefined;
}

type ReadFile = (file: string) => string;

type ResolveResult = { ok: true; warnings: Diagnostic[]; config: Config } | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };

/** An agent after `extends` is followed. */
interface Inherited {
  lineage: string[];
  ops: InstructionOp[];
  description?: string | undefined;
  model?: string | undefined;
  tools?: string[] | undefined;
  disallowedTools?: string[] | undefined;
  mcp?: boolean | undefined;
  maxTurns?: number | undefined;
  effort?: Effort | undefined;
  runs?: Runs | undefined;
  color?: string | undefined;
  output?: Output | undefined;
}

const CONFIG_DIR = '.claudestrator';
const CONFIG_FILE = 'config.yaml';
const PROMPTS_DIR = 'prompts';

const READ_ONLY = ['Read', 'Grep', 'Glob', 'Bash'];
const WRITE = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

const COMMON = `The prompt gives you paths to artifacts (ticket, plan, reports, diffs), not their contents. Read them yourself.
Write everything a human reads in the language the prompt names. Code, identifiers and machine-read markers stay in English.
Never commit, push, stash, reset, rebase or switch branches: the orchestrator owns git.`;

const PLANNER = `You plan one task across the repositories you are given. You change no files; Bash is for read-only commands.

${COMMON}

1. Read the ticket and work out what "done" means in behaviour.
2. For each candidate repo, read its CLAUDE.md and .claude/rules, then the code you would change. Name real files and symbols.
3. List every contract the change crosses, with producer and consumers.
4. Plan only what the ticket asks for; list tempting extras under "Out of scope".
5. Ask a question only when two readings lead to different code, and give the default you would pick.

Start the plan with a "## Summary" section of two or three sentences: it becomes the PR description.

End with the json the orchestrator parses: as your structured output when you have the StructuredOutput tool, else as a fenced json block:
{"type": "feat|fix|chore|refactor", "slug": "<kebab-case>", "title": "<short imperative English description, lowercase: the commit subject>", "repos": [{"name": "<repo>", "mode": "full|tests_only"}], "openQuestions": [{"question": "...", "default": "..."}]}`;

const DEVELOPER = `You implement one repository's part of an approved plan, or fix review findings there.

${COMMON}

- Read the repo's CLAUDE.md and .claude/rules first and follow them over your habits.
- Work only inside the repo you are given. Implement what the plan says, nothing extra.
- Match contracts already changed upstream exactly; the prompt links their diff.
- Keep existing tests green. If the plan is wrong or impossible, stop and report it as blocked.
- Do not run the repo's lint, typecheck or full test suite yourself: the gates run them when you finish and send you the output of any that fail. Fix the cause; never disable rules, skip tests or loosen assertions. Run a single test only to check one behaviour you are unsure of.

End with a report: changed files, contract changes, deviations from the plan, notes for the tester, blockers.`;

const TESTER = `You own the tests the task needs, in every repository the developers changed.

${COMMON}

- Go through the repositories you are given one by one. In each, read its testing rules and the change under test (its diff and the developer report for it).
- Cover the contracts between the repos too: what one changes, the others must call and expect the same way.
- Cover the success path, the edge cases the plan names and the failure behaviour. Test behaviour, not implementation.
- Run only the tests you wrote or changed, not the whole suite, lint or typecheck: the gates run those when you finish and send you the output of any that fail.
- Do not change production code. If a test exposes a real bug, leave it failing and report it as blocked, with the bug and where it is.

End with a report per repository: tests added or updated, acceptance criteria covered, what could not be executed, bugs found.`;

const REVIEWER = `You review a task's combined diff with fresh eyes. You did not write it. You change nothing.

${COMMON}

Check, in order: correctness against the ticket and plan, cross-repo contract consistency, repo rules, test quality, scope, security.
Skip linter-level style and code the diff did not touch.

Severities: blocker (wrong behaviour, broken contract, security hole, data at risk), major (missing test for new behaviour, rule violation, scope creep), minor (everything else).
End with the json the orchestrator parses: as your structured output when you have the StructuredOutput tool, else as a fenced json block:
{"status": "approved|changes_requested", "summary": "...", "findings": [{"severity": "blocker|major|minor", "repo": "...", "file": "...", "line": 1, "problem": "...", "fix": "..."}]}
status is changes_requested exactly when there is a blocker or major finding.`;

const VERIFIER = `You check whether a ticket is really done: is its work in the code, and does it meet every acceptance criterion? You change no files.
Bash is for read-only commands: git log/show/diff/branch, searches, and the repo's own tests when running them is the only way to check a criterion. GitHub is not reachable from your commands: the pull requests that mention the ticket are in the file the prompt names.

${COMMON}

1. Read the ticket. Take its acceptance criteria as written. If it has none, derive checkable criteria from the description and set "derivedCriteria": true.
2. Find the work. In every repository the prompt lists, look for branches, commits and PRs that mention the ticket key or its subject (git branch -a --list, git log --all --grep, and the pull request list). Judge that branch or PR; if there is none, judge the base branch and say so. Name what you judged under "work".
3. For every criterion, look for the code that implements it (file:line), the tests that cover it, and anything that contradicts it. Status:
   - met: implemented, and covered by a test or plainly verifiable in the code;
   - partial: some of it, or without the edge cases or tests the criterion implies;
   - not_met: missing or wrong;
   - unverifiable: needs a runtime, data or environment you do not have; say exactly what a human must check.
4. List gaps that block a release even if no criterion names them: missing or failing tests, TODOs in the change, unhandled errors, missing migrations or config, contracts that differ between repos.
5. Be strict: "met" needs evidence. Never guess; quote file:line.

Write the report for a human: a one-paragraph verdict, a table criterion | status | evidence, then gaps and what to do next.

End with the json the orchestrator parses: as your structured output when you have the StructuredOutput tool, else as a fenced json block:
{"summary": "...", "work": [{"repo": "...", "ref": "<branch, commit or PR url>"}], "criteria": [{"criterion": "...", "status": "met|partial|not_met|unverifiable", "evidence": "...", "files": ["<repo>/<path>:<line>"]}], "gaps": [{"severity": "critical|high|medium|low", "problem": "...", "fix": "..."}], "derivedCriteria": false}
The orchestrator derives the verdict from the statuses: ready only when every criterion is met and no gap is critical or high.`;

const AUDITOR = `You audit code for real problems: bugs, performance bottlenecks, reliability and security issues. You change no files.
Bash is for read-only commands, plus the repo's own linters, tests or benchmarks when they are cheap and safe to run.

${COMMON}

Scope: the repositories the prompt lists, narrowed to the repos, areas or concerns the ticket names (e.g. "performance of the reports API").
1. For each repo read its CLAUDE.md, README and .claude/rules, then map entry points, hot paths (request handlers, loops over data, database access, queues, caches) and risky parts (money, auth, concurrency, external calls).
2. Hunt for:
   - bugs: wrong logic, unhandled edge cases, error handling that hides failures, race conditions, time zone and number precision mistakes;
   - performance: N+1 queries, missing indexes or pagination, unbounded loops or memory, blocking I/O on hot paths, repeated work, missing caching, chatty network calls;
   - reliability: missing timeouts or retries, unhandled promise rejections, resource leaks, missing transactions, unsafe migrations;
   - security: injection, authorization gaps, leaked secrets, unvalidated input.
3. Verify every finding in the code before you report it and quote file:line. No style nits and no speculation: a few real findings beat many guesses.
4. Severity:
   - critical: data loss or corruption, money or security breach, an outage is likely;
   - high: wrong behaviour users hit, serious slowdown under normal load;
   - medium: edge-case bugs, slowdowns under load, risky patterns;
   - low: minor issues and cleanups with a real benefit.

Write the report for a human: a summary, then the findings by severity, each with problem, impact, evidence and fix.

End with the json the orchestrator parses: as your structured output when you have the StructuredOutput tool, else as a fenced json block:
{"summary": "...", "scope": ["<repo>"], "findings": [{"severity": "critical|high|medium|low", "category": "bug|performance|reliability|security|maintainability", "repo": "...", "file": "...", "line": 1, "title": "<one line>", "problem": "...", "impact": "...", "fix": "...", "effort": "S|M|L"}]}`;

interface BuiltinConfig extends ConfigLayer {
  agents: Record<string, AgentLayer>;
  scenarios: Record<string, string[]>;
}

const BUILTIN: BuiltinConfig = {
  agents: {
    planner: {
      description: 'Read-only planner. Turns a ticket into a cross-repo plan with contracts, order and open questions.',
      model: 'opus',
      effort: 'high',
      tools: READ_ONLY,
      color: 'blue',
      output: 'plan',
      instructions: PLANNER,
    },
    developer: {
      description: 'Implements the approved plan in exactly one repository, or fixes review findings there.',
      model: 'sonnet',
      effort: 'medium',
      tools: WRITE,
      mcp: false,
      color: 'green',
      output: 'code',
      instructions: DEVELOPER,
    },
    tester: {
      description: 'Writes and updates the tests the approved plan owes in every repository it changed and makes them pass.',
      model: 'sonnet',
      effort: 'medium',
      tools: WRITE,
      mcp: false,
      color: 'yellow',
      output: 'tests',
      instructions: TESTER,
    },
    reviewer: {
      description: 'Fresh-context, read-only reviewer of the combined cross-repo diff. Returns a verdict with findings.',
      model: 'opus',
      effort: 'high',
      tools: READ_ONLY,
      mcp: false,
      color: 'red',
      output: 'verdict',
      instructions: REVIEWER,
    },
    verifier: {
      description: 'Read-only. Checks that a ticket is done: finds its work in the repos and judges every acceptance criterion with evidence.',
      model: 'opus',
      tools: READ_ONLY,
      color: 'cyan',
      output: 'readiness',
      instructions: VERIFIER,
    },
    auditor: {
      description: 'Read-only. Audits the repos for bugs, performance bottlenecks, reliability and security issues; rates each critical to low.',
      model: 'opus',
      tools: READ_ONLY,
      color: 'purple',
      output: 'audit',
      instructions: AUDITOR,
    },
  },
  pipeline: ['planner', 'developer', 'tester', 'reviewer'],
  scenarios: { readiness: ['verifier'], audit: ['auditor'] },
  // A task that spends this much has gone wrong somewhere: it stops, and you raise the limit or resume it. 0: no limit.
  limits: { reviewRounds: 2, gateAttempts: 3, budgetUsd: 25 },
  language: 'English',
  baseBranch: 'main',
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const builtinLayer = (): Layer => ({ name: 'built-in', baseDir: '/', config: clone(BUILTIN) });
const builtinAgentNames = (): string[] => Object.keys(BUILTIN.agents);

const projectConfigFile = (workspace: string): string => path.join(workspace, CONFIG_DIR, CONFIG_FILE);
const userConfigFile = (home: string = os.homedir()): string => path.join(home, CONFIG_DIR, CONFIG_FILE);

// ---------- loading ----------

/** The largest config, instruction or context file read: anything bigger is a mistake, not a prompt. */
const MAX_FILE = 1024 * 1024;

/**
 * Reads a config, instruction or context file: a regular file of at most MAX_FILE. A path a config names may point
 * anywhere, and `/dev/zero` or a FIFO would otherwise hang the extension host for every extension in the window.
 */
async function readBounded(file: string): Promise<string> {
  const st = await fs.promises.stat(file);
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (st.size > MAX_FILE) throw new Error(`${file} is larger than ${MAX_FILE / 1024} KB`);
  return fs.promises.readFile(file, 'utf8');
}

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** A missing file is not an error: that layer simply does not exist. */
async function loadLayerFile(file: string, name: string): Promise<{ layer?: Layer; diagnostics: Diagnostic[] }> {
  let raw: ConfigLayer;
  try {
    raw = YAML.parse(await readBounded(file)) ?? {};
  } catch (e) {
    if (missing(e)) return { diagnostics: [] };
    return { diagnostics: [{ level: 'error', code: 'yaml_invalid', source: file, message: `${file}: ${(e as Error).message}` }] };
  }
  const issues = validateConfigLayer(raw);
  if (issues.length) return { diagnostics: issues.map((m) => ({ level: 'error', code: 'config_invalid', source: file, message: `${name} config: ${m}` })) };
  return { layer: { name, baseDir: path.dirname(file), config: raw, file }, diagnostics: [] };
}

/**
 * The layers in order: built-in, the libraries (those the user config lists, then the project's), the user config,
 * the project config. A later layer wins field by field, so a project can change what a library defines.
 */
async function loadLayers({ workspace, home = os.homedir() }: { workspace: string; home?: string }): Promise<{ layers: Layer[]; diagnostics: Diagnostic[]; files: string[] }> {
  const diagnostics: Diagnostic[] = [];
  const own: Layer[] = [];
  const files: [string, string][] = [['user', userConfigFile(home)], ['project', projectConfigFile(workspace)]];
  // A workspace inside the home folder must not load the same file twice.
  if (path.resolve(files[0]![1]) === path.resolve(files[1]![1])) files.shift();
  for (const [name, file] of files) {
    const r = await loadLayerFile(file, name);
    diagnostics.push(...r.diagnostics);
    if (r.layer) own.push(r.layer);
  }
  const libraries: Layer[] = [];
  const seen = new Set<string>();
  for (const layer of own) {
    for (const entry of layer.config.libraries ?? []) {
      const file = libraryFile(entry, layer.baseDir, home);
      if (seen.has(file)) continue;
      seen.add(file);
      let label = libraryLabel(file);
      for (let n = 2; libraries.some((l) => l.name === `${LIBRARY_PREFIX}${label}`); n++) label = `${libraryLabel(file)}-${n}`;
      const r = await loadLibraryFile(file, label);
      diagnostics.push(...r.diagnostics);
      if (r.layer) libraries.push({ ...r.layer, listedBy: layer.name === 'project' ? 'project' : 'user' });
    }
  }
  // Every file a layer comes from or would come from: one created later is a new config too.
  return { layers: [builtinLayer(), ...libraries, ...own], diagnostics, files: [...files.map(([, file]) => file), ...seen] };
}

const LIBRARY_FILE = 'library.yaml';
/** Layer names of libraries: `library:<folder name>`. */
const LIBRARY_PREFIX = 'library:';
const isLibraryLayer = (name: string): boolean => name.startsWith(LIBRARY_PREFIX);

/** A library's file: the entry itself when it names a .yaml file, else library.yaml in that folder. `~` and relative paths resolve from the config that lists it. */
function libraryFile(entry: string, baseDir: string, home: string = os.homedir()): string {
  const abs = path.resolve(baseDir, entry.replace(/^~(?=$|[\\/])/, home));
  return /\.ya?ml$/i.test(abs) ? abs : path.join(abs, LIBRARY_FILE);
}

/** What a library is called on screen: its folder's name (or the file's, without .yaml). */
function libraryLabel(file: string): string {
  return path.basename(file) === LIBRARY_FILE ? path.basename(path.dirname(file)) : path.basename(file).replace(/\.ya?ml$/i, '');
}

/**
 * A library missing on this machine (a teammate's path, an unmounted disk) is a warning: the rest still loads, and a
 * scenario that needs its agents says so. A library that does not parse or holds more than agents and scenarios is an
 * error, as config.yaml would be.
 */
async function loadLibraryFile(file: string, label: string): Promise<{ layer?: Layer; diagnostics: Diagnostic[] }> {
  let raw: unknown;
  try {
    raw = YAML.parse(await readBounded(file)) ?? {};
  } catch (e) {
    if (missing(e)) return { diagnostics: [{ level: 'warning', code: 'library_missing', source: file, message: `library "${label}" is not at ${file}; its agents and scenarios are not loaded` }] };
    return { diagnostics: [{ level: 'error', code: 'yaml_invalid', source: file, message: `${file}: ${(e as Error).message}` }] };
  }
  const issues = validateLibraryLayer(raw);
  if (issues.length) return { diagnostics: issues.map((m) => ({ level: 'error', code: 'library_invalid', source: file, message: `library "${label}": ${m}` })) };
  return { layer: { name: `${LIBRARY_PREFIX}${label}`, baseDir: path.dirname(file), config: raw as ConfigLayer, file }, diagnostics: [] };
}

// ---------- merging ----------

const defined = <T extends object>(obj: T): Partial<T> => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

function toOp(layer: Layer, input: InstructionsInput | undefined): InstructionOp | undefined {
  if (input === undefined) return undefined;
  const dir = layer.baseDir;
  if (typeof input === 'string') return { mode: 'replace', text: input, source: `${layer.name} (inline)`, dir, layer: layer.name };
  const mode = input.mode || 'replace';
  if (input.file !== undefined) {
    const file = path.resolve(layer.baseDir, input.file);
    return { mode, file, source: file, dir, layer: layer.name };
  }
  return { mode, text: input.text ?? '', source: `${layer.name} (inline)`, dir, layer: layer.name };
}

function mergeLayers(layers: Layer[]): Merged {
  const merged: Merged = { agents: new Map(), limits: {}, repos: new Map(), jira: {}, policy: {}, scenarios: {}, groups: {}, instructions: {}, origins: {} };
  for (const layer of layers) {
    const c = layer.config;
    for (const [name, agent] of Object.entries(c.agents ?? {})) {
      const { instructions, ...fields } = agent;
      const prev: Draft = merged.agents.get(name) ?? { ops: [], layers: [] };
      const op = toOp(layer, instructions);
      merged.agents.set(name, { ...prev, ...defined(fields), ops: op ? [...prev.ops, op] : prev.ops, layers: [...prev.layers, layer.name] });
    }
    for (const [name, repo] of Object.entries(c.repos ?? {})) merged.repos.set(name, { ...merged.repos.get(name), ...defined(repo) });
    if (c.pipeline) merged.pipeline = { names: [...c.pipeline], source: layer.name };
    // A later layer replaces a whole scenario: its list, `false` (removed) or a custom scenario.
    for (const [name, value] of Object.entries(c.scenarios ?? {})) merged.scenarios[name] = { value: clone(value), source: layer.name };
    // Groups and instructions too: a later layer replaces the whole entry.
    Object.assign(merged.groups, clone(c.groups ?? {}));
    Object.assign(merged.instructions, clone(c.instructions ?? {}));
    if (c.limits) merged.limits = { ...merged.limits, ...defined(c.limits) };
    if (c.language) merged.language = c.language;
    if (c.baseBranch) merged.baseBranch = c.baseBranch;
    if (c.jira && c.jira.allowedProjects) merged.jira = { allowedProjects: [...c.jira.allowedProjects] };
    if (c.policy) merged.policy = { ...merged.policy, ...defined(c.policy) };
    if (c.git && c.git.mode) merged.gitMode = c.git.mode;
    if (c.context) merged.context = c.context.map((f) => path.resolve(layer.baseDir, f));
  }
  return merged;
}

/** `only` enables exactly the named agents, `no` then disables names; both refer to known agents. */
function applyFlags(merged: Merged, flags: Flags, diagnostics: Diagnostic[]): void {
  const no = flags.no ?? [];
  const only = flags.only ?? [];
  for (const name of new Set([...no, ...only])) {
    if (!merged.agents.has(name)) diagnostics.push({ level: 'error', code: 'unknown_flag_agent', agent: name, source: 'flags', message: `flag names unknown agent "${name}"` });
  }
  for (const name of only.filter((n) => no.includes(n))) {
    diagnostics.push({ level: 'error', code: 'conflicting_flags', agent: name, source: 'flags', message: `"${name}" is both in --only and --no` });
  }
  if (only.length > 0) for (const [name, draft] of merged.agents) draft.enabled = only.includes(name);
  for (const name of no) {
    const draft = merged.agents.get(name);
    if (draft) draft.enabled = false;
  }
}

// ---------- resolving ----------

/**
 * Resolves layers into a config. Pure: the instruction and context files it names come in `readFile`, read beforehand
 * (`readConfig`); without one, a layer that names a file gets a diagnostic for it.
 */
function resolveConfig(layers: Layer[], opts: { flags?: Flags | undefined; readFile?: ReadFile | undefined } = {}): ResolveResult {
  const readFile: ReadFile =
    opts.readFile ??
    ((p) => {
      throw new Error(`${p} was not read`);
    });
  // The files the config is made of besides its layers: instruction and context files.
  const sources = new Set(layers.flatMap((l) => (l.file ? [l.file] : [])));
  const read: ReadFile = (p) => {
    sources.add(p);
    return readFile(p);
  };
  const diags: Diagnostic[] = [];
  const merged = mergeLayers(layers);
  applyFlags(merged, opts.flags ?? {}, diags);

  const inherited = resolveExtends(merged.agents, diags);
  const agents: Record<string, Agent> = {};
  for (const [name, draft] of merged.agents) {
    const base = inherited.get(name);
    if (!base) continue;
    const enabled = draft.enabled ?? true;
    const level = enabled ? 'error' : 'warning';

    if (!base.description) diags.push({ level: 'error', code: 'missing_description', agent: name, message: `agent "${name}" needs a description (or extends an agent that has one)` });
    if (!base.output) diags.push({ level: 'error', code: 'missing_output', agent: name, message: `agent "${name}" needs an output: plan, code, tests or verdict (or extends an agent that has one)` });

    const instructions = applyOps(base.ops, read, (op, err) =>
      diags.push({ level, code: 'instructions_unreadable', agent: name, source: op.source, message: `cannot read instructions for "${name}": ${err}` })
    );
    if (enabled && instructions.trim() === '') diags.push({ level: 'warning', code: 'empty_instructions', agent: name, message: `agent "${name}" has no instructions` });
    if (!base.description || !base.output) continue;
    if (base.runs && base.output !== 'code' && base.output !== 'tests') diags.push({ level: 'warning', code: 'runs_ignored', agent: name, message: `"${name}" has runs: ${base.runs}, which only applies to code and tests agents` });

    agents[name] = {
      name,
      enabled,
      lineage: base.lineage,
      description: base.description,
      model: base.model ?? 'inherit',
      // An agent always runs with a list of tools: without one Claude Code would offer every tool it has, among them
      // ones that reach outside the sandbox or run commands the guard never reads.
      tools: base.tools ?? (base.output === 'code' || base.output === 'tests' ? WRITE : READ_ONLY),
      ...(base.disallowedTools && { disallowedTools: base.disallowedTools }),
      ...(base.mcp !== undefined && { mcp: base.mcp }),
      ...(base.maxTurns !== undefined && { maxTurns: base.maxTurns }),
      ...(base.effort && { effort: base.effort }),
      ...(base.runs && { runs: base.runs }),
      ...(base.color && { color: base.color }),
      output: base.output,
      instructions,
      instructionSources: base.ops.map((o) => ({ mode: o.mode, source: o.source })),
      layers: draft.layers,
    };
  }

  const { scenarios, removed } = resolveScenarios(merged.scenarios, merged.agents, agents, diags);
  const custom = resolveCustomScenarios(merged.scenarios, merged.agents, agents, diags);
  const inCustom = Object.values(custom).flatMap((s) => s.agents.map((st) => st.name));
  const pipeline = resolvePipeline(merged.pipeline, merged.agents, diags, scenarios, inCustom);
  for (const name of pipeline) {
    const a = agents[name];
    if (a && Object.values(SCENARIO_OUTPUT).includes(a.output)) {
      diags.push({ level: 'error', code: 'report_agent_in_pipeline', agent: name, message: `"${name}" writes a ${a.output} report; list it under scenarios.${a.output}, not in the pipeline` });
    }
  }

  // An agent nothing runs (a library's, not in the pipeline or a scenario) with unreadable instructions is a warning:
  // the rest of the config works, and the agent says so when something starts to use it.
  const used = new Set([...pipeline, ...Object.values(scenarios).flat(), ...inCustom]);
  for (const d of diags) if (d.code === 'instructions_unreadable' && d.agent && !used.has(d.agent)) d.level = 'warning';

  const context = merged.context ?? [];
  for (const file of context) {
    try {
      read(file);
    } catch {
      diags.push({ level: 'warning', code: 'context_missing', source: file, message: `context file ${file} cannot be read; agents will not get it` });
    }
  }

  const baseBranch = merged.baseBranch ?? 'main';
  const repos: Record<string, RepoConfig> = {};
  for (const [name, repo] of merged.repos) {
    repos[name] = { name, ...(repo.role && { role: repo.role }), path: repo.path ?? name, baseBranch: repo.baseBranch ?? baseBranch, gates: repo.gates ?? [] };
  }

  // A group ticks only instructions that exist; one it names that is gone is left out, not an error.
  const groups: Record<string, TaskGroup> = {};
  for (const [id, g] of Object.entries(merged.groups)) {
    const ticks = g.defaultInstructions ?? [];
    for (const x of ticks.filter((t) => !merged.instructions[t])) diags.push({ level: 'warning', code: 'unknown_instruction', message: `group "${id}" ticks the instruction "${x}", which is not defined; it is left out` });
    const known = ticks.filter((t) => merged.instructions[t]);
    groups[id] = { id, type: g.type, label: g.label, ...(g.jira && { jira: g.jira }), ...(g.instructions && { instructions: g.instructions }), ...(known.length && { defaultInstructions: known }) };
  }

  const errors = diags.filter((d) => d.level === 'error');
  const warnings = diags.filter((d) => d.level === 'warning');
  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    warnings,
    config: {
      agents,
      pipeline,
      scenarios,
      custom,
      removedScenarios: removed,
      pipelineSource: merged.pipeline ? merged.pipeline.source : 'agents',
      limits: {
        reviewRounds: merged.limits.reviewRounds ?? 2,
        gateAttempts: merged.limits.gateAttempts ?? 3,
        ...(merged.limits.budgetUsd !== undefined && merged.limits.budgetUsd > 0 && { budgetUsd: merged.limits.budgetUsd }),
        ...(merged.limits.parallelTasks !== undefined && { parallelTasks: merged.limits.parallelTasks }),
      },
      language: merged.language ?? 'English',
      baseBranch,
      repos,
      jira: { allowedProjects: merged.jira.allowedProjects ?? [] },
      policy: {
        protectedBranches: merged.policy.protectedBranches ?? ['main', 'master'],
        draftPrsOnly: merged.policy.draftPrsOnly ?? true,
        forbidAiAttribution: merged.policy.forbidAiAttribution ?? false,
        allowNoVerify: merged.policy.allowNoVerify ?? false,
        sandbox: merged.policy.sandbox ?? true,
        localPorts: merged.policy.localPorts ?? false,
        network: merged.policy.network ?? [],
        writable: merged.policy.writable ?? [],
        checkEnv: merged.policy.checkEnv ?? [],
      },
      context,
      git: { mode: merged.gitMode ?? 'branch' },
      groups,
      instructions: Object.fromEntries(Object.entries(merged.instructions).map(([id, x]) => [id, { id, label: x.label, text: x.text }])),
      sources: [...sources],
    },
  };
}

/** Walks `extends` for every agent. Agents in a cycle or with a missing base map to nothing. */
function resolveExtends(drafts: Map<string, Draft>, diags: Diagnostic[]): Map<string, Inherited> {
  const done = new Map<string, Inherited | null>();
  const visit = (name: string, stack: string[]): Inherited | null => {
    if (done.has(name)) return done.get(name)!;
    if (stack.includes(name)) {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(' → ');
      diags.push({ level: 'error', code: 'extends_cycle', agent: name, message: `extends cycle: ${cycle}` });
      for (const member of stack.slice(stack.indexOf(name))) done.set(member, null);
      return null;
    }
    const draft = drafts.get(name)!;
    let base: Inherited = { lineage: [], ops: [] };
    if (draft.extends !== undefined) {
      if (!drafts.has(draft.extends)) {
        diags.push({ level: 'error', code: 'extends_unknown', agent: name, message: `agent "${name}" extends unknown agent "${draft.extends}"` });
        done.set(name, null);
        return null;
      }
      const parent = visit(draft.extends, [...stack, name]);
      if (parent === null) {
        if (!done.has(name)) {
          diags.push({ level: 'error', code: 'extends_invalid_base', agent: name, message: `agent "${name}" extends "${draft.extends}", which cannot be resolved` });
          done.set(name, null);
        }
        return null;
      }
      base = parent;
    }
    const result: Inherited = {
      lineage: [...base.lineage, name],
      description: draft.description ?? base.description,
      model: draft.model ?? base.model,
      tools: draft.tools ?? base.tools,
      disallowedTools: draft.disallowedTools ?? base.disallowedTools,
      mcp: draft.mcp ?? base.mcp,
      maxTurns: draft.maxTurns ?? base.maxTurns,
      effort: draft.effort ?? base.effort,
      runs: draft.runs ?? base.runs,
      color: draft.color ?? base.color,
      output: draft.output ?? base.output,
      ops: [...base.ops, ...draft.ops],
    };
    done.set(name, result);
    return result;
  };
  const out = new Map<string, Inherited>();
  for (const name of drafts.keys()) {
    const r = visit(name, []);
    if (r) out.set(name, r);
  }
  return out;
}

function applyOps(ops: InstructionOp[], read: ReadFile, onError: (op: InstructionOp, message: string) => void): string {
  let text = '';
  for (const op of ops) {
    let fragment: string;
    if (op.file !== undefined) {
      try {
        fragment = read(op.file);
      } catch (e) {
        onError(op, (e as Error).message);
        continue;
      }
    } else fragment = op.text ?? '';
    // A library's instructions can point at its own files (SQL, templates) wherever the library is kept.
    fragment = fragment.replaceAll('{{dir}}', op.dir).trim();
    if (op.mode === 'replace') text = fragment;
    else if (!fragment) continue;
    else if (!text) text = fragment;
    else text = op.mode === 'append' ? `${text}\n\n${fragment}` : `${fragment}\n\n${text}`;
  }
  return text;
}

/** The agents of each built-in report scenario. They must exist and produce that scenario's report. A removed one has none. */
function resolveScenarios(merged: Record<string, ScenarioEntry>, drafts: Map<string, Draft>, agents: Record<string, Agent>, diags: Diagnostic[]): { scenarios: Record<string, string[]>; removed: string[] } {
  const out: Record<string, string[]> = {};
  const removed: string[] = [];
  for (const [scenario, output] of Object.entries(SCENARIO_OUTPUT)) {
    const entry = merged[scenario];
    if (entry && entry.value === false) removed.push(scenario);
    const names: string[] = entry && Array.isArray(entry.value) ? entry.value : [];
    const seen = new Set<string>();
    for (const name of names) {
      if (!drafts.has(name)) diags.push({ level: 'error', code: 'scenario_unknown_agent', agent: name, source: entry!.source, message: `scenarios.${scenario} names unknown agent "${name}"` });
      else if (agents[name] && agents[name].output !== output) diags.push({ level: 'error', code: 'scenario_wrong_output', agent: name, source: entry!.source, message: `scenarios.${scenario} lists "${name}", which produces ${agents[name].output}, not ${output}` });
      if (seen.has(name)) diags.push({ level: 'error', code: 'scenario_duplicate', agent: name, source: entry!.source, message: `scenarios.${scenario} lists "${name}" more than once` });
      seen.add(name);
    }
    out[scenario] = names;
  }
  return { scenarios: out, removed };
}

/**
 * Custom scenarios: `{ id: { id, label, description, kind, agents: [{ name, model?, effort? }] } }`. Their kind is
 * `deliver` when the agents change code, else the report they all write; `null` while a scenario has no agents.
 */
function resolveCustomScenarios(merged: Record<string, ScenarioEntry>, drafts: Map<string, Draft>, agents: Record<string, Agent>, diags: Diagnostic[]): Record<string, CustomScenario> {
  const out: Record<string, CustomScenario> = {};
  for (const [id, entry] of Object.entries(merged)) {
    if (SCENARIO_OUTPUT[id] || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) continue;
    const def = entry.value;
    const steps: ScenarioStep[] = def.agents.map((st) => (typeof st === 'string' ? { name: st } : { name: st.agent, ...(st.model && { model: st.model }), ...(st.effort && { effort: st.effort }) }));
    const seen = new Set<string>();
    const kinds = new Set<string>();
    for (const { name } of steps) {
      if (!drafts.has(name)) diags.push({ level: 'error', code: 'scenario_unknown_agent', agent: name, source: entry.source, message: `scenario "${id}" names unknown agent "${name}"` });
      if (seen.has(name)) diags.push({ level: 'error', code: 'scenario_duplicate', agent: name, source: entry.source, message: `scenario "${id}" lists "${name}" more than once` });
      seen.add(name);
      if (agents[name]) kinds.add(Object.values(SCENARIO_OUTPUT).includes(agents[name]!.output) ? agents[name]!.output : 'deliver');
    }
    if (kinds.size > 1) {
      diags.push({ level: 'error', code: 'scenario_mixed', source: entry.source, message: `scenario "${id}" mixes agents that change code with report agents (${[...kinds].join(', ')}); keep one kind per scenario` });
    }
    out[id] = { id, label: def.label || id, ...(def.description && { description: def.description }), kind: kinds.size ? [...kinds][0]! : null, agents: steps, source: entry.source };
  }
  return out;
}

/** `elsewhere`: agents a custom scenario runs, so they are not reported as never running. */
function resolvePipeline(pipeline: Merged['pipeline'], drafts: Map<string, Draft>, diags: Diagnostic[], scenarios: Record<string, string[]> = {}, elsewhere: string[] = []): string[] {
  const inScenario = new Set(Object.values(scenarios).flat());
  const used = new Set([...inScenario, ...elsewhere]);
  // An agent only a library defines is there to be picked (for a scenario, or into the pipeline), not run by default.
  const fromLibraryOnly = (d: Draft): boolean => d.layers.length > 0 && d.layers.every(isLibraryLayer);
  const names = pipeline ? pipeline.names : [...drafts.keys()].filter((n) => !inScenario.has(n) && !fromLibraryOnly(drafts.get(n)!));
  const source = pipeline && pipeline.source;
  const seen = new Set<string>();
  for (const name of names) {
    if (!drafts.has(name)) diags.push({ level: 'error', code: 'pipeline_unknown_agent', agent: name, source, message: `pipeline names unknown agent "${name}"` });
    if (seen.has(name)) diags.push({ level: 'error', code: 'pipeline_duplicate', agent: name, source, message: `pipeline lists "${name}" more than once` });
    seen.add(name);
  }
  for (const [name, draft] of drafts) {
    if ((draft.enabled ?? true) && !seen.has(name) && !used.has(name) && !fromLibraryOnly(draft)) diags.push({ level: 'warning', code: 'not_in_pipeline', agent: name, message: `agent "${name}" is enabled but not in the pipeline, so it never runs` });
    const libs = draft.layers.filter(isLibraryLayer);
    if (libs.length > 1) diags.push({ level: 'warning', code: 'library_conflict', agent: name, message: `agent "${name}" is defined in ${libs.map((l) => l.slice(LIBRARY_PREFIX.length)).join(' and ')}; the last one wins` });
  }
  return names;
}

/** Loads every layer and resolves it. */
/** Size and mtime of each file, '' for one that is not there: equal signatures, the same config. */
const signatureOf = async (files: string[]): Promise<string> =>
  (
    await Promise.all(
      files.map((f) =>
        fs.promises.stat(f).then(
          (st) => `${f}:${st.size}:${st.mtimeMs}`,
          () => `${f}:`
        )
      )
    )
  ).join('\n');

/** Configs already read, by workspace, home and flags, with the signature of the files they came from. */
const loaded = new Map<string, { signature: string; sources: string[]; result: ResolveResult }>();

/**
 * The config, read again only when one of the files it comes from changed: the engine and the dashboard ask for it on
 * every stage and screen refresh, and reading means parsing every layer and reading every instruction file.
 */
async function loadConfig({ workspace, home, flags }: { workspace: string; home?: string | undefined; flags?: Flags | undefined }): Promise<ResolveResult> {
  const key = JSON.stringify([workspace, home ?? null, flags ?? null]);
  const hit = loaded.get(key);
  if (hit && (await signatureOf(hit.sources)) === hit.signature) return structuredClone(hit.result);
  const result = await readConfig({ workspace, home, flags });
  // A config with errors names no files; it is read again next time.
  if (result.ok) loaded.set(key, { signature: await signatureOf(result.config.sources), sources: result.config.sources, result: structuredClone(result) });
  else loaded.delete(key);
  return result;
}

const within = (abs: string, root: string): boolean => abs === root || abs.startsWith(root + path.sep);
/** A path with its links followed; one that is not there yet, from its nearest folder that is. */
async function realOrSame(p: string): Promise<string> {
  const rest: string[] = [];
  for (let cur = path.resolve(p); ; ) {
    try {
      return path.join(await fs.promises.realpath(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
/** Folders whose files are the system's, not text: `/proc/self/environ` reads as a file of your environment. */
const SYSTEM_DIRS = ['/proc', '/sys', '/dev'];

/** Whether a path is one of SECRET_PATHS (`~/.ssh`, `~/.claude*\/.credentials.json`) or inside one. */
function secretPath(abs: string, home: string): boolean {
  return SECRET_PATHS.some((p) => {
    const parts = p.replace(/^~(?=\/)/, home).split('/');
    const re = new RegExp(`^${parts.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('/')}(/|$)`);
    return re.test(abs.split(path.sep).join('/'));
  });
}

/**
 * Why an agent's instruction file may not be read, or null. Its text goes into the agent's system prompt, so a
 * project's config (a repo someone else wrote) names one inside the workspace, and a library one inside the library;
 * no config names a credential or a system file.
 */
async function instructionFileProblem(op: InstructionOp, workspace: string, home: string): Promise<string | null> {
  const file = op.file!;
  const real = await realOrSame(file);
  if (SYSTEM_DIRS.some((d) => within(real, d))) return `${file} is a system file, not instructions`;
  if (secretPath(real, await realOrSame(home)) || secretPath(path.resolve(file), home)) return `${file} holds credentials, not instructions`;
  // A dotenv file anywhere: the agents may not read it (Claude Code's deny rules), so no config puts it into their prompt.
  if (ENV_FILE.test(path.basename(real)) || ENV_FILE.test(path.basename(file))) return `${file} is a dotenv file, which holds credentials, not instructions`;
  const root = op.layer === 'project' ? workspace : isLibraryLayer(op.layer) ? op.dir : null;
  if (root && !within(real, await realOrSame(root))) return `${file} is outside ${op.layer === 'project' ? 'the workspace' : `the library (${op.dir})`}: ${op.layer === 'project' ? "a project's config names instruction files in the workspace" : 'a library names instruction files in its own folder'}`;
  return null;
}

/** `policy.writable` entries that open your home folder, one above it or the whole disk to sandboxed commands. */
function tooWide(writable: string[], home: string): string[] {
  const homeDir = path.resolve(home);
  return writable.filter((w) => {
    const abs = path.resolve(w.replace(/^~(?=$|[\\/])/, homeDir));
    return abs === path.parse(abs).root || within(homeDir, abs);
  });
}

/** Reads the layers, then every instruction and context file they name, then resolves them (`resolveConfig`). */
async function readConfig({ workspace, home, flags }: { workspace: string; home?: string | undefined; flags?: Flags | undefined }): Promise<ResolveResult> {
  const { layers, diagnostics, files } = await loadLayers({ workspace, ...(home && { home }) });
  const loadErrors = diagnostics.filter((d) => d.level === 'error');
  if (loadErrors.length) return { ok: false, errors: loadErrors, warnings: diagnostics.filter((d) => d.level === 'warning') };
  const merged = mergeLayers(layers);
  const homeDir = home ?? os.homedir();
  const wide = tooWide(merged.policy.writable ?? [], homeDir);
  if (wide.length) {
    const error: Diagnostic = { level: 'error', code: 'writable_too_wide', message: `policy.writable opens ${wide.join(', ')} to sandboxed commands: your home folder, a folder above it or the whole disk. Name the folder a tool writes (~/.cache/go-build)` };
    return { ok: false, errors: [error], warnings: diagnostics.filter((d) => d.level === 'warning') };
  }
  // A file no layer may name is not read: it counts as one that cannot be read (an error for an agent that runs).
  const refused = new Map<string, Error>();
  for (const op of [...merged.agents.values()].flatMap((d) => d.ops)) {
    const problem = op.file !== undefined && !refused.has(op.file) ? await instructionFileProblem(op, workspace, homeDir) : null;
    if (problem) refused.set(op.file!, new Error(problem));
  }
  const named = [...new Set([...[...merged.agents.values()].flatMap((d) => d.ops.flatMap((op) => (op.file !== undefined ? [op.file] : []))), ...(merged.context ?? [])])];
  const read = new Map(await Promise.all(named.map(async (f): Promise<[string, string | Error]> => [f, refused.get(f) ?? (await readBounded(f).catch((e: Error) => e))])));
  const readFile: ReadFile = (p) => {
    const v = read.get(p);
    if (v === undefined) throw new Error(`${p} was not read`);
    if (v instanceof Error) throw v;
    return v;
  };
  const r = resolveConfig(layers, { flags, readFile });
  if (r.ok) r.config.sources = [...new Set([...files, ...r.config.sources])];
  return { ...r, warnings: [...diagnostics, ...loosened(layers), ...r.warnings] };
}

/**
 * What the project config, and the libraries it lists, relax of the safety and the spending limits the layers under
 * them (yours, your libraries, the defaults) set. A repo someone else wrote can carry that file and those libraries,
 * and the dashboard's Safety switches write it too: either way it is said wherever the config's warnings show, not
 * applied silently.
 */
function loosened(layers: Layer[]): Diagnostic[] {
  const project = layers.find((l) => l.name === 'project');
  if (!project) return [];
  const brought = layers.filter((l) => l.listedBy === 'project');
  const under = mergeLayers(layers.filter((l) => l !== project && !brought.includes(l)));
  const was = { sandbox: true, localPorts: false, allowNoVerify: false, draftPrsOnly: true, forbidAiAttribution: false, protectedBranches: ['main', 'master'], ...under.policy };
  const p = project.config.policy ?? {};
  const out: string[] = [];
  if (p.sandbox === false && was.sandbox) out.push("turns the sandbox off: agents' commands, checks and git hooks run without it");
  if (p.network && p.network.includes('*')) out.push('lets sandboxed commands reach any host (network: "*")');
  if (p.localPorts === true && !was.localPorts) out.push('lets sandboxed commands open local ports and reach every service listening on this machine (localPorts)');
  if (p.allowNoVerify === true && !was.allowNoVerify) out.push('lets git hooks be skipped (allowNoVerify)');
  if (p.draftPrsOnly === false && was.draftPrsOnly) out.push('opens PRs ready for review instead of as drafts');
  if (p.forbidAiAttribution === false && was.forbidAiAttribution) out.push('allows AI attribution in commits and PRs');
  const unprotected = p.protectedBranches ? was.protectedBranches.filter((b) => !p.protectedBranches!.includes(b)) : [];
  if (unprotected.length) out.push(`no longer protects ${unprotected.join(', ')}`);
  const added = (mine: string[] | undefined, theirs: string[] | undefined): string[] => (mine ?? []).filter((x) => x !== '*' && !(theirs ?? []).includes(x));
  const network = added(p.network, under.policy.network);
  if (network.length) out.push(`lets sandboxed commands and MCP reads reach ${network.join(', ')}`);
  const writable = added(p.writable, under.policy.writable);
  if (writable.length) out.push(`lets sandboxed commands, checks and git hooks write ${writable.join(', ')}`);
  const checkEnv = added(p.checkEnv, under.policy.checkEnv);
  const github = checkEnv.filter((v) => GITHUB_TOKENS.includes(v));
  if (checkEnv.length) out.push(`hands ${checkEnv.join(', ')} to checks and git hooks${github.length ? ` (${github.join(', ')}: a GitHub token, which can push and merge)` : ''}`);
  const projects = project.config.jira && project.config.jira.allowedProjects;
  const allowed = under.jira.allowedProjects ?? [];
  if (projects && allowed.length && (!projects.length || projects.some((k) => !allowed.includes(k)))) out.push(projects.length ? `allows Jira projects you did not (${projects.filter((k) => !allowed.includes(k)).join(', ')})` : 'allows every Jira project, where your config allows some');
  // What a task may spend: a library holds no limits, so only the project's config can raise them.
  const limits = project.config.limits ?? {};
  const cap = under.limits.budgetUsd ?? 0;
  if (cap > 0 && limits.budgetUsd === 0) out.push(`removes the $${cap} budget cap of a task (limits.budgetUsd: 0): a task spends without a limit`);
  else if (cap > 0 && limits.budgetUsd !== undefined && limits.budgetUsd > cap) out.push(`raises the budget cap of a task from $${cap} to $${limits.budgetUsd} (limits.budgetUsd)`);
  const rounds = under.limits.reviewRounds ?? 2;
  if (limits.reviewRounds !== undefined && limits.reviewRounds > rounds) out.push(`raises the review rounds of a task from ${rounds} to ${limits.reviewRounds} (limits.reviewRounds)`);
  const attempts = under.limits.gateAttempts ?? 3;
  if (limits.gateAttempts !== undefined && limits.gateAttempts > attempts) out.push(`raises the attempts at red checks from ${attempts} to ${limits.gateAttempts} (limits.gateAttempts)`);
  const diag = (layer: Layer, m: string): Diagnostic => ({ level: 'warning', code: 'policy_loosened', source: layer.file, message: `${layer === project ? `the project's config (${CONFIG_DIR}/${CONFIG_FILE})` : `the library "${layer.name.slice(LIBRARY_PREFIX.length)}" the project's config lists`} ${m}` });
  // Agents, from the project's config and from the libraries it lists, which can only bring agents and scenarios.
  const agents: Diagnostic[] = [];
  for (const layer of [...brought, project]) {
    for (const [name, agent] of Object.entries(layer.config.agents ?? {})) {
      const was = under.agents.get(name);
      const before = (was && was.tools) ?? [];
      const reach = (agent.tools ?? []).filter((t) => (t === 'WebFetch' || t === 'WebSearch' || t.startsWith('WebFetch(') || t.startsWith('mcp__')) && !before.includes(t));
      if (reach.length) agents.push(diag(layer, `gives the ${name} agent ${reach.join(', ')}, which reach${reach.length === 1 ? 'es' : ''} outside the sandbox`));
      if (agent.mcp === true && was && was.mcp === false) agents.push(diag(layer, `turns MCP servers on for the ${name} agent, which reads through them outside the sandbox`));
    }
  }
  return [...out.map((m) => diag(project, m)), ...agents];
}

/**
 * What agents never change, whatever their stage: the workspace's config folder, the task state, and every file the
 * config comes from (library and instruction files may sit inside a repo). An agent that could would turn its own
 * sandbox off or add a gate the next stage runs, and that change never shows in a diff.
 */
function configPaths(workspace: string, config: Pick<Config, 'sources'>): string[] {
  const orch = (p: string): string => path.join(workspace, ORCH_DIR, p);
  // All of .orch but the worktrees, where agents work: what Claudestrator itself writes there (the checks' logs too).
  return [...new Set([path.join(workspace, CONFIG_DIR), orch('tasks'), orch('current'), orch('gates'), orch('.gitignore'), ...config.sources.map((f) => path.resolve(f))])];
}

// ---------- editing the project layer ----------

/** A file's text, or null when it is not there. */
async function readIfThere(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/**
 * In a change `withConfigRollback` runs: the files it edits or writes, each with the text it last wrote there
 * (`undefined`: it set out to edit the file and wrote nothing). Its rollback restores only a file that still holds that.
 */
const changeWrites = new AsyncLocalStorage<Map<string, string | undefined>>();

/** Writes a file whole (`writeAtomic`) and notes it for the change that runs, if one does. */
async function writeMaking(file: string, text: string): Promise<void> {
  await writeAtomic(file, text);
  const wrote = changeWrites.getStore();
  if (wrote) wrote.set(path.resolve(file), text);
}

/** Whether the edit running now was started inside another one (an agent added with its scenario set). */
const inEdit = new AsyncLocalStorage<true>();
let edits: Promise<unknown> = Promise.resolve();

/**
 * Config edits run one at a time, each reading the files as the one before left them: two quick clicks never write
 * over each other, and a rollback never undoes another edit. An edit inside one that runs runs at once.
 */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  if (inEdit.getStore()) return fn();
  const run = edits.then(() => inEdit.run(true, fn));
  edits = run.catch(() => undefined);
  return run;
}

/** The project layer as plain data ({} when the file does not exist or does not parse). */
async function readProjectLayer(workspace: string): Promise<ConfigLayer> {
  try {
    return YAML.parse((await readIfThere(projectConfigFile(workspace))) ?? '') ?? {};
  } catch {
    return {};
  }
}

/**
 * Edits the project layer in place, keeping comments and formatting, and refuses a result
 * that no longer validates. Returns the file path.
 */
function editProjectConfig(workspace: string, mutate: (doc: YAML.Document) => unknown): Promise<string> {
  return editYamlFile(projectConfigFile(workspace), mutate, { validate: validateConfigLayer, what: `${CONFIG_DIR}/${CONFIG_FILE}` });
}

/**
 * Edits a YAML file in place, keeping comments and formatting, and refuses a result `validate` finds problems in.
 * The project config, the user config and library files are all edited this way. Returns the file.
 */
function editYamlFile(file: string, mutate: (doc: YAML.Document) => unknown, { validate, what }: { validate: (raw: unknown) => string[]; what: string }): Promise<string> {
  return serialized(async () => {
    const wrote = changeWrites.getStore();
    if (wrote && !wrote.has(path.resolve(file))) wrote.set(path.resolve(file), undefined);
    const read = await signature(file);
    const text = await readIfThere(file);
    const doc = YAML.parseDocument(text ?? '');
    if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0]!.message}`);
    if (doc.contents === null) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
    mutate(doc);
    // An agent left with no fields changes nothing; a repo with none is still a repo (`api: {}`: at ./api, base main).
    pruneEmpty(doc, ['agents']);
    const issues = validate(doc.toJS() ?? {});
    if (issues.length) throw new Error(`the change would make ${what} invalid: ${issues.join('; ')}`);
    const out = text === null ? doc.toString(YAML_OUT) : inOwnFormatting(text, doc);
    if (out === text) return file;
    // Edits of this window take turns (serialized); another window or the CLI may have written it meanwhile.
    if ((await signature(file)) !== read) throw new Error(`${file} changed while it was being edited (in another window?); nothing was written, try again`);
    await writeMaking(file, out);
    return file;
  });
}

// ---------- writing a YAML file in its own formatting ----------

/** How the yaml library writes a document: a long line (a command, a role) stays one line, never folded at 80 columns. */
const YAML_OUT: YAML.ToStringOptions = { lineWidth: 0 };

/**
 * The edited document as the file had it, but for the lines the edit changed. The yaml library writes a document its
 * own way (`[ a, b ]` for `[a, b]`, one space before a comment, lists indented under their key, folded text joined), so
 * the lines the edit did not change are taken from the file as it is. When that merge does not mean exactly what the
 * edit does, the library's text is written.
 */
function inOwnFormatting(original: string, doc: YAML.Document): string {
  const after = doc.toString(YAML_OUT);
  const merged = keepUnchangedLines(original, YAML.parseDocument(original).toString(YAML_OUT), after);
  if (merged === null) return after;
  const check = YAML.parseDocument(merged);
  return check.errors.length === 0 && isDeepStrictEqual(check.toJS(), YAML.parse(after)) ? merged : after;
}

/** A line as far as its meaning goes: its indentation, then its text with any run of spaces as one, `[ a ]` as `[a]`. */
const spacing = (line: string): string => {
  const body = line.trimStart();
  return line.slice(0, line.length - body.length) + body.trimEnd().replace(/\s+/g, ' ').replace(/([[{]) /g, '$1').replace(/ ([\]}])/g, '$1');
};

/**
 * A three-way merge by lines. `before` is the library's text of `original`, `after` its text of the edited document.
 * The file's lines are paired with the library's lines that differ from them in spacing at most; a paired line, and the
 * lines between two pairs, are written as the file has them when the edit kept all their lines, else as `after` has
 * them. Null when the files are too long to compare line by line.
 */
function keepUnchangedLines(original: string, before: string, after: string): string | null {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const o = original.split(eol);
  const a = before.split('\n');
  const b = after.split('\n');
  const oa = commonLines(o.map(spacing), a.map(spacing));
  const ab = commonLines(a, b);
  if (!oa || !ab) return null;
  // The file in stretches, each with the library's lines for it: a paired line, or the lines between two pairs.
  const stretches: { o: [number, number]; a: [number, number] }[] = [];
  let [po, pa] = [0, 0];
  for (const [io, ia] of oa) {
    if (po < io || pa < ia) stretches.push({ o: [po, io], a: [pa, ia] });
    stretches.push({ o: [io, io + 1], a: [ia, ia + 1] });
    [po, pa] = [io + 1, ia + 1];
  }
  if (po < o.length || pa < a.length) stretches.push({ o: [po, o.length], a: [pa, a.length] });

  const keptAt = new Map(ab);
  const out: string[] = [];
  let next = 0; // the first line of `after` not written yet
  for (const { o: [o0, o1], a: [a0, a1] } of stretches) {
    const kept = Array.from({ length: a1 - a0 }, (_, k) => keptAt.get(a0 + k)).filter((x): x is number => x !== undefined);
    const first = kept[0];
    const last = kept[kept.length - 1];
    if (first === undefined || last === undefined) {
      // No line of the library's: the file's own (a second blank line), kept. Or every line the edit removed or changed:
      // what it wrote instead comes with the next stretch it kept.
      if (a0 === a1) out.push(...o.slice(o0, o1));
    } else if (kept.length === a1 - a0 && last - first === kept.length - 1) {
      // Kept whole: what the edit added before it, then the file's lines.
      out.push(...b.slice(next, first), ...o.slice(o0, o1));
      next = last + 1;
    } else {
      out.push(...b.slice(next, last + 1));
      next = last + 1;
    }
  }
  out.push(...b.slice(next));
  return out.join(eol);
}

/** The most pairs of lines `commonLines` compares (a table of this many cells): files of a few thousand lines. */
const MAX_LINE_PAIRS = 1_000_000;

/** Equal lines of `a` and `b` as index pairs, in order (their longest common subsequence); null for files too long. */
function commonLines(a: readonly string[], b: readonly string[]): [number, number][] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n * m > MAX_LINE_PAIRS) return null;
  // lcs[i * w + j]: how many lines the middles of a and b have in common from a[head + i] and b[head + j] on.
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = a[head + i] === b[head + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  }
  const pairs: [number, number][] = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[head + i] === b[head + j]) pairs.push([head + i++, head + j++]);
    else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) i++;
    else j++;
  }
  for (let k = 0; k < tail; k++) pairs.push([a.length - tail + k, b.length - tail + k]);
  return pairs;
}

/** A YAML collection node as far as the pruning looks at it. */
interface YamlCollection {
  items?: { key: { value?: unknown }; value?: { items?: unknown[] } }[];
}

function pruneEmpty(doc: YAML.Document, at: string[]): void {
  const node = doc.getIn(at, true) as YamlCollection | undefined;
  if (!node || !node.items) return;
  for (const item of [...node.items]) {
    const v = item.value;
    if (v && v.items && v.items.length === 0) doc.deleteIn([...at, (item.key.value ?? item.key) as string]);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keyOf = (pair: YAML.Pair): string => String(YAML.isScalar(pair.key) ? pair.key.value : pair.key);

/**
 * `value` written into the node that holds the old one, changing only what differs, so the comments in it and its
 * layout stay. A map keeps its keys' order and its flow or block style, and loses only the keys `value` lacks (or has
 * as `undefined`). A list keeps the items still in it; an item that changed where it stands (one check's command) is
 * edited in place, and a new map in it is written like most maps in it (`{ name: lint, cmd: … }`). A scalar keeps
 * its quotes and comment. A node of another kind is replaced, keeping the comments on it. Returns the node to use.
 */
function mergeNode(doc: YAML.Document, node: unknown, value: unknown): unknown {
  if (YAML.isMap(node) && isRecord(value)) {
    const want = new Map(Object.entries(value).filter(([, v]) => v !== undefined));
    node.items = node.items.filter((pair) => want.has(keyOf(pair)));
    for (const [key, v] of want) {
      const pair = node.items.find((p) => keyOf(p) === key);
      if (pair) pair.value = mergeNode(doc, pair.value, v);
      else node.set(key, doc.createNode(v));
    }
    return node;
  }
  if (YAML.isSeq(node) && Array.isArray(value)) {
    const items = [...node.items];
    const old: unknown[] = items.map((item) => (YAML.isNode(item) ? item.toJS(doc) : item));
    if (isDeepStrictEqual(old, value)) return node;
    const taken = new Set<number>();
    const same = value.map((v) => {
      const i = old.findIndex((o, k) => !taken.has(k) && isDeepStrictEqual(o, v));
      if (i !== -1) taken.add(i);
      return i;
    });
    const maps = items.filter((x) => YAML.isMap(x));
    const flow = maps.filter((x) => x.flow === true).length * 2 > maps.length;
    node.items = value.map((v, n) => {
      const i = same[n] ?? -1;
      if (i !== -1) return items[i];
      const here = n < items.length && !taken.has(n) ? items[n] : undefined;
      taken.add(n);
      const item = mergeNode(doc, here, v);
      if (YAML.isMap(item) && !items.includes(item)) item.flow = flow;
      return item;
    });
    return node;
  }
  if (YAML.isScalar(node) && (value === null || typeof value !== 'object')) {
    node.value = value;
    return node;
  }
  const fresh = doc.createNode(value);
  if (YAML.isNode(node)) {
    if (node.commentBefore) fresh.commentBefore = node.commentBefore;
    if (node.comment) fresh.comment = node.comment;
  }
  return fresh;
}

/** Writes `value` at `at` into what the file has there (`mergeNode`); `undefined` removes it. */
function writeIn(doc: YAML.Document, at: readonly string[], value: unknown): void {
  if (value === undefined) {
    if (doc.hasIn(at)) doc.deleteIn(at);
    return;
  }
  const node = doc.getIn(at, true);
  const next = node === undefined ? doc.createNode(value) : mergeNode(doc, node, value);
  if (next !== node) doc.setIn(at, next);
}

/** Writes a list of names at `at`: into the list there, or as a new one on one line (`[planner, developer]`). */
function writeNames(doc: YAML.Document, at: readonly string[], names: string[]): void {
  if (YAML.isSeq(doc.getIn(at, true))) return writeIn(doc, at, names);
  const node = doc.createNode(names);
  node.flow = true;
  doc.setIn(at, node);
}

/**
 * Renames the entry `from` of the map at `at` to `to` where it stands, with the comments on it. When `to` is taken,
 * `from` goes and what is written next goes into `to`.
 */
function renameIn(doc: YAML.Document, at: readonly string[], from: string, to: string): void {
  const map = doc.getIn(at, true);
  if (!YAML.isMap(map)) return;
  const pair = map.items.find((p) => keyOf(p) === from);
  if (!pair) return;
  if (map.items.some((p) => keyOf(p) === to)) map.items = map.items.filter((p) => p !== pair);
  else if (YAML.isScalar(pair.key)) pair.key.value = to;
  else pair.key = doc.createNode(to);
}

/** Sets (or, with `undefined`/null, removes) fields of one agent in the project config. */
async function updateAgentConfig(workspace: string, agent: string, patch: Record<string, unknown>): Promise<string> {
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null));
  const issues = validateAgentPatch(set);
  if (issues.length) throw new Error(`invalid agent change: ${issues.join('; ')}`);
  return editProjectConfig(workspace, (doc) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) doc.deleteIn(['agents', agent, key]);
      else writeIn(doc, ['agents', agent, key], value);
    }
  });
}

/** Replaces everything the project layer says about an agent with `layer` (a backup restores agents this way). */
async function setAgentLayer(workspace: string, agent: string, layer: AgentLayer): Promise<string> {
  return editProjectConfig(workspace, (doc) => writeIn(doc, ['agents', agent], defined(layer)));
}

/** Removes everything the project layer says about an agent: back to the user/built-in definition. */
async function resetAgentConfig(workspace: string, agent: string): Promise<string> {
  return editProjectConfig(workspace, (doc) => doc.deleteIn(['agents', agent]));
}

async function setScenario(workspace: string, scenario: string, agents: string[]): Promise<string> {
  return editProjectConfig(workspace, (doc) => writeNames(doc, ['scenarios', scenario], agents));
}

/**
 * Writes a custom scenario: `{ label, description?, agents: [{ name, model?, effort? }] }`. A step without its own model
 * or effort is written as the bare agent name. `oldId` renames it.
 */
async function setCustomScenario(workspace: string, id: string, def: { label: string; description?: string | undefined; agents: ScenarioStep[] }, oldId?: string): Promise<string> {
  const agents = def.agents.map((st) => (st.model || st.effort ? { agent: st.name, ...(st.model && { model: st.model }), ...(st.effort && { effort: st.effort }) } : st.name));
  return editProjectConfig(workspace, (doc) => {
    if (oldId && oldId !== id) renameIn(doc, ['scenarios'], oldId, id);
    writeIn(doc, ['scenarios', id], { label: def.label, description: def.description || undefined, agents });
  });
}

/** A custom scenario is deleted; a built-in report scenario is switched off with `false` so a lower layer cannot bring it back. */
async function removeScenario(workspace: string, id: string): Promise<string> {
  return editProjectConfig(workspace, (doc) => {
    if (SCENARIO_OUTPUT[id]) doc.setIn(['scenarios', id], false);
    else doc.deleteIn(['scenarios', id]);
    const node = doc.getIn(['scenarios'], true) as YamlCollection | undefined;
    if (node && node.items && node.items.length === 0) doc.deleteIn(['scenarios']);
  });
}

/**
 * Brings a removed built-in report scenario back. When the layers under the project (built in, libraries, your config)
 * still list its agents, the project's `false` goes and their list counts again, yours (`readiness: [verifier,
 * my-verifier]`) included. When they removed it too, the project lists the built-in agents.
 */
async function restoreScenario(workspace: string, id: string, { home }: { home?: string | undefined } = {}): Promise<string> {
  const { layers } = await loadLayers({ workspace, ...(home && { home }) });
  const under = mergeLayers(layers.filter((l) => l.name !== 'project')).scenarios[id];
  if (!under || !Array.isArray(under.value)) return setScenario(workspace, id, BUILTIN.scenarios[id] || []);
  return editProjectConfig(workspace, (doc) => {
    writeIn(doc, ['scenarios', id], undefined);
    const left = doc.getIn(['scenarios'], true);
    if (YAML.isMap(left) && left.items.length === 0) doc.deleteIn(['scenarios']);
  });
}

async function setPipeline(workspace: string, pipeline: string[]): Promise<string> {
  return editProjectConfig(workspace, (doc) => writeNames(doc, ['pipeline'], pipeline));
}

/** Sets any top-level path (e.g. ['limits', 'reviewRounds']); `undefined` removes it. */
async function setProjectValue(workspace: string, keyPath: string[], value: unknown): Promise<string> {
  return editProjectConfig(workspace, (doc) => {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0 && keyPath[0] !== 'pipeline')) doc.deleteIn(keyPath);
    else writeIn(doc, keyPath, value);
    // Drop parents left empty, e.g. `limits: {}`.
    for (let i = keyPath.length - 1; i > 0; i--) {
      const parent = doc.getIn(keyPath.slice(0, i), true) as YamlCollection | undefined;
      if (parent && parent.items && parent.items.length === 0) doc.deleteIn(keyPath.slice(0, i));
    }
  });
}

async function setRepo(workspace: string, name: string, layer: RepoLayer | undefined, oldName?: string): Promise<string> {
  return editProjectConfig(workspace, (doc) => {
    if (oldName && oldName !== name) renameIn(doc, ['repos'], oldName, name);
    writeIn(doc, ['repos', name], layer);
  });
}

/** Writes a fresh project config (setup wizard). Refuses to overwrite an existing one. */
function createProjectConfig(workspace: string, layer: ConfigLayer, header?: string): Promise<string> {
  return serialized(async () => {
    const file = projectConfigFile(workspace);
    if ((await readIfThere(file)) !== null) throw new Error(`${CONFIG_DIR}/${CONFIG_FILE} already exists`);
    const issues = validateConfigLayer(layer);
    if (issues.length) throw new Error(issues.join('; '));
    const doc = new YAML.Document(layer);
    if (header) doc.commentBefore = header;
    await writeMaking(file, doc.toString(YAML_OUT));
    return file;
  });
}

/**
 * Points an agent at its own instructions file (`.claudestrator/prompts/<name>.md`), seeding it with what
 * the agent resolves to today, so editing that file changes the agent. Returns the file.
 */
function ensureInstructionsFile(workspace: string, agentName: string, resolved?: { instructions?: string } | null): Promise<string> {
  return serialized(async () => {
    const rel = `./${PROMPTS_DIR}/${agentName}.md`;
    const file = path.join(workspace, CONFIG_DIR, PROMPTS_DIR, `${agentName}.md`);
    const current = await readProjectLayer(workspace);
    const own = current.agents && current.agents[agentName] && current.agents[agentName].instructions;
    const seed = `${(resolved && resolved.instructions) || ''}\n`;
    if (own && typeof own === 'object' && own.file) {
      const existing = path.resolve(path.join(workspace, CONFIG_DIR), own.file);
      if ((await readIfThere(existing)) === null) {
        // A missing file is created only in the config folder: a path in a config someone else wrote may lead anywhere.
        const dir = path.join(workspace, CONFIG_DIR);
        if (!existing.startsWith(dir + path.sep)) throw new Error(`${own.file} does not exist, and it is outside ${CONFIG_DIR}/; create it yourself, or point "${agentName}" at a file in ${CONFIG_DIR}/`);
        await writeMaking(existing, seed);
      }
      return existing;
    }
    if ((await readIfThere(file)) === null) await writeMaking(file, seed);
    await updateAgentConfig(workspace, agentName, { instructions: { mode: 'replace', file: rel } });
    return file;
  });
}

// ---------- changes that must leave a working config ----------

/** A path inside .claudestrator/, as config.yaml writes it: relative, with `/` (`./workspace.md` is `workspace.md`). */
function configRelative(workspace: string, file: string): string {
  return path.relative(path.join(workspace, CONFIG_DIR), file).split(path.sep).join('/');
}

/**
 * Runs `change` on the project and keeps it only if the config still resolves. Otherwise config.yaml, and every file
 * `change` named through `remember` before writing it, go back to what they were, and the problems are thrown: a config
 * that does not resolve would stop every task. `explain` picks the problems worth showing (all of them by default).
 * Only what this change wrote goes back: a config file another window (or the CLI) wrote meanwhile, an edit refused
 * because of that included, is left as that window wrote it.
 */
function withConfigRollback<T>({ workspace, home, explain }: { workspace: string; home?: string | undefined; explain?: (errors: Diagnostic[]) => Diagnostic[] }, change: (remember: (file: string) => Promise<void>) => T | Promise<T>): Promise<T> {
  return serialized(async () => {
    const saved = new Map<string, string | null>();
    // The files `change` said it writes; config.yaml is looked after even when it does not.
    const named = new Set<string>();
    const snapshot = async (file: string): Promise<void> => {
      if (!saved.has(file)) saved.set(file, await readIfThere(file));
    };
    const remember = async (file: string): Promise<void> => {
      named.add(path.resolve(file));
      await snapshot(file);
    };
    await snapshot(projectConfigFile(workspace));
    const wrote = changeWrites.getStore() ?? new Map<string, string | undefined>();
    try {
      const result = await changeWrites.run(wrote, () => change(remember));
      const after = await loadConfig({ workspace, home });
      if (!after.ok) {
        const shown = explain ? explain(after.errors) : after.errors;
        throw new Error((shown.length ? shown : after.errors).map((e) => e.message).join('; '));
      }
      return result;
    } catch (e) {
      for (const [file, content] of saved) {
        const now = await readIfThere(file);
        const key = path.resolve(file);
        // A file edited here goes back only if it holds what this change wrote; one written some other way, if `change`
        // named it (an instructions file it wrote or removed).
        if (now === content || (wrote.has(key) ? wrote.get(key) !== now : !named.has(key))) continue;
        if (content === null) await fs.promises.rm(file, { force: true });
        else await writeAtomic(file, content);
      }
      throw e;
    }
  });
}

/** A new entry's id, made from its name: `Quick fix` → `quick-fix`, `-2` for a taken one, `fallback` for a name without Latin letters. */
function idFromLabel(label: string, taken: Set<string>, fallback: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '') || fallback;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Scenario ids nobody can take: the delivery pipeline, the composer's "pick for me", and the built-in reports. */
const RESERVED_SCENARIOS = ['deliver', 'auto', ...Object.keys(SCENARIO_OUTPUT)];

/**
 * Creates or changes a custom scenario. Without `id` a new one is named after its label (`Quick fix` → `quick-fix`,
 * `-2` for a taken one; a label without Latin letters gets `scenario`). Labels are unique, ignoring case. Returns the id.
 */
async function saveCustomScenario({ workspace, home, id, label, description, agents = [] }: { workspace: string; home?: string | undefined; id?: string | undefined; label?: string | undefined; description?: string | undefined; agents?: ScenarioStep[] | undefined }): Promise<string> {
  const r = await loadConfig({ workspace, home });
  const custom = r.ok ? r.config.custom : {};
  const clean = String(label || '').trim();
  if (!clean) throw new Error('Give the scenario a name');
  if (id && !custom[id]) throw new Error(`There is no scenario "${id}"`);
  if (Object.values(custom).some((sc) => sc.id !== id && sc.label.toLowerCase() === clean.toLowerCase())) throw new Error(`A scenario called "${clean}" already exists`);
  const finalId = id || idFromLabel(clean, new Set([...RESERVED_SCENARIOS, ...Object.keys(custom)]), 'scenario');
  // Some mistakes (an unknown agent, code and report agents mixed) only show once the agents resolve.
  await withConfigRollback({ workspace, home, explain: (errors) => errors.filter((e) => e.message.includes(`"${finalId}"`)) }, () =>
    setCustomScenario(workspace, finalId, { label: clean, description: description && description.trim(), agents })
  );
  return finalId;
}

const ENTRY_NAMES = { groups: 'group', instructions: 'instruction' } as const;
type EntrySection = keyof typeof ENTRY_NAMES;

/**
 * Writes a group or an instruction to the project config. Without `id` a new one gets an id from its name; names are
 * unique within the section, ignoring case. Returns the id.
 */
async function saveEntry(workspace: string, section: EntrySection, existing: Record<string, { id: string; label: string }>, id: string | undefined, value: GroupLayer | InstructionLayer): Promise<string> {
  const what = ENTRY_NAMES[section];
  if (!value.label) throw new Error(`Give the ${what} a name`);
  if (id && !existing[id]) throw new Error(`There is no ${what} "${id}"`);
  if (Object.values(existing).some((x) => x.id !== id && x.label.toLowerCase() === value.label.toLowerCase())) throw new Error(`A ${what} called "${value.label}" already exists`);
  const finalId = id || idFromLabel(value.label, new Set(Object.keys(existing)), what);
  await editProjectConfig(workspace, (doc) => writeIn(doc, [section, finalId], value));
  return finalId;
}

interface SaveGroupArgs {
  workspace: string;
  home?: string | undefined;
  id?: string | undefined;
  type: GroupType;
  label: string;
  jira?: string | undefined;
  instructions?: string | undefined;
  defaultInstructions?: string[] | undefined;
}

/**
 * Creates or changes a task group: an epic, a story or a plain group, with an optional Jira key (`cp-123` is written
 * `CP-123`), optional instructions for every task in it, and the instructions it ticks when picked. Returns its id.
 */
async function saveGroup({ workspace, home, id, type, label, jira, instructions, defaultInstructions = [] }: SaveGroupArgs): Promise<string> {
  const r = await loadConfig({ workspace, home });
  const ticks = [...new Set(defaultInstructions)];
  const missing = ticks.filter((x) => !(r.ok && r.config.instructions[x]));
  if (missing.length) throw new Error(`There is no instruction ${missing.map((x) => `"${x}"`).join(', ')}`);
  const key = (jira || '').trim().toUpperCase();
  if (key && !JIRA_KEY.test(key)) throw new Error(`"${jira}" is not a Jira key (e.g. CP-123)`);
  const text = (instructions || '').trim();
  const value: GroupLayer = { type, label: label.trim(), ...(key && { jira: key }), ...(text && { instructions: text }), ...(ticks.length && { defaultInstructions: ticks }) };
  return saveEntry(workspace, 'groups', r.ok ? r.config.groups : {}, id, value);
}

/** Creates or changes an instruction tasks can pick. Returns its id. */
async function saveInstruction({ workspace, home, id, label, text }: { workspace: string; home?: string | undefined; id?: string | undefined; label: string; text: string }): Promise<string> {
  const r = await loadConfig({ workspace, home });
  if (!text.trim()) throw new Error('Write the instruction');
  return saveEntry(workspace, 'instructions', r.ok ? r.config.instructions : {}, id, { label: label.trim(), text: text.trim() });
}

/**
 * Deletes a group or an instruction from the project config; a deleted instruction is no longer ticked by the project's
 * groups. One only your user config has is not this project's to delete.
 */
async function removeEntry(workspace: string, section: EntrySection, id: string): Promise<string> {
  const layer = await readProjectLayer(workspace);
  if (!(layer[section] || {})[id]) throw new Error(`The ${ENTRY_NAMES[section]} "${id}" is not in this project's config.yaml; it comes from ~/${CONFIG_DIR}/${CONFIG_FILE}`);
  return editProjectConfig(workspace, (doc) => {
    doc.deleteIn([section, id]);
    if (section === 'instructions') {
      for (const [gid, g] of Object.entries(layer.groups ?? {})) {
        const rest = (g.defaultInstructions ?? []).filter((x) => x !== id);
        if (rest.length === (g.defaultInstructions ?? []).length) continue;
        writeIn(doc, ['groups', gid, 'defaultInstructions'], rest.length ? rest : undefined);
      }
    }
    const node = doc.getIn([section], true) as YamlCollection | undefined;
    if (node && node.items && node.items.length === 0) doc.deleteIn([section]);
  });
}

/**
 * Adds an agent of the project's own, with its instructions file under prompts/ (kept if it is there already). One
 * based on another (`base`) adds to that agent's instructions and runs right after it; one based on a readiness or
 * audit agent joins that report scenario. Returns the instructions file, for the user to write.
 */
async function addAgent({ workspace, home, name, base, description, output, model, effort }: { workspace: string; home?: string | undefined; name?: string | undefined; base?: string | undefined; description?: string | undefined; output?: Output | undefined; model?: string | undefined; effort?: Effort | undefined }): Promise<string> {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Use lowercase letters, digits and dashes, starting with a letter (e.g. security-reviewer)');
  const before = await loadConfig({ workspace, home });
  if (before.ok && before.config.agents[name]) throw new Error(`An agent called "${name}" already exists`);
  const file = path.join(workspace, CONFIG_DIR, PROMPTS_DIR, `${name}.md`);
  return withConfigRollback({ workspace, home }, async (remember) => {
    await remember(file);
    if ((await readIfThere(file)) === null) {
      await writeMaking(file, base ? `<!-- Added to the instructions of "${base}". Write what this agent should do differently or check in addition. -->\n\n` : `You are the ${name} stage.\n\nDescribe what this agent does, what it reads first and what its report must contain.\n`);
    }
    await updateAgentConfig(workspace, name, {
      ...(base && { extends: base }),
      ...(description && { description }),
      ...(!base && { output: output || 'verdict' }),
      ...(model && { model }),
      ...(effort && { effort }),
      instructions: { mode: base ? 'append' : 'replace', file: `./${PROMPTS_DIR}/${name}.md` },
    });
    const now = await loadConfig({ workspace, home });
    if (!now.ok) return file; // the rollback reports it
    const scenario = base ? Object.keys(now.config.scenarios).find((sc) => now.config.scenarios[sc]!.includes(base)) : Object.keys(SCENARIO_OUTPUT).find((sc) => SCENARIO_OUTPUT[sc] === output);
    if (scenario) await setScenario(workspace, scenario, [...now.config.scenarios[scenario]!, name]);
    else {
      const pipeline = [...now.config.pipeline];
      const at = base ? pipeline.indexOf(base) : -1;
      pipeline.splice(at === -1 ? pipeline.length : at + 1, 0, name);
      await setPipeline(workspace, pipeline);
    }
    return file;
  });
}

export type { AgentLayer, ConfigLayer, EntrySection, Flags, GroupLayer, InstructionLayer, Layer, RepoLayer, ResolveResult, ScenarioStepLayer };
export {
  CONFIG_DIR,
  CONFIG_FILE,
  PROMPTS_DIR,
  BUILTIN,
  builtinLayer,
  builtinAgentNames,
  projectConfigFile,
  userConfigFile,
  loadLayerFile,
  loadLayers,
  mergeLayers,
  resolveConfig,
  loadConfig,
  configPaths,
  readProjectLayer,
  updateAgentConfig,
  resetAgentConfig,
  setAgentLayer,
  editYamlFile,
  editProjectConfig,
  libraryFile,
  libraryLabel,
  isLibraryLayer,
  LIBRARY_FILE,
  LIBRARY_PREFIX,
  configRelative,
  withConfigRollback,
  saveCustomScenario,
  saveGroup,
  saveInstruction,
  removeEntry,
  addAgent,
  RESERVED_SCENARIOS,
  setPipeline,
  setScenario,
  setCustomScenario,
  removeScenario,
  restoreScenario,
  setProjectValue,
  setRepo,
  createProjectConfig,
  ensureInstructionsFile,
  writeIn,
};
