// The extension's side of the PreToolUse hook: a local socket (Unix socket or Windows named pipe)
// where each running agent session has a token mapped to its permission policy.
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import * as crypto from 'crypto';

/** What an agent asked to do, and the policy's answer. */
interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
}
type Decision = { allow: boolean; reason?: string };
type Decide = (call: ToolCall) => Promise<Decision> | Decision;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A line the hook sends: `{ token, payload: { tool_name, tool_input, cwd } }`, as Claude Code hands it to the hook.
 * Null when it is not that shape: the server then denies, so a malformed call never passes as an unknown tool would.
 */
function parseHookRequest(line: string): { token: string; call: ToolCall } | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.token !== 'string' || !isRecord(data.payload)) return null;
  const { tool_name: tool, tool_input: input, cwd } = data.payload;
  if (typeof tool !== 'string' || !tool) return null;
  if (input !== undefined && !isRecord(input)) return null;
  return { token: data.token, call: { tool, input: input ?? {}, cwd: typeof cwd === 'string' ? cwd : '' } };
}

class HookServer {
  sessions: Map<string, Decide>;
  address: string;
  server: net.Server | null;

  constructor() {
    this.sessions = new Map();
    const id = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const name = `claudestrator-${id}.sock`;
    // Unix socket paths are limited to ~104 bytes; a long TMPDIR falls back to /tmp.
    const tmp = path.join(os.tmpdir(), name).length < 100 ? os.tmpdir() : '/tmp';
    this.address = process.platform === 'win32' ? `\\\\.\\pipe\\claudestrator-${id}` : path.join(tmp, name);
    this.server = null;
  }

  listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server = net.createServer((conn) => this.onConnection(conn));
      this.server.on('error', reject);
      this.server.listen(this.address, () => {
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.address, 0o600);
          } catch {
            // best effort: the token is the real check
          }
        }
        resolve();
      });
    });
  }

  /** Registers a policy: `decide({ tool, input, cwd }) → Promise<{ allow, reason }>`. Returns the env for the agent. */
  register(decide: Decide): { token: string; env: Record<string, string> } {
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, decide);
    return { token, env: { CLAUDESTRATOR_HOOK_SOCKET: this.address, CLAUDESTRATOR_HOOK_TOKEN: token } };
  }

  unregister(token: string): void {
    this.sessions.delete(token);
  }

  onConnection(conn: net.Socket): void {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', async (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = '';
      let reply: Decision;
      try {
        const request = parseHookRequest(line);
        const decide = request && this.sessions.get(request.token);
        if (!request) reply = { allow: false, reason: 'Claudestrator could not read the tool call' };
        else if (!decide) reply = { allow: false, reason: 'this agent session is no longer active in Claudestrator' };
        else reply = await decide(request.call);
      } catch (e) {
        reply = { allow: false, reason: `Claudestrator error: ${(e as Error).message}` };
      }
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  }

  dispose(): void {
    if (this.server) this.server.close();
    this.server = null;
    if (process.platform !== 'win32') fs.rmSync(this.address, { force: true });
  }
}

const quote = (s: string): string => (process.platform === 'win32' ? `"${s}"` : `'${String(s).replace(/'/g, `'\\''`)}'`);

/**
 * Writes the `--settings` file every agent gets: one PreToolUse hook for all tools. `node` is a Node.js binary;
 * without one, VS Code's own runtime runs the script in Node mode.
 */
function writeHookSettings(file: string, { node, script }: { node?: string | null | undefined; script: string }): string {
  const runtime = node ? quote(node) : `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)}`;
  const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${runtime} ${quote(script)}`, timeout: 900 }] }] } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

export type { Decide, Decision, ToolCall };
export { HookServer, writeHookSettings, parseHookRequest };
