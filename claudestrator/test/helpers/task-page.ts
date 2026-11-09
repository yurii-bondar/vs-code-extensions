// The task screen (media/task.ts), run here as the page runs it: the compiled script on a `window` of its own, with the
// shell (window.CS) reduced to what records what the screen draws and asks the host.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/** What the page asked, as plain data: its objects come from the page's own realm, with another `Object`. */
const sent = (calls: Calls): unknown => JSON.parse(JSON.stringify(calls.attempts));

interface Calls {
  attempts: [string, unknown][];
  persisted: number;
}

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EFFORT_LABEL: Record<string, string> = { '': 'Default effort', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const node = () => ({ innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {}, scrollIntoView() {}, querySelector: () => null, querySelectorAll: () => [] });

/** The task screen of a task in `screen`: the HTML each region got, and what its actions asked the host. */
/**
 * `screen` is what the host sends that the test sets; the rest is a task waiting at nothing. `elements`: what the
 * page's `$$` finds for a selector (checkboxes as the test ticks them).
 */
async function taskScreen(screen: Record<string, unknown>, ui: Record<string, unknown> = {}, elements: Record<string, unknown[]> = {}) {
  const regions: Record<string, string> = {};
  const calls: Calls = { attempts: [], persisted: 0 };
  const picks = [node(), node()];
  const d = {
    taskId: 'T-1', title: 'Risk thresholds', status: { key: 'waiting', tone: 'warn', label: 'Needs you', resumable: false }, live: null, error: null, stopReason: undefined,
    round: 1, maxRounds: 2, phase: 'finish', prs: {}, branch: 'feat/T-1-risk', repos: ['api'], cost: 1, createdAt: '', updatedAt: '', steps: [], events: [], files: [], comments: [], answers: [],
    permissions: [], canMessage: false, liveUsage: null, model: {}, effort: {}, instructions: [], openFindings: [], gitMode: 'branch', auto: false, scenario: 'deliver', source: null, result: null,
    ticket: '', pipelineEdit: null, flow: [], fix: null, taskDir: '/ws/.orch/tasks/T-1', ...screen,
  };
  const S = { route: { name: 'task', taskId: d.taskId }, overview: { defaults: null }, ui: { ...ui }, draft: {} };
  const views: Record<string, { enter(r: unknown): Promise<void>; actions: Record<string, (el: unknown) => unknown>; changes: Record<string, (el: unknown) => unknown> }> = {};
  const known: Record<string, unknown> = {
    S,
    views,
    esc,
    // Markdown as a paragraph of its text: what a test reads of it.
    md: (text: string) => `<p>${esc(text)}</p>`,
    EFFORT_LABEL,
    icon: (name: string) => `<i data-icon="${name}"></i>`,
    patch: (region: string, html: string) => ((regions[region] = html), true),
    call: async (method: string) => (method === 'task' ? d : []),
    attempt: async (method: string, params: unknown) => (calls.attempts.push([method, params]), null),
    persist: () => void calls.persisted++,
    $: (sel: string) => (sel === '#view' || sel === '#transcript' ? node() : null),
    $$: (sel: string) => (sel === '.fix-pick' ? picks : (elements[sel] ?? [])),
    // The CLI's model list has not come yet: the fallback aliases, as on a page that just opened.
    modelChoices: () => [['inherit', 'Default (checking…)'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']],
    statusBadge: () => '',
    SCENARIO_INFO: { deliver: { label: 'Deliver', icon: 'pr', hint: '' } },
    pipeEditors: {},
    pipeDragging: () => false,
  };
  // Every other helper of the shell draws nothing here: this test reads only what Fix in chat draws.
  const CS = new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : () => '') });
  const window = { CS, liveTexts: () => ({ take() {}, writing: () => undefined }), loadedEdge: () => ({ has: () => false }), stripJsonBlock: (s: string) => s, innerHeight: 0, scrollY: 0 };
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'task.js'), 'utf8');
  vm.runInNewContext(script, { window, document: { body: { scrollHeight: 0 } }, setTimeout, clearTimeout, console });
  await views.task!.enter({ name: 'task', taskId: d.taskId });
  return { regions, calls, view: views.task!, S, picks };
}

export type { Calls };
export { sent, taskScreen };
