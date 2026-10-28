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

// The plugin closed its end: nothing left to serve, and the engine's children must not outlive it.
process.stdin.on('end', () => process.exit(0));

export { send, request, onMessage };
