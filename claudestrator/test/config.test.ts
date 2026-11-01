// Config layers and the dashboard's edits of config.yaml: what an edit writes, what the layers warn about.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as config from '../src/core/config';

const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** A workspace whose .claudestrator/config.yaml holds `yaml`. */
function workspace(yaml: string): string {
  const ws = tmp('cs-cfg-');
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(config.projectConfigFile(ws), yaml);
  return ws;
}

const projectText = (ws: string): string => fs.readFileSync(config.projectConfigFile(ws), 'utf8');

/** Narrows a `{ ok }` result to its success variant; the test fails, printing the result, if it is not one. */
function passed<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.ok(r.ok, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** A config written by hand: long lines, flow maps and lists in both spacings, comments, an unindented list, folded text. */
const HANDWRITTEN = `# Team config: edit it here or in the dashboard.
language: English   # the reports
limits: { reviewRounds: 2, gateAttempts: 3 }
pipeline: [planner, developer, tester, reviewer]
scenarios:
  readiness: [ verifier ]
repos:
  api:
    role: Public REST API (NestJS) that serves the mobile apps, the partner integrations and the internal back office tools
    # e2e needs the docker stack: run \`docker compose up -d\` in ../infra first, or the test gate fails on a timeout
    gates:
      - { name: lint, cmd: npm run lint }   # cached
      - { name: test, cmd: "npm run test:unit -- --runInBand --reporter=dot --coverage --coverageReporters=text-summary", when: src/ }
      - name: e2e
        cmd: 'npm run test:e2e -- --config jest.e2e.config.js --runInBand --detectOpenHandles --forceExit --silent'
  web:
    path: ./web
    baseBranch: develop

policy:
  protectedBranches:
  - main
  - master
  draftPrsOnly: true
instructions:
  no-new-deps:
    label: No new dependencies
    text: >
      Do not add packages;
      use what the repo already has.
`;

test('config edits: a hand-written file keeps every line the edit did not change, long lines and flow maps too', async () => {
  const ws = workspace(HANDWRITTEN);
  await config.setProjectValue(ws, ['limits', 'reviewRounds'], 5);
  const edited = HANDWRITTEN.replace('reviewRounds: 2', 'reviewRounds: 5');
  assert.equal(projectText(ws), edited);

  // A key added after folded text and after an unindented list: only the new line is new.
  await config.setProjectValue(ws, ['baseBranch'], 'develop');
  await config.setProjectValue(ws, ['policy', 'allowNoVerify'], false);
  assert.equal(projectText(ws), `${edited.replace('  draftPrsOnly: true\n', '  draftPrsOnly: true\n  allowNoVerify: false\n')}baseBranch: develop\n`);

  // An edit that changes nothing writes nothing.
  const before = fs.statSync(config.projectConfigFile(ws)).mtimeMs;
  await config.setProjectValue(ws, ['limits', 'reviewRounds'], 5);
  assert.equal(fs.statSync(config.projectConfigFile(ws)).mtimeMs, before);
});

test('config edits: a long value the dashboard writes stays on one line, and Windows line ends stay', async () => {
  const role = 'Public REST API (NestJS) that serves the mobile apps, the partner integrations and the internal back office tools';
  const cmd = 'npm run test:unit -- --runInBand --reporter=dot --coverage --coverageReporters=text-summary';
  const ws = workspace('repos:\r\n  api: { path: ./api }   # the backend\r\n');
  await config.setProjectValue(ws, ['repos', 'api', 'role'], role);
  await config.setProjectValue(ws, ['repos', 'web'], { gates: [{ name: 'test', cmd }] });
  const text = projectText(ws);
  assert.match(text, /^repos:\r\n {2}api: \{ path: \.\/api, role: "Public REST API .* tools" \} # the backend\r\n/);
  assert.ok(text.split('\r\n').some((line) => line.includes(cmd)), text);
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'every line ends in \\r\\n');

  // A new config from the setup wizard is written with long lines whole too.
  const fresh = tmp('cs-cfg-');
  await config.createProjectConfig(fresh, { repos: { api: { role, gates: [{ name: 'test', cmd }] } } });
  assert.ok(projectText(fresh).split('\n').some((line) => line.endsWith(`role: ${role}`)), projectText(fresh));
  assert.ok(projectText(fresh).split('\n').some((line) => line.endsWith(`cmd: ${cmd}`)), projectText(fresh));
});

test('config edits: what the edit means is what is written, even where the file was laid out differently', async () => {
  // Four-space indentation throughout: the edited block is written the library's way, the rest as it was.
  const ws = workspace('limits:\n    reviewRounds: 2\n    gateAttempts: 3\nrepos:\n    api:\n        role: Backend   # mine\n');
  await config.setProjectValue(ws, ['limits', 'gateAttempts'], 4);
  const r = passed(await config.loadConfig({ workspace: ws, home: tmp('cs-home-') }));
  assert.equal(r.config.limits.gateAttempts, 4);
  assert.equal(r.config.limits.reviewRounds, 2);
  assert.equal(r.config.repos.api!.role, 'Backend');
  assert.match(projectText(ws), /\n {4}api:\n {8}role: Backend {3}# mine\n$/, 'the block the edit did not touch is as it was');
});
