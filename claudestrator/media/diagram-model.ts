// The scenario diagram's draft and what it may hold: the blocks its steps are in, the conditions of a branch, and what
// Save would be refused for. No HTML here: diagram-canvas.ts draws the draft, diagram-side.ts its right column, and
// diagram.ts is the view that changes it. They are plain scripts loaded in that order, each publishing one `const`.

type DgConfig = Extract<ConfigData, { ok: true }>;

/** The scenario being drawn: what Save writes. `id` is null until a new one is saved. */
interface DiagramDraft {
  id: string | null;
  label: string;
  description: string;
  steps: ScenarioStep[];
  intake: { model?: string; effort?: Effort };
  dirty: boolean;
}

/** Where a step added or dropped on an arrow goes, and the blocks it is then in. */
interface EdgeCtx {
  at: number;
  parallel?: number;
  when?: StepWhen;
  loop?: { rounds?: number };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const dgModel = (function () {
  const { views, OUTPUT_INFO } = window.CS;
  const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  const REPORTS = ['readiness', 'audit'];
  const asEffort = (v: string) => EFFORTS.find((e) => e === v);

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

  return { EFFORTS, REPORTS, PARALLEL_OUTPUTS, asEffort, v, agentOf, outputLabel, kindOf, misfit, fromConfig, fresh, stageOf, sameWhen, blockEnd, placed, blockOf, newParallel, CONDITIONS, conditionValue, conditionOf, describeWhen, branchSources, defaultWhen, problems, approveWhy, inReviewLoop };
})();
