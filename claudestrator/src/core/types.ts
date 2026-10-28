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
export type CheckpointId = 'approve-plan' | 'gate-failure' | 'agent-failure' | 'review-limit' | 'hook-failure' | 'confirm-push';
export type NextMode = 'initial' | 'retry' | 'replan' | 'fix';

/** Untyped JSON as it comes from disk, the CLI or an agent. Narrow before use. */
export type JsonObject = Record<string, unknown>;

// ---------- pipeline ----------

export interface Stage {
  agent: string;
  output: Output;
  scope: Scope;
  approval: boolean;
}

export interface ReviewLoop {
  restartAt: number;
  end: number;
  fixers: string[];
  reviewers: string[];
  maxRounds: number;
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
}

export interface PlanMeta {
  type: string;
  slug: string;
  title?: string;
  repos: PlanRepo[];
  openQuestions: { question: string; default: string }[];
}

export interface Finding {
  severity: Severity;
  repo?: string;
  file?: string;
  line?: number;
  problem: string;
  fix?: string;
}

export interface Verdict {
  status: 'approved' | 'changes_requested';
  summary: string;
  findings: Finding[];
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
}

export interface RepoConfig {
  name: string;
  role?: string;
  path: string;
  baseBranch: string;
  gates: Gate[];
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
}

export interface CustomScenario {
  id: string;
  label: string;
  description?: string;
  kind: string | null;
  agents: ScenarioStep[];
  /** The layer that defines it: `project`, `user`, or `library:<name>`. */
  source: string;
}

export interface Limits {
  reviewRounds: number;
  gateAttempts: number;
  budgetUsd?: number;
}

export interface Policy {
  protectedBranches: string[];
  draftPrsOnly: boolean;
  forbidAiAttribution: boolean;
  allowNoVerify: boolean;
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
  baseBranch: string;
  repos: Record<string, RepoConfig>;
  jira: { allowedProjects: string[] };
  policy: Policy;
  context: string[];
  git: { mode: GitMode };
  editor?: string;
}

export interface Diagnostic {
  level: 'error' | 'warning';
  code: string;
  message: string;
  agent?: string | undefined;
  source?: string | undefined;
}

// ---------- tickets ----------

export type Source = (
  | { kind: 'jira'; key: string; site?: string }
  | { kind: 'confluence'; pageId: string; url: string }
  | { kind: 'text'; text: string }
) & {
  /** What the user wrote next to the issue key ("check it is ready"). */
  note?: string;
};

export interface SpecLink {
  title: string;
  url: string;
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
}

// ---------- task state ----------

export type TaskStatus = 'active' | 'waiting' | 'stopped' | 'done';
export type TaskPhase = 'intake' | 'stages' | 'finish' | 'done';

export interface Checkpoint {
  id: CheckpointId;
  options: string[];
  step?: Step;
  reason?: string;
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
  auto: boolean;
  pipeline: StoredPipeline;
  knownRepos: string[];
  contextFiles: string[];
  gitMode: GitMode;
  effort: Record<string, Effort>;
  model: Record<string, string>;
  limits: Pick<Limits, 'reviewRounds' | 'gateAttempts'>;
  status: TaskStatus;
  phase: TaskPhase;
  repos: PlanRepo[];
  next: Step | null;
  nextMode: NextMode;
  feedback: string | null;
  running: Step | null;
  checkpoint: Checkpoint | null;
  review: ReviewState;
  finishStep: 'commit' | 'confirm' | 'publish' | null;
  gateFailures: Step[];
  artifacts: Artifact[];
  reports: Report[];
  answers: Answer[];
  prs: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  spec?: Spec;
  plan?: PlanMeta;
  outcome?: string;
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
        auto: boolean;
        pipeline: StoredPipeline;
        knownRepos: string[];
        contextFiles?: string[];
        gitMode?: GitMode;
        effort?: Record<string, Effort> | undefined;
        model?: Record<string, string> | undefined;
        limits: Pick<Limits, 'reviewRounds' | 'gateAttempts'>;
      }
    | { type: 'intake_completed'; spec: Spec; repos?: PlanRepo[] }
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
      }
    | { type: 'stage_failed'; agent: string; repo?: string; error: string }
    | { type: 'checkpoint_answered'; id: string; option: string; feedback?: string }
    | { type: 'committed'; repos: string[] }
    | { type: 'commit_failed'; repo: string; output: string }
    | { type: 'published'; prs: Record<string, string> }
    | { type: 'stopped'; reason?: string }
    | { type: 'resumed' }
    | { type: 'pipeline_changed'; pipeline: StoredPipeline }
    | { type: 'agent_stopped'; agent: string; payload?: AgentStoppedPayload }
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
