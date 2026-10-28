import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { iconColor, iconSvg, initials } from '../src/core/icon';
import { readBranch, resolveGitDir } from '../src/core/git';
import { isUnder, tildify } from '../src/core/paths';
import { parseRecent } from '../src/core/recent';
import { beat, focused, lastProject, openProjects, parseFocus, parseRegistry, previousFirst, STALE_MS } from '../src/core/state';
import type { ProjectUri, WindowId } from '../src/core/types';

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtp-')));
const uri = (s: string): ProjectUri => s as ProjectUri;
const win = (s: string): WindowId => s as WindowId;

test('initials: two words, camelCase, one word, empty', () => {
  assert.equal(initials('shop-admin-panel'), 'SA');
  assert.equal(initials('myProject'), 'MP');
  assert.equal(initials('vs_code.extensions'), 'VC');
  assert.equal(initials('api'), 'AP');
  assert.equal(initials(''), '?');
});

test('icon colour is stable per name and comes from the palette', () => {
  assert.equal(iconColor('claudestrator'), iconColor('claudestrator'));
  assert.match(iconColor('x'), /^#[0-9A-F]{6}$/);
  const svg = iconSvg('GR', '#4D8FE8');
  assert.match(svg, /fill="#4D8FE8"/);
  assert.match(svg, />GR<\/text>/);
});

test('branch of a plain repo, from a subfolder, detached, and no git', async () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  assert.equal(await readBranch(repo), 'feature/x');
  assert.equal(await readBranch(path.join(repo, 'src', 'deep')), 'feature/x');
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), '0123456789abcdef\n');
  assert.equal(await readBranch(repo), '0123456');
  assert.equal(await readBranch(tmp()), undefined);
});

test('worktree: follows the gitdir file and marks the branch', async () => {
  const main = tmp();
  const wtGit = path.join(main, '.git', 'worktrees', 'wt');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/hotfix\n');
  const wt = tmp();
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.equal(await resolveGitDir(wt), wtGit);
  assert.equal(await readBranch(wt), 'hotfix (worktree)');
});

test('tildify only shortens paths inside home', () => {
  assert.equal(tildify('/Users/me/code/app', '/Users/me'), '~/code/app');
  assert.equal(tildify('/Users/meow/app', '/Users/me'), '/Users/meow/app');
  assert.equal(tildify('/opt/app', '/Users/me'), '/opt/app');
});

test('isUnder matches the folder itself and its children, not siblings with the same prefix', () => {
  const dirs = ['/tmp', '/Users/me/.Trash'];
  assert.ok(isUnder('/tmp', dirs));
  assert.ok(isUnder('/tmp/x/y', dirs));
  assert.ok(isUnder('/Users/me/.Trash/old', dirs));
  assert.ok(!isUnder('/tmpfiles/x', dirs));
});

test('previousFirst puts the window you came from first and keeps the rest in order', () => {
  const uris = [uri('file:///a'), uri('file:///b'), uri('file:///c')];
  assert.deepEqual(previousFirst(uris, uri('file:///c')), ['file:///c', 'file:///a', 'file:///b']);
  assert.deepEqual(previousFirst(uris, null), uris);
});

test('parseRegistry keeps only well-formed windows', () => {
  assert.equal(parseRegistry(undefined).size, 0);
  assert.equal(parseRegistry([1, 2]).size, 0);
  const registry = parseRegistry({ w1: { uri: 'file:///a', ts: 5 }, w2: { uri: 1, ts: 5 }, w3: { uri: 'file:///c' }, w4: null });
  assert.deepEqual([...registry], [['w1', { uri: 'file:///a', ts: 5 }]]);
});

test('beat stamps this window, drops stale ones, and removes this window when it has no project', () => {
  const now = 100_000;
  const registry = parseRegistry({ me: { uri: 'file:///old', ts: 0 }, live: { uri: 'file:///b', ts: now - 1000 }, dead: { uri: 'file:///c', ts: now - STALE_MS - 1 } });
  const next = beat(registry, { windowId: win('me'), uri: uri('file:///a'), now });
  assert.deepEqual([...next], [['live', { uri: 'file:///b', ts: now - 1000 }], ['me', { uri: 'file:///a', ts: now }]]);
  assert.deepEqual([...beat(next, { windowId: win('me'), uri: null, now })].map(([id]) => id), ['live']);
});

test('openProjects lists live windows and this one, each project once', () => {
  const now = 100_000;
  const registry = parseRegistry({
    me: { uri: 'file:///a', ts: 0 },
    live: { uri: 'file:///b', ts: now },
    twin: { uri: 'file:///b', ts: now },
    dead: { uri: 'file:///c', ts: 0 },
  });
  assert.deepEqual(openProjects(registry, { windowId: win('me'), own: uri('file:///a'), now }), ['file:///a', 'file:///b']);
  assert.deepEqual(openProjects(new Map(), { windowId: win('me'), own: uri('file:///z'), now }), ['file:///z']);
});

test('focus: a new window moves the current one to previous; the last project is never this window', () => {
  assert.deepEqual(parseFocus('x'), { current: null, previous: null });
  const focus = parseFocus({ current: 'file:///a' });
  assert.deepEqual(focus, { current: 'file:///a', previous: null });
  assert.equal(focused(focus, uri('file:///a')), null);
  const next = focused(focus, uri('file:///b'));
  assert.deepEqual(next, { current: 'file:///b', previous: 'file:///a' });
  assert.equal(lastProject(next ?? focus, uri('file:///b')), 'file:///a');
  assert.equal(lastProject(next ?? focus, uri('file:///a')), null);
  assert.equal(lastProject(next ?? focus, null), 'file:///a');
  assert.equal(lastProject(focus, null), null);
});

test('parseRecent takes folders and workspaces and skips what is not a URI', () => {
  assert.equal(parseRecent(undefined), null);
  assert.deepEqual(parseRecent({}), []);
  const folder = { scheme: 'file', path: '/a' };
  const workspace = { scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/w.code-workspace' };
  const recent = parseRecent({ workspaces: [{ folderUri: folder }, { workspace: { configPath: workspace } }, { folderUri: { path: '/no-scheme' } }, 'x'] });
  assert.deepEqual(recent, [
    { scheme: 'file', authority: '', path: '/a', query: '', fragment: '' },
    { scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/w.code-workspace', query: '', fragment: '' },
  ]);
});
