// A custom scenario drawn as a diagram: the ticket, its steps top to bottom, the approvals and the review loop the
// steps' outputs make, and how it finishes. Changes stay on the page until Save writes them to config.yaml as the
// scenario's `agents:`, the same list the Scenarios page edits as chips. This is the view: what you do on it changes the
// draft (diagram-model.ts), which diagram-canvas.ts draws and diagram-side.ts shows in the right column.

type DgPreview = Rpc['previewScenario']['result'];

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
  const { call, attempt, toast, icon, esc, $, plural, views, patch, debounce, persist, go, S, loadOverview } = window.CS;
  const { v, agentOf, asEffort, fromConfig, fresh, problems, sameWhen, blockEnd, placed, blockOf, newParallel, CONDITIONS, conditionOf, defaultWhen, approveWhy } = dgModel;
  const { flowHtml, edgeCtx, finishEdge } = dgCanvas;
  const { sideHtml } = dgSide;
  const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25];

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
      patch('dg-side', sideHtml(this.draft()));
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
        const i = Number(el.dataset.i) < 0 ? finishEdge(n) : Number(el.dataset.i);
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
