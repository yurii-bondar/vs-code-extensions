// One human line per persisted event, for the activity timeline.
const at = (agent, repo) => `${agent}${repo ? ` @ ${repo}` : ''}`;

const READINESS = { ready: 'ready', not_ready: 'not ready', needs_check: 'needs a human check' };

const CHECKPOINT_TITLE = {
  'approve-plan': 'Plan approval',
  'gate-failure': 'Checks are red',
  'agent-failure': 'An agent failed',
  'review-limit': 'Review rounds used up',
  'hook-failure': 'Commit failed',
  'confirm-push': 'Confirm push',
};

function describeEvent(e) {
  switch (e.type) {
    case 'task_created':
      return { tone: 'strong', icon: 'add', text: `${{ readiness: 'Readiness check', audit: 'Audit' }[e.scenario] || 'Task'} created · ${e.pipeline.stages.map((s) => s.agent).join(' → ') || 'intake only'}` };
    case 'intake_completed':
      return { tone: 'normal', icon: 'note', text: `Ticket ready: ${e.spec.title}` };
    case 'stage_started':
      return { tone: 'normal', icon: 'play', text: `${at(e.agent, e.repo)} started` };
    case 'stage_completed': {
      let verdict = e.verdict ? (e.verdict.status === 'approved' ? ' · approved' : ` · changes requested (${e.verdict.findings.length} findings)`) : '';
      let tone = e.gates === 'fail' || (e.verdict && e.verdict.status === 'changes_requested') ? 'warn' : 'ok';
      if (e.readiness) {
        const met = e.readiness.criteria.filter((c) => c.status === 'met').length;
        verdict = ` · ${READINESS[e.readiness.verdict] || e.readiness.verdict} (${met}/${e.readiness.criteria.length} criteria met)`;
        if (e.readiness.verdict !== 'ready') tone = 'warn';
      }
      if (e.audit) {
        const n = (sev) => e.audit.findings.filter((f) => f.severity === sev).length;
        verdict = ` · ${e.audit.findings.length} findings (${['critical', 'high', 'medium', 'low'].map((sev) => `${n(sev)} ${sev}`).join(', ')})`;
        if (n('critical') || n('high')) tone = 'warn';
      }
      return { tone, icon: 'check', text: `${at(e.agent, e.repo)} finished${verdict}${e.gates === 'fail' ? ' · checks red' : e.gates === 'pass' ? ' · checks green' : ''}`, artifact: e.artifact };
    }
    case 'stage_failed':
      return { tone: 'error', icon: 'error', text: `${at(e.agent, e.repo)} failed: ${e.error}` };
    case 'gates_ran':
      return { tone: e.status === 'fail' ? 'error' : e.status === 'pass' ? 'ok' : 'dim', icon: 'beaker', text: `Checks in ${e.repo || (e.repos || []).join(', ')} (attempt ${e.attempt}): ${e.status}` };
    case 'checkpoint_answered':
      return { tone: 'strong', icon: 'person', text: `You answered "${CHECKPOINT_TITLE[e.id] || e.id}": ${e.option}${e.feedback ? ` — "${e.feedback}"` : ''}` };
    case 'committed':
      return { tone: 'normal', icon: 'git-commit', text: `Committed: ${e.repos.join(', ') || 'nothing to commit'}` };
    case 'commit_failed':
      return { tone: 'error', icon: 'error', text: `Commit failed in ${e.repo}` };
    case 'published':
      return { tone: 'ok', icon: 'git-pull-request', text: `Draft PRs opened: ${Object.keys(e.prs).join(', ')}` };
    case 'stopped':
      return { tone: 'warn', icon: 'debug-stop', text: `Stopped${e.reason ? `: ${e.reason}` : ''}` };
    case 'resumed':
      return { tone: 'normal', icon: 'debug-continue', text: 'Resumed' };
    case 'pipeline_changed':
      return { tone: 'strong', icon: 'edit', text: `Pipeline changed · ${e.pipeline.stages.map((s) => s.agent).join(' → ') || 'no agents'}` };
    case 'agent_stopped': {
      const p = e.payload || {};
      return { tone: 'dim', icon: 'circle-small', text: `${e.agent} session ended · ${p.turns || 0} turns · $${Number(p.costUsd || 0).toFixed(2)}` };
    }
    case 'jira_comment': {
      const what = { plan: 'the plan', prs: 'the PR links', report: 'the report' }[e.what] || 'a comment';
      return e.ok
        ? { tone: 'ok', icon: 'comment', text: `Commented on ${e.key} with ${what}${e.via && e.via !== 'api' ? ` (${e.via.replace(/^mcp:/, 'via MCP ')})` : ''}` }
        : { tone: 'error', icon: 'error', text: `Jira comment on ${e.key} failed: ${e.error}` };
    }
    case 'note':
      return { tone: /^(error|run failed)/i.test(e.message) ? 'error' : 'dim', icon: 'info', text: e.message };
    case 'transition_rejected':
      return { tone: 'error', icon: 'warning', text: `Rejected ${e.event && e.event.type}: ${e.error}` };
    default:
      return null;
  }
}

module.exports = { describeEvent, CHECKPOINT_TITLE };
