import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ago, short, size } from '../src/format';
import { defaultLabel, expand, keychainService, readProfile } from '../src/configdir';
import { parseClientMessage } from '../src/messages';
import { DEFAULT_CONFIG } from '../statusline/render';

test('ago counts from the given time', () => {
  const now = 1_000_000_000_000;
  assert.equal(ago(now - 5_000, now), 'just now');
  assert.equal(ago(now - 5 * 60_000, now), '5m ago');
  assert.equal(ago(now - 3 * 3600_000, now), '3h ago');
  assert.equal(ago(now - 2 * 86400_000, now), '2d ago');
});

test('size and short format for the tree', () => {
  assert.equal(size(100), '1 KB');
  assert.equal(size(3 * 1024 * 1024), '3.0 MB');
  assert.equal(short('abcdef', 4), 'abc…');
  assert.equal(short('abc', 4), 'abc');
});

test('the Keychain item name follows the folder', () => {
  assert.match(keychainService('/a/.claude-x'), /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.notEqual(keychainService('/a/.claude-x'), keychainService('/a/.claude-y'));
});

test('labels drop the .claude- prefix, and ~ expands', () => {
  assert.equal(defaultLabel('/h/.claude-work'), 'work');
  assert.equal(expand('~/x'), path.join(os.homedir(), 'x'));
});

test('readProfile reads the cached login and tolerates a missing or odd file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-man-profile-'));
  try {
    assert.deepEqual(readProfile(dir), { email: '', org: '' });
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', organizationName: 'Org' } }));
    assert.deepEqual(readProfile(dir), { email: 'a@b.c', org: 'Org' });
    fs.writeFileSync(path.join(dir, '.claude.json'), '[1]');
    assert.deepEqual(readProfile(dir), { email: '', org: '' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseClientMessage takes the editor messages and rejects the rest', () => {
  assert.deepEqual(parseClientMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseClientMessage({ type: 'apply', dirs: ['/a', 3] }), { type: 'apply', dirs: ['/a'] });
  assert.deepEqual(parseClientMessage({ type: 'previewAccount', dir: '/a' }), { type: 'previewAccount', dir: '/a' });
  for (const bad of [null, 'x', {}, { type: 'nope' }, { type: 'previewAccount' }, { type: 'update', config: 5 }]) assert.equal(parseClientMessage(bad), null);
});

test('an update from the page is normalized before it is saved', () => {
  const message = parseClientMessage({ type: 'update', config: { separator: 7, segments: [{ id: 'model', color: 'red' }] } });
  assert.equal(message?.type, 'update');
  if (message?.type === 'update') {
    assert.equal(message.config.separator, DEFAULT_CONFIG.separator);
    assert.equal(message.config.segments[0]?.color, 'red');
  }
});
