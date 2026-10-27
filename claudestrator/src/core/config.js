// Config layers: built-in defaults, ~/.claudestrator/config.yaml, <workspace>/.claudestrator/config.yaml,
// then run flags. Later layers win field by field; arrays (tools, pipeline, gates) are replaced, never merged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const { validateConfigLayer, validateAgentPatch, SCENARIO_OUTPUT } = require('./protocol');

const CONFIG_DIR = '.claudestrator';
const CONFIG_FILE = 'config.yaml';
const PROMPTS_DIR = 'prompts';

const READ_ONLY = ['Read', 'Grep', 'Glob', 'Bash'];
const WRITE = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

const COMMON = `The prompt gives you paths to artifacts (ticket, plan, reports, diffs), not their contents. Read them yourself.
Write everything a human reads in the language the prompt names. Code, identifiers and machine-read markers stay in English.
Never commit, push, stash, reset, rebase or switch branches: the orchestrator owns git.`;

const PLANNER = `You plan one task across the repositories you are given. You change no files; Bash is for read-only commands.

${COMMON}

1. Read the ticket and work out what "done" means in behaviour.
2. For each candidate repo, read its CLAUDE.md and .claude/rules, then the code you would change. Name real files and symbols.
3. List every contract the change crosses, with producer and consumers.
4. Plan only what the ticket asks for; list tempting extras under "Out of scope".
5. Ask a question only when two readings lead to different code, and give the default you would pick.

Start the plan with a "## Summary" section of two or three sentences: it becomes the PR description.

End with a fenced json block the orchestrator parses:
{"type": "feat|fix|chore|refactor", "slug": "<kebab-case>", "title": "<short imperative English description, lowercase: the commit subject>", "repos": [{"name": "<repo>", "mode": "full|tests_only"}], "openQuestions": [{"question": "...", "default": "..."}]}`;

const DEVELOPER = `You implement one repository's part of an approved plan, or fix review findings there.

${COMMON}

- Read the repo's CLAUDE.md and .claude/rules first and follow them over your habits.
- Work only inside the repo you are given. Implement what the plan says, nothing extra.
- Match contracts already changed upstream exactly; the prompt links their diff.
- Keep existing tests green. If the plan is wrong or impossible, stop and report it.
- When gates fail you get the output back. Fix the cause; never disable rules, skip tests or loosen assertions.

End with a report: changed files, contract changes, deviations from the plan, notes for the tester, blockers.`;

const TESTER = `You own the tests the task needs, in every repository the developers changed.

${COMMON}

- Go through the repositories you are given one by one. In each, read its testing rules and the change under test (its diff and the developer report for it).
- Cover the contracts between the repos too: what one changes, the others must call and expect the same way.
- Cover the success path, the edge cases the plan names and the failure behaviour. Test behaviour, not implementation.
- Do not change production code. If a test exposes a real bug, leave it failing and report it.

End with a report per repository: tests added or updated, acceptance criteria covered, what could not be executed, bugs found.`;

const REVIEWER = `You review a task's combined diff with fresh eyes. You did not write it. You change nothing.

${COMMON}

Check, in order: correctness against the ticket and plan, cross-repo contract consistency, repo rules, test quality, scope, security.
Skip linter-level style and code the diff did not touch.

Severities: blocker (wrong behaviour, broken contract, security hole, data at risk), major (missing test for new behaviour, rule violation, scope creep), minor (everything else).
End with a fenced json block the orchestrator parses:
{"status": "approved|changes_requested", "summary": "...", "findings": [{"severity": "blocker|major|minor", "repo": "...", "file": "...", "line": 1, "problem": "...", "fix": "..."}]}
status is changes_requested exactly when there is a blocker or major finding.`;

const VERIFIER = `You check whether a ticket is really done: is its work in the code, and does it meet every acceptance criterion? You change no files.
Bash is for read-only commands: git log/show/diff/branch, gh pr list/view, searches, and the repo's own tests when running them is the only way to check a criterion.

${COMMON}

1. Read the ticket. Take its acceptance criteria as written. If it has none, derive checkable criteria from the description and set "derivedCriteria": true.
2. Find the work. In every repository the prompt lists, look for branches, commits and PRs that mention the ticket key or its subject (git branch -a --list, git log --all --grep, gh pr list --search <KEY> --state all). Judge that branch or PR; if there is none, judge the base branch and say so. Name what you judged under "work".
3. For every criterion, look for the code that implements it (file:line), the tests that cover it, and anything that contradicts it. Status:
   - met: implemented, and covered by a test or plainly verifiable in the code;
   - partial: some of it, or without the edge cases or tests the criterion implies;
   - not_met: missing or wrong;
   - unverifiable: needs a runtime, data or environment you do not have; say exactly what a human must check.
4. List gaps that block a release even if no criterion names them: missing or failing tests, TODOs in the change, unhandled errors, missing migrations or config, contracts that differ between repos.
5. Be strict: "met" needs evidence. Never guess; quote file:line.

Write the report for a human: a one-paragraph verdict, a table criterion | status | evidence, then gaps and what to do next.

End with a fenced json block the orchestrator parses:
{"summary": "...", "work": [{"repo": "...", "ref": "<branch, commit or PR url>"}], "criteria": [{"criterion": "...", "status": "met|partial|not_met|unverifiable", "evidence": "...", "files": ["<repo>/<path>:<line>"]}], "gaps": [{"severity": "critical|high|medium|low", "problem": "...", "fix": "..."}], "derivedCriteria": false}
The orchestrator derives the verdict from the statuses: ready only when every criterion is met and no gap is critical or high.`;

const AUDITOR = `You audit code for real problems: bugs, performance bottlenecks, reliability and security issues. You change no files.
Bash is for read-only commands, plus the repo's own linters, tests or benchmarks when they are cheap and safe to run.

${COMMON}

Scope: the repositories the prompt lists, narrowed to the repos, areas or concerns the ticket names (e.g. "performance of the reports API").
1. For each repo read its CLAUDE.md, README and .claude/rules, then map entry points, hot paths (request handlers, loops over data, database access, queues, caches) and risky parts (money, auth, concurrency, external calls).
2. Hunt for:
   - bugs: wrong logic, unhandled edge cases, error handling that hides failures, race conditions, time zone and number precision mistakes;
   - performance: N+1 queries, missing indexes or pagination, unbounded loops or memory, blocking I/O on hot paths, repeated work, missing caching, chatty network calls;
   - reliability: missing timeouts or retries, unhandled promise rejections, resource leaks, missing transactions, unsafe migrations;
   - security: injection, authorization gaps, leaked secrets, unvalidated input.
3. Verify every finding in the code before you report it and quote file:line. No style nits and no speculation: a few real findings beat many guesses.
4. Severity:
   - critical: data loss or corruption, money or security breach, an outage is likely;
   - high: wrong behaviour users hit, serious slowdown under normal load;
   - medium: edge-case bugs, slowdowns under load, risky patterns;
   - low: minor issues and cleanups with a real benefit.

Write the report for a human: a summary, then the findings by severity, each with problem, impact, evidence and fix.

End with a fenced json block the orchestrator parses:
{"summary": "...", "scope": ["<repo>"], "findings": [{"severity": "critical|high|medium|low", "category": "bug|performance|reliability|security|maintainability", "repo": "...", "file": "...", "line": 1, "title": "<one line>", "problem": "...", "impact": "...", "fix": "...", "effort": "S|M|L"}]}`;

const BUILTIN = {
  agents: {
    planner: {
      description: 'Read-only planner. Turns a ticket into a cross-repo plan with contracts, order and open questions.',
      model: 'opus',
      tools: READ_ONLY,
      color: 'blue',
      output: 'plan',
      instructions: PLANNER,
    },
    developer: {
      description: 'Implements the approved plan in exactly one repository, or fixes review findings there.',
      model: 'inherit',
      tools: WRITE,
      color: 'green',
      output: 'code',
      instructions: DEVELOPER,
    },
    tester: {
      description: 'Writes and updates the tests the approved plan owes in every repository it changed and makes them pass.',
      model: 'inherit',
      tools: WRITE,
      color: 'yellow',
      output: 'tests',
      instructions: TESTER,
    },
    reviewer: {
      description: 'Fresh-context, read-only reviewer of the combined cross-repo diff. Returns a verdict with findings.',
      model: 'opus',
      tools: READ_ONLY,
      color: 'red',
      output: 'verdict',
      instructions: REVIEWER,
    },
    verifier: {
      description: 'Read-only. Checks that a ticket is done: finds its work in the repos and judges every acceptance criterion with evidence.',
      model: 'opus',
      tools: READ_ONLY,
      color: 'cyan',
      output: 'readiness',
      instructions: VERIFIER,
    },
    auditor: {
      description: 'Read-only. Audits the repos for bugs, performance bottlenecks, reliability and security issues; rates each critical to low.',
      model: 'opus',
      tools: READ_ONLY,
      color: 'purple',
      output: 'audit',
      instructions: AUDITOR,
    },
  },
  pipeline: ['planner', 'developer', 'tester', 'reviewer'],
  scenarios: { readiness: ['verifier'], audit: ['auditor'] },
  limits: { reviewRounds: 2, gateAttempts: 3 },
  language: 'English',
  baseBranch: 'main',
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const builtinLayer = () => ({ name: 'built-in', baseDir: '/', config: clone(BUILTIN) });
const builtinAgentNames = () => Object.keys(BUILTIN.agents);
const builtinInstructions = (name) => BUILTIN.agents[name] && BUILTIN.agents[name].instructions;

const projectConfigFile = (workspace) => path.join(workspace, CONFIG_DIR, CONFIG_FILE);
const userConfigFile = (home = os.homedir()) => path.join(home, CONFIG_DIR, CONFIG_FILE);

// ---------- loading ----------

/** A missing file is not an error: that layer simply does not exist. */
function loadLayerFile(file, name) {
  if (!fs.existsSync(file)) return { diagnostics: [] };
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (e) {
    return { diagnostics: [{ level: 'error', code: 'yaml_invalid', source: file, message: `${file}: ${e.message}` }] };
  }
  const issues = validateConfigLayer(raw);
  if (issues.length) return { diagnostics: issues.map((m) => ({ level: 'error', code: 'config_invalid', source: file, message: `${name} config: ${m}` })) };
  return { layer: { name, baseDir: path.dirname(file), config: raw }, diagnostics: [] };
}

function loadLayers({ workspace, home = os.homedir() }) {
  const layers = [builtinLayer()];
  const diagnostics = [];
  const files = [['user', userConfigFile(home)], ['project', projectConfigFile(workspace)]];
  // A workspace inside the home folder must not load the same file twice.
  if (path.resolve(files[0][1]) === path.resolve(files[1][1])) files.shift();
  for (const [name, file] of files) {
    const r = loadLayerFile(file, name);
    diagnostics.push(...r.diagnostics);
    if (r.layer) layers.push(r.layer);
  }
  return { layers, diagnostics };
}

// ---------- merging ----------

const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function toOp(layer, input) {
  if (input === undefined) return undefined;
  if (typeof input === 'string') return { mode: 'replace', text: input, source: `${layer.name} (inline)` };
  const mode = input.mode || 'replace';
  if (input.file !== undefined) {
    const file = path.resolve(layer.baseDir, input.file);
    return { mode, file, source: file };
  }
  return { mode, text: input.text ?? '', source: `${layer.name} (inline)` };
}

function mergeLayers(layers) {
  const merged = { agents: new Map(), limits: {}, repos: new Map(), jira: {}, policy: {}, scenarios: {}, origins: {} };
  for (const layer of layers) {
    const c = layer.config;
    for (const [name, agent] of Object.entries(c.agents ?? {})) {
      const { instructions, ...fields } = agent;
      const prev = merged.agents.get(name) ?? { ops: [], layers: [] };
      const op = toOp(layer, instructions);
      merged.agents.set(name, { ...prev, ...defined(fields), ops: op ? [...prev.ops, op] : prev.ops, layers: [...prev.layers, layer.name] });
    }
    for (const [name, repo] of Object.entries(c.repos ?? {})) merged.repos.set(name, { ...merged.repos.get(name), ...defined(repo) });
    if (c.pipeline) merged.pipeline = { names: [...c.pipeline], source: layer.name };
    for (const [name, list] of Object.entries(c.scenarios ?? {})) merged.scenarios[name] = { names: [...list], source: layer.name };
    if (c.limits) merged.limits = { ...merged.limits, ...defined(c.limits) };
    if (c.language) merged.language = c.language;
    if (c.baseBranch) merged.baseBranch = c.baseBranch;
    if (c.jira && c.jira.allowedProjects) merged.jira = { allowedProjects: [...c.jira.allowedProjects] };
    if (c.policy) merged.policy = { ...merged.policy, ...defined(c.policy) };
    if (c.git && c.git.mode) merged.gitMode = c.git.mode;
    if (c.editor) merged.editor = c.editor;
    if (c.context) merged.context = c.context.map((f) => path.resolve(layer.baseDir, f));
  }
  return merged;
}

/** `only` enables exactly the named agents, `no` then disables names; both refer to known agents. */
function applyFlags(merged, flags, diagnostics) {
  const no = flags.no ?? [];
  const only = flags.only ?? [];
  for (const name of new Set([...no, ...only])) {
    if (!merged.agents.has(name)) diagnostics.push({ level: 'error', code: 'unknown_flag_agent', agent: name, source: 'flags', message: `flag names unknown agent "${name}"` });
  }
  for (const name of only.filter((n) => no.includes(n))) {
    diagnostics.push({ level: 'error', code: 'conflicting_flags', agent: name, source: 'flags', message: `"${name}" is both in --only and --no` });
  }
  if (only.length > 0) for (const [name, draft] of merged.agents) draft.enabled = only.includes(name);
  for (const name of no) {
    const draft = merged.agents.get(name);
    if (draft) draft.enabled = false;
  }
}

// ---------- resolving ----------

function resolveConfig(layers, opts = {}) {
  const read = opts.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const diags = [];
  const merged = mergeLayers(layers);
  applyFlags(merged, opts.flags ?? {}, diags);

  const inherited = resolveExtends(merged.agents, diags);
  const agents = {};
  for (const [name, draft] of merged.agents) {
    const base = inherited.get(name);
    if (!base) continue;
    const enabled = draft.enabled ?? true;
    const level = enabled ? 'error' : 'warning';

    if (!base.description) diags.push({ level: 'error', code: 'missing_description', agent: name, message: `agent "${name}" needs a description (or extends an agent that has one)` });
    if (!base.output) diags.push({ level: 'error', code: 'missing_output', agent: name, message: `agent "${name}" needs an output: plan, code, tests or verdict (or extends an agent that has one)` });

    const instructions = applyOps(base.ops, read, (op, err) =>
      diags.push({ level, code: 'instructions_unreadable', agent: name, source: op.source, message: `cannot read instructions for "${name}": ${err}` })
    );
    if (enabled && instructions.trim() === '') diags.push({ level: 'warning', code: 'empty_instructions', agent: name, message: `agent "${name}" has no instructions` });
    if (!base.description || !base.output) continue;
    if (base.runs && base.output !== 'code' && base.output !== 'tests') diags.push({ level: 'warning', code: 'runs_ignored', agent: name, message: `"${name}" has runs: ${base.runs}, which only applies to code and tests agents` });

    agents[name] = {
      name,
      enabled,
      lineage: base.lineage,
      description: base.description,
      model: base.model ?? 'inherit',
      ...(base.tools && { tools: base.tools }),
      ...(base.disallowedTools && { disallowedTools: base.disallowedTools }),
      ...(base.maxTurns !== undefined && { maxTurns: base.maxTurns }),
      ...(base.effort && { effort: base.effort }),
      ...(base.runs && { runs: base.runs }),
      ...(base.color && { color: base.color }),
      output: base.output,
      instructions,
      instructionSources: base.ops.map((o) => ({ mode: o.mode, source: o.source })),
      layers: draft.layers,
    };
  }

  const scenarios = resolveScenarios(merged.scenarios, merged.agents, agents, diags);
  const pipeline = resolvePipeline(merged.pipeline, merged.agents, diags, scenarios);
  for (const name of pipeline) {
    const a = agents[name];
    if (a && Object.values(SCENARIO_OUTPUT).includes(a.output)) {
      diags.push({ level: 'error', code: 'report_agent_in_pipeline', agent: name, message: `"${name}" writes a ${a.output} report; list it under scenarios.${a.output}, not in the pipeline` });
    }
  }

  const context = merged.context ?? [];
  for (const file of context) {
    try {
      read(file);
    } catch {
      diags.push({ level: 'warning', code: 'context_missing', source: file, message: `context file ${file} cannot be read; agents will not get it` });
    }
  }

  const baseBranch = merged.baseBranch ?? 'main';
  const repos = {};
  for (const [name, repo] of merged.repos) {
    repos[name] = { name, ...(repo.role && { role: repo.role }), path: repo.path ?? name, baseBranch: repo.baseBranch ?? baseBranch, gates: repo.gates ?? [] };
  }

  const errors = diags.filter((d) => d.level === 'error');
  const warnings = diags.filter((d) => d.level === 'warning');
  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    warnings,
    config: {
      agents,
      pipeline,
      scenarios,
      pipelineSource: merged.pipeline ? merged.pipeline.source : 'agents',
      limits: {
        reviewRounds: merged.limits.reviewRounds ?? 2,
        gateAttempts: merged.limits.gateAttempts ?? 3,
        ...(merged.limits.budgetUsd !== undefined && { budgetUsd: merged.limits.budgetUsd }),
      },
      language: merged.language ?? 'English',
      baseBranch,
      repos,
      jira: { allowedProjects: merged.jira.allowedProjects ?? [] },
      policy: {
        protectedBranches: merged.policy.protectedBranches ?? ['main', 'master'],
        draftPrsOnly: merged.policy.draftPrsOnly ?? true,
        forbidAiAttribution: merged.policy.forbidAiAttribution ?? false,
        allowNoVerify: merged.policy.allowNoVerify ?? false,
      },
      context,
      git: { mode: merged.gitMode ?? 'branch' },
      ...(merged.editor && { editor: merged.editor }),
    },
  };
}

/** Walks `extends` for every agent. Agents in a cycle or with a missing base map to nothing. */
function resolveExtends(drafts, diags) {
  const done = new Map();
  const visit = (name, stack) => {
    if (done.has(name)) return done.get(name);
    if (stack.includes(name)) {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(' → ');
      diags.push({ level: 'error', code: 'extends_cycle', agent: name, message: `extends cycle: ${cycle}` });
      for (const member of stack.slice(stack.indexOf(name))) done.set(member, null);
      return null;
    }
    const draft = drafts.get(name);
    let base = { lineage: [], ops: [] };
    if (draft.extends !== undefined) {
      if (!drafts.has(draft.extends)) {
        diags.push({ level: 'error', code: 'extends_unknown', agent: name, message: `agent "${name}" extends unknown agent "${draft.extends}"` });
        done.set(name, null);
        return null;
      }
      const parent = visit(draft.extends, [...stack, name]);
      if (parent === null) {
        if (!done.has(name)) {
          diags.push({ level: 'error', code: 'extends_invalid_base', agent: name, message: `agent "${name}" extends "${draft.extends}", which cannot be resolved` });
          done.set(name, null);
        }
        return null;
      }
      base = parent;
    }
    const result = {
      lineage: [...base.lineage, name],
      description: draft.description ?? base.description,
      model: draft.model ?? base.model,
      tools: draft.tools ?? base.tools,
      disallowedTools: draft.disallowedTools ?? base.disallowedTools,
      maxTurns: draft.maxTurns ?? base.maxTurns,
      effort: draft.effort ?? base.effort,
      runs: draft.runs ?? base.runs,
      color: draft.color ?? base.color,
      output: draft.output ?? base.output,
      ops: [...base.ops, ...draft.ops],
    };
    done.set(name, result);
    return result;
  };
  const out = new Map();
  for (const name of drafts.keys()) {
    const r = visit(name, []);
    if (r) out.set(name, r);
  }
  return out;
}

function applyOps(ops, read, onError) {
  let text = '';
  for (const op of ops) {
    let fragment;
    if (op.file !== undefined) {
      try {
        fragment = read(op.file);
      } catch (e) {
        onError(op, e.message);
        continue;
      }
    } else fragment = op.text ?? '';
    fragment = fragment.trim();
    if (op.mode === 'replace') text = fragment;
    else if (!fragment) continue;
    else if (!text) text = fragment;
    else text = op.mode === 'append' ? `${text}\n\n${fragment}` : `${fragment}\n\n${text}`;
  }
  return text;
}

/** The agents of each report scenario. They must exist and produce that scenario's report. */
function resolveScenarios(merged, drafts, agents, diags) {
  const out = {};
  for (const [scenario, output] of Object.entries(SCENARIO_OUTPUT)) {
    const entry = merged[scenario];
    const names = entry ? entry.names : [];
    const seen = new Set();
    for (const name of names) {
      if (!drafts.has(name)) diags.push({ level: 'error', code: 'scenario_unknown_agent', agent: name, source: entry.source, message: `scenarios.${scenario} names unknown agent "${name}"` });
      else if (agents[name] && agents[name].output !== output) diags.push({ level: 'error', code: 'scenario_wrong_output', agent: name, source: entry.source, message: `scenarios.${scenario} lists "${name}", which produces ${agents[name].output}, not ${output}` });
      if (seen.has(name)) diags.push({ level: 'error', code: 'scenario_duplicate', agent: name, source: entry.source, message: `scenarios.${scenario} lists "${name}" more than once` });
      seen.add(name);
    }
    out[scenario] = names;
  }
  return out;
}

function resolvePipeline(pipeline, drafts, diags, scenarios = {}) {
  const inScenario = new Set(Object.values(scenarios).flat());
  const names = pipeline ? pipeline.names : [...drafts.keys()].filter((n) => !inScenario.has(n));
  const source = pipeline && pipeline.source;
  const seen = new Set();
  for (const name of names) {
    if (!drafts.has(name)) diags.push({ level: 'error', code: 'pipeline_unknown_agent', agent: name, source, message: `pipeline names unknown agent "${name}"` });
    if (seen.has(name)) diags.push({ level: 'error', code: 'pipeline_duplicate', agent: name, source, message: `pipeline lists "${name}" more than once` });
    seen.add(name);
  }
  for (const [name, draft] of drafts) {
    if ((draft.enabled ?? true) && !seen.has(name) && !inScenario.has(name)) diags.push({ level: 'warning', code: 'not_in_pipeline', agent: name, message: `agent "${name}" is enabled but not in the pipeline, so it never runs` });
  }
  return names;
}

/** Loads every layer and resolves it. */
function loadConfig({ workspace, home, flags, readFile } = {}) {
  const { layers, diagnostics } = loadLayers({ workspace, ...(home && { home }) });
  const loadErrors = diagnostics.filter((d) => d.level === 'error');
  if (loadErrors.length) return { ok: false, errors: loadErrors, warnings: diagnostics.filter((d) => d.level === 'warning') };
  const r = resolveConfig(layers, { flags, readFile });
  return { ...r, warnings: [...diagnostics, ...r.warnings] };
}

// ---------- editing the project layer ----------

/** The project layer as plain data ({} when the file does not exist or does not parse). */
function readProjectLayer(workspace) {
  const file = projectConfigFile(workspace);
  if (!fs.existsSync(file)) return {};
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/**
 * Edits the project layer in place, keeping comments and formatting, and refuses a result
 * that no longer validates. Returns the file path.
 */
function editProjectConfig(workspace, mutate) {
  const file = projectConfigFile(workspace);
  const doc = YAML.parseDocument(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0].message}`);
  if (doc.contents === null) doc.contents = doc.createNode({});
  mutate(doc);
  pruneEmpty(doc, ['agents']);
  pruneEmpty(doc, ['repos']);
  const issues = validateConfigLayer(doc.toJS() ?? {});
  if (issues.length) throw new Error(`the change would make ${CONFIG_DIR}/${CONFIG_FILE} invalid: ${issues.join('; ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, doc.toString());
  return file;
}

function pruneEmpty(doc, at) {
  const node = doc.getIn(at, true);
  if (!node || !node.items) return;
  for (const item of [...node.items]) {
    const v = item.value;
    if (v && v.items && v.items.length === 0) doc.deleteIn([...at, item.key.value ?? item.key]);
  }
}

/** Sets (or, with `undefined`/null, removes) fields of one agent in the project config. */
function updateAgentConfig(workspace, agent, patch) {
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null));
  const issues = validateAgentPatch(set);
  if (issues.length) throw new Error(`invalid agent change: ${issues.join('; ')}`);
  return editProjectConfig(workspace, (doc) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) doc.deleteIn(['agents', agent, key]);
      else doc.setIn(['agents', agent, key], doc.createNode(value));
    }
  });
}

/** Removes everything the project layer says about an agent: back to the user/built-in definition. */
function resetAgentConfig(workspace, agent) {
  return editProjectConfig(workspace, (doc) => doc.deleteIn(['agents', agent]));
}

function setScenario(workspace, scenario, agents) {
  return editProjectConfig(workspace, (doc) => {
    const node = doc.createNode(agents);
    node.flow = true;
    doc.setIn(['scenarios', scenario], node);
  });
}

function setPipeline(workspace, pipeline) {
  return editProjectConfig(workspace, (doc) => {
    const node = doc.createNode(pipeline);
    node.flow = true;
    doc.setIn(['pipeline'], node);
  });
}

/** Sets any top-level path (e.g. ['limits', 'reviewRounds']); `undefined` removes it. */
function setProjectValue(workspace, keyPath, value) {
  return editProjectConfig(workspace, (doc) => {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0 && keyPath[0] !== 'pipeline')) doc.deleteIn(keyPath);
    else doc.setIn(keyPath, doc.createNode(value));
    // Drop parents left empty, e.g. `limits: {}`.
    for (let i = keyPath.length - 1; i > 0; i--) {
      const parent = doc.getIn(keyPath.slice(0, i), true);
      if (parent && parent.items && parent.items.length === 0) doc.deleteIn(keyPath.slice(0, i));
    }
  });
}

function setRepo(workspace, name, layer, oldName) {
  return editProjectConfig(workspace, (doc) => {
    if (oldName && oldName !== name) doc.deleteIn(['repos', oldName]);
    if (layer === undefined) doc.deleteIn(['repos', name]);
    else doc.setIn(['repos', name], doc.createNode(defined(layer)));
  });
}

/** Writes a fresh project config (setup wizard). Refuses to overwrite an existing one. */
function createProjectConfig(workspace, layer, header) {
  const file = projectConfigFile(workspace);
  if (fs.existsSync(file)) throw new Error(`${CONFIG_DIR}/${CONFIG_FILE} already exists`);
  const issues = validateConfigLayer(layer);
  if (issues.length) throw new Error(issues.join('; '));
  const doc = new YAML.Document(layer);
  if (header) doc.commentBefore = header;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, doc.toString());
  return file;
}

/**
 * Points an agent at its own instructions file (`.claudestrator/prompts/<name>.md`), seeding it with what
 * the agent resolves to today, so editing that file changes the agent. Returns the file.
 */
function ensureInstructionsFile(workspace, agentName, resolved) {
  const rel = `./${PROMPTS_DIR}/${agentName}.md`;
  const file = path.join(workspace, CONFIG_DIR, PROMPTS_DIR, `${agentName}.md`);
  const current = readProjectLayer(workspace);
  const own = current.agents && current.agents[agentName] && current.agents[agentName].instructions;
  if (own && typeof own === 'object' && own.file) {
    const existing = path.resolve(path.join(workspace, CONFIG_DIR), own.file);
    if (!fs.existsSync(existing)) {
      fs.mkdirSync(path.dirname(existing), { recursive: true });
      fs.writeFileSync(existing, `${(resolved && resolved.instructions) || ''}\n`);
    }
    return existing;
  }
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${(resolved && resolved.instructions) || ''}\n`);
  }
  updateAgentConfig(workspace, agentName, { instructions: { mode: 'replace', file: rel } });
  return file;
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  PROMPTS_DIR,
  BUILTIN,
  builtinLayer,
  builtinAgentNames,
  builtinInstructions,
  projectConfigFile,
  userConfigFile,
  loadLayerFile,
  loadLayers,
  mergeLayers,
  resolveConfig,
  loadConfig,
  readProjectLayer,
  updateAgentConfig,
  resetAgentConfig,
  setPipeline,
  setScenario,
  setProjectValue,
  setRepo,
  createProjectConfig,
  ensureInstructionsFile,
};
