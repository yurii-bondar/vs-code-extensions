// Turns the resolved config into stages and loop rules. Routing depends on outputs only, never on names.

const isWork = (o) => o === 'code' || o === 'tests';

/** `opts.scenario`: `deliver` (default) runs `config.pipeline`; a report scenario runs its own read-only agents. */
function buildPipeline(config, opts = {}) {
  const scenario = opts.scenario || 'deliver';
  if (scenario !== 'deliver') return reportPipeline(config, scenario);
  const warnings = [];
  const enabled = config.pipeline.map((n) => config.agents[n]).filter((a) => a && a.enabled);

  const stages = enabled.map((a, i) => ({
    agent: a.name,
    output: a.output,
    scope: isWork(a.output) ? 'repo' : 'task',
    approval: a.output === 'plan' && !opts.auto && enabled.slice(i + 1).some((b) => b.output !== 'plan'),
  }));

  const firstIndex = (pred) => stages.findIndex(pred);
  const lastIndex = (pred) => {
    for (let i = stages.length - 1; i >= 0; i--) if (pred(stages[i])) return i;
    return -1;
  };
  const warn = (code, message, agent) => warnings.push({ level: 'warning', code, message, ...(agent && { agent }) });

  const plans = stages.filter((s) => s.output === 'plan');
  if (plans.length > 1) warn('multiple_plans', `more than one plan stage: ${plans.map((s) => s.agent).join(', ')}; each re-plans from the previous plan`);
  const firstPlan = firstIndex((s) => s.output === 'plan');
  if (firstPlan > 0) warn('plan_not_first', `plan stage "${stages[firstPlan].agent}" runs after other stages`, stages[firstPlan].agent);

  const firstCode = firstIndex((s) => s.output === 'code');
  const firstTests = firstIndex((s) => s.output === 'tests');
  if (firstTests !== -1 && (firstCode === -1 || firstTests < firstCode)) {
    warn('tests_without_code', `"${stages[firstTests].agent}" tests code no stage before it wrote; it will test the existing branch`, stages[firstTests].agent);
  }

  const lastVerdict = lastIndex((s) => s.output === 'verdict');
  const firstVerdict = firstIndex((s) => s.output === 'verdict');
  const lastWork = lastIndex((s) => isWork(s.output));
  if (lastVerdict !== -1 && lastWork > lastVerdict) {
    warn('unreviewed_work', `"${stages[lastWork].agent}" runs after the last review, so its changes are never reviewed`, stages[lastWork].agent);
  }
  if (firstVerdict !== -1 && firstCode !== -1 && firstVerdict < firstCode) {
    warn('verdict_before_code', `"${stages[firstVerdict].agent}" reviews before any code is written; it reviews the existing branch`, stages[firstVerdict].agent);
  }
  if (firstPlan === -1 && firstIndex((s) => s.scope === 'repo') !== -1) {
    warn('no_plan', 'no plan stage: per-repo stages have no repos to run in unless the task names them');
  }

  let reviewLoop = null;
  const restartAt = lastVerdict === -1 ? -1 : firstIndex((s) => isWork(s.output));
  if (restartAt !== -1 && restartAt < lastVerdict) {
    const span = stages.slice(restartAt, lastVerdict + 1);
    reviewLoop = {
      restartAt,
      end: lastVerdict,
      fixers: span.filter((s) => isWork(s.output)).map((s) => s.agent),
      reviewers: span.filter((s) => s.output === 'verdict').map((s) => s.agent),
      maxRounds: config.limits.reviewRounds,
    };
  }

  return { mode: modeOf(stages, reviewLoop), scenario: 'deliver', stages, reviewLoop, warnings };
}

/** Readiness and audit: task-scoped stages one after another, no approval, no review loop, no git. */
function reportPipeline(config, scenario) {
  const names = (config.scenarios && config.scenarios[scenario]) || [];
  const stages = names
    .map((n) => config.agents[n])
    .filter((a) => a && a.enabled)
    .map((a) => ({ agent: a.name, output: a.output, scope: 'task', approval: false }));
  return { mode: scenario, scenario, stages, reviewLoop: null, warnings: [] };
}

function modeOf(stages, loop) {
  if (stages.length === 0) return 'intake_only';
  const outputs = new Set(stages.map((s) => s.output));
  if (outputs.size === 1 && outputs.has('plan')) return 'plan_only';
  if (outputs.size === 1 && outputs.has('verdict')) return 'review_only';
  const has = (o) => outputs.has(o);
  if (has('plan') && has('code') && has('tests') && has('verdict') && loop && stages[0].output === 'plan') return 'full';
  return 'custom';
}

/** A plain-language outline of a pipeline, as chips for the UI: `[{ text, kind }]`. */
function outline(pipeline) {
  const out = [];
  const { stages, reviewLoop } = pipeline;
  let i = 0;
  while (i < stages.length) {
    const st = stages[i];
    if (reviewLoop && i === reviewLoop.restartAt) out.push({ kind: 'loop-start', text: `review loop · up to ${reviewLoop.maxRounds} round${reviewLoop.maxRounds === 1 ? '' : 's'}` });
    if (st.scope === 'repo') {
      let j = i;
      const block = [];
      while (j < stages.length && stages[j].scope === 'repo') block.push(stages[j++]);
      out.push({ kind: 'repo-block', text: 'per repo', agents: block.map((b) => ({ agent: b.agent, output: b.output })) });
      i = j;
    } else {
      out.push({ kind: 'stage', agent: st.agent, output: st.output, text: st.agent });
      if (st.approval) out.push({ kind: 'human', text: 'you approve' });
      i++;
    }
    if (reviewLoop && i - 1 === reviewLoop.end) out.push({ kind: 'loop-end', text: 'fix rounds' });
  }
  if (stages.some((s) => s.scope === 'repo')) out.push({ kind: 'finish', text: 'commit' }, { kind: 'human', text: 'you confirm push' }, { kind: 'finish', text: 'draft PRs' });
  else if (pipeline.scenario && stages.length) out.push({ kind: 'finish', text: pipeline.scenario === 'audit' ? 'audit report' : 'readiness report' });
  return out;
}

module.exports = { buildPipeline, outline };
