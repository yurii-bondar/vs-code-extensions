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

/**
 * What the right column shows: the scenario, the ticket, a step, a block (by its first step), or a new agent for an
 * arrow (its place and blocks).
 */
type DgSelection =
  | { kind: 'scenario' }
  | { kind: 'start' }
  | { kind: 'step'; i: number }
  | { kind: 'block'; type: 'parallel' | 'branch' | 'loop'; i: number }
  | { kind: 'approve'; i: number }
  | { kind: 'create'; at: number; parallel?: number; when?: StepWhen; loop?: { rounds?: number } };

interface DiagramView extends View {
  c: DgConfig | null;
  preview: DgPreview | null;
  sel: DgSelection;
  zoom: number;
  /** The arrow whose add menu is open. */
  adding: number | null;
  /** What its menu adds: a step, the first agent of a new Parallel, or the first step of a new Branch. */
  addMode: 'agent' | 'parallel' | 'branch';
  query: string;
  draft(): DiagramDraft;
  load(): Promise<void>;
  render(): void;
  renderFlow(): void;
  renderSide(): void;
  renderHead(): void;
  change(fn: (d: DiagramDraft) => void, opts?: { side?: boolean; route?: boolean }): void;
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

  // ---------- blocks ----------

  /** Where a step added or dropped on an arrow goes, and the blocks it is then in. */
  interface EdgeCtx {
    at: number;
    parallel?: number;
    when?: StepWhen;
    loop?: { rounds?: number };
  }
  /** The arrows drawn last, by their `data-i`: drawn again in the same order, an open menu stays on its arrow. */
  let edges: EdgeCtx[] = [];

  const PARALLEL_OUTPUTS = ['verdict', 'readiness', 'audit'];
  const sameWhen = (a: StepWhen | undefined, b: StepWhen | undefined) => Boolean(a && b) && a!.on === b!.on && JSON.stringify(a!.if) === JSON.stringify(b!.if);
  /** The end (exclusive) of the block that starts at `i`: a Loop, a Branch or a Parallel, else the step alone. */
  function blockEnd(steps: readonly ScenarioStep[], i: number, inLoop: boolean): number {
    const st = steps[i]!;
    let j = i + 1;
    if (st.loop && !inLoop) while (j < steps.length && steps[j]!.loop) j++;
    else if (st.when) while (j < steps.length && sameWhen(steps[j]!.when, st.when) && Boolean(steps[j]!.loop) === Boolean(st.loop)) j++;
    else if (st.parallel !== undefined) while (j < steps.length && steps[j]!.parallel === st.parallel && Boolean(steps[j]!.loop) === Boolean(st.loop)) j++;
    return j;
  }
  /** The markers a step takes on an arrow: those of the arrow, none of its own. */
  function placed(st: ScenarioStep, ctx: EdgeCtx): ScenarioStep {
    const { parallel: _p, when: _w, loop: _l, ...rest } = st;
    return { ...rest, ...(ctx.parallel !== undefined && { parallel: ctx.parallel }), ...(ctx.when && { when: ctx.when }), ...(ctx.loop && { loop: ctx.loop }) };
  }
  /** The steps of the Parallel or the Loop `st` is in, or null for a step in neither. */
  const blockOf = (st: ScenarioStep): ((x: ScenarioStep) => boolean) | null => (st.parallel !== undefined ? (x) => x.parallel === st.parallel : st.loop ? (x) => Boolean(x.loop) : null);
  const newParallel = (steps: readonly ScenarioStep[]) => Math.max(0, ...steps.map((st) => st.parallel ?? 0)) + 1;

  // Conditions, as one value per choice: `severity:major`.
  const CONDITIONS: Record<string, [string, string][]> = {
    verdict: [['verdict:changes_requested', 'requested changes'], ['verdict:approved', 'approved'], ['severity:blocker', 'found a blocker'], ['severity:major', 'found major or worse'], ['severity:minor', 'found anything']],
    readiness: [['readiness:not_ready', 'says not ready'], ['readiness:needs_check', 'says needs a check'], ['readiness:ready', 'says ready']],
    audit: [['audit:critical', 'found a critical issue'], ['audit:high', 'found high or worse'], ['audit:medium', 'found medium or worse'], ['audit:low', 'found anything']],
    code: [['gates:fail', 'left checks failing'], ['gates:pass', 'passed its checks']],
  };
  CONDITIONS.tests = CONDITIONS.code!;
  const conditionValue = (c: Condition) => Object.entries(c).map(([k, x]) => `${k}:${String(x)}`)[0] ?? '';
  function conditionOf(value: string): Condition | null {
    const [k, x] = value.split(':') as [string, string];
    if (k === 'verdict' && (x === 'approved' || x === 'changes_requested')) return { verdict: x };
    if (k === 'severity' && (x === 'blocker' || x === 'major' || x === 'minor')) return { severity: x };
    if (k === 'readiness' && (x === 'ready' || x === 'not_ready' || x === 'needs_check')) return { readiness: x };
    if (k === 'audit' && (x === 'critical' || x === 'high' || x === 'medium' || x === 'low')) return { audit: x };
    if (k === 'gates' && (x === 'pass' || x === 'fail')) return { gates: x };
    return null;
  }
  const describeWhen = (w: StepWhen) => `${w.on} ${(CONDITIONS[agentOf(w.on)?.output ?? '']?.find(([val]) => val === conditionValue(w.if)) ?? ['', conditionValue(w.if)])[1]}`;
  /** Steps before `at` a branch there can look at: ones that report a result, nearest last. */
  const branchSources = (steps: readonly ScenarioStep[], at: number) => steps.slice(0, at).filter((st) => CONDITIONS[agentOf(st.name)?.output ?? ''] && !st.when);
  function defaultWhen(steps: readonly ScenarioStep[], at: number): StepWhen | null {
    const on = branchSources(steps, at).pop();
    if (!on) return null;
    return { on: on.name, if: conditionOf(CONDITIONS[agentOf(on.name)!.output]![0]![0])! };
  }

  /** What Save would be refused for, as config.yaml would say it. */
  function problems(d: DiagramDraft): string[] {
    const out: string[] = [];
    d.steps.forEach((st, i) => {
      const o = agentOf(st.name)?.output;
      if (!agentOf(st.name)) out.push(`${st.name} is not an agent in config.yaml`);
      if (st.parallel !== undefined && o && !PARALLEL_OUTPUTS.includes(o)) out.push(`${st.name} writes ${outputLabel(o)}: only reviewers, readiness and audit agents run at once`);
      if (st.when) {
        const first = d.steps.findIndex((x) => sameWhen(x.when, st.when));
        const src = d.steps.findIndex((x) => x.name === st.when!.on);
        if (first === i && (src === -1 || src > first)) out.push(`The branch on ${st.when.on} comes before ${st.when.on}: move it after`);
      }
    });
    const looped = d.steps.filter((st) => st.loop);
    const last = looped[looped.length - 1];
    if (last && agentOf(last.name)?.output !== 'verdict') out.push(`The Loop ends with ${last.name}: it must end with a reviewer, whose approval ends it`);
    return out;
  }

  // ---------- the canvas ----------

  function edgeHtml(ctx: EdgeCtx, d: DiagramDraft, { label = '', end = false }: { label?: string; end?: boolean } = {}) {
    const i = edges.push(ctx) - 1;
    const open = v().adding === i;
    const between = ctx.at === 0 ? 'the ticket' : d.steps[ctx.at - 1]!.name;
    const and = ctx.at === d.steps.length ? 'Finish' : d.steps[ctx.at]!.name;
    const where = ctx.parallel !== undefined ? 'to this Parallel' : ctx.when ? `to this arm of the branch` : ctx.loop ? 'to the Loop' : `between ${between} and ${and}`;
    return `<div class="dg-edge ${end ? 'dg-edge-end' : ''}" data-i="${i}">${label ? `<span class="chip small dg-edge-label">${esc(label)}</span>` : ''}
      <span class="menu-wrap dg-add-wrap ${open ? 'open' : ''}">
        <button class="dg-add" data-action="dg-add" data-i="${i}" title="Add a step here" aria-label="Add a step ${esc(where)}">${icon('plus')}</button>
        ${open ? addMenuHtml(i, ctx, d, where) : ''}
      </span>
    </div>`;
  }

  function addMenuHtml(i: number, ctx: EdgeCtx, d: DiagramDraft, where: string) {
    const c = v().c;
    if (!c) return '';
    const mode = v().addMode;
    const q = v().query.trim().toLowerCase();
    const taken = new Set(d.steps.map((st) => st.name));
    const list = c.agents.filter((a) => !taken.has(a.name) && (!q || a.name.includes(q) || a.description.toLowerCase().includes(q)));
    const readOnly = mode === 'parallel' || ctx.parallel !== undefined;
    const branch = defaultWhen(d.steps, ctx.at);
    const canLoop = !d.steps.some((st) => st.loop) && Boolean(v().preview?.pipeline.reviewLoop);
    const flow = (action: string, ic: string, label: string, hint: string, why: string) =>
      `<button data-action="${action}" data-i="${i}" ${why ? `disabled title="${esc(why)}"` : ''}>${icon(ic)}<span class="grow"><b>${label}</b><span class="muted small">${esc(why || hint)}</span></span></button>`;
    const title = mode === 'parallel' ? 'New Parallel: its first agent (add the others with + in it)' : mode === 'branch' && branch ? `New branch, when ${describeWhen(branch)}: its first step` : `Add a step ${where}`;
    return `<div class="menu dg-menu" role="menu">
      <div class="muted small dg-menu-title">${esc(title)}</div>
      <input class="input sm" data-input="dg-query" value="${esc(v().query)}" placeholder="Search agents" aria-label="Search agents">
      <h4>Agents</h4>
      <div class="dg-menu-list">
        ${list
          .map((a) => {
            const why = misfit(a, d.steps) || (readOnly && !PARALLEL_OUTPUTS.includes(a.output) ? 'Only reviewers, readiness and audit agents run at once' : '');
            return `<button class="${agentColor(a.color)}" data-action="dg-insert" data-i="${i}" data-name="${esc(a.name)}" ${why ? `disabled title="${esc(why)}"` : `title="${esc(a.description)}"`}><span class="adot"></span><span class="grow"><b>${esc(a.name)}</b><span class="muted small">${esc(a.description)}${a.enabled ? '' : ' · turned off'}</span></span><span class="chip small">${esc(outputLabel(a.output))}</span></button>`;
          })
          .join('') || `<div class="muted small dg-menu-empty">${q ? 'No agent matches.' : 'Every agent is in this scenario already.'}</div>`}
      </div>
      <button class="dg-create" data-action="dg-create" data-i="${i}">${icon('plus')}Create agent…</button>
      ${mode === 'agent' && ctx.parallel === undefined && ctx.when ? `<h4>Flow</h4>${flow('dg-approve-add', 'user', 'You approve', 'The task waits for you here, when this arm runs', approveWhy(d, ctx))}` : ''}
      ${mode === 'agent' && ctx.parallel === undefined && !ctx.when ? `<h4>Flow</h4>
      ${flow('dg-mode-parallel', 'activity', 'Parallel', 'Start several read-only agents together', '')}
      ${flow('dg-mode-branch', 'branch', 'Branch', 'Steps that run only when an earlier result holds', ctx.loop ? 'A Loop holds no branch' : branch ? '' : 'Needs a step before it that reports a result: a review, readiness, audit or checks')}
      ${flow('dg-loop-on', 'refresh', 'Loop', 'Choose which steps run again, and how many rounds', canLoop ? '' : d.steps.some((st) => st.loop) ? 'This scenario has its Loop' : 'Needs an agent that changes code and a reviewer after it')}
      ${flow('dg-approve-add', 'user', 'You approve', 'The task waits for you here', approveWhy(d, ctx))}` : ''}
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
    const bad = st.parallel !== undefined && !PARALLEL_OUTPUTS.includes(a.output);
    return `<div class="dg-node dg-step ${agentColor(a.color)} ${on ? 'selected' : ''} ${a.enabled ? '' : 'off'} ${bad ? 'bad' : ''}" data-action="dg-select" data-i="${i}" tabindex="0" draggable="true" aria-label="Step ${i + 1}: ${esc(st.name)}">
      <div class="dg-node-head"><span class="adot"></span><b>${esc(st.name)}</b><span class="chip small">${esc(outputLabel(a.output))}</span></div>
      <div class="dg-node-sub">${esc(sub)}</div>
      ${note ? `<div class="dg-node-note">${icon(st.instructionsFile ? 'file' : 'text')}<span>${esc(note)}</span></div>` : ''}
      ${bad ? `<div class="dg-node-sub err">${icon('alert')}writes ${esc(outputLabel(a.output))}: cannot run at once</div>` : ''}
    </div>`;
  }

  /** Why You approve cannot go on this arrow, or '' when it can: it marks the step right before it. */
  function approveWhy(d: DiagramDraft, ctx: EdgeCtx): string {
    const prev = d.steps[ctx.at - 1];
    if (!prev) return 'Needs a step before it';
    if (ctx.parallel !== undefined) return 'Not inside a Parallel: put it after it';
    if (ctx.loop) return 'Not inside the Loop: put it after it, where the reviewers approved';
    if (ctx.when ? !sameWhen(prev.when, ctx.when) || Boolean(prev.when!.else) !== Boolean(ctx.when.else) : Boolean(prev.when)) return ctx.when ? 'Needs a step before it in this arm' : 'Not right after a Branch: put it in one of its arms';
    if (prev.approve) return 'The task waits for you here already';
    if (agentOf(prev.name)?.output === 'plan') return 'A plan waits for your approval already';
    return '';
  }
  const approveHtml = (st: ScenarioStep, i: number) =>
    st.approve
      ? `<div class="dg-line short"></div><div class="dg-node dg-pill dg-approve ${v().sel.kind === 'approve' && (v().sel as { i: number }).i === i ? 'selected' : ''}" data-action="dg-approve" data-i="${i}" tabindex="0" title="The task waits for you here">${icon('user')}<b>You approve</b><span class="muted small dg-approve-text">${esc(st.approve.text || `what ${st.name} did`)}</span></div>`
      : '';
  const approvalHtml = (st: ScenarioStep) => (stageOf(st.name)?.approval ? `<div class="dg-line short"></div><div class="dg-node dg-pill dg-derived" title="Made from the step's output: a plan waits for you before anything changes">${icon('user')}<b>You approve the plan</b><span class="grow"></span><span class="chip small">auto · after a plan</span></div>` : '');
  const blockSelected = (type: string, i: number) => { const s = v().sel; return s.kind === 'block' && s.type === type && s.i === i; };

  /** Steps `from..to` with arrows between them (and after the last when `tail`), every arrow in `base`'s blocks. */
  function chainHtml(d: DiagramDraft, from: number, to: number, base: Omit<EdgeCtx, 'at'>, { inLoop = false, tail = false }: { inLoop?: boolean; tail?: boolean } = {}): string {
    let html = '';
    for (let i = from; i < to; ) {
      const j = Math.min(blockEnd(d.steps, i, inLoop), to);
      html += itemHtml(d, i, j, base, inLoop);
      if (j < to || tail) html += edgeHtml({ at: j, ...base }, d, { end: j === to });
      i = j;
    }
    return html;
  }

  /** One item of a chain: a step, a Parallel, a Branch or a Loop over steps `i..j`. */
  function itemHtml(d: DiagramDraft, i: number, j: number, base: Omit<EdgeCtx, 'at'>, inLoop: boolean): string {
    const st = d.steps[i]!;
    if (st.loop && !inLoop) {
      const rounds = st.loop.rounds ?? v().c!.config.limits.reviewRounds;
      return `<div class="dg-loop dg-own ${blockSelected('loop', i) ? 'selected' : ''}">
        <div class="dg-loop-head" data-action="dg-block" data-kind="loop" data-i="${i}" role="button" tabindex="0">${icon('refresh')}<b>Loop</b><span class="muted small">until the reviewers at its end approve · up to ${plural(rounds, 'round')}</span><span class="grow"></span><span class="chip small">yours</span></div>
        ${chainHtml(d, i, j, { ...base, loop: st.loop }, { inLoop: true, tail: true })}
        <div class="dg-loop-foot">${icon('back')}changes requested → fix round</div>
      </div>${approveHtml(d.steps[j - 1]!, j - 1)}`;
    }
    if (st.when) {
      const yes = d.steps.slice(i, j).map((x, k) => [x, i + k] as const).filter(([x]) => !x.when!.else);
      const no = d.steps.slice(i, j).map((x, k) => [x, i + k] as const).filter(([x]) => x.when!.else);
      const when = { on: st.when.on, if: st.when.if };
      const loop = base.loop ? { loop: base.loop } : {};
      const arm = (list: (readonly [ScenarioStep, number])[], w: StepWhen, at: number) =>
        `${list.map(([x, k], n) => stepHtml(x, k) + approveHtml(x, k) + (n < list.length - 1 ? edgeHtml({ at: k + 1, when: w, ...loop }, d) : '')).join('')}${edgeHtml({ at, when: w, ...loop }, d, { end: true })}`;
      const yesEnd = yes.length ? yes[yes.length - 1]![1] + 1 : no.length ? no[0]![1] : i;
      return `<div class="dg-branch ${blockSelected('branch', i) ? 'selected' : ''}">
        <div class="dg-branch-head" data-action="dg-block" data-kind="branch" data-i="${i}" role="button" tabindex="0">${icon('branch')}<b>Branch</b><span class="muted small">on ${esc(st.when.on)}</span></div>
        <div class="dg-arms">
          <div class="dg-arm"><span class="chip small dg-yes">${esc(describeWhen(when))}</span>${arm(yes, when, yesEnd)}</div>
          <div class="dg-arm"><span class="chip small">otherwise</span>${arm(no, { ...when, else: true }, j)}</div>
        </div>
      </div>`;
    }
    if (st.parallel !== undefined) {
      const ctx = { ...base, parallel: st.parallel };
      return `<div class="dg-parallel ${blockSelected('parallel', i) ? 'selected' : ''}">
        <div class="dg-parallel-head" data-action="dg-block" data-kind="parallel" data-i="${i}" role="button" tabindex="0">${icon('activity')}<b>Parallel</b><span class="muted small">${j - i > 1 ? 'they start together · the next step waits for all' : 'add another read-only agent with +'}</span></div>
        <div class="dg-lanes">${d.steps.slice(i, j).map((x, k) => `<div class="dg-lane">${stepHtml(x, i + k)}</div>`).join('')}<div class="dg-lane dg-lane-add">${edgeHtml({ at: j, ...ctx }, d, { end: true })}</div></div>
      </div>${base.loop ? '' : approveHtml(d.steps[j - 1]!, j - 1)}`;
    }
    return stepHtml(st, i) + approvalHtml(st) + (inLoop ? '' : approveHtml(st, i));
  }

  function flowHtml(d: DiagramDraft) {
    edges = [];
    const p = v().preview;
    const sel = v().sel;
    const kind = kindOf(d.steps);
    const start = `<div class="dg-node dg-pill ${sel.kind === 'start' ? 'selected' : ''}" data-action="dg-start" tabindex="0">${icon('inbox')}<b>Ticket</b><span class="grow"></span><span class="chip small">Jira · Confluence · text</span></div>`;
    const finish = `<div class="dg-node dg-pill dg-finish">${icon('commit')}<b>Finish</b><span class="muted">${esc(!kind ? 'decided by the steps: PRs or a report' : REPORTS.includes(kind) ? `${kind} report` : 'commit → you confirm push → draft PRs')}</span></div>`;
    if (!d.steps.length) {
      const first = edges.push({ at: 0 }) - 1;
      return `${start}<div class="dg-line"></div>
        <div class="dg-first">
          ${icon('plus', 'big')}<b>Add the first step</b>
          <span class="muted small">A scenario is written to config.yaml with its first step.</span>
          <div class="row"><span class="menu-wrap dg-add-wrap ${v().adding === first ? 'open' : ''}"><button class="btn sm" data-action="dg-add" data-i="${first}">${icon('users')}Pick an agent</button>${v().adding === first ? addMenuHtml(first, { at: 0 }, d, 'first') : ''}</span><button class="btn ghost sm" data-action="dg-create" data-i="${first}">${icon('plus')}Create agent</button></div>
        </div><div class="dg-line"></div>${finish}`;
    }
    // The loop outputs make, where the scenario has none of its own: a frame over the top-level items it spans.
    const loop = p && p.pipeline.reviewLoop && !p.pipeline.reviewLoop.explicit ? p.pipeline.reviewLoop : null;
    const stages = p ? p.pipeline.stages : [];
    const loopFrom = loop ? d.steps.findIndex((st) => st.name === stages[loop.restartAt]?.agent) : -1;
    const loopTo = loop ? d.steps.findIndex((st) => st.name === stages[loop.end]?.agent) : -1;
    let html = start + edgeHtml({ at: 0 }, d);
    let frame: string | null = null;
    for (let i = 0; i < d.steps.length; ) {
      const j = blockEnd(d.steps, i, false);
      if (loop && i === loopFrom) frame = `<div class="dg-loop" title="Made from the steps' outputs: code is reviewed, and changes requested send it back">
          <div class="dg-loop-head">${icon('refresh')}<b>Review loop</b><span class="muted small">until every reviewer approves · up to ${plural(loop.maxRounds, 'round')}</span><span class="grow"></span><span class="chip small">built from outputs</span></div>`;
      const item = itemHtml(d, i, j, {}, false);
      const own = d.steps[i]!.loop;
      if (frame !== null) {
        if (loopTo >= i && loopTo < j) {
          html += `${frame}${item}<div class="dg-loop-foot">${icon('back')}changes requested → fix round</div></div>${edgeHtml({ at: j }, d, { label: 'approved' })}`;
          frame = null;
        } else frame += item + edgeHtml({ at: j }, d);
      } else html += item + edgeHtml({ at: j }, d, own ? { label: 'approved' } : {});
      i = j;
    }
    if (frame !== null) html += `${frame}</div>`;
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
      st.parallel !== undefined ? `${icon('activity')}Runs at the same time as ${esc(d.steps.filter((x, k) => k !== i && x.parallel === st.parallel).map((x) => x.name).join(', ') || 'the agents you add to its Parallel')}.` : '',
      st.when ? `${icon('branch')}Runs only when ${st.when.else ? `not: ${esc(describeWhen(st.when))}` : esc(describeWhen(st.when))}; otherwise it is skipped.` : '',
    ].filter(Boolean);
    const block = st.loop ? 'Loop' : st.parallel !== undefined ? 'Parallel' : st.when ? 'Branch' : '';
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
      ${block ? `<div class="row"><button class="btn ghost sm" data-action="dg-take-out" data-i="${i}" title="It runs after the ${block}, on its own">${icon('back')}Take out of the ${block}</button>${st.when ? `<button class="btn ghost sm" data-action="dg-other-arm" data-i="${i}">${icon('branch')}Move to ${st.when.else ? 'the yes arm' : 'otherwise'}</button>` : ''}</div>` : ''}
      <div class="row dg-remove"><button class="btn ghost sm danger" data-action="dg-remove" data-i="${i}">${icon('x')}Remove step</button><span class="grow"></span><span class="muted small">↑ ↓ select · Del remove</span></div>
    </section>`;
  }

  /** Whether a step is in the loop the outputs make, before its end (where it runs again each round). */
  function inReviewLoop(st: ScenarioStep): boolean {
    const p = v().preview?.pipeline;
    const loop = p?.reviewLoop;
    if (!p || !loop || st.loop) return false;
    const k = p.stages.findIndex((x) => x.agent === st.name);
    if (k < loop.restartAt || k > loop.end) return false;
    // The loop's end (or a Parallel that ends it) asks once, after the reviewers approved.
    const end = p.stages[loop.end]!;
    return k !== loop.end && !(end.group !== undefined && p.stages[k]!.group === end.group);
  }

  /** You approve after a step: what the task shows you there, and how to take it away. */
  function approveSide(d: DiagramDraft, i: number) {
    const st = d.steps[i];
    if (!st || !st.approve) return '';
    return `<section class="card dg-side-card">
      <div class="dg-side-head"><span class="muted small">YOU APPROVE</span><button class="icon-btn" data-action="dg-deselect" aria-label="Close">${icon('x')}</button></div>
      <h3>${icon('user')}You approve</h3>
      <p class="muted small">After ${esc(st.name)}${st.parallel !== undefined ? ' and the rest of its Parallel' : st.loop ? ', once the Loop\'s reviewers approved,' : ''} the task waits for you: it shows what the step wrote, and you approve, or have the step run again with your words${st.parallel !== undefined ? ' (not in a Parallel, which runs as one)' : ''}.</p>
      ${inReviewLoop(st) ? `<div class="dg-fact small">${icon('refresh')}<span>It is in the review loop, so it asks you in every round. After the loop instead: put it after the last reviewer.</span></div>` : ''}
      <label class="field"><span>What to look at <span class="muted">(optional, shown above it)</span></span><input class="input" data-input="dg-approve-text" data-i="${i}" value="${esc(st.approve.text || '')}" placeholder="e.g. Security fixes need a look"></label>
      <div class="row dg-remove"><button class="btn ghost sm danger" data-action="dg-approve-remove" data-i="${i}">${icon('x')}Remove: the task goes on by itself</button></div>
    </section>`;
  }

  /** A Parallel, a Branch or a Loop: what it does, what it is set to, and how to undo it. */
  function blockSide(d: DiagramDraft, type: 'parallel' | 'branch' | 'loop', i: number) {
    const st = d.steps[i];
    if (!st) return '';
    const head = (label: string, ic: string, text: string) => `<div class="dg-side-head"><span class="muted small">${label.toUpperCase()}</span><button class="icon-btn" data-action="dg-deselect" aria-label="Close">${icon('x')}</button></div><h3>${icon(ic)}${label}</h3><p class="muted small">${text}</p>`;
    const members = (pred: (x: ScenarioStep) => boolean) => d.steps.map((x, k) => [x, k] as const).filter(([x]) => pred(x)).map(([x, k]) => `<button class="btn ghost sm dg-member" data-action="dg-select" data-i="${k}"><span class="${agentColor(agentOf(x.name)?.color)}"><span class="adot"></span></span>${esc(x.name)}</button>`).join('');
    if (type === 'parallel') {
      return `<section class="card dg-side-card">${head('Parallel', 'activity', 'Its agents start together, each in its own session, and the next step waits for all of them. Only agents that read run at once: reviewers, readiness and audit agents. One that fails is asked about after the others end.')}
        <h4>Agents</h4><div class="dg-members">${members((x) => x.parallel === st.parallel)}</div>
        <p class="muted small">+ under them adds another. Several at once cost as much as one after another, only sooner.</p>
        <div class="row dg-remove"><button class="btn ghost sm" data-action="dg-unblock" data-kind="parallel" data-i="${i}">${icon('x')}Run them one after another</button></div>
      </section>`;
    }
    if (type === 'branch') {
      const w = st.when!;
      const first = d.steps.findIndex((x) => sameWhen(x.when, w));
      const sources = branchSources(d.steps, first);
      const out = agentOf(w.on)?.output ?? '';
      const choices = CONDITIONS[out] ?? [];
      return `<section class="card dg-side-card">${head('Branch', 'branch', 'Its steps run only when a result of a step before it holds; the otherwise steps when it does not. The task decides from what the step reported, so a task shows which way it went.')}
        <div class="field-row two">
          <label class="field"><span>On</span><select class="input" data-change="dg-branch-on" data-i="${i}">${sources.map((x) => `<option value="${esc(x.name)}" ${x.name === w.on ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}${sources.some((x) => x.name === w.on) ? '' : `<option selected>${esc(w.on)}</option>`}</select></label>
          <label class="field"><span>When it</span><select class="input" data-change="dg-branch-if" data-i="${i}">${choices.map(([val, label]) => `<option value="${val}" ${val === conditionValue(w.if) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        </div>
        <h4>Then</h4><div class="dg-members">${members((x) => sameWhen(x.when, w) && !x.when!.else) || '<span class="muted small">nothing: + in its column adds a step</span>'}</div>
        <h4>Otherwise</h4><div class="dg-members">${members((x) => sameWhen(x.when, w) && Boolean(x.when!.else)) || '<span class="muted small">nothing: the task goes on</span>'}</div>
        <div class="row dg-remove"><button class="btn ghost sm" data-action="dg-unblock" data-kind="branch" data-i="${i}">${icon('x')}Remove the branch: its steps always run</button></div>
      </section>`;
    }
    const limit = v().c!.config.limits.reviewRounds;
    const rounds = st.loop!.rounds;
    return `<section class="card dg-side-card">${head('Loop', 'refresh', 'Its steps run again while the reviewers at its end request changes, each round with their findings, up to its rounds; then you decide. In place of the review loop the outputs make.')}
      <label class="field"><span>Rounds</span><select class="input" data-change="dg-loop-rounds" data-i="${i}"><option value="">limits.reviewRounds (${limit})</option>${[1, 2, 3, 4, 5, 6, 8, 10].map((n) => `<option value="${n}" ${n === rounds ? 'selected' : ''}>${plural(n, 'round')}</option>`).join('')}</select></label>
      <h4>Steps</h4><div class="dg-members">${members((x) => Boolean(x.loop))}</div>
      <p class="muted small">Drag a step onto an arrow in the frame to put it in the Loop; it must end with a reviewer.</p>
      <div class="row dg-remove"><button class="btn ghost sm" data-action="dg-unblock" data-kind="loop" data-i="${i}">${icon('x')}Back to the loop the outputs make</button></div>
    </section>`;
  }

  function createSide(d: DiagramDraft, at: number) {
    const c = v().c!;
    const where = `${at === 0 ? 'the ticket' : d.steps[at - 1]?.name ?? ''} and ${at >= d.steps.length ? 'Finish' : d.steps[at]!.name}`;
    const sel = v().sel;
    const inBlock = sel.kind === 'create' && (sel.parallel !== undefined ? ' (in its Parallel: base it on a reviewer, readiness or audit agent)' : sel.when ? ' (in its branch)' : sel.loop ? ' (in the Loop)' : '');
    const base = d.steps[at - 1]?.name || 'reviewer';
    return `<section class="card dg-side-card">
      <div class="dg-side-head"><span class="muted small">NEW AGENT</span><button class="icon-btn" data-action="dg-deselect" aria-label="Close">${icon('x')}</button></div>
      <h3>${icon('plus')}Create agent</h3>
      <p class="muted small">Added to this scenario between ${esc(where)}${esc(inBlock || '')}, and to nothing else. Its instructions open in a file to write.</p>
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
    const bad = (t: string) => `<div class="dg-check bad">${icon('x')}<span>${esc(t)}</span></div>`;
    const items = [
      ...problems(d).map(bad),
      p.pipeline.stages.some((s) => s.approval) ? ok('The plan comes first and is approved by you.') : '',
      // One after a turned-off agent: the route's warning says where it waits instead.
      ...d.steps.filter((st) => st.approve && agentOf(st.name)?.enabled !== false).map((st) => ok(`The task waits for you after ${st.name}${st.when ? ', when its branch runs' : ''}.`)),
      p.pipeline.stages.some((s) => s.group !== undefined) ? ok('Agents in a Parallel start together; the next step waits for all of them.') : '',
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
    addMode: 'agent',
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
            <div class="dg-bar"><div class="dg-toolbar"><span class="muted small">Add</span><button class="btn ghost sm" data-action="dg-add" data-i="-1" title="Add an agent at the end">${icon('users')}Agent</button><button class="btn ghost sm" data-action="dg-approve-add" data-i="-1" title="The task waits for you after the selected step, or after the last one">${icon('user')}You approve</button><button class="btn ghost sm" data-action="dg-add" data-i="-1" data-kind="parallel" title="A new Parallel at the end: read-only agents that start together">${icon('activity')}Parallel</button><button class="btn ghost sm" data-action="dg-add" data-i="-1" data-kind="branch" title="A new Branch at the end: steps that run only when an earlier result holds">${icon('branch')}Branch</button><button class="btn ghost sm" data-action="dg-loop-on" title="Choose which steps run again, and how many rounds">${icon('refresh')}Loop</button></div>
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
      const errors = problems(d).length;
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
          <button class="btn primary sm" data-action="dg-save" ${d.steps.length && (d.dirty || !d.id) && !errors ? '' : 'disabled'} title="${!d.steps.length ? 'Add a step first: an empty scenario writes nothing' : errors ? 'Fix the problems in Route check first' : 'Write it to .claudestrator/config.yaml (Ctrl+S)'}">${icon('check')}Save</button>
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
      const main = sel.kind === 'start' ? startSide(d) : sel.kind === 'step' ? stepSide(d, sel.i) : sel.kind === 'block' ? blockSide(d, sel.type, sel.i) : sel.kind === 'approve' ? approveSide(d, sel.i) : sel.kind === 'create' ? createSide(d, sel.at) : scenarioSide(d);
      patch('dg-side', main + routeHtml(d));
    },
    /**
     * Applies a change to the draft and draws it; the right column only when `side` (typing there keeps it), the route
     * asked of the host again only when `route` (a name or a text changes no route).
     */
    change(fn, { side = true, route = true } = {}) {
      const d = this.draft();
      fn(d);
      d.dirty = true;
      persist();
      this.renderHead();
      this.renderFlow();
      if (side) this.renderSide();
      if (!route) return;
      debounce('dg-preview', async () => {
        await refreshPreview();
        this.renderHead();
        this.renderFlow();
        this.renderSide();
      }, 120);
    },
    async save() {
      const d = this.draft();
      if (!d.steps.length || problems(d).length) return false;
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
        // The toolbar's Agent: the last arrow of the main chain, before Finish.
        const n = view.draft().steps.length;
        const i = Number(el.dataset.i) < 0 ? edges.map((e, k) => (e.at === n && e.parallel === undefined && !e.when && !e.loop ? k : -1)).reduce((a, b) => Math.max(a, b), -1) : Number(el.dataset.i);
        view.adding = view.adding === i ? null : i;
        view.addMode = el.dataset.kind === 'parallel' || el.dataset.kind === 'branch' ? el.dataset.kind : 'agent';
        view.query = '';
        view.renderFlow();
        $('.dg-menu')?.scrollIntoView({ block: 'nearest' });
        $<HTMLInputElement>('.dg-menu input')?.focus();
      },
      'dg-mode-parallel': () => setMode('parallel'),
      'dg-mode-branch': () => setMode('branch'),
      'dg-insert': (el) => {
        const ctx = edgeCtx(Number(el.dataset.i));
        if (!ctx) return;
        insertAt(ctx, el.dataset.name);
      },
      'dg-create': (el) => {
        const ctx = edgeCtx(Number(el.dataset.i)) ?? { at: v().draft().steps.length };
        v().adding = null;
        v().renderFlow();
        select({ kind: 'create', ...ctx });
        $<HTMLInputElement>('#dg-na-name')?.focus();
      },
      'dg-create-save': async () => {
        const sel = v().sel;
        if (sel.kind !== 'create') return;
        const val = (id: string) => $<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value.trim() ?? '';
        const name = val('dg-na-name');
        const ok = await attempt('newAgent', { name, base: val('dg-na-base') || undefined, description: val('dg-na-desc') || undefined, standalone: true }, null);
        if (!ok) return;
        await v().load();
        const { kind: _k, ...ctx } = sel;
        insertAt({ ...ctx, at: Math.min(ctx.at, v().draft().steps.length) }, name);
        toast(`${name} created and added. Write its instructions in the file that opened; save the scenario to keep the step.`, 'ok');
      },
      'dg-approve': (el) => select({ kind: 'approve', i: Number(el.dataset.i) }),
      // From an arrow's menu: after the step before it; from the toolbar: after the step selected, else the last one.
      'dg-approve-add': (el) => {
        const view = v();
        const d = view.draft();
        const sel = view.sel;
        const ctx: EdgeCtx | undefined = Number(el.dataset.i) >= 0 ? edgeCtx(Number(el.dataset.i)) : sel.kind === 'step' ? { at: sel.i + 1, ...(d.steps[sel.i]!.when && { when: d.steps[sel.i]!.when }) } : { at: d.steps.length };
        if (!ctx) return;
        // A step of a Parallel or the Loop: You approve goes after its block, on the block's last step.
        let at = ctx.at;
        const prev = d.steps[at - 1];
        if (prev && !ctx.when && (prev.parallel !== undefined || prev.loop)) at = blockEnd(d.steps, d.steps.findIndex((x) => (prev.loop ? Boolean(x.loop) : x.parallel === prev.parallel)), false);
        const why = approveWhy(d, { at, ...(ctx.when && { when: ctx.when }) });
        if (why) return toast(why, 'warn');
        view.adding = null;
        view.change((dd) => void (dd.steps[at - 1]!.approve = {}));
        select({ kind: 'approve', i: at - 1 });
        $<HTMLInputElement>('[data-input="dg-approve-text"]')?.focus();
      },
      'dg-approve-remove': (el) => {
        const i = Number(el.dataset.i);
        v().change((d) => void delete d.steps[i]!.approve);
        select({ kind: 'step', i });
      },
      'dg-block': (el) => {
        const type = el.dataset.kind;
        if (type === 'parallel' || type === 'branch' || type === 'loop') select({ kind: 'block', type, i: Number(el.dataset.i) });
      },
      // The loop the outputs make becomes the scenario's own, to change.
      'dg-loop-on': () => {
        const view = v();
        const p = view.preview?.pipeline;
        const loop = p?.reviewLoop;
        if (view.draft().steps.some((st) => st.loop)) return select({ kind: 'block', type: 'loop', i: view.draft().steps.findIndex((st) => st.loop) });
        if (!p || !loop) return toast('A Loop needs an agent that changes code and a reviewer after it', 'warn');
        const d = view.draft();
        const from = d.steps.findIndex((st) => st.name === p.stages[loop.restartAt]?.agent);
        const to = d.steps.findIndex((st) => st.name === p.stages[loop.end]?.agent);
        if (from === -1 || to < from) return;
        view.adding = null;
        view.change((dd) => dd.steps.forEach((st, k) => k >= from && k <= to && (st.loop = {})));
        select({ kind: 'block', type: 'loop', i: from });
      },
      'dg-unblock': (el) => {
        const i = Number(el.dataset.i);
        const d = v().draft();
        const st = d.steps[i];
        if (!st) return;
        const kind = el.dataset.kind;
        const inBlock = (x: ScenarioStep) => (kind === 'parallel' ? x.parallel === st.parallel : kind === 'branch' ? sameWhen(x.when, st.when) : Boolean(x.loop));
        v().change((dd) => {
          dd.steps = dd.steps.map((x) => {
            if (!inBlock(x)) return x;
            const { parallel, when, loop, ...rest } = x;
            return { ...rest, ...(kind !== 'parallel' && parallel !== undefined && { parallel }), ...(kind !== 'branch' && when && { when }), ...(kind !== 'loop' && loop && { loop }) };
          });
        });
        select({ kind: 'step', i });
      },
      'dg-take-out': (el) => {
        const i = Number(el.dataset.i);
        const d = v().draft();
        const st = d.steps[i];
        if (!st) return;
        // Out of its innermost block only (a Parallel in a Loop stays in the Loop), to right after that block.
        const kind = st.parallel !== undefined ? 'parallel' : st.when ? 'branch' : 'loop';
        const inBlock = (x: ScenarioStep) => (kind === 'parallel' ? x.parallel === st.parallel : kind === 'branch' ? sameWhen(x.when, st.when) : Boolean(x.loop));
        const last = d.steps.reduce((n, x, k) => (inBlock(x) ? k : n), i);
        const { parallel, when, loop, approve, ...rest } = st;
        // A Parallel's or the Loop's You approve stays with the block, on the step that ends it now.
        const ofBlock = kind !== 'branch';
        const out: ScenarioStep = { ...rest, ...(kind !== 'parallel' && parallel !== undefined && { parallel }), ...(kind !== 'branch' && when && { when }), ...(kind !== 'loop' && loop && { loop }), ...(approve && !ofBlock && { approve }) };
        v().change((dd) => {
          dd.steps.splice(i, 1);
          const end = dd.steps.reduce((n, x, k) => (inBlock(x) ? k : n), -1);
          if (approve && ofBlock && end !== -1 && !dd.steps[end]!.approve) dd.steps[end] = { ...dd.steps[end]!, approve };
          dd.steps.splice(last, 0, out);
        });
        select({ kind: 'step', i: last });
      },
      'dg-other-arm': (el) => {
        const i = Number(el.dataset.i);
        v().change((d) => {
          const st = d.steps[i]!;
          const { else: was, ...w } = st.when!;
          const moved: ScenarioStep = { ...st, when: was ? w : { ...w, else: true } };
          // Then-steps before the otherwise-steps.
          d.steps.splice(i, 1);
          let k = d.steps.findIndex((x) => sameWhen(x.when, w));
          const arm = d.steps.map((x, n) => [x, n] as const).filter(([x]) => sameWhen(x.when, w));
          k = was ? (arm.find(([x]) => x.when!.else)?.[1] ?? (k === -1 ? i : arm[arm.length - 1]![1] + 1)) : arm.length ? arm[arm.length - 1]![1] + 1 : i;
          d.steps.splice(k, 0, moved);
        });
        select({ kind: 'scenario' });
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
      'dg-label': (el) => v().change((d) => void (d.label = el.value), { side: false, route: false }),
      'dg-desc': (el) => v().change((d) => void (d.description = el.value), { side: false, route: false }),
      'dg-approve-text': (el) =>
        v().change((d) => {
          const st = d.steps[Number(el.dataset.i)];
          if (st) st.approve = el.value.trim() ? { text: el.value.trim() } : {};
        }, { side: false, route: false }),
      'dg-query': (el) => {
        v().query = el.value;
        v().renderFlow();
      },
      'dg-instructions': (el) => {
        const sel = v().sel;
        if (sel.kind === 'step') v().change((d) => void (d.steps[sel.i]!.instructions = el.value), { side: false, route: false });
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
      'dg-branch-on': (el) => editBranch(Number(el.dataset.i), () => {
        const out = agentOf(el.value)?.output ?? '';
        const first = (CONDITIONS[out] ?? [])[0];
        const cond = first ? conditionOf(first[0]) : null;
        return cond ? { on: el.value, if: cond } : null;
      }),
      'dg-branch-if': (el) => editBranch(Number(el.dataset.i), (w) => {
        const cond = conditionOf(el.value);
        return cond ? { on: w.on, if: cond } : null;
      }),
      'dg-loop-rounds': (el) =>
        v().change((d) => {
          const n = Number(el.value);
          d.steps.forEach((st) => st.loop && (st.loop = n ? { rounds: n } : {}));
        }),
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
    const agents = d.steps.map((st) => ({ name: st.name, ...(st.parallel !== undefined && { parallel: st.parallel }), ...(st.when && { when: st.when }), ...(st.loop && { loop: st.loop }), ...(st.approve && { approve: st.approve }) }));
    v().preview = await call('previewScenario', { agents }).catch(() => null);
  }

  const edgeCtx = (i: number): EdgeCtx | undefined => edges[i];

  function setMode(mode: 'parallel' | 'branch') {
    v().addMode = mode;
    v().query = '';
    v().renderFlow();
    $<HTMLInputElement>('.dg-menu input')?.focus();
  }

  /** Adds `name` on an arrow: in the arrow's blocks, or as the first of a new Parallel or Branch the menu opened. */
  function insertAt(ctx: EdgeCtx, name: string) {
    const view = v();
    const mode = view.addMode;
    view.adding = null;
    view.addMode = 'agent';
    view.change((d) => {
      let place = ctx;
      if (mode === 'parallel') place = { at: ctx.at, parallel: newParallel(d.steps), ...(ctx.loop && { loop: ctx.loop }) };
      if (mode === 'branch') {
        const when = defaultWhen(d.steps, ctx.at);
        if (when) place = { at: ctx.at, when };
      }
      d.steps.splice(ctx.at, 0, placed({ name }, place));
    }, { side: false });
    select({ kind: 'step', i: ctx.at });
  }

  /** Sets the condition of the branch `i` is in, on each of its steps; `fn` returning null changes nothing. */
  function editBranch(i: number, fn: (w: StepWhen) => StepWhen | null) {
    const was = v().draft().steps[i]?.when;
    if (!was) return;
    const next = fn(was);
    if (!next) return;
    v().change((d) => d.steps.forEach((st) => sameWhen(st.when, was) && (st.when = { ...next, ...(st.when!.else && { else: true as const }) })));
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
    const ctx = edgeCtx(Number(edge.dataset.i));
    if (!ctx) return;
    const d = v().draft();
    const src = d.steps[from]!;
    const moved = placed(src, ctx);
    // An arrow right above or below the step, in the same blocks, leaves it where it is.
    if ((ctx.at === from || ctx.at === from + 1) && JSON.stringify(moved) === JSON.stringify(src)) return v().renderFlow();
    const at = ctx.at > from ? ctx.at - 1 : ctx.at;
    // You approve after a Parallel or the Loop is the block's: it stays on the step that ends the block. Into one, a
    // step's own goes, as the block waits for you after its end.
    const block = blockOf(src);
    const { approve, ...bare } = moved;
    const keep = approve && !block && ctx.parallel === undefined && !ctx.loop;
    v().change((dd) => {
      dd.steps.splice(from, 1);
      dd.steps.splice(at, 0, keep ? moved : bare);
      const end = block ? dd.steps.reduce((n, x, k) => (block(x) ? k : n), -1) : -1;
      if (approve && end !== -1 && !dd.steps[end]!.approve) dd.steps[end] = { ...dd.steps[end]!, approve };
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
