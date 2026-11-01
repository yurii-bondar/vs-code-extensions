// Runs one pipeline agent as a Claude Code CLI session (`claude -p` with stream-json in and out).
// The session stays open, so gate output or a report correction goes back into the same conversation.
// The `get_settings` and `initialize` control requests are not documented: what they answer only fills in the status
// line and the model list, and a CLI that does not answer them still runs. Everything a run depends on (hook
// `onFailure`, `user_message_uuids`, headless denials) is documented and needs MIN_CLAUDE_VERSION.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { getChildEnv, launch } from './git';
import { GITHUB_TOKENS } from './settings';
import type { TranscriptItem } from './store';
import type { Agent } from './types';

/**
 * The oldest Claude Code the engine runs: 2.1.302 denies in -p a call nobody approved, 2.1.295 honours a hook's
 * `onFailure: "block"` (a guard that cannot answer blocks the call), 2.1.259 names the messages a result answers.
 */
const MIN_CLAUDE_VERSION = '2.1.302';

/** Why a Claude Code version cannot run agents (`2.1.290 (Claude Code)`), or null when it can or is not a release number. */
function versionProblem(version: string | undefined): string | null {
  const m = (version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const need = MIN_CLAUDE_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i]! > need[i]!) return null;
    if (have[i]! < need[i]!) return `Claude Code ${m[0]} is older than ${MIN_CLAUDE_VERSION}, which Claudestrator needs to guard the agents; update it (claude update)`;
  }
  return null;
}

/** Tools an agent never gets in an unattended run: nobody answers them. */
const ALWAYS_DISALLOWED = ['AskUserQuestion', 'ExitPlanMode'];
/** Context window per model, learned from `modelUsage`, so a new session can show ctx % before its first result. */
const contextWindows = new Map<string, number>();

/** A rate-limit window as the CLI reports it. */
interface RawWindow {
  utilization?: number;
  resetsAt?: number;
  status?: string;
}
interface RateLimitInfo {
  unifiedWindows?: Record<string, RawWindow | undefined>;
  utilization?: number;
  rateLimitType?: string;
  resetsAt?: number;
  status?: string;
}
interface Limit {
  pct: number;
  resetsAt: number | undefined;
  status: string | undefined;
}
interface Limits {
  fiveHour: Limit | undefined;
  sevenDay: Limit | undefined;
}

/** `rate_limit_event` → `{ fiveHour, sevenDay }` with `pct` (0–100) and `resetsAt` (unix seconds). */
function limitsOf(info: RateLimitInfo | null | undefined): Limits | null {
  if (!info) return null;
  const w = info.unifiedWindows || {};
  const one = (x: RawWindow | undefined): Limit | undefined => (x && typeof x.utilization === 'number' ? { pct: Math.round(x.utilization * 100), resetsAt: x.resetsAt, status: x.status } : undefined);
  const out: Limits = { fiveHour: one(w.five_hour), sevenDay: one(w.seven_day) };
  if (!out.fiveHour && !out.sevenDay && typeof info.utilization === 'number') {
    const key = info.rateLimitType === 'seven_day' ? 'sevenDay' : 'fiveHour';
    out[key] = { pct: Math.round(info.utilization * 100), resetsAt: info.resetsAt, status: info.status };
  }
  return out.fiveHour || out.sevenDay ? out : null;
}
/** Whether two reports of an account's limits say the same of both windows: each agent session reports them again. */
interface Windows {
  fiveHour?: Window | undefined;
  sevenDay?: Window | undefined;
}
interface Window {
  pct: number;
  resetsAt?: number | undefined;
  status?: string | undefined;
}
function sameWindows(a: Windows | null | undefined, b: Windows | null | undefined): boolean {
  const key = (w?: Window): string => (w ? `${w.pct}:${w.resetsAt ?? ''}:${w.status ?? ''}` : '');
  return Boolean(a && b) && key(a!.fiveHour) === key(b!.fiveHour) && key(a!.sevenDay) === key(b!.sevenDay);
}

const STDERR_KEEP = 8000;
/** After an interrupt, how long the CLI gets to end the turn before SIGTERM, and SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 5000;

/** What a result's error subtype means, for the step's failure message. */
const RESULT_ERRORS: Record<string, string> = {
  error_max_structured_output_retries: 'the agent could not hand over a report that matches its schema',
  error_max_turns: 'the agent used up its turns (maxTurns)',
  error_max_budget_usd: "the task's budget ran out (limits.budgetUsd)",
};

/** What the runner asks of its host: the CLI to run, what it supports, and where its settings come from. */
interface RunnerOptions {
  command(): string;
  /** The CLI's `--version`, when known: an older CLI than MIN_CLAUDE_VERSION does not start. */
  version?(): string | undefined;
  /** What this CLI version supports. */
  flags(): Set<string>;
  settingSources(): string[] | null;
  env(): NodeJS.ProcessEnv;
  /** The account's MCP servers as an `--mcp-config` file, for agents run without the `user` setting source. */
  mcpConfig?(): Promise<string | null>;
}

/** The part of an agent definition a session needs. */
type SessionAgent = Pick<Agent, 'instructions' | 'model'> & Partial<Pick<Agent, 'effort' | 'tools' | 'disallowedTools' | 'mcp' | 'maxTurns'>>;

interface SessionRequest {
  agent: SessionAgent;
  prompt: string;
  cwd: string;
  /** The session's own settings (`--settings`): the guard hook and what Claude Code itself enforces. */
  settings: Record<string, unknown>;
  additionalDirectories?: string[] | undefined;
  env?: Record<string, string> | undefined;
  name?: string | undefined;
  maxBudgetUsd?: number | undefined;
  /** Filled in by the runner: the `--mcp-config` file, if the session gets one. */
  mcpConfig?: string | null | undefined;
  /** The JSON Schema of the data a turn hands over (`--json-schema`); it comes back as `TurnResult.structured`. */
  jsonSchema?: Record<string, unknown> | undefined;
  onOutput(item: TranscriptItem): void;
  /** The session started: its id, model, and the account (CLAUDE_CONFIG_DIR) it runs under. */
  onSession?: ((sessionId: string, model: string | undefined, configDir: string | undefined) => void) | undefined;
  onLimits?: ((limits: Limits & { at: number }) => void) | undefined;
  /** Any message of the CLI, also of a subagent working for the agent: a sign the session is alive. */
  onActivity?: (() => void) | undefined;
  /** A problem worth a line in the log (a message from the CLI this runner could not handle). */
  onWarn?: ((message: string) => void) | undefined;
}

/** What one turn of the agent came to. */
interface TurnResult {
  ok: boolean;
  /** What the agent wrote for a human in its last turn. */
  report: string;
  /** With a JSON Schema: the data of the turn, as Claude Code checked it against the schema. */
  structured?: unknown;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
}

/** A message of the CLI's stream-json output, as far as this runner reads it. */
interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}
interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  canonicalModel?: string;
}
interface CliMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  event?: { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string } };
  response?: { request_id?: string; subtype?: string; response?: { applied?: { model?: string; effort?: string | null } } };
  rate_limit_info?: RateLimitInfo;
  message?: {
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
    content?: ContentBlock[] | string;
  };
  user_message_uuids?: string[];
  user_message_uuid?: string;
  total_cost_usd?: number;
  num_turns?: number;
  modelUsage?: Record<string, ModelUsage>;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  errors?: unknown[];
}

/** How much of a tool call's input the UI and the transcript get: a Write of a big fixture is shown in part anyway. */
const INPUT_STRING_CHARS = 8000;
const INPUT_DEPTH = 6;

/** A tool call's input for the UI and the transcript: long strings cut, with how much was left out. The guard sees it whole. */
function capInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > INPUT_STRING_CHARS ? `${value.slice(0, INPUT_STRING_CHARS)}…(+${value.length - INPUT_STRING_CHARS} chars)` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= INPUT_DEPTH) return '…';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => capInput(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capInput(v, depth + 1)]));
}

/** The tool Claude Code adds for --json-schema: the way an agent hands its data over, not a step it chose. */
const STRUCTURED_OUTPUT = 'StructuredOutput';

/** A report without a json block at its end: with structured output the data is apart, and appended once. */
const withoutTrailingJson = (text: string): string => text.replace(/\n*```json[^\n]*\n(?:(?!```)[\s\S])*```\s*$/, '').trim();

class ClaudeRunner {
  opts: RunnerOptions;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  async start(req: SessionRequest): Promise<ClaudeSession> {
    const problem = versionProblem(this.opts.version && this.opts.version());
    if (problem) throw new Error(problem);
    // A folder that is not there fails the spawn with ENOENT, which reads like a missing CLI.
    const folder = await fs.promises.stat(req.cwd).catch(() => null);
    if (!folder || !folder.isDirectory()) throw new Error(`its working folder ${req.cwd} is not there`);
    const sources = this.opts.settingSources();
    // Without the user source, the account's own MCP servers come in explicitly.
    const wantsMcp = req.agent.mcp !== false && this.opts.mcpConfig && (!sources || !sources.includes('user'));
    return new ClaudeSession({ ...req, mcpConfig: wantsMcp ? await this.opts.mcpConfig!() : null }, this.opts);
  }
}

function buildArgs(req: Pick<SessionRequest, 'agent' | 'additionalDirectories' | 'maxBudgetUsd' | 'name' | 'mcpConfig' | 'settings' | 'jsonSchema'>, opts: RunnerOptions): string[] {
  const a = req.agent;
  const has = (f: string): boolean => opts.flags().has(f);
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  if (has('--include-partial-messages')) args.push('--include-partial-messages');
  if (a.instructions) args.push('--append-system-prompt', a.instructions);
  if (a.model && a.model !== 'inherit') args.push('--model', a.model);
  if (a.effort && has('--effort')) args.push('--effort', a.effort);
  if (a.maxTurns && has('--max-turns')) args.push('--max-turns', String(a.maxTurns));
  // --tools picks from the built-in set; an MCP tool an agent lists is for the guard, which allows it.
  if (a.tools && has('--tools')) args.push('--tools', a.tools.filter((t) => !t.startsWith('mcp__')).join(','));
  const disallowed = [...ALWAYS_DISALLOWED, ...(a.disallowedTools || [])];
  args.push('--disallowedTools', disallowed.join(','));
  const sources = opts.settingSources();
  if (sources && has('--setting-sources')) args.push('--setting-sources', sources.join(','));
  args.push('--settings', JSON.stringify(req.settings));
  if (a.mcp === false && has('--strict-mcp-config')) {
    // Strict: only servers named in --mcp-config count, and none is given. Each server's tool list would otherwise ride along in every turn.
    args.push('--strict-mcp-config');
  } else {
    // Without the user source, the account's own MCP servers come in explicitly.
    const mcpConfig = req.mcpConfig && (!sources || !sources.includes('user')) ? req.mcpConfig : null;
    if (mcpConfig && has('--mcp-config')) args.push('--mcp-config', mcpConfig);
  }
  for (const d of req.additionalDirectories || []) args.push('--add-dir', d);
  if (req.maxBudgetUsd !== undefined && has('--max-budget-usd')) args.push('--max-budget-usd', req.maxBudgetUsd.toFixed(2));
  if (req.name && has('--name')) args.push('--name', req.name);
  if (req.jsonSchema && has('--json-schema')) args.push('--json-schema', JSON.stringify(req.jsonSchema));
  return args;
}

class ClaudeSession {
  req: SessionRequest;
  pending: Set<string>;
  results: TurnResult[];
  waiter: ((r: TurnResult) => void) | null;
  ended: boolean;
  stderr: string;
  sessionId: string | undefined;
  turns: number;
  costUsd: number;
  model: string | undefined;
  effort: string | null | undefined;
  ctxTokens: number;
  tokens: number;
  args: string[];
  proc: ChildProcessWithoutNullStreams;
  settingsRequest: string;
  /** Whether a message this session could not handle was already logged (once is enough to find the bug). */
  reportedBadMessage = false;
  /**
   * What the agent has written since its last tool call: its final words, the report, when the data comes structured.
   * Text before a tool call is it thinking aloud ("I'll read that file"), as Claude Code's own `result` leaves it out.
   */
  turnText: string[] = [];
  /** StructuredOutput calls, whose results are not shown either. */
  hiddenTools = new Set<string>();
  closing?: boolean;
  endReason?: string;
  /** The account (CLAUDE_CONFIG_DIR) it runs under; none: Claude Code's default. */
  configDir: string | undefined;

  constructor(req: SessionRequest, opts: RunnerOptions) {
    this.req = req;
    this.pending = new Set();
    this.results = [];
    this.waiter = null;
    this.ended = false;
    this.stderr = '';
    this.sessionId = undefined;
    this.turns = 0;
    this.costUsd = 0;
    this.model = req.agent.model && req.agent.model !== 'inherit' ? req.agent.model : undefined;
    this.ctxTokens = 0;
    this.tokens = 0;
    this.args = buildArgs(req, opts);

    const env = { ...getChildEnv(), ...opts.env(), ...req.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLAUDECODE;
    for (const name of GITHUB_TOKENS) delete env[name];
    this.configDir = env.CLAUDE_CONFIG_DIR || undefined;
    const [file, argv] = launch(opts.command(), this.args);
    // A process group of its own: stopping the agent stops what it started too (a dev server, a watcher, MCP servers).
    this.proc = spawn(file, argv, { cwd: req.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.proc.on('error', (e: NodeJS.ErrnoException) => this.end(e.code === 'ENOENT' ? `Claude Code CLI not found (${opts.command()}). Set "claudestrator.claudePath" or install Claude Code.` : e.message));
    this.proc.on('exit', (code, signal) => {
      // What the agent left running in the background goes with the session.
      this.signal('SIGTERM');
      this.end(this.exitMessage(code, signal));
    });
    this.proc.stdin.on('error', () => {}); // EPIPE after the process died; reported through 'exit'
    // Decoded as a stream: a pipe may cut a line inside a multi-byte character (Cyrillic, emoji), and decoding each
    // chunk on its own would turn both halves into U+FFFD in plans, reports and Jira comments.
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-STDERR_KEEP);
    });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let m: unknown;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        // Every field of a CLI message is optional and read with care; it only has to be an object.
        if (typeof m !== 'object' || m === null || Array.isArray(m)) continue;
        try {
          this.handle(m as CliMessage);
        } catch (e) {
          // A message we cannot handle must not kill the session, but a bug in handling it should be findable.
          if (!this.reportedBadMessage) {
            this.reportedBadMessage = true;
            const message = `could not handle a message from Claude Code: ${(e as Error).message}`;
            if (this.req.onWarn) this.req.onWarn(message);
            else console.warn(`[claudestrator] ${message}`);
          }
        }
      }
    });
    // Ask the session what it really runs with (model and effort after settings, env and plan); costs no request.
    this.settingsRequest = `cs-settings-${crypto.randomBytes(4).toString('hex')}`;
    this.proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: this.settingsRequest, request: { subtype: 'get_settings' } })}\n`);
    this.send(req.prompt, { echo: false });
  }

  exitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    if (this.closing) return 'the agent session ended';
    const tail = this.stderr.trim().split('\n').slice(-6).join('\n');
    if (signal) return `the agent was stopped (${signal})`;
    return `Claude Code exited with code ${code}${tail ? `:\n${tail}` : ''}`;
  }

  /** `from`: 'you' (a message typed in the UI) or 'orchestrator' (gate output, report corrections). */
  send(text: string, { echo = true, from = 'you' }: { echo?: boolean; from?: string } = {}): void {
    if (this.ended || this.proc.stdin.destroyed) throw new Error('the agent session has ended');
    // A result nobody waited for answers an earlier message (one you typed while the gates ran): the next turn is
    // the answer to this one, never that.
    this.results = [];
    const uuid = crypto.randomUUID();
    this.pending.add(uuid);
    if (echo) this.req.onOutput({ type: 'user', text, from });
    this.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.sessionId || '', uuid })}\n`);
  }

  /** Resolves when the agent has answered every message sent so far. */
  turn(): Promise<TurnResult> {
    if (this.results.length) return Promise.resolve(this.results.shift()!);
    if (this.ended) return Promise.resolve({ ok: false, report: '', error: this.endReason || 'the agent session ended' });
    return new Promise((resolve) => (this.waiter = resolve));
  }

  /**
   * Stops the agent: an `interrupt` control request ends the turn cleanly (it comes back as a failed result and the
   * session is saved for a resume); SIGTERM if the CLI does not, and SIGKILL as the last resort.
   */
  async interrupt(): Promise<void> {
    this.closing = true;
    if (this.ended) return;
    try {
      this.proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `cs-interrupt-${crypto.randomBytes(4).toString('hex')}`, request: { subtype: 'interrupt' } })}\n`);
    } catch {
      // stdin is gone; the signals below still stop it
    }
    this.escalate(STOP_GRACE_MS);
  }

  /**
   * Stops the agent and waits for it, up to `graceMs`, then kills its process group at once. For a host that is about
   * to exit (VS Code closing the window), where the timers of `interrupt` would never fire and a CLI stuck on a hung
   * tool would be left running with everything it started.
   */
  async terminate(graceMs: number): Promise<void> {
    await this.interrupt();
    if (this.ended) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!this.ended) this.signal('SIGKILL');
  }

  /** SIGTERM after `afterMs` if the CLI has not ended, SIGKILL STOP_GRACE_MS later: to its whole process group. */
  escalate(afterMs: number): void {
    setTimeout(() => {
      if (this.ended) return;
      this.signal('SIGTERM');
      setTimeout(() => !this.ended && this.signal('SIGKILL'), STOP_GRACE_MS).unref();
    }, afterMs).unref();
  }

  /** Signals the CLI and everything in its process group; on Windows, its process tree (taskkill /t) for a kill. */
  signal(sig: NodeJS.Signals): void {
    const pid = this.proc.pid;
    if (pid === undefined) return;
    try {
      if (process.platform !== 'win32') process.kill(-pid, sig);
      else if (sig === 'SIGKILL') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      else this.proc.kill(sig);
    } catch {
      // already gone
    }
  }

  close(): void {
    this.closing = true;
    if (this.ended) return;
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    this.escalate(STOP_GRACE_MS);
  }

  deliver(r: TurnResult): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w(r);
    else this.results.push(r);
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    if (this.waiter) this.deliver({ ok: false, report: '', error: reason, ...this.totals() });
  }

  totals(): { sessionId?: string; costUsd: number; turns: number } {
    return { ...(this.sessionId && { sessionId: this.sessionId }), costUsd: this.costUsd, turns: this.turns };
  }

  /** What a Claude Code status line shows for this session. */
  usage() {
    const ctxWindow = contextWindows.get(this.model as string);
    return {
      model: this.model,
      effort: this.effort !== undefined ? this.effort : this.req.agent.effort,
      ctxTokens: this.ctxTokens,
      ...(ctxWindow && { ctxWindow, ctxPct: Math.min(100, Math.round((this.ctxTokens / ctxWindow) * 100)) }),
      tokens: this.tokens,
      costUsd: this.costUsd,
    };
  }

  emitUsage(): void {
    this.req.onOutput({ type: 'usage', ...this.usage() });
  }

  handle(m: CliMessage): void {
    const out = this.req.onOutput;
    if (this.req.onActivity) this.req.onActivity();
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && m.session_id) {
          this.sessionId = m.session_id;
          if (m.model) this.model = m.model;
          if (this.req.onSession) this.req.onSession(m.session_id, m.model, this.configDir);
        }
        return;
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event || {};
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) out({ type: 'text_delta', text: ev.delta.text });
        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') out({ type: 'thinking' });
        return;
      }
      case 'control_response': {
        const r = m.response || {};
        if (r.request_id !== this.settingsRequest || r.subtype !== 'success') return;
        const applied = (r.response && r.response.applied) || {};
        if (applied.model) this.model = applied.model;
        if (applied.effort !== undefined) this.effort = applied.effort;
        this.emitUsage();
        return;
      }
      case 'rate_limit_event': {
        const limits = limitsOf(m.rate_limit_info);
        if (limits && this.req.onLimits) this.req.onLimits({ ...limits, at: Date.now() });
        return;
      }
      case 'assistant': {
        if (m.parent_tool_use_id) return;
        const u = m.message && m.message.usage;
        // The prompt of the latest request is what fills the context window.
        if (u && typeof u.input_tokens === 'number') {
          this.ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
          this.emitUsage();
        }
        const content = ((m.message && m.message.content) || []) as ContentBlock[];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            this.turnText.push(block.text);
            out({ type: 'text', text: block.text });
          }
          if (block.type === 'tool_use' && block.name === STRUCTURED_OUTPUT) this.hiddenTools.add(block.id || '');
          else if (block.type === 'tool_use') {
            this.turnText = [];
            out({ type: 'tool_use', id: block.id || '', name: block.name || '', input: capInput(block.input) });
          }
        }
        return;
      }
      case 'user': {
        const content = m.message && m.message.content;
        if (m.parent_tool_use_id || typeof content === 'string' || !Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== 'tool_result' || this.hiddenTools.has(block.tool_use_id || '')) continue;
          const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text || '').join('\n') : JSON.stringify(block.content ?? '');
          out({ type: 'tool_result', id: block.tool_use_id || '', isError: block.is_error === true, text: text.slice(0, 4000) });
        }
        return;
      }
      case 'result': {
        // Without the uuids a result answers at least the oldest message still open; taking it for all of them would
        // hand the answer to a message typed mid-turn to the next turn.
        const answered = m.user_message_uuids || (m.user_message_uuid ? [m.user_message_uuid] : [...this.pending].slice(0, 1));
        for (const u of answered) this.pending.delete(u);
        // total_cost_usd is cumulative for the session; num_turns counts this run only.
        if (typeof m.total_cost_usd === 'number') this.costUsd = m.total_cost_usd;
        this.turns += m.num_turns || 0;
        // modelUsage is cumulative for the session.
        if (m.modelUsage && typeof m.modelUsage === 'object') {
          let tokens = 0;
          for (const [id, mu] of Object.entries(m.modelUsage)) {
            tokens += (mu.inputTokens || 0) + (mu.outputTokens || 0) + (mu.cacheReadInputTokens || 0) + (mu.cacheCreationInputTokens || 0);
            if (mu.contextWindow) {
              contextWindows.set(id, mu.contextWindow);
              if (mu.canonicalModel) contextWindows.set(mu.canonicalModel, mu.contextWindow);
            }
          }
          this.tokens = tokens;
          if (!this.model || !contextWindows.has(this.model)) this.model = Object.keys(m.modelUsage)[0] || this.model;
        }
        this.emitUsage();
        const ok = m.subtype === 'success' && !m.is_error;
        const errors = Array.isArray(m.errors) ? m.errors.join('; ') : '';
        // With structured output, `result` is the data as JSON text; the report is what the agent wrote this turn.
        const structured = m.structured_output !== undefined && m.structured_output !== null;
        const written = withoutTrailingJson(this.turnText.join('\n\n'));
        this.turnText = [];
        const r: TurnResult = {
          ok,
          report: m.subtype !== 'success' ? '' : structured ? written : m.result || '',
          ...(structured && { structured: m.structured_output }),
          ...(!ok && { error: m.subtype === 'success' ? `the agent reported an error${m.result ? `: ${String(m.result).slice(0, 500)}` : ''}` : `${RESULT_ERRORS[m.subtype ?? ''] ?? m.subtype}${errors ? `: ${errors}` : ''}` }),
          ...this.totals(),
        };
        out({ type: 'turn_end', ok, costUsd: this.costUsd, turns: this.turns });
        // A message sent mid-turn that the CLI did not fold in gets its own turn; wait for it.
        if (this.pending.size === 0 || !ok) this.deliver(r);
        return;
      }
    }
  }
}

/** Parses `claude --help` into the set of long flags this CLI version accepts. */
function parseFlags(helpText: string): Set<string> {
  return new Set((helpText.match(/--[a-z][a-z-]+/g) || []).map((f) => f));
}

export type { CliMessage, Limit, Limits, RunnerOptions, SessionRequest, TurnResult };
export { ClaudeRunner, ClaudeSession, buildArgs, capInput, parseFlags, limitsOf, sameWindows, versionProblem, withoutTrailingJson, MIN_CLAUDE_VERSION };
