// Starting the Claude Code CLI: an npm shim on Windows (`claude.cmd`) is read and its target spawned directly.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

import { npmShimTarget } from '../src/core/env';
import { launch, setShim } from '../src/core/git';

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

test('launch: the target of an npm shim is found in both shim formats', () => {
  const dir = path.join('npm-global');
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  assert.equal(npmShimTarget(SHIM, dir), cli);
  assert.equal(npmShimTarget(OLD_SHIM, dir), cli);
  assert.equal(npmShimTarget('@echo off\r\nclaude-native.exe %*\r\n', dir), null, 'a script of another shape is not guessed at');
});

test('launch: a registered shim runs its target with the arguments, anything else runs as it is', () => {
  setShim('C:\\npm\\claude.cmd', { file: 'C:\\node\\node.exe', args: ['C:\\npm\\cli.js'] });
  assert.deepEqual(launch('C:\\npm\\claude.cmd', ['-p', '--verbose']), ['C:\\node\\node.exe', ['C:\\npm\\cli.js', '-p', '--verbose']]);
  assert.deepEqual(launch('/usr/local/bin/claude', ['--version']), ['/usr/local/bin/claude', ['--version']]);
});
