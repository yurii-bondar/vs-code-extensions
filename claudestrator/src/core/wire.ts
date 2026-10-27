// What the extension host and the dashboard page say to each other. The page cannot load Node modules, so this file
// holds only types and imports only other type-only modules: the host annotates what its handlers return with these
// types, and the page (media/*.ts) reads replies through them, so the compiler catches a field renamed on one side.
import type {
  Agent,
  Answer,
  AuditFinding,
  Checkpoint,
  Config,
  Criterion,
  Effort,
  Finding,
  Gap,
  GatesStatus,
  GitMode,
  Output,
  Pipeline,
  PlanMeta,
  Readiness,
  ReadinessVerdict,
  Runs,
  Scope,
  ScenarioStep,
  Source,
  SpecLink,
  Step,
  StoredPipeline,
} from './types';
import type { Chip } from './pipeline';

// ---------- where the dashboard is ----------

/** A screen of the dashboard and what to show on it. */
export interface Route {
  name: string;
  taskId?: string | undefined;
  compose?: string;
  scenario?: string | undefined;
  focus?: string;
  section?: string;
}

export interface Boot {
  route: Route | null;
  platform: string;
  version: string;
}

// ---------- models and effort ----------

/** The model and effort a model choice resolves to. */
export interface Resolved {
  model: string | undefined;
  effort: string | null;
}

export interface ModelInfo {
  value: string;
  model: string;
  name: string;
  efforts: string[];
}

/** The CLI's own answer about its models and defaults. */
export interface Defaults {
  byModel: Record<string, Resolved | null>;
  models: ModelInfo[];
  account: unknown;
  at: number;
}

/** The part of the defaults the page needs. */
export interface DefaultsView {
  models: ModelInfo[];
  byModel: Record<string, Resolved | null>;
}

/** What an agent runs with, with null parts when unknown. */
export interface Effective {
  model: string | null | undefined;
  modelName: string;
  modelIsDefault: boolean;
  effort: string | null | undefined;
  effortIsDefault: boolean;
  defaultEffort: string | null;
}

// ---------- the Claude Code account and machine ----------

/** The Claude Code account the agents run as, and where that choice comes from. */
export interface Account {
  loggedIn?: boolean;
  plan?: string;
  dir: string | null;
  shownDir: string;
  label: string;
  email?: string;
  source: string;
  sourceText: string;
}

/** An account in the switcher. */
export interface AccountEntry {
  dir: string;
  label: string;
  email?: string;
  current: boolean;
  loggedIn?: boolean;
}

/** One window of the account's limits. */
export interface LimitWindow {
  pct: number;
  resetsAt?: number | undefined;
  reset?: boolean;
  status?: string | undefined;
}

/** The newest limits seen: reported by agents, or read from a status line. */
export interface StoredLimits {
  fiveHour?: LimitWindow | undefined;
  sevenDay?: LimitWindow | undefined;
  at?: number;
  source?: string;
  model?: string;
  effort?: string;
}

export interface HealthChecking {
  checking: true;
}

export interface HealthReport {
  checking?: undefined;
  checkedAt: string | undefined;
  claude: { ok: boolean; version: string | undefined; path: string | null | undefined; error: string | undefined };
  git: { ok: boolean | undefined; version: string | undefined };
  gh: { ok: boolean | undefined; version: string | undefined; account: string | undefined; error: string | undefined; installed: boolean };
  node: { ok: boolean | undefined; path: string | null | undefined };
  account: Account;
  atlassian: boolean;
  atlassianMcp: string | null;
}

export type HealthSummary = HealthChecking | HealthReport;

// ---------- MCP servers ----------

/**
 * installed: configured, not checked yet (or disabled / awaiting approval) · connected: working ·
 * needs_auth: needs a (re)login · failed: cannot connect.
 */
export type McpState = 'installed' | 'connected' | 'needs_auth' | 'failed';

export interface McpServer {
  name: string;
  scope: string;
  state: McpState | string;
  transport?: string;
  target?: string;
  detail?: string;
  disabled?: boolean;
  pending?: boolean;
  missing?: boolean;
}

export interface McpServerView extends McpServer {
  canLogin: boolean;
  login: { since: number } | null;
}

export interface McpData {
  servers: McpServerView[];
  checking: boolean;
  checkedAt: string | null;
  error: string | null;
  /** Missing while the machine check has not finished. */
  account: Account | undefined;
}

export interface McpSummary {
  total: number;
  connected: number;
  problems: number;
  installed: number;
  checking: boolean;
}

// ---------- tasks in lists ----------

/** A repo that was not ready for a task, and why. */
export interface BlockedRepo {
  repo: string;
  dir: string;
  problem: string;
  files?: string[];
}

/** Why a task's last run failed. */
export interface TaskError {
  code?: string;
  message: string | undefined;
  blocked?: BlockedRepo[];
  at?: string;
}

/** What the engine is doing for a task right now. */
export interface Live {
  phase: string;
  text: string;
  step?: Step;
  key?: string;
  since?: number | undefined;
}

export interface PermissionRequest {
  requestId: string;
  taskId: string;
  agent: string;
  repo?: string;
  tool: string;
  input: unknown;
  at: number;
}

export interface Status {
  key: string;
  label: string;
  tone: string;
  group: string;
}

export interface TaskSource {
  kind: string;
  label: string;
  url?: string | undefined;
}

/** A compact task card for lists and the tree. A card of an unreadable task carries only what the catch-all branch of `summary` sets. */
export interface Card {
  taskId: string;
  title: string;
  source: TaskSource | null;
  scenario: string;
  scenarioLabel?: string;
  result?: { kind: string; verdict?: string; met?: number; total?: number; counts?: Record<string, number> };
  status: Status;
  checkpoint: { id: string; title: string | undefined; hint: string | undefined } | null;
  live: Live | null;
  error: TaskError | null | undefined;
  stopReason: string | undefined;
  round: number;
  maxRounds: number;
  phase: string;
  outcome: string | undefined;
  prs: Record<string, string>;
  branch: string | null;
  repos: string[];
  cost: number;
  createdAt: string;
  updatedAt: string;
  progress: { done: number; total: number };
  mini: { kind: string; agent: string | undefined; repo: string | undefined; label: string | undefined; status: string }[];
}

// ---------- one task ----------

/** One line of an agent's live output, as the runner emits it and the transcript file keeps it. */
export interface UsageItem {
  type: 'usage';
  t?: number;
  model: string | undefined;
  effort: string | null | undefined;
  ctxTokens: number;
  ctxWindow?: number;
  ctxPct?: number;
  tokens: number;
  costUsd: number;
}

export type TranscriptItem = (
  | { type: 'prompt'; text: string }
  | { type: 'text'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; isError: boolean; text: string }
  | { type: 'blocked'; tool: string; reason: string; input?: unknown }
  | { type: 'user'; text: string; from?: string | undefined }
  | { type: 'gates'; status: GatesStatus; attempt: number; summary: string; results?: Pick<GateResult, 'gate' | 'status' | 'ms'>[] }
  | { type: 'turn_end'; ok: boolean; costUsd: number; turns: number }
  | UsageItem
) & { t?: number };

/** One row of a task's timeline. Which fields are set depends on `kind`. */
export interface StepItem {
  kind: string;
  status: string;
  key?: string;
  id?: string;
  label?: string;
  agent?: string;
  repo?: string | undefined;
  round?: number;
  mode?: string;
  allRepos?: boolean;
  perRepo?: boolean;
  startedAt?: string;
  endedAt?: string;
  artifact?: string;
  gates?: string | undefined;
  verdict?: { status: string; findings: number; blocking: number };
  readiness?: { verdict: string; met: number; total: number };
  audit?: { findings: number; serious: number };
  error?: string;
  gateRuns?: { attempt: number; status: string }[];
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  ctxPct?: number;
  tokens?: number;
}

type ReportSummary = { agent: string; text: string; artifact: string };

export type AuditResult = {
  kind: 'audit';
  summaries: ReportSummary[];
  scope: string[];
  counts: Record<string, number>;
  findings: (AuditFinding & { agent: string })[];
};

export type ReadinessResult = {
  kind: 'readiness';
  verdict: ReadinessVerdict;
  summaries: ReportSummary[];
  criteria: (Criterion & { agent: string })[];
  met: number;
  gaps: (Gap & { agent: string })[];
  work: Readiness['work'];
  derivedCriteria: boolean;
};

/**
 * What the task's agents reported, merged: `{ kind: 'readiness', verdict, criteria, gaps, work, ... }` or
 * `{ kind: 'audit', counts, findings, ... }`; null until an agent reported.
 */
export type Result = AuditResult | ReadinessResult;

export interface TaskComment {
  seq: number | undefined;
  at: string;
  key: string;
  what: string;
  ok: boolean;
  via: string | undefined;
  error?: string;
}

/** A line of the activity feed. */
export interface FeedEvent {
  seq: number | undefined;
  at: string;
  type: string;
  tone: string;
  icon: string;
  text: string;
  artifact?: string;
}

/** Everything the task screen shows, before the checkpoint and ticket the panel adds. */
export type TaskDetail = Omit<Card, 'result'> & {
  input: string;
  auto: boolean;
  gitMode: GitMode;
  effort: Record<string, Effort>;
  model: Record<string, string>;
  pipeline: StoredPipeline;
  plan: PlanMeta | null;
  spec: { title: string; acceptanceCriteria: string[]; links: SpecLink[] } | null;
  openFindings: Finding[];
  result: Result | null;
  comments: TaskComment[];
  answers: Answer[];
  steps: StepItem[];
  events: FeedEvent[];
  files: { path: string; size: number; mtime: number }[];
  taskDir: string;
  permissions: PermissionRequest[];
  canMessage: boolean;
  liveUsage: (UsageItem & { key: string }) | null;
};

export interface CheckpointContext {
  format: 'markdown' | 'log';
  text: string;
  file?: string | undefined;
  repos?: { name: string; branch: string | null; base: string; files: number; dir: string }[];
}

/** What the task's pipeline editor shows: its stages, from which one they can change, and the agents to add. */
export interface PipelineEdit {
  from: number;
  stages: { agent: string; output: Output; scope: Scope; color: string | undefined }[];
  choices: { name: string; output: Output; runs: Runs | undefined; color: string | undefined; description: string; enabled: boolean }[];
  warnings: string[];
}

export type TaskScreen = TaskDetail & {
  checkpointContext?: CheckpointContext;
  checkpointFull?: Checkpoint;
  ticket: string;
  pipelineEdit: PipelineEdit | null;
};

export interface CommentResult {
  ok: boolean;
  error?: string;
  id?: string;
}

export interface WorktreeResult {
  repo: string;
  status: string;
  error?: string;
}

/** What the composer sends to start a task or preview one. */
export interface ComposerArgs {
  text?: string;
  auto?: boolean;
  no?: string[];
  key?: string | undefined;
  effort?: Record<string, string>;
  scenario?: string | undefined;
}

/** What a composer input would do, without creating anything. */
export type Preview =
  | { ok: false; error: string }
  | { ok: true; empty: true }
  | {
      ok: true;
      empty?: undefined;
      source: Source;
      taskId: string;
      exists: boolean;
      scenario: string;
      scenarioName: string;
      scenarioDetected: boolean;
      pipeline: Pipeline;
      effort: Record<string, string>;
      warnings: string[];
      problem?: string;
      outline?: Chip[];
    };

export interface SaveScenarioParams {
  id?: string | undefined;
  label?: string | undefined;
  description?: string | undefined;
  agents?: ScenarioStep[] | undefined;
}

export interface SetupParams {
  repos?: AddedRepo[] | undefined;
  language?: string | undefined;
  gitMode?: GitMode | undefined;
  map?: boolean | undefined;
  baseBranch?: string | undefined;
}

/** What the host pushes to a task screen while an agent works. */
export type TaskPush =
  | { type: 'output'; taskId: string; key: string; item: TranscriptItem }
  | { type: 'live'; taskId: string; live: Live | null };

// ---------- the workspace: config, repos, gates ----------

/** One agent of a scenario as the composer lists it, with the scenario's own model and effort when it sets them. */
export interface AgentSummary {
  name: string;
  scenario: string;
  color: string | undefined;
  output: Output;
  runs: Runs | undefined;
  enabled: boolean;
  description: string;
  model: string;
  effort: Effort | undefined;
  ownModel?: true;
  ownEffort?: true;
  actual: Effective;
}

export interface CatalogEntry {
  name: string;
  output: Output;
  runs: Runs | undefined;
  color: string | undefined;
  enabled: boolean;
  description: string;
}

export interface CustomScenarioSummary {
  id: string;
  label: string;
  description: string | undefined;
  kind: string | null;
}

export type ConfigSummary =
  | {
      ok: true;
      warnings: string[];
      agents: AgentSummary[];
      custom: CustomScenarioSummary[];
      removedScenarios: string[];
      catalog: CatalogEntry[];
      pipelineWarnings: string[];
      repos: string[];
      language: string;
      gitMode: GitMode;
      jiraProjects: string[];
    }
  | { ok: false; errors: string[]; warnings: string[] };

export interface Overview {
  root: string | null;
  rootName: string | null;
  hasConfig: boolean;
  config: ConfigSummary | null;
  health: HealthSummary;
  tasks: Card[];
  limits: StoredLimits | null;
  account: Account;
  accounts: AccountEntry[];
  mcp: McpSummary;
  defaults: DefaultsView | null;
  permissions: PermissionRequest[];
}

/** An agent in the agents page, without its (long) instructions. */
export type AgentView = Omit<Agent, 'instructions'> & {
  instructions?: undefined;
  instructionsPreview: string;
  instructionsLength: number;
  overridden: boolean;
  actual: Effective;
  builtin: boolean;
};

interface ConfigBase {
  root: string | null;
  hasConfig: boolean;
  files: { project: string | null; user: string };
  /** The workspace's config.yaml as written, layer by layer; the page only looks keys up in it. */
  layer: object;
  colors: readonly string[];
  outputs: readonly string[];
  efforts: readonly string[];
  builtins: string[];
  languages: string[];
}

export type ConfigData =
  | (ConfigBase & {
      ok: true;
      warnings: string[];
      config: Omit<Config, 'agents'> & { agents?: undefined };
      agents: AgentView[];
      pipeline: Pipeline;
      outline: Chip[];
      defaults: DefaultsView | null;
    })
  | (ConfigBase & { ok: false; errors: string[]; warnings: string[] });

/** A check suggested for a repo from what it uses. */
export interface SuggestedGate {
  name: string;
  cmd: string;
}

export interface RepoGuess {
  gates: SuggestedGate[];
  stack: string[];
  role: string | undefined;
  baseBranch: string | undefined;
}

export type FoundRepo = RepoGuess & { name: string; path: string; dir: string };

export interface PickedRepos {
  repos: (FoundRepo & { outside: boolean })[];
  notRepos: string[];
}

export interface DetectData {
  root?: string;
  repos: FoundRepo[];
}

export interface RepoStatus {
  name: string;
  dir: string;
  exists: boolean;
  isRepo: boolean;
  branch?: string | null;
  dirty?: number;
  last?: { hash: string | undefined; subject: string | undefined; when: string | undefined } | null;
  sync?: { ahead: number | undefined; behind: number | undefined } | null;
}

export interface GateConfig {
  name: string;
  cmd: string;
  dir?: string;
  when?: string;
}

/** A repo as the page sends it back from the setup wizard or the detected list. */
export interface AddedRepo {
  name: string;
  path: string;
  role?: string | undefined;
  baseBranch?: string | undefined;
  stack?: string[] | undefined;
  gates?: GateConfig[] | undefined;
}

export interface RepoView {
  name: string;
  role?: string;
  path: string;
  baseBranch: string;
  gates: GateConfig[];
  status: RepoStatus | undefined;
  suggested: SuggestedGate[];
}

export interface ContextFile {
  file: string;
  rel: string;
  exists: boolean;
  ref: string;
}

export interface ReposData {
  ok: boolean;
  errors: string[];
  repos: RepoView[];
  detected: FoundRepo[];
  context: ContextFile[];
  baseBranch: string;
}

/** One gate's outcome. */
export interface GateResult {
  repo: string;
  gate: string;
  status: GatesStatus;
  log?: string;
  ms?: number | undefined;
  tail?: string;
}

export interface RepoGates {
  repo: string;
  status: GatesStatus;
  results: GateResult[];
  summary: string;
}

// ---------- settings ----------

export interface SettingsData {
  claudePath: string | undefined;
  claudeConfigDir: string | undefined;
  claudeConfigDirResolved: string;
  settingSources: string[] | undefined;
  askPermissions: boolean | undefined;
  notifications: string | undefined;
  workspaceFolder: string | undefined;
  root: string | null;
  accounts: AccountEntry[];
  account: Account;
  atlassian: { site: string; email: string; hasToken: boolean; fromEnv: boolean; connected: boolean; mcp: { server: string; site: string | undefined } | null };
  health: HealthSummary;
}

export interface AtlassianUser {
  name: string | undefined;
  email: string | undefined;
}

// ---------- the requests ----------

type Void = void;

export interface NewAgentParams {
  name?: string | undefined;
  base?: string | undefined;
  description?: string | undefined;
  output?: Output | undefined;
  model?: string | undefined;
  effort?: Effort | undefined;
}

/** Every request the page can make: its parameters and what comes back. */
export interface Rpc {
  boot: { params: void; result: Boot };
  overview: { params: void; result: Overview };
  health: { params: { refresh?: boolean }; result: HealthSummary };
  detect: { params: void; result: DetectData };
  accounts: { params: void; result: { current: Account; accounts: AccountEntry[] } };
  setAccount: { params: { dir?: string | null }; result: Account };
  claudeLogin: { params: void; result: Void };
  config: { params: void; result: ConfigData };
  updateAgent: { params: { name: string; patch: Record<string, unknown> }; result: Void };
  resetAgent: { params: { name: string }; result: Void };
  setPipeline: { params: { pipeline: string[] }; result: Void };
  setScenario: { params: { scenario: string; agents: string[] }; result: Void };
  newAgent: { params: NewAgentParams; result: Void };
  editInstructions: { params: { name: string }; result: Void };
  setValue: { params: { keyPath: string[]; value: unknown }; result: Void };
  openConfig: { params: { which: string }; result: Void };
  openFile: { params: { taskId?: string; file: string; preview?: boolean }; result: unknown };
  repos: { params: void; result: ReposData };
  saveRepo: { params: { name?: string; oldName?: string; layer: { role?: string; path?: string; baseBranch?: string; gates?: GateConfig[] } }; result: Void };
  removeRepo: { params: { name: string }; result: Void };
  pickRepos: { params: { forSetup?: boolean } | undefined; result: PickedRepos | null };
  pickWorkspace: { params: void; result: string | null };
  addDetected: { params: { repos: AddedRepo[] }; result: Void };
  runGates: { params: { name: string; force?: boolean }; result: RepoGates };
  addContext: { params: void; result: Void };
  removeContext: { params: { file: string }; result: Void };
  createWorkspaceMap: { params: void; result: Void };
  settings: { params: void; result: SettingsData };
  updateSetting: { params: { key: string; value: unknown }; result: Void };
  pickClaude: { params: void; result: string | null };
  saveAtlassian: { params: { site?: string; email?: string; token?: string }; result: Void };
  testAtlassian: { params: void; result: AtlassianUser };
  mcp: { params: { refresh?: boolean }; result: McpData };
  mcpLogin: { params: { name: string }; result: Void };
  mcpShowLogin: { params: { name: string }; result: Void };
  mcpCancelLogin: { params: { name: string }; result: Void };
  mcpDetails: { params: { name: string }; result: string };
  task: { params: { taskId: string }; result: TaskScreen };
  editPipeline: { params: { taskId: string; names: string[] }; result: { warnings: string[] } };
  transcript: { params: { taskId: string; key: string }; result: TranscriptItem[] };
  run: { params: { taskId: string }; result: Void };
  stop: { params: { taskId: string }; result: Void };
  answer: { params: { taskId: string; checkpointId: string; option: string; feedback?: string | undefined }; result: Void };
  postReport: { params: { taskId: string }; result: CommentResult };
  retryComment: { params: { taskId: string; seq: number }; result: CommentResult };
  message: { params: { taskId: string; text: string }; result: Void };
  permission: { params: { requestId: string; allow: boolean; message?: string | undefined }; result: Void };
  openDiff: { params: { taskId: string }; result: Void };
  openRepo: { params: { taskId: string; repo: string }; result: Void };
  revealTask: { params: { taskId: string }; result: Void };
  deleteTask: { params: { taskId: string }; result: { deleted: boolean } };
  cleanup: { params: { taskId: string }; result: WorktreeResult[] };
  resumeTerminal: { params: { taskId: string; key: string }; result: Void };
  openExternal: { params: { url: string }; result: Void };
  copy: { params: { text: string }; result: Void };
  preview: { params: ComposerArgs; result: Preview };
  start: { params: ComposerArgs; result: { taskId: string; created: boolean } };
  saveScenario: { params: SaveScenarioParams; result: { id: string } };
  deleteScenario: { params: { id: string }; result: { deleted: boolean } };
  restoreScenario: { params: { id: string }; result: Void };
  setup: { params: SetupParams; result: { file: string } };
}

/** What `DashboardPanel` implements: one `$method` per request. */
export type RpcHandlers = { [M in keyof Rpc as `$${M}`]: (params: Rpc[M]['params']) => Promise<Rpc[M]['result']> };

/** Everything the host posts to the page: replies to requests, navigation, notices and live task output. */
export type HostMessage =
  | { type: 'res'; id: number; ok: true; data: unknown }
  | { type: 'res'; id: number; ok: false; error: string; code?: string | undefined; blocked?: BlockedRepo[] }
  | { type: 'navigate'; route: Route }
  | { type: 'changed' }
  | { type: 'config' }
  | { type: 'toast'; kind: string; text: string; taskId?: string | undefined }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permissionDone'; requestId: string }
  | TaskPush;
