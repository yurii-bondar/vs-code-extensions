// Runs the Claudestrator engine for the JetBrains plugin. What extension.ts does in VS Code (tree, status bar,
// notifications, commands) is the plugin's job; this file only exposes the engine's state, events and operations.
import { exitCleanly, onBeforeExit, onMessage, send } from './transport';
import * as shim from './vscode-shim';
import type { Incoming } from './protocol';
import { Orchestrator } from '../../../../claudestrator/src/orchestrator';
import { DashboardPanel } from '../../../../claudestrator/src/panel';
import * as view from '../../../../claudestrator/src/core/view';
import { CHECKPOINT_TITLE } from '../../../../claudestrator/src/core/describe';
import type { Route } from '../../../../claudestrator/src/core/wire';

// Recursive file watching, which the engine relies on, works on Linux only from Node 20.
const MIN_NODE_MAJOR = 20;

let orch: Orchestrator | undefined;
let context: shim.ExtensionContext | undefined;

const toVscodeContext = (c: shim.ExtensionContext): ConstructorParameters<typeof Orchestrator>[0] => c as unknown as ConstructorParameters<typeof Orchestrator>[0];

function pushState(): void {
  if (!orch) return;
  const engine = orch.engine;
  const o = orch;
  send({
    type: 'state',
    root: o.root,
    cards: engine ? o.list().map((entry) => view.summary(engine, entry)) : [],
    limits: o.limits(),
    health: o.health,
  });
}

/** The panel, created on first use as `extension.ts` does: `show` reveals it, or opens it on the given route. */
function showDashboard(route?: Route): DashboardPanel {
  if (!orch || !context) throw new Error('Claudestrator is not started');
  return DashboardPanel.show(toVscodeContext(context), orch, route);
}

/** What the plugin shows for an engine event; a checkpoint gets its title from the engine's table (describe.ts). */
function forEvent(name: string, data: unknown): unknown {
  if (name !== 'checkpoint' || typeof data !== 'object' || data === null) return data;
  const checkpoint = (data as { checkpoint?: { id?: unknown } }).checkpoint;
  const id = checkpoint && typeof checkpoint.id === 'string' ? checkpoint.id : undefined;
  const title = id ? (CHECKPOINT_TITLE as Readonly<Record<string, string | undefined>>)[id] : undefined;
  return title ? { ...data, checkpointTitle: title } : data;
}

/** Agents are children of this process; stopped cleanly, their tasks resume from the same step. */
async function stopAgents(): Promise<void> {
  await orch?.engine?.stopAll();
}

type CallParams = Record<string, unknown>;

const taskId = (params: CallParams): string => {
  if (typeof params.taskId !== 'string' || !params.taskId) throw new Error('taskId is missing');
  return params.taskId;
};

const calls: Record<string, (params: CallParams) => Promise<unknown>> = {
  async runTask(params) {
    const o = orch!;
    await o.ensureReady();
    o.engine!.resume(taskId(params));
  },
  async stopTask(params) {
    await orch!.engine!.stop(taskId(params));
  },
  async deleteTask(params) {
    await showDashboard().$deleteTask({ taskId: taskId(params) });
  },
  async openConfig() {
    await showDashboard().$openConfig({ which: 'project' });
  },
  async checkHealth() {
    return orch!.refreshHealth();
  },
  async refresh() {
    const o = orch!;
    o.rebuild();
    await o.refreshHealth();
    pushState();
  },
  async permissionReply(params) {
    if (typeof params.requestId !== 'string') throw new Error('requestId is missing');
    orch!.engine?.permissionReply(params.requestId, params.allow === true);
  },
  async taskFolderFile(params) {
    return `${orch!.engine!.svc.dir(taskId(params))}/events.ndjson`;
  },
};

async function start(msg: Extract<Incoming, { type: 'init' }>): Promise<void> {
  shim.setSettings(msg.settings, []);
  shim.setWorkspaceFolders(msg.workspaceFolders);
  context = shim.createContext({ storageDir: msg.storageDir, extensionDir: msg.extensionDir, version: msg.version });
  orch = new Orchestrator(toVscodeContext(context));
  orch.onDidChange(pushState);
  orch.onEngine(({ name, data }) => {
    if (['checkpoint', 'finished', 'log', 'permission', 'permissionDone'].includes(name)) send({ type: 'engine', name, data: forEvent(name, data) });
  });
  await orch.init();
  // The ages in the task list ("5m ago") drift; refresh them now and then.
  setInterval(pushState, 60_000).unref();
  pushState();
  send({ type: 'ready' });
}

async function handle(msg: Incoming): Promise<void> {
  switch (msg.type) {
    case 'init':
      return start(msg);
    case 'settings':
      return shim.setSettings(msg.settings, msg.changed);
    case 'page':
      return shim.deliverPageMessage(msg.msg);
    case 'dashboard':
      // A dashboard already open in the IDE is re-attached to a restarted engine without being brought forward.
      if (msg.reveal === false) shim.quietly(() => showDashboard(msg.route as Route | undefined));
      else showDashboard(msg.route as Route | undefined);
      return;
    case 'dashboardClosed':
      return shim.closeDashboard();
    case 'terminalClosed':
      return shim.terminalClosed(msg.id, msg.code);
    case 'call': {
      const fn = calls[msg.method];
      try {
        if (!fn) throw new Error(`unknown call ${msg.method}`);
        send({ type: 'res', id: msg.id, ok: true, data: await fn(msg.params || {}) });
      } catch (e) {
        send({ type: 'res', id: msg.id, ok: false, error: (e as Error).message });
      }
      return;
    }
    case 'shutdown':
      return exitCleanly();
    case 'res':
      return; // answered in transport.ts
    default: {
      const unhandled: never = msg;
      console.error('[sidecar] unknown message', unhandled);
    }
  }
}

const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE_MAJOR) {
  send({ type: 'fatal', message: `Node.js ${MIN_NODE_MAJOR} or newer is required; found ${process.versions.node}.` });
  process.exit(1);
}

onBeforeExit(stopAgents);

onMessage((msg) => {
  handle(msg).catch((e: Error) => {
    console.error('[sidecar]', msg.type, e.stack || e.message);
    if (msg.type === 'init') {
      send({ type: 'fatal', message: e.message });
      process.exit(1);
    }
  });
});
process.on('unhandledRejection', (e) => console.error('[sidecar] unhandled rejection', e));
