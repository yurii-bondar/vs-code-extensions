// Agents & pipeline, repos & checks, settings. Every change is written to .claudestrator/config.yaml
// (comments kept) and applies to the next agent run; tasks already running keep their frozen pipeline.

type ConfigOk = Extract<ConfigData, { ok: true }>;

interface AgentsView extends View {
  c: ConfigData | null;
  open: Record<string, boolean>;
  newOpen: boolean;
  load(): Promise<void>;
  render(): void;
  move(name: string, delta: number): Promise<void>;
  /** The pipeline as configured; empty while the config has errors. */
  pipeline(): string[];
  scenarioAgents(scenario: string): string[];
}

/** A repo being edited: what the form fields hold until Save. */
interface RepoDraft {
  name: string;
  path: string;
  role: string;
  baseBranch: string;
  gates: GateConfig[];
}

interface ReposView extends View {
  r: ReposData | null;
  drafts: Record<string, RepoDraft>;
  results: Record<string, RepoGates>;
  picked: PickedRepos | null;
  load(): Promise<void>;
  draft(name: string): RepoDraft;
  render(): void;
  repoCard(x: RepoView): string;
}

interface SettingsView extends View {
  s: SettingsData | null;
  c: ConfigData | null;
  load(): Promise<void>;
  render(): void;
}

interface McpView extends View {
  m: McpData | null;
  /** A server's details: `true` while they load, then the text. */
  details: Record<string, true | string>;
  load(refresh?: boolean): Promise<void>;
  render(): void;
  row(x: McpServerView, checking: boolean): string;
}

// Merges into `Views` of globals.d.ts, which is where the shell reads these screens.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Views {
  agents: AgentsView;
  repos: ReposView;
  settings: SettingsView;
  mcp: McpView;
}

(function () {
  const { call, attempt, toast, icon, esc, $, $$, plural, OUTPUT_INFO, SCENARIO_INFO, agentColor, views, patch, outlineHtml, dur, ago, EFFORT_LABEL, modelChoices } = window.CS;
  const REPORT_SCENARIOS = ['readiness', 'audit'];
  const EFFORT_HINT: Record<string, string> = { '': 'the model\'s default', low: 'fastest, cheapest', medium: 'balanced', high: 'thorough', xhigh: 'very thorough', max: 'deepest, slowest' };
  const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  const ALL_OUTPUTS: Output[] = ['plan', 'code', 'tests', 'verdict', 'readiness', 'audit'];
  const asEffort = (v: string) => ALL_EFFORTS.find((e) => e === v);
  const asOutput = (v: string) => ALL_OUTPUTS.find((o) => o === v);
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

  /**
   * Effort choices with the real default spelled out ("Default — medium"), limited to what the model supports.
   * `actual` is what the agent runs with today, as the CLI reported it.
   */
  function effortOptions(current: string | undefined, actual: Effective, supported: string[] | null) {
    const levels = supported && supported.length ? ALL_EFFORTS.filter((e) => supported.includes(e) || e === current) : ALL_EFFORTS;
    const def = actual.defaultEffort;
    return [
      `<option value="" ${!current ? 'selected' : ''}>${esc(def ? `Default — ${def}` : actual.model ? 'Default — no effort for this model' : 'Default (checking…)')}</option>`,
      ...levels.map((e) => `<option value="${e}" ${e === current ? 'selected' : ''}>${esc(`${EFFORT_LABEL[e]} — ${EFFORT_HINT[e]}`)}</option>`),
    ].join('');
  }

  function errorsHtml(errors: readonly string[]) {
    return `<div class="banner error">${icon('alert')}<div class="grow"><b>The config has errors:</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div><div class="banner-actions"><button class="btn sm" data-action="open-config">Open config.yaml</button></div></div>`;
  }
  const warningsHtml = (warnings: readonly string[] | undefined) => (warnings && warnings.length ? `<div class="banner warn">${icon('info')}<div class="grow">${warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div></div>` : '');

  /** Sends a change; `ok` is the toast on success, `null` for none. Resolves to whether it went through. */
  async function save<M extends keyof Rpc>(method: M, params: Rpc[M]['params'], ok: string | null = 'Saved') {
    const r = await attempt(method, params, ok);
    return r !== undefined;
  }

  /** The items whose checkbox (its `data-i` is the item's index) is ticked. */
  function ticked<T extends object>(checkboxes: string, list: readonly T[]): T[] {
    return $$<HTMLInputElement>(checkboxes)
      .filter((c) => c.checked)
      .flatMap((c) => {
        const item = list[Number(c.dataset.i)];
        return item ? [item] : [];
      });
  }

  // ---------- agents ----------

  views.agents = {
    c: null,
    open: {},
    newOpen: false,
    async enter() {
      $('#view')!.innerHTML = `<div class="page agents-page" data-region="agents"></div>`;
      await this.load();
    },
    async load() {
      this.c = await call('config');
      this.render();
    },
    onConfig() {
      this.load();
    },
    refresh() {
      return window.CS.loadOverview();
    },
    pipeline() {
      const c = this.c;
      return c && c.ok ? c.config.pipeline : [];
    },
    scenarioAgents(scenario) {
      const c = this.c;
      return (c && c.ok && (c.config.scenarios || {})[scenario]) || [];
    },
    render() {
      const c = this.c;
      if (!c) return;
      if (!c.root) {
        patch('agents', '<div class="empty-state"><h2>Open a folder first</h2></div>');
        return;
      }
      if (!c.ok) {
        patch('agents', `<h1>${icon('users')}Agents & pipeline</h1>${errorsHtml(c.errors)}`);
        return;
      }
      const byName = Object.fromEntries(c.agents.map((a) => [a.name, a]));
      const colors = Object.fromEntries(c.agents.map((a) => [a.name, a.color]));
      const known = (names: readonly string[]) =>
        names.flatMap((n) => {
          const a = byName[n];
          return a ? [a] : [];
        });
      const inPipeline = known(c.config.pipeline);
      const pipelineNames = new Set(inPipeline.map((a) => a.name));
      const scenarios = c.config.scenarios || {};
      const custom = Object.values(c.config.custom || {});
      const removed = c.config.removedScenarios || [];
      const inScenario = new Set([...Object.values(scenarios).flat(), ...custom.flatMap((sc) => sc.agents.map((st) => st.name))]);
      const others = c.agents.filter((a) => !pipelineNames.has(a.name) && !inScenario.has(a.name));
      const step = (st: { name: string; model?: string | undefined; effort?: string | undefined }) => `<span class="${agentColor(colors[st.name])}"><span class="adot"></span>${esc(st.name)}${st.model || st.effort ? ` <span class="muted small">${esc([st.model, st.effort].filter(Boolean).join(' · '))}</span>` : ''}</span>`;
      const open = this.open;
      const defaults = c.defaults;
      patch(
        'agents',
        `<div class="page-head">
          <div><h1>${icon('users')}Agents & pipeline</h1>
          <p class="lead">Agents run top to bottom. What an agent <b>produces</b> decides how it is used: a <b>plan</b> waits for your approval, <b>code</b> runs once per repo of the plan and <b>tests</b> once across all of them (each switchable), with checks after them, and a <b>review</b> sends blocking findings back for a fix round.</p></div>
          <div class="row"><button class="btn" data-action="open-config">${icon('edit')}config.yaml</button><button class="btn primary" data-action="agent-new-open">${icon('plus')}New agent</button></div>
        </div>
        <div class="card flow-card"><div class="flow-label muted small">A task goes through</div>${outlineHtml(c.outline, colors)}</div>
        ${warningsHtml(c.warnings)}
        ${this.newOpen ? newAgentForm(c) : ''}
        <div class="agent-list" data-dropzone="pipeline">
          ${inPipeline.map((a, i) => agentCard(a, { index: i, total: inPipeline.length, open: Boolean(open[a.name]), defaults })).join('')}
        </div>
        <h3 class="section-title">Other scenarios</h3>
        <p class="muted small">Read-only agents that end with a report instead of PRs. Pick the scenario in the task composer, or let your words pick it (“перевір готовність…”, “аудит…”).</p>
        ${REPORT_SCENARIOS.filter((sc) => !removed.includes(sc)).map((sc) => {
          const agents = known(scenarios[sc] || []);
          return `<div class="scenario-block"><div class="sb-head">${icon(SCENARIO_INFO[sc]!.icon)}<b>${esc(SCENARIO_INFO[sc]!.label)}</b><span class="muted small">${esc(SCENARIO_INFO[sc]!.hint)}</span></div>
            <div class="agent-list">${agents.length ? agents.map((a) => agentCard(a, { index: -1, total: 0, open: Boolean(open[a.name]), scenario: sc, defaults })).join('') : `<div class="muted small">No agent: add one that produces a ${esc(OUTPUT_INFO[sc]!.label)} report.</div>`}</div></div>`;
        }).join('')}
        ${custom.length ? `<h3 class="section-title">Your scenarios</h3>
          <p class="muted small">Made, changed and deleted from the scenario menu of the task composer; each sets its agents' order and, if you like, their model and effort.</p>
          ${custom.map((sc) => `<div class="scenario-block"><div class="sb-head">${icon('wand')}<b>${esc(sc.label)}</b>${sc.description ? `<span class="muted small">${esc(sc.description)}</span>` : ''}</div>
            <div class="sc-agents">${sc.agents.length ? sc.agents.map(step).join('<span class="pipe-arrow">→</span>') : '<span class="muted small">no agents yet</span>'}</div></div>`).join('')}` : ''}
        ${others.length ? `<h3 class="section-title">Not in the pipeline</h3><div class="agent-list">${others.map((a) => agentCard(a, { index: -1, total: 0, open: Boolean(open[a.name]), defaults })).join('')}</div>` : ''}
        <p class="muted small">Changes are saved to <code>.claudestrator/config.yaml</code> and apply to new tasks; a running task keeps the pipeline it started with, but picks up edited instructions for its next agent.</p>`
      );
    },
    async move(name, delta) {
      const list = [...this.pipeline()];
      const i = list.indexOf(name);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return;
      const a = list[i];
      const b = list[j];
      if (a === undefined || b === undefined) return;
      list[i] = b;
      list[j] = a;
      if (await save('setPipeline', { pipeline: list }, null)) this.load();
    },
    actions: {
      'agent-toggle-open': (el) => {
        const v = views.agents;
        v.open = { ...v.open, [el.dataset.name]: !v.open[el.dataset.name] };
        v.render();
      },
      'agent-up': (el) => views.agents.move(el.dataset.name, -1),
      'agent-down': (el) => views.agents.move(el.dataset.name, 1),
      'agent-instructions': (el) => attempt('editInstructions', { name: el.dataset.name }),
      'agent-reset': async (el) => {
        await attempt('resetAgent', { name: el.dataset.name });
        views.agents.load();
      },
      'agent-remove': async (el) => {
        const list = views.agents.pipeline().filter((n) => n !== el.dataset.name);
        if (await save('setPipeline', { pipeline: list }, `${el.dataset.name} removed from the pipeline`)) views.agents.load();
      },
      'agent-add': async (el) => {
        const list = [...views.agents.pipeline(), el.dataset.name];
        if (await save('setPipeline', { pipeline: list }, `${el.dataset.name} added at the end`)) views.agents.load();
      },
      'agent-add-scenario': async (el) => {
        const sc = el.dataset.scenario;
        const list = [...views.agents.scenarioAgents(sc), el.dataset.name];
        if (await save('setScenario', { scenario: sc, agents: list }, `${el.dataset.name} added to ${SCENARIO_INFO[sc]!.label}`)) views.agents.load();
      },
      'agent-remove-scenario': async (el) => {
        const sc = el.dataset.scenario;
        const list = views.agents.scenarioAgents(sc).filter((n) => n !== el.dataset.name);
        if (await save('setScenario', { scenario: sc, agents: list }, `${el.dataset.name} removed from ${SCENARIO_INFO[sc]!.label}`)) views.agents.load();
      },
      'agent-new-open': () => {
        views.agents.newOpen = !views.agents.newOpen;
        views.agents.render();
        const f = $('#na-name');
        if (f) f.focus();
      },
      'agent-create': async () => {
        const v = (id: string) => $<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value.trim() ?? '';
        const ok = await save(
          'newAgent',
          { name: v('na-name'), base: v('na-base') || undefined, description: v('na-desc') || undefined, output: asOutput(v('na-output')), model: v('na-model') || undefined, effort: asEffort(v('na-effort')) },
          'Agent created. Write its instructions in the file that opened.'
        );
        if (ok) {
          views.agents.newOpen = false;
          views.agents.load();
        }
      },
    },
    changes: {
      'agent-enabled': async (el) => {
        if (await save('updateAgent', { name: el.dataset.name, patch: { enabled: el.checked } }, `${el.dataset.name} ${el.checked ? 'on' : 'off'}`)) views.agents.load();
      },
      'agent-model': async (el) => {
        const model = el.value;
        if (model === '__custom') {
          const input = el.parentElement!.querySelector<HTMLInputElement>('.custom-model')!;
          input.hidden = false;
          input.focus();
          return;
        }
        if (await save('updateAgent', { name: el.dataset.name, patch: { model } }, `${el.dataset.name} uses ${model}`)) views.agents.load();
      },
      'agent-model-custom': async (el) => {
        if (el.value.trim() && (await save('updateAgent', { name: el.dataset.name, patch: { model: el.value.trim() } }))) views.agents.load();
      },
      'agent-runs': async (el) => {
        const runs = el.value || null;
        if (await save('updateAgent', { name: el.dataset.name, patch: { runs } }, `${el.dataset.name}: ${el.selectedOptions[0]?.textContent}`)) views.agents.load();
      },
      'agent-effort': async (el) => {
        const effort = el.value || null;
        if (await save('updateAgent', { name: el.dataset.name, patch: { effort } }, `${el.dataset.name}: ${effort ? `effort ${effort}` : 'default effort'}`)) views.agents.load();
      },
      'agent-mcp': async (el) => {
        if (await save('updateAgent', { name: el.dataset.name, patch: { mcp: el.checked } }, `${el.dataset.name}: ${el.checked ? 'MCP servers on' : 'no MCP servers'}`)) views.agents.load();
      },
      'agent-color': async (el) => {
        if (await save('updateAgent', { name: el.dataset.name, patch: { color: el.value } }, null)) views.agents.load();
      },
      'agent-field': async (el) => {
        const field = el.dataset.field;
        const text = el.value.trim();
        if (field === 'description' && !text) return toast('An agent needs a description', 'warn');
        const value = field === 'tools' || field === 'disallowedTools' ? (text ? text.split(/[\s,]+/).filter(Boolean) : null) : text;
        if (await save('updateAgent', { name: el.dataset.name, patch: { [field]: value } })) views.agents.load();
      },
      'na-base': (el) => {
        $('#na-output-row')!.hidden = Boolean(el.value);
      },
    },
  };

  // Drag and drop to reorder the pipeline.
  let dragName: string | null = null;
  const dragCard = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>('.agent-card[draggable="true"]') : null);
  document.addEventListener('dragstart', (e) => {
    const card = dragCard(e);
    if (!card) return;
    dragName = card.dataset.name ?? null;
    card.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
  });
  document.addEventListener('dragend', () => {
    dragName = null;
    $$('.agent-card').forEach((c) => c.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  document.addEventListener('dragover', (e) => {
    const card = dragCard(e);
    if (!card || !dragName) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    $$('.agent-card').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    card.classList.add(before ? 'drop-before' : 'drop-after');
  });
  document.addEventListener('drop', async (e) => {
    const card = dragCard(e);
    if (!card || !dragName) return;
    e.preventDefault();
    const moved = dragName;
    const list = views.agents.pipeline().filter((n) => n !== moved);
    const r = card.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    let i = list.indexOf(card.dataset.name ?? '');
    if (!before) i += 1;
    list.splice(i, 0, moved);
    dragName = null;
    if (await save('setPipeline', { pipeline: list }, null)) views.agents.load();
  });

  interface AgentCardOptions {
    index: number;
    total: number;
    open: boolean;
    /** The report scenario the card is listed under, if any. */
    scenario?: string;
    defaults: DefaultsView | null;
  }

  function agentCard(a: AgentView, { index, total, open, scenario, defaults }: AgentCardOptions) {
    const inPipeline = index >= 0;
    const info = OUTPUT_INFO[a.output] || { label: a.output, hint: '' };
    const reportAgent = REPORT_SCENARIOS.includes(a.output);
    const choices = modelChoices(defaults);
    const known = choices.some(([m]) => m === a.model);
    const extra: [string, string][] = known ? [] : [[a.model, a.model]];
    const models = [...choices, ...extra].map(([m, label]) => `<option value="${esc(m)}" ${m === a.model ? 'selected' : ''}>${esc(label)}</option>`).join('');
    const act = a.actual;
    const supported = defaults ? (defaults.models.find((m) => m.model === act.model || m.value === a.model)?.efforts ?? []) : null;
    const lineage = a.lineage ?? [];
    return `<article class="agent-card ${agentColor(a.color)} ${a.enabled ? '' : 'disabled'}" data-name="${esc(a.name)}" draggable="${inPipeline}">
      <div class="ac-top">
        ${inPipeline ? `<span class="grip" title="Drag to reorder">${icon('grip')}</span><span class="ac-index">${index + 1}</span>` : ''}
        <span class="adot big"></span>
        <div class="ac-title">
          <div class="ac-name">${esc(a.name)}<span class="out-badge out-${a.output}" title="${esc(info.hint)}">${esc(info.label)}</span>${lineage.length > 1 ? `<span class="muted small">extends ${esc(lineage[lineage.length - 2])}</span>` : ''}${a.overridden ? '<span class="chip small" title="This workspace changes this agent">customized</span>' : ''}</div>
          <div class="ac-desc muted">${esc(a.description)}</div>
        </div>
        <label class="switch" title="${a.enabled ? 'On: runs in every new task' : 'Off: skipped'}"><input type="checkbox" data-change="agent-enabled" data-name="${esc(a.name)}" ${a.enabled ? 'checked' : ''}><span class="track"></span></label>
      </div>
      <div class="ac-controls">
        <label class="mini-field" title="Model">${icon('zap')}<select class="input sm" data-change="agent-model" data-name="${esc(a.name)}" aria-label="Model">${models}<option value="__custom">Other model id…</option></select><input class="input sm custom-model" hidden placeholder="claude-…" data-change="agent-model-custom" data-name="${esc(a.name)}"></label>
        <label class="mini-field effort-field eff-${act.effort || 'none'} ${a.effort ? '' : 'is-default'}" title="${esc(`Reasoning effort (claude --effort). Runs at ${act.effort || 'the model default'}${a.effort ? '' : ', the default for this model and account'}.`)}">${icon('gauge')}<select class="input sm" data-change="agent-effort" data-name="${esc(a.name)}" aria-label="Effort">${effortOptions(a.effort, act, supported)}</select></label>
        ${a.output === 'code' || a.output === 'tests' ? runsField(a) : ''}
        <button class="btn sm" data-action="agent-instructions" data-name="${esc(a.name)}">${icon('edit')}Instructions</button>
        <button class="btn ghost sm" data-action="agent-toggle-open" data-name="${esc(a.name)}">${icon('gear')}${open ? 'Less' : 'More'}</button>
        <span class="grow"></span>
        ${inPipeline ? `<button class="icon-btn" data-action="agent-up" data-name="${esc(a.name)}" ${index === 0 ? 'disabled' : ''} title="Move up">${icon('up')}</button><button class="icon-btn" data-action="agent-down" data-name="${esc(a.name)}" ${index === total - 1 ? 'disabled' : ''} title="Move down">${icon('down')}</button>` : scenario ? '' : reportAgent ? `<button class="btn sm" data-action="agent-add-scenario" data-scenario="${a.output}" data-name="${esc(a.name)}">${icon('plus')}Add to ${esc(SCENARIO_INFO[a.output]!.label)}</button>` : `<button class="btn sm" data-action="agent-add" data-name="${esc(a.name)}">${icon('plus')}Add to pipeline</button>`}
      </div>
      ${open ? `<div class="ac-more">
        <label class="field"><span>Description <span class="muted">(what the agent is for)</span></span><input class="input" data-change="agent-field" data-field="description" data-name="${esc(a.name)}" value="${esc(a.description)}"></label>
        <div class="field-row two">
          <label class="field"><span>Tools <span class="muted">(empty = all)</span></span><input class="input mono" data-change="agent-field" data-field="tools" data-name="${esc(a.name)}" value="${esc((a.tools || []).join(', '))}" placeholder="Read, Edit, Write, Grep, Glob, Bash"></label>
          <label class="field"><span>Never allowed</span><input class="input mono" data-change="agent-field" data-field="disallowedTools" data-name="${esc(a.name)}" value="${esc((a.disallowedTools || []).join(', '))}" placeholder="WebFetch"></label>
        </div>
        <label class="check-line" title="Every MCP server adds its tool list to each turn. Off: this agent sees none."><input type="checkbox" data-change="agent-mcp" data-name="${esc(a.name)}" ${a.mcp === false ? '' : 'checked'}><span>MCP servers (Jira, Grafana, docs…) <span class="muted">turn off for agents that only work on the repo</span></span></label>
        <div class="field-row two">
          <label class="field"><span>Color</span><select class="input" data-change="agent-color" data-name="${esc(a.name)}">${['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'].map((c) => `<option ${c === a.color ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <div class="field"><span>Instructions come from</span><div class="sources">${a.instructionSources.map((s) => `<div class="mono small"><span class="chip small">${esc(s.mode)}</span> ${esc(s.source)}</div>`).join('') || '<span class="muted">nowhere</span>'}</div></div>
        </div>
        <details class="preview"><summary>Preview the instructions (${a.instructionsLength} chars)</summary><pre class="code-pre">${esc(a.instructionsPreview)}${a.instructionsLength > a.instructionsPreview.length ? '\n…' : ''}</pre></details>
        <div class="row">
          ${a.overridden ? `<button class="btn ghost sm" data-action="agent-reset" data-name="${esc(a.name)}">${icon('refresh')}Reset to default</button>` : ''}
          ${inPipeline ? `<button class="btn ghost sm danger" data-action="agent-remove" data-name="${esc(a.name)}">${icon('x')}Remove from pipeline</button>` : ''}
          ${scenario ? `<button class="btn ghost sm danger" data-action="agent-remove-scenario" data-scenario="${scenario}" data-name="${esc(a.name)}">${icon('x')}Remove from ${esc(SCENARIO_INFO[scenario]!.label)}</button>` : ''}
        </div>
      </div>` : ''}
    </article>`;
  }

  /** Per repo or once across all repos, for code and tests agents; the output's default is no setting. */
  function runsField(a: AgentView) {
    const def = a.output === 'code' ? 'per-repo' : 'all-repos';
    const label = { 'per-repo': 'Once per repo', 'all-repos': 'Once across all repos' };
    const opt = (v: keyof typeof label) => `<option value="${v === def ? '' : v}" ${(a.runs || def) === v ? 'selected' : ''}>${label[v]}${v === def ? ' (default)' : ''}</option>`;
    return `<label class="mini-field" title="Where it runs: once in each repo of the plan, one after another, or once with every repo of the plan in one session (it sees all the changes and the contracts between them)">${icon('repo')}<select class="input sm" data-change="agent-runs" data-name="${esc(a.name)}" aria-label="Runs">${opt('per-repo')}${opt('all-repos')}</select></label>`;
  }

  function newAgentForm(c: ConfigOk) {
    return `<section class="card new-agent">
      <h3>${icon('plus')}New agent</h3>
      <p class="muted small">Most custom agents extend an existing one, e.g. a <i>security</i> reviewer that extends <i>reviewer</i> with extra checks. It is added right after the agent it extends; one based on <i>verifier</i> or <i>auditor</i> joins that scenario.</p>
      <div class="field-row two">
        <label class="field"><span>Name</span><input id="na-name" class="input mono" placeholder="security-reviewer" spellcheck="false"></label>
        <label class="field"><span>Based on</span><select id="na-base" class="input" data-change="na-base"><option value="">— nothing, write from scratch —</option>${c.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === 'reviewer' ? 'selected' : ''}>${esc(a.name)} (${esc((OUTPUT_INFO[a.output] || { label: a.output }).label)})</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Description</span><input id="na-desc" class="input" placeholder="Reviews the diff for security problems only"></label>
      <div class="field-row two">
        <label class="field" id="na-output-row" hidden><span>Produces</span><select id="na-output" class="input">${ALL_OUTPUTS.map((o) => `<option value="${o}" ${o === 'verdict' ? 'selected' : ''}>${OUTPUT_INFO[o]!.label} — ${esc(OUTPUT_INFO[o]!.hint)}</option>`).join('')}</select></label>
        <label class="field"><span>Model</span><select id="na-model" class="input"><option value="">same as base</option>${modelChoices(c.defaults).map(([m, l]) => `<option value="${esc(m)}">${esc(l)}</option>`).join('')}</select></label>
        <label class="field"><span>Effort</span><select id="na-effort" class="input"><option value="">same as base</option>${ALL_EFFORTS.map((e) => `<option value="${e}">${EFFORT_LABEL[e]} — ${EFFORT_HINT[e]}</option>`).join('')}</select></label>
      </div>
      <div class="row end"><button class="btn ghost" data-action="agent-new-open">Cancel</button><button class="btn primary" data-action="agent-create">${icon('check')}Create & write instructions</button></div>
    </section>`;
  }

  // ---------- repos ----------

  const isRepoField = (f: string): f is 'name' | 'path' | 'role' | 'baseBranch' => f === 'name' || f === 'path' || f === 'role' || f === 'baseBranch';
  const isGateField = (f: string): f is keyof GateConfig => f === 'name' || f === 'cmd' || f === 'when' || f === 'dir';

  views.repos = {
    r: null,
    drafts: {},
    results: {},
    picked: null,
    async enter() {
      $('#view')!.innerHTML = `<div class="page repos-page" data-region="repos"></div>`;
      this.drafts = {};
      this.results = {};
      await this.load();
    },
    async load() {
      this.r = await call('repos');
      this.render();
    },
    onConfig() {
      if (!Object.keys(this.drafts).length) this.load();
    },
    refresh() {
      return window.CS.loadOverview();
    },
    draft(name) {
      const existing = this.drafts[name];
      if (existing) return existing;
      const repo = this.r?.repos.find((x) => x.name === name);
      if (!repo) throw new Error(`No repo ${name}`);
      const draft = { name: repo.name, path: repo.path, role: repo.role || '', baseBranch: repo.baseBranch, gates: repo.gates.map((g) => ({ ...g })) };
      this.drafts[name] = draft;
      return draft;
    },
    render() {
      const r = this.r;
      if (!r) return;
      if (!r.ok) {
        patch('repos', `<h1>${icon('repo')}Repos & checks</h1>${errorsHtml(r.errors)}`);
        return;
      }
      patch(
        'repos',
        `<div class="page-head"><div><h1>${icon('repo')}Repos & checks</h1>
          <p class="lead">The repositories agents may change, and the checks (gates) that must pass after an agent touches one. A red check goes back to the agent with its output, up to the attempt limit in Settings.</p></div>
          <div class="row"><button class="btn" data-action="open-config">${icon('edit')}config.yaml</button><button class="btn primary" data-action="repo-pick">${icon('folder')}Add repository…</button></div></div>
        ${this.picked ? pickedCard(this.picked) : ''}
        ${r.repos.length ? r.repos.map((x) => this.repoCard(x)).join('') : this.picked ? '' : `<div class="banner info">${icon('info')}<div class="grow">No repos configured yet. Without them, agents work in folders named by the plan, with no checks.</div><div class="banner-actions"><button class="btn sm primary" data-action="repo-pick">${icon('folder')}Add repository…</button></div></div>`}
        ${r.detected.length ? `<section class="card detected"><h3>${icon('search')}Found in this workspace</h3>${r.detected.map((d, i) => `<label class="det-row"><input type="checkbox" class="det-check" data-i="${i}" checked><b>${esc(d.name)}</b><span class="muted mono small">${esc(d.path)}</span>${d.stack.map((s) => `<span class="chip small">${esc(s)}</span>`).join('')}<span class="muted small">${d.gates.length ? d.gates.map((g) => esc(g.name)).join(', ') : 'no checks found'}</span></label>`).join('')}<div class="row end"><button class="btn primary sm" data-action="repo-add-detected">${icon('plus')}Add selected</button></div></section>` : ''}
        <section class="card context-card"><h3>${icon('doc')}What every agent reads first</h3>
          <p class="muted small">A short workspace map (what each repo is, the contracts between them, the merge order) is the cheapest way to better plans.</p>
          ${r.context.length ? r.context.map((f) => `<div class="ctx-row">${icon(f.exists ? 'doc' : 'alert')}<a class="path" data-action="ctx-open" data-path="${esc(f.file)}">${esc(f.rel)}</a>${f.exists ? '' : '<span class="badge tone-error">missing</span>'}<span class="grow"></span><button class="icon-btn" data-action="ctx-remove" data-file="${esc(f.file)}" title="Stop giving this to agents">${icon('x')}</button></div>`).join('') : '<div class="muted small">Nothing yet.</div>'}
          <div class="row">${r.context.some((f) => /workspace\.md$/.test(f.file)) ? '' : `<button class="btn sm" data-action="ctx-map">${icon('wand')}Create workspace map</button>`}<button class="btn ghost sm" data-action="ctx-add">${icon('plus')}Add a file…</button></div>
        </section>`
      );
    },
    repoCard(x) {
      const d = this.drafts[x.name];
      const v = d || x;
      const st = x.status;
      const dirty = Boolean(d);
      const res = this.results[x.name];
      const suggested = x.suggested.filter((g) => !v.gates.some((h) => h.name === g.name || h.cmd === g.cmd));
      return `<article class="card repo-card ${dirty ? 'editing' : ''}">
        <div class="rc-head">
          <div class="rc-title">${icon('repo')}<input class="input inline lg" data-input="repo-field" data-repo="${esc(x.name)}" data-field="name" data-key="rn-${esc(x.name)}" value="${esc(v.name)}" spellcheck="false" aria-label="Repo name"></div>
          <div class="rc-status">${!st?.exists ? '<span class="badge tone-error">folder missing</span>' : !st.isRepo ? '<span class="badge tone-error">not a git repo</span>' : `<span class="chip">${icon('branch')}${esc(st.branch || '?')}</span>${st.dirty ? `<span class="badge tone-warn">${plural(st.dirty, 'uncommitted change')}</span>` : '<span class="badge tone-ok">clean</span>'}${st.sync ? `<span class="muted small">↑${st.sync.ahead} ↓${st.sync.behind} vs origin/${esc(x.baseBranch)}</span>` : ''}${st.last ? `<span class="muted small" title="${esc(st.last.subject)}">${esc(st.last.hash)} · ${esc(st.last.when)}</span>` : ''}`}</div>
        </div>
        <div class="field-row three">
          <label class="field"><span>Folder <span class="muted">(relative to the workspace, or an absolute path)</span></span><input class="input mono" data-input="repo-field" data-repo="${esc(x.name)}" data-field="path" data-key="rp-${esc(x.name)}" value="${esc(v.path)}"></label>
          <label class="field"><span>Base branch</span><input class="input mono" data-input="repo-field" data-repo="${esc(x.name)}" data-field="baseBranch" data-key="rb-${esc(x.name)}" value="${esc(v.baseBranch)}"></label>
          <label class="field"><span>Role <span class="muted">(helps the planner)</span></span><input class="input" data-input="repo-field" data-repo="${esc(x.name)}" data-field="role" data-key="rr-${esc(x.name)}" value="${esc(v.role || '')}" placeholder="e.g. Public REST API (NestJS)"></label>
        </div>
        <div class="gates">
          <div class="gates-head"><b>Checks</b><span class="muted small">run in order after each code or tests step · <i>only if changed</i> skips a check unless a changed file starts with that prefix</span></div>
          ${v.gates.length ? `<div class="gate-table"><div class="gt-row gt-head"><span>Name</span><span>Command</span><span>Only if changed</span><span>In folder</span><span></span></div>${v.gates
            .map(
              (g, i) => `<div class="gt-row">
              <input class="input sm" data-input="gate-field" data-repo="${esc(x.name)}" data-i="${i}" data-field="name" data-key="g-${esc(x.name)}-${i}-n" value="${esc(g.name)}" placeholder="lint">
              <input class="input sm mono" data-input="gate-field" data-repo="${esc(x.name)}" data-i="${i}" data-field="cmd" data-key="g-${esc(x.name)}-${i}-c" value="${esc(g.cmd)}" placeholder="npm run lint">
              <input class="input sm mono" data-input="gate-field" data-repo="${esc(x.name)}" data-i="${i}" data-field="when" data-key="g-${esc(x.name)}-${i}-w" value="${esc(g.when || '')}" placeholder="src/">
              <input class="input sm mono" data-input="gate-field" data-repo="${esc(x.name)}" data-i="${i}" data-field="dir" data-key="g-${esc(x.name)}-${i}-d" value="${esc(g.dir || '')}" placeholder=".">
              <button class="icon-btn" data-action="gate-remove" data-repo="${esc(x.name)}" data-i="${i}" title="Remove">${icon('x')}</button>
            </div>`
            )
            .join('')}</div>` : '<div class="muted small">No checks: agents get no automatic feedback in this repo.</div>'}
          <div class="row">
            <button class="btn ghost sm" data-action="gate-add" data-repo="${esc(x.name)}">${icon('plus')}Add check</button>
            ${suggested.map((g) => `<button class="gate-chip" data-action="gate-suggest" data-repo="${esc(x.name)}" data-name="${esc(g.name)}" data-cmd="${esc(g.cmd)}" title="Add: ${esc(g.cmd)}">${icon('plus')}${esc(g.name)}<code>${esc(g.cmd)}</code></button>`).join('')}
          </div>
        </div>
        ${res ? gateResults(res) : ''}
        <div class="rc-actions">
          ${dirty ? `<button class="btn primary sm" data-action="repo-save" data-repo="${esc(x.name)}">${icon('check')}Save</button><button class="btn ghost sm" data-action="repo-cancel" data-repo="${esc(x.name)}">Cancel</button>` : `<button class="btn sm" data-action="repo-run" data-repo="${esc(x.name)}" ${x.gates.length ? '' : 'disabled'}>${icon('beaker')}Run checks now</button>`}
          <span class="grow"></span>
          <button class="btn ghost sm danger" data-action="repo-remove" data-repo="${esc(x.name)}">${icon('trash')}Remove</button>
        </div>
      </article>`;
    },
    actions: {
      'gate-add': (el) => {
        views.repos.draft(el.dataset.repo).gates.push({ name: '', cmd: '' });
        views.repos.render();
      },
      'gate-suggest': (el) => {
        views.repos.draft(el.dataset.repo).gates.push({ name: el.dataset.name, cmd: el.dataset.cmd });
        views.repos.render();
      },
      'gate-remove': (el) => {
        views.repos.draft(el.dataset.repo).gates.splice(+el.dataset.i, 1);
        views.repos.render();
      },
      'repo-cancel': (el) => {
        delete views.repos.drafts[el.dataset.repo];
        views.repos.render();
      },
      'repo-save': async (el) => {
        const v = views.repos;
        const d = v.drafts[el.dataset.repo];
        if (!d) return;
        if (await save('saveRepo', { name: d.name, oldName: el.dataset.repo, layer: d })) {
          delete v.drafts[el.dataset.repo];
          v.load();
        }
      },
      'repo-remove': async (el) => {
        await attempt('removeRepo', { name: el.dataset.repo });
        delete views.repos.drafts[el.dataset.repo];
        views.repos.load();
      },
      'repo-run': async (el) => {
        el.disabled = true;
        el.innerHTML = '<span class="spinner xs"></span>Running…';
        const name = el.dataset.repo;
        let r = await attempt('runGates', { name });
        if (r && r.status === 'skipped' && /no changes/.test(r.summary)) r = await attempt('runGates', { name, force: true });
        if (r) views.repos.results[name] = r;
        views.repos.render();
      },
      'repo-pick': async () => {
        const v = views.repos;
        const res = await attempt('pickRepos');
        if (!res) return;
        if (!res.repos.length) return toast(res.notRepos.length ? `No git repository in ${res.notRepos.join(', ')}` : 'All picked repos are already added', 'warn');
        v.picked = res;
        v.render();
        if (res.notRepos.length) toast(`Not a git repository: ${res.notRepos.join(', ')}`, 'warn');
      },
      'repo-add-picked': async () => {
        const v = views.repos;
        const chosen = ticked('.pick-check', v.picked ? v.picked.repos : []);
        if (!chosen.length) return;
        if (await save('addDetected', { repos: chosen }, `${plural(chosen.length, 'repo')} added`)) {
          v.picked = null;
          v.load();
        }
      },
      'repo-pick-cancel': () => {
        views.repos.picked = null;
        views.repos.render();
      },
      'repo-add-detected': async () => {
        const v = views.repos;
        const picked = ticked('.det-check', v.r ? v.r.detected : []);
        if (!picked.length) return;
        if (await save('addDetected', { repos: picked }, `${plural(picked.length, 'repo')} added`)) v.load();
      },
      'ctx-open': (el) => attempt('openFile', { file: el.dataset.path }),
      'ctx-remove': async (el) => {
        if (await save('removeContext', { file: el.dataset.file }, null)) views.repos.load();
      },
      'ctx-add': async () => {
        await attempt('addContext');
        views.repos.load();
      },
      'ctx-map': async () => {
        await attempt('createWorkspaceMap');
        views.repos.load();
      },
    },
    inputs: {
      'repo-field': (el) => {
        const v = views.repos;
        const wasClean = !v.drafts[el.dataset.repo];
        const field = el.dataset.field;
        if (isRepoField(field)) v.draft(el.dataset.repo)[field] = el.value;
        if (wasClean) v.render();
      },
      'gate-field': (el) => {
        const v = views.repos;
        const wasClean = !v.drafts[el.dataset.repo];
        const field = el.dataset.field;
        const gate = v.draft(el.dataset.repo).gates[+el.dataset.i];
        if (gate && isGateField(field)) gate[field] = el.value;
        if (wasClean) v.render();
      },
    },
  };

  function pickedCard(p: PickedRepos) {
    return `<section class="card detected picked">
      <h3>${icon('folder')}Add ${plural(p.repos.length, 'repository', 'repositories')}</h3>
      ${p.repos.map((d, i) => `<label class="det-row"><input type="checkbox" class="pick-check" data-i="${i}" checked><b>${esc(d.name)}</b><span class="muted mono small" title="${esc(d.dir)}">${esc(d.outside ? d.dir.replace(/^\/Users\/[^/]+/, '~') : d.path)}</span>${d.outside ? '<span class="chip small" title="Saved with its absolute path">outside the workspace</span>' : ''}${d.stack.map((s) => `<span class="chip small">${esc(s)}</span>`).join('')}<span class="muted small">${d.gates.length ? `checks: ${d.gates.map((g) => esc(g.name)).join(', ')}` : 'no checks found'}</span>${d.baseBranch ? `<span class="muted small">${icon('branch')}${esc(d.baseBranch)}</span>` : ''}</label>`).join('')}
      ${p.notRepos.length ? `<div class="muted small">${icon('info')}Not a git repository: ${p.notRepos.map(esc).join(', ')}</div>` : ''}
      <div class="row end"><button class="btn ghost sm" data-action="repo-pick-cancel">Cancel</button><button class="btn primary sm" data-action="repo-add-picked">${icon('plus')}Add selected</button></div>
    </section>`;
  }

  function gateResults(r: RepoGates) {
    return `<div class="gate-results g-${r.status}"><div class="g-head">${icon('beaker')}<b>${r.status === 'pass' ? 'All checks passed' : r.status === 'fail' ? 'Some checks failed' : 'Skipped'}</b>${r.results.map((x) => `<span class="gate-chip ${x.status === 'pass' ? 'on' : x.status === 'fail' ? 'bad' : ''}">${icon(x.status === 'pass' ? 'check' : x.status === 'fail' ? 'x' : 'chevron')}${esc(x.gate)}${x.ms !== undefined && x.ms >= 1000 ? `<span class="muted">${dur(x.ms)}</span>` : ''}</span>`).join('')}</div>${r.status !== 'pass' ? `<pre class="log small ${r.status === 'fail' ? 'error' : ''}">${esc(r.summary)}</pre>` : ''}</div>`;
  }

  // ---------- settings ----------

  views.settings = {
    s: null,
    c: null,
    async enter(route) {
      $('#view')!.innerHTML = `<div class="page narrow settings-page" data-region="settings"></div>`;
      await this.load();
      if (route.section) {
        const el = $(`#sec-${route.section}`);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }
    },
    async load() {
      const [s, c] = await Promise.all([call('settings'), call('config')]);
      this.s = s;
      this.c = c;
      this.render();
    },
    onConfig() {
      this.load();
    },
    refresh() {
      return window.CS.loadOverview();
    },
    render() {
      const { s, c } = this;
      if (!s || !c) return;
      const cfg = c.ok ? c.config : null;
      const layer = c.layer || {};
      const h = s.health;
      const claude = h.checking ? null : h.claude;
      const lang = cfg ? cfg.language : 'English';
      const langs = [...new Set([...c.languages, lang])];
      const fromProject = (keyPath: string[]) => keyPath.reduce<unknown>((o, k) => (isRecord(o) ? o[k] : undefined), layer) !== undefined;
      const tag = (keyPath: string[]) => (fromProject(keyPath) ? '<span class="chip small" title="Set in this workspace\'s config.yaml">workspace</span>' : '');
      patch(
        'settings',
        `<h1>${icon('gear')}Settings</h1>
        ${!c.ok ? errorsHtml(c.errors) : ''}
        <section class="card settings-card" id="sec-general"><h3>How agents work</h3>
          <div class="field-row two">
            <label class="field"><span>Language ${tag(['language'])}<span class="muted">of plans, reviews, questions and PR descriptions</span></span>
              <select class="input" data-change="set-language">${langs.map((l) => `<option ${l === lang ? 'selected' : ''}>${esc(l)}</option>`).join('')}<option value="__other">Other…</option></select></label>
            <label class="field"><span>Base branch ${tag(['baseBranch'])}<span class="muted">tasks branch off it; PRs target it</span></span><input class="input mono" data-change="set-value" data-path="baseBranch" value="${esc(cfg ? cfg.baseBranch : 'main')}"></label>
          </div>
          <div class="field"><span>Git ${tag(['git', 'mode'])}<span class="muted">for new tasks</span></span>
            <div class="radio-cards">
              <label class="radio-card ${cfg && cfg.git.mode === 'branch' ? 'on' : ''}"><input type="radio" name="gm" value="branch" data-change="set-git" ${cfg && cfg.git.mode === 'branch' ? 'checked' : ''}><b>${icon('branch')}Branch in your checkout</b><span>Your repos switch to the task branch; they must be clean. One task at a time.</span></label>
              <label class="radio-card ${cfg && cfg.git.mode === 'worktree' ? 'on' : ''}"><input type="radio" name="gm" value="worktree" data-change="set-git" ${cfg && cfg.git.mode === 'worktree' ? 'checked' : ''}><b>${icon('folder')}Worktree per task</b><span>Each task gets its own copy in <code>.orch/worktrees</code>. Your checkouts stay untouched; tasks run in parallel.</span></label>
            </div>
          </div>
          <div class="field-row three">
            <label class="field"><span>Review rounds ${tag(['limits', 'reviewRounds'])}</span><input class="input" type="number" min="0" max="20" data-change="set-number" data-path="limits.reviewRounds" value="${cfg ? cfg.limits.reviewRounds : 2}"><small class="muted">fix rounds before you are asked</small></label>
            <label class="field"><span>Check attempts ${tag(['limits', 'gateAttempts'])}</span><input class="input" type="number" min="1" max="20" data-change="set-number" data-path="limits.gateAttempts" value="${cfg ? cfg.limits.gateAttempts : 3}"><small class="muted">red checks fed back to the agent</small></label>
            <label class="field"><span>Budget per task, $ ${tag(['limits', 'budgetUsd'])}</span><input class="input" type="number" min="0" step="1" data-change="set-number" data-path="limits.budgetUsd" value="${cfg && cfg.limits.budgetUsd !== undefined ? cfg.limits.budgetUsd : ''}" placeholder="no limit"><small class="muted">the task stops when spent</small></label>
          </div>
        </section>

        <section class="card settings-card" id="sec-workspace"><h3>${icon('folder')}Workspace</h3>
          <div class="field"><span>Folder with the repos and <code>.claudestrator/</code> <span class="muted">${s.workspaceFolder ? 'chosen here' : 'the first folder open in VS Code'}</span></span>
            <div class="input-row"><input class="input mono" value="${esc(s.root || '')}" readonly><button class="btn sm" data-action="pick-workspace">${icon('folder')}Browse…</button>${s.workspaceFolder ? '<button class="btn ghost sm" data-action="reset-workspace">Use the open folder</button>' : ''}</div>
            <small class="muted">Tasks live in <code>.orch/</code> of this folder. Repositories can also live elsewhere: add them under Repos &amp; checks.</small></div>
        </section>

        <section class="card settings-card" id="sec-safety"><h3>${icon('shield')}Safety</h3>
          <p class="muted small">Always enforced: agents never commit, push, switch branches or run destructive git/rm commands, and edit files only inside the repo of their step. Claudestrator itself never force-pushes, never merges PRs and pushes only after you confirm.</p>
          <label class="check-line"><input type="checkbox" data-change="set-setting" data-key="askPermissions" ${s.askPermissions ? 'checked' : ''}><span><b>Ask me</b> before an agent edits a file or runs a command <span class="muted">(otherwise the rules above decide)</span></span></label>
          <label class="check-line"><input type="checkbox" data-change="set-bool" data-path="policy.draftPrsOnly" ${!cfg || cfg.policy.draftPrsOnly ? 'checked' : ''}><span>Open PRs as drafts only</span></label>
          <label class="check-line"><input type="checkbox" data-change="set-bool" data-path="policy.forbidAiAttribution" ${cfg && cfg.policy.forbidAiAttribution ? 'checked' : ''}><span>No AI attribution (co-author lines, "generated with") in commits and PRs</span></label>
          <label class="check-line"><input type="checkbox" data-change="set-bool" data-path="policy.allowNoVerify" ${cfg && cfg.policy.allowNoVerify ? 'checked' : ''}><span>Allow skipping git hooks (<code>--no-verify</code>)</span></label>
          <label class="field"><span>Protected branches <span class="muted">nobody commits on or pushes to directly</span></span><input class="input mono" data-change="set-list" data-path="policy.protectedBranches" value="${esc(cfg ? cfg.policy.protectedBranches.join(', ') : 'main, master')}"></label>
        </section>

        <section class="card settings-card" id="sec-claude"><h3>${icon('bot')}Claude Code</h3>
          <div class="tool-check ${claude && claude.ok ? 'ok' : 'bad'}">${icon(claude && claude.ok ? 'check' : 'alert')}<b>CLI</b><span>${esc(claude ? (claude.ok ? `${claude.version} · ${claude.path}` : claude.error || 'checking…') : 'checking…')}</span><button class="icon-btn" data-action="recheck" title="Check again">${icon('refresh')}</button></div>
          <div class="field-row two">
            <label class="field"><span>CLI path <span class="muted">empty = found on PATH</span></span><div class="input-row"><input class="input mono" data-change="set-setting" data-key="claudePath" value="${esc(s.claudePath || '')}" placeholder="${esc((claude && claude.path) || 'claude')}"><button class="btn sm" data-action="pick-claude">Browse…</button></div></label>
            <label class="field"><span>Account agents run under <span class="muted">${esc(s.account.sourceText)}</span></span><select class="input" data-change="set-setting" data-key="claudeConfigDir">
              <option value="" ${s.account.source !== 'setting' ? 'selected' : ''}>Automatic — now ${esc(s.account.email || s.account.label)} (follows ctx-man / VS Code, else ~/.claude)</option>
              ${s.accounts.map((a) => `<option value="${esc(a.dir)}" ${s.account.source === 'setting' && a.current ? 'selected' : ''}>${esc(a.email || a.label)} — ${esc(a.label)}</option>`).join('')}
            </select></label>
          </div>
          <div class="field"><span>Settings agents load</span>
            <div class="row">${['user', 'project', 'local'].map((src) => `<label class="check-line inline"><input type="checkbox" data-change="set-sources" value="${src}" ${(s.settingSources || []).includes(src) ? 'checked' : ''}><span>${src}</span></label>`).join('')}</div>
            <small class="muted"><b>project</b> brings each repo's CLAUDE.md and .claude rules. Leaving out <b>user</b> keeps your personal plugins and hooks out of the pipeline.</small>
          </div>
        </section>

        <section class="card settings-card" id="sec-atlassian"><h3>${icon('jira')}Jira & Confluence</h3>
          ${s.atlassian.connected ? `<div class="tool-check ok">${icon('check')}<b>Reading tickets</b><span>with the API token below (Jira REST)</span></div>` : s.atlassian.mcp ? `<div class="tool-check ok">${icon('check')}<b>Reading tickets</b><span>through the MCP server “${esc(s.atlassian.mcp.server)}”, signed in with Claude Code. No token needed; a short read-only agent reads each issue (a few cents).</span></div>` : `<div class="tool-check bad">${icon('alert')}<b>Reading tickets</b><span>not set up: sign in to an Atlassian MCP server on the MCP tab, or add an API token below</span><button class="btn sm" data-action="nav" data-name="mcp">${icon('plug')}MCP</button></div>`}
          <p class="muted small">An API token (optional with MCP) makes reading instant and free, and lets Claudestrator post Jira comments. It is kept in VS Code's secret storage. Create one at <a data-href="https://id.atlassian.com/manage-profile/security/api-tokens">id.atlassian.com</a>.</p>
          <div class="field-row three">
            <label class="field"><span>Site</span><input id="at-site" class="input mono" value="${esc(s.atlassian.site)}" placeholder="acme.atlassian.net"></label>
            <label class="field"><span>Email</span><input id="at-email" class="input" value="${esc(s.atlassian.email)}" placeholder="you@acme.com"></label>
            <label class="field"><span>API token ${s.atlassian.hasToken ? '<span class="badge tone-ok">saved</span>' : s.atlassian.fromEnv ? '<span class="chip small">from env</span>' : ''}</span><input id="at-token" class="input mono" type="password" placeholder="${s.atlassian.hasToken ? '•••••••• (leave empty to keep)' : 'paste the token'}"></label>
          </div>
          <div class="row"><button class="btn primary sm" data-action="at-save">${icon('check')}Save</button><button class="btn sm" data-action="at-test" ${s.atlassian.connected ? '' : 'disabled'}>${icon('zap')}Test connection</button>${s.atlassian.hasToken ? `<button class="btn ghost sm danger" data-action="at-forget">Forget token</button>` : ''}</div>
          <label class="field"><span>Allowed Jira projects ${tag(['jira', 'allowedProjects'])}<span class="muted">empty = any</span></span><input class="input mono" data-change="set-list" data-path="jira.allowedProjects" value="${esc(cfg ? cfg.jira.allowedProjects.join(', ') : '')}" placeholder="CP, OPS"></label>
        </section>

        <section class="card settings-card"><h3>${icon('bell')}Notifications</h3>
          <select class="input" data-change="set-setting" data-key="notifications">
            ${[['all', 'When a task needs you, finishes or fails'], ['needsYou', 'Only when a task needs you'], ['off', 'Never']].map(([v, l]) => `<option value="${v}" ${s.notifications === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </section>

        <section class="card settings-card"><h3>${icon('file')}Config files</h3>
          <p class="muted small">Layers, each overriding the one before field by field: built-in defaults → your user config → this workspace's config.</p>
          <div class="row"><button class="btn sm" data-action="open-config">${icon('edit')}Workspace config.yaml</button><button class="btn ghost sm" data-action="open-user-config">${icon('user')}User config.yaml</button></div>
        </section>`
      );
    },
    actions: {
      'pick-workspace': async () => {
        const dir = await attempt('pickWorkspace');
        if (!dir) return;
        toast(`Workspace: ${dir}`, 'ok');
        await window.CS.loadOverview();
        views.settings.load();
      },
      'reset-workspace': async () => {
        await attempt('updateSetting', { key: 'workspaceFolder', value: '' });
        await window.CS.loadOverview();
        views.settings.load();
      },
      'pick-claude': async () => {
        await attempt('pickClaude');
        views.settings.load();
      },
      'open-user-config': () => attempt('openConfig', { which: 'user' }),
      'at-save': async () => {
        const token = $<HTMLInputElement>('#at-token')!.value.trim();
        if (await save('saveAtlassian', { site: $<HTMLInputElement>('#at-site')!.value, email: $<HTMLInputElement>('#at-email')!.value, ...(token && { token }) })) views.settings.load();
      },
      'at-forget': async () => {
        if (await save('saveAtlassian', { site: $<HTMLInputElement>('#at-site')!.value, email: $<HTMLInputElement>('#at-email')!.value, token: '' }, 'Token removed')) views.settings.load();
      },
      'at-test': async () => {
        const me = await attempt('testAtlassian');
        if (me) toast(`Connected as ${me.name}${me.email ? ` (${me.email})` : ''}`, 'ok');
      },
    },
    changes: {
      'set-language': async (el) => {
        const value = el.value;
        if (value === '__other') {
          el.insertAdjacentHTML('afterend', '<input class="input" data-change="set-value" data-path="language" placeholder="e.g. Czech" autofocus>');
          const input = el.nextElementSibling;
          if (input instanceof HTMLElement) input.focus();
          return;
        }
        if (await save('setValue', { keyPath: ['language'], value: value === 'English' ? undefined : value })) views.settings.load();
      },
      'set-value': async (el) => {
        const keyPath = el.dataset.path.split('.');
        if (await save('setValue', { keyPath, value: el.value.trim() || undefined })) views.settings.load();
      },
      'set-number': async (el) => {
        const keyPath = el.dataset.path.split('.');
        const raw = el.value.trim();
        const value = raw === '' ? undefined : Number(raw);
        if (value !== undefined && Number.isNaN(value)) return toast('Enter a number', 'warn');
        if (await save('setValue', { keyPath, value: keyPath[1] === 'budgetUsd' && value === 0 ? undefined : value })) views.settings.load();
      },
      'set-bool': async (el) => {
        if (await save('setValue', { keyPath: el.dataset.path.split('.'), value: el.checked })) views.settings.load();
      },
      'set-list': async (el) => {
        const value = el.value.split(/[\s,]+/).filter(Boolean);
        if (await save('setValue', { keyPath: el.dataset.path.split('.'), value: value.length ? value : undefined })) views.settings.load();
      },
      'set-git': async (el) => {
        if (await save('setValue', { keyPath: ['git', 'mode'], value: el.value === 'branch' ? undefined : el.value }, `New tasks use ${el.value === 'branch' ? 'branches in your checkouts' : 'worktrees'}`)) views.settings.load();
      },
      'set-setting': async (el) => {
        const value = el.type === 'checkbox' ? el.checked : el.value.trim();
        if (await save('updateSetting', { key: el.dataset.key, value })) views.settings.load();
      },
      'set-sources': async () => {
        const value = $$<HTMLInputElement>('[data-change="set-sources"]').filter((c) => c.checked).map((c) => c.value);
        if (await save('updateSetting', { key: 'settingSources', value })) views.settings.load();
      },
    },
  };

  // ---------- MCP servers ----------

  interface McpLabel {
    label: string;
    hint: string;
  }
  const MCP_INSTALLED: McpLabel = { label: 'Configured', hint: 'not checked yet, disabled, or waiting for approval' };
  const MCP_STATE: Record<string, McpLabel> = {
    connected: { label: 'Connected', hint: 'working' },
    installed: MCP_INSTALLED,
    needs_auth: { label: 'Needs sign-in', hint: 'the login expired or never happened' },
    failed: { label: 'Error', hint: 'cannot connect' },
  };
  const MCP_ORDER: Record<string, number> = { failed: 0, needs_auth: 0, installed: 1, connected: 2 };
  const order = (x: McpServerView) => MCP_ORDER[x.state] ?? 3;

  views.mcp = {
    m: null,
    details: {},
    async enter() {
      $('#view')!.innerHTML = `<div class="page mcp-page" data-region="mcp"></div>`;
      this.details = {};
      await this.load();
    },
    async load(refresh) {
      this.m = await call('mcp', { refresh: Boolean(refresh) });
      this.render();
    },
    refresh() {
      return Promise.all([window.CS.loadOverview(), this.load()]);
    },
    render() {
      const m = this.m;
      if (!m) return;
      const servers = [...m.servers].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
      const count = (st: string) => servers.filter((x) => x.state === st).length;
      patch(
        'mcp',
        `<div class="page-head"><div><h1>${icon('plug')}MCP servers</h1>
          <p class="lead">Connections to external tools (Jira, Grafana, docs…) that Claude Code and the agents can use. The check runs <code>claude mcp list</code>, which contacts every server.</p>
          ${m.account ? `<div class="acc-line">${icon('user')}Account <b>${esc(m.account.email || m.account.label)}</b><span class="muted small">${esc(m.account.shownDir.replace(/^\/Users\/[^/]+/, '~'))} · ${esc(m.account.sourceText)}</span><button class="link small" data-action="open-account-menu">Switch account</button></div>` : ''}</div>
          <div class="row"><span class="muted small">${m.checking ? '<span class="spinner xs"></span> checking…' : m.checkedAt ? `checked ${ago(m.checkedAt)}` : ''}</span><button class="btn" data-action="mcp-refresh" ${m.checking ? 'disabled' : ''}>${icon('refresh')}Check again</button></div></div>
        <div class="mcp-legend">
          <span><span class="mcp-dot s-connected"></span>connected · ${count('connected')}</span>
          <span><span class="mcp-dot s-installed"></span>configured, not checked · ${count('installed')}</span>
          <span><span class="mcp-dot s-failed"></span>error or needs sign-in · ${count('failed') + count('needs_auth')}</span>
        </div>
        ${m.error ? `<div class="banner error">${icon('alert')}<div class="grow"><b>The check failed.</b><pre class="log small">${esc(m.error)}</pre></div></div>` : ''}
        ${servers.length ? `<div class="mcp-list">${servers.map((x) => this.row(x, m.checking)).join('')}</div>` : `<div class="empty-state">${icon('plug', 'big')}<h2>No MCP servers configured</h2><p>Add one in a terminal, e.g. <code>claude mcp add --transport http sentry https://mcp.sentry.dev/mcp</code>, then check again.</p></div>`}`
      );
    },
    row(x, checking) {
      const st = MCP_STATE[x.state] || MCP_INSTALLED;
      const detailText = x.disabled ? 'disabled for this project' : x.pending ? 'waiting for your approval in Claude Code' : x.detail && x.detail.toLowerCase() !== st.label.toLowerCase() ? x.detail : '';
      const label = x.missing ? 'Not loaded' : st.label;
      const plugin = x.name.startsWith('plugin:') ? x.name.split(':')[1] : null;
      const bad = x.state === 'failed' || x.state === 'needs_auth';
      const login = x.login;
      const opened = this.details[x.name];
      return `<div class="mcp-row s-${x.state}">
        <div class="mcp-main">
          <span class="mcp-dot s-${x.state} ${checking && x.state === 'installed' ? 'checking' : ''}" title="${esc(`${st.label}: ${st.hint}`)}"></span>
          <span class="mcp-name">${esc(x.name)}</span>${plugin ? `<span class="muted small" title="Claude Code loads this server from an installed plugin; it is not part of this VS Code extension">from the Claude Code plugin “${esc(plugin)}”</span>` : ''}
          <span class="chip small">${esc(x.scope)}</span>
          ${x.transport ? `<span class="chip small mono">${esc(x.transport)}</span>` : ''}
          ${x.target ? `<span class="mcp-target" title="${esc(x.target)}">${esc(x.target)}</span>` : ''}
          <span class="mcp-state s-${x.state} ${x.missing ? 'missing' : ''}">${esc(label)}${detailText ? `<span class="muted"> · ${esc(detailText)}</span>` : ''}</span>
          <span class="mcp-actions">
            ${x.canLogin ? (login ? `<button class="btn sm" data-action="mcp-show-login" data-name="${esc(x.name)}">${icon('terminal')}Show terminal</button><button class="btn ghost sm" data-action="mcp-cancel" data-name="${esc(x.name)}">${icon('x')}Cancel</button>` : `<button class="btn ${bad ? 'primary' : 'ghost'} sm" data-action="mcp-login" data-name="${esc(x.name)}" title="Runs claude mcp login: the provider's sign-in page opens in your browser">${icon('key')}${x.state === 'connected' ? 'Sign in again' : 'Sign in'}</button>`) : ''}
            <button class="btn ghost sm" data-action="mcp-details" data-name="${esc(x.name)}">${icon(opened ? 'x' : 'info')}${opened ? 'Hide' : 'Details'}</button>
          </span>
        </div>
        ${login ? `<div class="mcp-login"><span class="spinner xs"></span> A terminal is running <code>claude mcp login ${esc(x.name)}</code>. Finish the sign-in in the browser it opens; if the terminal asks for the redirect URL, paste it there. The list checks again when it is done.</div>` : ''}
        ${opened ? `<pre class="log small">${esc(opened === true ? 'Loading…' : opened)}</pre>` : ''}
      </div>`;
    },
    actions: {
      'mcp-refresh': async () => {
        await views.mcp.load(true);
      },
      'mcp-login': async (el) => {
        el.disabled = true;
        if ((await attempt('mcpLogin', { name: el.dataset.name })) !== undefined) views.mcp.load();
        else el.disabled = false;
      },
      'mcp-show-login': (el) => attempt('mcpShowLogin', { name: el.dataset.name }),
      'mcp-cancel': async (el) => {
        await attempt('mcpCancelLogin', { name: el.dataset.name });
        views.mcp.load();
      },
      'mcp-details': async (el) => {
        const v = views.mcp;
        const name = el.dataset.name;
        if (v.details[name]) {
          delete v.details[name];
          return v.render();
        }
        v.details[name] = true;
        v.render();
        const text = await attempt('mcpDetails', { name });
        v.details[name] = text || '(no details)';
        v.render();
      },
    },
  };

  window.CS.boot();
})();
