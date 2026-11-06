// What the dashboard page may ask the host: every request's parameters are checked here, at the boundary, so a
// handler only ever sees the shape `Rpc` promises it.
import * as path from 'path';
import { T, EFFORTS, GROUP_TYPES, OUTPUTS, type Check } from './protocol';
import { MODEL_ID } from './fix';
import type { Rpc } from './wire';

/** A request from the page, checked: its id, its method and parameters of the shape that method takes. */
type PageRequest = { [M in keyof Rpc]: { id: number; method: M; params: Rpc[M]['params'] } }[keyof Rpc];

type Parsed = { ok: true; request: PageRequest } | { ok: false; id: number | null; error: string };

/** Extra fields are left to the handler to ignore: the page may send more than a handler reads. */
const obj = (shape: Record<string, Check>): Check => T.obj(shape, { strict: false });
const none: Check = (v, p) => (v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) ? [] : [`${p || '(root)'}: takes no parameters`]);
const anything: Check = () => [];
const nullable = (check: Check): Check => (v, p) => (v === null ? [] : check(v, p));

const id = T.str(1);
const named = obj({ name: id });
const byId = obj({ id });
const task = obj({ taskId: id });
const gate = obj({ name: T.str(1), cmd: T.str(1), 'dir?': T.str(), 'when?': T.str(), 'timeout?': T.int(1, 24 * 60 * 60) });
const addedRepo = obj({ name: T.str(1), path: T.str(1), 'role?': T.str(), 'baseBranch?': T.str(), 'stack?': T.arr(T.str()), 'gates?': T.arr(gate) });
const composer = obj({
  'text?': T.str(),
  'auto?': T.bool(),
  'no?': T.arr(T.str()),
  'key?': T.str(),
  'effort?': T.rec(T.str(), T.str()),
  'scenario?': T.str(),
  'group?': T.str(),
  'instructions?': T.arr(T.str(1)),
});

/** One checker per request; the compiler makes sure a new request gets one. */
const PARAMS: { [M in keyof Rpc]: Check } = {
  boot: none,
  view: obj({ taskId: nullable(id) }),
  overview: none,
  health: obj({ 'refresh?': T.bool() }),
  detect: none,
  accounts: none,
  setAccount: obj({ 'dir?': nullable(T.str()) }),
  claudeLogin: none,
  config: none,
  updateAgent: obj({ name: id, patch: T.rec(T.str(1), anything) }),
  resetAgent: named,
  setPipeline: obj({ pipeline: T.arr(T.str(1)) }),
  setScenario: obj({ scenario: id, agents: T.arr(T.str(1)) }),
  newAgent: obj({ 'name?': T.str(), 'base?': T.str(), 'description?': T.str(), 'output?': T.oneOf(OUTPUTS), 'model?': T.str(), 'effort?': T.oneOf(EFFORTS) }),
  editInstructions: named,
  setValue: obj({ keyPath: T.arr(T.str(1), 1), 'value?': anything }),
  openConfig: obj({ which: id }),
  openFile: obj({ 'taskId?': id, file: T.str(1), 'preview?': T.bool() }),
  repos: none,
  saveRepo: obj({ 'name?': T.str(), 'oldName?': T.str(), layer: obj({ 'role?': T.str(), 'path?': T.str(), 'baseBranch?': T.str(), 'gates?': T.arr(gate) }) }),
  removeRepo: named,
  pickRepos: (v, p) => (v === undefined ? [] : obj({ 'forSetup?': T.bool() })(v, p)),
  pickWorkspace: none,
  addDetected: obj({ repos: T.arr(addedRepo) }),
  runGates: obj({ name: id, 'force?': T.bool() }),
  addContext: none,
  removeContext: obj({ file: T.str(1) }),
  createWorkspaceMap: none,
  settings: none,
  updateSetting: obj({ key: id, 'value?': anything }),
  pickClaude: none,
  saveAtlassian: obj({ 'site?': T.str(), 'email?': T.str(), 'token?': T.str() }),
  testAtlassian: none,
  mcp: obj({ 'refresh?': T.bool() }),
  mcpLogin: named,
  mcpShowLogin: named,
  mcpCancelLogin: named,
  mcpDetails: named,
  task,
  editPipeline: obj({ taskId: id, names: T.arr(T.str(1)) }),
  transcript: obj({ taskId: id, key: id }),
  run: task,
  stop: task,
  answer: obj({ taskId: id, checkpointId: id, option: id, 'feedback?': T.str(), 'at?': T.str(1) }),
  postReport: task,
  retryComment: obj({ taskId: id, seq: T.int(1) }),
  message: obj({ taskId: id, text: T.str(1) }),
  permission: obj({ requestId: id, allow: T.bool(), 'message?': T.str() }),
  openDiff: task,
  openRepo: obj({ taskId: id, repo: id }),
  revealTask: task,
  deleteTask: task,
  cleanup: task,
  resumeTerminal: obj({ taskId: id, key: id }),
  fixInChat: obj({ taskId: id, 'model?': T.re(MODEL_ID, 'a model alias or id, e.g. opus'), 'effort?': T.oneOf(EFFORTS) }),
  // Only web links leave the editor: never a command: or file: URI.
  openExternal: obj({ url: T.re(/^https?:\/\//i, 'only http(s) links open outside the editor') }),
  copy: obj({ text: T.str() }),
  preview: composer,
  start: composer,
  saveScenario: obj({ 'id?': T.str(), 'label?': T.str(), 'description?': T.str(), 'agents?': T.arr(obj({ name: T.str(1), 'model?': T.str(), 'effort?': T.oneOf(EFFORTS), 'instructions?': T.str(), 'instructionsFile?': T.str(1) })), 'intake?': obj({ 'model?': T.str(1), 'effort?': T.oneOf(EFFORTS) }) }),
  editStepInstructions: obj({ scenario: id, agent: T.str(1) }),
  previewScenario: obj({ agents: T.arr(obj({ name: T.str(1) })), 'auto?': T.bool() }),
  deleteScenario: byId,
  restoreScenario: byId,
  saveGroup: obj({ 'id?': T.str(), type: T.oneOf(GROUP_TYPES), label: T.str(), 'jira?': T.str(), 'instructions?': T.str(), 'defaultInstructions?': T.arr(T.str(1)), 'baseBranch?': T.str() }),
  deleteGroup: byId,
  saveInstruction: obj({ 'id?': T.str(), label: T.str(), text: T.str() }),
  deleteInstruction: byId,
  backupConfig: none,
  restoreConfigBackup: none,
  addLibrary: none,
  removeLibrary: obj({ file: T.str(1), scope: T.oneOf(['user', 'project']) }),
  moveToLibrary: obj({ library: T.str(1), 'agents?': T.arr(T.str(1)), 'scenarios?': T.arr(T.str(1)) }),
  setup: obj({ 'repos?': T.arr(addedRepo), 'language?': T.str(), 'gitMode?': T.oneOf(['branch', 'worktree']), 'map?': T.bool(), 'baseBranch?': T.str() }),
};

const isMethod = (m: string): m is keyof Rpc => Object.prototype.hasOwnProperty.call(PARAMS, m);

/** Narrows a message from the page to a request with valid parameters; anything else is rejected with the reason. */
function parsePageRequest(msg: unknown): Parsed | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'req' || typeof m.id !== 'number') return null;
  if (typeof m.method !== 'string' || !isMethod(m.method)) return { ok: false, id: m.id, error: `unknown request ${String(m.method)}` };
  const issues = PARAMS[m.method](m.params, '');
  if (issues.length) return { ok: false, id: m.id, error: `${m.method}: ${issues.join('; ')}` };
  return { ok: true, request: { id: m.id, method: m.method, params: m.params } as PageRequest };
}

/** A Claude Code session id as the CLI makes them; anything else never reaches a terminal's command line. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

/**
 * Whether the page may open a file the host did not name itself: one inside the workspace, a configured repo or the
 * config's own files. The page shows paths agents wrote (their tool calls), so a click must not open just anything.
 */
function openable(file: string, roots: string[]): boolean {
  const abs = path.resolve(file);
  return roots.some((root) => {
    const r = path.resolve(root);
    return abs === r || abs.startsWith(r + path.sep);
  });
}

export type { PageRequest };
export { parsePageRequest, openable, SESSION_ID };
