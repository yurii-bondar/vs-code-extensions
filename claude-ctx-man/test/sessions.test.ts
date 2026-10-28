import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHandoff, copySession, inWorkspace, listSessions, slugFor, targetFile } from '../src/sessions';
import type { Account, ConfigDir } from '../src/types';

const ID = '11111111-2222-3333-4444-555555555555';
let root: string;
let cwd: string;
const account = (name: string): Account => ({ dir: path.join(root, name) as ConfigDir, label: name, email: '', org: '' });
const jsonl = (...entries: unknown[]): string => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-man-test-'));
  cwd = path.join(root, 'work', 'my app');
  const dir = path.join(root, 'a', 'projects', slugFor(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${ID}.jsonl`),
    jsonl(
      { type: 'user', cwd, gitBranch: 'feat/x', message: { role: 'user', content: 'Build the login page' } },
      { type: 'user', isMeta: true, message: { content: 'ignored meta' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Edit', input: { file_path: path.join(cwd, 'src', 'login.ts') } }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ status: 'completed', content: 'page' }, { status: 'in_progress', content: 'tests' }] } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
      { type: 'ai-title', aiTitle: 'Login page' }
    )
  );
  fs.writeFileSync(path.join(dir, 'not-a-session.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, `${ID.replace(/1/g, '2')}.jsonl`), '');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('listSessions reads the title, folder and branch, and skips what is not a session', () => {
  const list = listSessions(account('a'));
  assert.equal(list.length, 1);
  assert.deepEqual([list[0]?.id, list[0]?.title, list[0]?.cwd, list[0]?.branch, list[0]?.firstPrompt], [ID, 'Login page', cwd, 'feat/x', 'Build the login page']);
});

test('listSessions of an account without projects is empty', () => {
  assert.deepEqual(listSessions(account('nothing')), []);
});

test('inWorkspace matches by project folder, and by cwd inside a workspace', () => {
  const [s] = listSessions(account('a'));
  assert.ok(s);
  assert.equal(inWorkspace(s, [path.join(root, 'work', 'my app')]), true);
  assert.equal(inWorkspace(s, [path.join(root, 'work')]), true);
  assert.equal(inWorkspace(s, [path.join(root, 'other')]), false);
});

test('copySession puts the transcript where the other account looks for it', () => {
  const [s] = listSessions(account('a'));
  assert.ok(s);
  const to = account('b');
  copySession(s, to);
  assert.ok(fs.existsSync(targetFile(s, to)));
  assert.equal(listSessions(to)[0]?.title, 'Login page');
});

test('buildHandoff has the request, the changed file, the task list and the replies', () => {
  const [s] = listSessions(account('a'));
  assert.ok(s);
  const md = buildHandoff(s, { maxMessages: 12 });
  assert.match(md, /^# Handoff: Login page/);
  assert.match(md, /## Original request\n\nBuild the login page/);
  assert.match(md, /- `src\/login.ts`/);
  assert.match(md, /- \[x\] page\n- \[ \] tests _\(in progress\)_/);
  // One reply split over two entries is one message.
  assert.match(md, /### Assistant\n\nOn it.\n\nDone./);
  assert.doesNotMatch(md, /ignored meta|command-name/);
});

test('buildHandoff keeps only the last messages asked for', () => {
  const [s] = listSessions(account('a'));
  assert.ok(s);
  assert.match(buildHandoff(s, { maxMessages: 1 }), /last 1 messages\)/);
});
