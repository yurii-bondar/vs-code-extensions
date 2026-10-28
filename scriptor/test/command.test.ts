import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, expandHome, interpreterOf, kindOf, quote, shellKind } from '../src/core/command';

const script = (path: string, extra: { interpreter?: string; args?: string } = {}) => ({ path, interpreter: '', args: '', ...extra });

test('shellKind tells the shells apart by name', () => {
  assert.equal(shellKind('/bin/zsh'), 'posix');
  assert.equal(shellKind('C:\\Windows\\System32\\cmd.exe'), 'cmd');
  assert.equal(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'powershell');
});

test('quote survives spaces and quotes in every shell', () => {
  assert.equal(quote("/a b/it's.sh", 'posix'), `'/a b/it'\\''s.sh'`);
  assert.equal(quote("C:\\a b\\it's.ps1", 'powershell'), "'C:\\a b\\it''s.ps1'");
  assert.equal(quote('C:\\a b\\x.bat', 'cmd'), '"C:\\a b\\x.bat"');
});

test('the interpreter follows the extension, and python differs on Windows', () => {
  assert.equal(interpreterOf(script('/x/run.sh'), 'darwin'), 'bash');
  assert.equal(interpreterOf(script('/x/run.py'), 'linux'), 'python3');
  assert.equal(interpreterOf(script('C:\\x\\run.py'), 'win32'), 'python');
  assert.equal(interpreterOf(script('/x/run.JS'), 'darwin'), 'node');
});

test('an own interpreter wins over the extension', () => {
  assert.equal(interpreterOf(script('/x/run.py', { interpreter: ' /venv/bin/python -u ' }), 'darwin'), '/venv/bin/python -u');
});

test('a file without a known interpreter is run itself', () => {
  assert.equal(interpreterOf(script('/x/tool'), 'darwin'), null);
  assert.equal(interpreterOf(script('C:\\x\\go.bat'), 'win32'), null);
});

test('buildCommand puts the interpreter, the quoted file and the arguments in order', () => {
  assert.equal(buildCommand({ script: script('/my dir/a.py', { args: '--fast  x' }), shell: 'posix', platform: 'darwin' }), "python3 '/my dir/a.py' --fast  x");
});

test('buildCommand runs a bare file with & in PowerShell and plain in other shells', () => {
  const s = script('/x/tool', { args: '-v' });
  assert.equal(buildCommand({ script: s, shell: 'powershell', platform: 'win32' }), "& '/x/tool' -v");
  assert.equal(buildCommand({ script: s, shell: 'posix', platform: 'linux' }), "'/x/tool' -v");
});

test('kindOf describes a known file and falls back for others', () => {
  assert.deepEqual([kindOf('/x/a.py').label, kindOf('/x/a.py').short], ['Python', 'PY']);
  assert.deepEqual([kindOf('/x/a.rs').label, kindOf('/x/a.rs').short], ['RS', 'RS']);
  assert.equal(kindOf('/x/tool').short, 'EXE');
});

test('expandHome only touches a leading ~', () => {
  assert.equal(expandHome('~/bin/a.sh', '/home/me'), '/home/me/bin/a.sh');
  assert.equal(expandHome('  ~ ', '/home/me'), '/home/me');
  assert.equal(expandHome('/a/~b', '/home/me'), '/a/~b');
});
