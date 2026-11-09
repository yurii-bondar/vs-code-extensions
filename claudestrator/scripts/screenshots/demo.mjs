// What the Marketplace screenshots and the demo GIF share: the preview harness with a throwaway HOME, the made-up
// surroundings of the demo workspace, and what the fake agent writes, as a real agent would write it.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TASK = 'Add input validation to the signup form: email format, a password of 12+ characters, errors shown inline';

// ---------- the preview, with nothing of yours ----------

/** The preview harness on `port`, its fake agent waiting `delay` ms per tool call. */
export function startPreview({ port, delay = 1400 }) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cs-shots-home-'));
  const proc = spawn(process.execPath, [path.join(ROOT, 'dist', 'test', 'harness', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, PREVIEW_SETUP: '1', PREVIEW_DELAY: String(delay), PREVIEW_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    proc.on('exit', (code) => reject(new Error(`the preview exited (${code})`)));
    proc.stdout.on('data', (d) => {
      if (String(d).includes('Claudestrator preview:')) resolve(proc);
    });
  });
}

// ---------- in the page: made-up surroundings ----------

/** The overview and health as a demo workspace would have them, and a few more tasks in the tree and the list. */
export const DEMO = `(() => {
  const now = Date.now(), sec = Math.round(now / 1000);
  const iso = (m) => new Date(now - m * 60000).toISOString();
  const account = { loggedIn: true, plan: 'max', dir: '/Users/alex/.claude', shownDir: '~/.claude', label: 'Default', email: 'alex.demo@example.com', source: 'default', sourceText: 'the default ~/.claude' };
  const health = (h) => ({ ...h, checking: undefined, checkedAt: iso(1), claude: { ok: true, version: '2.1.0 (Claude Code)', path: '/usr/local/bin/claude', error: undefined }, git: { ok: true, version: '2.47.1' }, gh: { ok: true, version: '2.63.0', account: 'alex-demo', error: undefined, installed: true }, account, atlassian: true, atlassianMcp: 'Atlassian' });
  const st = { done: { key: 'done', label: 'PRs opened', tone: 'ok', group: 'done' }, ready: { key: 'done', label: 'Ready', tone: 'ok', group: 'done' }, stopped: { key: 'stopped', label: 'Stopped', tone: 'muted', group: 'stopped' }, push: { key: 'waiting', label: 'Confirm push', tone: 'warn', group: 'attention' } };
  const card = (taskId, title, s, group, m, extra = {}) => ({ taskId, title, source: null, scenario: 'deliver', status: st[s], checkpoint: s === 'push' ? { id: 'confirm-push', title: 'Confirm push', hint: 'The review passed. Look at the diff, then push and open the draft PRs.' } : null, live: null, error: null, stopReason: undefined, round: 1, maxRounds: 2, phase: '', outcome: undefined, prs: s === 'done' ? { api: 'https://github.com/acme/api/pull/412' } : {}, branch: null, repos: ['api', 'web'], cost: 0.42, createdAt: iso(m + 40), updatedAt: iso(m), progress: { done: s === 'done' ? 8 : 4, total: 8 }, mini: [], ...(group ? { group } : {}), ...extra });
  window.__demoTasks = (groupOf) => {
    const epic = groupOf('epic'), story = { id: 'demo-story', type: 'story', label: 'Guest checkout', jira: 'SHOP-131' }, docs = { id: 'demo-docs', type: 'group', label: 'Docs' };
    return [
      card('T-20261104-0930', 'Remember the shipping address for returning customers', 'push', story, 18),
      card('T-20261104-0812', 'Guest checkout: skip the account step', 'done', story, 95),
      card('T-20261104-0705', 'Show the order total with taxes before payment', 'done', epic, 160),
      card('T-20261103-1640', 'Apple Pay and Google Pay on the payment step', 'done', epic, 1100),
      card('T-20261103-1015', 'Readiness of SHOP-125 Promo codes', 'ready', epic, 1500, { scenario: 'readiness', scenarioLabel: 'Check readiness', result: { kind: 'readiness', verdict: 'ready', met: 4, total: 4 } }),
      card('T-20261103-0920', 'Document the /v2/orders endpoints', 'stopped', docs, 1700),
      card('T-20261102-1500', 'Fix: the orders list shows times in UTC instead of the user\\'s time zone', 'done', null, 2900),
    ];
  };
  const order = ['attention', 'running', 'stopped', 'done'];
  window.addEventListener('message', (e) => {
    const m = e.data, d = m && m.data;
    if (!(m && m.type === 'res' && d && typeof d === 'object')) return;
    if (d.claude && d.git && d.gh) Object.assign(d, health(d));
    if (!(Array.isArray(d.tasks) && Array.isArray(d.sections))) return;
    d.rootName = 'acme-shop';
    d.account = account;
    d.accounts = [{ dir: '/Users/alex/.claude', label: 'Default', email: 'alex.demo@example.com', current: true, loggedIn: true }];
    d.limits = { fiveHour: { pct: 31, resetsAt: sec + 2 * 3600 + 29 * 60 }, sevenDay: { pct: 26, resetsAt: sec + 2 * 86400 + 21 * 3600 }, at: now - 60000, source: 'statusline' };
    d.mcp = { total: 3, connected: 3, problems: 0, installed: 0, checking: false };
    if (d.health && !d.health.checking) d.health = health(d.health);
    const real = d.tasks;
    const epicOf = () => (real.find((t) => t.group) || {}).group || { id: 'demo-epic', type: 'epic', label: 'Checkout revamp', jira: 'SHOP-120' };
    const tasks = [...real, ...window.__demoTasks(epicOf)];
    const groups = [];
    for (const t of tasks) if (t.group && !groups.some((g) => g.id === t.group.id)) groups.push(t.group);
    const kinds = ['epic', 'story', 'group'];
    groups.sort((a, b) => kinds.indexOf(a.type) - kinds.indexOf(b.type));
    const ids = (f) => tasks.filter(f).sort((a, b) => order.indexOf(a.status.group) - order.indexOf(b.status.group)).map((t) => t.taskId);
    d.tasks = tasks;
    d.sections = [...groups.map((g) => ({ key: g.type + ':' + g.id, kind: g.type, label: g.label, ...(g.jira ? { jira: g.jira } : {}), taskIds: ids((t) => t.group && t.group.id === g.id) })), { key: 'ungrouped', kind: 'ungrouped', label: 'Ungrouped', taskIds: ids((t) => !t.group) }].filter((s) => s.taskIds.length);
  }, true);
  return true;
})()`;

/**
 * What the fake agent writes, as a real one would: run on the page's text right before each shot. Lists alternate
 * between the plan's repos (api, then web).
 */
export const WORDING = `(() => {
  const swap = [
    [/^Add the feature to every repo\\.$/, 'Validate the signup form in the API and in the web app: email format, a password of at least 12 characters, and an error shown inline under each field.'],
    [/feature\\.test\\.txt/g, 'test/signup.test.ts'],
    [/feature\\.txt/g, 'src/signup/validate.ts'],
    [/add-feature/g, 'signup-validation'],
    [/^add the feature$/i, 'Add signup validation'],
    [/^missing edge case$/, 'An empty password passes the length check'],
    [/^edge case$/, 'an empty password is not rejected: the length check runs after trim()'],
    [/^ok$/, 'Validation is complete on both sides; the 422 body matches what the form reads.'],
    [/^nit$/, 'rename err to error in SignupForm.vue'],
    [/"sneaky"/g, '"wip"'],
    [/outside\\.txt/g, 'shared/config.ts'],
    [/Changed src\\/signup\\/validate\\.ts\\./g, 'Added validateSignup() with the email and password rules, and the 422 answer with one error per field.'],
    [/Added test\\/signup\\.test\\.ts in 2 repo\\(s\\)\\./g, 'Covered the rules in both repos: 9 tests, all passing.'],
    [/^Read it\\.$/, 'Read the ticket.'],
    [/dev@example\\.com/g, 'alex.demo@example.com'],
    [/^flaky$/, 'unit tests'],
    // The preview's throwaway folders, wherever a path shows them: as a checkout of the demo workspace.
    [/(?:\\/private)?\\/var\\/folders\\/[^\\s/]+\\/[^\\s/]+\\/T\\/cs-preview-[\\w-]+/g, '/Users/alex/code/acme-shop'],
    [/[\\w]+\\/T\\/cs-preview-[\\w-]+/g, 'code/acme-shop'],
    [/cs-preview-[\\w-]+/g, 'acme-shop'],
    // What is left of a temp folder's path once its name is replaced.
    [/(^|\\s)T\\/acme-shop/g, '$1code/acme-shop'],
    [/^Needs a fix\\.$/, 'An empty password passes the length check: one blocker for the developer.'],
    [/^Looks good\\.$/, 'The validation rules and the 422 body match the plan.'],
  ];
  const steps = ['add a validateSignup schema and answer 422 with one error per field', 'show those errors inline and keep Submit disabled until the form is valid'];
  let step = 0;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    let v = n.nodeValue;
    if (/^\\s*do it\\s*$/.test(v)) { n.nodeValue = steps[step++ % 2]; continue; }
    for (const [re, to] of swap) v = v.replace(re, to);
    if (v !== n.nodeValue) n.nodeValue = v;
  }
  // The tips and toasts of a live session are not part of the picture.
  for (const t of document.querySelectorAll('#toasts > *')) t.remove();
  if (document.activeElement) document.activeElement.blur();
  return true;
})()`;

// ---------- driving it ----------

export const until = async (b, expr, ms = 120000, every = 500) => {
  for (let t = 0; t < ms; t += every) {
    if (await b.eval(expr)) return true;
    await b.sleep(every);
  }
  throw new Error(`timed out waiting for: ${expr.slice(0, 120)}`);
};
/** The task's steps as its screen has them: two reviewers with status running mean the Parallel is at work. */
export const reviewersAtOnce = (id) => `(async () => { const d = await window.CS.call('task', { taskId: ${JSON.stringify(id)} }); return d.steps.filter((s) => s.status === 'running' && /reviewer/.test(s.agent || '')).length >= 2; })()`;
export const card = (b) => b.eval(`(async () => { await window.CS.loadOverview(); return window.CS.S.overview.tasks.find((t) => t.title.startsWith(${JSON.stringify(TASK.slice(0, 30))})) || null; })()`);


/**
 * Opens the demo workspace at `url`: its made-up surroundings, an epic with an instruction (returned as `{ inst, group }`),
 * and Deliver's second reviewer on, so the review runs as two reviewers at once.
 */
export async function openDemo(b, url) {
  await b.goto(url);
  await b.eval('sessionStorage.clear()');
  await b.goto(url);
  await b.eval(DEMO);
  await until(b, '!!(window.CS && window.CS.S.overview)');
  // The Docs group folded, so the rail's last items stay in view.
  await b.eval(`window.CS.S.ui.treeOpen = { 'group:demo-docs': false }; window.CS.persist(); true`);

  // An instruction and the epic it comes with, as the composer's menus offer them.
  const ids = await b.eval(`(async () => {
    const inst = await window.CS.call('saveInstruction', { label: 'No new dependencies', text: 'Do not add packages; use what the repos already depend on.' });
    const group = await window.CS.call('saveGroup', { type: 'epic', label: 'Checkout revamp', jira: 'SHOP-120', instructions: 'All signup and checkout endpoints live under /v2; keep the /orders responses as they are.', defaultInstructions: [inst.id] });
    return { inst: inst.id, group: group.id };
  })()`);
  await b.sleep(800);
  // Deliver's second reviewer on: it reviews at the same time as the reviewer.
    await b.eval(`window.CS.call('updateAgent', { name: 'appsec-reviewer', patch: { enabled: true } })`);
    await b.sleep(800);
  return ids;
}
