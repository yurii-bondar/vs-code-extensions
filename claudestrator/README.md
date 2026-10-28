# Claudestrator

A standalone agent pipeline for Claude Code, driven from VS Code. You describe a task (or paste a Jira key, a Jira link or a Confluence page), and a pipeline of Claude Code agents takes it to draft PRs:

```
ticket → planner → [you approve the plan] → per repo: developer (checks after each) → tester across all repos (checks in each)
       → reviewer (fresh context, whole diff) → fix rounds → commit → [you confirm the push] → draft PRs
```

Besides delivering a change, two read-only scenarios end with a report instead of PRs:

- **Check readiness**: "PROJ-123 перевір готовність виконання таски і закриття всіх критеріїв приймання". The `verifier` reads the issue, finds its branches, commits and PRs in every repo, and judges each acceptance criterion (met, partial, not met, check by hand) with file:line evidence, plus gaps that block a release. The verdict (ready, not ready, needs a human check) follows from the statuses.
- **Audit**: "Аудит проекту: вузькі місця, перформанс, помилки". The `auditor` looks for bugs, performance bottlenecks, reliability and security issues and rates each one critical, high, medium or low.

The orchestration is code, not a prompt: a pure state machine decides what runs next and rejects anything out of order (no skipped approval, no extra review round, no push before you confirm). Each agent is a `claude -p` session of your installed Claude Code CLI, under your login and account.

## Using it

- **New task**: the activity-bar icon, `⌘⌥N`, or *Start a Task from Selection* in an editor. Type what you want in plain words. Below the box you see what it was recognised as (free text, Jira issue, Confluence page), the task id, and the exact pipeline it will run. Click an agent chip to skip it for this task, or turn on *Skip plan approval*. The effort part of a chip (`medium ▾`) changes that agent's effort for this task only; *Effort: … ▾* sets it for every agent. In the text, `--effort high` or `--effort developer=max,tester=low` does the same. The choice is saved with the task and wins over the agents' settings.
- **Scenario**: *Deliver*, *Check readiness* or *Audit* at the top of the composer. Your words pick it (`готовність`, `acceptance criteria`, `критерії приймання` → readiness; `аудит`, `audit`, `вузькі місця` → audit) unless you click one; `--scenario readiness|audit` in the text does the same. A readiness check takes the one Jira issue a sentence names as its source and keeps the rest of the sentence in the ticket as what you asked. Report tasks get their own ids (`PROJ-123-check`, `AUDIT-<time>`), so they never continue the delivery task; checking again after a finished check is a new run (`PROJ-123-check-2`). Commands: *Check a Task's Readiness…*, *Audit the Project…*.
- **Your own scenarios**: *New scenario* at the bottom of the scenario menu. Give it a name and a description, add agents, drag them into order, and pick a model and an effort per agent for this scenario only (empty means the agent's own setting; the composer can still change effort per task). Agents that change code make it end with draft PRs like Deliver; readiness or audit agents make it a read-only report. One scenario cannot mix the two. 🗑 next to a scenario deletes it. Check readiness and Audit can be deleted too and brought back from the same menu; Deliver always stays. `--scenario <name>` in the text picks one. A task started from your scenario shows its name and the models it runs with.
- **Tasks view** (sidebar) groups tasks into *Needs you*, *Running*, *Paused* and *Finished*. The badge and the status bar count what needs you. Notifications tell you when a task needs a decision, finishes or fails.
- **Task screen**:
  - **Decisions** appear at the top, with everything needed to decide: the rendered plan with its open questions and branch, the red check output, the reviewer's findings, or per-repo commits with the combined diff before a push. Options that take feedback (request changes, retry with a hint) have a text box. `⌘↵` picks the primary option.
  - **Step timeline**: every agent run per repo and round, with check results, verdicts and cost. Click a step to see its transcript.
  - **Agent output** streams live: text as it is written, every tool call (reads, edits as diffs, commands with output), what the guard blocked, check runs. While an agent works you can **message it** ("reuse formatDate from utils/date.ts"). *Continue in terminal* opens `claude --resume <session>` for any finished step.
  - **Report** (readiness and audit): the verdict with every criterion and its evidence, or the findings with a filter per severity. *Open report* opens `report.md`; *Post to Jira* comments the result on the issue; *Start a task to close the gaps* / *Start a task to fix it* opens a delivery task prefilled with what was found.
  - **Activity** (the event log), **Files** (ticket, plan, reports, reviews, check logs) and **Ticket & plan**.
  - **Stop / Resume**: stopping kills the agent; resuming re-runs the same step. Tasks survive VS Code restarts.
- **Status line, as in Claude Code**:
  - every step shows its model, effort, context used (`ctx ▰▱ 53%`), tokens, cost and turns, live while the agent works;
  - the header and the status bar show the account's 5-hour and weekly limits with time to reset. They come from what Claude Code reports to the agents, or, before any agent ran, from your status line's snapshots in `<account>/statusline/` (ctx-man writes them).
- **Agents**: reorder the pipeline by dragging, turn agents on or off, pick a model and an **effort** (`low` … `max`, passed as `claude --effort`), open an agent's instructions as a Markdown file, or edit its tools and description. *New agent* creates one that extends an existing agent (e.g. a security reviewer on top of `reviewer`) and opens its instructions file.
- **Repos & checks**: the repos agents may change and their checks (lint, typecheck, tests) with an optional *only if changed* prefix. *Run checks now* tries them on the current changes. *Add repository…* picks folders anywhere on disk: a repo, several, or a folder that holds repos (they are found inside it). Repos outside the workspace are saved with their absolute path. Repos found in the workspace can be added in one click, with checks suggested from `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml` or a `Makefile`. The workspace map (`.claudestrator/workspace.md`) is what every agent reads first.
- **MCP**: every MCP server Claude Code has for the agents' account and this workspace, coloured by state: green connected, yellow configured but not checked (or disabled, or waiting for approval), red an error or an expired/missing sign-in. *Sign in* runs `claude mcp login` and opens the provider's page in the browser, then the list is checked again. *Details* shows `claude mcp get` with header and env values masked. The *MCP* tab and the dashboard show a red count when something needs attention.
- **Settings**: language of plans, reports and PR texts (the developer, tester and reviewer write to each other in English to save tokens); base branch; git mode; limits (review rounds, check attempts, budget per task); safety policy; the Claude Code CLI, account and setting sources; the Jira/Confluence connection; notifications.

First time in a workspace, *Set up this workspace* finds the git repos and suggests checks for them. It also lets you choose the git mode and the language, and can create the workspace map.

## How it works

- **Routing by output, never by name.** An agent's `output` decides its role. `plan` waits for your approval. `code` runs once per repo of the plan, in plan order, with the repo's checks after it. `tests` runs once after that, across every repo the plan names (one tester sees all the changes and the contracts between them), then the checks of each of those repos. An agent's `runs: per-repo | all-repos` switches this for a code or tests agent (Agents screen, or *per repo ⇄ all repos* on its chip in the composer's scenario editor). Tasks started before keep the tester per repo. `verdict` sends blocking findings (blocker, major) back to the code/tests stages of only the affected repos, up to `limits.reviewRounds`. Minor findings go into the PR description.
- **Checks.** After a code or tests step the repo's checks run on its changes. Red output goes back into the same agent session, up to `limits.gateAttempts` times; then you decide.
- **Reports.** Plan and verdict stages end with a JSON block. It is validated, and an unreadable report is sent back to the agent for correction (twice) before the step fails.
- **Git.**
  - In *branch* mode the repos switch to `<type>/<KEY>-<slug>` and must be clean first. In *worktree* mode each task gets `.orch/worktrees/<task>/<repo>` from `origin/<base>`, and your checkouts are never touched.
  - The engine makes one commit per repo. It pushes and opens draft PRs with `gh` only after you confirm, and the PRs link to each other.
- **Guard.** Every agent runs with a `PreToolUse` hook that asks the extension over a local socket. It always blocks:
  - git writes by agents (commit, push, switch, stash, reset…) and non-read `gh` calls;
  - force-push, pushes to protected branches, `--no-verify`, merging PRs, non-draft PRs, AI attribution (if the policy says so) and destructive `rm -r`;
  - edits outside the repo of the current step (read-only stages edit nothing).

  With *Ask me* on, you also approve every edit and command from the dashboard or a notification. The hook fails closed: if VS Code is gone, the tool call is denied.
- **Jira comments** (*Approve & post to Jira*, *Push, open PRs & comment in Jira*, *Post to Jira*) go over REST with an API token, else through the account's Atlassian MCP server: a short haiku session whose guard allows only the read tools and one add-comment call. Each attempt is in the activity log and the *Jira comments* card; a failed one shows a banner with *Post again*.
- **Jira and Confluence.** With an API token (Settings) tickets are read over REST. Without one, a short read-only agent (haiku, low effort, a few cents) reads the issue or page through the account's Atlassian MCP server, signed in with Claude Code; its tool calls are limited to get/search/fetch.
- **Account.** Agents, MCP checks and limits use one Claude Code account (config folder), chosen in the header or followed from ctx-man. `claude auth status` shows which accounts are signed in; a signed-out one gets a banner with *Sign in* (`claude auth login` in a terminal). Agents run without the `user` setting source, so the account's own MCP servers are handed to them with `--mcp-config` (a 0600 file), without your personal plugins and hooks.
- **State.** `<workspace>/.orch/tasks/<id>/events.ndjson` is the source of truth, and the state is rebuilt from it. Artifacts and transcripts sit next to it. `.orch/` ignores itself in git. The layout and the config format are those of the claudestrator CLI and plugin, so they can work on the same tasks.

## Spending fewer tokens

What the built-in agents do by default, and what to change per task.

- **Model and effort.** planner and reviewer run on Opus at high effort; developer and tester on Sonnet at medium. Change them per agent on the Agents page, per scenario, or per task with the effort chips.
- **MCP.** developer, tester and reviewer run with `mcp: false`: they see no MCP servers, so no server's tool list rides along in every turn. The planner, verifier and auditor keep them. The Agents page has the switch under *More*; in `config.yaml` it is `mcp: true` or `mcp: false`.
- **Gates do the checking.** developer and tester are told not to run the full lint, typecheck or test suite; the gates run it after the stage and send back only the tail of a failing command (40 lines, without colour codes or redrawn progress lines). Make gate commands quiet so that tail holds the failure and not the progress: `--silent`, `-q`, a `dot` reporter.
- **Run less.** For a small task, click agents off (no tester for a text fix), turn on *Skip plan approval*, or keep a scenario like the `hotfix` below (developer and a short review).
- **Caps.** `limits.reviewRounds`, `limits.gateAttempts` and `limits.budgetUsd` stop a loop that is not converging.
- **See the cost.** Every step shows its tokens, context used and cost; compare two runs of a task after changing a model or an effort.

## Configuration

Layers, each overriding the previous field by field: built-in defaults → libraries → `~/.claudestrator/config.yaml` → `<workspace>/.claudestrator/config.yaml`. The dashboard edits the workspace file in place and keeps your comments.

### Libraries

Agents and scenarios you want in more than one project, or kept apart from a project's config, live in a folder of their own:

```
my-claudestrator-library/
  library.yaml          # agents: and scenarios:, written as in config.yaml
  prompts/
    security.md         # instruction files, relative to library.yaml
```

List it under `libraries:` in `~/.claudestrator/config.yaml` (all your projects) or in a project's config (for the team; a folder inside the project is listed by a relative path, so it works in every clone):

```yaml
libraries: [~/my-claudestrator-library, ../shared-agents]
```

- A project can change a library's agent (its model, say) in its own config; the library stays as it is.
- An agent only a library has is not in the delivery pipeline until you add it; scenarios use it right away.
- `{{dir}}` in instructions becomes the folder of the config that names them: in a library, the folder of `library.yaml`. Instructions point the agent at the library's own files with it (`sqlite3 "$DB" < "{{dir}}/sql/schema.sql"`), wherever the library is kept.
- A library that is missing on this machine is a warning, not an error. Two libraries defining the same agent: the later one wins, and the dashboard says so.
- On the Agents page: *Add library…* (an empty folder becomes a new library), *Move to …* on an agent or a scenario of the project's own (it goes with its instructions file, and a scenario takes the project agents it runs), *Stop using*.

```yaml
agents:
  tester: { enabled: false }
  planner: { effort: max }
  developer: { mcp: true }       # built in: developer, tester and reviewer run without MCP servers
  reviewer:
    model: opus
    effort: high
    instructions: { mode: append, file: ./prompts/reviewer-extra.md }
  security:
    extends: reviewer
    instructions: { mode: append, file: ./prompts/security.md }
pipeline: [planner, developer, tester, reviewer, security]
scenarios:                      # read-only agents of the report scenarios (built in: verifier, auditor)
  readiness: [verifier]
  audit: [auditor, perf-auditor] # e.g. perf-auditor: { extends: auditor, instructions: { mode: append, file: ./prompts/perf.md } }
  # readiness: false             # removes a built-in report scenario from the menu
  hotfix:                        # your own scenario: its agents in order, each with an optional model and effort
    label: Hotfix
    description: Code and a quick review, no plan
    agents:
      - developer
      - { agent: reviewer, model: sonnet, effort: low }
limits: { reviewRounds: 2, gateAttempts: 3, budgetUsd: 20 }
language: Ukrainian
baseBranch: main
context: [./workspace.md]
git: { mode: worktree }
repos:
  api:
    role: Public REST API (NestJS)
    gates:
      - { name: lint, cmd: npm run lint }
      - { name: test, cmd: npm run test:unit, when: src/ }
jira: { allowedProjects: [PROJ] }
policy:
  protectedBranches: [main, master]
  draftPrsOnly: true
  forbidAiAttribution: true
```

VS Code settings (`claudestrator.*`):

| Setting | What it does |
|---|---|
| `claudePath` | Path to the Claude Code CLI. Empty: found on your login shell's `PATH`. |
| `claudeConfigDir` | Claude Code account (config folder) the agents run under. |
| `settingSources` | Which Claude Code settings agents load. Default `project, local`: each repo's `CLAUDE.md` and rules, without your personal plugins. |
| `askPermissions` | Ask before every edit and command. |
| `notifications` | `all`, `needsYou` or `off`. |
| `workspaceFolder` | Folder with the repos and `.claudestrator/`. Empty: the first workspace folder. |
| `atlassian.site`, `atlassian.email` | Jira/Confluence connection. The API token goes in secret storage (Settings screen). `ATLASSIAN_SITE`, `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` work too. |

## Requirements

- Claude Code CLI, logged in (`claude --version`).
- Git. GitHub CLI (`gh auth login`) only to open PRs.
- Node.js on `PATH` for the guard hook (otherwise VS Code's own runtime is used).

## Develop

```bash
npm install
npm test          # state machine, config, guard, intake, and the engine end to end against a fake Claude CLI and real git repos
npm run preview   # the dashboard in a browser at http://127.0.0.1:4780, on the real engine with a fake agent
```

Press F5 in VS Code to run the extension. To package, run `npx @vscode/vsce package` and install the `.vsix`.
