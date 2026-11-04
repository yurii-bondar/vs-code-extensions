// The JSON Schemas (draft-07) of the reports a program reads. With Claude Code's --json-schema an agent hands its
// result over as structured output: Claude Code checks it against the schema and asks the agent again on a mismatch.
// The checkers in protocol.ts keep the last word, also on what a schema cannot say (a verdict's status follows from its
// findings), and they are built from the same constants, so the two do not drift apart.
import { BRANCH_PATTERN, CRITERION_STATUSES, PLAN_TYPES, REPORT_SEVERITIES, SEVERITIES, SLUG_PATTERN } from './protocol';
import type { Output } from './types';

type Schema = Record<string, unknown>;

const str = (minLength = 0, maxLength?: number): Schema => ({ type: 'string', ...(minLength && { minLength }), ...(maxLength && { maxLength }) });
const oneOf = (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] });
const list = (items: Schema, minItems = 0): Schema => ({ type: 'array', items, ...(minItems && { minItems }) });
const obj = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: 'object', properties, required });
const line: Schema = { type: 'integer', minimum: 1 };

const PLAN = obj(
  {
    type: oneOf(PLAN_TYPES),
    slug: { type: 'string', pattern: SLUG_PATTERN.source },
    title: str(1, 100),
    repos: list(obj({ name: str(1), mode: oneOf(['full', 'tests_only']), baseBranch: { type: 'string', pattern: BRANCH_PATTERN.source } }, ['name']), 1),
    openQuestions: list(obj({ question: str(), default: str(), blocking: { type: 'boolean' } }, ['question', 'default'])),
  },
  ['type', 'slug', 'repos']
);

const VERDICT = obj(
  {
    status: oneOf(['approved', 'changes_requested']),
    summary: str(),
    findings: list(obj({ severity: oneOf(SEVERITIES), repo: str(), file: str(), line, problem: str(1), fix: str() }, ['severity', 'problem'])),
  },
  ['status', 'summary', 'findings']
);

const READINESS = obj(
  {
    summary: str(),
    criteria: list(obj({ criterion: str(1), status: oneOf(CRITERION_STATUSES), evidence: str(), files: list(str()) }, ['criterion', 'status']), 1),
    gaps: list(obj({ severity: oneOf(REPORT_SEVERITIES), problem: str(1), fix: str() }, ['severity', 'problem'])),
    work: list(obj({ repo: str(), ref: str() }, [])),
    derivedCriteria: { type: 'boolean' },
  },
  ['summary', 'criteria']
);

const AUDIT = obj(
  {
    summary: str(),
    scope: list(str()),
    findings: list(obj({ severity: oneOf(REPORT_SEVERITIES), title: str(1), category: str(), repo: str(), file: str(), line, problem: str(1), impact: str(), fix: str(), effort: str() }, ['severity', 'title', 'problem'])),
  },
  ['summary', 'findings']
);

/**
 * A code or tests stage: done, or blocked by what it cannot settle (each blocker one line), with its report. Claude Code
 * ends the turn on the StructuredOutput call, and an agent often writes no text before it: the report is part of the
 * data, so a call without it is one Claude Code itself sends back.
 */
const WORK = obj({ status: oneOf(['done', 'blocked']), blockers: list(str(1)), report: str(1) }, ['status', 'report']);

const draft7 = (schema: Schema): Schema => ({ $schema: 'http://json-schema.org/draft-07/schema#', ...schema });

/** The schema of each output a program reads. */
const REPORT_SCHEMAS: Partial<Record<Output, Schema>> = { plan: draft7(PLAN), verdict: draft7(VERDICT), readiness: draft7(READINESS), audit: draft7(AUDIT), code: draft7(WORK), tests: draft7(WORK) };

export type { Schema };
export { REPORT_SCHEMAS };
