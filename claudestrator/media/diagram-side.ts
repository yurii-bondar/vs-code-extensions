// The scenario diagram's right column: the scenario, the ticket, a step, a block, You approve or a new agent, whichever
// is selected, and the route check under it.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const dgSide = (function () {
  const { icon, esc, plural, agentColor, modelChoices, EFFORT_LABEL } = window.CS;
  const { v, agentOf, outputLabel, kindOf, misfit, stageOf, sameWhen, REPORTS, EFFORTS, CONDITIONS, conditionValue, describeWhen, branchSources, problems, inReviewLoop } = dgModel;

  function modelOptions(own: string | undefined, fallback: string) {
    const c = v().c;
    const models = modelChoices(c ? c.defaults : null).filter(([m]) => m !== 'inherit');
    const known = !own || models.some(([m]) => m === own);
    return [`<option value="">${esc(fallback)}</option>`, ...models.map(([m, l]) => `<option value="${esc(m)}" ${m === own ? 'selected' : ''}>${esc(l)}</option>`), ...(known ? [] : [`<option value="${esc(own)}" selected>${esc(own)}</option>`])].join('');
  }
  function effortOptions(own: string | undefined, fallback: string) {
    return [`<option value="">${esc(fallback)}</option>`, ...EFFORTS.map((e) => `<option value="${e}" ${e === own ? 'selected' : ''}>${esc(EFFORT_LABEL[e] || e)}</option>`)].join('');
  }

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

  /** The right column for what is selected, with the route check under it. */
  function sideHtml(d: DiagramDraft): string {
    const sel = v().sel;
    const main = sel.kind === 'start' ? startSide(d) : sel.kind === 'step' ? stepSide(d, sel.i) : sel.kind === 'block' ? blockSide(d, sel.type, sel.i) : sel.kind === 'approve' ? approveSide(d, sel.i) : sel.kind === 'create' ? createSide(d, sel.at) : scenarioSide(d);
    return main + routeHtml(d);
  }

  return { sideHtml };
})();
