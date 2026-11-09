// Live checks against the real forges and trackers (`npm run test:live:forges`; not part of `npm test`: they need your
// logins, and the Linear one costs a few cents). Each runs only when its variables are set, and none creates anything:
// what would write (an MR, a PR) is sent with a branch that is not there, which the forge refuses, so the check sees
// that the call itself (glab's flags, the JSON body, the token's scopes) reaches it and is read.
//   LIVE_GITHUB_ISSUE=cli/cli#1 (or its link)                     gh issue view, under your gh login
//   LIVE_GITLAB_ISSUE=https://gitlab.com/<group>/<project>/-/issues/<n>   glab: the issue, then MRs of its project
//   LIVE_BITBUCKET_REPO=<workspace>/<repo> with BITBUCKET_EMAIL and BITBUCKET_API_TOKEN      Bitbucket Cloud's API
//   LIVE_LINEAR_ISSUE=https://linear.app/<team>/issue/<KEY>   the intake agent (haiku, low) through your Linear MCP server
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { BitbucketClient } from '../../src/core/bitbucket';
import { Engine } from '../../src/core/engine';
import { changeRequests, parseRemote, readIssue } from '../../src/core/forge';
import { exec, setChildEnv } from '../../src/core/git';
import { HookServer } from '../../src/core/hookserver';
import { classifyInput } from '../../src/core/intake';
import * as mcp from '../../src/core/mcp';
import { ClaudeRunner, parseFlags } from '../../src/core/runner';
import type { Source } from '../../src/core/types';

let failed = 0;
const results: string[] = [];

/** Runs one check when `needs` are all set; a failure is counted, and the rest still run. */
async function check(name: string, needs: string[], fn: () => Promise<string>): Promise<void> {
  const missing = needs.filter((v) => !process.env[v]);
  if (missing.length) {
    results.push(`- skip  ${name} (set ${missing.join(', ')})`);
    return;
  }
  try {
    results.push(`- ok    ${name}: ${await fn()}`);
  } catch (e) {
    failed++;
    results.push(`- FAIL  ${name}: ${(e as Error).message}`);
  }
}

function expect(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(what);
}

/** A branch no repo has: a write sent with it is refused without changing anything. */
const NO_BRANCH = `claudestrator-live-probe-${Date.now()}`;

/** A Markdown file for a description, in a folder of its own. */
function bodyFile(): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-live-forge-')), 'body.md');
  fs.writeFileSync(f, 'Claudestrator live check: this request is refused before it is made.');
  return f;
}

/** A source from what the user would paste: a link, or `owner/repo#12` (GitHub's when no repo says otherwise). */
function sourceOf(input: string): Source {
  const c = classifyInput(input);
  if (c.kind === 'issue') {
    expect(c.project, `${input}: name the project (owner/repo#12)`);
    return { kind: 'github', host: 'github.com', repo: c.project, number: c.number };
  }
  return c;
}

async function main(): Promise<void> {
  await check('GitHub issue with gh', ['LIVE_GITHUB_ISSUE'], async () => {
    const src = sourceOf(process.env.LIVE_GITHUB_ISSUE!);
    expect(src.kind === 'github', `${process.env.LIVE_GITHUB_ISSUE} is not a GitHub issue`);
    const issue = await readIssue(src, exec);
    expect(issue.title, 'no title');
    expect(/^https:\/\//.test(issue.url), `no link: ${issue.url}`);
    return `"${issue.title}", ${issue.comments.length} comment(s), labels [${issue.labels.join(', ')}]`;
  });

  await check('GitLab issue and merge requests with glab', ['LIVE_GITLAB_ISSUE'], async () => {
    const src = sourceOf(process.env.LIVE_GITLAB_ISSUE!);
    expect(src.kind === 'gitlab', `${process.env.LIVE_GITLAB_ISSUE} is not a GitLab issue link`);
    const issue = await readIssue(src, exec);
    expect(issue.title, 'no title');
    const remote = parseRemote(`https://${src.host}/${src.project}.git`, 'gitlab');
    const mrs = changeRequests({ remote, dir: os.tmpdir(), run: exec });
    const found = await mrs.search(`#${src.number}`);
    expect(found.ok, `searching MRs: ${found.ok ? '' : found.error}`);
    expect((await mrs.findOpen(NO_BRANCH)) === null, 'an open MR from a branch that is not there');
    const made = await mrs.create({ base: NO_BRANCH, head: NO_BRANCH, title: 'live check', bodyFile: bodyFile(), draft: true });
    expect(!made.ok, `an MR was opened from ${NO_BRANCH}: close it by hand`);
    expect(!/unknown (flag|shorthand)|accepts \d+ arg|usage:/i.test(made.error), `glab did not take the call: ${made.error}`);
    expect(!/not signed in|401/.test(made.error), `no write access: ${made.error}`);
    return `"${issue.title}"; ${found.value.length} MR(s) mention #${src.number}; opening one from a missing branch is refused: ${made.error.slice(0, 160)}`;
  });

  await check('Bitbucket Cloud pull requests over the API', ['LIVE_BITBUCKET_REPO', 'BITBUCKET_EMAIL', 'BITBUCKET_API_TOKEN'], async () => {
    const client = new BitbucketClient({ email: process.env.BITBUCKET_EMAIL!, token: process.env.BITBUCKET_API_TOKEN! });
    const me = await client.myself();
    const prs = changeRequests({ remote: parseRemote(`git@bitbucket.org:${process.env.LIVE_BITBUCKET_REPO}.git`), dir: os.tmpdir(), run: exec, bitbucket: client });
    expect(prs.forge === 'bitbucket', `${process.env.LIVE_BITBUCKET_REPO} is not read as a Bitbucket repo`);
    const found = await prs.search('claudestrator');
    expect(found.ok, `searching PRs (repository and pull request read scopes): ${found.ok ? '' : found.error}`);
    expect((await prs.findOpen(NO_BRANCH)) === null, 'an open PR from a branch that is not there');
    const made = await prs.create({ base: NO_BRANCH, head: NO_BRANCH, title: 'live check', bodyFile: bodyFile(), draft: true });
    expect(!made.ok, `a PR was opened from ${NO_BRANCH}: decline it by hand`);
    expect(!/\b(401|403)\b/.test(made.error), `the token may not write pull requests: ${made.error}`);
    return `signed in as ${me.name}; ${found.value.length} PR(s) mention claudestrator; opening one from a missing branch is refused: ${made.error.slice(0, 160)}`;
  });

  await check('Linear issue through the Linear MCP server', ['LIVE_LINEAR_ISSUE'], async () => {
    const src = sourceOf(process.env.LIVE_LINEAR_ISSUE!);
    expect(src.kind === 'linear', `${process.env.LIVE_LINEAR_ISSUE} is not a Linear issue link`);
    const claude = process.env.CLAUDE_PATH || 'claude';
    const configDir = process.env.CLAUDE_CONFIG_DIR || null;
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-live-linear-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws });
    fs.mkdirSync(path.join(ws, '.claudestrator'));
    fs.writeFileSync(path.join(ws, '.claudestrator', 'config.yaml'), 'repos:\n  app:\n    path: .\npipeline: [planner]\nintake: { model: haiku, effort: low }\nlimits: { budgetUsd: 1 }\n');
    const server = (await mcp.configuredMcpServers(ws, configDir)).find((s) => /linear/i.test(`${s.name} ${s.target || ''}`) && !s.disabled);
    expect(server, 'no Linear MCP server is configured for this account: claude mcp add --transport http linear https://mcp.linear.app/mcp');
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDECODE;
    setChildEnv(env);
    const hooks = new HookServer();
    await hooks.listen();
    const mcpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-live-mcp-')), 'agent-mcp.json');
    const runner = new ClaudeRunner({
      command: () => claude,
      version: () => execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim(),
      flags: () => parseFlags(execFileSync(claude, ['--help'], { encoding: 'utf8' })),
      settingSources: () => ['project', 'local'],
      mcpConfig: () => mcp.writeUserMcpConfig(mcpFile, configDir),
      env: () => (configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    });
    const engine = new Engine({ workspace: ws, runner, hooks, mcpIntake: async (tracker) => (tracker === 'linear' ? { server: server.name, site: undefined } : null), secretFiles: () => [mcpFile] });
    try {
      const { taskId } = await engine.start({ text: process.env.LIVE_LINEAR_ISSUE! });
      const spec = await engine.readTicket(await engine.svc.state(taskId));
      expect(spec.title.startsWith(src.key), `the title does not start with ${src.key}: ${spec.title}`);
      const blocked = (await engine.svc.readTranscript(taskId, '0000-intake')).filter((i) => i.type === 'blocked');
      return `"${spec.title}", ${spec.acceptanceCriteria.length} criteria, read through "${server.name}"${blocked.length ? `; blocked: ${blocked.map((i) => String(i.tool)).join(', ')}` : ''}`;
    } finally {
      hooks.dispose();
    }
  });

  console.log(results.join('\n'));
  if (failed) {
    console.error(`${failed} live check(s) failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
