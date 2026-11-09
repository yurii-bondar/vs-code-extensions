// Shared domain types of the orchestrator core: pipeline, task state, events, and what agents report.

export type Output = 'plan' | 'code' | 'tests' | 'verdict' | 'readiness' | 'audit';
/** A built-in scenario. Custom scenarios are named in config.yaml and are plain strings. */
export type Scenario = 'deliver' | 'readiness' | 'audit';
export type Scope = 'repo' | 'repos' | 'task';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Runs = 'per-repo' | 'all-repos';
export type Severity = 'blocker' | 'major' | 'minor';
export type ReportSeverity = 'critical' | 'high' | 'medium' | 'low';
export type CriterionStatus = 'met' | 'partial' | 'not_met' | 'unverifiable';
export type ReadinessVerdict = 'ready' | 'not_ready' | 'needs_check';
export type GitMode = 'branch' | 'worktree';
export type CheckpointId = 'approve-step' | 'approve-plan' | 'gate-failure' | 'agent-failure' | 'review-limit' | 'protected-changes' | 'hook-failure' | 'confirm-push' | 'post-review';
export type NextMode = 'initial' | 'retry' | 'replan' | 'fix';
export type GroupType = 'epic' | 'story' | 'group';

/** Untyped JSON as it comes from disk, the CLI or an agent. Narrow before use. */
export type JsonObject = Record<string, unknown>;

// ---------- pipeline ----------

export interface Stage {
  agent: string;
  output: Output;
  scope: Scope;
  approval: boolean;
  /** Stages next to each other with the same group run at once (read-only agents a scenario puts in a Parallel). */
  group?: number;
  /** The stage runs only when this holds (a branch of a scenario); otherwise it is skipped. */
  when?: StepWhen;
  /** After it, the task waits for you (a scenario's You approve): `text` is what to look at. */
  approve?: { text?: string };
}

/**
 * What a branch looks at: a result a step before it reported. `severity` and `audit` hold when a finding is at least
 * that serious; `gates` when the step's checks passed or were left failing.
 */
export type Condition =
  | { verdict: 'approved' | 'changes_requested' }
  | { severity: Severity }
  | { readiness: ReadinessVerdict }
  | { audit: ReportSeverity }
  | { gates: 'pass' | 'fail' };

/** A step of a branch: it runs when `on`'s result meets `if`, or, with `else`, when it does not. */
export interface StepWhen {
  on: string;
  if: Condition;
  else?: true;
}

export interface ReviewLoop {
  restartAt: number;
  end: number;
  fixers: string[];
  reviewers: string[];
  maxRounds: number;
  /** A scenario's own Loop, not the one its outputs make: a task with one keeps its stages as they are. */
  explicit?: true;
}

export interface PipelineWarning {
  level: 'warning';
  code: string;
  message: string;
  agent?: string;
}

export interface Pipeline {
  mode: string;
  scenario: string;
  stages: Stage[];
  reviewLoop: ReviewLoop | null;
  warnings: PipelineWarning[];
}

/** The part of a pipeline that is persisted in `task_created` and `pipeline_changed` events. */
export interface StoredPipeline {
  mode: string;
  stages: Stage[];
  reviewLoop: ReviewLoop | null;
  scenario?: string;
  warnings?: PipelineWarning[];
}

/** One run of an agent: the stage it belongs to and, for per-repo stages, the repo. */
export interface Step {
  stage: number;
  agent: string;
  repo?: string;
}

/** Anything that names a step: a step, or an event about one. */
export interface StepRef {
  agent: string;
  repo?: string | undefined;
}

// ---------- what agents report ----------

export interface PlanRepo {
  name: string;
  mode: 'full' | 'tests_only';
  /** The branch the task's branch starts from and its PR goes into, when the work is not on the repo's base. */
  baseBranch?: string;
}

export interface PlanMeta {
  type: string;
  slug: string;
  title?: string;
  repos: PlanRepo[];
  openQuestions: PlanQuestion[];
}

/** A question the planner leaves open, with the answer it goes on with. */
export interface PlanQuestion {
  question: string;
  default: string;
  /**
   * Only the user can answer it (a text legal must approve, a decision of the business), and no code is changed without
   * the answer: the plan waits for it, also in a task that runs on its own.
   */
  blocking?: boolean;
}

export interface Finding {
  severity: Severity;
  repo?: string;
  file?: string;
  line?: number;
  problem: string;
  fix?: string;
  /**
   * Set by Claudestrator when it records the verdict, never by the agent: the finding is about a file no agent changes
   * (the repo's Claude Code or VS Code settings), so it is yours and sends no repo into a fix round. On the event, so a
   * log replays as it was decided: one written before this field existed has none.
   */
  yours?: boolean;
}

export interface Verdict {
  status: 'approved' | 'changes_requested';
  summary: string;
  findings: Finding[];
}

/**
 * What a code or tests stage says of its own work: done, or blocked by what it cannot settle itself (a plan that does
 * not hold, a bug in code a tester may not change). Blocked stops the step at once for you to decide.
 */
export interface WorkReport {
  status: 'done' | 'blocked';
  blockers: string[];
}

export interface Criterion {
  criterion: string;
  status: CriterionStatus;
  evidence: string;
  files: string[];
}

export interface Gap {
  severity: ReportSeverity;
  problem: string;
  fix?: string;
}

export interface ReadinessValue {
  summary: string;
  criteria: Criterion[];
  gaps: Gap[];
  work: { repo: string; ref: string }[];
  derivedCriteria: boolean;
}

export interface Readiness extends ReadinessValue {
  verdict: ReadinessVerdict;
}

export interface AuditFinding {
  severity: ReportSeverity;
  title: string;
  category?: string;
  repo?: string;
  file?: string;
  line?: number;
  problem: string;
  impact?: string;
  fix?: string;
  effort?: string;
}

export interface Audit {
  summary: string;
  scope: string[];
  findings: AuditFinding[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

// ---------- config ----------

export interface Gate {
  name: string;
  cmd: string;
  dir?: string;
  when?: string;
  /** Seconds the check may run before it is stopped (1 to 86400); unset: the default of 15 minutes. */
  timeout?: number;
}

export interface RepoConfig {
  name: string;
  role?: string;
  path: string;
  baseBranch: string;
  gates: Gate[];
  /** Where its PRs go when origin's host does not say (a self-managed GitLab on `git.acme.com`). */
  forge?: ForgeOverride;
}

export interface Agent {
  name: string;
  enabled: boolean;
  lineage?: string[];
  description: string;
  model: string;
  tools?: string[];
  disallowedTools?: string[];
  /** `false`: the agent sees no MCP servers at all. Unset: the ones Claude Code loads for it. */
  mcp?: boolean;
  maxTurns?: number;
  effort?: Effort;
  runs?: Runs;
  color?: string;
  output: Output;
  instructions: string;
  instructionSources: { mode: string; source: string }[];
  layers: string[];
}

export interface ScenarioStep {
  name: string;
  model?: string;
  effort?: Effort;
  /** What the agent does in this scenario, after its own instructions: the text, read from `instructionsFile` when it has one. */
  instructions?: string;
  /** The file those instructions are kept in, as an absolute path. */
  instructionsFile?: string;
  /** Steps next to each other with the same number form a Parallel: read-only agents that run at once. */
  parallel?: number;
  /** A step of a Branch: it runs only when this holds. */
  when?: StepWhen;
  /** A step of the scenario's Loop (one, of steps next to each other): it runs again until the reviewers approve. */
  loop?: { rounds?: number };
  /** After it (after its Parallel, for one in a Parallel), the task waits for you: You approve. */
  approve?: { text?: string };
}

/** The model and effort of the agent that reads a Jira issue or Confluence page through an MCP server. */
export interface IntakeSettings {
  model: string;
  effort: Effort;
}

export interface CustomScenario {
  id: string;
  label: string;
  description?: string;
  /** What it reads its tickets with, over the config's `intake`. */
  intake?: Partial<IntakeSettings>;
  kind: string | null;
  agents: ScenarioStep[];
  /** The layer that defines it: `project`, `user`, or `library:<name>`. */
  source: string;
}

/** What a task belongs to: an epic, a story or a plain group, optionally with its Jira issue. */
export interface TaskGroup {
  id: string;
  type: GroupType;
  label: string;
  jira?: string;
  /** What every agent of every task in the group follows, before the task's own instructions. */
  instructions?: string;
  /** Ids of instructions the composer ticks when the group is picked; a task can still untick them. */
  defaultInstructions?: string[];
  /**
   * The branch its tasks start from (and open their PRs into), in each repo where origin has it: an epic's own branch,
   * `feat/checkout-revamp`. Elsewhere, and where a plan names another, the repo's base as before.
   */
  baseBranch?: string;
}

/** Instructions the user wrote once and picks per task; every agent of the task gets them. */
export interface TaskInstruction {
  id: string;
  label: string;
  text: string;
}

export interface Limits {
  reviewRounds: number;
  gateAttempts: number;
  budgetUsd?: number;
  /** How many tasks may run agents at once; unset: no cap. */
  parallelTasks?: number;
}

export interface Policy {
  protectedBranches: string[];
  draftPrsOnly: boolean;
  forbidAiAttribution: boolean;
  allowNoVerify: boolean;
  /** Run the agents' shell commands in Claude Code's sandbox (macOS, Linux, WSL2). */
  sandbox: boolean;
  /** Hosts sandboxed commands may reach besides the package registries. */
  network: string[];
  /** Folders sandboxed commands (agents' and checks') may write besides the repo: build caches such as `~/.cache/go-build`. */
  writable: string[];
  /**
   * Let sandboxed commands open local ports and reach what listens on them: a test that starts a server on 127.0.0.1.
   * It matters on macOS, where every service listening on the machine becomes reachable; Linux's sandbox has a
   * loopback of its own.
   */
  localPorts: boolean;
  /** Variables of your environment that checks and git hooks keep although they look like credentials (a test database's URL). */
  checkEnv: string[];
  /**
   * What becomes of a change an agent makes to the repo's Claude Code or VS Code settings (`.claude/`, `.mcp.json`,
   * `.vscode/`), which it never writes itself: `ask` puts it to you to apply, `rules` applies the rules of `.claude/rules/`
   * at once and asks for the rest, `off` only tells you, for you to make it.
   */
  protectedChanges: ProtectedMode;
}

export type ProtectedMode = 'off' | 'ask' | 'rules';

/** A change an agent made to a file of the repo's settings, kept for you: the content is a task artifact. */
export interface ProtectedChange {
  repo: string;
  /** Where it goes in the repo, with forward slashes: `.claude/rules/forms.md`. */
  file: string;
  /**
   * The task artifact that holds the file's content as the agent wrote it. None: the agent tried with a shell command,
   * which the sandbox refused, so its content is not known.
   */
  artifact?: string;
}

export interface Config {
  agents: Record<string, Agent>;
  pipeline: string[];
  scenarios: Record<string, string[]>;
  custom: Record<string, CustomScenario>;
  removedScenarios: string[];
  pipelineSource: string;
  limits: Limits;
  language: string;
  intake: IntakeSettings;
  baseBranch: string;
  repos: Record<string, RepoConfig>;
  jira: { allowedProjects: string[] };
  policy: Policy;
  context: string[];
  git: { mode: GitMode };
  groups: Record<string, TaskGroup>;
  instructions: Record<string, TaskInstruction>;
  /** Every file the config is read from: config and library files (also where none is yet), instruction and context files. */
  sources: string[];
}

export interface Diagnostic {
  level: 'error' | 'warning';
  code: string;
  message: string;
  agent?: string | undefined;
  source?: string | undefined;
}

// ---------- tickets ----------

/** Where a repo's pull or merge requests go: GitHub, GitLab (also where a task's issue may be), Bitbucket Cloud. */
export type ForgeKind = 'github' | 'gitlab' | 'bitbucket';
/** The forges `repos.<name>.forge` can name, for a host whose name does not say (Bitbucket Cloud is bitbucket.org). */
export type ForgeOverride = 'github' | 'gitlab';

export type Source = (
  | { kind: 'jira'; key: string; site?: string }
  | { kind: 'confluence'; pageId: string; url: string }
  /** A GitHub issue: `repo` is `owner/name`, `host` github.com or a GitHub Enterprise host. */
  | { kind: 'github'; host: string; repo: string; number: number }
  /** A GitLab issue: `project` is its full path (`group/sub/name`), `host` gitlab.com or a self-managed host. */
  | { kind: 'gitlab'; host: string; project: string; number: number }
  /** A Linear issue, read through the account's Linear MCP server. */
  | { kind: 'linear'; key: string; url: string }
  /**
   * A pull request (GitHub, Bitbucket) or merge request (GitLab) to review: `project` is the repo's path on the forge
   * (`owner/name`, `group/sub/name`, `workspace/repo`).
   */
  | { kind: 'pr'; forge: ForgeKind; host: string; project: string; number: number }
  | { kind: 'text'; text: string }
) & {
  /** What the user wrote next to the issue key ("check it is ready"). */
  note?: string;
};

export interface SpecLink {
  title: string;
  url: string;
}

/** A pull request under review, as its forge described it when the task read it. */
export interface PullRequestInfo {
  url: string;
  /** The workspace's repo whose origin it is on. */
  repo: string;
  /** Where it merges into, and the branch it comes from. */
  base: string;
  head: string;
  /** The commit reviewed: its comments are made on it. */
  headSha: string;
  /** GitLab's diff refs, which an MR's inline comment names. */
  baseSha?: string;
  startSha?: string;
}

export interface Spec {
  id: string;
  source: Source;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  links: SpecLink[];
  request?: string;
  context?: string;
  /** A pull request under review. */
  pr?: PullRequestInfo;
}

// ---------- task state ----------

export type TaskStatus = 'active' | 'waiting' | 'stopped' | 'done';
export type TaskPhase = 'intake' | 'stages' | 'finish' | 'done';

export interface GroupProgress {
  id: number;
  done: Step[];
  failed: { step: Step; error: string; blocked?: true }[];
}

export interface Checkpoint {
  id: CheckpointId;
  options: string[];
  step?: Step;
  reason?: string;
  /** An agent-failure where the agent said it cannot go on, rather than one that ended without a usable report. */
  blocked?: boolean;
  /**
   * The failure reads as the one the retry before it ended in: a retry as it was ends there again, unless its cause was
   * fixed meanwhile outside the task (a setting, the branch), which no event records. A warning, never a refusal.
   */
  repeated?: boolean;
  at: string;
}

export interface RecordedVerdict {
  agent: string;
  artifact: string;
  status: Verdict['status'];
  findings: Finding[];
  /** The diff this verdict was given had no changed file in any repo. */
  emptyDiff?: boolean;
}

export interface ReviewState {
  round: number;
  maxRounds: number;
  fixing: boolean;
  fixRepos: string[];
  /** Review rounds in a row whose diff was empty: the fix rounds are changing nothing. */
  emptyRounds: number;
  verdicts: RecordedVerdict[];
  lastVerdicts: RecordedVerdict[];
  openFindings: Finding[];
  /** What you said for the fix round ("Priorities for the fix round"): every step of the round gets it. */
  roundFeedback?: string | null | undefined;
}

export interface Artifact {
  agent: string;
  repo?: string;
  round: number;
  output: Output;
  path: string;
  at: string;
}

export interface Report {
  agent: string;
  output: Output;
  artifact: string;
  value: Readiness | Audit | undefined;
}

export interface Answer {
  id: string;
  option: string;
  feedback?: string;
  at: string;
}

export interface TaskState {
  taskId: string;
  input: string;
  source: Source;
  scenario: string;
  scenarioName?: string;
  scenarioLabel?: string | undefined;
  /** The group as it was when the task started. */
  group?: TaskGroup;
  /** The instructions as they were when the task started: editing one later does not change a running task. */
  instructions: TaskInstruction[];
  auto: boolean;
  pipeline: StoredPipeline;
  knownRepos: string[];
  contextFiles: string[];
  gitMode: GitMode;
  effort: Record<string, Effort>;
  model: Record<string, string>;
  /** Per agent, what its custom scenario's step adds to its instructions, as it was when the task started. */
  stepInstructions: Record<string, string>;
  /** What reads its ticket through an MCP server, as it was when the task started. */
  intake: IntakeSettings;
  limits: Pick<Limits, 'reviewRounds' | 'gateAttempts'>;
  status: TaskStatus;
  phase: TaskPhase;
  repos: PlanRepo[];
  next: Step | null;
  nextMode: NextMode;
  feedback: string | null;
  /** The steps an agent works on now: one, or the members of a parallel group. */
  running: Step[];
  /**
   * A parallel group under way: its members that ended well, and the ones that failed. The task moves on once none
   * runs; a failure then asks you about it, one at a time.
   */
  parallel?: GroupProgress;
  /**
   * "Run it again" at You approve after a per-repo stage: each of its repos runs again with your words, until the task
   * waits for you there again.
   */
  rerun?: { stage: number; feedback: string | null };
  checkpoint: Checkpoint | null;
  review: ReviewState;
  /** `post`: a pull request's review goes to it, as you said. */
  finishStep: 'commit' | 'confirm' | 'publish' | 'post' | null;
  gateFailures: Step[];
  artifacts: Artifact[];
  reports: Report[];
  answers: Answer[];
  prs: Record<string, string>;
  /** A pull request's review, once posted to it. */
  reviewPosted?: { url: string; inline: number };
  createdAt: string;
  updatedAt: string;
  spec?: Spec;
  plan?: PlanMeta;
  outcome?: string;
  /** The last failure a retry answered (an agent's step, a commit a hook rejected), until a step or a commit goes through. */
  lastFailure?: { id: CheckpointId; step?: Step; reason: string };
  /** Changes agents made to the repos' settings, waiting for you since their step ended. */
  proposed?: ProtectedChange[];
}

// ---------- events ----------

export interface EventBase {
  at: string;
  seq?: number;
}

export type GatesStatus = 'pass' | 'fail' | 'skipped';

export interface AgentStoppedPayload {
  costUsd?: number;
  turns?: number;
  sessionId?: string | undefined;
  cwd?: string;
  /** The Claude Code account (config folder) the session ran under: where `claude --resume` finds it. */
  configDir?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  ctxPct?: number | undefined;
  tokens?: number | undefined;
  transcript?: string;
  [key: string]: unknown;
}

export type OrchEvent = EventBase &
  (
    | {
        type: 'task_created';
        taskId: string;
        input: string;
        source: Source;
        scenario?: string;
        scenarioName?: string;
        scenarioLabel?: string | undefined;
        group?: TaskGroup;
        instructions?: TaskInstruction[];
        auto: boolean;
        pipeline: StoredPipeline;
        knownRepos: string[];
        contextFiles?: string[];
        gitMode?: GitMode;
        effort?: Record<string, Effort> | undefined;
        model?: Record<string, string> | undefined;
        stepInstructions?: Record<string, string> | undefined;
        intake?: IntakeSettings | undefined;
        limits: Pick<Limits, 'reviewRounds' | 'gateAttempts'>;
      }
    | { type: 'intake_completed'; spec: Spec; repos?: PlanRepo[]; plan?: PlanMeta }
    | { type: 'stage_started'; agent: string; repo?: string }
    | {
        type: 'stage_completed';
        agent: string;
        repo?: string;
        artifact: string;
        plan?: PlanMeta;
        verdict?: Verdict;
        readiness?: Readiness;
        audit?: Audit;
        gates?: 'none' | 'pass' | 'fail';
        /** A verdict stage: the diff it reviewed had no changed file in any repo. */
        emptyDiff?: boolean;
        /** A code or tests stage: what it changed of the repos' settings, which no agent writes, kept for you. */
        protectedChanges?: ProtectedChange[];
      }
    | {
        type: 'stage_failed';
        agent: string;
        repo?: string;
        error: string;
        blocked?: boolean;
        /** What the step changed of the repos' settings before it failed, kept for you as when it completes. */
        protectedChanges?: ProtectedChange[];
      }
    | { type: 'checkpoint_answered'; id: string; option: string; feedback?: string }
    | { type: 'committed'; repos: string[] }
    | { type: 'commit_failed'; repo: string; output: string }
    | { type: 'published'; prs: Record<string, string> }
    /** A pull request's review, posted to it: where, and how many comments on its lines. */
    | { type: 'review_posted'; url: string; inline: number }
    | { type: 'stopped'; reason?: string }
    | { type: 'resumed' }
    | { type: 'pipeline_changed'; pipeline: StoredPipeline }
    | { type: 'agent_stopped'; agent: string; payload?: AgentStoppedPayload }
    /** A session's running totals as it goes (its id once it starts, its cost after each turn): what a session that never ends spent still counts. */
    | { type: 'agent_progress'; agent: string; payload: AgentStoppedPayload }
    /** A PR opened while publishing, as soon as it is there: a later repo that fails does not leave it untold. */
    | { type: 'pr_opened'; repo: string; url: string }
    | { type: 'note'; message: string }
    | { type: 'gates_ran'; agent: string; repo?: string; repos?: string[]; status: GatesStatus; attempt: number; summary: string }
    | { type: 'transition_rejected'; event?: unknown; code: string; error: string }
    | {
        type: 'jira_comment';
        key: string;
        what: string;
        ok: boolean;
        via?: string;
        error?: string;
        commentId?: string;
        text?: string;
      }
  );

export type EventType = OrchEvent['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The event of one type: `EventOf<'stopped'>`. */
export type EventOf<T extends EventType> = Extract<OrchEvent, { type: T }>;

/** An event as handed to `dispatch`: the time and sequence number are added on the way in. */
export type EventBody = DistributiveOmit<OrchEvent, 'at' | 'seq'>;

/** An event on its way to the log: timed, not yet numbered. */
export type NewEvent = DistributiveOmit<OrchEvent, 'seq'>;

export type Transition = { ok: true; state: TaskState } | { ok: false; error: { code: string; message: string } };
