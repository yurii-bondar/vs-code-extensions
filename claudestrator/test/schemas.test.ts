// Reports as structured output (--json-schema): the schemas agree with the checkers, only report stages hand data
// over, and a CLI without the flag still gets by with the json block.
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { REPORT_SCHEMAS } from '../src/core/schemas';
import { parseStageReport, workReport } from '../src/core/prompt';
import { withoutTrailingJson } from '../src/core/runner';
import * as view from '../src/core/view';
import { CLI_FLAGS, workspace, harness, runTask } from './helpers/e2e';
import type { Schema } from '../src/core/schemas';
import type { Output } from '../src/core/types';

/** The draft-07 keywords the schemas use, enough to check them against the same samples as the checkers. */
function valid(schema: Schema, v: unknown): boolean {
  const s = schema as { type?: string; enum?: unknown[]; pattern?: string; minLength?: number; maxLength?: number; minimum?: number; minItems?: number; items?: Schema; properties?: Record<string, Schema>; required?: string[] };
  if (s.enum && !s.enum.includes(v)) return false;
  switch (s.type) {
    case 'string':
      return typeof v === 'string' && v.length >= (s.minLength ?? 0) && v.length <= (s.maxLength ?? Infinity) && (!s.pattern || new RegExp(s.pattern).test(v));
    case 'integer':
      return Number.isInteger(v) && (v as number) >= (s.minimum ?? -Infinity);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v) && v.length >= (s.minItems ?? 0) && v.every((x) => valid(s.items!, x));
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      return (s.required || []).every((k) => o[k] !== undefined) && Object.entries(s.properties || {}).every(([k, sub]) => o[k] === undefined || valid(sub, o[k]));
    }
    default:
      return true;
  }
}

const SAMPLES: Record<string, { good: unknown; bad: unknown[] }> = {
  plan: {
    good: { type: 'feat', slug: 'cap-max-bet', title: 'Cap the max bet', repos: [{ name: 'api', baseBranch: 'release/2.x' }, { name: 'web', mode: 'tests_only' }], openQuestions: [{ question: 'Per operator?', default: 'yes' }] },
    bad: [{ type: 'feat', slug: 'Cap Bet', repos: [{ name: 'api' }] }, { type: 'feature', slug: 'x', repos: [{ name: 'api' }] }, { type: 'fix', slug: 'x', repos: [] }, { type: 'fix', slug: 'x', repos: [{ name: 'api', baseBranch: '-rf' }] }],
  },
  verdict: {
    good: { status: 'changes_requested', summary: 'one gap', findings: [{ severity: 'major', repo: 'api', file: 'a.ts', line: 3, problem: 'no test' }] },
    bad: [{ status: 'ok', summary: '', findings: [] }, { status: 'approved', summary: '', findings: [{ severity: 'minor', problem: 'x', line: 0 }] }, { status: 'approved', findings: [] }],
  },
  readiness: {
    good: { summary: 's', criteria: [{ criterion: 'bets are capped', status: 'met', evidence: 'bet.ts:12', files: ['api/bet.ts'] }], gaps: [{ severity: 'high', problem: 'no test' }], work: [{ repo: 'api', ref: 'feat/x' }] },
    bad: [{ summary: 's', criteria: [] }, { summary: 's', criteria: [{ criterion: 'c', status: 'done' }] }],
  },
  audit: {
    good: { summary: 's', scope: ['api'], findings: [{ severity: 'critical', title: 'Negative payout', category: 'bug', file: 'pay.ts', line: 7, problem: 'no bound' }] },
    bad: [{ summary: 's', findings: [{ severity: 'blocker', title: 't', problem: 'p' }] }, { summary: 's', findings: [{ severity: 'low', problem: 'p' }] }],
  },
};

test('schemas: every report schema accepts what its checker accepts and rejects what it rejects', async () => {
  assert.deepEqual(Object.keys(REPORT_SCHEMAS).sort(), ['audit', 'code', 'plan', 'readiness', 'tests', 'verdict']);
  // Code and tests stages say done or blocked; their checker is lenient (no status: done), the schema is not.
  for (const output of ['code', 'tests'] as const) {
    const schema = REPORT_SCHEMAS[output]!;
    assert.ok(valid(schema, { status: 'done' }) && valid(schema, { status: 'blocked', blockers: ['no such table'] }));
    for (const b of [{ status: 'stuck' }, {}, { status: 'blocked', blockers: [''] }]) assert.ok(!valid(schema, b), `${output}: ${JSON.stringify(b)}`);
    assert.deepEqual(workReport('', { status: 'blocked', blockers: ['no such table'] }), { status: 'blocked', blockers: ['no such table'] });
    assert.deepEqual(workReport('Changed a.ts.'), { status: 'done', blockers: [] }, 'a report without one is done, as before');
    assert.deepEqual(workReport('x\n```json\n{"status": "blocked", "blockers": ["b"]}\n```'), { status: 'blocked', blockers: ['b'] }, 'from a json block without --json-schema');
  }
  for (const [output, { good, bad }] of Object.entries(SAMPLES)) {
    const schema = REPORT_SCHEMAS[output as Output]!;
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#', 'Claude Code validates draft-07');
    assert.ok(valid(schema, good), `${output}: the schema takes a good report`);
    // The checker also wants the report's text (a plan's with a section per repo): the schema holds only the data.
    const repos = output === 'plan' ? (good as { repos: { name: string }[] }).repos : [];
    const prose = `The report.\n\n${repos.map((r) => `### ${r.name}\n- a step`).join('\n\n')}`;
    assert.ok(parseStageReport(output as Output, prose, good).ok, `${output}: so does the checker`);
    for (const b of bad) {
      assert.ok(!valid(schema, b), `${output}: the schema refuses ${JSON.stringify(b)}`);
      assert.ok(!parseStageReport(output as Output, prose, b).ok, `${output}: so does the checker`);
    }
  }
});

test('schemas: the checker keeps the last word on what a schema cannot say', async () => {
  const verdict = { status: 'approved', summary: 'fine', findings: [{ severity: 'major', problem: 'no test for the new branch' }] };
  assert.ok(valid(REPORT_SCHEMAS.verdict!, verdict), 'the shape is right');
  const r = parseStageReport('verdict', '', verdict);
  assert.ok(!r.ok && /changes_requested exactly when/.test(r.error), 'but approved with a major finding is refused, and sent back');
});

test('schemas: a json block the agent also wrote is cut from the end of its report only', async () => {
  assert.equal(withoutTrailingJson('## Review\n\nFine.\n\n```json\n{"status":"approved"}\n```\n'), '## Review\n\nFine.');
  const example = '## Contract\n\n```json\n{"id": 1}\n```\n\nThe rest of the report.';
  assert.equal(withoutTrailingJson(example), example, 'an example in the middle stays');
  assert.equal(withoutTrailingJson(`${example}\n\n\`\`\`json\n{"x":1}\n\`\`\``), example);
});

test('schemas: report stages hand their data over as structured output, and the artifact still reads as one report', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' });
  try {
    const { taskId } = await h.engine.start({ text: 'Do a thing', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'confirm-push');
    const nameOf = (c: { args: string[] }): string => c.args[c.args.indexOf('--name') + 1] || '';
    const schemaOf = (agent: string): string | undefined => {
      const c = h.calls().find((x: { args: string[] }) => x.args.includes('-p') && new RegExp(`· ${agent}( @|$)`).test(nameOf(x)));
      assert.ok(c, `${agent} ran`);
      return c.args.includes('--json-schema') ? c.args[c.args.indexOf('--json-schema') + 1] : undefined;
    };
    assert.deepEqual(JSON.parse(schemaOf('planner')!).required, ['type', 'slug', 'repos']);
    assert.deepEqual(JSON.parse(schemaOf('reviewer')!).required, ['status', 'summary', 'findings']);
    assert.deepEqual(JSON.parse(schemaOf('developer')!).required, ['status'], 'a code stage hands over its status');
    assert.equal(s.plan!.slug, 'add-feature');
    const plan = await h.engine.svc.readArtifact(taskId, 'plan/planner.md');
    assert.match(plan, /^## Summary[\s\S]*\n```json\n\{\n {2}"type": "feat",/, 'the report, then its data as a json block');
    assert.equal((plan.match(/```json/g) || []).length, 1);
    const key = (await view.detail(h.engine, taskId)).steps.find((st) => st.agent === 'reviewer')!.key!;
    // What the agent handed over shows in its transcript: a report that came as data alone is seen there.
    const handover = (await h.engine.svc.readTranscript(taskId, key)).find((i) => i.type === 'tool_use' && i.name === 'StructuredOutput');
    assert.ok(handover && handover.type === 'tool_use' && (handover.input as { status?: string }).status, 'the hand-over is shown, with its data');
  } finally {
    h.hooks.dispose();
  }
});

test('schemas: a CLI without --json-schema still runs the pipeline on the json block', async () => {
  const ws = workspace(['api'], 'repos:\n  api: {}\n');
  const h = await harness(ws, { FAKE_REPOS: 'api' }, { flags: CLI_FLAGS.filter((f) => f !== '--json-schema') });
  try {
    const { taskId } = await h.engine.start({ text: 'Do a thing', auto: true });
    const s = await runTask(h.engine, taskId);
    assert.equal(s.checkpoint!.id, 'confirm-push');
    assert.ok(!h.calls().some((c: { args: string[] }) => c.args.includes('--json-schema')));
    assert.equal(s.plan!.slug, 'add-feature');
  } finally {
    h.hooks.dispose();
  }
});
