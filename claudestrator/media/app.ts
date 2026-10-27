// Claudestrator dashboard: core (rpc, state, router, rendering helpers), the shell, home and setup.
// Views live in task.js and config.js and register themselves on window.CS.views.
// Rendering: each view renders named regions; live updates re-render only regions whose HTML changed,
// and keep focus and caret, so typing is never interrupted.
interface CustomDef {
  id: string;
  label: string;
  description: string | undefined;
  agents: ScenarioStep[];
}

interface HomeView extends View {
  /** The scenario the last preview detected in the words, or null. */
  detected: string | null;
  render(): void;
  tasksHtml(tasks: Card[]): string;
  renderComposer(): void;
  scenario(): string;
  scenarioIds(): string[];
  scenarioAgents(sc: string): AgentSummary[];
  renderScenario(): void;
  renderScenarioEditor(): void;
  customDef(id: string, change?: Partial<CustomDef>): CustomDef;
  saveCustom(def: CustomDef, done?: string): Promise<false | undefined>;
  renderAgentsChips(): void;
  preview(): void;
  start(): Promise<void>;
}

/** A repo of the setup wizard: what was found, plus whether it is ticked and which of its checks are. */
interface SetupRepo extends Omit<FoundRepo, 'gates'> {
  on: boolean;
  outside?: boolean;
  gates: (SuggestedGate & { on: boolean })[];
}

interface SetupView extends View {
  repos: SetupRepo[];
  prefs: { language: string; gitMode: GitMode; map: boolean };
  render(): void;
  create(): Promise<void>;
}

interface Views {
  home: HomeView;
  setup: SetupView;
}

(function () {
  const vscode = acquireVsCodeApi();
  const esc = window.escapeHtml;
  const md = window.renderMarkdown;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);
  const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] => Array.from(root.querySelectorAll<T>(sel));
  /** A field of untyped JSON, such as the input of a tool call. */
  const field = (v: unknown, key: string): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined);

  // ---------- rpc ----------

  let reqId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** The one untyped door to the host: what comes back is whatever the request's entry in `Rpc` says. */
  function send(method: string, params: unknown): Promise<unknown> {
    const id = ++reqId;
    vscode.postMessage({ type: 'req', id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  function call<M extends keyof Rpc>(method: M, ...args: RpcArgs<Rpc[M]['params']>): Promise<Rpc[M]['result']> {
    return send(method, (args as unknown[])[0]) as Promise<Rpc[M]['result']>;
  }
  /** Like call(), but shows failures as toasts. Resolves to the result, `true` for requests without one, `undefined` on failure. */
  async function attempt<M extends keyof Rpc>(method: M, params?: Rpc[M]['params'], okText?: string | null): Promise<Attempted<Rpc[M]['result']>> {
    try {
      const r = await send(method, params);
      if (okText) toast(okText, 'ok');
      return (r === undefined ? true : r) as Attempted<Rpc[M]['result']>;
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code !== 'cancelled') toast(err.message, 'error');
      return undefined;
    }
  }

  // ---------- icons (lucide-style strokes) ----------

  const ICONS: Record<string, string> = {
    home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
    plus: 'M12 5v14M5 12h14',
    play: 'M7 4.5v15l12-7.5z',
    stop: 'M6 6h12v12H6z',
    pause: 'M7 5h3v14H7zM14 5h3v14h-3z',
    check: 'M20 6 9 17l-5-5',
    x: 'M18 6 6 18M6 6l12 12',
    bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
    alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 16v-4M12 8h.01',
    branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a9 9 0 0 1-9 9',
    pr: 'M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 9v12M13 6h3a2 2 0 0 1 2 2v7',
    commit: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M3 12h6M15 12h6',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    bot: 'M12 8V4H8M4 12a8 8 0 0 1 8-4h0a8 8 0 0 1 8 4v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM9 13v2M15 13v2',
    repo: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM8 7h8',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1',
    wand: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M15 9h0M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5',
    refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
    terminal: 'M4 17l6-6-6-6M12 19h8',
    ext: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
    edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    beaker: 'M9 3h6M10 3v6L4.5 19A2 2 0 0 0 6.3 22h11.4a2 2 0 0 0 1.8-3L14 9V3',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.35-4.35',
    checklist: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
    copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',
    up: 'M12 19V5M5 12l7-7 7 7',
    down: 'M12 5v14M19 12l-7 7-7-7',
    chevron: 'M9 18l6-6-6-6',
    back: 'M19 12H5M12 19l-7-7 7-7',
    sparkles: 'M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.5l-1.9-5.9L4 10.7l6.1-1.9zM19 3v4M21 5h-4',
    message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2',
    dollar: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    jira: 'M11.5 2 4 9.5l3.5 3.5L15 5.5zM12.5 22l7.5-7.5-3.5-3.5L9 18.5z',
    doc: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
    text: 'M17 6H3M21 12H3M15 18H3',
    dots: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2',
    link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
    zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    gauge: 'M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0',
    plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
    key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zM15.5 7.5l3 3L22 7l-3-3',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  };
  // The extension's mark (media/icon.svg): a burst over three branches, filled rather than stroked.
  const LOGO = `<svg class="ic logo-mark" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" aria-hidden="true"><path stroke="none" d="M12.83 7.60 L12.45 1.65 A0.45 0.45 0 0 0 11.55 1.65 L11.17 7.60Z M12.72 8.02 L14.72 3.78 A0.45 0.45 0 0 0 13.95 3.33 L11.28 7.18Z M12.42 8.32 L17.05 5.20 A0.45 0.45 0 0 0 16.60 4.43 L11.58 6.88Z M12.00 8.43 L16.54 8.05 A0.45 0.45 0 0 0 16.54 7.15 L12.00 6.77Z M11.58 8.32 L16.82 10.90 A0.45 0.45 0 0 0 17.27 10.12 L12.42 6.88Z M11.28 8.02 L14.01 11.98 A0.45 0.45 0 0 0 14.79 11.53 L12.72 7.18Z M11.17 7.60 L11.55 13.04 A0.45 0.45 0 0 0 12.45 13.04 L12.83 7.60Z M11.28 7.18 L9.28 11.42 A0.45 0.45 0 0 0 10.05 11.87 L12.72 8.02Z M11.58 6.88 L6.62 10.19 A0.45 0.45 0 0 0 7.07 10.96 L12.42 8.32Z M12.00 6.77 L7.39 7.15 A0.45 0.45 0 0 0 7.39 8.05 L12.00 8.43Z M12.42 6.88 L7.35 4.40 A0.45 0.45 0 0 0 6.90 5.17 L11.58 8.32Z M12.72 7.18 L10.02 3.27 A0.45 0.45 0 0 0 9.24 3.72 L11.28 8.02Z"/><circle stroke="none" cx="12" cy="7.6" r="1.92"/><path fill="none" stroke-width="1.5" stroke-linecap="round" d="M12 14.6 L5.6 19.1 M12 14.6 L12 19.6 M12 14.6 L18.4 19.1"/><circle stroke="none" cx="4.6" cy="19.9" r="1.6"/><circle stroke="none" cx="12" cy="20.9" r="1.6"/><circle stroke="none" cx="19.4" cy="19.9" r="1.6"/></svg>`;
  const icon = (name: string, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ICONS.info}"/></svg>`;

  // ---------- formatting ----------

  function ago(iso: string | undefined | null) {
    if (!iso) return '';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  const clock = (t: string | number | Date) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  function dur(ms: number) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const fmtTokens = (n: number | undefined | null) => (!n ? '0' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  function resetIn(unix: number | undefined | null) {
    if (!unix) return '';
    const s = Math.max(0, Math.round(unix - Date.now() / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  const level = (pct: number | undefined | null) => (pct == null ? '' : pct < 60 ? 'ok' : pct < 85 ? 'warn' : 'err');
  /** ▰▰▱ meter, coloured by how full it is. */
  const meter = (pct: number | undefined | null) => `<span class="meter ${level(pct)}"><i style="width:${Math.min(100, Math.max(pct || 0, pct ? 3 : 0))}%"></i></span>`;
  const EFFORT_LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  const asEffort = (v: string): Effort | undefined => EFFORT_LEVELS.find((l) => l === v);
  const EFFORT_HINTS: Record<string, string> = { low: 'fastest, cheapest', medium: 'balanced', high: 'thorough', xhigh: 'very thorough', max: 'deepest, slowest' };
  const EFFORT_LABEL: Record<string, string> = { '': 'Default effort', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const effortTag = (e: string | undefined | null) => (e ? `<span class="effort eff-${e}" title="Reasoning effort">${esc(e)}</span>` : '');
  const money = (n: number) => (n >= 10 ? `$${n.toFixed(1)}` : `$${(n || 0).toFixed(2)}`);
  const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const stepName = (s: { agent?: string | undefined; label?: string | undefined; repo?: string | undefined; perRepo?: boolean | undefined }) => `${s.agent || s.label}${s.repo ? ` @ ${s.repo}` : s.perRepo ? ' · per repo' : ''}`;

  const OUTPUT_INFO: Record<string, { label: string; hint: string }> = {
    plan: { label: 'plan', hint: 'Writes the plan. You approve it before anything changes.' },
    code: { label: 'code', hint: 'Changes code, once per repo of the plan. Gates run after it.' },
    tests: { label: 'tests', hint: 'Writes tests, once per repo of the plan. Gates run after it.' },
    verdict: { label: 'review', hint: 'Reviews the diff. Blocking findings send the work back for a fix round.' },
    readiness: { label: 'readiness', hint: 'Checks a ticket\'s work against its acceptance criteria. Read-only; ends with a report.' },
    audit: { label: 'audit', hint: 'Audits the repos for bugs, bottlenecks, reliability and security issues, rated critical to low. Read-only.' },
  };

  /** What a task is for. The composer picks one from your words unless you choose. */
  const SCENARIO_INFO: Record<string, ScenarioInfo> = {
    deliver: { label: 'Deliver', icon: 'pr', hint: 'Plan → your approval → code and tests per repo → review → draft PRs', placeholder: 'Describe a task in plain words, or paste a Jira key (PROJ-123), a Jira link or a Confluence page link…' },
    readiness: { label: 'Check readiness', icon: 'checklist', hint: 'Finds the work for a ticket and checks every acceptance criterion. Changes nothing.', placeholder: 'Paste a Jira key or link, e.g. “PROJ-123 check it is ready and every acceptance criterion is met”, or describe what should be done…' },
    audit: { label: 'Audit', icon: 'search', hint: 'Looks for bugs, bottlenecks, performance and security issues; a report rated critical / high / medium / low. Changes nothing.', placeholder: 'What to audit, e.g. “Audit the api repo: bottlenecks, performance, bugs” — or leave it general…' },
  };
  /**
   * A scenario's label, icon, hint and placeholder, built-in or your own. `kind` is what it runs as: a custom scenario
   * delivers when its agents change code and makes a report when they write one.
   */
  function scInfo(id: string): ScenarioInfo & { kind: string; custom?: true } {
    const builtin = SCENARIO_INFO[id];
    if (builtin) return { ...builtin, kind: id };
    const c = (okConfig()?.custom ?? []).find((x) => x.id === id);
    const kind = (c && c.kind) || 'deliver';
    const what = ({ deliver: 'ends with draft PRs', readiness: 'read-only, ends with a readiness report', audit: 'read-only, ends with an audit report' } as Record<string, string>)[kind];
    return { label: c ? c.label : id, icon: 'wand', hint: c && c.description ? `${c.description} (${what})` : `Your scenario: ${what}`, placeholder: SCENARIO_INFO[kind]!.placeholder, kind, custom: true };
  }
  /** A task's scenario as a chip; a delivery from the Deliver scenario needs none. */
  const scenarioChip = (sc: string | undefined, label: string | undefined) => {
    if (label) return `<span class="chip sc-chip sc-custom" title="Your scenario">${icon('wand')}${esc(label)}</span>`;
    return sc && sc !== 'deliver' ? `<span class="chip sc-chip sc-${sc}" title="${esc(SCENARIO_INFO[sc]!.hint)}">${icon(SCENARIO_INFO[sc]!.icon)}${esc(SCENARIO_INFO[sc]!.label)}</span>` : '';
  };
  const FALLBACK_MODELS: [string, string][] = [
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['haiku', 'Haiku'],
  ];
  /** Model choices from the CLI's own list, with the real default named: `[value, label]`. */
  function modelChoices(defaults: DefaultsView | null | undefined): [string, string][] {
    const def = defaults && defaults.byModel.inherit;
    const name = (id: string | undefined) => (defaults && defaults.models.find((m) => m.model === id)?.name) || id;
    const pair = (m: { value: string; name: string }): [string, string] => [m.value, m.name];
    const aliases = defaults ? defaults.models.filter((m) => !/^claude-/.test(m.value)).map(pair) : FALLBACK_MODELS;
    const pinned = defaults ? defaults.models.filter((m) => /^claude-/.test(m.value)).map(pair) : [];
    return [['inherit', def ? `Default — ${name(def.model)}` : 'Default (checking…)'], ...aliases, ...pinned];
  }
  const agentColor = (c: string | undefined | null) => `c-${c || 'gray'}`;

  // ---------- toasts & modals ----------

  function toast(text: string, kind = 'info', action?: ToastAction) {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.innerHTML = `${icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'info')}<span>${esc(text)}</span>${action ? `<button class="link">${esc(action.label)}</button>` : ''}<button class="toast-x" aria-label="Dismiss">${icon('x')}</button>`;
    $('#toasts')!.appendChild(el);
    const close = () => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 250);
    };
    el.querySelector<HTMLElement>('.toast-x')!.onclick = close;
    if (action) {
      el.querySelector<HTMLElement>('.link')!.onclick = () => {
        action.run();
        close();
      };
    }
    setTimeout(close, kind === 'error' ? 9000 : 4000);
  }

  // ---------- state & routing ----------

  const saved: PersistedState = vscode.getState() || {};
  const S: AppState = {
    route: saved.route || { name: 'home' },
    overview: null,
    draft: { text: '', no: [], auto: false, key: '', effort: {}, scenario: 'auto', ...(saved.draft || {}) },
    ui: saved.ui || {},
  };
  /** The config when it is valid; the dashboard offers nothing to change in a broken one. */
  const okConfig = () => {
    const c = S.overview && S.overview.config;
    return c && c.ok ? c : null;
  };
  const persist = () => vscode.setState({ route: S.route, draft: S.draft, ui: S.ui });

  // Each script registers its screens here (config.ts and task.ts add theirs before the page boots).
  const views = {} as Views;
  let current: View | null = null;

  async function go(route: Route) {
    if (current && current.leave) current.leave();
    S.route = route;
    persist();
    const v = views[route.name] || views.home;
    current = v;
    renderShell();
    $('#view')!.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    window.scrollTo(0, 0);
    try {
      await v.enter(route);
    } catch (e) {
      $('#view')!.innerHTML = `<div class="empty-state">${icon('alert', 'big')}<h2>Something went wrong</h2><p>${esc(e instanceof Error ? e.message : String(e))}</p><button class="btn" data-action="go-home">Back to tasks</button></div>`;
    }
  }

  /** The HTML each region was last given, to skip a patch that would change nothing. */
  const rendered = new WeakMap<HTMLElement, string>();

  /** Replaces a region's content only when it changed; keeps the focused field and its caret. */
  function patch(name: string | HTMLElement, html: string) {
    const el = typeof name === 'string' ? $(`[data-region="${name}"]`) : name;
    if (!el) return false;
    if (rendered.get(el) === html) return false;
    const active = document.activeElement;
    let key: string | undefined;
    let sel: [number | null, number | null] | null = null;
    if (active instanceof HTMLElement && el.contains(active)) {
      key = active.id || active.dataset.key || active.getAttribute('name') || undefined;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        try {
          sel = [active.selectionStart, active.selectionEnd];
        } catch {
          sel = null;
        }
      }
    }
    el.innerHTML = html;
    rendered.set(el, html);
    if (key) {
      const again = el.querySelector<HTMLElement>(`#${CSS.escape(key)}`) || el.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) || el.querySelector<HTMLElement>(`[name="${CSS.escape(key)}"]`);
      if (again) {
        again.focus();
        if (sel && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement)) {
          try {
            again.setSelectionRange(sel[0], sel[1]);
          } catch {
            // not a text field
          }
        }
      }
    }
    return true;
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  function debounce(key: string, fn: () => unknown, ms = 200) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      fn();
    }, ms));
  }

  // ---------- shell ----------

  const NAV = [
    { name: 'home', label: 'Tasks', icon: 'list' },
    { name: 'agents', label: 'Agents', icon: 'users' },
    { name: 'repos', label: 'Repos & checks', icon: 'repo' },
    { name: 'mcp', label: 'MCP', icon: 'plug' },
    { name: 'settings', label: 'Settings', icon: 'gear' },
  ];

  function renderShell() {
    const app = $('#app')!;
    if (!$('.shell', app)) {
      app.innerHTML = `
        <div class="shell">
          <header class="topbar">
            <button class="brand" data-action="go-home" title="All tasks">
              <span class="logo">${LOGO}</span>
              <span class="brand-text"><span class="brand-name">Claudestrator</span><span class="brand-sub" data-region="workspace"></span></span>
            </button>
            <nav class="nav" data-region="nav"></nav>
            <div class="top-actions" data-region="top-actions"></div>
          </header>
          <div data-region="global-alerts"></div>
          <div data-region="global-permissions"></div>
          <main id="view"></main>
        </div>`;
    }
    renderNav();
  }

  function renderNav() {
    const o = S.overview;
    const attention = o ? o.tasks.filter((t) => t.status.group === 'attention').length : 0;
    const running = o ? o.tasks.filter((t) => t.status.group === 'running').length : 0;
    const active = S.route.name === 'task' ? 'home' : S.route.name;
    patch(
      'nav',
      NAV.map((n) => {
        const mcpBad = o && o.mcp ? o.mcp.problems : 0;
        if (n.name === 'mcp') {
          const dot = !o || !o.mcp || !o.mcp.total ? '' : mcpBad ? `<span class="nb err" title="${plural(mcpBad, 'server')} with a problem">${mcpBad}</span>` : o.mcp.connected === o.mcp.total ? '<span class="mcp-dot s-connected" title="All connected"></span>' : '<span class="mcp-dot s-installed" title="Not checked yet"></span>';
          return `<button class="nav-item ${active === n.name ? 'active' : ''}" data-action="nav" data-name="${n.name}">${icon(n.icon)}<span>${n.label}</span>${dot}</button>`;
        }
        const badge = n.name === 'home' && (attention || running) ? `<span class="nav-badges">${running ? `<span class="nb run" title="${plural(running, 'task')} running"><span class="pulse"></span>${running}</span>` : ''}${attention ? `<span class="nb warn" title="${plural(attention, 'task')} need you">${attention}</span>` : ''}</span>` : '';
        return `<button class="nav-item ${active === n.name ? 'active' : ''}" data-action="nav" data-name="${n.name}">${icon(n.icon)}<span>${n.label}</span>${badge}</button>`;
      }).join('')
    );
    patch('workspace', o && o.rootName ? esc(o.rootName) : '');
    patch('top-actions', `${accountSwitcher(o)}${limitsPill(o && o.limits)}<button class="btn primary sm" data-action="new-task" title="New task (⌘⌥N)">${icon('plus')}<span>New task</span></button>`);
    renderGlobalPermissions();
    const a = o && o.account;
    patch('global-alerts', a && a.loggedIn === false ? `<div class="perm-strip"><div class="banner error">${icon('alert')}<div class="grow"><b>Claude Code is signed out for ${esc(a.email || a.label)}</b> <span class="muted small">(${esc(a.shownDir.replace(/^\/Users\/[^/]+/, '~'))})</span><div class="small">Agents cannot run under this account. Sign in again, or switch to a signed-in account.</div></div><div class="banner-actions"><button class="btn sm primary" data-action="claude-login">${icon('user')}Sign in</button><button class="btn sm" data-action="open-account-menu">Switch account</button></div></div></div>` : '');
  }

  /** Which Claude Code account the agents, MCP and limits use; one click to switch. */
  function accountSwitcher(o: Overview | null) {
    if (!o || !o.account) return '';
    const a = o.account;
    const who = a.email || a.label;
    const rows = (o.accounts || [])
      .map((x) => `<button data-action="set-account" data-dir="${esc(x.dir)}" class="${x.current ? 'current' : ''}">${x.current ? icon('check') : '<span class="ic"></span>'}<span class="acc-row"><b>${esc(x.email || x.label)}${x.loggedIn === false ? ' <span class="badge tone-error">signed out</span>' : ''}</b><span class="muted small">${esc(x.label)} · ${esc(x.dir.replace(/^\/Users\/[^/]+/, '~'))}</span></span></button>`)
      .join('');
    return `<span class="menu-wrap acc-wrap">
      <button class="acc-btn ${a.loggedIn === false ? 'signed-out' : ''}" data-action="eff-menu" title="${a.loggedIn === false ? 'Signed out — ' : ''}"${esc(`Claude account for agents, MCP and limits: ${who} (${a.shownDir}) — ${a.sourceText}`)}">${icon('user')}<span>${esc(who)}</span>▾</button>
      <div class="menu acc-menu">
        <div class="menu-title">Claude account for agents, MCP servers and limits</div>
        ${rows}
        ${a.source === 'setting' ? `<button data-action="set-account" data-dir="">${icon('refresh')}<span class="acc-row"><b>Automatic</b><span class="muted small">follow ctx-man / VS Code, else ~/.claude</span></span></button>` : `<div class="menu-note muted small">${icon('info')}Now: ${esc(a.sourceText)}</div>`}
      </div>
    </span>`;
  }

  /** The account's 5-hour and weekly windows, as the Claude Code status line shows them. */
  function limitsPill(l: StoredLimits | null) {
    if (!l) return '';
    const win = (label: string, w: LimitWindow | undefined) =>
      w ? `<span class="lim" title="${esc(`${label === '5h' ? '5-hour' : 'Weekly'} limit: ${w.pct}% used${w.reset ? ' (window reset)' : w.resetsAt ? `, resets in ${resetIn(w.resetsAt)}` : ''}`)}"><b>${label}</b>${meter(w.pct)}<span class="lim-pct ${level(w.pct)}">${w.pct}%</span>${w.resetsAt ? `<span class="muted">${resetIn(w.resetsAt)}</span>` : ''}</span>` : '';
    const when = l.at ? ago(new Date(l.at).toISOString()) : '';
    return `<span class="limits" title="${esc(`${l.source === 'statusline' ? 'From your Claude Code status line' : 'Reported to the agents'}, ${when}`)}">${win('5h', l.fiveHour)}${win('wk', l.sevenDay)}</span>`;
  }

  /** Permission prompts are urgent wherever you are; the task page shows its own, so skip there. */
  function renderGlobalPermissions() {
    const o = S.overview;
    const list = o ? o.permissions.filter((p) => !(S.route.name === 'task' && S.route.taskId === p.taskId)) : [];
    patch('global-permissions', list.length ? `<div class="perm-strip">${list.map(permissionCard).join('')}</div>` : '');
  }

  function permissionCard(p: PermissionRequest) {
    const what = p.tool === 'Bash' ? `<code class="cmd">$ ${esc(field(p.input, 'command') || '')}</code>${field(p.input, 'description') ? `<div class="muted small">${esc(field(p.input, 'description'))}</div>` : ''}` : field(p.input, 'file_path') ? `<code>${esc(field(p.input, 'file_path'))}</code>` : `<code>${esc(JSON.stringify(p.input || {}).slice(0, 300))}</code>`;
    return `<div class="perm-card">
      <div class="perm-head">${icon('shield')}<strong>${esc(p.agent)}${p.repo ? ` @ ${esc(p.repo)}` : ''}</strong><span class="muted">wants to use <b>${esc(p.tool)}</b> · ${esc(p.taskId)}</span></div>
      <div class="perm-body">${what}</div>
      <div class="perm-actions">
        <button class="btn primary sm" data-action="perm" data-id="${p.requestId}" data-allow="1">${icon('check')}Allow</button>
        <button class="btn sm" data-action="perm" data-id="${p.requestId}" data-allow="0">${icon('x')}Deny</button>
        <button class="btn ghost sm" data-action="perm-why" data-id="${p.requestId}">Deny with a reason…</button>
      </div>
    </div>`;
  }

  async function loadOverview() {
    const o = await call('overview');
    S.overview = o;
    renderNav();
    return o;
  }

  // ---------- shared bits ----------

  // Pipeline editor chips, shared by a task's pipeline and a scenario's agents in the composer. Each editor on
  // screen registers `{ names(), from(), save(names) }` under the id its row carries in `data-pipe`.
  const pipeEditors: Record<string, PipeEditor | undefined> = {};
  let pipeDrag: { id: string; name: string } | null = null;
  const outputLabel = (o: string) => (OUTPUT_INFO[o] || { label: o }).label;
  /** Whether an agent with this output can join a pipeline of this scenario. */
  const fitsScenario = (output: string, sc: string) => (sc === 'deliver' ? output !== 'readiness' && output !== 'audit' : output === sc);

  /** Where a code or tests agent runs: `repo` per repo, `repos` once across all; `runs` overrides the default. */
  const RUNS_SCOPE: Record<string, string> = { 'per-repo': 'repo', 'all-repos': 'repos' };
  const OUTPUT_SCOPE: Record<string, string> = { code: 'repo', tests: 'repos' };
  const scopeOf = (a: { scope?: string | undefined; runs?: string | undefined; output?: string | undefined }) => a.scope || RUNS_SCOPE[a.runs ?? ''] || OUTPUT_SCOPE[a.output ?? ''] || 'task';
  const SCOPE_LABEL: Record<string, string> = { repo: 'per repo', repos: 'all repos' };

  /**
   * `stages`: `[{ agent, output, color, scope?, runs?, enabled? }]`; the ones before `from` ran and stay put.
   * `runsToggle`: code and tests chips get a per repo / all repos switch. `extras(stage)`: more controls in a chip.
   */
  function pipeRowHtml(id: string, { stages, from = 0, choices = [], empty = 'No agents.', runsToggle = false, extras = null }: PipeRowOptions) {
    const chip = (st: PipeStage, i: number) => {
      const locked = i < from;
      const scope = scopeOf(st);
      const where = SCOPE_LABEL[scope];
      const toggle = runsToggle && !locked && where;
      const other = scope === 'repo' ? 'all-repos' : 'per-repo';
      const whereHtml = toggle
        ? `<button class="pipe-runs" data-action="pipe-runs" data-pipe="${id}" data-name="${esc(st.agent)}" data-runs="${other}" title="${esc(scope === 'repo' ? `Runs once per repo of the plan. Click to run ${st.agent} once across all repos` : `Runs once across all repos of the plan. Click to run ${st.agent} once per repo`)}">${esc(where)} ⇄</button>`
        : where ? ` · ${esc(where)}` : '';
      const kind = `${esc(outputLabel(st.output))}${toggle ? '' : whereHtml}${st.enabled === false ? ' · off' : ''}`;
      return `<span class="pipe-chip ${agentColor(st.color)} ${locked ? 'locked' : ''} ${st.enabled === false ? 'off' : ''}" ${locked ? '' : 'draggable="true"'} data-name="${esc(st.agent)}" title="${esc(locked ? `${st.agent} has run or is running, so it stays in place` : `${st.agent}: drag to move it${st.enabled === false ? '\nSwitched off in Agents, so it does not run' : ''}`)}">
        ${locked ? icon('check') : `<span class="pipe-grip">${icon('grip')}</span>`}<span class="adot"></span><span class="pipe-name">${esc(st.agent)}</span><span class="pipe-kind">${kind}</span>${toggle ? whereHtml : ''}${extras && !locked ? extras(st) : ''}
        ${locked ? '' : `<button class="pipe-x" data-action="pipe-remove" data-pipe="${id}" data-name="${esc(st.agent)}" title="Remove ${esc(st.agent)}">${icon('x')}</button>`}
      </span>`;
    };
    const add = choices.length
      ? `<span class="menu-wrap"><button class="pipe-add" data-action="eff-menu" title="Add an agent at the end">${icon('plus')}Add agent</button>
          <div class="menu">${choices.map((a) => `<button data-action="pipe-add" data-pipe="${id}" data-name="${esc(a.name)}" class="${agentColor(a.color)}" title="${esc(a.description || '')}"><span class="adot"></span><b>${esc(a.name)}</b><span class="muted small">${esc(outputLabel(a.output))}${a.enabled === false ? ' · off in Agents' : ''}</span></button>`).join('')}</div></span>`
      : '';
    return `<div class="pipe-row" data-pipe="${id}">${stages.map(chip).join('<span class="pipe-arrow">→</span>')}${stages.length ? '' : `<span class="muted small">${esc(empty)}</span>`}${add}</div>`;
  }

  pipeEditors.composer = {
    names: () => views.home.scenarioAgents(S.ui.scEdit ?? '').map((a) => a.name),
    from: () => 0,
    async save(names) {
      const sc = S.ui.scEdit ?? '';
      if (scInfo(sc).custom) {
        // Each agent keeps its own model and effort in the new order; an added one starts with the agent's settings.
        const def = views.home.customDef(sc);
        const steps = Object.fromEntries(def.agents.map((st) => [st.name, st]));
        return views.home.saveCustom({ ...def, agents: names.map((n) => steps[n] || { name: n }) });
      }
      const ok = sc === 'deliver' ? await attempt('setPipeline', { pipeline: names }) : await attempt('setScenario', { scenario: sc, agents: names });
      if (ok === undefined) return false;
      await loadOverview();
      if (S.route.name === 'home') {
        views.home.renderAgentsChips();
        views.home.preview();
      }
    },
    redraw: () => views.home.renderScenarioEditor(),
    async setRuns(name, runs) {
      const a = okConfig()?.catalog.find((x) => x.name === name);
      // The output's own default is written as no setting at all.
      const value = a && scopeOf({ output: a.output }) === RUNS_SCOPE[runs] ? null : runs;
      if ((await attempt('updateAgent', { name, patch: { runs: value } })) === undefined) return;
      toast(`${name} now runs ${runs === 'per-repo' ? 'once per repo' : 'once across all repos'}`, 'ok');
      await loadOverview();
      if (S.route.name === 'home') views.home.renderAgentsChips();
    },
  };

  async function pipeSave(id: string, names: string[], done: string | null) {
    const ed = pipeEditors[id];
    if (!ed) return;
    if ((await ed.save(names)) !== false && done) toast(done, 'ok');
  }

  // Drag and drop within one row; a chip never lands before one that ran.
  const pipeDropAt = (e: DragEvent) => {
    const chip = e.target instanceof Element ? e.target.closest<HTMLElement>('.pipe-chip') : null;
    const row = chip && chip.closest<HTMLElement>('.pipe-row');
    if (!chip || !row || !pipeDrag || row.dataset.pipe !== pipeDrag.id || chip.dataset.name === pipeDrag.name) return null;
    const r = chip.getBoundingClientRect();
    return { chip, after: chip.classList.contains('locked') || e.clientX > r.left + r.width / 2 };
  };
  const pipeClearDrop = () => $$('.pipe-chip').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
  document.addEventListener('dragstart', (e) => {
    const chip = e.target instanceof Element ? e.target.closest<HTMLElement>('.pipe-chip[draggable="true"]') : null;
    const row = chip && chip.closest<HTMLElement>('.pipe-row');
    if (!chip || !row) return;
    pipeDrag = { id: row.dataset.pipe ?? '', name: chip.dataset.name ?? '' };
    chip.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', pipeDrag.name);
  });
  document.addEventListener('dragend', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.pipe-chip')) return;
    const id = pipeDrag && pipeDrag.id;
    pipeDrag = null;
    $$('.pipe-chip').forEach((c) => c.classList.remove('dragging'));
    pipeClearDrop();
    const ed = id ? pipeEditors[id] : undefined;
    if (ed && ed.redraw) ed.redraw();
  });
  document.addEventListener('dragover', (e) => {
    const at = pipeDropAt(e);
    if (!at) return;
    e.preventDefault();
    pipeClearDrop();
    at.chip.classList.add(at.after ? 'drop-after' : 'drop-before');
  });
  document.addEventListener('drop', (e) => {
    const at = pipeDropAt(e);
    if (!at || !pipeDrag) return;
    e.preventDefault();
    const { id, name } = pipeDrag;
    const ed = pipeEditors[id];
    if (!ed) return;
    const before = ed.names();
    const list = before.filter((n) => n !== name);
    const i = Math.max(list.indexOf(at.chip.dataset.name ?? '') + (at.after ? 1 : 0), ed.from());
    list.splice(i, 0, name);
    pipeDrag = null;
    pipeClearDrop();
    if (list.join() !== before.join()) pipeSave(id, list, null);
  });


  function statusBadge(st: Pick<Status, 'key' | 'tone' | 'label'>, live: Live | null | undefined) {
    const spin = st.key === 'running' ? '<span class="pulse"></span>' : '';
    return `<span class="badge tone-${st.tone}">${spin}${esc(live && live.text && st.key === 'running' ? live.text : st.label)}</span>`;
  }

  function miniSteps(mini: { kind: string; agent: string | undefined; repo: string | undefined; label: string | undefined; status: string }[]) {
    return `<div class="mini">${mini
      .map((m) => `<span class="dot s-${m.status} ${m.kind === 'human' ? 'human' : ''}" title="${esc(`${stepName(m)} · ${m.status}`)}"></span>`)
      .join('')}</div>`;
  }

  function sourceChip(src: TaskSource | null | undefined) {
    if (!src) return '';
    const ic = src.kind === 'jira' ? 'jira' : src.kind === 'confluence' ? 'doc' : 'text';
    if (src.url) return `<a class="chip link-chip" data-action="open-url" data-url="${esc(src.url)}" title="${esc(src.url)}">${icon(ic)}${esc(src.label)}</a>`;
    return `<span class="chip">${icon(ic)}${esc(src.label)}</span>`;
  }

  function outlineHtml(items: Chip[] | null | undefined, colors: Record<string, string | undefined> = {}) {
    if (!items || !items.length) return '<span class="muted">Only the ticket is written: every agent is off.</span>';
    return `<div class="outline">${items
      .map((o) => {
        if (o.kind === 'stage') return `<span class="ol-node ${agentColor(colors[o.agent ?? ''])}"><span class="adot"></span>${esc(o.agent)}${o.allRepos ? '<span class="ol-tag">all repos</span>' : ''}</span>`;
        if (o.kind === 'repo-block') return `<span class="ol-block"><span class="ol-tag">per repo</span>${(o.agents ?? []).map((a) => `<span class="ol-node ${agentColor(colors[a.agent])}"><span class="adot"></span>${esc(a.agent)}</span>`).join('<span class="ol-arrow">→</span>')}</span>`;
        if (o.kind === 'human') return `<span class="ol-human">${icon('user')}${esc(o.text)}</span>`;
        if (o.kind === 'loop-start') return `<span class="ol-loop">${icon('refresh')}${esc(o.text)}</span>`;
        if (o.kind === 'loop-end') return '';
        return `<span class="ol-finish">${esc(o.text)}</span>`;
      })
      .filter(Boolean)
      .join('<span class="ol-arrow">→</span>')}</div>`;
  }

  function mcpHealth() {
    const m = S.overview && S.overview.mcp;
    if (!m || !m.total) return '';
    const cls = m.problems ? 'bad' : m.connected === m.total ? 'ok' : 'warn';
    const text = m.checking && !m.connected && !m.problems ? 'checking…' : m.problems ? `${m.problems} of ${m.total} need attention` : `${m.connected}/${m.total} connected`;
    return `<span class="hi mcp-hi ${cls}" data-action="nav" data-name="mcp" role="button" tabindex="0" title="MCP servers"><span class="mcp-dot s-${m.problems ? 'failed' : m.connected === m.total ? 'connected' : 'installed'}"></span><b>MCP</b><span>${esc(text)}</span></span>`;
  }

  function healthLine(h: HealthSummary | null | undefined) {
    if (!h || h.checking) return `<div class="health">${'<span class="hi"><span class="spinner xs"></span>Checking tools…</span>'}</div>`;
    const item = (ok: boolean | undefined, label: string, text: string | undefined, action?: string) => `<span class="hi ${ok ? 'ok' : 'bad'}" ${action ? `data-action="${action}" role="button" tabindex="0"` : ''} title="${esc(text || '')}">${icon(ok ? 'check' : 'alert')}<b>${label}</b>${text ? `<span>${esc(text)}</span>` : ''}</span>`;
    return `<div class="health">
      ${item(h.claude.ok, 'Claude Code', h.claude.ok ? h.claude.version : h.claude.error, h.claude.ok ? '' : 'nav-settings')}
      ${h.account ? `<span class="hi">${icon('user')}<b>Account</b><span>${esc(h.account.email || h.account.label)}</span></span>` : ''}
      ${item(h.git.ok, 'Git', h.git.version)}
      ${item(h.gh.ok, 'GitHub CLI', h.gh.ok ? h.gh.account || h.gh.version : h.gh.error)}
      ${h.atlassian ? item(true, 'Jira', 'API token') : h.atlassianMcp ? item(true, 'Jira', `via MCP “${h.atlassianMcp}”`) : ''}
      ${mcpHealth()}
      <button class="icon-btn" data-action="recheck" title="Check again">${icon('refresh')}</button>
    </div>`;
  }

  // ---------- home ----------

  const EXAMPLES = [
    'Add input validation to the signup form: email format, password ≥ 12 chars, show errors inline',
    'Fix: the orders list shows times in UTC instead of the user\'s time zone',
    'PROJ-123',
  ];

  views.home = {
    detected: null,
    async enter(route) {
      if (route.compose !== undefined && route.compose !== '') {
        S.draft.text = route.compose;
        persist();
      }
      if (route.scenario) {
        // Once: a reload must not pick it again over what you chose since.
        S.draft.scenario = route.scenario;
        S.route = { ...route, scenario: undefined };
        persist();
      }
      $('#view')!.innerHTML = `
        <div class="page home">
          <div data-region="onboarding"></div>
          <section class="composer card" data-region-static="composer"></section>
          <div data-region="health"></div>
          <div data-region="tasks"></div>
        </div>`;
      await loadOverview();
      this.renderComposer();
      this.render();
      const ta = $<HTMLTextAreaElement>('#composer-text');
      if (ta && (route.compose !== undefined || !S.overview!.tasks.length)) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
      this.preview();
    },
    async refresh() {
      await loadOverview();
      this.render();
      this.renderAgentsChips();
    },
    render() {
      const o = S.overview;
      if (!o!.root) {
        patch('onboarding', `<div class="empty-state">${icon('folder', 'big')}<h2>Open a folder</h2><p>Claudestrator works on the repositories of a workspace folder. Open the folder that holds your repos (or a single repo).</p></div>`);
        patch('tasks', '');
        return;
      }
      patch('onboarding', !o!.hasConfig ? `
        <div class="hero card">
          <div class="hero-icon">${icon('wand')}</div>
          <div class="hero-text">
            <h2>Set up ${esc(o!.rootName)} in a minute</h2>
            <p>Tell Claudestrator which repos the agents may change and which checks (lint, tests) must stay green. You can also skip this and just describe a task: the planner picks folders by name.</p>
          </div>
          <div class="hero-actions"><button class="btn primary" data-action="nav" data-name="setup">${icon('wand')}Set up workspace</button></div>
        </div>` : o!.config && !o!.config.ok ? `
        <div class="banner error">${icon('alert')}<div><b>The config has errors, so tasks cannot start.</b><ul>${o!.config.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div><button class="btn sm" data-action="open-config">Open config.yaml</button></div>` : '');
      patch('health', healthLine(o!.health));
      patch('tasks', this.tasksHtml(o!.tasks));
    },
    tasksHtml(tasks) {
      if (!tasks.length) {
        return `<div class="empty-tasks">
          <div class="empty-illustration">${icon('bot', 'big')}</div>
          <h3>No tasks yet</h3>
          <p class="muted">Describe one above. A few to try:</p>
          <div class="examples">${EXAMPLES.map((e) => `<button class="example" data-action="example" data-text="${esc(e)}">${icon('sparkles')}${esc(e)}</button>`).join('')}</div>
        </div>`;
      }
      const groups = [
        { id: 'attention', title: 'Needs you', icon: 'bell', open: true },
        { id: 'running', title: 'Running', icon: 'activity', open: true },
        { id: 'stopped', title: 'Paused', icon: 'pause', open: true },
        { id: 'done', title: 'Finished', icon: 'check', open: true },
      ];
      return groups
        .map((g) => {
          const list = tasks.filter((t) => t.status.group === g.id);
          if (!list.length) return '';
          const collapsed = S.ui[`group-${g.id}`] === undefined ? !g.open : S.ui[`group-${g.id}`];
          const shown = g.id === 'done' && !S.ui.showAllDone ? list.slice(0, 8) : list;
          return `<section class="group ${collapsed ? 'collapsed' : ''}">
            <button class="group-head" data-action="toggle-group" data-id="${g.id}">${icon('chevron', 'chev')}${icon(g.icon)}<span>${g.title}</span><span class="count">${list.length}</span></button>
            <div class="cards">${shown.map(taskCard).join('')}${shown.length < list.length ? `<button class="btn ghost sm more" data-action="show-all-done">Show ${list.length - shown.length} more</button>` : ''}</div>
          </section>`;
        })
        .join('');
    },
    renderComposer() {
      const o = S.overview;
      const disabled = !o!.root || (o!.config && !o!.config.ok);
      $('[data-region-static="composer"]')!.innerHTML = `
        <div class="composer-top">
          <label class="composer-label" for="composer-text">${icon('sparkles')}What should the agents do?</label>
          <div class="scenarios" data-region="scenarios"></div>
        </div>
        <div data-region="sc-editor"></div>
        <textarea id="composer-text" class="composer-text" rows="3" placeholder="${esc(SCENARIO_INFO[this.scenario()]!.placeholder)}" ${disabled ? 'disabled' : ''}>${esc(S.draft.text)}</textarea>
        <div class="composer-detect" data-region="detect"></div>
        <div class="composer-row">
          <div class="agents-chips" data-region="agent-chips"></div>
          <div class="composer-actions">
            <span data-region="auto-switch"></span>
            <button class="btn primary" data-action="start" id="start-btn" ${disabled ? 'disabled' : ''}>${icon('play')}<span data-region="start-label">Start</span><kbd>⌘↵</kbd></button>
          </div>
        </div>
        <details class="composer-more" ${S.draft.key ? 'open' : ''}>
          <summary>More options</summary>
          <div class="field-row">
            <label class="field"><span>Task key <span class="muted">(optional)</span></span><input id="composer-key" class="input" placeholder="e.g. PROJ-123, or any id" value="${esc(S.draft.key)}" spellcheck="false"></label>
            <p class="muted small">By default a Jira issue keeps its key, a Confluence page becomes DOC-&lt;id&gt; and a description gets a time-based id. Starting a task that already exists continues it.</p>
          </div>
        </details>`;
      this.renderAgentsChips();
      autosize($('#composer-text'));
    },
    /** The scenario the task will run: your pick (while it exists), else what the words suggest (from the last preview). */
    scenario() {
      const ids = this.scenarioIds();
      const picked = S.draft.scenario && S.draft.scenario !== 'auto' && ids.includes(S.draft.scenario) ? S.draft.scenario : null;
      return picked || (this.detected !== null && ids.includes(this.detected) ? this.detected : 'deliver');
    },
    /** Every scenario the menu offers: Deliver, the built-in reports not removed, then your own. */
    scenarioIds() {
      const c = okConfig();
      const removed = (c && c.removedScenarios) || [];
      return [...Object.keys(SCENARIO_INFO).filter((id) => !removed.includes(id)), ...((c && c.custom) || []).map((x) => x.id)];
    },
    /** A scenario's agents as the config lists them, switched-off ones included. */
    scenarioAgents(sc) {
      const c = okConfig();
      return c ? c.agents.filter((a) => (a.scenario || 'deliver') === sc) : [];
    },
    renderScenario() {
      const sc = this.scenario();
      const picked = S.draft.scenario && S.draft.scenario !== 'auto' && S.draft.scenario === sc;
      const auto = (id: string) => sc === id && !picked && id !== 'deliver';
      const info = scInfo(sc);
      const c = okConfig();
      const editable = Boolean(c && c.catalog);
      const removed = (c && c.removedScenarios) || [];
      patch(
        'scenarios',
        `<span class="menu-wrap sc-select">
          <button class="sc-current sc-${info.custom ? 'custom' : sc}" data-action="eff-menu" aria-haspopup="menu" title="${esc(`${info.hint}${auto(sc) ? '\n\nPicked from your words; choose another to change it.' : ''}`)}">${icon(info.icon)}${esc(info.label)}${auto(sc) ? '<span class="sc-auto">auto</span>' : ''}<span class="sc-caret">▾</span></button>
          <div class="menu sc-menu" role="menu">${this.scenarioIds()
            .map((id) => {
              const x = scInfo(id);
              const agents = this.scenarioAgents(id).filter((a) => a.enabled);
              return `<div class="sc-item ${sc === id ? 'current' : ''}">
                <button class="sc-pick" role="menuitemradio" aria-checked="${sc === id}" data-action="set-scenario" data-id="${esc(id)}">${icon(sc === id ? 'check' : x.icon)}<span class="sc-text"><b>${esc(x.label)}${auto(id) ? '<span class="sc-auto">auto</span>' : ''}</b><span class="muted small">${esc(x.hint)}</span><span class="sc-agents">${agents.length ? agents.map((a) => `<span class="${agentColor(a.color)}"><span class="adot"></span>${esc(a.name)}</span>`).join('<span class="pipe-arrow">→</span>') : '<span class="muted">no agents yet</span>'}</span></span></button>
                ${editable ? `<span class="sc-tools">
                  <button class="sc-edit ${S.ui.scEdit === id ? 'on' : ''}" data-action="sc-edit" data-id="${esc(id)}" title="Edit ${esc(x.label)}: agents, their order${x.custom ? ', models and effort' : ''}">${icon('edit')}</button>
                  ${id === 'deliver' ? '' : `<button class="sc-edit sc-del" data-action="sc-delete" data-id="${esc(id)}" title="Delete ${esc(x.label)}">${icon('trash')}</button>`}
                </span>` : ''}
              </div>`;
            })
            .join('')}
            ${editable ? `<div class="sc-foot">
              <button class="sc-new" data-action="sc-new">${icon('plus')}New scenario<span class="muted small">your own agents, order, models and effort</span></button>
              ${removed.map((id) => `<button class="sc-restore" data-action="sc-restore" data-id="${id}" title="${esc(SCENARIO_INFO[id]!.hint)}">${icon('refresh')}Bring back <b>${esc(SCENARIO_INFO[id]!.label)}</b></button>`).join('')}
            </div>` : ''}</div>
        </span>`
      );
      this.renderScenarioEditor();
      patch('auto-switch', info.kind === 'deliver' ? `<label class="switch" title="The plan goes straight to development, without waiting for your approval"><input type="checkbox" id="composer-auto" ${S.draft.auto ? 'checked' : ''}><span class="track"></span><span>Skip plan approval</span></label>` : '');
      patch('start-label', info.kind === 'readiness' ? 'Check' : info.kind === 'audit' ? 'Audit' : 'Start');
      const ta = $<HTMLTextAreaElement>('#composer-text');
      if (ta) ta.placeholder = info.placeholder;
    },
    renderScenarioEditor() {
      const c = okConfig();
      const sc = S.ui.scEdit;
      if (!sc || !this.scenarioIds().includes(sc) || !c || !c.catalog) return patch('sc-editor', '');
      const info = scInfo(sc);
      const own = (c.custom || []).find((x) => x.id === sc);
      const stages: PipeStage[] = this.scenarioAgents(sc).map((a) => ({ agent: a.name, output: a.output, runs: a.runs, color: a.color, enabled: a.enabled, model: a.model, effort: a.effort, ownModel: a.ownModel, ownEffort: a.ownEffort }));
      // An empty custom scenario takes any agent; after the first one, only agents of the same kind.
      const kind = own ? own.kind : sc;
      const choices = c.catalog.filter((a) => (!kind || fitsScenario(a.output, kind)) && !stages.some((st) => st.agent === a.name));
      const warnings = sc === 'deliver' ? c.pipelineWarnings || [] : [];
      if (pipeDrag && pipeDrag.id === 'composer') return;
      const models = modelChoices(S.overview!.defaults);
      // A custom scenario sets each agent's model and effort for itself; empty means the agent's own setting.
      const extras: ((st: PipeStage) => string) | null = own
        ? (st) => {
            const known = models.some(([m]) => m === st.model);
            const modelOpts = [`<option value="">agent's model${st.ownModel ? '' : ` (${esc(st.model)})`}</option>`, ...models.filter(([m]) => m !== 'inherit').map(([m, l]) => `<option value="${esc(m)}" ${st.ownModel && m === st.model ? 'selected' : ''}>${esc(l)}</option>`), ...(st.ownModel && !known ? [`<option value="${esc(st.model)}" selected>${esc(st.model)}</option>`] : [])].join('');
            const effortOpts = [`<option value="">agent's effort${st.ownEffort ? '' : st.effort ? ` (${esc(st.effort)})` : ''}</option>`, ...EFFORT_LEVELS.map((l) => `<option value="${l}" ${st.ownEffort && l === st.effort ? 'selected' : ''}>${l}</option>`)].join('');
            return `<span class="pipe-sets"><select class="pipe-set ${st.ownModel ? 'own' : ''}" data-change="sc-model" data-name="${esc(st.agent)}" title="Model of ${esc(st.agent)} in this scenario" aria-label="Model">${modelOpts}</select><select class="pipe-set ${st.ownEffort ? 'own' : ''}" data-change="sc-effort" data-name="${esc(st.agent)}" title="Effort of ${esc(st.agent)} in this scenario" aria-label="Effort">${effortOpts}</select></span>`;
          }
        : null;
      patch(
        'sc-editor',
        `<div class="pipe-editor sc-editor">
          <div class="pipe-head">
            <div><h3>${icon(own ? 'wand' : 'edit')}${esc(info.label)}: ${own ? 'your scenario' : 'agents'}</h3>
              <p class="muted small">Drag to reorder, ${icon('x')} to remove, <b>Add agent</b> to add${own ? '; pick a model and effort per agent for this scenario only' : ''}; <b>per repo ⇄ all repos</b> switches whether a code or tests agent runs once per repo or once across them. Saved to <code>.claudestrator/config.yaml</code>: new tasks run this order, running tasks keep theirs (change those on the task screen).</p></div>
            <button class="btn sm" data-action="sc-edit" data-id="${esc(sc)}">${icon('check')}Done</button>
          </div>
          ${own ? `<div class="sc-fields">
            <label class="field"><span>Name</span><input class="input" data-change="sc-label" value="${esc(own.label)}" maxlength="60" placeholder="e.g. Hotfix"></label>
            <label class="field"><span>Description <span class="muted">(optional, shown in the menu)</span></span><input class="input" data-change="sc-desc" value="${esc(own.description || '')}" placeholder="e.g. Code and a quick review, no plan"></label>
          </div>
          <p class="muted small">${own.kind === 'readiness' || own.kind === 'audit' ? `Read-only: its agents write ${own.kind === 'audit' ? 'an audit' : 'a readiness'} report, nothing in your repos changes.` : own.kind ? 'Its agents change code: the task ends with commits and draft PRs, like Deliver.' : 'Add the first agent: agents that change code make it end with draft PRs, readiness or audit agents make it a read-only report.'}</p>` : ''}
          ${pipeRowHtml('composer', { stages, choices, runsToggle: true, extras, empty: own ? 'No agents yet: add the first one.' : 'No agents: add one, or tasks of this kind cannot start.' })}
          ${warnings.length ? `<div class="pipe-warn">${warnings.map((w) => `<div>${icon('alert')}${esc(w)}</div>`).join('')}</div>` : ''}
        </div>`
      );
    },
    /** A custom scenario as saveScenario takes it, with `change` applied to one agent's step. */
    customDef(id, change = {}) {
      const own = ((okConfig()?.custom) || []).find((x) => x.id === id);
      if (!own) throw new Error(`No scenario ${id}`);
      const agents = this.scenarioAgents(id).map((a) => {
        const step: ScenarioStep = { name: a.name };
        if (a.ownModel) step.model = a.model;
        if (a.ownEffort && a.effort) step.effort = a.effort;
        return step;
      });
      return { id, label: own.label, description: own.description, agents, ...change };
    },
    async saveCustom(def, done) {
      if ((await attempt('saveScenario', def)) === undefined) return false;
      await loadOverview();
      if (S.route.name === 'home') {
        this.renderAgentsChips();
        this.preview();
      }
      if (done) toast(done, 'ok');
    },
    renderAgentsChips() {
      const c = okConfig();
      this.renderScenario();
      if (!c) return patch('agent-chips', '');
      const sc = this.scenario();
      const enabled = c.agents.filter((a) => a.enabled && (a.scenario || 'deliver') === sc);
      const own = (a: AgentSummary) => S.draft.effort[a.name];
      const on = enabled.filter((a) => !S.draft.no.includes(a.name));
      const levels = new Set(on.map(own));
      const allLabel = !on.some(own) ? 'as configured' : levels.size === 1 ? [...levels][0] : 'mixed';
      const menu = (name: string, configured: string | null | undefined, current: string | undefined) => `<div class="menu eff-menu">
        <div class="menu-title">${name === '*' ? 'Effort for every agent of this task' : `Effort of ${esc(name)} for this task`}</div>
        <button data-action="set-effort" data-name="${esc(name)}" data-level="" class="${!current ? 'current' : ''}">${icon(!current ? 'check' : 'refresh')}${name === '*' ? 'As each agent is configured' : `As configured (${esc(configured || '…')})`}</button>
        ${EFFORT_LEVELS.map((l) => `<button data-action="set-effort" data-name="${esc(name)}" data-level="${l}" class="${current === l ? 'current' : ''}">${current === l ? icon('check') : '<span class="ic"></span>'}<span class="effort eff-${l}">${l}</span><span class="muted small">${EFFORT_HINTS[l]}</span></button>`).join('')}
      </div>`;
      patch(
        'agent-chips',
        `<span class="menu-wrap"><button class="btn ghost sm eff-all" data-action="eff-menu" title="Set the effort of every agent for this task">${icon('gauge')}Effort: <b>${esc(allLabel)}</b></button>${menu('*', '', levels.size === 1 && on.some(own) ? [...levels][0] : '')}</span>
        <span class="muted small chips-label">Agents</span>${enabled
          .map((a) => {
            const off = S.draft.no.includes(a.name);
            const override = own(a);
            const act = a.actual;
            const level = override || act.effort || a.effort;
            const isDefault = !override && !a.effort;
            const model = act.modelName || (a.model && a.model !== 'inherit' ? a.model : '');
            return `<span class="agent-chip ${agentColor(a.color)} ${off ? 'off' : ''}">
              <button class="ac-toggle" data-action="toggle-agent" data-name="${a.name}" title="${esc(`${a.description}\n\nModel: ${model || a.model}${a.model === 'inherit' ? ' (the default for your account)' : ''}\n${off ? 'Off for this task: click to turn on' : 'Click to skip this agent for this task'}`)}" aria-pressed="${!off}"><span class="adot"></span>${esc(a.name)}${model ? `<span class="chip-sub">${esc(model)}</span>` : ''}</button>
              <span class="menu-wrap"><button class="ac-eff ${override ? 'overridden' : ''} ${isDefault ? 'is-default' : ''} ${level ? `eff-${level}` : ''}" data-action="eff-menu" ${off ? 'disabled' : ''} title="${esc(override ? `Effort ${override} for this task (the agent is set to ${a.effort || `the default, ${act.defaultEffort || 'unknown'}`})` : `Runs at ${level || 'the model default'}${isDefault ? ` (the default of ${model || 'its model'} for your account)` : ' (set on the agent)'}. Click to change it for this task`)}">${esc(level || '…')}${override ? '<span class="ov-dot"></span>' : ''}▾</button>${menu(a.name, act.effort || a.effort, override)}</span>
            </span>`;
          })
          .join('')}`
      );
    },
    preview() {
      debounce('preview', async () => {
        if (S.route.name !== 'home') return;
        const text = S.draft.text.trim();
        if (!text && !S.draft.key) return patch('detect', `<span class="muted small">Tip: select text in an editor and run “Claudestrator: Start a Task from Selection”.</span>`);
        let p: Preview;
        try {
          p = await call('preview', { text: S.draft.text, auto: S.draft.auto, no: S.draft.no, key: S.draft.key || undefined, effort: S.draft.effort, scenario: S.draft.scenario });
        } catch (e) {
          return patch('detect', `<span class="detect error">${icon('alert')}${esc(e instanceof Error ? e.message : String(e))}</span>`);
        }
        if (!p.ok) return patch('detect', `<span class="detect error">${icon('alert')}${esc(p.error)}</span>`);
        if (p.empty) {
          if (this.detected) {
            this.detected = null;
            this.renderAgentsChips();
          }
          return patch('detect', '');
        }
        const detected = p.scenarioDetected ? p.scenarioName : null;
        if (detected !== this.detected) {
          this.detected = detected;
          this.renderAgentsChips();
        }
        const colors = Object.fromEntries(((okConfig()?.agents) || []).map((a): [string, string | undefined] => [a.name, a.color]));
        const kind = p.source.kind === 'jira' ? `${icon('jira')}Jira issue <b>${esc(p.source.key)}</b>${p.source.note ? ` <span class="muted">+ your note</span>` : ''}` : p.source.kind === 'confluence' ? `${icon('doc')}Confluence page <b>${esc(p.source.pageId)}</b>` : `${icon('text')}${p.scenario === 'audit' ? 'Audit scope in your words' : p.scenario === 'readiness' ? 'What to check, in your words' : 'Task described in your words'}`;
        const health = S.overview!.health;
        const needsAtlassian = p.source.kind !== 'text' && !(!health.checking && (health.atlassian || health.atlassianMcp));
        patch(
          'detect',
          `<div class="detect">
            <span class="detect-kind">${kind}</span>
            <span class="muted">→</span>
            <span class="chip mono">${esc(p.taskId)}</span>
            ${p.exists ? `<span class="badge tone-warn">continues the existing task</span>` : ''}
            ${p.scenario === 'readiness' && p.source.kind === 'text' && /\b[A-Z][A-Z0-9]+-\d+\b/.test(S.draft.text) ? `<span class="detect warn">${icon('info')}Checked against your words only: name exactly one Jira issue to read it from Jira</span>` : ''}
            ${p.problem ? `<span class="detect error">${icon('alert')}${esc(p.problem)}</span>` : ''}
            ${needsAtlassian ? `<span class="detect warn">${icon('alert')}Jira/Confluence is not connected. <a data-action="nav" data-name="mcp">Sign in to Atlassian MCP</a> or <a data-action="nav" data-name="settings">add a token</a></span>` : ''}
          </div>
          <div class="detect-outline">${outlineHtml(p.outline, colors)}</div>
          ${p.warnings.length ? `<div class="detect-warn">${p.warnings.map((w) => `<div>${icon('info')}${esc(w)}</div>`).join('')}</div>` : ''}`
        );
      }, 250);
    },
    async start() {
      const text = S.draft.text.trim();
      if (!text && !S.draft.key) {
        $('#composer-text')?.focus();
        shake($('#composer-text'));
        return;
      }
      const btn = $<HTMLButtonElement>('#start-btn')!;
      btn.disabled = true;
      btn.classList.add('busy');
      const r = await attempt('start', { text: S.draft.text, auto: S.draft.auto, no: S.draft.no, key: S.draft.key || undefined, effort: S.draft.effort, scenario: this.scenario() });
      btn.disabled = false;
      btn.classList.remove('busy');
      if (!r) return;
      S.draft = { text: '', no: [], auto: false, key: '', effort: {}, scenario: 'auto' };
      this.detected = null;
      persist();
      toast(r.created ? `Started ${r.taskId}` : `Continuing ${r.taskId}`, 'ok');
      go({ name: 'task', taskId: r.taskId });
    },
  };

  /** `2 critical · 1 high · …`, skipping zeros. */
  function sevCounts(counts: Record<string, number>) {
    return `<span class="sev-counts">${['critical', 'high', 'medium', 'low'].filter((s) => counts[s]).map((s) => `<span class="sev-n sev-${s}" title="${counts[s]} ${s}">${counts[s]} ${s}</span>`).join('')}</span>`;
  }

  function taskCard(t: Card) {
    const live = t.status.key === 'running' && t.live;
    let cta = '';
    if (t.status.key === 'waiting') cta = `<button class="btn primary sm" data-action="open-task" data-id="${t.taskId}">${icon('bell')}${esc(t.checkpoint?.id === 'approve-plan' ? 'Review plan' : t.checkpoint?.id === 'confirm-push' ? 'Review & push' : 'Decide')}</button>`;
    else if (['stopped', 'failed', 'interrupted', 'ready'].includes(t.status.key)) cta = `<button class="btn sm" data-action="run" data-id="${t.taskId}">${icon('play')}Resume</button>`;
    else if (t.status.key === 'running') cta = `<button class="icon-btn" data-action="stop" data-id="${t.taskId}" title="Stop">${icon('stop')}</button>`;
    const prs = Object.entries(t.prs || {});
    return `<article class="task-card tone-${t.status.tone}" data-action="open-task" data-id="${t.taskId}" tabindex="0">
      <div class="tc-main">
        <div class="tc-title">${esc(t.title)}</div>
        <div class="tc-meta">
          <span class="chip mono">${esc(t.taskId)}</span>
          ${scenarioChip(t.scenario, t.scenarioLabel)}
          ${statusBadge(t.status, t.live)}
          ${t.result && t.result.kind === 'audit' ? sevCounts(t.result.counts ?? {}) : ''}
          ${live ? `<span class="muted small" data-since="${live.since ?? Date.now()}">${dur(Date.now() - (live.since ?? Date.now()))}</span>` : ''}
          ${t.branch ? `<span class="muted small">${icon('branch')}${esc(t.branch)}</span>` : ''}
          ${t.cost ? `<span class="muted small">${money(t.cost)}</span>` : ''}
          <span class="muted small">${ago(t.updatedAt)}</span>
        </div>
        ${t.error ? `<div class="tc-error">${icon('alert')}${esc(t.error.message)}</div>` : t.checkpoint ? `<div class="tc-hint">${esc(t.checkpoint.hint)}</div>` : ''}
        ${miniSteps(t.mini)}
      </div>
      <div class="tc-side">
        ${prs.length ? prs.map(([r, u]) => `<a class="chip link-chip" data-action="open-url" data-url="${esc(u)}">${icon('pr')}${esc(r)}</a>`).join('') : ''}
        ${cta}
      </div>
    </article>`;
  }

  // ---------- setup wizard ----------

  views.setup = {
    repos: [],
    prefs: { language: 'English', gitMode: 'branch', map: false },
    async enter() {
      await loadOverview();
      const o = S.overview;
      if (!o!.root) return go({ name: 'home' });
      if (o!.hasConfig) {
        $('#view')!.innerHTML = `<div class="page narrow"><div class="empty-state">${icon('check', 'big ok')}<h2>${esc(o!.rootName)} is set up</h2><p>Change repos and checks, agents or settings any time.</p>
          <div class="row center"><button class="btn" data-action="nav" data-name="repos">${icon('repo')}Repos & checks</button><button class="btn" data-action="nav" data-name="agents">${icon('users')}Agents</button><button class="btn" data-action="nav" data-name="settings">${icon('gear')}Settings</button></div></div></div>`;
        return;
      }
      const detected = await call('detect');
      this.repos = detected.repos.map((r) => ({ ...r, on: true, gates: r.gates.map((g) => ({ ...g, on: true })) }));
      this.prefs = { language: 'English', gitMode: 'branch', map: this.repos.length > 1 };
      this.render();
    },
    render() {
      const o = S.overview;
      const h = o!.health;
      const repoRows = this.repos.length
        ? this.repos
            .map(
              (r, i) => `<div class="setup-repo ${r.on ? '' : 'off'}">
          <label class="sr-check"><input type="checkbox" data-change="setup-repo" data-i="${i}" ${r.on ? 'checked' : ''}></label>
          <div class="sr-main">
            <div class="sr-title"><input class="input inline" data-input="setup-name" data-i="${i}" value="${esc(r.name)}" spellcheck="false" aria-label="Repo name">${r.path !== r.name ? `<span class="muted mono small" title="${esc(r.dir || r.path)}">${esc(String(r.path).replace(/^\/Users\/[^/]+/, '~'))}</span>` : ''}${r.outside ? '<span class="chip small">outside the workspace</span>' : ''}${r.stack.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}${r.baseBranch ? `<span class="muted small">${icon('branch')}${esc(r.baseBranch)}</span>` : ''}</div>
            <div class="sr-gates">${r.gates.length ? r.gates.map((g, j) => `<button class="gate-chip ${g.on ? 'on' : ''}" data-action="setup-gate" data-i="${i}" data-j="${j}" title="${esc(g.cmd)}">${icon(g.on ? 'check' : 'x')}${esc(g.name)}<code>${esc(g.cmd)}</code></button>`).join('') : '<span class="muted small">No checks found. Add them later under Repos & checks.</span>'}</div>
          </div>
        </div>`
            )
            .join('')
        : `<div class="banner info">${icon('info')}<div>No git repositories found in ${esc(o!.rootName)}. Add them from anywhere on disk below, or continue: agents then work in folders named by the plan.</div></div>`;
      const tool = (ok: boolean | undefined, name: string, text: string | undefined, fix?: string) => `<div class="tool-check ${ok ? 'ok' : 'bad'}">${icon(ok ? 'check' : 'alert')}<b>${name}</b><span>${esc(text || '')}</span>${!ok && fix ? `<span class="fix">${fix}</span>` : ''}</div>`;
      $('#view')!.innerHTML = `
        <div class="page narrow setup">
          <h1>${icon('wand')}Set up ${esc(o!.rootName)}</h1>
          <p class="lead">Three quick choices. Everything ends up in <code>.claudestrator/config.yaml</code>, which you can edit here later or commit for your team.</p>
          <section class="card step-card"><div class="step-no">1</div><div class="step-body">
            <h3>Tools</h3>
            ${h && !h.checking ? `${tool(h.claude.ok, 'Claude Code CLI', h.claude.ok ? h.claude.version : h.claude.error, 'Install it from <a data-action="open-url" data-url="https://docs.claude.com/en/docs/claude-code/setup">docs.claude.com</a> or set its path in Settings.')}
            ${tool(h.git.ok, 'Git', h.git.version)}
            ${tool(h.gh.ok, 'GitHub CLI', h.gh.ok ? `logged in${h.gh.account ? ` as ${h.gh.account}` : ''}` : h.gh.error, 'Optional: needed only to open PRs. Run <code>gh auth login</code>.')}` : '<div class="muted">Checking…</div>'}
          </div></section>
          <section class="card step-card"><div class="step-no">2</div><div class="step-body">
            <h3>Repositories agents may change</h3>
            <p class="muted small">Each check (gate) runs after an agent changes the repo. If one fails, the agent gets the output and fixes it.</p>
            <div class="setup-repos">${repoRows}</div>
            <div class="row"><button class="btn sm" data-action="setup-pick">${icon('folder')}Add a repository from disk…</button><span class="muted small">any folder on this laptop; a folder with several repos works too</span></div>
          </div></section>
          <section class="card step-card"><div class="step-no">3</div><div class="step-body">
            <h3>How agents work</h3>
            <div class="field-row">
              <label class="field"><span>Language of plans, reviews and PR descriptions</span>
                <select class="input" data-change="setup-lang">${['English', 'Ukrainian', 'German', 'French', 'Spanish', 'Polish'].map((l) => `<option ${l === this.prefs.language ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            </div>
            <div class="radio-cards">
              <label class="radio-card ${this.prefs.gitMode === 'branch' ? 'on' : ''}"><input type="radio" name="gitmode" value="branch" data-change="setup-git" ${this.prefs.gitMode === 'branch' ? 'checked' : ''}><b>${icon('branch')}Branch in your checkout</b><span>Agents switch your repos to the task branch. Simple; your repos must be clean, one task at a time.</span></label>
              <label class="radio-card ${this.prefs.gitMode === 'worktree' ? 'on' : ''}"><input type="radio" name="gitmode" value="worktree" data-change="setup-git" ${this.prefs.gitMode === 'worktree' ? 'checked' : ''}><b>${icon('folder')}Separate worktree per task</b><span>Each task gets its own copy under <code>.orch/worktrees</code>. Your checkouts are never touched; tasks can run in parallel.</span></label>
            </div>
            <label class="check-line"><input type="checkbox" data-change="setup-map" ${this.prefs.map ? 'checked' : ''}><span>Create a workspace map (<code>.claudestrator/workspace.md</code>) every agent reads first: what each repo is and the contracts between them</span></label>
          </div></section>
          <div class="setup-actions">
            <button class="btn ghost" data-action="go-home">Not now</button>
            <button class="btn primary lg" data-action="setup-create">${icon('check')}Create configuration</button>
          </div>
        </div>`;
    },
    async create() {
      const repos = this.repos.filter((r) => r.on).map((r) => ({ name: r.name, path: r.path, role: r.role, baseBranch: r.baseBranch, stack: r.stack, gates: r.gates.filter((g) => g.on).map(({ name, cmd }) => ({ name, cmd })) }));
      const r = await attempt('setup', { repos, language: this.prefs.language, gitMode: this.prefs.gitMode, map: this.prefs.map });
      if (!r) return;
      toast('Workspace is set up. Describe your first task.', 'ok');
      go({ name: 'home', compose: '' });
    },
  };

  // ---------- helpers for inputs ----------

  function autosize(ta: HTMLElement | null) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 320)}px`;
  }

  function shake(el: HTMLElement | null) {
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  // ---------- events ----------

  const closeMenus = () => $$('.menu-wrap.open').forEach((w) => w.classList.remove('open'));

  const actions: Record<string, ActionFn> = {
    nav: (el) => go({ name: el.dataset.name }),
    'nav-settings': () => go({ name: 'settings' }),
    'go-home': () => go({ name: 'home' }),
    'new-task': () => {
      if (S.route.name === 'home') return $('#composer-text')?.focus();
      go({ name: 'home', compose: '' });
    },
    'open-task': (el, e) => {
      const inner = e.target instanceof Element ? e.target.closest('a, button') : null;
      if (inner && inner !== el) return;
      go({ name: 'task', taskId: el.dataset.id });
    },
    run: async (el) => {
      await attempt('run', { taskId: el.dataset.id || S.route.taskId || '' });
    },
    stop: async (el) => {
      await attempt('stop', { taskId: el.dataset.id || S.route.taskId || '' }, 'Stopped. Resume any time; the step starts over.');
    },
    'open-url': (el) => call('openExternal', { url: el.dataset.url }),
    'open-config': () => attempt('openConfig', { which: 'project' }),
    recheck: async () => {
      patch('health', healthLine({ checking: true }));
      const h = await attempt('health', { refresh: true });
      if (h && S.overview) {
        S.overview.health = h;
        if (S.route.name === 'home') patch('health', healthLine(h));
        else if (current && current.load) current.load();
      }
    },
    example: (el) => {
      S.draft.text = el.dataset.text;
      persist();
      const ta = $<HTMLTextAreaElement>('#composer-text')!;
      ta.value = S.draft.text;
      autosize(ta);
      ta.focus();
      views.home.preview();
    },
    'eff-menu': (el) => {
      const wrap = el.closest('.menu-wrap');
      if (!wrap) return;
      const open = !wrap.classList.contains('open');
      closeMenus();
      wrap.classList.toggle('open', open);
    },
    'set-account': async (el) => {
      closeMenus();
      const a = await attempt('setAccount', { dir: el.dataset.dir });
      if (!a) return;
      toast(`Agents now run as ${a.email || a.label}`, 'ok');
      await loadOverview();
      if (current && current.refresh) current.refresh();
      if (current && current.load) current.load();
    },
    'claude-login': () => attempt('claudeLogin'),
    'open-account-menu': () => {
      const btn = $('.acc-btn');
      if (btn) btn.click();
    },
    'set-effort': (el) => {
      const { name, level } = el.dataset;
      const c = okConfig();
      if (name === '*') {
        S.draft.effort = level ? Object.fromEntries((c ? c.agents : []).filter((a) => a.enabled && !S.draft.no.includes(a.name)).map((a): [string, string] => [a.name, level])) : {};
      } else if (level) S.draft.effort = { ...S.draft.effort, [name]: level };
      else {
        const { [name]: _, ...rest } = S.draft.effort;
        S.draft.effort = rest;
      }
      persist();
      views.home.renderAgentsChips();
      views.home.preview();
    },
    'toggle-agent': (el) => {
      const n = el.dataset.name;
      S.draft.no = S.draft.no.includes(n) ? S.draft.no.filter((x) => x !== n) : [...S.draft.no, n];
      persist();
      views.home.renderAgentsChips();
      views.home.preview();
    },
    start: () => views.home.start(),
    'pipe-remove': (el) => {
      const { pipe, name } = el.dataset;
      const ed = pipeEditors[pipe];
      if (ed) pipeSave(pipe, ed.names().filter((n) => n !== name), `${name} removed`);
    },
    'pipe-runs': (el) => {
      const { pipe, name, runs } = el.dataset;
      const ed = pipeEditors[pipe];
      if (ed && ed.setRuns) ed.setRuns(name, runs);
    },
    'pipe-add': (el) => {
      const { pipe, name } = el.dataset;
      el.closest('.menu-wrap')?.classList.remove('open');
      const ed = pipeEditors[pipe];
      if (ed) pipeSave(pipe, [...ed.names(), name], `${name} added at the end`);
    },
    'sc-edit': (el) => {
      closeMenus();
      S.ui.scEdit = S.ui.scEdit === el.dataset.id ? null : el.dataset.id;
      persist();
      views.home.renderScenario();
    },
    'set-scenario': (el) => {
      closeMenus();
      S.draft.scenario = el.dataset.id;
      persist();
      views.home.renderAgentsChips();
      views.home.preview();
    },
    // A new scenario starts empty, picked and open in the editor, with its name ready to type over.
    'sc-new': async () => {
      closeMenus();
      const labels = new Set(((okConfig()?.custom) || []).map((x) => x.label.toLowerCase()));
      let label = 'New scenario';
      for (let n = 2; labels.has(label.toLowerCase()); n++) label = `New scenario ${n}`;
      const r = await attempt('saveScenario', { label, agents: [] });
      if (!r) return;
      await loadOverview();
      S.draft.scenario = r.id;
      S.ui.scEdit = r.id;
      persist();
      views.home.renderAgentsChips();
      views.home.preview();
      const name = $<HTMLInputElement>('[data-change="sc-label"]');
      if (name) {
        name.focus();
        name.select();
      }
    },
    'sc-delete': async (el) => {
      closeMenus();
      const id = el.dataset.id;
      const label = scInfo(id).label;
      const r = await attempt('deleteScenario', { id });
      if (!r || !r.deleted) return;
      if (S.draft.scenario === id) S.draft.scenario = 'auto';
      if (S.ui.scEdit === id) S.ui.scEdit = null;
      persist();
      await loadOverview();
      views.home.renderAgentsChips();
      views.home.preview();
      toast(`${label} deleted`, 'ok');
    },
    'sc-restore': async (el) => {
      closeMenus();
      if ((await attempt('restoreScenario', { id: el.dataset.id })) === undefined) return;
      await loadOverview();
      views.home.renderAgentsChips();
      toast(`${SCENARIO_INFO[el.dataset.id]!.label} is back`, 'ok');
    },
    'toggle-group': (el) => {
      const id = el.dataset.id;
      const sec = el.closest('.group')!;
      const collapsed = !sec.classList.contains('collapsed');
      sec.classList.toggle('collapsed', collapsed);
      S.ui[`group-${id}`] = collapsed;
      persist();
    },
    'show-all-done': () => {
      S.ui.showAllDone = true;
      persist();
      views.home.render();
    },
    perm: async (el) => {
      await attempt('permission', { requestId: el.dataset.id, allow: el.dataset.allow === '1' });
      refreshSoon();
    },
    'perm-why': async (el) => {
      const card = el.closest<HTMLElement>('.perm-card')!;
      if ($('.perm-why', card)) return;
      card.insertAdjacentHTML('beforeend', `<div class="perm-why"><input class="input" placeholder="Tell the agent why, or what to do instead" data-key="why-${el.dataset.id}"><button class="btn sm" data-action="perm-why-send" data-id="${el.dataset.id}">Deny</button></div>`);
      $('.perm-why input', card)!.focus();
    },
    'perm-why-send': async (el) => {
      const msg = $<HTMLInputElement>('.perm-why input', el.closest<HTMLElement>('.perm-card')!)!.value.trim();
      await attempt('permission', { requestId: el.dataset.id, allow: false, message: msg || undefined });
      refreshSoon();
    },
    'copy-code': (el) => {
      const code = el.closest('.code')!.querySelector('code')!.textContent ?? '';
      call('copy', { text: code }).then(() => toast('Copied', 'ok'));
    },
    'setup-gate': (el) => {
      const g = views.setup.repos[+el.dataset.i]!.gates[+el.dataset.j]!;
      g.on = !g.on;
      views.setup.render();
    },
    'setup-create': () => views.setup.create(),
    'setup-pick': async () => {
      const res = await attempt('pickRepos', { forSetup: true });
      if (!res) return;
      const known = new Set(views.setup.repos.map((r) => r.dir));
      const names = new Set(views.setup.repos.map((r) => r.name));
      for (const r of res.repos) {
        if (known.has(r.dir)) continue;
        let name = r.name;
        for (let n = 2; names.has(name); n++) name = `${r.name}-${n}`;
        names.add(name);
        views.setup.repos.push({ ...r, name, on: true, gates: r.gates.map((g) => ({ ...g, on: true })) });
      }
      if (res.notRepos.length) toast(`Not a git repository: ${res.notRepos.join(', ')}`, 'warn');
      views.setup.render();
    },
  };

  // The scenario open in the composer's editor: its name, description, and each agent's model and effort in it.
  const scChange = (change: Partial<CustomDef>, done?: string) => views.home.saveCustom(views.home.customDef(S.ui.scEdit ?? '', change), done);
  const scStep = (el: FieldEl, key: 'model' | 'effort') => {
    const def = views.home.customDef(S.ui.scEdit ?? '');
    const agents = def.agents.map((st) => {
      if (st.name !== el.dataset.name) return st;
      const next: ScenarioStep = { ...st };
      if (key === 'model') {
        if (el.value) next.model = el.value;
        else delete next.model;
      } else {
        const level = asEffort(el.value);
        if (level) next.effort = level;
        else delete next.effort;
      }
      return next;
    });
    return scChange({ agents }, `${el.dataset.name}: ${el.value ? `${key} ${el.value}` : `the agent's own ${key}`} in ${def.label}`);
  };

  const changes: Record<string, FieldFn> = {
    'sc-label': (el) => {
      if (!el.value.trim()) {
        el.value = views.home.customDef(S.ui.scEdit ?? '').label;
        return toast('A scenario needs a name', 'warn');
      }
      scChange({ label: el.value.trim() }, 'Renamed');
    },
    'sc-desc': (el) => scChange({ description: el.value.trim() || undefined }),
    'sc-model': (el) => scStep(el, 'model'),
    'sc-effort': (el) => scStep(el, 'effort'),
    'setup-repo': (el) => {
      views.setup.repos[+el.dataset.i]!.on = el.checked;
      views.setup.render();
    },
    'setup-lang': (el) => (views.setup.prefs.language = el.value),
    'setup-git': (el) => {
      views.setup.prefs.gitMode = el.value === 'worktree' ? 'worktree' : 'branch';
      views.setup.render();
    },
    'setup-map': (el) => (views.setup.prefs.map = el.checked),
  };
  const inputs: Record<string, FieldFn> = {
    'setup-name': (el) => (views.setup.repos[+el.dataset.i]!.name = el.value.trim()),
  };

  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    // A click outside an open menu closes it.
    for (const w of $$('.menu-wrap.open')) if (!w.contains(target)) w.classList.remove('open');
    const link = target && target.closest<HTMLElement>('a[data-href]');
    if (link) {
      e.preventDefault();
      call('openExternal', { url: link.dataset.href ?? '' });
      return;
    }
    const el = target && target.closest<ActionEl>('[data-action]');
    if (!el) return;
    const fn = actions[el.dataset.action] || (current && current.actions && current.actions[el.dataset.action]);
    if (fn) {
      e.preventDefault();
      fn(el, e);
    }
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if ((e.key === 'Enter' || e.key === ' ') && t && t.matches('[data-action][tabindex], [role="button"]') && !t.matches('button, a, input, textarea, select')) {
      e.preventDefault();
      t.click();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      if (t && (t.id === 'composer-text' || t.id === 'composer-key')) {
        e.preventDefault();
        views.home.start();
      } else if (current && current.onSubmit) current.onSubmit(e);
    }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const f = t as FieldEl;
    if (t.id === 'composer-text') {
      S.draft.text = f.value;
      persist();
      autosize(t);
      views.home.preview();
      return;
    }
    if (t.id === 'composer-key') {
      S.draft.key = f.value.trim();
      persist();
      views.home.preview();
      return;
    }
    if (t.matches('textarea.autosize')) autosize(t);
    const key = t.dataset.input;
    const fn = key && (inputs[key] || (current && current.inputs && current.inputs[key]));
    if (fn) fn(f, e);
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const f = t as FieldEl;
    if (t.id === 'composer-auto') {
      S.draft.auto = f.checked;
      persist();
      views.home.preview();
      return;
    }
    const key = t.dataset.change;
    const fn = key && (changes[key] || (current && current.changes && current.changes[key]));
    if (fn) fn(f, e);
  });

  function refreshSoon() {
    debounce('refresh', async () => {
      if (current && current.refresh) await current.refresh();
      else await loadOverview();
    }, 150);
  }

  window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case 'res': {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(Object.assign(new Error(msg.error), { code: msg.code, blocked: msg.blocked }));
        return;
      }
      case 'navigate':
        go(msg.route);
        return;
      case 'changed':
        refreshSoon();
        return;
      case 'config':
        if (current && current.onConfig) current.onConfig();
        else refreshSoon();
        return;
      case 'toast': {
        const taskId = msg.taskId;
        if (!(S.route.name === 'task' && S.route.taskId === taskId)) toast(`${taskId ? `${taskId}: ` : ''}${msg.text}`, msg.kind, taskId ? { label: 'Open', run: () => go({ name: 'task', taskId }) } : undefined);
        return;
      }
      case 'permission':
      case 'permissionDone':
        loadOverview().then(() => current && current.onPermission && current.onPermission());
        return;
      default:
        if (current && current.onPush) current.onPush(msg);
    }
  });

  // Live durations ("2m 13s") tick without re-rendering anything else.
  setInterval(() => {
    for (const el of $$('[data-since]')) el.textContent = dur(Date.now() - Number(el.dataset.since));
  }, 1000);

  window.CS = { vscode, call, attempt, toast, icon, esc, md, $, $$, ago, clock, dur, money, fmtTokens, resetIn, meter, level, EFFORT_LABEL, effortTag, size, plural, stepName, OUTPUT_INFO, SCENARIO_INFO, scInfo, modelChoices, scenarioChip, sevCounts, agentColor, S, views, pipeRowHtml, pipeEditors, pipeDragging: () => Boolean(pipeDrag), go, patch, debounce, persist, statusBadge, miniSteps, sourceChip, outlineHtml, permissionCard, loadOverview, autosize, shake, refreshSoon, actions, changes, inputs,
    // Called by the last script to load (config.js) once every view is registered.
    boot: async () => {
      renderShell();
      const boot = await call('boot');
      go(boot.route || S.route || { name: 'home' });
    },
  };
})();
