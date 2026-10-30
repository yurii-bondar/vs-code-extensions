// Shared by the end-to-end tests: real git repos in a temp workspace, the real engine, runner and hook server,
// and a fake Claude CLI that plays the pipeline roles.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { Engine } from '../../src/core/engine';
import { ClaudeRunner } from '../../src/core/runner';
import { HookServer } from '../../src/core/hookserver';
import { setChildEnv } from '../../src/core/git';
import type { TranscriptItem } from '../../src/core/store';
import type { ComposerArgs } from '../../src/core/engine';
import type { EventOf, EventType, OrchEvent, TaskState } from '../../src/core/types';

/** What the engine emits for every transcript item of a running agent. */
interface OutputEvent {
  taskId: string;
  key: string;
  item: TranscriptItem;
}

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');
fs.chmodSync(FAKE, 0o755);

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function workspace(repos: string[], configYaml: string): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-')));
  for (const name of repos) {
    const dir = path.join(ws, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  }
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), configYaml);
  return ws;
}

async function harness(ws: string, env: Record<string, string> = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fake-state-'));
  setChildEnv({ ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', FAKE_STATE: state, FAKE_LOG: path.join(state, 'calls.ndjson'), ...env });
  const hooks = new HookServer();
  await hooks.listen();
  const runner = new ClaudeRunner({ command: () => FAKE, flags: () => new Set(['--include-partial-messages', '--tools', '--setting-sources', '--name', '--effort', '--strict-mcp-config']), settingSources: () => ['project'], env: () => ({}) });
  const engine = new Engine({ workspace: ws, home: state, runner, hooks });
  const outputs: OutputEvent[] = [];
  engine.on('output', (o: OutputEvent) => outputs.push(o));
  const calls = () => fs.readFileSync(path.join(state, 'calls.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { engine, hooks, outputs, state, calls };
}

/** The events of one type, narrowed to it. */
const only = <T extends EventType>(events: OrchEvent[], type: T): EventOf<T>[] => events.filter((e): e is EventOf<T> => e.type === type);

/** Runs a task to its next stop; the task is known to exist. */
async function runTask(engine: Engine, taskId: string): Promise<TaskState> {
  const s = await engine.run(taskId);
  assert.ok(s, 'the task ran');
  return s;
}

/** What the composer's preview says about a valid input; the test fails for an empty or rejected one. */
function previewOf(engine: Engine, args: ComposerArgs) {
  const p = engine.preview(args);
  assert.ok(p.ok && !('empty' in p), JSON.stringify(p));
  return p as Extract<typeof p, { pipeline: unknown }>;
}

/** A transcript field the test reads as text. */
const text = (v: unknown): string => String(v);

const waitFor = async <T>(fn: () => T | null | undefined | false, ms = 20000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
};

export type { OutputEvent };
export { FAKE, git, workspace, harness, only, runTask, previewOf, text, waitFor };
