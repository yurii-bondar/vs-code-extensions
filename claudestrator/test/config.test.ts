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

/** Lines of `after` that are not in `before`, and lines of `before` that are not in `after`, in order. */
function changedLines(before: string, after: string): { added: string[]; removed: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)) };
}

const API_GATES = [
  { name: 'lint', cmd: 'npm run lint' },
  { name: 'test', cmd: 'npm run test:unit -- --runInBand --reporter=dot --coverage --coverageReporters=text-summary', when: 'src/' },
  { name: 'e2e', cmd: 'npm run test:e2e -- --config jest.e2e.config.js --runInBand --detectOpenHandles --forceExit --silent' },
];

test('config edits: saving a repo changes only its fields that changed; comments in it and flow-style checks stay', async () => {
  const ws = workspace(HANDWRITTEN);
  // What the Repos page sends: the whole repo, its role changed.
  await config.setRepo(ws, 'api', { role: 'Backend', gates: API_GATES });
  assert.equal(projectText(ws), HANDWRITTEN.replace(/role: Public REST API.*tools/, 'role: Backend'));

  // One check's command changed: that check stays where it is, with its comment.
  await config.setRepo(ws, 'api', { role: 'Backend', gates: [{ name: 'lint', cmd: 'npm run lint -- --max-warnings 0' }, ...API_GATES.slice(1)] });
  assert.deepEqual(changedLines(HANDWRITTEN.replace(/role: Public REST API.*tools/, 'role: Backend'), projectText(ws)), {
    added: ['      - { name: lint, cmd: npm run lint -- --max-warnings 0 } # cached'],
    removed: ['      - { name: lint, cmd: npm run lint }   # cached'],
  });

  // A check removed, another added: the ones that stay are untouched, the new one is written like its neighbours.
  const before = projectText(ws);
  await config.setRepo(ws, 'api', { role: 'Backend', gates: [{ name: 'lint', cmd: 'npm run lint -- --max-warnings 0' }, API_GATES[2]!, { name: 'types', cmd: 'npm run typecheck' }] });
  const { added, removed } = changedLines(before, projectText(ws));
  assert.deepEqual(removed, ['      - { name: test, cmd: "npm run test:unit -- --runInBand --reporter=dot --coverage --coverageReporters=text-summary", when: src/ }']);
  assert.deepEqual(added, ['      - { name: types, cmd: npm run typecheck }']);
  assert.match(projectText(ws), /# e2e needs the docker stack/);

  // Renamed: it stays where it was, with the comments in it.
  await config.setRepo(ws, 'backend', { role: 'Backend', path: './api', gates: [{ name: 'lint', cmd: 'npm run lint' }] }, 'api');
  const text = projectText(ws);
  assert.match(text, /repos:\n {2}backend:\n {4}role: Backend\n {4}# e2e needs the docker stack.*\n {4}gates:\n {6}- \{ name: lint, cmd: npm run lint \} # cached\n {4}path: \.\/api\n {2}web:\n/);
  const r = passed(await config.loadConfig({ workspace: ws, home: tmp('cs-home-') }));
  assert.deepEqual(Object.keys(r.config.repos), ['backend', 'web']);
  assert.equal(r.config.repos.backend!.path, './api');
});

const TEAM = `agents:
  developer: { model: sonnet, mcp: true }   # MCP for the Jira reads
  reviewer:
    model: opus     # the strongest one
    effort: high
pipeline: [planner, developer, tester, reviewer]   # tester stays
scenarios:
  hotfix:
    label: Hotfix   # what the menu shows
    agents:
      - developer
      - { agent: reviewer, model: sonnet, effort: low }   # a quick look
context: [./workspace.md]
groups:
  checkout:
    type: epic
    label: Checkout revamp
    jira: CP-123   # the epic in Jira
    defaultInstructions: [no-new-deps]
instructions:
  no-new-deps:
    label: No new dependencies   # short
    text: Do not add packages.
`;

test('config edits: scenarios, groups, instructions, agents and lists keep their comments and layout when saved', async () => {
  const ws = workspace(TEAM);
  const home = tmp('cs-home-');
  const edits: [string, () => Promise<unknown>, string, string][] = [
    ['scenario label', () => config.setCustomScenario(ws, 'hotfix', { label: 'Hot fix', agents: [{ name: 'developer' }, { name: 'reviewer', model: 'sonnet', effort: 'low' }] }), '    label: Hotfix   # what the menu shows', '    label: Hot fix # what the menu shows'],
    ['a step of it', () => config.setCustomScenario(ws, 'hotfix', { label: 'Hot fix', agents: [{ name: 'developer' }, { name: 'reviewer', model: 'opus', effort: 'low' }] }), '      - { agent: reviewer, model: sonnet, effort: low }   # a quick look', '      - { agent: reviewer, model: opus, effort: low } # a quick look'],
    ['group label', () => config.saveGroup({ workspace: ws, home, id: 'checkout', type: 'epic', label: 'Checkout', jira: 'CP-123', defaultInstructions: ['no-new-deps'] }), '    label: Checkout revamp', '    label: Checkout'],
    ['instruction text', () => config.saveInstruction({ workspace: ws, home, id: 'no-new-deps', label: 'No new dependencies', text: 'Do not add npm packages.' }), '    text: Do not add packages.', '    text: Do not add npm packages.'],
    ['agent layer', () => config.setAgentLayer(ws, 'reviewer', { model: 'opus', effort: 'max' }), '    effort: high', '    effort: max'],
    ['agent field', () => config.updateAgentConfig(ws, 'developer', { model: 'opus' }), '  developer: { model: sonnet, mcp: true }   # MCP for the Jira reads', '  developer: { model: opus, mcp: true } # MCP for the Jira reads'],
    ['pipeline', () => config.setPipeline(ws, ['planner', 'developer', 'reviewer', 'tester']), 'pipeline: [planner, developer, tester, reviewer]   # tester stays', 'pipeline: [ planner, developer, reviewer, tester ] # tester stays'],
    ['context', () => config.setProjectValue(ws, ['context'], ['./workspace.md', './api.md']), 'context: [./workspace.md]', 'context: [ ./workspace.md, ./api.md ]'],
  ];
  for (const [what, edit, was, now] of edits) {
    const before = projectText(ws);
    await edit();
    assert.deepEqual(changedLines(before, projectText(ws)), { added: [now], removed: [was] }, what);
  }

  // A scenario renamed keeps its place and comments; an agent layer without a field drops only that field.
  await config.setCustomScenario(ws, 'quick', { label: 'Hot fix', agents: [{ name: 'developer' }, { name: 'reviewer', model: 'opus', effort: 'low' }] }, 'hotfix');
  await config.setAgentLayer(ws, 'reviewer', { model: 'opus' });
  const text = projectText(ws);
  assert.match(text, /scenarios:\n {2}quick:\n {4}label: Hot fix # what the menu shows\n/);
  assert.match(text, / {2}reviewer:\n {4}model: opus {5}# the strongest one\npipeline:/);
  const r = passed(await config.loadConfig({ workspace: ws, home }));
  assert.deepEqual(Object.keys(r.config.custom), ['quick']);
  assert.equal(r.config.agents.reviewer!.effort, 'high', 'back to the built-in effort');
});

/** The warnings a project config with `yaml` gets over a user config with `mine` (none when empty). */
async function loosenedBy(yaml: string, mine = ''): Promise<string[]> {
  const ws = workspace(yaml);
  const home = tmp('cs-home-');
  if (mine) {
    fs.mkdirSync(path.join(home, '.claudestrator'));
    fs.writeFileSync(config.userConfigFile(home), mine);
  }
  const r = passed(await config.loadConfig({ workspace: ws, home }));
  return r.warnings.filter((w) => w.code === 'policy_loosened').map((w) => w.message);
}

test("config: a project's config that lifts the budget cap or raises the rounds and attempts says so", async () => {
  assert.deepEqual(await loosenedBy('limits: { budgetUsd: 0, reviewRounds: 20, gateAttempts: 20 }\n'), [
    "the project's config (.claudestrator/config.yaml) removes the $25 budget cap of a task (limits.budgetUsd: 0): a task spends without a limit",
    "the project's config (.claudestrator/config.yaml) raises the review rounds of a task from 2 to 20 (limits.reviewRounds)",
    "the project's config (.claudestrator/config.yaml) raises the attempts at red checks from 3 to 20 (limits.gateAttempts)",
  ]);
  assert.deepEqual(await loosenedBy('limits: { budgetUsd: 100 }\n', 'limits: { budgetUsd: 40 }\n'), ["the project's config (.claudestrator/config.yaml) raises the budget cap of a task from $40 to $100 (limits.budgetUsd)"], 'measured against your own cap');
  assert.deepEqual(await loosenedBy('limits: { budgetUsd: 10, reviewRounds: 1, gateAttempts: 3 }\n'), [], 'a lower cap and fewer rounds tighten it');
  assert.deepEqual(await loosenedBy('limits: { budgetUsd: 0, reviewRounds: 4 }\n', 'limits: { budgetUsd: 0, reviewRounds: 5 }\n'), [], 'what your config already allows is not news');
});

test("config: a change that is undone puts back only what it wrote, never another window's edit", async () => {
  const home = tmp('cs-home-');
  const mine = 'language: English\n';
  const theirs = 'language: Ukrainian # from the other window\n';
  const ws = workspace(mine);
  const file = config.projectConfigFile(ws);
  const where = { workspace: ws, home };

  // The edit is refused because another window wrote the file under it: that window's text stays.
  await assert.rejects(
    () => config.withConfigRollback(where, () => config.editProjectConfig(ws, (doc) => (fs.writeFileSync(file, theirs), doc.setIn(['baseBranch'], 'develop')))),
    /changed while it was being edited/
  );
  assert.equal(fs.readFileSync(file, 'utf8'), theirs);

  // This change wrote the file, then another window wrote over it before the change failed: the other window's text stays.
  fs.writeFileSync(file, mine);
  await assert.rejects(
    () =>
      config.withConfigRollback(where, async () => {
        await config.setProjectValue(ws, ['language'], 'German');
        fs.writeFileSync(file, theirs);
        throw new Error('boom');
      }),
    /boom/
  );
  assert.equal(fs.readFileSync(file, 'utf8'), theirs);

  // config.yaml written by another window during a change that never touched it stays too.
  fs.writeFileSync(file, mine);
  await assert.rejects(
    () =>
      config.withConfigRollback(where, () => {
        fs.writeFileSync(file, theirs);
        throw new Error('boom');
      }),
    /boom/
  );
  assert.equal(fs.readFileSync(file, 'utf8'), theirs);

  // What the change itself wrote goes back: config.yaml, and a file it named and wrote some other way.
  fs.writeFileSync(file, mine);
  const prompt = path.join(ws, '.claudestrator', 'prompts', 'x.md');
  await assert.rejects(
    () =>
      config.withConfigRollback(where, async (remember) => {
        await remember(prompt);
        fs.mkdirSync(path.dirname(prompt), { recursive: true });
        fs.writeFileSync(prompt, 'x');
        await config.setPipeline(ws, ['planner', 'ghost']);
      }),
    /unknown agent "ghost"/
  );
  assert.equal(fs.readFileSync(file, 'utf8'), mine);
  assert.equal(fs.existsSync(prompt), false);
});

test('scenarios: a deleted report scenario comes back as your own config has it', async () => {
  const home = tmp('cs-home-');
  fs.mkdirSync(path.join(home, '.claudestrator'));
  fs.writeFileSync(
    config.userConfigFile(home),
    "agents:\n  my-verifier: { extends: verifier, instructions: { mode: append, text: 'Check the docs too.' } }\nscenarios:\n  readiness: [verifier, my-verifier]\n"
  );
  const ws = workspace('language: English # mine\n');
  const scenarios = async () => {
    const r = passed(await config.loadConfig({ workspace: ws, home }));
    return { readiness: r.config.scenarios.readiness, removed: r.config.removedScenarios };
  };
  await config.removeScenario(ws, 'readiness');
  assert.deepEqual(await scenarios(), { readiness: [], removed: ['readiness'] });
  await config.restoreScenario(ws, 'readiness', { home });
  assert.deepEqual(await scenarios(), { readiness: ['verifier', 'my-verifier'], removed: [] });
  assert.equal(projectText(ws), 'language: English # mine\n', 'the project config is as it was before the Delete');

  // Removed in your config too: the project brings back the built-in agents.
  fs.writeFileSync(config.userConfigFile(home), 'scenarios:\n  audit: false\n');
  await config.restoreScenario(ws, 'audit', { home });
  assert.deepEqual((await config.readProjectLayer(ws)).scenarios, { audit: ['auditor'] });
  assert.deepEqual(passed(await config.loadConfig({ workspace: ws, home })).config.scenarios.audit, ['auditor']);
});
