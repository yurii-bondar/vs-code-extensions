// What the dashboard scripts share. They are plain scripts loaded one after the other (markdown.js, app.js,
// task.js, config.js), not modules: markdown.js sets two functions on `window`, app.js publishes the shell API on
// `window.CS`, and the views register themselves there. The page is built from HTML strings and DOM events.
// What the host sends comes through the types of src/core/wire.ts.

type Route = import('../src/core/wire').Route;
type Overview = import('../src/core/wire').Overview;
type DefaultsView = import('../src/core/wire').DefaultsView;
type Chip = import('../src/core/pipeline').Chip;
type Status = import('../src/core/wire').Status;
type Live = import('../src/core/wire').Live;
type TaskSource = import('../src/core/wire').TaskSource;
type PermissionRequest = import('../src/core/wire').PermissionRequest;
type Card = import('../src/core/wire').Card;
type AgentSummary = import('../src/core/wire').AgentSummary;
type ConfigSummary = import('../src/core/wire').ConfigSummary;
type HealthSummary = import('../src/core/wire').HealthSummary;
type StoredLimits = import('../src/core/wire').StoredLimits;
type LimitWindow = import('../src/core/wire').LimitWindow;
type Account = import('../src/core/wire').Account;
type AccountEntry = import('../src/core/wire').AccountEntry;
type Preview = import('../src/core/wire').Preview;
type HostMessage = import('../src/core/wire').HostMessage;
type ScenarioStep = import('../src/core/types').ScenarioStep;
type GitMode = import('../src/core/types').GitMode;
type FoundRepo = import('../src/core/wire').FoundRepo;
type SuggestedGate = import('../src/core/wire').SuggestedGate;
type AddedRepo = import('../src/core/wire').AddedRepo;
type ConfigData = import('../src/core/wire').ConfigData;
type LibraryView = import('../src/core/wire').LibraryView;
type AgentView = import('../src/core/wire').AgentView;
type Effective = import('../src/core/wire').Effective;
type ReposData = import('../src/core/wire').ReposData;
type RepoView = import('../src/core/wire').RepoView;
type PickedRepos = import('../src/core/wire').PickedRepos;
type RepoGates = import('../src/core/wire').RepoGates;
type GateConfig = import('../src/core/wire').GateConfig;
type SettingsData = import('../src/core/wire').SettingsData;
type McpData = import('../src/core/wire').McpData;
type McpServerView = import('../src/core/wire').McpServerView;
type Output = import('../src/core/types').Output;
type Effort = import('../src/core/types').Effort;
type TaskScreen = import('../src/core/wire').TaskScreen;
type TaskComment = import('../src/core/wire').TaskComment;
type TaskPush = import('../src/core/wire').TaskPush;
type TaskResult = import('../src/core/wire').Result;
type TranscriptItem = import('../src/core/wire').TranscriptItem;
type UsageItem = import('../src/core/wire').UsageItem;
type StepItem = import('../src/core/wire').StepItem;
type FeedEvent = import('../src/core/wire').FeedEvent;
type PipelineEdit = import('../src/core/wire').PipelineEdit;
type CheckpointContext = import('../src/core/wire').CheckpointContext;

// ---------- requests ----------

type Rpc = import('../src/core/wire').Rpc;

/** The arguments after the method name: none when the request takes none, optional when `undefined` is allowed. */
type RpcArgs<P> = 0 extends 1 & P ? [params?: P] : [P] extends [void] ? [] : undefined extends P ? [params?: P] : [params: P];
/** What `attempt` resolves to: the result, `true` for a request without one, `undefined` on failure. */
type Attempted<R> = (R extends void ? true : R) | undefined;

// ---------- DOM ----------

/** The data-* attributes the templates set; a handler reads only the ones its own template wrote. */
type DataKey =
  | 'name' | 'id' | 'repo' | 'path' | 'i' | 'j' | 'field' | 'file' | 'preview' | 'tab' | 'url' | 'pipe' | 'tool' | 'since'
  | 'sev' | 'scenario' | 'level' | 'kind' | 'dir' | 'allow' | 'text' | 'seq' | 'runs' | 'option' | 'cmd' | 'key' | 'action'
  | 'change' | 'input' | 'href';
interface WithData {
  readonly dataset: Readonly<Record<DataKey, string>>;
}
/** An element a click handler was bound to; `disabled` is there for the buttons. */
type ActionEl = HTMLElement & WithData & { disabled?: boolean };
/** An input, textarea or select a change or input handler was bound to; `type` stays a plain string. */
type FieldEl = Omit<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement, 'type' | 'dataset'> & { type: string } & WithData;
type ActionFn = (el: ActionEl, e: Event) => unknown;
type FieldFn = (el: FieldEl, e: Event) => unknown;

// ---------- state ----------

interface Draft {
  text: string;
  no: string[];
  auto: boolean;
  key: string;
  effort: Record<string, string>;
  scenario: string;
}

/** Small interface state that survives a reload: which groups are folded, which scenario is being edited. */
interface UiState {
  scEdit?: string | null;
  /** A new scenario not saved yet: it reaches config.yaml with its first agent. */
  scDraft?: { label: string; description: string } | null;
  showAllDone?: boolean;
  taskTab?: string;
  pipeEdit?: boolean;
  [flag: string]: unknown;
}

interface AppState {
  route: Route;
  overview: Overview | null;
  draft: Draft;
  ui: UiState;
}

interface PersistedState {
  route?: Route;
  draft?: Partial<Draft>;
  ui?: UiState;
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): PersistedState | undefined; setState(state: PersistedState): void };

// ---------- views ----------

/** A screen. The shell calls these; each view adds its own members. */
interface View {
  enter(route: Route): unknown;
  leave?(): void;
  refresh?(): unknown;
  load?(refresh?: boolean): unknown;
  onConfig?(): void;
  onPermission?(): void;
  onPush?(msg: TaskPush): void;
  onSubmit?(e: KeyboardEvent): void;
  actions?: Record<string, ActionFn>;
  changes?: Record<string, FieldFn>;
  inputs?: Record<string, FieldFn>;
}

/** Screens by route name; each script declares its own with `interface Views { … }`. */
interface Views {
  [name: string]: View;
}

// ---------- the shell's API ----------

interface PipeStage {
  agent: string;
  output: string;
  color?: string | undefined;
  scope?: string | undefined;
  runs?: string | undefined;
  enabled?: boolean | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  ownModel?: boolean | undefined;
  ownEffort?: boolean | undefined;
}

interface PipeChoice {
  name: string;
  output: string;
  enabled?: boolean | undefined;
  color?: string | undefined;
  description?: string | undefined;
}

interface PipeRowOptions {
  stages: PipeStage[];
  from?: number;
  choices?: PipeChoice[];
  empty?: string;
  runsToggle?: boolean;
  extras?: ((st: PipeStage) => string) | null;
}

/** An editor of an ordered list of agents shown as chips; each is registered under the id of its row. */
interface PipeEditor {
  names(): string[];
  from(): number;
  save(names: string[]): unknown;
  redraw?(): void;
  setRuns?(name: string, runs: string): unknown;
}

interface ScenarioInfo {
  label: string;
  icon: string;
  hint: string;
  placeholder: string;
}

interface ToastAction {
  label: string;
  run(): void;
}

interface CSApi {
  vscode: ReturnType<typeof acquireVsCodeApi>;
  call<M extends keyof Rpc>(method: M, ...params: RpcArgs<Rpc[M]['params']>): Promise<Rpc[M]['result']>;
  attempt<M extends keyof Rpc>(method: M, params?: Rpc[M]['params'], okText?: string | null): Promise<Attempted<Rpc[M]['result']>>;
  toast(text: string, kind?: string, action?: ToastAction): void;
  icon(name: string, cls?: string): string;
  esc(s: unknown): string;
  md(text: string): string;
  $<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T | null;
  $$<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T[];
  ago(iso: string | undefined | null): string;
  clock(t: string | number | Date): string;
  dur(ms: number): string;
  money(n: number): string;
  fmtTokens(n: number | undefined | null): string;
  resetIn(unix: number | undefined | null): string;
  meter(pct: number | undefined | null): string;
  level(pct: number | undefined | null): string;
  EFFORT_LABEL: Record<string, string>;
  effortTag(e: string | undefined | null): string;
  size(n: number): string;
  plural(n: number, one: string, many?: string): string;
  stepName(s: { agent?: string | undefined; label?: string | undefined; repo?: string | undefined; perRepo?: boolean | undefined }): string;
  OUTPUT_INFO: Record<string, { label: string; hint: string }>;
  SCENARIO_INFO: Record<string, ScenarioInfo>;
  scInfo(id: string): ScenarioInfo & { kind: string; custom?: true };
  modelChoices(defaults: DefaultsView | null | undefined): [string, string][];
  scenarioChip(sc: string | undefined, label: string | undefined): string;
  sevCounts(counts: Record<string, number>): string;
  agentColor(c: string | undefined | null): string;
  S: AppState;
  views: Views;
  pipeRowHtml(id: string, opts: PipeRowOptions): string;
  libraryBlock(l: LibraryView): string;
  libraryMove(kind: 'agent' | 'scenario', id: string, libs: LibraryView[]): string;
  pipeEditors: Record<string, PipeEditor | undefined>;
  pipeDragging(): boolean;
  go(route: Route): Promise<void>;
  patch(name: string | HTMLElement, html: string): boolean;
  debounce(key: string, fn: () => unknown, ms?: number): void;
  persist(): void;
  statusBadge(st: Pick<Status, 'key' | 'tone' | 'label'>, live: Live | null | undefined): string;
  miniSteps(mini: { kind: string; agent: string | undefined; repo: string | undefined; label: string | undefined; status: string }[]): string;
  sourceChip(src: TaskSource | null | undefined): string;
  outlineHtml(items: Chip[] | null | undefined, colors?: Record<string, string | undefined>): string;
  permissionCard(p: PermissionRequest): string;
  loadOverview(): Promise<Overview>;
  autosize(ta: HTMLElement | null): void;
  shake(el: HTMLElement | null): void;
  refreshSoon(): void;
  actions: Record<string, ActionFn>;
  changes: Record<string, FieldFn>;
  inputs: Record<string, FieldFn>;
  boot(): Promise<void>;
}

interface Window {
  escapeHtml: (s: unknown) => string;
  renderMarkdown: (text: string) => string;
  CS: CSApi;
}
