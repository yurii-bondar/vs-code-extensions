// Shared vocabulary of the orchestrator: outputs, checkpoints, event kinds, and the validators
// for what agents hand back (plan and verdict blocks) and for config layers.
// The on-disk formats match the claudestrator CLI and plugin, so both can work on the same tasks.

const OUTPUTS = ['plan', 'code', 'tests', 'verdict', 'readiness', 'audit'];
/**
 * What a task is for. `deliver` runs the pipeline to draft PRs; the others run read-only agents and end with a report:
 * `readiness` checks a ticket's work against its acceptance criteria, `audit` looks for bugs and bottlenecks.
 */
const SCENARIOS = ['deliver', 'readiness', 'audit'];
/** The output every agent of a report scenario produces. */
const SCENARIO_OUTPUT = { readiness: 'readiness', audit: 'audit' };
/** Severities of audit findings and readiness gaps, worst first. */
const REPORT_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CRITERION_STATUSES = ['met', 'partial', 'not_met', 'unverifiable'];
const INSTRUCTION_MODES = ['replace', 'append', 'prepend'];
/** Reasoning effort, as `claude --effort` accepts it. Omitted: the model's default. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;
const PLAN_TYPES = ['feat', 'fix', 'chore', 'refactor'];
const SEVERITIES = ['blocker', 'major', 'minor'];

/** Where a human must decide. Ids are shared with the CLI and the plugin. */
const CHECKPOINT_OPTIONS = {
  'approve-plan': ['approve', 'approve-post', 'change', 'stop'],
  'gate-failure': ['retry', 'continue', 'stop'],
  'agent-failure': ['retry', 'stop'],
  'review-limit': ['continue', 'retry', 'stop'],
  'hook-failure': ['retry', 'stop'],
  'confirm-push': ['push', 'push-comment', 'local'],
};
const JIRA_ONLY_OPTIONS = ['approve-post', 'push-comment'];

/** Informational events: recorded for the UI and the audit trail, they never change state. */
const INFO_EVENTS = new Set(['agent_stopped', 'note', 'gates_ran', 'transition_rejected', 'jira_comment']);

const STATE_EVENTS = new Set([
  'task_created', 'intake_completed', 'stage_started', 'stage_completed', 'stage_failed',
  'checkpoint_answered', 'committed', 'commit_failed', 'published', 'stopped', 'resumed',
]);

const isBlocking = (f) => f.severity !== 'minor';

// ---------- a tiny schema checker ----------
// Each checker returns a list of "path: message" strings; empty means valid.

const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const at = (p) => p || '(root)';

const T = {
  str: (min = 0, max = Infinity) => (v, p) =>
    typeof v !== 'string' ? [`${at(p)}: expected a string, got ${kind(v)}`]
      : v.length < min ? [`${at(p)}: must not be empty`]
        : v.length > max ? [`${at(p)}: at most ${max} characters`] : [],
  bool: () => (v, p) => (typeof v === 'boolean' ? [] : [`${at(p)}: expected true or false, got ${kind(v)}`]),
  int: (min = -Infinity, max = Infinity) => (v, p) =>
    !Number.isInteger(v) ? [`${at(p)}: expected a whole number, got ${kind(v)}`]
      : v < min || v > max ? [`${at(p)}: must be between ${min} and ${max}`] : [],
  pos: () => (v, p) => (typeof v === 'number' && v > 0 ? [] : [`${at(p)}: expected a positive number`]),
  oneOf: (list) => (v, p) => (list.includes(v) ? [] : [`${at(p)}: expected one of ${list.join(', ')}, got ${JSON.stringify(v)}`]),
  re: (re, msg) => (v, p) => (typeof v === 'string' && re.test(v) ? [] : [`${at(p)}: ${msg}`]),
  arr: (item, min = 0) => (v, p) => {
    if (!Array.isArray(v)) return [`${at(p)}: expected a list, got ${kind(v)}`];
    if (v.length < min) return [`${at(p)}: needs at least ${min} item${min === 1 ? '' : 's'}`];
    return v.flatMap((x, i) => item(x, `${p}[${i}]`));
  },
  rec: (keyCheck, item) => (v, p) => {
    if (kind(v) !== 'object') return [`${at(p)}: expected a map, got ${kind(v)}`];
    return Object.entries(v).flatMap(([k, x]) => [...keyCheck(k, p ? `${p}.${k}` : k), ...item(x, p ? `${p}.${k}` : k)]);
  },
  /** `shape` values are checkers; keys ending in `?` are optional. Unknown keys are errors when strict. */
  obj: (shape, { strict = true } = {}) => (v, p) => {
    if (kind(v) !== 'object') return [`${at(p)}: expected an object, got ${kind(v)}`];
    const issues = [];
    const known = new Set();
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
  any: (...checks) => (v, p) => {
    const all = checks.map((c) => c(v, p));
    return all.some((x) => x.length === 0) ? [] : all[0];
  },
};

const agentName = T.re(AGENT_NAME, 'agent names are lowercase kebab-case and start with a letter');

const instructions = T.any(
  T.str(),
  (v, p) => {
    const issues = T.obj({ 'mode?': T.oneOf(INSTRUCTION_MODES), 'file?': T.str(1), 'text?': T.str() })(v, p);
    if (!issues.length && (v.file === undefined) === (v.text === undefined)) issues.push(`${at(p)}: instructions need exactly one of file or text`);
    return issues;
  }
);

const AGENT_LAYER = {
  'enabled?': T.bool(),
  'extends?': agentName,
  'description?': T.str(1),
  'model?': T.str(1),
  'tools?': T.arr(T.str(1)),
  'disallowedTools?': T.arr(T.str(1)),
  'maxTurns?': T.int(1),
  'effort?': T.oneOf(EFFORTS),
  'color?': T.oneOf(AGENT_COLORS),
  'output?': T.oneOf(OUTPUTS),
  'instructions?': instructions,
};

const GATE = T.obj({ name: T.str(1), cmd: T.str(1), 'dir?': T.str(1), 'when?': T.str(1) });

const CONFIG_LAYER = T.obj({
  'agents?': T.rec(agentName, T.obj(AGENT_LAYER)),
  'pipeline?': T.arr(agentName),
  'scenarios?': T.obj({ 'readiness?': T.arr(agentName), 'audit?': T.arr(agentName) }),
  'limits?': T.obj({ 'reviewRounds?': T.int(0, 20), 'gateAttempts?': T.int(1, 20), 'budgetUsd?': T.pos() }),
  'language?': T.str(1),
  'baseBranch?': T.str(1),
  'repos?': T.rec(T.str(1), T.obj({ 'role?': T.str(1), 'path?': T.str(1), 'baseBranch?': T.str(1), 'gates?': T.arr(GATE) })),
  'jira?': T.obj({ 'allowedProjects?': T.arr(T.str(1)) }),
  'policy?': T.obj({ 'protectedBranches?': T.arr(T.str(1)), 'draftPrsOnly?': T.bool(), 'forbidAiAttribution?': T.bool(), 'allowNoVerify?': T.bool() }),
  'git?': T.obj({ 'mode?': T.oneOf(['branch', 'worktree']) }),
  'editor?': T.str(1),
  'context?': T.arr(T.str(1)),
});

const validateConfigLayer = (v) => CONFIG_LAYER(v ?? {}, '');
const validateAgentPatch = (v) => T.obj(AGENT_LAYER)(v, '');

// Agents often write `null` for "not applicable"; treat it as absent instead of bouncing the report.
function dropNulls(v) {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (kind(v) !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
}

const PLAN = T.obj(
  {
    type: T.oneOf(PLAN_TYPES),
    slug: T.re(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be kebab-case latin'),
    'title?': T.str(1, 100),
    repos: T.arr(T.obj({ name: T.str(1), 'mode?': T.oneOf(['full', 'tests_only']) }), 1),
    'openQuestions?': T.arr(T.obj({ question: T.str(), default: T.str() }, { strict: false })),
  },
  { strict: false }
);

/** The machine-readable part of a plan: `{ ok, value }` with defaults filled in, or `{ ok: false, issues }`. */
function parsePlanMeta(raw) {
  const v = dropNulls(raw);
  const issues = PLAN(v, '');
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    value: {
      type: v.type,
      slug: v.slug,
      ...(v.title && { title: v.title }),
      repos: v.repos.map((r) => ({ name: r.name, mode: r.mode || 'full' })),
      openQuestions: (v.openQuestions || []).map((q) => ({ question: q.question, default: q.default })),
    },
  };
}

const FINDING = T.obj(
  { severity: T.oneOf(SEVERITIES), 'repo?': T.str(), 'file?': T.str(), 'line?': T.int(1), problem: T.str(1), 'fix?': T.str() },
  { strict: false }
);
const VERDICT = T.obj({ status: T.oneOf(['approved', 'changes_requested']), summary: T.str(), findings: T.arr(FINDING) }, { strict: false });

function parseVerdict(raw) {
  const v = dropNulls(raw);
  const issues = VERDICT(v, '');
  if (issues.length) return { ok: false, issues };
  const findings = v.findings.map((f) => ({
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

// ---------- report scenarios ----------

const asText = (v) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

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
function readinessVerdict(r) {
  const statuses = r.criteria.map((c) => c.status);
  if (statuses.some((x) => x === 'partial' || x === 'not_met') || r.gaps.some((g) => g.severity === 'critical' || g.severity === 'high')) return 'not_ready';
  if (statuses.includes('unverifiable')) return 'needs_check';
  return 'ready';
}

function parseReadiness(raw) {
  const v = dropNulls(raw);
  const issues = READINESS(v, '');
  if (issues.length) return { ok: false, issues };
  const value = {
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

function parseAudit(raw) {
  const v = dropNulls(raw);
  const issues = AUDIT(v, '');
  if (issues.length) return { ok: false, issues };
  const rank = (f) => REPORT_SEVERITIES.indexOf(f.severity);
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

module.exports = {
  OUTPUTS,
  SCENARIOS,
  SCENARIO_OUTPUT,
  REPORT_SEVERITIES,
  CRITERION_STATUSES,
  INSTRUCTION_MODES,
  AGENT_COLORS,
  EFFORTS,
  AGENT_NAME,
  PLAN_TYPES,
  CHECKPOINT_OPTIONS,
  JIRA_ONLY_OPTIONS,
  INFO_EVENTS,
  STATE_EVENTS,
  isBlocking,
  validateConfigLayer,
  validateAgentPatch,
  parsePlanMeta,
  parseVerdict,
  parseReadiness,
  parseAudit,
  readinessVerdict,
};
