import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DIRECTORY_SLOTS, parseDirectories, projectsIn } from '../src/core/directory';
import { untildify } from '../src/core/paths';
import { isRecord } from '../src/core/types';

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtp-')));

test('projectsIn lists folders, linked folders and workspaces by name, not hidden entries or plain files', async () => {
  const dir = tmp();
  for (const name of ['beta', 'Alpha', 'app10', 'app9', '.git']) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'notes.md'), '');
  fs.writeFileSync(path.join(dir, 'team.code-workspace'), '{}');
  const outside = tmp();
  fs.symlinkSync(outside, path.join(dir, 'linked'));
  fs.symlinkSync(path.join(dir, 'gone'), path.join(dir, 'broken'));
  const names = (await projectsIn(dir)).map((p) => path.basename(p));
  assert.deepEqual(names, ['Alpha', 'app9', 'app10', 'beta', 'linked', 'team.code-workspace']);
  assert.equal((await projectsIn(dir))[0], path.join(dir, 'Alpha'));
});

test('projectsIn throws for a folder that is not there', async () => {
  await assert.rejects(projectsIn(path.join(tmp(), 'missing')));
});

test('parseDirectories keeps the non-empty strings in order', () => {
  assert.deepEqual(parseDirectories(undefined), []);
  assert.deepEqual(parseDirectories('~/code'), []);
  assert.deepEqual(parseDirectories([' ~/code ', '', 3, null, '/work']), ['~/code', '/work']);
});

test('untildify expands the home folder only at the start', () => {
  assert.equal(untildify('~', '/Users/me'), '/Users/me');
  assert.equal(untildify('~/code', '/Users/me'), path.join('/Users/me', 'code'));
  assert.equal(untildify('/opt/~/x', '/Users/me'), '/opt/~/x');
  assert.equal(untildify('~other/x', '/Users/me'), path.resolve('~other/x'));
});

test('package.json has a command and a palette entry for every directory slot', () => {
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const contributes = isRecord(pkg) && isRecord(pkg.contributes) ? pkg.contributes : {};
  const ids = (list: unknown): string[] => (Array.isArray(list) ? list.flatMap((c) => (isRecord(c) && typeof c.command === 'string' ? [c.command] : [])) : []);
  const slots = (list: unknown): string[] => ids(list).filter((id) => /^goToProject\.directory\d+$/.test(id));
  const expected = Array.from({ length: DIRECTORY_SLOTS }, (_, i) => `goToProject.directory${i + 1}`);
  assert.deepEqual(slots(contributes.commands), expected);
  assert.deepEqual(slots(isRecord(contributes.menus) ? contributes.menus.commandPalette : undefined), expected);
});
