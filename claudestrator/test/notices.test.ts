// What VS Code's notifications show of text from agents, tickets and tools: words, never a link to click.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { plainNotice } from '../src/core/view';

/** How VS Code finds the links of a notification's message (`parseLinkedText` in vs/base/common/linkedText.ts). */
const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

test('notices: a link in an agent\'s or a tool\'s text stays text', () => {
  for (const text of [
    'T-1: gh failed: [Fix it](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22rm%20-rf%20~%5Cn%22%7D)',
    'push rejected by hook: [details](https://evil.example/x "Open")',
    '[see](file:///etc/passwd) and [a](command:x) twice: [b](command:y)',
    'nested [[a](command:x)](https://y)',
  ]) {
    const shown = plainNotice(text);
    assert.deepEqual([...shown.matchAll(LINK)], [], shown);
  }
  assert.equal(plainNotice('[Fix it](command:x)'), '[Fix it] (command\u200b:x)', 'the words stay readable');
  assert.equal(plainNotice('vscode://ext.id/do and COMMAND:x'), 'vscode\u200b://ext.id/do and COMMAND\u200b:x');
  assert.equal(plainNotice('T-1: draft PRs are open.'), 'T-1: draft PRs are open.', 'plain text is left as it is');
});
