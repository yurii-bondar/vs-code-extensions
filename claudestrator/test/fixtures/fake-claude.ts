#!/usr/bin/env node
// A stand-in for the Claude Code CLI in print mode with stream-json in and out. It plays each pipeline
// role from the prompt, and before every tool call it posts the call to the PreToolUse http hook from --settings,
// as Claude Code does, so tests cover the guard end to end.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/** The PreToolUse hook of `--settings`, as far as the fake reads it. */
interface HttpHook {
  type: string;
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
  onFailure?: string;
}
interface Settings {
  hooks?: { PreToolUse?: { matcher?: string; hooks: HttpHook[] }[] };
  sandbox?: { enabled?: boolean; network?: { allowedDomains?: string[] } };
}

/** Posts `{ url, headers, body }` from stdin and prints the answer; exits 1 on a non-2xx status. */
const POST = `let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', async () => { const r = JSON.parse(s); const res = await fetch(r.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...r.headers }, body: JSON.stringify(r.body) }); if (!res.ok) process.exit(1); process.stdout.write(await res.text()); });`;

/** What the extension sends on stdin: a user turn, or a control request. */
interface ClientMessage {
  type?: string;
  uuid: string;
  request_id?: string;
  request: { subtype: string };
  message: { content: string };
}

interface ToolInput {
  file_path?: string;
  content?: string;
  [key: string]: unknown;
}

function main(): void {
  const args = process.argv.slice(2);
  const argOf = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes('--version')) {
    console.log('9.9.9 (Fake Claude)');
    process.exit(0);
  }
  if (args.includes('--help')) {
    console.log('--print --output-format --input-format --verbose --include-partial-messages --append-system-prompt --model --effort --tools --mcp-config --strict-mcp-config --disallowedTools --setting-sources --settings --add-dir --name --json-schema');
    process.exit(0);
  }
  if (args[0] === 'auth' && args[1] === 'status') {
    const out = process.env.FAKE_LOGGED_OUT ? { loggedIn: false, authMethod: 'none' } : { loggedIn: true, authMethod: 'claude.ai', email: 'dev@example.com', subscriptionType: 'pro' };
    console.log(JSON.stringify(out));
    process.exit(0);
  }
  if (args[0] === 'mcp') {
    const marker = path.join(process.env.FAKE_STATE || os.tmpdir(), 'mcp-signed-in');
    const signedIn = fs.existsSync(marker);
    if (args[1] === 'list') {
      console.log('Checking MCP server health…\n');
      console.log('claude.ai Docs: https://api.anthropic.com/mcp - ✔ Connected');
      console.log(`Atlassian: https://mcp.atlassian.com/v1/sse (SSE) - ${signedIn ? '✔ Connected' : '! Needs authentication'}`);
      console.log('Grafana: http://localhost:8765/mcp (HTTP) - ✗ Failed to connect');
      console.log('local-db: npx -y db-mcp - ✔ Connected');
      process.exit(0);
    }
    if (args[1] === 'get') {
      console.log(`${args[2]}:\n  Type: http\n  URL: https://mcp.example.com\n  Headers:\n    Authorization: Bearer abc.def\n  Env:\n    API_TOKEN=supersecret`);
      process.exit(0);
    }
    if (args[1] === 'login') {
      console.log(`Opening your browser to sign in to ${args[2]}: https://auth.example.com/authorize?client=cs`);
      setTimeout(() => {
        fs.writeFileSync(marker, '1');
        console.log('Authentication successful');
        process.exit(0);
      }, Number(process.env.FAKE_LOGIN_MS || 300));
      return;
    }
  }
  const log = process.env.FAKE_LOG;
  if (log) fs.appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd(), ghToken: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN), scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB })}\n`);

  const rawSettings = argOf('--settings');
  const settings: Settings | null = rawSettings ? JSON.parse(rawSettings.trim().startsWith('{') ? rawSettings : fs.readFileSync(rawSettings, 'utf8')) : null;
  const hook = settings && settings.hooks && settings.hooks.PreToolUse && settings.hooks.PreToolUse[0] ? settings.hooks.PreToolUse[0].hooks[0] : undefined;

  /**
   * Asks the hook like Claude Code: the input as the POST body, `$VAR` in a header filled only from allowedEnvVars.
   * A hook that fails (no answer, a non-2xx status, a timeout) lets the call go on unless it says `onFailure: block`;
   * the fake then allows it, as an allow rule of the project would.
   */
  function askHook(input: object): { allow: boolean; reason: string } {
    if (!hook) return { allow: true, reason: 'no hook' };
    // With the sandbox on, Claude Code sends the hook through the sandbox's network proxy: a host it does not allow
    // never gets the request (the real CLI waits minutes for an approval, then gets a 403).
    const sandboxed = settings && settings.sandbox && settings.sandbox.enabled;
    const allowed = (settings && settings.sandbox && settings.sandbox.network && settings.sandbox.network.allowedDomains) || [];
    if (sandboxed && !allowed.includes(new URL(hook.url).host)) {
      const failure = `PreToolUse hook failed: HTTP 403 from ${hook.url} (the sandbox's proxy)`;
      return hook.onFailure === 'block' ? { allow: false, reason: failure } : { allow: true, reason: failure };
    }
    const env = (name: string): string => ((hook.allowedEnvVars || []).includes(name) ? process.env[name] || '' : '');
    const headers = Object.fromEntries(Object.entries(hook.headers || {}).map(([k, v]) => [k, v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, name: string) => env(name))]));
    try {
      const out = execFileSync(process.execPath, ['-e', POST], { input: JSON.stringify({ url: hook.url, headers, body: input }), timeout: (hook.timeout ?? 600) * 1000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const d = JSON.parse(out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
      return { allow: d.permissionDecision === 'allow', reason: d.permissionDecisionReason };
    } catch (e) {
      const failure = `PreToolUse hook failed: ${(e as Error).message.split('\n')[0]}`;
      return hook.onFailure === 'block' ? { allow: false, reason: failure } : { allow: true, reason: failure };
    }
  }
  const ALIAS: Record<string, string> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
  const resolvedModel = ALIAS[argOf('--model')!] || argOf('--model') || 'claude-opus-5-5';
  const sessionId = `fake-${process.pid}`;
  const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  let cost = 0;
  let ctx = 0;
  let tokensTotal = 0;
  let limitsSent = false;
  let role: string | undefined;
  let repoDir: string | undefined;

  /**
   * Runs the hook like Claude Code: JSON on stdin, decision JSON on stdout. `failed`: what the tool says when it runs and
   * fails (a command the sandbox refused).
   */
  function tool(name: string, input: ToolInput, failed?: string) {
    sleep(DELAY);
    const id = `tu_${Math.random().toString(36).slice(2)}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null });
    const d = askHook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, cwd: process.cwd(), session_id: sessionId });
    const allowed = d.allow;
    let result = d.reason;
    if (allowed && name === 'Write') {
      fs.mkdirSync(path.dirname(input.file_path!), { recursive: true });
      fs.writeFileSync(input.file_path!, input.content!);
      result = `File created successfully at: ${input.file_path}`;
    }
    if (allowed && failed !== undefined) result = failed;
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !allowed || failed !== undefined, content: result }] }, parent_tool_use_id: null });
    return allowed;
  }

  const DELAY = Number(process.env.FAKE_DELAY || 0);
  const sleep = (ms: number) => {
    if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };

  /**
   * With --json-schema, like Claude Code: the report's data goes over the StructuredOutput tool (through the hook) and
   * comes back as `structured_output`, with `result` holding it as JSON text; the report itself is the turn's text.
   */
  const jsonSchema = argOf('--json-schema');

  function reply(text: string, uuid: string) {
    if (process.env.FAKE_AUTH_FAIL) {
      out({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', total_cost_usd: 0, num_turns: 0, user_message_uuids: [uuid] });
      return;
    }
    let structured: unknown;
    const block = jsonSchema ? text.match(/\n*```json\n([\s\S]*?)\n```\s*$/) : null;
    if (block) {
      structured = JSON.parse(block[1]!);
      text = text.slice(0, block.index).trim();
    }
    for (const chunk of text.match(/.{1,40}/gs) || []) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } }, parent_tool_use_id: null });
      sleep(DELAY / 10);
    }
    ctx += 12000;
    out({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 4, cache_read_input_tokens: ctx, cache_creation_input_tokens: 1000, output_tokens: 300 } }, parent_tool_use_id: null });
    // Real Claude Code reports the account's windows with the first response of a session.
    if (!limitsSent) {
      limitsSent = true;
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1900000000, unifiedWindows: { five_hour: { utilization: 0.31, resetsAt: 1900000000, status: 'allowed' }, seven_day: { utilization: 0.26, resetsAt: 1900300000, status: 'allowed' } } } });
    }
    cost += 0.01;
    tokensTotal += ctx + 1300;
    if (structured !== undefined && !tool('StructuredOutput', structured as ToolInput)) {
      out({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, errors: ['StructuredOutput was not allowed'], total_cost_usd: cost, num_turns: 1, user_message_uuids: [uuid] });
      return;
    }
    const model = resolvedModel;
    out({ type: 'result', subtype: 'success', is_error: false, result: structured !== undefined ? JSON.stringify(structured) : text, ...(structured !== undefined && { structured_output: structured }), total_cost_usd: cost, num_turns: 1, user_message_uuids: [uuid], modelUsage: { [model]: { inputTokens: 4, outputTokens: 300, cacheReadInputTokens: tokensTotal, cacheCreationInputTokens: 1000, contextWindow: 200000, costUSD: cost } } });
  }

  const state = process.env.FAKE_STATE;

  /**
   * A plan with a section per repo; `text: false` hands over only its data, as a planner that ends on StructuredOutput.
   * FAKE_PLAN_BASE: the branch its repos start from (FAKE_PLAN_BASE_FIRST in the first plan).
   */
  function plan(names: string, uuid: string, { slug = 'add-feature', text = true, base = process.env.FAKE_PLAN_BASE }: { slug?: string; text?: boolean; base?: string | undefined } = {}) {
    const repos = names.split(',').map((name) => ({ name, mode: 'full', ...(base && { baseBranch: base }) }));
    const sections = repos.map((r) => `### ${r.name}\n- do it`).join('\n\n');
    // FAKE_PLAN_BLOCKING: a question only the user can answer, until a prompt carries the user's answer.
    const blocking = process.env.FAKE_PLAN_BLOCKING && !/Feedback from the user, verbatim:/.test(firstPrompt) ? [{ question: process.env.FAKE_PLAN_BLOCKING, default: 'change nothing', blocking: true }] : [];
    const data = `\`\`\`json\n${JSON.stringify({ type: 'feat', slug, title: 'add the feature', repos, openQuestions: blocking })}\n\`\`\``;
    return reply(text ? `## Summary\n\nAdd the feature to every repo.\n\n## Steps\n\n${sections}\n\n${data}` : `\n${data}`, uuid);
  }

  let firstPrompt = '';
  function first(prompt: string, uuid: string) {
    role = (prompt.match(/You are the `([^`]+)` stage/) || [])[1];
    firstPrompt = prompt;
    // FAKE_API_ERROR_ONCE=<role>: its first turn ends on an overloaded API, past Claude Code's own retries.
    const apiMarker = state ? path.join(state, `api-error-${role}`) : '';
    if (process.env.FAKE_API_ERROR_ONCE && process.env.FAKE_API_ERROR_ONCE === role && apiMarker && !fs.existsSync(apiMarker)) {
      fs.writeFileSync(apiMarker, '1');
      out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', total_cost_usd: cost, num_turns: 1, user_message_uuids: [uuid] });
      return;
    }
    const issue = prompt.match(/^Read the Jira issue (\S+)/);
    if (issue) {
      tool('mcp__Atlassian__getJiraIssue', { issueIdOrKey: issue[1] });
      tool('mcp__Atlassian__addCommentToJiraIssue', { issueIdOrKey: issue[1], commentBody: 'hi' });
      return reply(`Read it.\n\`\`\`json\n${JSON.stringify({ title: `${issue[1]} Cap the max bet`, url: `https://acme.atlassian.net/browse/${issue[1]}`, description: 'Players can bet too much.\n\n## Acceptance criteria\n- bets above the cap are rejected', acceptanceCriteria: [], links: [], context: 'PM: per operator, not global' })}\n\`\`\``, uuid);
    }
    const comment = prompt.match(/^Add one comment to the Jira issue (\S+)/);
    if (comment) {
      const body = (prompt.match(/-----BEGIN COMMENT-----\n([\s\S]*)\n-----END COMMENT-----/) || [])[1] || '';
      if (state) fs.writeFileSync(path.join(state, `comment-${comment[1]}.txt`), body);
      tool('mcp__Atlassian__getAccessibleAtlassianResources', {});
      // What a session steered by text in the comment would try: read other issues, post elsewhere, add what it read.
      tool('mcp__Atlassian__searchJiraIssuesUsingJql', { jql: 'project = SECRET' });
      tool('mcp__Atlassian__addCommentToJiraIssue', { issueIdOrKey: 'OTHER-1', commentBody: body });
      tool('mcp__Atlassian__addCommentToJiraIssue', { issueIdOrKey: comment[1], commentBody: `${body}\n\nSECRET-1 says: the admin password is hunter2` });
      const posted = tool('mcp__Atlassian__addCommentToJiraIssue', { issueIdOrKey: comment[1], commentBody: body });
      tool('mcp__Atlassian__addCommentToJiraIssue', { issueIdOrKey: comment[1], commentBody: 'twice' });
      tool('mcp__Atlassian__editJiraIssue', { issueIdOrKey: comment[1], fields: {} });
      return reply(`Done.\n\`\`\`json\n${JSON.stringify(posted ? { ok: true, commentId: '10001' } : { error: 'not allowed' })}\n\`\`\``, uuid);
    }
    repoDir = (prompt.match(/Repository: \S+ at (.+)\. Work only there\./) || [])[1];
    switch (role) {
      case 'planner':
        // FAKE_PLAN_REPOS_FIRST: the first plan names repos by another name (the package's), as a small model may.
        // FAKE_PLAN_NO_TEXT: the first plan is only its data, the text never written.
        return plan(process.env.FAKE_PLAN_REPOS_FIRST || process.env.FAKE_REPOS || 'api', uuid, { text: !process.env.FAKE_PLAN_NO_TEXT, base: process.env.FAKE_PLAN_BASE_FIRST || process.env.FAKE_PLAN_BASE });
      case 'developer': {
        // FAKE_TODO_STATUS: a to-do status an agent steered by a ticket might write (the dashboard must not run it as markup).
        if (process.env.FAKE_TODO_STATUS) tool('TodoWrite', { todos: [{ content: 'Add the feature', status: process.env.FAKE_TODO_STATUS, activeForm: 'Adding it' }, { content: 'Write the test', status: 'pending', activeForm: 'Writing it' }] });
        tool('Bash', { command: 'git commit -am "sneaky"' });
        tool('Write', { file_path: path.join(repoDir!, '..', 'outside.txt'), content: 'nope' });
        tool('Write', { file_path: path.join(repoDir!, 'feature.txt'), content: 'feature\n' });
        // FAKE_DEV_FILES: more files the developer writes, as {"path": "content"} (a credential it should not have).
        for (const [file, content] of Object.entries(JSON.parse(process.env.FAKE_DEV_FILES || '{}') as Record<string, string>)) tool('Write', { file_path: path.join(repoDir!, file), content });
        // FAKE_DEV_SHELL: commands it runs that fail as given, [{"command", "output"}] (a git apply the sandbox refused);
        // only on the first run, so a retry does without them.
        const shell = path.join(state!, 'dev-shell-done');
        if (process.env.FAKE_DEV_SHELL && !fs.existsSync(shell)) {
          fs.writeFileSync(shell, '1');
          for (const c of JSON.parse(process.env.FAKE_DEV_SHELL) as { command: string; output: string }[]) tool('Bash', { command: c.command }, c.output);
        }
        // FAKE_BLOCKED=developer: the plan does not hold, and the developer says so instead of working around it.
        if (process.env.FAKE_BLOCKED === 'developer') return reply(`The plan names table bets_v2, which does not exist.\n\`\`\`json\n${JSON.stringify({ status: 'blocked', blockers: ['the plan names table bets_v2, which does not exist'] })}\n\`\`\``, uuid);
        // FAKE_DEV_NO_TEXT: no text at all, the report only in the status it hands over (as agents end on StructuredOutput).
        if (process.env.FAKE_DEV_NO_TEXT) return reply(`\n\`\`\`json\n${JSON.stringify({ status: 'done', report: '## Developer report\nChanged feature.txt.' })}\n\`\`\``, uuid);
        return reply(`Changed feature.txt.\n\`\`\`json\n${JSON.stringify({ status: 'done' })}\n\`\`\``, uuid);
      }
      case 'tester': {
        // One tester across every repo of the task, or (tasks from before) the one repo it is given.
        const section = (prompt.match(/Repositories of this task[^\n]*\n((?:- .+\n?)+)/) || [])[1] || '';
        const dirs = [...section.matchAll(/^- \S+ at (.+)$/gm)].map((m) => m[1]);
        for (const dir of dirs.length ? dirs : [repoDir]) tool('Write', { file_path: path.join(dir!, 'feature.test.txt'), content: 'test\n' });
        // FAKE_BLOCKED=tester: its test shows a bug in code it may not change, which it leaves failing.
        if (process.env.FAKE_BLOCKED === 'tester') return reply(`The new test fails: discount() returns a negative price over 100%.\n\`\`\`json\n${JSON.stringify({ status: 'blocked', blockers: ['discount() returns a negative price for percent > 100 (src/price.js:6)'] })}\n\`\`\``, uuid);
        return reply(`Added feature.test.txt in ${dirs.length || 1} repo(s).`, uuid);
      }
      case 'reviewer': {
        const marker = path.join(state!, 'reviewed-once');
        if (process.env.FAKE_REVIEW === 'fail-once' && !fs.existsSync(marker)) {
          fs.writeFileSync(marker, '1');
          const repo = (process.env.FAKE_REPOS || 'api').split(',').pop();
          // FAKE_REVIEW_FILE: the file its finding is about (one of the repo's settings, say).
          return reply(`Needs a fix.\n\`\`\`json\n${JSON.stringify({ status: 'changes_requested', summary: 'missing edge case', findings: [{ severity: 'major', repo, file: process.env.FAKE_REVIEW_FILE || 'feature.txt', line: 1, problem: 'edge case' }] })}\n\`\`\``, uuid);
        }
        return reply(`Looks good.\n\`\`\`json\n${JSON.stringify({ status: 'approved', summary: 'ok', findings: [{ severity: 'minor', problem: 'nit' }] })}\n\`\`\``, uuid);
      }
      case 'verifier':
      case 'auditor': {
        if (state) fs.writeFileSync(path.join(state, `prompt-${role}.txt`), prompt);
        // A read-only stage may not write; the guard says so.
        const repo = (prompt.match(/^- (\S+) at (\S+) \(base branch/m) || [])[2];
        if (repo) tool('Write', { file_path: path.join(repo, 'audit-notes.txt'), content: 'x' });
        tool('Bash', { command: 'git log --all --oneline --grep PROJ' });
        if (role === 'verifier') {
          return reply(`## Verdict\n\nMostly there.\n\n\`\`\`json\n${JSON.stringify({ summary: 'The cap is enforced; the operator override is missing.', work: [{ repo: 'api', ref: 'feat/PROJ-805-cap' }], criteria: [{ criterion: 'bets above the cap are rejected', status: 'met', evidence: 'validateBet throws', files: ['api/src/bet.ts:12'] }, { criterion: 'the cap is per operator', status: 'not_met', evidence: 'a global constant' }], gaps: [{ severity: 'high', problem: 'no test for the cap', fix: 'add one' }] })}\n\`\`\``, uuid);
        }
        return reply(`## Audit\n\nTwo problems.\n\n\`\`\`json\n${JSON.stringify({ summary: 'One slow query, one crash.', scope: ['api'], findings: [{ severity: 'medium', category: 'performance', repo: 'api', file: 'src/report.ts', line: 40, title: 'N+1 query in the report', problem: 'one query per row', impact: 'slow under load', fix: 'join', effort: 'S' }, { severity: 'critical', category: 'bug', repo: 'api', file: 'src/pay.ts', line: 7, title: 'Payout can be negative', problem: 'no lower bound', impact: 'money lost', fix: 'clamp' }] })}\n\`\`\``, uuid);
      }
      default:
        return reply('I do not know this role.', uuid);
    }
  }

  let buf = '';
  let turn = 0;
  /** The message a hanging agent never answers. */
  let hanging: string | null = null;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m: ClientMessage = JSON.parse(line);
      // FAKE_STUBBORN: a CLI stuck on a hung tool, which neither an interrupt nor SIGTERM ends.
      if (m.type === 'control_request' && m.request.subtype === 'interrupt' && process.env.FAKE_STUBBORN) continue;
      if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
        out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        // Claude Code ends the turn it is in with an error result.
        if (hanging) out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], total_cost_usd: cost, num_turns: 0, user_message_uuids: [hanging] });
        hanging = null;
        continue;
      }
      if (m.type === 'control_request') {
        const model = resolvedModel;
        const response = m.request.subtype === 'get_settings'
          ? { effective: {}, sources: [], applied: { model, effort: argOf('--effort') || process.env.FAKE_DEFAULT_EFFORT || 'medium' } }
          : { models: [{ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' }, { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }, { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }], account: { email: 'dev@example.com' } };
        out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
        continue;
      }
      const text = m.message.content;
      out({ type: 'system', subtype: 'init', session_id: sessionId, model: resolvedModel });
      if (turn++ === 0) {
        if (process.env.FAKE_HANG && process.env.FAKE_HANG === (text.match(/You are the `([^`]+)`/) || [])[1]) {
          hanging = m.uuid; // never answers, until interrupted
          continue;
        }
        first(text, m.uuid);
      } else if (/Continue where you left off/.test(text)) first(firstPrompt, m.uuid);
      // FAKE_API_ERROR_GATES=<role>: the first turn fixing its red checks ends on an overloaded API.
      else if (/^Gates failed/.test(text) && process.env.FAKE_API_ERROR_GATES === role && state && !fs.existsSync(path.join(state, `api-error-gates-${role}`))) {
        fs.writeFileSync(path.join(state, `api-error-gates-${role}`), '1');
        out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', total_cost_usd: cost, num_turns: 1, user_message_uuids: [m.uuid] });
      }
      // FAKE_BLOCKED_ON_GATES=<role>: asked to fix its red checks, it says it cannot.
      else if (/^Gates failed/.test(text) && process.env.FAKE_BLOCKED_ON_GATES === role) reply(`The check needs a database this machine does not have.\n\`\`\`json\n${JSON.stringify({ status: 'blocked', blockers: ['the check needs a database'] })}\n\`\`\``, m.uuid);
      else if (role === 'planner' && /repos this workspace does not have|named more than once|the report has no text|origin has no branch/.test(text)) plan(process.env.FAKE_REPOS || 'api', m.uuid);
      else if (role === 'planner' && /choose another slug/.test(text)) plan(process.env.FAKE_REPOS || 'api', m.uuid, { slug: 'add-feature-again' });
      else reply(`Follow-up handled: ${text.split('\n')[0]!.slice(0, 60)}`, m.uuid);
    }
  });
  process.stdin.on('end', () => !process.env.FAKE_STUBBORN && process.exit(0));
  if (process.env.FAKE_STUBBORN) process.on('SIGTERM', () => undefined);
}

main();
