// Child processes and git: an npm shim on Windows (`claude.cmd`) is read and its target spawned directly, and the
// guard reads a checkout's branch without spawning git.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { npmShimTarget } from '../src/core/env';
import { branchAt, launch, setShim } from '../src/core/git';

// What `npm install -g @anthropic-ai/claude-code` writes, in the cmd-shim format of npm 7+ and in the older one.
const SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;
const OLD_SHIM = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
)
`;

test('launch: the target of an npm shim is found in both shim formats', async () => {
  const dir = path.join('npm-global');
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  assert.equal(npmShimTarget(SHIM, dir), cli);
  assert.equal(npmShimTarget(OLD_SHIM, dir), cli);
  assert.equal(npmShimTarget('@echo off\r\nclaude-native.exe %*\r\n', dir), null, 'a script of another shape is not guessed at');
});

test('launch: a registered shim runs its target with the arguments, anything else runs as it is', async () => {
  setShim('C:\\npm\\claude.cmd', { file: 'C:\\node\\node.exe', args: ['C:\\npm\\cli.js'] });
  assert.deepEqual(launch('C:\\npm\\claude.cmd', ['-p', '--verbose']), ['C:\\node\\node.exe', ['C:\\npm\\cli.js', '-p', '--verbose']]);
  assert.deepEqual(launch('/usr/local/bin/claude', ['--version']), ['/usr/local/bin/claude', ['--version']]);
});

test('git: the branch of a checkout is read from HEAD, in a worktree and a subfolder too', async () => {
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-head-')));
  run(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  run(repo, 'add', '.');
  run(repo, 'commit', '-q', '-m', 'init');
  assert.equal(branchAt(repo), 'main');
  assert.equal(branchAt(path.join(repo, 'src', 'deep')), 'main');
  run(repo, 'switch', '-q', '-c', 'feat/PROJ-1-cap');
  assert.equal(branchAt(repo), 'feat/PROJ-1-cap', 'a branch name with slashes');
  const wt = path.join(repo, '..', `${path.basename(repo)}-wt`);
  run(repo, 'worktree', 'add', '-q', '-b', 'fix/other', wt);
  assert.equal(branchAt(wt), 'fix/other', "a worktree's own HEAD");
  run(repo, 'switch', '-q', '--detach');
  assert.equal(branchAt(repo), 'HEAD', 'detached, as git rev-parse --abbrev-ref says');
  assert.equal(branchAt(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-norepo-'))), null);
});
