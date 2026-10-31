// The extension's side of the guard: Claude Code POSTs every tool call of an agent to a local HTTP endpoint (a
// PreToolUse `http` hook), with the session's token in a header, and the session's permission policy answers. No
// process starts per tool call, and nothing but Claude Code itself has to run for the guard to work.
import * as http from 'http';
import * as crypto from 'crypto';

/** What an agent asked to do, and the policy's answer. */
interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
}
type Decision = { allow: boolean; reason?: string };
type Decide = (call: ToolCall) => Promise<Decision> | Decision;

/** The variable the session's token travels in; Claude Code puts it into the hook's Authorization header. */
const TOKEN_ENV = 'CLAUDESTRATOR_HOOK_TOKEN';
const HOOK_PATH = '/pretooluse';
/** A Write carries the whole file; anything larger is refused rather than read into memory. */
const MAX_BODY = 32 * 1024 * 1024;
/** How long Claude Code waits for an answer, in seconds: an "Ask me" question waits for you. */
const HOOK_TIMEOUT_S = 900;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The hook's input as Claude Code sends it: `{ tool_name, tool_input, cwd, … }`. Null when it is not that shape: the
 * server then denies, so a malformed call never passes as an unknown tool would.
 */
function parseHookRequest(body: string): ToolCall | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const { tool_name: tool, tool_input: input, cwd } = data;
  if (typeof tool !== 'string' || !tool) return null;
  if (input !== undefined && !isRecord(input)) return null;
  return { tool, input: input ?? {}, cwd: typeof cwd === 'string' ? cwd : '' };
}

/** What a PreToolUse hook answers. */
const answer = (d: Decision): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.allow ? 'allow' : 'deny', permissionDecisionReason: d.reason || (d.allow ? 'allowed by Claudestrator' : 'denied by Claudestrator') } });

class HookServer {
  sessions = new Map<string, Decide>();
  server: http.Server | null = null;
  /** Where Claude Code posts tool calls, once listening. */
  url: string | null = null;

  listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.on('error', reject);
      // Loopback only, on a port the system picks: nothing outside this machine can reach it.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') return reject(new Error('the guard server has no port'));
        this.server = server;
        this.url = `http://127.0.0.1:${addr.port}${HOOK_PATH}`;
        resolve();
      });
    });
  }

  /** `127.0.0.1:<port>`: what the sandbox's network proxy must let through for the hook to arrive. */
  host(): string {
    if (!this.url) throw new Error('the guard server is not listening');
    return new URL(this.url).host;
  }

  /** Registers a session's policy. Returns the env for the agent: its token, which only that session holds. */
  register(decide: Decide): { token: string; env: Record<string, string> } {
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, decide);
    return { token, env: { [TOKEN_ENV]: token } };
  }

  unregister(token: string): void {
    this.sessions.delete(token);
  }

  /**
   * The `hooks` part of an agent's settings: every tool call goes to this server first. A guard that cannot answer
   * (VS Code gone, a timeout, an error) blocks the call: by default Claude Code would go on without it, and an allow
   * rule in the repo's own settings could then let a push or an edit through.
   */
  settings(): { PreToolUse: { matcher: string; hooks: Record<string, unknown>[] }[] } {
    if (!this.url) throw new Error('the guard server is not listening');
    return {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'http', url: this.url, headers: { Authorization: `Bearer $${TOKEN_ENV}` }, allowedEnvVars: [TOKEN_ENV], timeout: HOOK_TIMEOUT_S, onFailure: 'block' }] }],
    };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (d: Decision): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(answer(d));
    };
    if (req.method !== 'POST' || req.url !== HOOK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const token = (String(req.headers.authorization || '').match(/^Bearer (\S+)$/) || [])[1];
    const decide = token ? this.sessions.get(token) : undefined;
    // Answered before its body is read, which is dropped unread: any local process (or a page in a browser that found
    // the port) could otherwise have the extension host hold many large bodies at once.
    if (!decide) {
      res.setHeader('Connection', 'close');
      reply({ allow: false, reason: 'this agent session is no longer active in Claudestrator' });
      req.resume();
      return;
    }
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    try {
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk as string);
        if (size > MAX_BODY) return reply({ allow: false, reason: 'Claudestrator: the tool call is too large to check' });
        body += chunk;
      }
      const call = parseHookRequest(body);
      if (!call) return reply({ allow: false, reason: 'Claudestrator could not read the tool call' });
      reply(await decide(call));
    } catch (e) {
      if (!res.headersSent) reply({ allow: false, reason: `Claudestrator error: ${(e as Error).message}` });
    }
  }

  dispose(): void {
    if (this.server) this.server.close();
    this.server = null;
    this.url = null;
  }
}

export type { Decide, Decision, ToolCall };
export { HookServer, parseHookRequest, HOOK_TIMEOUT_S, TOKEN_ENV };
