// What a branch of a scenario looks at: a result a step before it reported, read from the task's state. Pure and
// deterministic, so a replayed log takes the same branch without an event of its own.

import type { Audit, Condition, Output, Readiness, ReportSeverity, Severity, StepWhen, TaskState } from './types';

const SEVERITY: Severity[] = ['minor', 'major', 'blocker'];
const REPORT_SEVERITY: ReportSeverity[] = ['low', 'medium', 'high', 'critical'];

/** The output a step must have for a condition to be about it. */
function conditionOutput(c: Condition): Output[] {
  if ('verdict' in c || 'severity' in c) return ['verdict'];
  if ('readiness' in c) return ['readiness'];
  if ('audit' in c) return ['audit'];
  return ['code', 'tests'];
}

/** The latest verdict of `agent`: this round's, else the round before's (a loop that was left moved it there). */
function latestVerdict(s: TaskState, agent: string) {
  const find = (list: TaskState['review']['verdicts']) => [...list].reverse().find((v) => v.agent === agent);
  return find(s.review.verdicts) ?? find(s.review.lastVerdicts);
}

/**
 * Whether `c` holds for the result of `on`: null while `on` has reported nothing (it has not run, or it is turned off),
 * which a branch takes as not holding.
 */
function evaluate(s: TaskState, on: string, c: Condition): boolean | null {
  if ('verdict' in c || 'severity' in c) {
    const v = latestVerdict(s, on);
    if (!v) return null;
    if ('verdict' in c) return v.status === c.verdict;
    return v.findings.some((f) => SEVERITY.indexOf(f.severity) >= SEVERITY.indexOf(c.severity));
  }
  if ('readiness' in c || 'audit' in c) {
    const r = (s.reports || []).find((x) => x.agent === on);
    if (!r || !r.value) return null;
    if ('readiness' in c) return (r.value as Readiness).verdict === c.readiness;
    return ((r.value as Audit).findings || []).some((f) => REPORT_SEVERITY.indexOf(f.severity) >= REPORT_SEVERITY.indexOf(c.audit));
  }
  if (!s.artifacts.some((a) => a.agent === on)) return null;
  const failed = s.gateFailures.some((st) => st.agent === on);
  return c.gates === 'fail' ? failed : !failed;
}

/** Whether a step of a branch runs: its condition holds (an `else` step: it does not). A step of no branch always runs. */
function stepRuns(s: TaskState, when: StepWhen | undefined): boolean {
  if (!when) return true;
  const met = evaluate(s, when.on, when.if) === true;
  return when.else ? !met : met;
}

/** Whether two steps are in the same Branch (either arm): one on the same step, with the same condition. */
function sameBranch(a: StepWhen | undefined, b: StepWhen | undefined): boolean {
  return Boolean(a && b) && a!.on === b!.on && JSON.stringify(a!.if) === JSON.stringify(b!.if);
}

/** The condition in words, for the editor and the task screen: "reviewer approved", "auditor found high or worse". */
function describeCondition(on: string, c: Condition): string {
  if ('verdict' in c) return `${on} ${c.verdict === 'approved' ? 'approved' : 'requested changes'}`;
  if ('severity' in c) return `${on} found ${c.severity === 'blocker' ? 'a blocker' : `${c.severity} or worse`}`;
  if ('readiness' in c) return `${on} says ${c.readiness.replace('_', ' ')}`;
  if ('audit' in c) return `${on} found ${c.audit === 'critical' ? 'a critical issue' : `${c.audit} or worse`}`;
  return `${on}'s checks ${c.gates === 'pass' ? 'passed' : 'were left failing'}`;
}

export { REPORT_SEVERITY, SEVERITY, conditionOutput, describeCondition, evaluate, sameBranch, stepRuns };
