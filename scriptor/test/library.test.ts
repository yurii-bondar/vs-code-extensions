import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markRun, parseLibrary, removeGroup, removeScript, saveGroup, saveScript, validateGroup, validateScript } from '../src/core/library';
import type { GroupId, ScriptDraft, ScriptId } from '../src/core/types';

const draft = (extra: Partial<ScriptDraft> = {}): ScriptDraft => ({ id: null, type: 'file', name: '', path: '/x/deploy.sh', command: '', description: '', groupId: null, interpreter: '', args: '', cwd: '', ...extra });
let n = 0;
const ids = () => `id${++n}`;

test('parseLibrary survives anything and keeps only usable entries', () => {
  assert.deepEqual(parseLibrary(undefined), { groups: [], scripts: [] });
  assert.deepEqual(parseLibrary('x'), { groups: [], scripts: [] });
  const lib = parseLibrary({
    groups: [{ id: 'g1', name: 'Deploy', hue: 'nope' }, { id: 'g1', name: 'Dup' }, { name: 'no id' }],
    scripts: [
      { id: 's1', path: '/a/b.sh', groupId: 'gone', lastRunAt: 'x' },
      { id: 's1', path: '/dup.sh' },
      { id: 's2', name: 'N', path: '/a/c.py', groupId: 'g1', lastRunAt: 5 },
      { id: 's3' },
    ],
  });
  assert.deepEqual(lib.groups, [{ id: 'g1', name: 'Deploy', hue: 'violet' }]);
  assert.deepEqual(lib.scripts.map((s) => [s.id, s.name, s.groupId, s.lastRunAt]), [['s1', 'b.sh', null, 0], ['s2', 'N', 'g1', 5]]);
});

test('validateScript wants an absolute path', () => {
  assert.match(validateScript(draft({ path: ' ' })) ?? '', /Choose/);
  assert.match(validateScript(draft({ path: 'rel/a.sh' })) ?? '', /absolute/);
  assert.match(validateScript(draft({ cwd: 'rel' })) ?? '', /working directory/);
  assert.equal(validateScript(draft()), null);
  assert.match(validateGroup({ id: null, name: ' ', hue: 'blue' }) ?? '', /name/);
});

test('validateScript wants a command and an absolute folder for a command', () => {
  const cmd = (extra: Partial<ScriptDraft>) => draft({ type: 'command', path: '', command: 'npm run dev', cwd: '/app', ...extra });
  assert.equal(validateScript(cmd({})), null);
  assert.match(validateScript(cmd({ command: '  ' })) ?? '', /command/);
  assert.match(validateScript(cmd({ cwd: '' })) ?? '', /folder/);
  assert.match(validateScript(cmd({ cwd: 'app' })) ?? '', /absolute/);
});

test('saveScript keeps only what a command uses and names it after the command', () => {
  const lib = saveScript({ groups: [], scripts: [] }, draft({ type: 'command', path: '/x/left.sh', command: ' npm run dev ', interpreter: 'node', args: '-v', cwd: '/app' }), ids);
  const s = lib.scripts[0];
  assert.deepEqual([s?.type, s?.name, s?.path, s?.command, s?.interpreter, s?.args, s?.cwd], ['command', 'npm run dev', '', 'npm run dev', '', '', '/app']);
});

test('parseLibrary reads old entries as files and drops a command without a folder', () => {
  const lib = parseLibrary({
    scripts: [
      { id: 'a', path: '/a/b.sh' },
      { id: 'b', type: 'command', command: 'npm test', cwd: '/app' },
      { id: 'c', type: 'command', command: 'npm test' },
    ],
  });
  assert.deepEqual(lib.scripts.map((s) => [s.id, s.type, s.name]), [['a', 'file', 'b.sh'], ['b', 'command', 'npm test']]);
});

test('saveScript names the script after its file when no name is given', () => {
  const lib = saveScript({ groups: [], scripts: [] }, draft(), ids);
  assert.equal(lib.scripts[0]?.name, 'deploy.sh');
});

test('saveScript edits in place, keeps lastRunAt and drops an unknown group', () => {
  let lib = saveScript({ groups: [], scripts: [] }, draft(), ids);
  const id = lib.scripts[0]!.id;
  lib = markRun(lib, [id], 99);
  lib = saveScript(lib, draft({ id, name: 'Deploy', groupId: 'missing', args: ' -v ' }), ids);
  assert.equal(lib.scripts.length, 1);
  assert.deepEqual([lib.scripts[0]?.name, lib.scripts[0]?.groupId, lib.scripts[0]?.args, lib.scripts[0]?.lastRunAt], ['Deploy', null, '-v', 99]);
});

test('removeGroup leaves its scripts ungrouped', () => {
  let lib = saveGroup({ groups: [], scripts: [] }, { id: null, name: ' Stack ', hue: 'green' }, ids);
  const gid = lib.groups[0]!.id as GroupId;
  assert.equal(lib.groups[0]?.name, 'Stack');
  lib = saveScript(lib, draft({ groupId: gid }), ids);
  assert.equal(lib.scripts[0]?.groupId, gid);
  lib = removeGroup(lib, gid);
  assert.deepEqual([lib.groups.length, lib.scripts.length, lib.scripts[0]?.groupId], [0, 1, null]);
});

test('removeScript removes only that script', () => {
  let lib = saveScript({ groups: [], scripts: [] }, draft(), ids);
  lib = saveScript(lib, draft({ path: '/x/b.sh' }), ids);
  lib = removeScript(lib, lib.scripts[0]!.id as ScriptId);
  assert.deepEqual(lib.scripts.map((s) => s.path), ['/x/b.sh']);
});
