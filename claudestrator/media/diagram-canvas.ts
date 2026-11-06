// The scenario diagram's canvas: the ticket, the steps and their blocks top to bottom, the arrows with their add menu,
// and how it finishes. It draws the draft (diagram-model.ts) and keeps the arrows it drew, for the view to place by.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const dgCanvas = (function () {
  const { icon, esc, plural, agentColor } = window.CS;
  const { v, agentOf, outputLabel, kindOf, misfit, stageOf, blockEnd, PARALLEL_OUTPUTS, REPORTS, defaultWhen, describeWhen, approveWhy } = dgModel;
  const SCOPE_TEXT: Record<string, string> = { repo: 'per repo', repos: 'all repos', task: 'once' };

  /** The arrows drawn last, by their `data-i`: drawn again in the same order, an open menu stays on its arrow. */
  let edges: EdgeCtx[] = [];

  /** The arrow `i` drawn last. */
  const edgeCtx = (i: number): EdgeCtx | undefined => edges[i];
  /** The last arrow of the main chain, before Finish, where the toolbar adds; -1 before anything is drawn. */
  const finishEdge = (n: number): number => edges.reduce((last, e, k) => (e.at === n && e.parallel === undefined && !e.when && !e.loop ? k : last), -1);

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

  return { flowHtml, edgeCtx, finishEdge };
})();
