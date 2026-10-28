import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hueOf, initials } from '../src/format';
import { parseSidebarMessage } from '../src/sidebarMessages';

test('initials come from the first letters of the first two words', () => {
  assert.equal(initials('private-b'), 'PB');
  assert.equal(initials('work'), 'WO');
  assert.equal(initials('my cool account'), 'MC');
  assert.equal(initials('Робота'), 'РО');
  assert.equal(initials('---'), '?');
});

test('a folder always gets the same color, within the palette', () => {
  assert.equal(hueOf('/Users/a/.claude-b', 8), hueOf('/Users/a/.claude-b', 8));
  for (const dir of ['/a', '/b', '/c/.claude-work', '']) assert.ok(hueOf(dir, 8) >= 0 && hueOf(dir, 8) < 8);
});

test('parseSidebarMessage takes the page messages and rejects the rest', () => {
  assert.deepEqual(parseSidebarMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseSidebarMessage({ type: 'account', action: 'use', dir: '/x' }), { type: 'account', action: 'use', dir: '/x' });
  assert.deepEqual(parseSidebarMessage({ type: 'session', action: 'resume', key: 'k' }), { type: 'session', action: 'resume', key: 'k' });
  assert.deepEqual(parseSidebarMessage({ type: 'scope', all: true }), { type: 'scope', all: true });
  assert.deepEqual(parseSidebarMessage({ type: 'tool', tool: 'aiFiles' }), { type: 'tool', tool: 'aiFiles' });
  assert.deepEqual(parseSidebarMessage({ type: 'tool', tool: 'showHidden' }), { type: 'tool', tool: 'showHidden' });
  for (const bad of [null, 'x', {}, { type: 'account', action: 'delete', dir: '/x' }, { type: 'account', action: 'use' }, { type: 'session', action: 'resume', key: 1 }, { type: 'scope', all: 'yes' }, { type: 'tool', tool: 'rm' }]) {
    assert.equal(parseSidebarMessage(bad), null, JSON.stringify(bad));
  }
});
