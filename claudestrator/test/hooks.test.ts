// The guard's HTTP endpoint: only a live session's token gets an answer from its policy; anything else is denied.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { HookServer, TOKEN_ENV } from '../src/core/hookserver';
import { workspace, harness, runTask } from './helpers/e2e';
import type { ToolCall } from '../src/core/hookserver';

async function post(url: string, body: string, token?: string): Promise<{ status: number; decision?: string; reason?: string }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token !== undefined && { Authorization: `Bearer ${token}` }) }, body });
  if (res.status !== 200) return { status: res.status };
  const out = (await res.json()) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  return { status: res.status, decision: out.hookSpecificOutput.permissionDecision, reason: out.hookSpecificOutput.permissionDecisionReason };
}

test('hooks: a session is asked about its own tool calls, and only with its token', async () => {
  const server = new HookServer();
  await server.listen();
  try {
    assert.match(server.url!, /^http:\/\/127\.0\.0\.1:\d+\/pretooluse$/, 'loopback only');
    const calls: ToolCall[] = [];
    const a = server.register((call) => {
      calls.push(call);
      return call.tool === 'Read' ? { allow: true } : { allow: false, reason: 'not here' };
    });
    assert.deepEqual(Object.keys(a.env), [TOKEN_ENV]);
    const read = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/ws/a.ts' }, cwd: '/ws' });
    assert.deepEqual(await post(server.url!, read, a.token), { status: 200, decision: 'allow', reason: 'allowed by Claudestrator' });
    assert.deepEqual(calls, [{ tool: 'Read', input: { file_path: '/ws/a.ts' }, cwd: '/ws' }]);
    assert.equal((await post(server.url!, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), a.token)).reason, 'not here');

    assert.equal((await post(server.url!, read, 'f'.repeat(48))).decision, 'deny', 'an unknown token');
    assert.equal((await post(server.url!, read)).decision, 'deny', 'no token at all');
    assert.equal((await post(server.url!, 'not json', a.token)).decision, 'deny', 'a malformed call');
    server.unregister(a.token);
    assert.match((await post(server.url!, read, a.token)).reason!, /no longer active/, 'a session that ended');

    const broken = server.register(() => {
      throw new Error('boom');
    });
    assert.match((await post(server.url!, read, broken.token)).reason!, /Claudestrator error: boom/, 'a failing policy denies');
    assert.equal((await fetch(server.url!.replace('/pretooluse', '/other'), { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(server.url!)).status, 404, 'only POST');
  } finally {
    server.dispose();
  }
});

test('hooks: the settings send every tool call to the server with the token from the environment', async () => {
  const server = new HookServer();
  assert.throws(() => server.settings(), /not listening/);
  await server.listen();
  try {
    const [entry] = server.settings().PreToolUse;
    assert.equal(entry!.matcher, '*');
    assert.deepEqual(entry!.hooks[0], { type: 'http', url: server.url, headers: { Authorization: `Bearer $${TOKEN_ENV}` }, allowedEnvVars: [TOKEN_ENV], timeout: 900, onFailure: 'block' });
  } finally {
    server.dispose();
  }
});

test('hooks: a guard that cannot answer blocks the tool call', async () => {
  // A guard whose server is gone: what an agent sees when VS Code closed or the extension restarted.
  const gone = new HookServer();
  await gone.listen();
  const unreachable = gone.settings();
  gone.dispose();
  const failOpen = { PreToolUse: unreachable.PreToolUse.map((e) => ({ ...e, hooks: e.hooks.map(({ onFailure: _drop, ...h }) => h) })) };

  for (const [hooks, written] of [[unreachable, false], [failOpen, true]] as const) {
    const ws = workspace(['api'], 'repos:\n  api: {}\npipeline: [planner, developer]\n');
    const h = await harness(ws, { FAKE_REPOS: 'api' });
    h.engine.agentSettings = () => ({ hooks });
    try {
      const { taskId } = h.engine.start({ text: 'Do a thing', auto: true });
      await runTask(h.engine, taskId);
      assert.equal(fs.existsSync(path.join(ws, 'api', 'feature.txt')), written, written ? 'without onFailure: block the call goes on unguarded' : 'with it, nothing is written');
    } finally {
      h.hooks.dispose();
    }
  }
});
