// A custom scenario drawn as a diagram: the ticket, its steps top to bottom, the approvals and the review loop the
// steps' outputs make, and how it finishes. Changes stay on the page until Save writes them to config.yaml as the
// scenario's `agents:`, the same list the Scenarios page edits as chips.

type DgConfig = Extract<ConfigData, { ok: true }>;
type DgPreview = Rpc['previewScenario']['result'];

/** The scenario being drawn: what Save writes. `id` is null until a new one is saved. */
interface DiagramDraft {
  id: string | null;
  label: string;
  description: string;
  steps: ScenarioStep[];
  intake: { model?: string; effort?: Effort };
  dirty: boolean;
}

/** What the right column shows: the scenario, the ticket, a step, or a new agent for the arrow at `at`. */
type DgSelection = { kind: 'scenario' } | { kind: 'start' } | { kind: 'step'; i: number } | { kind: 'create'; at: number };

interface DiagramView extends View {
  c: DgConfig | null;
  preview: DgPreview | null;
  sel: DgSelection;
  zoom: number;
  /** The arrow whose add menu is open. */
  adding: number | null;
  query: string;
  draft(): DiagramDraft;
  load(): Promise<void>;
  render(): void;
  renderFlow(): void;
  renderSide(): void;
  renderHead(): void;
  change(fn: (d: DiagramDraft) => void, opts?: { side?: boolean }): void;
  save(): Promise<boolean>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Views {
  'scenario-diagram': DiagramView;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface UiState {
  /** The diagram on screen with its unsaved changes, so a reload of the page keeps them. */
  diagram?: DiagramDraft | null;
}

(function () {
  const { call, attempt, toast, icon, esc, $, plural, OUTPUT_INFO, agentColor, views, patch, debounce, persist, modelChoices, go, S, loadOverview, EFFORT_LABEL } = window.CS;
  const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  const REPORTS = ['readiness', 'audit'];
  const asEffort = (v: string) => EFFORTS.find((e) => e === v);
  const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25];

  const v = () => views['scenario-diagram'];
  const agentOf = (name: string) => v().c?.agents.find((a) => a.name === name);
  const outputLabel = (o: string) => (OUTPUT_INFO[o] || { label: o }).label;

  /** What the steps make of the scenario: a report of one kind, delivery, or nothing yet. */
  function kindOf(steps: readonly ScenarioStep[]): string | null {
    const outputs = steps.map((st) => agentOf(st.name)?.output).filter((o): o is Output => Boolean(o));
    return outputs.find((o) => REPORTS.includes(o)) || (outputs.length ? 'deliver' : null);
  }
  /** Why an agent cannot join these steps, or '' when it can: one kind per scenario. */
  function misfit(a: AgentView, steps: readonly ScenarioStep[]): string {
    const kind = kindOf(steps);
    if (!kind) return '';
    if (REPORTS.includes(kind)) return a.output === kind ? '' : `This scenario writes a ${kind} report; only ${kind} agents join it`;
    return REPORTS.includes(a.output) ? 'Report agents make their own scenario; this one changes code' : '';
  }

  function fromConfig(c: DgConfig, id: string): DiagramDraft | null {
    const sc = c.config.custom[id];
    if (!sc) return null;
    return { id, label: sc.label, description: sc.description || '', steps: sc.agents.map((st) => ({ ...st })), intake: { ...sc.intake }, dirty: false };
  }
  function fresh(c: DgConfig): DiagramDraft {
    const labels = new Set(Object.values(c.config.custom).map((x) => x.label.toLowerCase()));
    let label = 'New scenario';
    for (let n = 2; labels.has(label.toLowerCase()); n++) label = `New scenario ${n}`;
    return { id: null, label, description: '', steps: [], intake: {}, dirty: false };
  }

  /** The stage the route gives a step, if it runs: a turned-off agent has none. */
  const stageOf = (name: string) => v().preview?.pipeline.stages.find((s) => s.agent === name);
  const SCOPE_TEXT: Record<string, string> = { repo: 'per repo', repos: 'all repos', task: 'once' };

  function modelOptions(own: string | undefined, fallback: string) {
    const c = v().c;
    const models = modelChoices(c ? c.defaults : null).filter(([m]) => m !== 'inherit');
    const known = !own || models.some(([m]) => m === own);
    return [`<option value="">${esc(fallback)}</option>`, ...models.map(([m, l]) => `<option value="${esc(m)}" ${m === own ? 'selected' : ''}>${esc(l)}</option>`), ...(known ? [] : [`<option value="${esc(own)}" selected>${esc(own)}</option>`])].join('');
  }
  function effortOptions(own: string | undefined, fallback: string) {
    return [`<option value="">${esc(fallback)}</option>`, ...EFFORTS.map((e) => `<option value="${e}" ${e === own ? 'selected' : ''}>${esc(EFFORT_LABEL[e] || e)}</option>`)].join('');
  }

  // ---------- the canvas ----------

  function edgeHtml(at: number, d: DiagramDraft, label = '') {
    const v0 = v();
    const open = v0.adding === at;
    const between = at === 0 ? 'the ticket' : d.steps[at - 1]!.name;
    const and = at === d.steps.length ? 'Finish' : d.steps[at]!.name;
    return `<div class="dg-edge" data-i="${at}">${label ? `<span class="chip small dg-edge-label">${esc(label)}</span>` : ''}
      <span class="menu-wrap dg-add-wrap ${open ? 'open' : ''}">
        <button class="dg-add" data-action="dg-add" data-i="${at}" title="Add a step here" aria-label="Add a step between ${esc(between)} and ${esc(and)}">${icon('plus')}</button>
        ${open ? addMenuHtml(at, d, between, and) : ''}
      </span>
    </div>`;
  }

  function addMenuHtml(at: number, d: DiagramDraft, between: string, and: string) {
    const c = v().c;
    if (!c) return '';
    const q = v().query.trim().toLowerCase();
    const taken = new Set(d.steps.map((st) => st.name));
    const list = c.agents.filter((a) => !taken.has(a.name) && (!q || a.name.includes(q) || a.description.toLowerCase().includes(q)));
    const later = (ic: string, label: string, hint: string, stage: number) => `<div class="dg-menu-later" title="Comes in a later version">${icon(ic)}<span class="grow"><b>${label}</b><span class="muted small">${hint}</span></span><span class="chip small dg-later">${icon('clock')}later · stage ${stage}</span></div>`;
    return `<div class="menu dg-menu" role="menu">
      <div class="muted small dg-menu-title">Add a step between ${esc(between)} and ${esc(and)}</div>
      <input class="input sm" data-input="dg-query" value="${esc(v().query)}" placeholder="Search agents" aria-label="Search agents">
      <h4>Agents</h4>
      <div class="dg-menu-list">
        ${list
          .map((a) => {
            const why = misfit(a, d.steps);
            return `<button class="${agentColor(a.color)}" data-action="dg-insert" data-i="${at}" data-name="${esc(a.name)}" ${why ? `disabled title="${esc(why)}"` : `title="${esc(a.description)}"`}><span class="adot"></span><span class="grow"><b>${esc(a.name)}</b><span class="muted small">${esc(a.description)}${a.enabled ? '' : ' · turned off'}</span></span><span class="chip small">${esc(outputLabel(a.output))}</span></button>`;
          })
          .join('') || `<div class="muted small dg-menu-empty">${q ? 'No agent matches.' : 'Every agent is in this scenario already.'}</div>`}
      </div>
      <button class="dg-create" data-action="dg-create" data-i="${at}">${icon('plus')}Create agent…</button>
      <h4>Flow</h4>
      ${later('user', 'You approve', 'The task waits for you here', 3)}
      ${later('activity', 'Parallel', 'Start several read-only agents together', 2)}
      ${later('branch', 'Branch', 'If / otherwise on what an agent reported', 3)}
      ${later('refresh', 'Loop', 'Repeat a chain until a condition holds', 3)}
    </div>`;
  }

  function stepHtml(st: ScenarioStep, i: number) {
    const a = agentOf(st.name);
    const stage = stageOf(st.name);
    const sel = v().sel;
    const on = sel.kind === 'step' && sel.i === i;
    if (!a) {
      return `<div class="dg-node dg-step bad ${on ? 'selected' : ''}" data-action="dg-select" data-i="${i}" tabindex="0" draggable="true">
        <div class="dg-node-head"><b>${esc(st.name)}</b></div><div class="dg-node-sub err">${icon('alert')}No such agent in config.yaml</div></div>`;
    }
    const model = st.model || a.model;
    const effort = st.effort || a.effort || '';
    const sub = a.enabled ? [stage ? SCOPE_TEXT[stage.scope] : '', model, effort].filter(Boolean).join(' · ') : 'turned off · skipped when it runs';
    const note = (st.instructions || '').trim().split('\n')[0];
    return `<div class="dg-node dg-step ${agentColor(a.color)} ${on ? 'selected' : ''} ${a.enabled ? '' : 'off'}" data-action="dg-select" data-i="${i}" tabindex="0" draggable="true" aria-label="Step ${i + 1}: ${esc(st.name)}">
      <div class="dg-node-head"><span class="adot"></span><b>${esc(st.name)}</b><span class="chip small">${esc(outputLabel(a.output))}</span></div>
      <div class="dg-node-sub">${esc(sub)}</div>
      ${note ? `<div class="dg-node-note">${icon(st.instructionsFile ? 'file' : 'text')}<span>${esc(note)}</span></div>` : ''}
    </div>`;
  }

  function flowHtml(d: DiagramDraft) {
    const p = v().preview;
    const sel = v().sel;
    const loop = p && p.pipeline.reviewLoop;
    const stages = p ? p.pipeline.stages : [];
    // The review loop runs from the step of its first stage to the step of its last.
    const loopFrom = loop ? d.steps.findIndex((st) => st.name === stages[loop.restartAt]?.agent) : -1;
    const loopTo = loop ? d.steps.findIndex((st) => st.name === stages[loop.end]?.agent) : -1;
    const kind = kindOf(d.steps);
    const start = `<div class="dg-node dg-pill ${sel.kind === 'start' ? 'selected' : ''}" data-action="dg-start" tabindex="0">${icon('inbox')}<b>Ticket</b><span class="grow"></span><span class="chip small">Jira · Confluence · text</span></div>`;
    const finish = `<div class="dg-node dg-pill dg-finish">${icon('commit')}<b>Finish</b><span class="muted">${esc(!kind ? 'decided by the steps: PRs or a report' : REPORTS.includes(kind) ? `${kind} report` : 'commit → you confirm push → draft PRs')}</span></div>`;
    if (!d.steps.length) {
      return `${start}<div class="dg-line"></div>
        <div class="dg-first">
          ${icon('plus', 'big')}<b>Add the first step</b>
          <span class="muted small">A scenario is written to config.yaml with its first step.</span>
          <div class="row"><span class="menu-wrap dg-add-wrap ${v().adding === 0 ? 'open' : ''}"><button class="btn sm" data-action="dg-add" data-i="0">${icon('users')}Pick an agent</button>${v().adding === 0 ? addMenuHtml(0, d, 'the ticket', 'Finish') : ''}</span><button class="btn ghost sm" data-action="dg-create" data-i="0">${icon('plus')}Create agent</button></div>
        </div><div class="dg-line"></div>${finish}`;
    }
    let html = start + edgeHtml(0, d);
    let frame = '';
    d.steps.forEach((st, i) => {
      let node = stepHtml(st, i);
      if (stageOf(st.name)?.approval) node += `<div class="dg-line short"></div><div class="dg-node dg-pill dg-derived" title="Made from the step's output: a plan waits for you before anything changes">${icon('user')}<b>You approve the plan</b><span class="grow"></span><span class="chip small">auto · after a plan</span></div>`;
      if (!loop || loopFrom === -1 || loopTo < loopFrom || i < loopFrom || i > loopTo) {
        html += node + edgeHtml(i + 1, d);
        return;
      }
      if (i === loopFrom) frame = `<div class="dg-loop" title="Made from the steps' outputs: code is reviewed, and changes requested send it back">
          <div class="dg-loop-head">${icon('refresh')}<b>Review loop</b><span class="muted small">until every reviewer approves · up to ${plural(loop.maxRounds, 'round')}</span><span class="grow"></span><span class="chip small">built from outputs</span></div>`;
      frame += node;
      if (i < loopTo) frame += edgeHtml(i + 1, d);
      else html += `${frame}<div class="dg-loop-foot">${icon('back')}changes requested → fix round</div></div>${edgeHtml(i + 1, d, 'approved')}`;
    });
    return html + finish;
  }

  // ---------- the right column ----------

  function scenarioSide(d: DiagramDraft) {
    const c = v().c!;
    const kind = kindOf(d.steps);
    const src = d.id ? c.config.custom[d.id]?.source : 'project';
    const lib = src && src.startsWith('library:') ? src.slice('library:'.length) : '';
    return `<section class="card dg-side-card">
      <h4>Scenario</h4>
      <label class="field"><span>Name</span><input class="input" data-input="dg-label" value="${esc(d.label)}" maxlength="60" placeholder="e.g. Ship with security review"></label>
      <label class="field"><span>Description <span class="muted">(optional, shown in the menu)</span></span><textarea class="input autosize" rows="2" data-input="dg-desc" placeholder="What it is for, in a sentence. The composer shows it, and it helps your words pick it.">${esc(d.description)}</textarea></label>
      <div class="field"><span>Runs as</span><div class="dg-fact">${icon(kind && REPORTS.includes(kind) ? 'checklist' : 'commit')}<span><b>${kind === 'readiness' ? 'Readiness: a read-only report' : kind === 'audit' ? 'Audit: a read-only report' : 'Delivery: changes code, ends with draft PRs'}</b><span class="muted small">Decided by the agents you add: report agents (readiness, audit) make it a report scenario. One kind per scenario.</span></span></div></div>
      <div class="field"><span>Saved in</span><span class="muted small">${lib ? `From the library ${esc(lib)}: a change is kept in this project's .claudestrator/config.yaml, the library stays as it is.` : '.claudestrator/config.yaml of this project'}</span></div>
    </section>
    <section class="card dg-side-card dg-keys">
      <h4>Keys</h4>
      <div class="muted small">Click a node: its settings here</div>
      <div class="muted small">+ on an arrow: add a step there</div>
      <div class="muted small">Drag a step onto an arrow: move it</div>
      <div class="muted small">↑ ↓ select · Del remove · Ctrl+S save · Esc back here</div>
    </section>`;
  }

  function startSide(d: DiagramDraft) {
    const c = v().c!;
    const def = c.config.intake;
    return `<section class="card dg-side-card">
      <div class="dg-side-head"><span class="muted small">START</span><button class="icon-btn" data-action="dg-deselect" aria-label="Close">${icon('x')}</button></div>
      <h3>${icon('inbox')}Ticket</h3>
      <p class="muted small">What the task begins with. Always first; the composer fills it in.</p>
      <h4>Sources</h4>
      <div class="dg-fact">${icon('message')}<span>Your text<span class="muted small">read as written · no model</span></span></div>
      <div class="dg-fact">${icon('jira')}<span>Jira issue, API token<span class="muted small">read over REST · no model</span></span></div>
      <div class="dg-fact">${icon('plug')}<span>Jira or Confluence via MCP<span class="muted small">an agent reads it · model below</span></span></div>
      <h4>Reading through MCP</h4>
      <div class="field-row two">
        <label class="field"><span>Model</span><select class="input" data-change="dg-intake-model">${modelOptions(d.intake.model, `config's (${def.model})`)}</select></label>
        <label class="field"><span>Effort</span><select class="input" data-change="dg-intake-effort">${effortOptions(d.intake.effort, `config's (${def.effort})`)}</select></label>
      </div>
      <p class="muted small">Only in this scenario. For every task: Integrations → Jira &amp; Confluence (now ${esc(def.model)} · ${esc(def.effort)}). A long Confluence spec reads better with sonnet.</p>
      <h4>Jira</h4>
      <div class="row"><span class="grow">${c.config.jira.allowedProjects.length ? `Allowed projects: ${esc(c.config.jira.allowedProjects.join(', '))}` : '<span class="muted">No Jira projects allowed yet</span>'}</span><button class="btn ghost sm" data-action="dg-settings">Integrations</button></div>
    </section>`;
  }

  function stepSide(d: DiagramDraft, i: number) {
    const st = d.steps[i];
    if (!st) return '';
    const a = agentOf(st.name);
    const stage = stageOf(st.name);
    const loop = v().preview?.pipeline.reviewLoop;
    const inLoop = loop && stage ? (() => {
      const k = v().preview!.pipeline.stages.indexOf(stage);
      return k >= loop.restartAt && k <= loop.end;
    })() : false;
    const others = v().c!.agents.filter((x) => x.name === st.name || (!d.steps.some((s) => s.name === x.name) && !misfit(x, d.steps.filter((_, k) => k !== i))));
    const file = st.instructionsFile ? st.instructionsFile.slice(st.instructionsFile.indexOf('.claudestrator/') + '.claudestrator/'.length) : '';
    const facts = [
      inLoop && a && a.output !== 'verdict' ? `${icon('refresh')}Runs again in every fix round, with the reviewers' findings.` : '',
      inLoop && a && a.output === 'verdict' ? `${icon('refresh')}Its blocking findings send the work back for a fix round.` : '',
      stage && stage.approval ? `${icon('user')}Its plan waits for you before anything changes.` : '',
      a && (a.output === 'code' || a.output === 'tests') ? `${icon('folder')}Branches, commits and opens draft PRs in the plan's repos.` : '',
      a && REPORTS.includes(a.output) ? `${icon('checklist')}Read-only: writes the ${a.output} report.` : '',
      a && !a.enabled ? `${icon('eye')}Turned off in Agents: a task skips it.` : '',
    ].filter(Boolean);
    return `<section class="card dg-side-card">
      <div class="dg-side-head"><span class="muted small">STEP ${i + 1} OF ${d.steps.length}</span><button class="icon-btn" data-action="dg-deselect" aria-label="Close">${icon('x')}</button></div>
      <h3 class="${agentColor(a?.color)}"><span class="adot big"></span>${esc(st.name)}${a ? `<span class="chip small">${esc(outputLabel(a.output))}</span>` : ''}</h3>
      ${a ? `<p class="muted small">${esc(a.description)}</p>` : `<div class="banner error">${icon('alert')}<div>No agent called ${esc(st.name)}. Pick one, or remove the step.</div></div>`}
      <h4>Agent</h4>
      <select class="input" data-change="dg-agent" aria-label="Agent">${a ? '' : `<option selected>${esc(st.name)}</option>`}${others.map((x) => `<option value="${esc(x.name)}" ${x.name === st.name ? 'selected' : ''}>${esc(x.name)} · ${esc(outputLabel(x.output))}</option>`).join('')}</select>
      <div class="row dg-links"><button class="btn ghost sm" data-action="dg-create" data-i="${i + 1}">${icon('plus')}Create agent</button>${a ? `<button class="btn ghost sm" data-action="dg-edit-agent" data-name="${esc(st.name)}">${icon('edit')}Edit ${esc(st.name)}</button>` : ''}</div>
      ${a ? `<h4>Runs</h4><p class="muted small">${stage ? (stage.scope === 'repo' ? 'Once in each repo the plan names, one after another.' : stage.scope === 'repos' ? 'Once, with every repo of the plan in one session.' : 'Once for the task.') : 'Not at all while it is turned off.'} Set for the agent in Agents.</p>
      <div class="field-row two">
        <label class="field"><span>Model</span><select class="input" data-change="dg-model">${modelOptions(st.model, `agent's (${a.model})`)}</select></label>
        <label class="field"><span>Effort</span><select class="input" data-change="dg-effort">${effortOptions(st.effort, `agent's (${a.effort || 'default'})`)}</select></label>
      </div>
      <p class="muted small">Only in this scenario; the agent keeps its own.</p>` : ''}
      <div class="dg-instr-head"><h4>Instructions for this step</h4><button class="btn ghost sm" data-action="dg-open-editor" title="Write them in a file next to config.yaml: better for long ones">${icon('ext')}Open in editor</button></div>
      ${file
        ? `<textarea class="input dg-instr" rows="7" readonly aria-label="Instructions for this step, from ${esc(file)}">${esc(st.instructions || '')}</textarea>
           <p class="muted small">${icon('file')}From <code>${esc(file)}</code>: edit the file; this shows it once it is saved.</p>`
        : `<textarea class="input dg-instr" rows="7" data-input="dg-instructions" placeholder="What this agent should do differently in this scenario, e.g. Keep the change minimal; no drive-by refactors.">${esc(st.instructions || '')}</textarea>
           <p class="muted small">Added after the agent's own instructions and the group's. Open in editor moves them to <code>prompts/${esc(d.id || '<scenario>')}/${esc(st.name)}.md</code>.</p>`}
      ${facts.length ? `<h4>In this scenario</h4>${facts.map((f) => `<div class="dg-fact small">${f}</div>`).join('')}` : ''}
      <div class="row dg-remove"><button class="btn ghost sm danger" data-action="dg-remove" data-i="${i}">${icon('x')}Remove step</button><span class="grow"></span><span class="muted small">↑ ↓ select · Del remove</span></div>
    </section>`;
  }

  function createSide(d: DiagramDraft, at: number) {
    const c = v().c!;
    const where = `${at === 0 ? 'the ticket' : d.steps[at - 1]?.name ?? ''} and ${at >= d.steps.length ? 'Finish' : d.steps[at]!.name}`;
    const base = d.steps[at - 1]?.name || 'reviewer';
    return `<section class="card dg-side-card">
      <div class="dg-side-head"><span class="muted small">NEW AGENT</span><button class="icon-btn" data-action="dg-deselect" aria-label="Close">${icon('x')}</button></div>
      <h3>${icon('plus')}Create agent</h3>
      <p class="muted small">Added to this scenario between ${esc(where)}, and to nothing else. Its instructions open in a file to write.</p>
      <label class="field"><span>Name</span><input id="dg-na-name" class="input mono" placeholder="security-reviewer" spellcheck="false"></label>
      <label class="field"><span>Based on</span><select id="dg-na-base" class="input"><option value="">— nothing, write from scratch —</option>${c.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === base ? 'selected' : ''}>${esc(a.name)} (${esc(outputLabel(a.output))})</option>`).join('')}</select></label>
      <label class="field"><span>Description</span><input id="dg-na-desc" class="input" placeholder="Reviews the diff for security problems only"></label>
      <div class="row end"><button class="btn ghost" data-action="dg-deselect">Cancel</button><button class="btn primary" data-action="dg-create-save" data-i="${at}">${icon('check')}Create & write instructions</button></div>
    </section>`;
  }

  function routeHtml(d: DiagramDraft) {
    const p = v().preview;
    if (!p || !d.steps.length) return '';
    const ok = (t: string) => `<div class="dg-check ok">${icon('check')}<span>${esc(t)}</span></div>`;
    const warn = (t: string) => `<div class="dg-check warn">${icon('alert')}<span>${esc(t)}</span></div>`;
    const off = d.steps.filter((st) => agentOf(st.name)?.enabled === false).map((st) => warn(`${st.name} is turned off in Agents, so a task skips it.`));
    const items = [
      p.pipeline.stages.some((s) => s.approval) ? ok('The plan comes first and is approved by you.') : '',
      p.pipeline.reviewLoop ? ok(`Every change in the loop is reviewed, up to ${plural(p.pipeline.reviewLoop.maxRounds, 'round')}.`) : '',
      ...p.pipeline.warnings.map((w) => warn(w.message)),
      ...off,
    ].filter(Boolean);
    return items.length ? `<section class="card dg-side-card"><h4>Route check</h4>${items.join('')}</section>` : '';
  }

  // ---------- the view ----------

  views['scenario-diagram'] = {
    c: null,
    preview: null,
    sel: { kind: 'scenario' },
    zoom: 1,
    adding: null,
    query: '',
    draft() {
      if (!S.ui.diagram) S.ui.diagram = this.c ? fresh(this.c) : { id: null, label: 'New scenario', description: '', steps: [], intake: {}, dirty: false };
      return S.ui.diagram;
    },
    async enter(route) {
      $('#view')!.innerHTML = `<div class="page dg-page">
        <div data-region="dg-head"></div>
        <div class="dg-layout">
          <div class="dg-canvas" tabindex="-1">
            <div class="dg-bar"><div class="dg-toolbar"><span class="muted small">Add</span><button class="btn ghost sm" data-action="dg-add" data-i="-1" title="Add an agent at the end">${icon('users')}Agent</button><span class="dg-tool-later" title="Comes in a later version">${icon('user')}You approve</span><span class="dg-tool-later" title="Comes in a later version">${icon('activity')}Parallel</span><span class="dg-tool-later" title="Comes in a later version">${icon('branch')}Branch</span><span class="dg-tool-later" title="Comes in a later version">${icon('refresh')}Loop</span></div>
            <div class="dg-zoom"><button class="icon-btn" data-action="dg-zoom" data-level="-1" aria-label="Zoom out">−</button><span class="small" data-region="dg-zoom">100%</span><button class="icon-btn" data-action="dg-zoom" data-level="1" aria-label="Zoom in">${icon('plus')}</button><button class="btn ghost sm" data-action="dg-fit">${icon('eye')}Fit</button></div></div>
            <div class="dg-flow" data-region="dg-flow"></div>
          </div>
          <div class="dg-side" data-region="dg-side"></div>
        </div>
        <div class="dg-foot muted small" data-region="dg-foot"></div>
      </div>`;
      // A reload comes back to the diagram it left, with its changes; another scenario starts over ("New scenario"
      // clears it before it comes here).
      const kept = S.ui.diagram;
      if (kept && kept.id !== (route.scenario || null)) S.ui.diagram = null;
      this.sel = { kind: 'scenario' };
      this.adding = null;
      await this.load();
    },
    async load() {
      const [data] = await Promise.all([call('config'), loadOverview()]);
      this.c = data.ok ? data : null;
      if (!this.c) {
        patch('dg-head', `<h1>${icon('branch')}Scenario diagram</h1><div class="banner error">${icon('alert')}<div><b>The config has errors, so the diagram cannot be drawn.</b>${data.ok ? '' : `<ul>${data.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`}</div><button class="btn sm" data-action="open-config">Open config.yaml</button></div>`);
        return;
      }
      const d = S.ui.diagram;
      if (d && d.id && !this.c.config.custom[d.id]) S.ui.diagram = null; // deleted elsewhere
      const route = S.route.scenario;
      if (!S.ui.diagram && route) S.ui.diagram = fromConfig(this.c, route);
      const now = this.draft();
      if (now.id && !now.dirty) S.ui.diagram = fromConfig(this.c, now.id);
      else if (now.id) {
        // Unsaved changes stay; a step whose instructions are in a file shows the file as it is now.
        const saved = this.c.config.custom[now.id]!.agents;
        for (const st of now.steps) {
          const there = saved.find((x) => x.name === st.name);
          if (st.instructionsFile && there && there.instructionsFile === st.instructionsFile) st.instructions = there.instructions ?? '';
        }
      }
      persist();
      await refreshPreview();
      this.render();
    },
    refresh() {
      return this.load();
    },
    onConfig() {
      void this.load();
    },
    leave() {
      this.adding = null;
    },
    render() {
      this.renderHead();
      this.renderFlow();
      this.renderSide();
    },
    renderHead() {
      const d = this.draft();
      const errors = d.steps.filter((st) => !agentOf(st.name)).length;
      patch(
        'dg-head',
        `<div class="dg-head">
          <button class="btn ghost sm" data-action="dg-back">${icon('back')}Scenarios</button>
          <span class="dg-head-sep"></span>
          <h1>${icon('branch')}<span class="dg-title">${esc(d.label || 'New scenario')}</span></h1>
          <span class="chip small">diagram</span>
          ${d.dirty || !d.id ? `<span class="chip small dg-unsaved">${d.id ? 'unsaved changes' : 'not saved yet'}</span>` : ''}
          ${errors ? `<span class="chip small dg-problems">${icon('alert')}${plural(errors, 'problem')}</span>` : ''}
          <span class="grow"></span>
          ${d.id ? `<button class="btn ghost sm" data-action="dg-list" title="The same scenario as chips on the Scenarios page">${icon('list')}List view</button>` : ''}
          <button class="btn sm" data-action="dg-use" ${d.id && !d.dirty && !errors ? '' : 'disabled title="Save it first"'}>${icon('play')}Use in a new task</button>
          <button class="btn primary sm" data-action="dg-save" ${d.steps.length && (d.dirty || !d.id) ? '' : 'disabled'} title="${d.steps.length ? 'Write it to .claudestrator/config.yaml (Ctrl+S)' : 'Add a step first: an empty scenario writes nothing'}">${icon('check')}Save</button>
        </div>
        <p class="muted small dg-lead">${esc(d.description || (d.id ? 'No description.' : 'Saved with its first step: a scenario you leave empty writes nothing to config.yaml.'))}</p>`
      );
      const runs = d.steps.filter((st) => agentOf(st.name)?.enabled).length;
      const loop = this.preview?.pipeline.reviewLoop;
      patch('dg-foot', `<span>${icon('activity')}${plural(runs, 'step')} that run${loop ? ` · up to ${plural(loop.maxRounds, 'review round')}` : ''}</span><span class="grow"></span><span>Saved to .claudestrator/config.yaml as the scenario's <code>agents:</code></span>`);
    },
    renderFlow() {
      patch('dg-flow', flowHtml(this.draft()));
      const flow = $('.dg-flow');
      if (flow) flow.style.transform = this.zoom === 1 ? '' : `scale(${this.zoom})`;
      patch('dg-zoom', `${Math.round(this.zoom * 100)}%`);
    },
    renderSide() {
      const d = this.draft();
      const sel = this.sel;
      const main = sel.kind === 'start' ? startSide(d) : sel.kind === 'step' ? stepSide(d, sel.i) : sel.kind === 'create' ? createSide(d, sel.at) : scenarioSide(d);
      patch('dg-side', main + routeHtml(d));
    },
    /** Applies a change to the draft and draws it; the right column only when `side` (typing there keeps it). */
    change(fn, { side = true } = {}) {
      const d = this.draft();
      fn(d);
      d.dirty = true;
      persist();
      this.renderHead();
      this.renderFlow();
      if (side) this.renderSide();
      debounce('dg-preview', async () => {
        await refreshPreview();
        this.renderHead();
        this.renderFlow();
        this.renderSide();
      }, 120);
    },
    async save() {
      const d = this.draft();
      if (!d.steps.length) return false;
      const intake = d.intake.model || d.intake.effort ? d.intake : undefined;
      const r = await attempt('saveScenario', { id: d.id || undefined, label: d.label, description: d.description || undefined, agents: d.steps, intake });
      if (!r) return false;
      d.id = r.id;
      d.dirty = false;
      S.ui.scEdit = r.id;
      S.ui.scDraft = null;
      S.route = { name: 'scenario-diagram', scenario: r.id };
      persist();
      toast(`${d.label} saved`, 'ok');
      await this.load();
      return true;
    },
    actions: {
      'dg-select': (el) => select({ kind: 'step', i: Number(el.dataset.i) }),
      'dg-start': () => select({ kind: 'start' }),
      'dg-deselect': () => select({ kind: 'scenario' }),
      'dg-add': (el) => {
        const view = v();
        const at = Number(el.dataset.i) < 0 ? view.draft().steps.length : Number(el.dataset.i);
        view.adding = view.adding === at ? null : at;
        view.query = '';
        view.renderFlow();
        $('.dg-menu')?.scrollIntoView({ block: 'nearest' });
        $<HTMLInputElement>('.dg-menu input')?.focus();
      },
      'dg-insert': (el) => {
        const view = v();
        const at = Number(el.dataset.i);
        view.adding = null;
        view.change((d) => d.steps.splice(at, 0, { name: el.dataset.name }), { side: false });
        select({ kind: 'step', i: at });
      },
      'dg-create': (el) => {
        v().adding = null;
        v().renderFlow();
        select({ kind: 'create', at: Number(el.dataset.i) });
        $<HTMLInputElement>('#dg-na-name')?.focus();
      },
      'dg-create-save': async (el) => {
        const val = (id: string) => $<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value.trim() ?? '';
        const name = val('dg-na-name');
        const ok = await attempt('newAgent', { name, base: val('dg-na-base') || undefined, description: val('dg-na-desc') || undefined, standalone: true }, null);
        if (!ok) return;
        const view = v();
        await view.load();
        const at = Math.min(Number(el.dataset.i), view.draft().steps.length);
        view.change((d) => d.steps.splice(at, 0, { name }), { side: false });
        select({ kind: 'step', i: at });
        toast(`${name} created and added. Write its instructions in the file that opened; save the scenario to keep the step.`, 'ok');
      },
      'dg-remove': (el) => removeStep(Number(el.dataset.i)),
      'dg-edit-agent': () => leaveTo({ name: 'agents' }),
      'dg-settings': () => leaveTo({ name: 'mcp', section: 'atlassian' }),
      'dg-open-editor': async () => {
        const view = v();
        const sel = view.sel;
        if (sel.kind !== 'step') return;
        const st = view.draft().steps[sel.i];
        if (!st) return;
        // The file belongs to a saved step: the scenario is saved first.
        if ((view.draft().dirty || !view.draft().id) && !(await view.save())) return;
        const id = view.draft().id;
        if (id && (await attempt('editStepInstructions', { scenario: id, agent: st.name }, null))) await view.load();
      },
      'dg-save': () => v().save(),
      'dg-use': () => {
        const d = v().draft();
        if (!d.id) return;
        S.draft.scenario = d.id;
        persist();
        go({ name: 'home', compose: '' });
      },
      'dg-list': () => {
        const d = v().draft();
        S.ui.scEdit = d.id;
        leaveTo({ name: 'scenarios' });
      },
      'dg-back': () => leaveTo({ name: 'scenarios' }),
      'dg-zoom': (el) => setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(v().zoom) + Number(el.dataset.level)))] ?? 1),
      'dg-fit': () => {
        const canvas = $('.dg-canvas');
        const flow = $('.dg-flow');
        if (!canvas || !flow) return;
        const h = flow.scrollHeight;
        const fit = Math.min(1, (canvas.clientHeight - 80) / Math.max(1, h));
        setZoom(ZOOMS.filter((z) => z <= fit).pop() ?? ZOOMS[0]!);
      },
    },
    inputs: {
      'dg-label': (el) => v().change((d) => void (d.label = el.value), { side: false }),
      'dg-desc': (el) => v().change((d) => void (d.description = el.value), { side: false }),
      'dg-query': (el) => {
        v().query = el.value;
        v().renderFlow();
      },
      'dg-instructions': (el) => {
        const sel = v().sel;
        if (sel.kind === 'step') v().change((d) => void (d.steps[sel.i]!.instructions = el.value), { side: false });
      },
    },
    changes: {
      'dg-agent': (el) => {
        const sel = v().sel;
        if (sel.kind !== 'step') return;
        // A new agent for the step keeps what the step says; its file was named for the old agent, so its text is kept.
        v().change((d) => {
          const st = d.steps[sel.i]!;
          const { instructionsFile: _f, ...rest } = st;
          d.steps[sel.i] = { ...rest, name: el.value };
        });
      },
      'dg-model': (el) => stepField('model', el.value),
      'dg-effort': (el) => stepField('effort', el.value),
      'dg-intake-model': (el) =>
        v().change((d) => {
          const { model: _m, ...rest } = d.intake;
          d.intake = el.value ? { ...rest, model: el.value } : rest;
        }),
      'dg-intake-effort': (el) =>
        v().change((d) => {
          const { effort: _e, ...rest } = d.intake;
          const e = asEffort(el.value);
          d.intake = e ? { ...rest, effort: e } : rest;
        }),
    },
  };

  async function refreshPreview() {
    const d = v().draft();
    v().preview = await call('previewScenario', { agents: d.steps.map((st) => ({ name: st.name })) }).catch(() => null);
  }

  function select(sel: DgSelection) {
    const view = v();
    view.sel = sel;
    view.renderFlow();
    view.renderSide();
  }

  function stepField(field: 'model' | 'effort', value: string) {
    const sel = v().sel;
    if (sel.kind !== 'step') return;
    v().change((d) => {
      const st = d.steps[sel.i]!;
      const { model, effort, ...rest } = st;
      const next: ScenarioStep = { ...rest, ...(model && { model }), ...(effort && { effort }) };
      if (field === 'model') {
        delete next.model;
        if (value) next.model = value;
      } else {
        delete next.effort;
        const e = asEffort(value);
        if (e) next.effort = e;
      }
      d.steps[sel.i] = next;
    });
  }

  function removeStep(i: number) {
    const view = v();
    const st = view.draft().steps[i];
    if (!st) return;
    view.change((d) => d.steps.splice(i, 1), { side: false });
    const n = view.draft().steps.length;
    select(n ? { kind: 'step', i: Math.min(i, n - 1) } : { kind: 'scenario' });
    toast(`${st.name} removed from the diagram; Save to keep it so`, 'info');
  }

  /** Leaves the diagram; unsaved changes are kept for when it opens again, and said so. */
  function leaveTo(route: Route) {
    const d = v().draft();
    if (d.dirty && d.steps.length) toast(`${d.label}: changes not saved. They are kept here until you open another diagram.`, 'warn', { label: 'Back to it', run: () => go({ name: 'scenario-diagram', ...(d.id && { scenario: d.id }) }) });
    go(route);
  }

  function setZoom(z: number) {
    v().zoom = z;
    v().renderFlow();
  }

  // ---------- keys, dragging and panning ----------

  // A click outside the add menu closes it (the shell takes its class off; this forgets it).
  document.addEventListener('click', (e) => {
    const view = v();
    if (!here() || view.adding === null || (e.target instanceof Element && e.target.closest('.dg-add-wrap, [data-action="dg-add"]'))) return;
    view.adding = null;
  });

  const here = () => S.route.name === 'scenario-diagram';
  const typing = (t: EventTarget | null) => t instanceof HTMLElement && t.matches('input, textarea, select, [contenteditable]');

  document.addEventListener('keydown', (e) => {
    if (!here()) return;
    const view = v();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void view.save();
      return;
    }
    if (e.key === 'Escape') {
      if (view.adding !== null) {
        view.adding = null;
        view.renderFlow();
      } else if (!typing(e.target)) select({ kind: 'scenario' });
      return;
    }
    if (typing(e.target)) return;
    const n = view.draft().steps.length;
    const sel = view.sel;
    const at = sel.kind === 'step' ? sel.i : sel.kind === 'start' ? -1 : null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = at === null ? -1 : Math.max(-1, Math.min(n - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      select(next === -1 ? { kind: 'start' } : { kind: 'step', i: next });
      $<HTMLElement>(next === -1 ? '.dg-pill[data-action="dg-start"]' : `.dg-step[data-i="${next}"]`)?.focus();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.kind === 'step') {
      e.preventDefault();
      removeStep(sel.i);
    }
  });

  let dragFrom: number | null = null;
  const clearDrop = () => document.querySelectorAll('.dg-edge.drop').forEach((x) => x.classList.remove('drop'));
  document.addEventListener('dragstart', (e) => {
    const node = e.target instanceof Element ? e.target.closest<HTMLElement>('.dg-step[draggable="true"]') : null;
    if (!node || !here()) return;
    dragFrom = Number(node.dataset.i);
    node.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', node.dataset.i ?? '');
  });
  document.addEventListener('dragend', () => {
    if (dragFrom === null) return;
    dragFrom = null;
    clearDrop();
    document.querySelectorAll('.dg-step.dragging').forEach((x) => x.classList.remove('dragging'));
  });
  const edgeAt = (e: DragEvent) => (dragFrom === null || !(e.target instanceof Element) ? null : e.target.closest<HTMLElement>('.dg-edge'));
  document.addEventListener('dragover', (e) => {
    const edge = edgeAt(e);
    if (!edge) return;
    e.preventDefault();
    clearDrop();
    edge.classList.add('drop');
  });
  document.addEventListener('drop', (e) => {
    const edge = edgeAt(e);
    const from = dragFrom;
    if (!edge || from === null) return;
    e.preventDefault();
    dragFrom = null;
    clearDrop();
    const to = Number(edge.dataset.i);
    // An arrow right above or below the step leaves it where it is.
    if (to === from || to === from + 1) return v().renderFlow();
    const at = to > from ? to - 1 : to;
    v().change((d) => {
      const [st] = d.steps.splice(from, 1);
      d.steps.splice(at, 0, st!);
    }, { side: false });
    select({ kind: 'step', i: at });
  });

  // Dragging the canvas's background scrolls it; Ctrl or ⌘ with the wheel zooms.
  let pan: { x: number; y: number; left: number; top: number } | null = null;
  document.addEventListener('pointerdown', (e) => {
    const canvas = e.target instanceof HTMLElement && here() ? e.target.closest<HTMLElement>('.dg-canvas') : null;
    if (!canvas || (e.target instanceof HTMLElement && e.target.closest('.dg-node, .dg-edge, .dg-toolbar, .dg-zoom, .dg-first, .menu'))) return;
    pan = { x: e.clientX, y: e.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    canvas.classList.add('panning');
  });
  document.addEventListener('pointermove', (e) => {
    const canvas = pan && $('.dg-canvas');
    if (!pan || !canvas) return;
    canvas.scrollLeft = pan.left - (e.clientX - pan.x);
    canvas.scrollTop = pan.top - (e.clientY - pan.y);
  });
  document.addEventListener('pointerup', () => {
    pan = null;
    $('.dg-canvas')?.classList.remove('panning');
  });
  document.addEventListener(
    'wheel',
    (e) => {
      if (!here() || !(e.ctrlKey || e.metaKey) || !(e.target instanceof Element) || !e.target.closest('.dg-canvas')) return;
      e.preventDefault();
      const z = v().zoom;
      setZoom(e.deltaY < 0 ? (ZOOMS.find((x) => x > z) ?? z) : ([...ZOOMS].reverse().find((x) => x < z) ?? z));
    },
    { passive: false }
  );
})();
