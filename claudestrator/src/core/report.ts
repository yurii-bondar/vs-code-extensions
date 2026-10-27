// The result of a readiness check or an audit: one view over every agent's report, the task's `report.md`,
// and the text of a Jira comment. Built from the validated JSON blocks, so it reads the same every time.
import { REPORT_SEVERITIES } from './protocol';
import type { AuditResult, ReadinessResult, Result } from './wire';
import type { Audit, Readiness, ReadinessVerdict, ReportSeverity, TaskState } from './types';

const VERDICTS: ReadinessVerdict[] = ['not_ready', 'needs_check', 'ready'];

interface Labels {
  readiness: string;
  audit: string;
  verdict: Record<string, string>;
  status: Record<string, string>;
  criteria: string;
  criterion: string;
  state: string;
  evidence: string;
  derived: string;
  gaps: string;
  work: string;
  noWork: string;
  summary: string;
  scope: string;
  findings: string;
  none: string;
  impact: string;
  fix: string;
  by: string;
  sev: Record<string, string>;
}

const EN: Labels = {
  readiness: 'Readiness check',
  audit: 'Audit',
  verdict: { ready: 'Ready', not_ready: 'Not ready', needs_check: 'Needs a human check' },
  status: { met: 'met', partial: 'partial', not_met: 'not met', unverifiable: 'check by hand' },
  criteria: 'Acceptance criteria',
  criterion: 'Criterion',
  state: 'Status',
  evidence: 'Evidence',
  derived: 'The ticket has no acceptance criteria; these were derived from its description.',
  gaps: 'Gaps',
  work: 'Work checked',
  noWork: 'No branch or PR named; the base branches were checked.',
  summary: 'Summary',
  scope: 'Scope',
  findings: 'Findings',
  none: 'none',
  impact: 'Impact',
  fix: 'Fix',
  by: 'by',
  sev: { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' },
};
const UK: Labels = {
  readiness: 'Перевірка готовності',
  audit: 'Аудит',
  verdict: { ready: 'Готово', not_ready: 'Не готово', needs_check: 'Потрібна ручна перевірка' },
  status: { met: 'виконано', partial: 'частково', not_met: 'не виконано', unverifiable: 'перевірити вручну' },
  criteria: 'Критерії приймання',
  criterion: 'Критерій',
  state: 'Статус',
  evidence: 'Докази',
  derived: 'У тікеті немає критеріїв приймання; їх виведено з опису.',
  gaps: 'Прогалини',
  work: 'Що перевірено',
  noWork: 'Гілку чи PR не знайдено; перевірено базові гілки.',
  summary: 'Підсумок',
  scope: 'Обсяг',
  findings: 'Знахідки',
  none: 'немає',
  impact: 'Вплив',
  fix: 'Виправлення',
  by: 'агент',
  sev: { critical: 'Критичні', high: 'Високі', medium: 'Середні', low: 'Низькі' },
};
const labels = (language?: string): Labels => (/ukrain|україн/i.test(language || '') ? UK : EN);
const ICON: Record<string, string> = { met: '✅', partial: '🟡', not_met: '❌', unverifiable: '❔', ready: '✅', not_ready: '❌', needs_check: '❔' };
const rank = (sev: ReportSeverity): number => REPORT_SEVERITIES.indexOf(sev);
const cell = (v: unknown): string => String(v || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

function resultOf(state: TaskState): Result | null {
  const reports = state.reports || [];
  if (!reports.length) return null;
  if (state.scenario === 'audit') {
    const findings = reports
      .flatMap((r) => (r.value as Audit).findings.map((f) => ({ ...f, agent: r.agent })))
      .sort((a, b) => rank(a.severity) - rank(b.severity));
    const counts = Object.fromEntries(REPORT_SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
    return {
      kind: 'audit',
      summaries: reports.map((r) => ({ agent: r.agent, text: r.value!.summary, artifact: r.artifact })),
      scope: [...new Set(reports.flatMap((r) => (r.value as Audit).scope))],
      counts,
      findings,
    };
  }
  const values = (r: (typeof reports)[number]): Readiness => r.value as Readiness;
  const verdict = reports.map((r) => values(r).verdict).sort((a, b) => VERDICTS.indexOf(a) - VERDICTS.indexOf(b))[0]!;
  const criteria = reports.flatMap((r) => values(r).criteria.map((c) => ({ ...c, agent: r.agent })));
  return {
    kind: 'readiness',
    verdict,
    summaries: reports.map((r) => ({ agent: r.agent, text: r.value!.summary, artifact: r.artifact })),
    criteria,
    met: criteria.filter((c) => c.status === 'met').length,
    gaps: reports.flatMap((r) => values(r).gaps.map((g) => ({ ...g, agent: r.agent }))).sort((a, b) => rank(a.severity) - rank(b.severity)),
    work: reports.flatMap((r) => values(r).work),
    derivedCriteria: reports.some((r) => values(r).derivedCriteria),
  };
}

const where = (f: { repo?: string; file?: string; line?: number }): string => [f.repo, f.file && `${f.file}${f.line ? `:${f.line}` : ''}`].filter(Boolean).join(' · ');

/** `report.md`: the human-readable result in the task's language. */
function renderReport(state: TaskState, language?: string): string {
  const r = resultOf(state);
  if (!r) return '';
  const t = labels(language);
  const title = (state.spec && state.spec.title) || state.taskId;
  const many = r.summaries.length > 1;
  const summaries = r.summaries.map((s) => (many ? `**${s.agent}:** ${s.text}` : s.text)).join('\n\n');
  if (r.kind === 'readiness') {
    const parts = [
      `# ${t.readiness}: ${title}`,
      `**${ICON[r.verdict]} ${t.verdict[r.verdict]}** · ${r.met}/${r.criteria.length} ${t.status.met}`,
      summaries,
      `## ${t.criteria}`,
      ...(r.derivedCriteria ? [`_${t.derived}_`] : []),
      [`| | ${t.criterion} | ${t.state} | ${t.evidence} |`, '|---|---|---|---|', ...r.criteria.map((c) => `| ${ICON[c.status]} | ${cell(c.criterion)} | ${t.status[c.status]} | ${cell([c.evidence, ...c.files.map((f) => `\`${f}\``)].filter(Boolean).join(' '))} |`)].join('\n'),
      `## ${t.gaps}`,
      r.gaps.length ? r.gaps.map((g) => `- **${g.severity}** ${g.problem}${g.fix ? ` → ${g.fix}` : ''}`).join('\n') : `_${t.none}_`,
      `## ${t.work}`,
      r.work.length ? r.work.map((w) => `- ${[w.repo, w.ref].filter(Boolean).join(': ')}`).join('\n') : `_${t.noWork}_`,
    ];
    return `${parts.join('\n\n')}\n`;
  }
  const parts = [
    `# ${t.audit}: ${title}`,
    REPORT_SEVERITIES.map((s) => `**${t.sev[s]}: ${r.counts[s]}**`).join(' · '),
    summaries,
    ...(r.scope.length ? [`**${t.scope}:** ${r.scope.join(', ')}`] : []),
  ];
  for (const sev of REPORT_SEVERITIES) {
    const list = r.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    parts.push(`## ${t.sev[sev]} (${list.length})`);
    list.forEach((f, i) => {
      const meta = [f.category, where(f) && `\`${where(f)}\``, f.effort && `effort ${f.effort}`, many && `${t.by} ${f.agent}`].filter(Boolean).join(' · ');
      parts.push([`### ${i + 1}. ${f.title}`, meta, f.problem, f.impact && `**${t.impact}:** ${f.impact}`, f.fix && `**${t.fix}:** ${f.fix}`].filter(Boolean).join('\n\n'));
    });
  }
  if (!r.findings.length) parts.push(`## ${t.findings}`, `_${t.none}_`);
  return `${parts.join('\n\n')}\n`;
}

/** A compact plain-text version for a Jira comment (Jira renders paragraphs and line breaks). */
function jiraText(state: TaskState, language?: string, max = 20000): string {
  const r = resultOf(state);
  if (!r) return '';
  const t = labels(language);
  const lines: string[] = [];
  if (r.kind === 'readiness') {
    lines.push(`${t.readiness}: ${ICON[r.verdict]} ${t.verdict[r.verdict]} (${r.met}/${r.criteria.length} ${t.status.met})`, '', ...r.summaries.map((s) => s.text), '', `${t.criteria}:`);
    for (const c of r.criteria) lines.push(`${ICON[c.status]} ${c.criterion}${c.evidence ? ` — ${c.evidence}` : ''}`);
    if (r.gaps.length) lines.push('', `${t.gaps}:`, ...r.gaps.map((g) => `[${g.severity}] ${g.problem}${g.fix ? ` → ${g.fix}` : ''}`));
    if (r.work.length) lines.push('', `${t.work}: ${r.work.map((w) => [w.repo, w.ref].filter(Boolean).join(': ')).join('; ')}`);
  } else {
    lines.push(`${t.audit}: ${REPORT_SEVERITIES.map((s) => `${t.sev[s]} ${r.counts[s]}`).join(', ')}`, '', ...r.summaries.map((s) => s.text));
    for (const sev of REPORT_SEVERITIES) {
      const list = r.findings.filter((f) => f.severity === sev);
      if (!list.length) continue;
      lines.push('', `${t.sev[sev]}:`);
      // The worst findings in full, the rest as one-liners: a comment is a summary, report.md has everything.
      for (const f of list) lines.push(rank(sev) <= 1 ? `- ${f.title} (${where(f)}): ${f.problem}${f.fix ? ` → ${f.fix}` : ''}` : `- ${f.title}${where(f) ? ` (${where(f)})` : ''}`);
    }
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export type { AuditResult, ReadinessResult, Result };
export { resultOf, renderReport, jiraText, VERDICTS };
