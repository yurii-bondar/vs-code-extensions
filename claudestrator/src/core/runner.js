// Runs one pipeline agent as a Claude Code CLI session (`claude -p` with stream-json in and out).
// The session stays open, so gate output or a report correction goes back into the same conversation.
const { spawn } = require('child_process');
const crypto = require('crypto');
const { getChildEnv } = require('./git');

/** Tools an agent never gets in an unattended run: nobody answers them. */
const ALWAYS_DISALLOWED = ['AskUserQuestion', 'ExitPlanMode'];
/** Context window per model, learned from `modelUsage`, so a new session can show ctx % before its first result. */
const contextWindows = new Map();

/** `rate_limit_event` → `{ fiveHour, sevenDay }` with `pct` (0–100) and `resetsAt` (unix seconds). */
function limitsOf(info) {
  if (!info) return null;
  const w = info.unifiedWindows || {};
  const one = (x) => (x && typeof x.utilization === 'number' ? { pct: Math.round(x.utilization * 100), resetsAt: x.resetsAt, status: x.status } : undefined);
  const out = { fiveHour: one(w.five_hour), sevenDay: one(w.seven_day) };
  if (!out.fiveHour && !out.sevenDay && typeof info.utilization === 'number') {
    const key = info.rateLimitType === 'seven_day' ? 'sevenDay' : 'fiveHour';
    out[key] = { pct: Math.round(info.utilization * 100), resetsAt: info.resetsAt, status: info.status };
  }
  return out.fiveHour || out.sevenDay ? out : null;
}
const STDERR_KEEP = 8000;

class ClaudeRunner {
  /**
   * opts: { command(): string, flags(): Set<string> (what this CLI version supports),
   *         settingSources(): string[] | null, hookSettings(): string (file path), env(): object }
   */
  constructor(opts) {
    this.opts = opts;
  }

  /** req: { agent, prompt, cwd, additionalDirectories, env, name, maxBudgetUsd, onOutput(item) } */
  start(req) {
    return new ClaudeSession(req, this.opts);
  }
}

function buildArgs(req, opts) {
  const a = req.agent;
  const has = (f) => opts.flags().has(f);
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  if (has('--include-partial-messages')) args.push('--include-partial-messages');
  if (a.instructions) args.push('--append-system-prompt', a.instructions);
  if (a.model && a.model !== 'inherit') args.push('--model', a.model);
  if (a.effort && has('--effort')) args.push('--effort', a.effort);
  if (a.tools && has('--tools')) args.push('--tools', a.tools.join(','));
  const disallowed = [...ALWAYS_DISALLOWED, ...(a.disallowedTools || [])];
  args.push('--disallowedTools', disallowed.join(','));
  const sources = opts.settingSources();
  if (sources && has('--setting-sources')) args.push('--setting-sources', sources.join(','));
  args.push('--settings', opts.hookSettings());
  // Without the user source, the account's own MCP servers come in explicitly.
  const mcpConfig = opts.mcpConfig && (!sources || !sources.includes('user')) ? opts.mcpConfig() : null;
  if (mcpConfig && has('--mcp-config')) args.push('--mcp-config', mcpConfig);
  for (const d of req.additionalDirectories || []) args.push('--add-dir', d);
  if (req.maxBudgetUsd !== undefined && has('--max-budget-usd')) args.push('--max-budget-usd', req.maxBudgetUsd.toFixed(2));
  if (req.name && has('--name')) args.push('--name', req.name);
  return args;
}

class ClaudeSession {
  constructor(req, opts) {
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
    this.proc = spawn(opts.command(), this.args, { cwd: req.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', (e) => this.end(e.code === 'ENOENT' ? `Claude Code CLI not found (${opts.command()}). Set "claudestrator.claudePath" or install Claude Code.` : e.message));
    this.proc.on('exit', (code, signal) => this.end(this.exitMessage(code, signal)));
    this.proc.stdin.on('error', () => {}); // EPIPE after the process died; reported through 'exit'
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-STDERR_KEEP);
    });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          this.handle(m);
        } catch {
          // a malformed message must not kill the session
        }
      }
    });
    // Ask the session what it really runs with (model and effort after settings, env and plan); costs no request.
    this.settingsRequest = `cs-settings-${crypto.randomBytes(4).toString('hex')}`;
    this.proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: this.settingsRequest, request: { subtype: 'get_settings' } })}\n`);
    this.send(req.prompt, { echo: false });
  }

  exitMessage(code, signal) {
    if (this.closing) return 'the agent session ended';
    const tail = this.stderr.trim().split('\n').slice(-6).join('\n');
    if (signal) return `the agent was stopped (${signal})`;
    return `Claude Code exited with code ${code}${tail ? `:\n${tail}` : ''}`;
  }

  /** `from`: 'you' (a message typed in the UI) or 'orchestrator' (gate output, report corrections). */
  send(text, { echo = true, from = 'you' } = {}) {
    if (this.ended || this.proc.stdin.destroyed) throw new Error('the agent session has ended');
    const uuid = crypto.randomUUID();
    this.pending.add(uuid);
    if (echo) this.req.onOutput({ type: 'user', text, from });
    this.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.sessionId || '', uuid })}\n`);
  }

  /** Resolves when the agent has answered every message sent so far. */
  turn() {
    if (this.results.length) return Promise.resolve(this.results.shift());
    if (this.ended) return Promise.resolve({ ok: false, report: '', error: this.endReason || 'the agent session ended' });
    return new Promise((resolve) => (this.waiter = resolve));
  }

  async interrupt() {
    this.closing = true;
    if (!this.ended) this.proc.kill('SIGTERM');
    setTimeout(() => !this.ended && this.proc.kill('SIGKILL'), 3000).unref();
  }

  close() {
    this.closing = true;
    if (this.ended) return;
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    setTimeout(() => !this.ended && this.proc.kill('SIGTERM'), 5000).unref();
  }

  deliver(r) {
    const w = this.waiter;
    this.waiter = null;
    if (w) w(r);
    else this.results.push(r);
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    if (this.waiter) this.deliver({ ok: false, report: '', error: reason, ...this.totals() });
  }

  totals() {
    return { ...(this.sessionId && { sessionId: this.sessionId }), costUsd: this.costUsd, turns: this.turns };
  }

  /** What a Claude Code status line shows for this session. */
  usage() {
    const ctxWindow = contextWindows.get(this.model);
    return {
      model: this.model,
      effort: this.effort !== undefined ? this.effort : this.req.agent.effort,
      ctxTokens: this.ctxTokens,
      ...(ctxWindow && { ctxWindow, ctxPct: Math.min(100, Math.round((this.ctxTokens / ctxWindow) * 100)) }),
      tokens: this.tokens,
      costUsd: this.costUsd,
    };
  }

  emitUsage() {
    this.req.onOutput({ type: 'usage', ...this.usage() });
  }

  handle(m) {
    const out = this.req.onOutput;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && m.session_id) {
          this.sessionId = m.session_id;
          if (m.model) this.model = m.model;
          if (this.req.onSession) this.req.onSession(m.session_id, m.model);
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
        const content = (m.message && m.message.content) || [];
        for (const block of content) {
          if (block.type === 'text' && block.text) out({ type: 'text', text: block.text });
          if (block.type === 'tool_use') out({ type: 'tool_use', id: block.id || '', name: block.name || '', input: block.input });
        }
        return;
      }
      case 'user': {
        const content = m.message && m.message.content;
        if (m.parent_tool_use_id || typeof content === 'string' || !Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('\n') : JSON.stringify(block.content ?? '');
          out({ type: 'tool_result', id: block.tool_use_id || '', isError: block.is_error === true, text: text.slice(0, 4000) });
        }
        return;
      }
      case 'result': {
        const answered = m.user_message_uuids || (m.user_message_uuid ? [m.user_message_uuid] : [...this.pending]);
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
        const r = {
          ok,
          report: m.subtype === 'success' ? m.result || '' : '',
          ...(!ok && { error: m.subtype === 'success' ? `the agent reported an error${m.result ? `: ${String(m.result).slice(0, 500)}` : ''}` : `${m.subtype}${errors ? `: ${errors}` : ''}` }),
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
function parseFlags(helpText) {
  return new Set((helpText.match(/--[a-z][a-z-]+/g) || []).map((f) => f));
}

module.exports = { ClaudeRunner, ClaudeSession, buildArgs, parseFlags, limitsOf };
