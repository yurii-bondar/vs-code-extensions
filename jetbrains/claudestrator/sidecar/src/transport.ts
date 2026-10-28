import * as readline from 'node:readline';
import type { Incoming, Outgoing } from './protocol';

// stdout is the protocol; the engine and its libraries log with console.*, so those go to stderr.
const writeOut = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
for (const level of ['log', 'info', 'debug'] as const) console[level] = console.error;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const pending = new Map<number, Pending>();
let nextId = 1;
const handlers = new Set<(msg: Incoming) => void>();

function send(msg: Outgoing): void {
  try {
    writeOut(`${JSON.stringify(msg)}\n`);
  } catch (e) {
    console.error('[sidecar] could not send', msg.type, (e as Error).message);
  }
}

/** Asks the IDE to do something an editor does (a dialog, opening a file, a terminal) and waits for the answer. */
function request<T = unknown>(method: string, params: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send({ type: 'req', id, method, params });
  });
}

function onMessage(fn: (msg: Incoming) => void): void {
  handlers.add(fn);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg: Incoming;
  try {
    msg = JSON.parse(line) as Incoming;
  } catch {
    console.error('[sidecar] not JSON:', line.slice(0, 200));
    return;
  }
  if (msg.type === 'res') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error || 'request failed'));
    return;
  }
  handlers.forEach((fn) => fn(msg));
});

/** What runs before the process exits; main.ts sets it to stop the engine's agents. */
let beforeExit: () => Promise<void> = async () => undefined;
/** Long enough for agents to stop cleanly, short enough not to hold up an IDE that is quitting. */
const EXIT_GRACE_MS = 5000;

/** Runs `beforeExit`, for at most EXIT_GRACE_MS, then exits. */
function exitCleanly(): void {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, EXIT_GRACE_MS).unref());
  void Promise.race([beforeExit().catch((e: Error) => console.error('[sidecar] stopping failed', e.message)), timeout]).finally(() => process.exit(0));
}

function onBeforeExit(fn: () => Promise<void>): void {
  beforeExit = fn;
}

// The plugin closed its end (the IDE quit, or killed us): the engine's children must not outlive it.
process.stdin.on('end', exitCleanly);

export { send, request, onMessage, onBeforeExit, exitCleanly };
