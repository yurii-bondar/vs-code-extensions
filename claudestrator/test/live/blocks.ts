// A live run of a scenario's blocks against the Claude Code CLI installed here (`npm run test:live`; it costs a few
// cents): on haiku at low effort, a developer, two reviewers in a Parallel, You approve after them, and a Branch on
// the second reviewer's verdict. It checks what a fake CLI cannot: that two real sessions run at once and both report,
// that the question shows both reports, that the branch follows the verdict the agent actually gave, and that the
// task's diagram says the same.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { Engine } from '../../src/core/engine';
import { ClaudeRunner, parseFlags } from '../../src/core/runner';
import { HookServer } from '../../src/core/hookserver';
import { setChildEnv } from '../../src/core/git';
import { flowOf } from '../../src/core/flow';
import type { FlowItem } from '../../src/core/flow';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function workspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-live-blocks-')));
  git(ws, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'greet', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`);
  git(ws, 'add', '.');
  git(ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(
    path.join(ws, '.claudestrator', 'config.yaml'),
    `repos:
  app:
    path: .
    gates:
      - { name: test, cmd: node --test }
agents:
  developer: { model: haiku, effort: low }
  tester: { model: haiku, effort: low }
  reviewer: { model: haiku, effort: low }
  security-reviewer: { extends: reviewer, description: Reviews the diff for security problems only }
limits: { budgetUsd: 1, gateAttempts: 2, reviewRounds: 1 }
scenarios:
  ship-secure:
    label: Ship secure
    agents:
      - developer
      - parallel: [reviewer, security-reviewer]
      - approve: Read both reviews
      - branch:
          on: security-reviewer
          if: { verdict: approved }
          then: [tester]
`
  );
  return ws;
}

const TASK = 'Create greet.js exporting greet(name) that returns "Hello, <name>!", with a node:test test in greet.test.js. Keep it tiny. --repos app';

async function main(): Promise<void> {
  const claude = process.env.CLAUDE_PATH || 'claude';
  const version = execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim();
  const flags = parseFlags(execFileSync(claude, ['--help'], { encoding: 'utf8' }));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: 'live', GIT_AUTHOR_EMAIL: 'live@example.com', GIT_COMMITTER_NAME: 'live', GIT_COMMITTER_EMAIL: 'live@example.com' };
  delete env.CLAUDECODE;
  setChildEnv(env);
  const ws = workspace();
  console.log(`Claude Code ${version}\nworkspace: ${ws}`);

  const hooks = new HookServer();
  await hooks.listen();
  const runner = new ClaudeRunner({ command: () => claude, version: () => version, flags: () => flags, settingSources: () => ['project', 'local'], env: () => ({}) });
  const engine = new Engine({ workspace: ws, runner, hooks });
  engine.on('log', (l: { level: string; message: string }) => console.log(`  [${l.level}] ${l.message}`));

  const results: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, detail = ''): void => void results.push([name, ok, detail]);
  try {
    const { taskId } = await engine.start({ text: TASK, scenario: 'ship-secure' });
    let s = await engine.run(taskId);
    const err = engine.lastError(taskId);
    check('the task waits for you after the reviewers', Boolean(s && s.checkpoint && s.checkpoint.id === 'approve-step'), err ? `${err.code}: ${err.message}` : s && s.checkpoint ? `${s.checkpoint.id}: ${s.checkpoint.reason ?? ''}` : String(s && s.status));
    const events = await engine.svc.events(taskId);
    const order = events.flatMap((e) => (e.type === 'stage_started' || e.type === 'stage_completed' ? [`${e.type === 'stage_started' ? '>' : '<'}${e.agent}`] : []));
    const firstEnd = order.findIndex((x) => x === '<reviewer' || x === '<security-reviewer');
    check('both reviewers started before either ended (two sessions at once)', firstEnd > 0 && order.slice(0, firstEnd).includes('>reviewer') && order.slice(0, firstEnd).includes('>security-reviewer'), order.join(' '));
    if (!s || !s.checkpoint || s.checkpoint.id !== 'approve-step') throw new Error('stopped before the approval');

    const ctx = await engine.checkpointContext(s, s.checkpoint);
    check('the approval shows what to look at and both reports', ctx.text.startsWith('**Read both reviews**') && ctx.text.split('\n\n---\n\n').length === 2, `${ctx.text.length} chars`);
    const verdict = s.review.verdicts.find((v) => v.agent === 'security-reviewer') ?? s.review.lastVerdicts.find((v) => v.agent === 'security-reviewer');
    check('security-reviewer gave a verdict', Boolean(verdict), verdict ? verdict.status : 'none');

    await engine.answer(taskId, 'approve-step', 'approve');
    for (let i = 0; i < 3000 && engine.isRunning(taskId); i++) await new Promise((r) => setTimeout(r, 100));
    s = await engine.svc.state(taskId);
    const testerRan = (await engine.svc.events(taskId)).some((e) => e.type === 'stage_started' && e.agent === 'tester');
    check('the branch followed the verdict: tester ran only if security-reviewer approved', testerRan === (verdict?.status === 'approved'), `verdict ${verdict?.status}, tester ${testerRan ? 'ran' : 'skipped'}`);
    check('the task reaches the push question', Boolean(s.checkpoint && s.checkpoint.id === 'confirm-push'), s.checkpoint ? `${s.checkpoint.id}: ${s.checkpoint.reason ?? ''}` : `${s.status} ${engine.lastError(taskId)?.message ?? ''}`);

    const flow = flowOf(s);
    const parallel = flow.find((x): x is Extract<FlowItem, { kind: 'parallel' }> => x.kind === 'parallel') ?? flow.flatMap((x) => (x.kind === 'loop' ? x.items : [])).find((x): x is Extract<FlowItem, { kind: 'parallel' }> => x.kind === 'parallel');
    const branch = flow.find((x): x is Extract<FlowItem, { kind: 'branch' }> => x.kind === 'branch');
    const approve = flow.find((x): x is Extract<FlowItem, { kind: 'approve' }> => x.kind === 'approve');
    check('the Flow tab says the same', Boolean(parallel && parallel.nodes.every((n) => n.status === 'done') && approve && approve.status === 'done' && branch && branch.taken === (verdict?.status === 'approved' ? 'then' : 'else')), JSON.stringify({ parallel: parallel?.nodes.map((n) => n.status), approve: approve?.status, taken: branch?.taken }));

    if (s.checkpoint && s.checkpoint.id === 'confirm-push') {
      await engine.answer(taskId, 'confirm-push', 'local');
      for (let i = 0; i < 100 && engine.isRunning(taskId); i++) await new Promise((r) => setTimeout(r, 100));
      check('greet.js was committed on the task branch', git(ws, 'ls-files', 'greet.js').length > 0, git(ws, 'log', '--oneline', '-1'));
    }
    const spent = await engine.spentUsd(taskId);
    check('cost is reported', spent > 0, `$${spent.toFixed(3)}`);
  } finally {
    hooks.dispose();
  }
  for (const [name, ok, detail] of results) console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` (${detail})` : ''}`);
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
}

main().catch((e: Error) => {
  console.error(e);
  process.exitCode = 1;
});
