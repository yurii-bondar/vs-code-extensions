const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initials, iconColor, iconSvg, resolveGitDir, readBranch, tildify, isUnder, previousFirst } = require('../lib');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtp-')));

test('initials: two words, camelCase, one word, empty', () => {
  assert.strictEqual(initials('shop-admin-panel'), 'SA');
  assert.strictEqual(initials('myProject'), 'MP');
  assert.strictEqual(initials('vs_code.extensions'), 'VC');
  assert.strictEqual(initials('api'), 'AP');
  assert.strictEqual(initials(''), '?');
});

test('icon colour is stable per name and comes from the palette', () => {
  assert.strictEqual(iconColor('claudestrator'), iconColor('claudestrator'));
  assert.match(iconColor('x'), /^#[0-9A-F]{6}$/);
  const svg = iconSvg('GR', '#4D8FE8');
  assert.match(svg, /fill="#4D8FE8"/);
  assert.match(svg, />GR<\/text>/);
});

test('branch of a plain repo, from a subfolder, detached, and no git', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  assert.strictEqual(readBranch(repo), 'feature/x');
  assert.strictEqual(readBranch(path.join(repo, 'src', 'deep')), 'feature/x');
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), '0123456789abcdef\n');
  assert.strictEqual(readBranch(repo), '0123456');
  assert.strictEqual(readBranch(tmp()), undefined);
});

test('worktree: follows the gitdir file and marks the branch', () => {
  const main = tmp();
  const wtGit = path.join(main, '.git', 'worktrees', 'wt');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/hotfix\n');
  const wt = tmp();
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.strictEqual(resolveGitDir(wt), wtGit);
  assert.strictEqual(readBranch(wt), 'hotfix (worktree)');
});

test('tildify only shortens paths inside home', () => {
  assert.strictEqual(tildify('/Users/me/code/app', '/Users/me'), '~/code/app');
  assert.strictEqual(tildify('/Users/meow/app', '/Users/me'), '/Users/meow/app');
  assert.strictEqual(tildify('/opt/app', '/Users/me'), '/opt/app');
});

test('isUnder matches the folder itself and its children, not siblings with the same prefix', () => {
  const dirs = ['/tmp', '/Users/me/.Trash'];
  assert.ok(isUnder('/tmp', dirs));
  assert.ok(isUnder('/tmp/x/y', dirs));
  assert.ok(isUnder('/Users/me/.Trash/old', dirs));
  assert.ok(!isUnder('/tmpfiles/x', dirs));
});

test('previousFirst puts the window you came from first and keeps the rest in order', () => {
  const uris = ['file:///a', 'file:///b', 'file:///c'];
  assert.deepStrictEqual(previousFirst(uris, 'file:///c'), ['file:///c', 'file:///a', 'file:///b']);
  assert.deepStrictEqual(previousFirst(uris, undefined), uris);
});
