// The Bash guard against what the shell does to a command before it runs: patterns, tildes, escapes, quoting.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { guardBash } from '../src/core/guard';
import type { GuardContext } from '../src/core/guard';

const policy = { protectedBranches: ['main'], draftPrsOnly: true, forbidAiAttribution: true, allowNoVerify: false, sandbox: true, network: [], writable: [], checkEnv: [] };
/** An agent working in /ws/api, the root of its repository. */
const ctx = (extra: Partial<GuardContext> = {}): GuardContext => ({ policy, cwd: '/ws/api', workspace: '/ws', home: '/home/u', agent: true, task: { taskId: 'T', canPush: false }, writeRoots: ['/ws/api'], branchOf: async () => 'feat/x', isRepoRoot: async (d) => d === '/ws/api', readFile: async () => null, ...extra });
const allowed = async (command: string, c = ctx()): Promise<boolean> => (await guardBash(command, c)).allow;

test('guard: rm -r of a pattern is checked from the folder it starts in, and ~user is not your home', async () => {
  for (const command of ['rm -rf */', 'rm -rf ?*', 'rm -rf [a-z]*', 'rm -rf .[!.]* *', 'rm -rf src/*/../../*', 'rm -rf ~+', 'rm -rf ~u', 'rm -rf ~-/x', 'cd src && rm -rf ../*']) {
    assert.equal(await allowed(command), false, command);
  }
  for (const command of ['rm -rf build/*', 'rm -rf src/*/node_modules', 'rm -rf dist', 'rm -rf /tmp/cs-*', 'rm -rf ~/tmp-not-really']) {
    assert.equal(await allowed(command, ctx({ writeRoots: undefined })), command !== 'rm -rf ~/tmp-not-really', command);
  }
});

test('guard: no way into the keychain or a stored GitHub token', async () => {
  for (const command of [
    'security find-generic-password -s gh:github.com -w',
    'security -q find-generic-password -s gh:github.com -w',
    'echo "find-generic-password -s gh:github.com -w" | security -i',
    '/usr/bin/security dump-keychain',
    'printf "host=github.com\\n" | git-credential-osxkeychain get',
    'printf "protocol=https\\nhost=github.com\\n" | git credential fill',
    'gh auth status --show-token',
    'gh auth token',
    'gh pr view 1 --show-token',
  ]) {
    assert.equal(await allowed(command), false, command);
  }
  assert.equal(await allowed('gh pr view 12 --json title'), true);
});

test('guard: a command is read as the shell runs it, whatever escapes, quotes or wrappers spell it', async () => {
  for (const command of [
    '\\git push -f origin main',
    'g\\it push -f origin main',
    "$'\\x67it' push -f origin main",
    "echo $'\\'' ; git push -f origin main ; echo $'\\''",
    '{git,push,-f,origin,main}',
    'git {push,-f} origin main',
    'rm -rf {build,/}',
    'env -S "git push -f origin main"',
    'env --split-string="git commit -m x"',
    'time -p git push origin main',
    'watch -n 1 "git push origin main"',
    'flock /tmp/l git push origin main',
    'flock /tmp/l -c "git push origin main"',
    'script -q /dev/null git push origin main',
    'script -c "git push origin main" /tmp/out',
    'echo "git push -f origin main" | bash',
    'bash <<EOF\ngit push -f origin main\nEOF',
    'sh -s < cmds.txt',
    '$CMD push',
    '$(which git) push -f',
    'gi? push -f',
    'echo x &> .git/hooks/pre-commit',
    'echo x >| .git/hooks/pre-commit',
    'echo x >& .git/hooks/pre-commit',
    'echo x >&.git/hooks/pre-commit',
  ]) {
    assert.equal(await allowed(command), false, command);
  }
  for (const command of [
    'git status && git diff',
    'echo "a\\"b" > notes.txt',
    'ls 2>&1 | head',
    'npm test 2>&1 |& tee /tmp/log.txt',
    'find . -name "*.ts" -exec grep -l foo {} +',
    'git stash show -p stash@{0}',
    'echo {a,b}.txt',
    '[ -f package.json ] && npm test',
    '"/Users/A B/node_modules/.bin/eslint" src',
    'bash scripts/build.sh',
    'time npm test',
    "jq '.a' package.json",
  ]) {
    assert.equal(await allowed(command), true, command);
  }
  // A path with spaces in its folders is still the command its name says.
  assert.equal(await allowed('"/opt/x y/git" push -f origin main'), false);
});
