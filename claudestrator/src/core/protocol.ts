// Shared vocabulary of the orchestrator: outputs, checkpoints, event kinds, and the validators
// for what agents hand back (plan and verdict blocks) and for config layers.
// The on-disk formats match the claudestrator CLI and plugin, so both can work on the same tasks.

import type { Audit, AuditFinding, CheckpointId, Effort, Finding, GroupType, JsonObject, OrchEvent, Output, ParseResult, PlanMeta, Readiness, ReadinessValue, ReadinessVerdict, ReportSeverity, Runs, Scenario, Severity, CriterionStatus, WorkReport } from './types';

import { PROTECTED_MODES } from './protected';
const OUTPUTS: Output[] = ['plan', 'code', 'tests', 'verdict', 'readiness', 'audit'];
/**
 * What a task is for. `deliver` runs the pipeline to draft PRs; the others run read-only agents and end with a report:
 * `readiness` checks a ticket's work against its acceptance criteria, `audit` looks for bugs and bottlenecks.
 */
const SCENARIOS: Scenario[] = ['deliver', 'readiness', 'audit'];
/** The output every agent of a report scenario produces. */
const SCENARIO_OUTPUT: Record<string, Output> = { readiness: 'readiness', audit: 'audit' };
/**
 * Custom scenarios are named in config.yaml next to the built-in ones. Their kind follows from their agents:
 * agents that change code make a delivery (draft PRs), readiness or audit agents make that report.
 */
const SCENARIO_ID = /^[a-z][a-z0-9-]*$/;
/** Severities of audit findings and readiness gaps, worst first. */
const REPORT_SEVERITIES: ReportSeverity[] = ['critical', 'high', 'medium', 'low'];
const CRITERION_STATUSES: CriterionStatus[] = ['met', 'partial', 'not_met', 'unverifiable'];
const INSTRUCTION_MODES = ['replace', 'append', 'prepend'];
/** Reasoning effort, as `claude --effort` accepts it. Omitted: the model's default. */
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Where a code or tests agent runs: once per repo of the plan, or once across all of them. */
const RUNS: Runs[] = ['per-repo', 'all-repos'];
const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;
/**
 * A repo's name: a folder name of its own, since a worktree lives at `.orch/worktrees/<task>/<name>`. No separator and
 * no `..`, which would put that folder (and its removal) somewhere else.
 */
const REPO_NAME = /^(?![.-])(?!.*\.\.)[A-Za-z0-9._-]+$/;
const PLAN_TYPES = ['feat', 'fix', 'chore', 'refactor'];
/** A plan's slug: the end of the branch name. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** What a task group is. */
const GROUP_TYPES: GroupType[] = ['epic', 'story', 'group'];
/** A Jira issue key, as a group names it: `CP-123`, `MY_PROJ-12` (a project key may have `_`). */
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const SEVERITIES: Severity[] = ['blocker', 'major', 'minor'];

/** Where a human must decide. Ids are shared with the CLI and the plugin. */
const CHECKPOINT_OPTIONS: Record<CheckpointId, string[]> = {
  'approve-plan': ['approve', 'approve-post', 'change', 'stop'],
  'gate-failure': ['retry', 'continue', 'stop'],
  'agent-failure': ['retry', 'stop'],
  'review-limit': ['continue', 'retry', 'stop'],
  'protected-changes': ['apply', 'retry', 'skip', 'stop'],
  'hook-failure': ['retry', 'stop'],
  'confirm-push': ['push', 'push-comment', 'local'],
};
const JIRA_ONLY_OPTIONS = ['approve-post', 'push-comment'];

/** Informational events: recorded for the UI and the audit trail, they never change state. */
const INFO_EVENT_TYPES = ['agent_stopped', 'agent_progress', 'pr_opened', 'note', 'gates_ran', 'transition_rejected', 'jira_comment'] as const;
const INFO_EVENTS = new Set<string>(INFO_EVENT_TYPES);
type InfoEvent = Extract<OrchEvent, { type: (typeof INFO_EVENT_TYPES)[number] }>;
/** Events that record what happened without changing the task's state. */
const isInfoEvent = (e: OrchEvent): e is InfoEvent => INFO_EVENTS.has(e.type);

const STATE_EVENTS = new Set<string>([
  'task_created', 'intake_completed', 'stage_started', 'stage_completed', 'stage_failed',
  'checkpoint_answered', 'committed', 'commit_failed', 'published', 'stopped', 'resumed', 'pipeline_changed',
]);

const isBlocking = (f: { severity: string }): boolean => f.severity !== 'minor';

// ---------- a tiny schema checker ----------
// Each checker returns a list of "path: message" strings; empty means valid.

/** Returns "path: message" strings; empty means valid. */
type Check = (v: unknown, p: string) => string[];

const kind = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const at = (p: string): string => p || '(root)';
/** Callers check `kind(v) === 'object'` first. */
const asRecord = (v: unknown): JsonObject => v as JsonObject;

const T = {
  str: (min = 0, max = Infinity): Check => (v, p) =>
    typeof v !== 'string' ? [`${at(p)}: expected a string, got ${kind(v)}`]
      : v.length < min ? [`${at(p)}: must not be empty`]
        : v.length > max ? [`${at(p)}: at most ${max} characters`] : [],
  bool: (): Check => (v, p) => (typeof v === 'boolean' ? [] : [`${at(p)}: expected true or false, got ${kind(v)}`]),
  int: (min = -Infinity, max = Infinity): Check => (v, p) =>
    !Number.isInteger(v) ? [`${at(p)}: expected a whole number, got ${kind(v)}`]
      : (v as number) < min || (v as number) > max ? [`${at(p)}: must be between ${min} and ${max}`] : [],
  pos: (): Check => (v, p) => (typeof v === 'number' && v > 0 ? [] : [`${at(p)}: expected a positive number`]),
  nonNegative: (): Check => (v, p) => (typeof v === 'number' && v >= 0 ? [] : [`${at(p)}: expected 0 or a positive number`]),
  oneOf: (list: readonly unknown[]): Check => (v, p) => (list.includes(v) ? [] : [`${at(p)}: expected one of ${list.join(', ')}, got ${JSON.stringify(v)}`]),
  re: (re: RegExp, msg: string): Check => (v, p) => (typeof v === 'string' && re.test(v) ? [] : [`${at(p)}: ${msg}`]),
  arr: (item: Check, min = 0, max = Infinity): Check => (v, p) => {
    if (!Array.isArray(v)) return [`${at(p)}: expected a list, got ${kind(v)}`];
    if (v.length < min) return [`${at(p)}: needs at least ${min} item${min === 1 ? '' : 's'}`];
    if (v.length > max) return [`${at(p)}: at most ${max} items, got ${v.length}`];
    return v.flatMap((x, i) => item(x, `${p}[${i}]`));
  },
  rec: (keyCheck: Check, item: Check): Check => (v, p) => {
    if (kind(v) !== 'object') return [`${at(p)}: expected a map, got ${kind(v)}`];
    return Object.entries(asRecord(v)).flatMap(([k, x]) => [...keyCheck(k, p ? `${p}.${k}` : k), ...item(x, p ? `${p}.${k}` : k)]);
  },
  /** `shape` values are checkers; keys ending in `?` are optional. Unknown keys are errors when strict. */
  obj: (shape: Record<string, Check>, { strict = true }: { strict?: boolean } = {}): Check => (value, p) => {
    if (kind(value) !== 'object') return [`${at(p)}: expected an object, got ${kind(value)}`];
    const v = asRecord(value);
    const issues: string[] = [];
    const known = new Set<string>();
    for (const [rawKey, check] of Object.entries(shape)) {
      const optional = rawKey.endsWith('?');
      const key = optional ? rawKey.slice(0, -1) : rawKey;
      known.add(key);
      const sub = p ? `${p}.${key}` : key;
      if (v[key] === undefined) {
        if (!optional) issues.push(`${sub}: required`);
        continue;
      }
      issues.push(...check(v[key], sub));
    }
    if (strict) for (const k of Object.keys(v)) if (!known.has(k)) issues.push(`${p ? `${p}.${k}` : k}: unknown field`);
    return issues;
  },
  any: (...checks: Check[]): Check => (v, p) => {
    const all = checks.map((c) => c(v, p));
    return all.some((x) => x.length === 0) ? [] : all[0] ?? [];
  },
};

const agentName = T.re(AGENT_NAME, 'agent names are lowercase kebab-case and start with a letter');

const instructions = T.any(
  T.str(),
  (v, p) => {
    const issues = T.obj({ 'mode?': T.oneOf(INSTRUCTION_MODES), 'file?': T.str(1), 'text?': T.str() })(v, p);
    if (!issues.length && (asRecord(v).file === undefined) === (asRecord(v).text === undefined)) issues.push(`${at(p)}: instructions need exactly one of file or text`);
    return issues;
  }
);

const AGENT_LAYER: Record<string, Check> = {
  'enabled?': T.bool(),
  'extends?': agentName,
  'description?': T.str(1),
  'model?': T.str(1),
  'tools?': T.arr(T.str(1)),
  'disallowedTools?': T.arr(T.str(1)),
  'mcp?': T.bool(),
  'maxTurns?': T.int(1),
  'effort?': T.oneOf(EFFORTS),
  'color?': T.oneOf(AGENT_COLORS),
  'output?': T.oneOf(OUTPUTS),
  'runs?': T.oneOf(RUNS),
  'instructions?': instructions,
};

/** A step of a custom scenario: an agent name, or the agent with the model and effort it runs with in this scenario. */
const SCENARIO_STEP = T.any(agentName, T.obj({ agent: agentName, 'model?': T.str(1), 'effort?': T.oneOf(EFFORTS) }));
const CUSTOM_SCENARIO = T.obj({ 'label?': T.str(1, 60), 'description?': T.str(), agents: T.arr(SCENARIO_STEP) });

/** `readiness` and `audit` list their agents, or are `false` when removed; any other name is a custom scenario. */
const scenariosLayer: Check = (v, p) => {
  if (kind(v) !== 'object') return [`${at(p)}: expected a map, got ${kind(v)}`];
  return Object.entries(asRecord(v)).flatMap(([id, x]) => {
    const sub = `${p}.${id}`;
    if (id === 'deliver' || id === 'auto') return [`${sub}: "${id}" is reserved; the delivery pipeline is set with pipeline`];
    if (!SCENARIO_ID.test(id)) return [`${sub}: scenario names are lowercase kebab-case and start with a letter`];
    if (SCENARIO_OUTPUT[id]) return x === false ? [] : T.arr(agentName)(x, sub);
    return CUSTOM_SCENARIO(x, sub);
  });
};

/** What a library.yaml may hold: agents and scenarios, in the shape config.yaml has them. Nothing that is a project's own. */
function validateLibraryLayer(raw: unknown): string[] {
  if (kind(raw) !== 'object') return [`${at('')}: expected a map, got ${kind(raw)}`];
  const extra = Object.keys(asRecord(raw)).filter((k) => k !== 'agents' && k !== 'scenarios');
  if (extra.length) return [`a library holds only agents and scenarios, not ${extra.join(', ')}`];
  return validateConfigLayer(raw);
}

/** The VS Code settings (`claudestrator.*`) the dashboard may change, and what each holds. */
const SETTINGS: Record<string, Check> = {
  claudePath: T.str(),
  claudeConfigDir: T.str(),
  workspaceFolder: T.str(),
  settingSources: T.arr(T.oneOf(['user', 'project', 'local'])),
  askPermissions: T.bool(),
  notifications: T.oneOf(['all', 'needsYou', 'off']),
};

/** Problems with a setting the page wants to write: an unknown key, or a value of the wrong shape. */
function validateSetting(key: string, value: unknown): string[] {
  const check = Object.prototype.hasOwnProperty.call(SETTINGS, key) ? SETTINGS[key] : undefined;
  return check ? check(value, key) : [`unknown setting ${key}`];
}

/** Ids of groups and instructions in config.yaml, made from their names. */
const entryId = T.re(SCENARIO_ID, 'ids are lowercase kebab-case and start with a letter');
const GROUP = T.obj({ type: T.oneOf(GROUP_TYPES), label: T.str(1, 80), 'jira?': T.re(JIRA_KEY, 'a Jira key looks like CP-123'), 'instructions?': T.str(1), 'defaultInstructions?': T.arr(entryId) });
const INSTRUCTION = T.obj({ label: T.str(1, 80), text: T.str(1) });

const GATE = T.obj({ name: T.str(1), cmd: T.str(1), 'dir?': T.re(/^(?![\\/~]|[A-Za-z]:)(?!(?:.*[\\/])?\.\.(?:[\\/]|$)).+$/, 'dir is a folder of the repo, from its root (packages/web), never an absolute path, ~ or ..'), 'when?': T.re(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^*?[\]{}]+$/, 'when is a folder or file of the repo, from its root (src/ or package.json), without patterns'), 'timeout?': T.int(1, 24 * 60 * 60) });
/**
 * A repo's checks, each named once: a check writes its log under its name (gates.ts turns any run of characters other
 * than letters, digits, `.`, `_` and `-` into `_`), and macOS and Windows take Lint and lint for one file.
 */
const GATES: Check = (v, p) => {
  const issues = T.arr(GATE)(v, p);
  if (issues.length) return issues;
  const seen = new Map<string, string>();
  for (const { name } of v as { name: string }[]) {
    const log = name.replace(/[^A-Za-z0-9._-]+/g, '_').toLowerCase();
    const other = seen.get(log);
    if (other === undefined) seen.set(log, name);
    else if (other === name) issues.push(`${at(p)}: two checks are named "${name}"; give each check its own name, its log file is named after it`);
    else issues.push(`${at(p)}: the checks "${other}" and "${name}" would write one log file, which is named after the check; give them names that differ in more than case or punctuation`);
  }
  return issues;
};
/** The most entries a list of the safety policy holds. */
const SANDBOX_LIST = 100;

/** A branch name git takes as one (`main`, `release/2.x`): no leading `-`, which git would read as an option, and no `..`. */
const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const BRANCH = T.re(BRANCH_PATTERN, 'a branch name, e.g. main or release/2.x');

const CONFIG_LAYER = T.obj({
  'agents?': T.rec(agentName, T.obj(AGENT_LAYER)),
  'pipeline?': T.arr(agentName),
  'scenarios?': scenariosLayer,
  'libraries?': T.arr(T.str(1)),
  'limits?': T.obj({ 'reviewRounds?': T.int(0, 20), 'gateAttempts?': T.int(1, 20), 'budgetUsd?': T.nonNegative(), 'parallelTasks?': T.int(1, 20) }),
  'language?': T.str(1),
  'baseBranch?': BRANCH,
  'repos?': T.rec(T.re(REPO_NAME, 'a repo name is letters, digits, ".", "_" and "-", e.g. api or web-app'), T.obj({ 'role?': T.str(1), 'path?': T.str(1), 'baseBranch?': BRANCH, 'gates?': GATES })),
  'jira?': T.obj({ 'allowedProjects?': T.arr(T.str(1)) }),
  // The sandbox's lists go to sandbox-runtime as its settings: a few entries each, never an unbounded list to validate.
  'policy?': T.obj({ 'protectedBranches?': T.arr(T.str(1), 0, SANDBOX_LIST), 'draftPrsOnly?': T.bool(), 'forbidAiAttribution?': T.bool(), 'allowNoVerify?': T.bool(), 'sandbox?': T.bool(), 'localPorts?': T.bool(), 'network?': T.arr(T.re(/^[A-Za-z0-9*.:[\]-]+$/, 'a host name, e.g. npm.acme.corp or *.acme.corp'), 0, SANDBOX_LIST), 'writable?': T.arr(T.re(/^(~[\\/]|\/|[A-Za-z]:[\\/])(?=.*[^\\/~.\s])/, 'a folder below ~ or the filesystem root, e.g. ~/.cache/go-build'), 0, SANDBOX_LIST), 'checkEnv?': T.arr(T.re(/^[A-Za-z_][A-Za-z0-9_]*$/, 'a variable name, e.g. DATABASE_URL'), 0, SANDBOX_LIST), 'protectedChanges?': T.oneOf(PROTECTED_MODES) }),
  'git?': T.obj({ 'mode?': T.oneOf(['branch', 'worktree']) }),
  'editor?': T.str(1),
  'context?': T.arr(T.str(1)),
  'groups?': T.rec(entryId, GROUP),
  'instructions?': T.rec(entryId, INSTRUCTION),
});

const validateConfigLayer = (v: unknown): string[] => CONFIG_LAYER(v ?? {}, '');
const validateAgentPatch = (v: unknown): string[] => T.obj(AGENT_LAYER)(v, '');

// Agents often write `null` for "not applicable"; treat it as absent instead of bouncing the report.
function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (kind(v) !== 'object') return v;
  return Object.fromEntries(Object.entries(asRecord(v)).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
}

const PLAN = T.obj(
  {
    type: T.oneOf(PLAN_TYPES),
    slug: T.re(SLUG_PATTERN, 'slug must be kebab-case latin'),
    'title?': T.str(1, 100),
    repos: T.arr(T.obj({ name: T.str(1), 'mode?': T.oneOf(['full', 'tests_only']), 'baseBranch?': BRANCH }), 1),
    'openQuestions?': T.arr(T.obj({ question: T.str(), default: T.str() }, { strict: false })),
  },
  { strict: false }
);

/** The machine-readable part of a plan: `{ ok, value }` with defaults filled in, or `{ ok: false, issues }`. */
function parsePlanMeta(raw: unknown): ParseResult<PlanMeta> {
  const v = dropNulls(raw) as RawPlan;
  const issues = PLAN(v, '');
  if (issues.length) return { ok: false, issues };
  // Each repo once: the pipeline runs a step per repo, and a repo named twice would run its step again and again.
  const twice = [...new Set(v.repos.map((r) => r.name).filter((n, i, all) => all.indexOf(n) !== i))];
  if (twice.length) return { ok: false, issues: [`repos: ${twice.join(', ')} ${twice.length === 1 ? 'is' : 'are'} named more than once; name each repo once`] };
  return {
    ok: true,
    value: {
      type: v.type,
      slug: v.slug,
      ...(v.title && { title: v.title }),
      repos: v.repos.map((r) => ({ name: r.name, mode: r.mode || 'full', ...(r.baseBranch && { baseBranch: r.baseBranch }) })),
      openQuestions: (v.openQuestions || []).map((q) => ({ question: q.question, default: q.default })),
    },
  };
}

/** Shapes below are what the checkers above have already validated; nothing else is promised about them. */
interface RawPlan {
  type: string;
  slug: string;
  title?: string;
  repos: { name: string; mode?: 'full' | 'tests_only'; baseBranch?: string }[];
  openQuestions?: { question: string; default: string }[];
}
interface RawVerdict {
  status: 'approved' | 'changes_requested';
  summary: string;
  findings: Finding[];
}
interface RawReadiness {
  summary: string;
  criteria: { criterion: string; status: CriterionStatus; evidence?: unknown; files?: unknown[] }[];
  gaps?: { severity: ReportSeverity; problem: string; fix?: string }[];
  work?: { repo?: unknown; ref?: unknown }[];
  derivedCriteria?: unknown;
}
interface RawAudit {
  summary: string;
  scope?: unknown[];
  findings: AuditFinding[];
}

const FINDING = T.obj(
  { severity: T.oneOf(SEVERITIES), 'repo?': T.str(), 'file?': T.str(), 'line?': T.int(1), problem: T.str(1), 'fix?': T.str() },
  { strict: false }
);
const VERDICT = T.obj({ status: T.oneOf(['approved', 'changes_requested']), summary: T.str(), findings: T.arr(FINDING) }, { strict: false });

function parseVerdict(raw: unknown): ParseResult<RawVerdict> {
  const v = dropNulls(raw) as RawVerdict;
  const issues = VERDICT(v, '');
  if (issues.length) return { ok: false, issues };
  const findings: Finding[] = v.findings.map((f) => ({
    severity: f.severity,
    ...(f.repo && { repo: f.repo }),
    ...(f.file && { file: f.file }),
    ...(f.line && { line: f.line }),
    problem: f.problem,
    ...(f.fix && { fix: f.fix }),
  }));
  if ((v.status === 'changes_requested') !== findings.some(isBlocking)) {
    return { ok: false, issues: ['status: changes_requested exactly when there is at least one blocker or major finding'] };
  }
  return { ok: true, value: { status: v.status, summary: v.summary, findings } };
}

const WORK = T.obj({ status: T.oneOf(['done', 'blocked']), 'blockers?': T.arr(T.str()) }, { strict: false });

/**
 * A code or tests stage's status. Lenient where the others are strict: a report without one (an older CLI, an agent
 * of your own that never says) is done, as before; only `blocked` changes what happens next.
 */
function parseWork(raw: unknown): WorkReport {
  const v = dropNulls(raw) as { status?: string; blockers?: string[] };
  if (WORK(v, '').length || v.status !== 'blocked') return { status: 'done', blockers: [] };
  return { status: 'blocked', blockers: (v.blockers || []).map((b) => b.trim()).filter(Boolean) };
}

// ---------- report scenarios ----------

const asText = (v: unknown): string => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

const CRITERION = T.obj({ criterion: T.str(1), status: T.oneOf(CRITERION_STATUSES), 'evidence?': T.str(), 'files?': T.arr(T.str()) }, { strict: false });
const GAP = T.obj({ severity: T.oneOf(REPORT_SEVERITIES), problem: T.str(1), 'fix?': T.str() }, { strict: false });
const READINESS = T.obj(
  { summary: T.str(), criteria: T.arr(CRITERION, 1), 'gaps?': T.arr(GAP), 'work?': T.arr(T.obj({ 'repo?': T.str(), 'ref?': T.str() }, { strict: false })), 'derivedCriteria?': T.bool() },
  { strict: false }
);

/**
 * The verdict follows from the criteria, so a program decides it, not the agent: `not_ready` when a criterion is
 * partial or not met or a gap is critical or high, `needs_check` when what is left can only be verified by a human.
 */
function readinessVerdict(r: Pick<ReadinessValue, 'criteria' | 'gaps'>): ReadinessVerdict {
  const statuses = r.criteria.map((c) => c.status);
  if (statuses.some((x) => x === 'partial' || x === 'not_met') || r.gaps.some((g) => g.severity === 'critical' || g.severity === 'high')) return 'not_ready';
  if (statuses.includes('unverifiable')) return 'needs_check';
  return 'ready';
}

function parseReadiness(raw: unknown): ParseResult<Readiness> {
  const v = dropNulls(raw) as RawReadiness;
  const issues = READINESS(v, '');
  if (issues.length) return { ok: false, issues };
  const value: ReadinessValue = {
    summary: v.summary,
    criteria: v.criteria.map((c) => ({ criterion: c.criterion, status: c.status, evidence: asText(c.evidence), files: (c.files || []).map(String) })),
    gaps: (v.gaps || []).map((g) => ({ severity: g.severity, problem: g.problem, ...(g.fix && { fix: g.fix }) })),
    work: (v.work || []).filter((w) => w.repo || w.ref).map((w) => ({ repo: asText(w.repo), ref: asText(w.ref) })),
    derivedCriteria: v.derivedCriteria === true,
  };
  return { ok: true, value: { verdict: readinessVerdict(value), ...value } };
}

const AUDIT_FINDING = T.obj(
  { severity: T.oneOf(REPORT_SEVERITIES), title: T.str(1), 'category?': T.str(), 'repo?': T.str(), 'file?': T.str(), 'line?': T.int(1), problem: T.str(1), 'impact?': T.str(), 'fix?': T.str(), 'effort?': T.str() },
  { strict: false }
);
const AUDIT = T.obj({ summary: T.str(), 'scope?': T.arr(T.str()), findings: T.arr(AUDIT_FINDING) }, { strict: false });

function parseAudit(raw: unknown): ParseResult<Audit> {
  const v = dropNulls(raw) as RawAudit;
  const issues = AUDIT(v, '');
  if (issues.length) return { ok: false, issues };
  const rank = (f: { severity: ReportSeverity }): number => REPORT_SEVERITIES.indexOf(f.severity);
  const findings = v.findings
    .map((f) => ({
      severity: f.severity,
      title: f.title,
      ...(f.category && { category: f.category }),
      ...(f.repo && { repo: f.repo }),
      ...(f.file && { file: f.file }),
      ...(f.line && { line: f.line }),
      problem: f.problem,
      ...(f.impact && { impact: f.impact }),
      ...(f.fix && { fix: f.fix }),
      ...(f.effort && { effort: f.effort }),
    }))
    .sort((a, b) => rank(a) - rank(b));
  return { ok: true, value: { summary: v.summary, scope: (v.scope || []).map(String), findings } };
}

export type { Check };
export {
  T,
  OUTPUTS,
  SCENARIOS,
  SCENARIO_OUTPUT,
  SCENARIO_ID,
  REPORT_SEVERITIES,
  CRITERION_STATUSES,
  SEVERITIES,
  SLUG_PATTERN,
  BRANCH_PATTERN,
  INSTRUCTION_MODES,
  AGENT_COLORS,
  RUNS,
  EFFORTS,
  AGENT_NAME,
  REPO_NAME,
  PLAN_TYPES,
  GROUP_TYPES,
  JIRA_KEY,
  CHECKPOINT_OPTIONS,
  JIRA_ONLY_OPTIONS,
  INFO_EVENTS,
  validateSetting,
  validateLibraryLayer,
  isInfoEvent,
  STATE_EVENTS,
  isBlocking,
  validateConfigLayer,
  validateAgentPatch,
  parsePlanMeta,
  parseVerdict,
  parseWork,
  parseReadiness,
  parseAudit,
  readinessVerdict,
};
