// The task screen: what needs you (checkpoint, permissions, errors), the step timeline, the agent's live
// output with a message box, the activity feed, files, ticket and plan.

interface TaskView extends View {
  load(first?: boolean): Promise<void>;
  loadTranscript(): Promise<void>;
  render(): void;
  refresh(): Promise<void>;
}

// Merges into `Views` of globals.d.ts, which is where the shell reads this screen.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Views {
  task: TaskView;
}

(function () {
  const { call, attempt, toast, icon, esc, md, $, $$, ago, clock, dur, money, size, plural, stepName, agentColor, S, views, go, patch, persist, statusBadge, sourceChip, permissionCard, autosize, shake, fmtTokens, meter, level, effortTag, scenarioChip, groupChip, sevCounts, SCENARIO_INFO, pipeRowHtml, pipeEditors, pipeDragging } = window.CS;

  type ReadinessResult = Extract<TaskResult, { kind: 'readiness' }>;
  type AuditResult = Extract<TaskResult, { kind: 'audit' }>;
  type ToolResult = Extract<TranscriptItem, { type: 'tool_result' }>;

  interface CpOption {
    label: string;
    kind: 'primary' | 'secondary' | 'ghost' | 'warn';
    icon: string;
    feedback?: 'required' | 'optional';
    hint?: string;
  }
  interface CpUi {
    title: string;
    lead: string;
    options: Record<string, CpOption>;
    placeholder?: string;
  }

  const CP_UI: Record<string, CpUi> = {
    'approve-plan': {
      title: 'Review the plan',
      lead: 'Nothing has changed in your repos yet. Approve the plan to start development, or tell the planner what to change.',
      options: {
        approve: { label: 'Approve plan', kind: 'primary', icon: 'check' },
        'approve-post': { label: 'Approve & post to Jira', kind: 'secondary', icon: 'jira' },
        change: { label: 'Request changes', kind: 'secondary', icon: 'edit', feedback: 'required' },
        stop: { label: 'Stop task', kind: 'ghost', icon: 'stop' },
      },
      placeholder: 'What should the planner change? e.g. "Keep the API backwards compatible; add the field as optional"',
    },
    'gate-failure': {
      title: 'Checks are still red',
      lead: 'The agent tried to fix the failing checks but they stayed red. Let it try again (with a hint), or continue and the failure is noted in the PR.',
      options: {
        retry: { label: 'Let the agent fix it', kind: 'primary', icon: 'refresh', feedback: 'optional' },
        continue: { label: 'Continue with red checks', kind: 'warn', icon: 'alert' },
        stop: { label: 'Stop task', kind: 'ghost', icon: 'stop' },
      },
      placeholder: 'A hint for the agent (optional), e.g. "the snapshot needs updating"',
    },
    'agent-failure': {
      title: 'An agent stopped early',
      lead: 'The step ended before the agent handed in a usable report. Retry it, optionally with guidance.',
      options: { retry: { label: 'Retry this step', kind: 'primary', icon: 'refresh', feedback: 'optional' }, stop: { label: 'Stop task', kind: 'ghost', icon: 'stop' } },
      placeholder: 'Guidance for the retry (optional)',
    },
    'review-limit': {
      title: 'Review rounds used up',
      lead: 'The reviewer still has blocking findings after the last fix round.',
      options: {
        retry: { label: 'One more fix round', kind: 'primary', icon: 'refresh', feedback: 'optional' },
        continue: { label: 'Accept and continue', kind: 'secondary', icon: 'check', hint: 'Open findings go into the PR description.' },
        stop: { label: 'Stop task', kind: 'ghost', icon: 'stop' },
      },
      placeholder: 'Priorities for the fix round (optional)',
    },
    'hook-failure': {
      title: 'A git hook rejected the commit',
      lead: 'Fix what the hook complains about (for example run the formatter in that repo), then retry.',
      options: { retry: { label: 'Retry the commit', kind: 'primary', icon: 'refresh' }, stop: { label: 'Stop task', kind: 'ghost', icon: 'stop' } },
    },
    'confirm-push': {
      title: 'Push and open draft PRs?',
      lead: 'Everything is committed locally on the task branch. Nothing leaves your machine until you choose.',
      options: {
        push: { label: 'Push & open draft PRs', kind: 'primary', icon: 'pr' },
        'push-comment': { label: 'Push, open PRs & comment in Jira', kind: 'secondary', icon: 'jira' },
        local: { label: 'Keep it local', kind: 'secondary', icon: 'commit', hint: 'Branches and commits stay; push them yourself later.' },
      },
    },
  };

  const STATUS_ICON: Record<string, string | null> = { done: 'check', running: null, failed: 'alert', waiting: 'bell', paused: 'pause', interrupted: 'alert', next: 'play', pending: null, skipped: 'x' };

  /** What the screen remembers between refreshes. */
  const T: {
    taskId: string;
    d: TaskScreen | null;
    tab: string;
    viewKey: string | null;
    follow: boolean;
    items: TranscriptItem[];
    liveText: string;
    cpKey: string | null;
    feedback: string;
    /** Audit findings shown: 'all' or one severity. */
    sev: string;
  } = {
    taskId: '',
    d: null,
    tab: 'output',
    viewKey: null,
    follow: true,
    items: [],
    liveText: '',
    cpKey: null,
    feedback: '',
    sev: 'all',
  };

  const VERDICT_UI: Record<string, { label: string; icon: string; tone: string; lead: string }> = {
    ready: { label: 'Ready', icon: 'check', tone: 'ok', lead: 'Every acceptance criterion is met, with evidence in the code.' },
    not_ready: { label: 'Not ready', icon: 'x', tone: 'error', lead: 'Some criteria are not met, or a gap blocks the release.' },
    needs_check: { label: 'Needs a human check', icon: 'eye', tone: 'warn', lead: 'What the code can show is done; some criteria can only be verified by hand.' },
  };
  const CRITERION_UI: Record<string, { label: string; icon: string }> = { met: { label: 'met', icon: 'check' }, partial: { label: 'partial', icon: 'alert' }, not_met: { label: 'not met', icon: 'x' }, unverifiable: { label: 'check by hand', icon: 'eye' } };
  const SEVERITIES = ['critical', 'high', 'medium', 'low'];
  const COMMENT_WHAT: Record<string, string> = { plan: 'the plan', prs: 'the PR links', report: 'the report' };

  /** A field of untyped JSON, such as the input of a tool call. */
  const field = (v: unknown, key: string): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined);
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  const colors = () => Object.fromEntries(((S.overview && S.overview.config && S.overview.config.ok && S.overview.config.agents) || []).map((a) => [a.name, a.color]));

  const sendMessage = async () => {
    const ta = $<HTMLTextAreaElement>('#msg-text')!;
    const text = ta.value.trim();
    if (!text) return shake(ta);
    const r = await attempt('message', { taskId: T.taskId, text });
    if (r !== undefined) {
      ta.value = '';
      autosize(ta);
    }
  };

  views.task = {
    async enter(route) {
      Object.assign(T, { taskId: route.taskId ?? '', d: null, viewKey: null, follow: true, items: [], liveText: '', cpKey: null, sev: 'all', tab: S.ui.taskTab || 'output' });
      $('#view')!.innerHTML = `
        <div class="page task-page">
          <button class="back" data-action="go-home">${icon('back')}All tasks</button>
          <div data-region="task-header"></div>
          <div data-region="task-alerts"></div>
          <div data-region="task-perms"></div>
          <div data-region="task-checkpoint"></div>
          <div data-region="task-result"></div>
          <div data-region="task-pipeline"></div>
          <div data-region="task-steps"></div>
          <div class="task-grid">
            <div class="task-main">
              <div class="tabs" data-region="task-tabs"></div>
              <div class="tab-body" data-tab="output">
                <div class="transcript-head" data-region="transcript-head"></div>
                <div class="transcript" id="transcript"></div>
                <div data-region="message-box"></div>
              </div>
              <div class="tab-body" data-tab="activity" data-region="tab-activity"></div>
              <div class="tab-body" data-tab="files" data-region="tab-files"></div>
              <div class="tab-body" data-tab="ticket" data-region="tab-ticket"></div>
            </div>
            <aside class="task-aside" data-region="task-aside"></aside>
          </div>
        </div>`;
      if (!S.overview) await window.CS.loadOverview();
      await this.load(true);
      if (route.focus === 'checkpoint') {
        const cp = $('.checkpoint');
        if (cp) cp.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    leave() {
      T.taskId = '';
    },
    async refresh() {
      await window.CS.loadOverview();
      await this.load(false);
    },
    onConfig() {
      this.refresh();
    },
    onPermission() {
      this.load(false);
    },
    async load(first) {
      let d: TaskScreen;
      try {
        d = await call('task', { taskId: T.taskId });
      } catch (e) {
        if (first) throw e;
        toast(e instanceof Error ? e.message : String(e), 'error');
        return;
      }
      if (S.route.name !== 'task' || S.route.taskId !== d.taskId) return;
      T.d = d;
      const liveKey = d.live && d.live.key;
      const agentSteps = d.steps.filter((s) => s.key);
      let want = T.viewKey;
      if (T.follow && liveKey) want = liveKey;
      if (!want || !agentSteps.some((s) => s.key === want)) want = (agentSteps.find((s) => s.status === 'running') ?? agentSteps[agentSteps.length - 1])?.key ?? null;
      const switched = want !== T.viewKey;
      T.viewKey = want;
      this.render();
      if (switched || first) await this.loadTranscript();
    },
    async loadTranscript() {
      const key = T.viewKey;
      T.liveText = '';
      if (!key) {
        T.items = [];
        $('#transcript')!.innerHTML = emptyTranscript(T.d!);
        return;
      }
      const items = await call('transcript', { taskId: T.taskId, key });
      if (key !== T.viewKey) return;
      T.items = items;
      const el = $('#transcript')!;
      el.innerHTML = items.length ? renderItems(items) : `<div class="t-empty">${icon('clock')}Waiting for the agent's first words…</div>`;
      scrollTranscript(true);
    },
    render() {
      const d = T.d!;
      patch('task-header', headerHtml(d));
      patch('task-alerts', alertsHtml(d));
      patch('task-perms', d.permissions.length ? `<div class="perm-strip">${d.permissions.map(permissionCard).join('')}</div>` : '');
      const cpKey = d.checkpointFull ? `${d.checkpointFull.id}@${d.checkpointFull.at}:${d.status.key}` : null;
      if (cpKey !== T.cpKey) {
        T.cpKey = cpKey;
        T.feedback = '';
        patch('task-checkpoint', d.checkpointFull ? checkpointHtml(d) : '');
      }
      patch('task-result', reportHtml(d));
      if (patch('task-steps', stepsHtml(d))) {
        const strip = $('.steps');
        const focus = strip && (strip.querySelector<HTMLElement>('.st.s-running, .st.s-waiting, .st.s-failed, .st.s-interrupted') || strip.querySelector<HTMLElement>('.st.selected'));
        if (strip && focus) strip.scrollLeft = Math.max(0, focus.offsetLeft - strip.clientWidth / 2 + focus.clientWidth / 2);
      }
      // A re-render would drop the chip being dragged.
      if (!pipeDragging()) patch('task-pipeline', pipelineHtml(d));
      patch('task-tabs', tabsHtml(d));
      for (const el of $$('.tab-body')) el.classList.toggle('active', el.dataset.tab === T.tab);
      patch('transcript-head', transcriptHead(d));
      patch('message-box', messageBox(d));
      if (T.tab === 'activity') patch('tab-activity', activityHtml(d));
      if (T.tab === 'files') patch('tab-files', filesHtml(d));
      if (T.tab === 'ticket') patch('tab-ticket', ticketHtml(d));
      patch('task-aside', asideHtml(d));
    },
    onPush(msg) {
      if (msg.taskId !== T.taskId) return;
      if (msg.type === 'output') {
        if (msg.item.type === 'usage') {
          if (T.d) {
            T.d.liveUsage = { ...msg.item, key: msg.key };
            patch('transcript-head', transcriptHead(T.d));
          }
          return;
        }
        if (msg.key === T.viewKey) appendItem(msg.item);
        else if (T.follow && T.d && (!T.d.live || T.d.live.key !== msg.key)) this.load(false);
      } else if (msg.type === 'live') {
        if (T.d) {
          T.d.live = msg.live;
          patch('transcript-head', transcriptHead(T.d));
          patch('task-header', headerHtml(T.d));
        }
        if (msg.live && msg.live.key && T.follow && msg.live.key !== T.viewKey) this.load(false);
      }
    },
    onSubmit(e) {
      if (!(e.target instanceof HTMLElement)) return;
      if (e.target.id === 'msg-text') {
        sendMessage();
        return;
      }
      if (e.target.id === 'cp-feedback') {
        const primary = $('.checkpoint [data-kind="primary"]');
        if (primary) primary.click();
      }
    },
    actions: {
      'select-step': (el) => {
        const key = el.dataset.key;
        if (!key) return;
        T.viewKey = key;
        T.follow = Boolean(T.d!.live && T.d!.live.key === key);
        T.tab = 'output';
        S.ui.taskTab = 'output';
        persist();
        views.task.render();
        views.task.loadTranscript();
      },
      follow: () => {
        T.follow = true;
        views.task.load(false).then(() => views.task.loadTranscript());
      },
      tab: (el) => {
        T.tab = el.dataset.tab;
        S.ui.taskTab = T.tab;
        persist();
        views.task.render();
      },
      answer: async (el) => {
        const option = el.dataset.option;
        const checkpointId = T.d!.checkpointFull!.id;
        const spec = CP_UI[checkpointId]!.options[option];
        const ta = $<HTMLTextAreaElement>('#cp-feedback');
        const feedback = ta ? ta.value.trim() : '';
        if (spec?.feedback === 'required' && !feedback) {
          ta!.focus();
          shake(ta);
          toast('Write what should change first', 'warn');
          return;
        }
        $$<HTMLButtonElement>('.checkpoint button').forEach((b) => (b.disabled = true));
        el.classList.add('busy');
        const ok = await attempt('answer', { taskId: T.taskId, checkpointId, option, feedback: spec?.feedback ? feedback || undefined : undefined });
        $$<HTMLButtonElement>('.checkpoint button').forEach((b) => (b.disabled = false));
        el.classList.remove('busy');
        if (ok !== undefined) {
          T.follow = true;
          toast(option === 'stop' ? 'Task stopped. The question waits for you when you resume.' : 'Got it, continuing…', 'ok');
          views.task.refresh();
        }
      },
      'send-message': sendMessage,
      'open-artifact': (el) => attempt('openFile', { taskId: T.taskId, file: el.dataset.file, preview: el.dataset.preview === '1' }),
      'open-path': (el) => attempt('openFile', { file: el.dataset.path }),
      'open-diff': () => attempt('openDiff', { taskId: T.taskId }),
      'open-repo': (el) => attempt('openRepo', { taskId: T.taskId, repo: el.dataset.repo }),
      reveal: () => attempt('revealTask', { taskId: T.taskId }),
      'delete-task': async () => {
        const r = await attempt('deleteTask', { taskId: T.taskId });
        if (r && r.deleted) {
          toast(`Deleted ${T.taskId}`, 'ok');
          go({ name: 'home' });
        }
      },
      cleanup: async () => {
        const r = await attempt('cleanup', { taskId: T.taskId });
        if (r) toast(r.map((x) => `${x.repo}: ${x.status}`).join(', ') || 'No worktrees', 'ok');
      },
      'resume-terminal': (el) => attempt('resumeTerminal', { taskId: T.taskId, key: el.dataset.key }),
      'copy-id': () => call('copy', { text: T.taskId }).then(() => toast('Task id copied', 'ok')),
      'toggle-tool': (el) => el.closest('.tool')?.classList.toggle('open'),
      'task-menu': (el) => el.closest('.menu-wrap')?.classList.toggle('open'),
      'settings-atlassian': () => go({ name: 'settings', section: 'atlassian' }),
      'post-report': async (el) => {
        el.disabled = true;
        el.classList.add('busy');
        const r = await attempt('postReport', { taskId: T.taskId });
        el.disabled = false;
        el.classList.remove('busy');
        if (r) toast(r.ok ? `Posted on ${T.d!.source!.label}` : `Not posted: ${r.error}`, r.ok ? 'ok' : 'error');
        views.task.load(false);
      },
      'retry-comment': async (el) => {
        el.disabled = true;
        el.classList.add('busy');
        const r = await attempt('retryComment', { taskId: T.taskId, seq: Number(el.dataset.seq) });
        if (r) toast(r.ok ? `Commented on ${T.d!.source!.label}` : `Still not posted: ${r.error}`, r.ok ? 'ok' : 'error');
        views.task.load(false);
      },
      'sev-filter': (el) => {
        T.sev = el.dataset.sev;
        patch('task-result', reportHtml(T.d!));
      },
      'pipe-toggle': () => {
        S.ui.pipeEdit = !S.ui.pipeEdit;
        persist();
        views.task.render();
      },
      'fix-gaps': () => {
        const r = T.d!.result;
        if (r && r.kind === 'readiness') go({ name: 'home', scenario: 'deliver', compose: fixGapsText(T.d!, r) });
      },
      'fix-finding': (el) => {
        const r = T.d!.result;
        const f = r && r.kind === 'audit' ? r.findings[Number(el.dataset.i)] : undefined;
        if (f) go({ name: 'home', scenario: 'deliver', compose: fixFindingText(f) });
      },
    },
    inputs: {
      'cp-feedback': (el) => {
        T.feedback = el.value;
      },
    },
  };

  // ---------- header, alerts, aside ----------

  function headerHtml(d: TaskScreen) {
    const k = d.status.key;
    const canResume = ['stopped', 'failed', 'interrupted', 'ready'].includes(k);
    const live = k === 'running' ? d.live : null;
    const since = live ? (live.since ?? Date.now()) : 0;
    return `<header class="task-header">
      <div class="th-main">
        <h1 class="th-title">${esc(d.title)}</h1>
        <div class="th-meta">
          <button class="chip mono" data-action="copy-id" title="Copy task id">${esc(d.taskId)}</button>
          ${sourceChip(d.source)}
          ${scenarioChip(d.scenario, d.scenarioLabel)}
          ${groupChip(d.group)}
          ${statusBadge(d.status, d.live)}
          ${live ? `<span class="muted small">${icon('clock')}<span data-since="${since}">${dur(Date.now() - since)}</span></span>` : ''}
          ${d.round > 1 ? `<span class="chip">${icon('refresh')}round ${d.round}/${d.maxRounds}</span>` : ''}
          ${d.cost ? `<span class="chip" title="Spent by this task's agents so far">${icon('dollar')}${money(d.cost).slice(1)}</span>` : ''}
        </div>
      </div>
      <div class="th-actions">
        ${canResume ? `<button class="btn primary" data-action="run">${icon('play')}${k === 'failed' ? 'Retry' : 'Resume'}</button>` : ''}
        ${k === 'running' ? `<button class="btn" data-action="stop">${icon('stop')}Stop</button>` : ''}
        ${Object.keys(d.prs || {}).length ? Object.entries(d.prs).map(([r, u]) => `<button class="btn" data-action="open-url" data-url="${esc(u)}">${icon('pr')}${esc(r)} PR</button>`).join('') : ''}
        <div class="menu-wrap">
          <button class="icon-btn" data-action="task-menu" title="More">${icon('dots')}</button>
          <div class="menu">
            ${d.repos.length ? `<button data-action="open-diff">${icon('file')}Open combined diff</button>` : ''}
            ${d.files.some((f) => f.path === 'report.md') ? `<button data-action="open-artifact" data-file="report.md" data-preview="1">${icon('doc')}Open report</button>` : ''}
            <button data-action="open-artifact" data-file="ticket.md" data-preview="1">${icon('doc')}Open ticket</button>
            <button data-action="reveal">${icon('folder')}Reveal task folder</button>
            ${d.gitMode === 'worktree' && d.repos.length && k !== 'running' ? `<button data-action="cleanup">${icon('trash')}Remove worktrees</button>` : ''}
            ${k !== 'running' ? `<button class="danger" data-action="delete-task">${icon('trash')}Delete task…</button>` : ''}
          </div>
        </div>
      </div>
    </header>`;
  }

  function alertsHtml(d: TaskScreen) {
    const parts: string[] = [];
    if (d.error && d.status.key === 'failed') {
      const e = d.error;
      const message = e.message ?? '';
      let body = `<b>${esc(message.split('\n')[0])}</b>`;
      let action = `<button class="btn sm" data-action="run">${icon('refresh')}Retry</button>`;
      if (e.code === 'repos_not_ready' && e.blocked) {
        body = `<b>Some repos are not ready, so nothing was changed.</b><ul>${e.blocked.map((b) => `<li><code>${esc(b.repo)}</code>: ${esc(b.problem)}${b.files ? `<div class="mono small muted">${b.files.map((f) => esc(f)).join('<br>')}</div>` : ''}</li>`).join('')}</ul><div class="muted small">Commit or stash that work (branch mode switches your checkout), then retry. New tasks can use worktrees instead (Settings → Git).</div>`;
      } else if (e.code === 'claude_login') {
        action = `<button class="btn sm primary" data-action="claude-login">${icon('user')}Sign in to Claude</button><button class="btn sm" data-action="open-account-menu">Switch account</button>${action}`;
      } else if (e.code === 'atlassian_not_configured') {
        action = `<button class="btn sm primary" data-action="nav" data-name="mcp">${icon('plug')}Sign in to Atlassian MCP</button><button class="btn sm" data-action="settings-atlassian">Use an API token</button>${action}`;
      } else if (e.code === 'config_invalid') {
        action = `<button class="btn sm" data-action="open-config">Open config.yaml</button>${action}`;
      } else if (e.code === 'busy') {
        action = '';
      } else if (message.includes('\n')) body += `<pre class="log small">${esc(message.split('\n').slice(1).join('\n'))}</pre>`;
      parts.push(`<div class="banner error">${icon('alert')}<div class="grow">${body}</div><div class="banner-actions">${action}</div></div>`);
    }
    if (d.status.key === 'interrupted') {
      parts.push(`<div class="banner warn">${icon('alert')}<div class="grow"><b>This step was interrupted.</b> VS Code closed while it ran, or it runs in another tool (the claudestrator CLI or plugin). Resume here to start the step again.</div><div class="banner-actions"><button class="btn sm primary" data-action="run">${icon('play')}Resume here</button></div></div>`);
    }
    for (const c of unresolvedComments(d)) {
      parts.push(`<div class="banner warn">${icon('alert')}<div class="grow"><b>The Jira comment with ${esc(COMMENT_WHAT[c.what] || 'the text')} was not posted on ${esc(c.key)}.</b><div class="small">${esc(c.error || '')}</div></div><div class="banner-actions"><button class="btn sm primary" data-action="retry-comment" data-seq="${c.seq}">${icon('refresh')}Post again</button>${/not connected|signed out|auth/i.test(c.error || '') ? `<button class="btn sm" data-action="nav" data-name="mcp">${icon('plug')}MCP</button>` : ''}</div></div>`);
    }
    if (d.status.key === 'stopped' && !d.checkpointFull) {
      parts.push(`<div class="banner muted">${icon('pause')}<div class="grow"><b>Paused${d.stopReason ? `: ${esc(d.stopReason)}` : ''}.</b> Resume to continue from the same step.</div></div>`);
    }
    return parts.join('');
  }

  function asideHtml(d: TaskScreen) {
    const row = (label: string, value: string) => (value ? `<div class="kv"><span>${label}</span><div>${value}</div></div>` : '');
    const answers = d.answers.slice(-6).reverse();
    const deliver = !d.scenario || d.scenario === 'deliver';
    return `<div class="card aside-card">
      <h4>Details</h4>
      ${row('Status', statusBadge(d.status, null))}
      ${deliver ? `${row('Branch', d.branch ? `<code>${esc(d.branch)}</code>` : '<span class="muted">after the plan</span>')}
      ${row('Repos', d.repos.length ? d.repos.map((r) => `<button class="chip" data-action="open-repo" data-repo="${esc(r)}" title="Reveal in Explorer">${icon('repo')}${esc(r)}</button>`).join(' ') : '<span class="muted">from the plan</span>')}
      ${row('Git', d.gitMode === 'worktree' ? 'separate worktrees' : 'branch in your checkout')}
      ${row('Plan approval', d.auto ? 'skipped (auto)' : 'by you')}
      ${d.scenarioLabel ? row('Scenario', esc(d.scenarioLabel)) : ''}` : `${row('Scenario', `${esc(d.scenarioLabel || SCENARIO_INFO[d.scenario]!.label)}<div class="muted small">read-only: nothing in your repos changes</div>`)}`}
      ${Object.keys(d.model || {}).length ? row('Model', `${Object.entries(d.model).map(([a, m]) => `<span class="eff-pair">${esc(a)} <code>${esc(m)}</code></span>`).join(' ')}<div class="muted small">from the scenario, over the agents' settings</div>`) : ''}
      ${Object.keys(d.effort || {}).length ? row('Effort', `${Object.entries(d.effort).map(([a, l]) => `<span class="eff-pair">${esc(a)} ${effortTag(l)}</span>`).join(' ')}<div class="muted small">for this task, over the agents' settings</div>`) : ''}
      ${d.group ? row('Group', `${esc(d.group.label)}<div class="muted small">${esc(d.group.type)}${d.group.jira ? ` · Jira ${esc(d.group.jira)}` : ''}</div>${d.group.instructions ? `<div class="muted small pre-wrap">${esc(d.group.instructions)}</div>` : ''}`) : ''}
      ${d.instructions.length ? row('Instructions', `${d.instructions.map((x) => `<div class="extra-pick"><b>${esc(x.label)}</b><div class="muted small pre-wrap">${esc(x.text)}</div></div>`).join('')}`) : ''}
      ${deliver ? row('Review', `round ${d.round} of ${d.maxRounds}`) : ''}
      ${row('Cost', money(d.cost))}
      ${row('Started', `<span title="${esc(d.createdAt)}">${ago(d.createdAt)}</span>`)}
      ${row('Updated', `<span title="${esc(d.updatedAt)}">${ago(d.updatedAt)}</span>`)}
    </div>
    ${d.openFindings.length ? `<div class="card aside-card"><h4>Open findings <span class="muted">(go into the PR)</span></h4>${d.openFindings.map((f) => `<div class="finding sev-${f.severity}"><span class="sev">${f.severity}</span>${f.file ? `<code>${esc(f.file)}${f.line ? `:${f.line}` : ''}</code> ` : ''}${esc(f.problem)}</div>`).join('')}</div>` : ''}
    ${d.comments.length ? `<div class="card aside-card"><h4>Jira comments</h4>${d.comments.slice(-6).reverse().map((c) => `<div class="answer">${c.ok ? icon('check') : icon('x')}<b>${esc(COMMENT_WHAT[c.what] || 'comment')}</b> <span class="muted small">${esc(c.key)} · ${ago(c.at)}${c.via && c.via !== 'api' ? ` · ${esc(c.via.replace(/^mcp:/, 'via '))}` : ''}</span>${c.ok ? '' : `<div class="quote">${esc(c.error || 'failed')}</div>`}</div>`).join('')}</div>` : ''}
    ${answers.length ? `<div class="card aside-card"><h4>Your decisions</h4>${answers.map((a) => `<div class="answer"><b>${esc(CP_UI[a.id]?.options[a.option]?.label ?? a.option)}</b> <span class="muted small">${esc(CP_UI[a.id]?.title || a.id)} · ${ago(a.at)}</span>${a.feedback ? `<div class="quote">${esc(a.feedback)}</div>` : ''}</div>`).join('')}</div>` : ''}`;
  }

  // ---------- checkpoint ----------

  function checkpointHtml(d: TaskScreen) {
    const cp = d.checkpointFull;
    if (!cp) return '';
    const ui = CP_UI[cp.id]!;
    const ctx: Partial<CheckpointContext> = d.checkpointContext ?? {};
    const stopped = d.status.key === 'stopped';
    let body = '';
    if (cp.id === 'approve-plan') {
      const plan = d.plan;
      const questions = plan ? plan.openQuestions : [];
      body = `
        ${plan ? `<div class="plan-meta"><span class="chip">${esc(plan.type)}</span><span class="chip mono">${icon('branch')}${esc(`${plan.type}/${d.source && d.source.kind === 'jira' ? `${d.taskId}-` : ''}${plan.slug}`)}</span>${plan.repos.map((r) => `<span class="chip">${icon('repo')}${esc(r.name)}${r.mode === 'tests_only' ? ' · tests only' : ''}</span>`).join('')}</div>` : ''}
        ${questions.length ? `<div class="questions"><h4>${icon('info')}Open questions <span class="muted">(the planner's default applies unless you say otherwise)</span></h4>${questions.map((q) => `<div class="q"><div>${esc(q.question)}</div><div class="muted small">Default: ${esc(q.default)}</div></div>`).join('')}</div>` : ''}
        <div class="doc-frame"><div class="markdown">${md(stripJsonBlock(ctx.text || ''))}</div></div>
        ${ctx.file ? `<button class="link small" data-action="open-artifact" data-file="${esc(ctx.file)}" data-preview="1">${icon('ext')}Open the plan in an editor</button>` : ''}`;
    } else if (cp.id === 'review-limit') {
      body = `<div class="doc-frame"><div class="markdown">${md(stripJsonBlock(ctx.text || ''))}</div></div>`;
    } else if (cp.id === 'confirm-push') {
      const repos = ctx.repos || [];
      body = `<div class="push-table">${repos
        .map((r) => `<div class="push-row"><b>${icon('repo')}${esc(r.name)}</b><code>${esc(r.branch || '?')}</code><span class="muted">→ ${esc(r.base)}</span><span class="chip">${plural(r.files, 'file')} changed</span></div>`)
        .join('')}</div>
        <div class="row"><button class="btn sm" data-action="open-diff">${icon('file')}Review the combined diff</button></div>
        <details class="log-details"><summary>Commits</summary><pre class="log">${esc(ctx.text || '')}</pre></details>`;
    } else {
      body = ctx.text ? `<pre class="log ${cp.id === 'gate-failure' || cp.id === 'hook-failure' ? 'error' : ''}">${esc(ctx.text)}</pre>` : '';
      // An agent that failed because Claude Code is signed out needs a sign-in, not a retry.
      if (cp.id === 'agent-failure' && /Failed to authenticate|OAuth (session|token) (has )?expired|Invalid API key|Please run \/login|not logged in|authentication_error/i.test(ctx.text || '')) {
        body += `<div class="banner error">${icon('user')}<div class="grow"><b>Claude Code is signed out for this account.</b> Sign in again (or switch the account), then retry the step.</div><div class="banner-actions"><button class="btn sm primary" data-action="claude-login">Sign in to Claude</button><button class="btn sm" data-action="open-account-menu">Switch account</button></div></div>`;
      }
    }
    const needsFeedback = Object.keys(ui.options).some((o) => cp.options.includes(o) && ui.options[o]?.feedback);
    const buttons = cp.options
      .map((o) => {
        const spec: CpOption = ui.options[o] || { label: o, kind: 'secondary', icon: 'chevron' };
        return `<button class="btn ${spec.kind === 'primary' ? 'primary' : spec.kind === 'warn' ? 'warn' : spec.kind === 'ghost' ? 'ghost' : ''}" data-action="answer" data-option="${o}" data-kind="${spec.kind}" title="${esc(spec.hint || '')}">${icon(spec.icon || 'chevron')}${esc(spec.label)}</button>`;
      })
      .join('');
    const primary = cp.options.find((o) => ui.options[o]?.kind === 'primary');
    return `<section class="checkpoint card cp-${cp.id}">
      <div class="cp-head">
        <div class="cp-icon">${icon(cp.id === 'confirm-push' ? 'pr' : cp.id === 'approve-plan' ? 'eye' : 'alert')}</div>
        <div><h2>${esc(ui.title)}</h2><p>${esc(ui.lead)}</p>${stopped ? '<p class="muted small">The task is paused here; answering continues it.</p>' : ''}</div>
      </div>
      ${cp.step ? `<div class="muted small cp-step">At ${esc(stepName(cp.step))}</div>` : ''}
      <div class="cp-body">${body}</div>
      ${needsFeedback ? `<textarea id="cp-feedback" class="input autosize" rows="2" data-input="cp-feedback" placeholder="${esc(ui.placeholder || 'Feedback (optional)')}">${esc(T.feedback)}</textarea>` : ''}
      <div class="cp-actions">${buttons}<span class="muted small kbd-hint"><kbd>⌘↵</kbd> ${esc((primary !== undefined && ui.options[primary]?.label) || '')}</span></div>
    </section>`;
  }

  const stripJsonBlock = (text: string) => text.replace(/\n*```json[^\n]*\n[\s\S]*?\n\s*```\s*$/, '').trim();

  // ---------- steps ----------

  function stepsHtml(d: TaskScreen) {
    const c = colors();
    let round = 1;
    const nodes: string[] = [];
    for (const s of d.steps) {
      if (s.kind === 'agent' && s.round && s.round > round) {
        round = s.round;
        nodes.push(`<span class="round-sep">${icon('refresh')}round ${round} · fixes</span>`);
      }
      const ic = STATUS_ICON[s.status];
      const meta: string[] = [];
      if (s.verdict) meta.push(s.verdict.status === 'approved' ? 'approved' : `${plural(s.verdict.blocking, 'blocker')}`);
      if (s.readiness) meta.push(`${VERDICT_UI[s.readiness.verdict]!.label.toLowerCase()} · ${s.readiness.met}/${s.readiness.total}`);
      if (s.audit) meta.push(`${plural(s.audit.findings, 'finding')}${s.audit.serious ? ` · ${s.audit.serious} serious` : ''}`);
      if (s.gateRuns && s.gateRuns.length) meta.push(`checks ${s.gateRuns[s.gateRuns.length - 1]!.status}${s.gateRuns.length > 1 ? ` ×${s.gateRuns.length}` : ''}`);
      if (s.effort) meta.push(s.effort);
      if (s.costUsd) meta.push(money(s.costUsd));
      const selected = s.key && s.key === T.viewKey;
      const label = s.kind === 'agent' ? esc(s.agent) : esc(s.label);
      const sub = s.repo ? `<span class="st-repo">${esc(s.repo)}</span>` : s.perRepo ? '<span class="st-repo">per repo</span>' : s.allRepos ? `<span class="st-repo">${esc(d.repos.length ? d.repos.join(', ') : 'all repos')}</span>` : '';
      nodes.push(`<button class="st s-${s.status} k-${s.kind} ${s.kind === 'agent' ? agentColor(c[s.agent ?? '']) : ''} ${selected ? 'selected' : ''}" ${s.key ? `data-action="select-step" data-key="${s.key}"` : 'disabled'} title="${esc(`${stepName(s)} · ${s.status}${s.model ? `\n${s.model}${s.effort ? ` · effort ${s.effort}` : ''}` : ''}${s.ctxPct != null ? ` · ctx ${s.ctxPct}%` : ''}${s.tokens ? ` · ${fmtTokens(s.tokens)} tokens` : ''}${s.error ? `\n${s.error}` : ''}`)}">
        <span class="st-ic">${s.status === 'running' ? '<span class="spinner xs"></span>' : ic ? icon(ic) : s.kind === 'human' ? icon('user') : '<span class="st-dot"></span>'}</span>
        <span class="st-text"><span class="st-name">${label}</span>${sub}${meta.length ? `<span class="st-meta">${esc(meta.join(' · '))}</span>` : ''}</span>
      </button>`);
    }
    return `<div class="steps" role="list">${nodes.join('<span class="st-line"></span>')}</div>`;
  }

  // ---------- pipeline editor ----------

  pipeEditors.task = {
    names: () => T.d!.pipelineEdit!.stages.map((st) => st.agent),
    from: () => T.d!.pipelineEdit!.from,
    async save(names) {
      if ((await attempt('editPipeline', { taskId: T.taskId, names })) === undefined) return false;
      views.task.load(false);
    },
    redraw: () => {
      if (T.d && S.route.name === 'task') patch('task-pipeline', pipelineHtml(T.d));
    },
  };

  function pipelineHtml(d: TaskScreen) {
    const pe = d.pipelineEdit;
    if (!pe) return '';
    if (!S.ui.pipeEdit) return `<div class="pipe-bar"><button class="btn ghost sm" data-action="pipe-toggle" title="Add, remove or reorder the agents still to come in this task">${icon('edit')}Edit pipeline</button></div>`;
    return `<section class="card pipe-editor">
      <div class="pipe-head">
        <div><h3>${icon('edit')}Pipeline of this task</h3>
          <p class="muted small">Drag to reorder, ${icon('x')} to remove, <b>Add agent</b> to add. Steps that ran or run now stay in place. This changes this task only; the next steps follow the new order${d.status.key === 'running' ? ' once the running agent finishes' : ''}.</p></div>
        <button class="btn sm" data-action="pipe-toggle">${icon('check')}Done</button>
      </div>
      ${pipeRowHtml('task', { stages: pe.stages, from: pe.from, choices: pe.choices, empty: 'No agents: the task ends after the ticket.' })}
      ${pe.warnings.length ? `<div class="pipe-warn">${pe.warnings.map((w) => `<div>${icon('alert')}${esc(w)}</div>`).join('')}</div>` : ''}
    </section>`;
  }

  function tabsHtml(d: TaskScreen) {
    const tab = (id: string, label: string, ic: string, count?: number) => `<button class="tab ${T.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${icon(ic)}${label}${count ? `<span class="count">${count}</span>` : ''}</button>`;
    return `${tab('output', 'Agent output', 'bot')}${tab('activity', 'Activity', 'activity', d.events.length)}${tab('files', 'Files', 'file', d.files.length)}${tab('ticket', 'Ticket & plan', 'doc')}`;
  }

  // ---------- transcript ----------

  function emptyTranscript(d: TaskScreen) {
    if (d.status.key === 'running') return `<div class="t-empty"><span class="spinner"></span>${esc((d.live && d.live.text) || 'Starting…')}</div>`;
    if (d.phase === 'intake') return `<div class="t-empty">${icon('clock')}The ticket is written first; agent output appears here once the first agent starts.</div>`;
    return `<div class="t-empty">${icon('bot')}No agent has run yet.</div>`;
  }

  function transcriptHead(d: TaskScreen) {
    const step = d.steps.find((s) => s.key && s.key === T.viewKey);
    if (!step) return '';
    const live = d.live && d.live.key === step.key ? d.live : null;
    const actions: string[] = [];
    if (step.artifact) actions.push(`<button class="btn ghost sm" data-action="open-artifact" data-file="${esc(step.artifact)}" data-preview="1">${icon('doc')}Report</button>`);
    if (step.sessionId && !live) actions.push(`<button class="btn ghost sm" data-action="resume-terminal" data-key="${step.key}" title="claude --resume ${esc(step.sessionId)}">${icon('terminal')}Continue in terminal</button>`);
    if (d.live && d.live.key && !live) actions.push(`<button class="btn sm" data-action="follow">${icon('activity')}Follow live</button>`);
    const u = live && d.liveUsage && d.liveUsage.key === step.key ? d.liveUsage : step;
    const cfgAgent = ((S.overview && S.overview.config && S.overview.config.ok && S.overview.config.agents) || []).find((a) => a.name === step.agent);
    const model = u.model || (cfgAgent && cfgAgent.model !== 'inherit' ? cfgAgent.model : '');
    const effort = u.effort || (live ? cfgAgent?.effort : undefined);
    const cost = u.costUsd || step.costUsd;
    const bar = `<div class="statusline">
      ${model ? `<span class="sl-model">${esc(prettyModel(model))}</span>` : ''}${effortTag(effort)}
      ${u.ctxPct != null ? `<span class="sl" title="Context window used">ctx ${meter(u.ctxPct)}<b class="${level(u.ctxPct)}">${u.ctxPct}%</b></span>` : ''}
      ${u.tokens ? `<span class="sl" title="Tokens this session (input, output, cache)">tok <b>${fmtTokens(u.tokens)}</b></span>` : ''}
      ${cost ? `<span class="sl" title="Cost of this step">${money(cost)}</span>` : ''}
      ${step.turns ? `<span class="sl muted">${plural(step.turns, 'turn')}</span>` : ''}
    </div>`;
    return `<div class="th-step ${agentColor(colors()[step.agent ?? ''])}"><span class="adot"></span><b>${esc(stepName(step))}</b>
      <span class="muted small">${step.mode && step.mode !== 'initial' ? `${esc(step.mode)} · ` : ''}round ${step.round || 1}</span>
      ${live ? `<span class="badge tone-accent"><span class="pulse"></span>${esc(live.text)}</span>` : statusBadge({ key: step.status, tone: step.status === 'done' ? 'ok' : step.status === 'failed' ? 'error' : 'muted', label: step.status }, null)}
      <span class="grow"></span>${actions.join('')}${bar}</div>`;
  }

  /** `claude-opus-5-5` → `Opus 5.5`; aliases and display names pass through. */
  function prettyModel(m: string) {
    const models = S.overview && S.overview.defaults && S.overview.defaults.models;
    const hit = models && models.find((x) => x.model === m || x.value === m);
    if (hit) return hit.name;
    const x = String(m).match(/^claude-([a-z]+)-(\d+)-(\d+)/);
    if (x) return `${x[1]![0]!.toUpperCase()}${x[1]!.slice(1)} ${x[2]}.${x[3]}`;
    return /^[a-z]+$/.test(m) ? `${m[0]!.toUpperCase()}${m.slice(1)}` : m;
  }

  function messageBox(d: TaskScreen) {
    const isLive = d.canMessage && d.live && d.live.key === T.viewKey;
    if (!isLive) return '';
    const step = d.steps.find((s) => s.key === T.viewKey);
    return `<div class="msg-box">
      <textarea id="msg-text" class="input autosize" rows="1" placeholder="Message ${esc(step ? stepName(step) : '')} while it works, e.g. “reuse formatDate from utils/date.ts”"></textarea>
      <button class="btn primary" data-action="send-message" title="Send (⌘↵)">${icon('send')}</button>
    </div>`;
  }

  const base = (p: unknown) => String(p || '').split('/').pop();
  const dir = (p: unknown) => String(p || '').split('/').slice(0, -1).join('/');
  const pathLink = (p: unknown) => (p ? `<a class="path" data-action="open-path" data-path="${esc(p)}" title="${esc(p)}">${esc(base(p))}</a><span class="muted path-dir">${esc(dir(p).split('/').slice(-3).join('/'))}</span>` : '');

  function toolSummary(name: string, input: unknown) {
    switch (name) {
      case 'Read':
        return { ic: 'file', title: 'Read', detail: pathLink(field(input, 'file_path')) };
      case 'Edit':
      case 'MultiEdit':
        return { ic: 'edit', title: 'Edit', detail: pathLink(field(input, 'file_path')) };
      case 'Write':
        return { ic: 'edit', title: 'Write', detail: pathLink(field(input, 'file_path')) };
      case 'NotebookEdit':
        return { ic: 'edit', title: 'Edit notebook', detail: pathLink(field(input, 'notebook_path')) };
      case 'Bash':
        return { ic: 'terminal', title: field(input, 'description') ? esc(field(input, 'description')) : 'Run', detail: `<code class="cmd">$ ${esc(String(field(input, 'command') || '').split('\n')[0]!.slice(0, 200))}</code>` };
      case 'Grep':
        return { ic: 'search', title: 'Search', detail: `<code>${esc(field(input, 'pattern') || '')}</code>${field(input, 'path') ? ` <span class="muted">in ${esc(base(field(input, 'path')))}</span>` : ''}` };
      case 'Glob':
        return { ic: 'search', title: 'Find files', detail: `<code>${esc(field(input, 'pattern') || '')}</code>` };
      case 'WebFetch':
        return { ic: 'link', title: 'Fetch', detail: `<span class="muted">${esc(field(input, 'url') || '')}</span>` };
      case 'WebSearch':
        return { ic: 'search', title: 'Web search', detail: esc(field(input, 'query') || '') };
      case 'Task':
      case 'Agent':
        return { ic: 'bot', title: 'Subagent', detail: esc(field(input, 'description') || '') };
      case 'TodoWrite':
        return { ic: 'list', title: 'Updated its to-do list', detail: '' };
      default:
        return { ic: 'zap', title: esc(name), detail: '' };
    }
  }

  function toolBody(name: string, input: unknown) {
    if (name === 'Edit') return diffHtml(field(input, 'old_string'), field(input, 'new_string'));
    if (name === 'MultiEdit') return list(field(input, 'edits')).map((e) => diffHtml(field(e, 'old_string'), field(e, 'new_string'))).join('');
    if (name === 'Write') return `<pre class="code-pre">${esc(String(field(input, 'content') || '').split('\n').slice(0, 60).join('\n'))}${String(field(input, 'content') || '').split('\n').length > 60 ? '\n…' : ''}</pre>`;
    if (name === 'Bash') return `<pre class="code-pre">$ ${esc(field(input, 'command') || '')}</pre>`;
    if (name === 'TodoWrite') return `<ul class="todos">${list(field(input, 'todos')).map((t) => `<li class="todo ${field(t, 'status')}">${field(t, 'status') === 'completed' ? icon('check') : field(t, 'status') === 'in_progress' ? '<span class="spinner xs"></span>' : '<span class="st-dot"></span>'}${esc(field(t, 'content') || field(t, 'activeForm') || '')}</li>`).join('')}</ul>`;
    return `<pre class="code-pre">${esc(JSON.stringify(input, null, 2).slice(0, 3000))}</pre>`;
  }

  function diffHtml(a: unknown, b: unknown) {
    const minus = String(a || '').split('\n').map((l) => `<div class="dl del">- ${esc(l)}</div>`).join('');
    const plus = String(b || '').split('\n').map((l) => `<div class="dl add">+ ${esc(l)}</div>`).join('');
    return `<div class="diff">${minus}${plus}</div>`;
  }

  function toolHtml(item: Extract<TranscriptItem, { type: 'tool_use' }>, result: ToolResult | undefined) {
    const s = toolSummary(item.name, item.input);
    const state = !result ? 'pending' : result.isError ? 'error' : 'ok';
    const open = item.name === 'TodoWrite' ? 'open' : '';
    return `<div class="tool ${open} t-${state}" data-tool="${esc(item.id)}">
      <button class="tool-head" data-action="toggle-tool">
        <span class="tool-ic">${icon(s.ic)}</span><span class="tool-title">${s.title}</span><span class="tool-detail">${s.detail}</span>
        <span class="tool-state">${state === 'pending' ? '<span class="spinner xs"></span>' : state === 'error' ? icon('x') : icon('check')}</span>
      </button>
      <div class="tool-body">${toolBody(item.name, item.input)}<div class="tool-result">${result ? resultHtml(result) : ''}</div></div>
    </div>`;
  }

  const resultHtml = (r: ToolResult) => `<pre class="code-pre ${r.isError ? 'error' : 'muted'}">${esc(r.text.slice(0, 4000))}</pre>`;

  /** The tool results of a transcript, to show each under its call, and the calls that have one. */
  interface ItemContext {
    results: Map<string, ToolResult>;
    called: Set<string>;
  }

  function itemHtml(item: TranscriptItem, ctx: ItemContext | null) {
    switch (item.type) {
      case 'prompt':
        return `<details class="t-prompt"><summary>${icon('send')}Instructions Claudestrator sent to the agent</summary><pre class="code-pre">${esc(item.text)}</pre></details>`;
      case 'text':
        return `<div class="bubble agent"><div class="markdown">${md(item.text)}</div></div>`;
      case 'tool_use':
        return toolHtml(item, ctx?.results.get(item.id));
      case 'tool_result':
        return ctx && ctx.called.has(item.id) ? '' : `<div class="tool t-${item.isError ? 'error' : 'ok'} open"><div class="tool-body">${resultHtml(item)}</div></div>`;
      case 'blocked': {
        const command = field(item.input, 'command');
        return `<div class="t-blocked">${icon('shield')}<div><b>Claudestrator blocked ${esc(item.tool)}</b><div>${esc(item.reason)}</div>${command ? `<code class="cmd">$ ${esc(command)}</code>` : ''}</div></div>`;
      }
      case 'user':
        return item.from === 'orchestrator'
          ? `<div class="bubble orchestrator"><div class="b-who">${icon('sparkles')}Claudestrator</div><pre class="code-pre">${esc(item.text)}</pre></div>`
          : `<div class="bubble you"><div class="b-who">${icon('user')}You</div><div class="markdown">${md(item.text)}</div></div>`;
      case 'gates':
        return `<div class="t-gates g-${item.status}"><div class="g-head">${icon('beaker')}<b>Checks ${item.status === 'pass' ? 'passed' : item.status === 'fail' ? 'failed' : 'skipped'}</b><span class="muted small">attempt ${item.attempt}</span>${(item.results || []).map((r) => `<span class="gate-chip ${r.status === 'pass' ? 'on' : r.status === 'fail' ? 'bad' : ''}">${icon(r.status === 'pass' ? 'check' : r.status === 'fail' ? 'x' : 'chevron')}${esc(r.gate)}${r.ms !== undefined && r.ms >= 1000 ? `<span class="muted">${dur(r.ms)}</span>` : ''}</span>`).join('')}</div>${item.status === 'fail' ? `<pre class="log error small">${esc(item.summary)}</pre>` : ''}</div>`;
      case 'turn_end':
        return `<div class="t-turn"><span>${item.ok ? 'turn finished' : 'turn failed'} · ${money(item.costUsd || 0)} so far</span></div>`;
      default:
        return '';
    }
  }

  function renderItems(items: TranscriptItem[]) {
    const results = new Map<string, ToolResult>();
    const called = new Set<string>();
    for (const i of items) {
      if (i.type === 'tool_result') results.set(i.id, i);
      else if (i.type === 'tool_use') called.add(i.id);
    }
    const ctx: ItemContext = { results, called };
    return items.map((i) => itemHtml(i, ctx)).join('');
  }

  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  function appendItem(item: TranscriptItem) {
    const el = $('#transcript');
    if (!el) return;
    const empty = $('.t-empty', el);
    if (empty) empty.remove();
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120 || isPageBottom();
    if (item.type === 'text_delta' || item.type === 'thinking') {
      if (item.type === 'text_delta') T.liveText += item.text;
      let live = $('.bubble.live', el);
      if (!live) {
        el.insertAdjacentHTML('beforeend', `<div class="bubble agent live"><div class="markdown"></div><span class="caret"></span></div>`);
        live = $('.bubble.live', el);
      }
      if (!liveTimer) {
        liveTimer = setTimeout(() => {
          liveTimer = null;
          const l = $('.bubble.live .markdown', el);
          if (l) l.innerHTML = T.liveText ? md(T.liveText) : '<span class="muted">thinking…</span>';
          if (near) scrollTranscript();
        }, 80);
      }
      return;
    }
    if (item.type === 'text' || item.type === 'turn_end') {
      const live = $('.bubble.live', el);
      if (live) live.remove();
      T.liveText = '';
    }
    T.items.push(item);
    if (item.type === 'tool_result') {
      const row = el.querySelector(`[data-tool="${CSS.escape(item.id)}"]`);
      if (row) {
        row.classList.remove('t-pending');
        row.classList.add(item.isError ? 't-error' : 't-ok');
        $('.tool-state', row)!.innerHTML = item.isError ? icon('x') : icon('check');
        $('.tool-result', row)!.innerHTML = resultHtml(item);
        return;
      }
    }
    el.insertAdjacentHTML('beforeend', itemHtml(item, null));
    if (near) scrollTranscript();
  }

  const isPageBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  function scrollTranscript(force?: boolean) {
    const el = $('#transcript');
    if (!el) return;
    if (force || el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
  }

  // ---------- activity, files, ticket ----------

  function activityHtml(d: TaskScreen) {
    if (!d.events.length) return '<div class="t-empty">Nothing yet.</div>';
    return `<ol class="activity">${[...d.events]
      .reverse()
      .map((e) => `<li class="ev tone-${e.tone}"><span class="ev-time" title="${esc(e.at)}">${clock(e.at)}</span><span class="ev-dot"></span><span class="ev-text">${esc(e.text)}${e.artifact ? ` <a class="link small" data-action="open-artifact" data-file="${esc(e.artifact)}" data-preview="1">open</a>` : ''}</span></li>`)
      .join('')}</ol>`;
  }

  const FILE_GROUPS: [string, string, (path: string) => boolean][] = [
    ['report', 'Report', (p) => p === 'report.md' || p.startsWith('readiness/') || p.startsWith('audit/')],
    ['ticket', 'Ticket', (p) => p.startsWith('ticket')],
    ['plan', 'Plan', (p) => p.startsWith('plan/')],
    ['reports', 'Reports', (p) => p.startsWith('reports/')],
    ['reviews', 'Reviews', (p) => p.startsWith('reviews/')],
    ['gates', 'Check logs', (p) => p.startsWith('gates/')],
    ['other', 'Other', () => true],
  ];

  function filesHtml(d: TaskScreen) {
    if (!d.files.length) return '<div class="t-empty">No files yet.</div>';
    const used = new Set<string>();
    return FILE_GROUPS.map(([, label, pred]) => {
      const files = d.files.filter((f) => !used.has(f.path) && pred(f.path));
      files.forEach((f) => used.add(f.path));
      if (!files.length) return '';
      return `<div class="file-group"><h4>${label}</h4>${files
        .map((f) => `<button class="file-row" data-action="open-artifact" data-file="${esc(f.path)}" data-preview="${f.path.endsWith('.md') ? '1' : '0'}">${icon(f.path.endsWith('.md') ? 'doc' : 'file')}<span class="mono">${esc(f.path)}</span><span class="muted small">${size(f.size)} · ${ago(new Date(f.mtime).toISOString())}</span></button>`)
        .join('')}</div>`;
    }).join('');
  }

  // ---------- readiness and audit results ----------

  /** Failed comments not followed by a successful one for the same thing. */
  function unresolvedComments(d: TaskScreen) {
    const failed = d.comments.filter((c, i) => !c.ok && !d.comments.slice(i + 1).some((x) => x.what === c.what && x.ok));
    return failed.filter((c, i) => !failed.slice(i + 1).some((x) => x.what === c.what));
  }

  function reportHtml(d: TaskScreen) {
    const r = d.result;
    if (!r) return '';
    const running = d.status.key === 'running';
    const posted = d.comments.some((c) => c.what === 'report' && c.ok);
    const actions = [
      d.files.some((f) => f.path === 'report.md') ? `<button class="btn sm" data-action="open-artifact" data-file="report.md" data-preview="1">${icon('doc')}Open report</button>` : '',
      d.source && d.source.kind === 'jira' && !running ? `<button class="btn sm" data-action="post-report" title="Comment on ${esc(d.source.label)} with this result">${icon('jira')}${posted ? 'Post to Jira again' : 'Post to Jira'}</button>` : '',
    ];
    const summaries = r.summaries.map((x) => `<div class="markdown">${r.summaries.length > 1 ? `<b>${esc(x.agent)}:</b> ` : ''}${md(x.text)}</div>`).join('');
    if (r.kind === 'readiness') {
      const v = VERDICT_UI[r.verdict]!;
      const open = r.gaps.length || r.criteria.some((c) => c.status !== 'met');
      if (open && !running) actions.push(`<button class="btn sm primary" data-action="fix-gaps" title="A delivery task prefilled with what is missing">${icon('play')}Start a task to close the gaps</button>`);
      return `<section class="card result-card r-readiness v-${r.verdict}">
        <div class="rc-head">
          <div class="rc-verdict tone-${v.tone}"><span class="rc-icon">${icon(v.icon)}</span><div><h2>${esc(v.label)}</h2><div class="muted small">${r.met} of ${plural(r.criteria.length, 'criterion', 'criteria')} met · ${esc(v.lead)}</div></div></div>
          <div class="rc-actions">${actions.join('')}</div>
        </div>
        <div class="rc-summary">${summaries}</div>
        ${r.derivedCriteria ? `<div class="muted small rc-note">${icon('info')}The ticket has no acceptance criteria; these were derived from its description.</div>` : ''}
        <div class="criteria">${r.criteria
          .map((c) => `<div class="crit s-${c.status}"><span class="crit-ic">${icon(CRITERION_UI[c.status]!.icon)}</span><div class="crit-body"><div class="crit-text">${esc(c.criterion)}</div>${c.evidence ? `<div class="muted small">${esc(c.evidence)}</div>` : ''}${c.files.length ? `<div class="crit-files">${c.files.map((f) => `<code>${esc(f)}</code>`).join('')}</div>` : ''}</div><span class="crit-status">${esc(CRITERION_UI[c.status]!.label)}</span></div>`)
          .join('')}</div>
        ${r.gaps.length ? `<h4 class="rc-sub">Gaps</h4><div class="gaps">${r.gaps.map((g) => `<div class="finding sev-${g.severity}"><span class="sev">${esc(g.severity)}</span>${esc(g.problem)}${g.fix ? `<div class="muted small">→ ${esc(g.fix)}</div>` : ''}</div>`).join('')}</div>` : ''}
        ${r.work.length ? `<div class="muted small rc-work">${icon('branch')}Checked: ${r.work.map((w) => `<code>${esc([w.repo, w.ref].filter(Boolean).join(': '))}</code>`).join(' ')}</div>` : ''}
      </section>`;
    }
    const total = r.findings.length;
    const indexed = r.findings.map((f, i) => ({ f, i }));
    const shown = T.sev === 'all' ? indexed : indexed.filter(({ f }) => f.severity === T.sev);
    const filter = `<div class="sev-filter"><button class="sev-tab ${T.sev === 'all' ? 'on' : ''}" data-action="sev-filter" data-sev="all">All <b>${total}</b></button>${SEVERITIES.map((sv) => `<button class="sev-tab sev-${sv} ${T.sev === sv ? 'on' : ''}" data-action="sev-filter" data-sev="${sv}" ${r.counts[sv] ? '' : 'disabled'}>${sv} <b>${r.counts[sv]}</b></button>`).join('')}</div>`;
    return `<section class="card result-card r-audit">
      <div class="rc-head">
        <div class="rc-verdict tone-${r.counts.critical ? 'error' : r.counts.high ? 'warn' : 'ok'}"><span class="rc-icon">${icon('search')}</span><div><h2>${total ? plural(total, 'finding') : 'No findings'}</h2><div class="muted small">${sevCounts(r.counts)}${r.scope.length ? ` · ${esc(r.scope.join(', '))}` : ''}</div></div></div>
        <div class="rc-actions">${actions.join('')}</div>
      </div>
      <div class="rc-summary">${summaries}</div>
      ${total ? filter : ''}
      <div class="audit-findings">${shown
          .map(({ f, i }) => `<details class="audit-f sev-${f.severity}" ${f.severity === 'critical' ? 'open' : ''}>
          <summary><span class="sev">${esc(f.severity)}</span><span class="af-title">${esc(f.title)}</span>${f.category ? `<span class="chip small">${esc(f.category)}</span>` : ''}<span class="af-where muted small">${esc([f.repo, f.file && `${f.file}${f.line ? `:${f.line}` : ''}`].filter(Boolean).join(' · '))}</span></summary>
          <div class="af-body">
            <div class="markdown">${md(f.problem)}</div>
            ${f.impact ? `<div class="af-row"><b>Impact</b><div class="markdown">${md(f.impact)}</div></div>` : ''}
            ${f.fix ? `<div class="af-row"><b>Fix</b><div class="markdown">${md(f.fix)}</div></div>` : ''}
            <div class="af-foot">${f.effort ? `<span class="muted small">effort ${esc(f.effort)}</span>` : ''}${r.summaries.length > 1 ? `<span class="muted small">by ${esc(f.agent)}</span>` : ''}<span class="grow"></span><button class="btn ghost sm" data-action="fix-finding" data-i="${i}">${icon('play')}Start a task to fix it</button></div>
          </div>
        </details>`)
        .join('')}</div>
    </section>`;
  }

  /** A delivery task for what a readiness check found missing. */
  function fixGapsText(d: TaskScreen, r: ReadinessResult) {
    const head = d.source && d.source.kind === 'jira' ? d.source.label : d.title;
    const lines = [`${head}`, '', 'Close what the readiness check found:'];
    for (const c of r.criteria.filter((x) => x.status === 'partial' || x.status === 'not_met')) lines.push(`- ${c.criterion} (${CRITERION_UI[c.status]!.label})${c.evidence ? `: ${c.evidence}` : ''}`);
    for (const g of r.gaps) lines.push(`- [${g.severity}] ${g.problem}${g.fix ? ` → ${g.fix}` : ''}`);
    return lines.join('\n');
  }

  function fixFindingText(f: AuditResult['findings'][number]) {
    const where = [f.repo, f.file && `${f.file}${f.line ? `:${f.line}` : ''}`].filter(Boolean).join(' ');
    return [`Fix: ${f.title}`, '', where && `Where: ${where}`, f.problem, f.impact && `Impact: ${f.impact}`, f.fix && `Suggested fix: ${f.fix}`].filter(Boolean).join('\n');
  }

  function ticketHtml(d: TaskScreen) {
    const plan = d.plan;
    const planFile = d.files.filter((f) => f.path.startsWith('plan/')).pop();
    return `<div class="ticket">
      ${plan ? `<div class="card plan-card"><h4>Plan</h4><div class="plan-meta"><span class="chip">${esc(plan.type)}</span>${plan.title ? `<span>${esc(plan.title)}</span>` : ''}${plan.repos.map((r) => `<span class="chip">${icon('repo')}${esc(r.name)}${r.mode === 'tests_only' ? ' · tests only' : ''}</span>`).join('')}</div>
        ${planFile ? `<button class="link small" data-action="open-artifact" data-file="${esc(planFile.path)}" data-preview="1">${icon('ext')}Open the full plan</button>` : ''}</div>` : ''}
      ${d.ticket ? `<div class="doc-frame"><div class="markdown">${md(d.ticket)}</div></div>` : `<div class="t-empty">The ticket is written when the task starts.</div>`}
      <details class="log-details"><summary>What you typed</summary><pre class="code-pre">${esc(d.input)}</pre></details>
    </div>`;
  }
})();
