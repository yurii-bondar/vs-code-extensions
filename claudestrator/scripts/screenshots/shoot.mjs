// The Marketplace screenshots, from the real dashboard and made-up data only.
//   npm run build && node scripts/screenshots/shoot.mjs             VS Code's: media/screenshots/*.png
//   npm run build && node scripts/screenshots/shoot.mjs jetbrains   JetBrains': ../jetbrains/claudestrator/marketplace/screenshots
//     (the IDE's dark theme, as the plugin's ThemeCss.kt hands it to the page, and its own menu item in the tips)
// It starts the preview harness itself, with a throwaway HOME: none of your agents, libraries, MCP servers, accounts or
// GitHub login can reach a screenshot. One real task runs through the fake agent (plan, work, a fix round, push), and
// what the fake agent writes ("do it", feature.txt) is shown as a real agent would write it. The chrome around it (the
// account, the tools, the limits, the workspace's name) is made up too.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../design-sync/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const JETBRAINS = process.argv[2] === 'jetbrains';
const OUT = JETBRAINS ? path.resolve(ROOT, '..', 'jetbrains', 'claudestrator', 'marketplace', 'screenshots') : path.join(ROOT, 'media', 'screenshots');
const PORT = 4781;
const URL_ = `http://127.0.0.1:${PORT}/`;
const W = 1200, H = 750, SCALE = 2;

const TASK = 'Add input validation to the signup form: email format, a password of 12+ characters, errors shown inline';

// ---------- the preview, with nothing of yours ----------

function startPreview() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cs-shots-home-'));
  const proc = spawn(process.execPath, [path.join(ROOT, 'dist', 'test', 'harness', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, PREVIEW_SETUP: '1', PREVIEW_DELAY: '1400', PREVIEW_PORT: String(PORT) },
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

/** The IDE's New UI dark theme as ThemeCss.kt turns it into the page's variables (its colors, Inter, JetBrains Mono). */
const IDE_THEME = `(() => {
  const v = {
    '--vscode-font-family': 'Inter, -apple-system, BlinkMacSystemFont, sans-serif', '--vscode-font-size': '13px', '--vscode-editor-font-family': '"JetBrains Mono", Menlo, monospace',
    '--vscode-foreground': '#dfe1e5', '--vscode-descriptionForeground': '#868a91', '--vscode-editor-background': '#1e1f22', '--vscode-sideBar-background': '#2b2d30',
    '--vscode-editorWidget-background': '#27282b', '--vscode-panel-border': '#393b40', '--vscode-contrastBorder': 'transparent', '--vscode-focusBorder': '#3574f0',
    '--vscode-list-hoverBackground': '#2e3034', '--vscode-textLink-foreground': '#548af7', '--vscode-textCodeBlock-background': '#2e3034',
    '--vscode-button-background': '#3574f0', '--vscode-button-foreground': '#ffffff', '--vscode-button-hoverBackground': '#4d85f2',
    '--vscode-button-secondaryBackground': '#2b2d30', '--vscode-button-secondaryForeground': '#dfe1e5', '--vscode-button-secondaryHoverBackground': '#3e4044',
    '--vscode-input-background': '#1e1f22', '--vscode-input-foreground': '#dfe1e5', '--vscode-input-border': '#4e5157',
    '--vscode-menu-background': '#2b2d30', '--vscode-menu-foreground': '#dfe1e5', '--vscode-menu-selectionBackground': '#2e436e', '--vscode-menu-selectionForeground': '#ffffff',
    '--vscode-notifications-background': '#2b2d30', '--vscode-notifications-foreground': '#dfe1e5',
    '--vscode-testing-iconPassed': '#73c991', '--vscode-editorWarning-foreground': '#cca700', '--vscode-errorForeground': '#f48771', '--vscode-charts-blue': '#3794ff',
    '--vscode-charts-red': '#f14c4c', '--vscode-charts-green': '#89d185', '--vscode-charts-orange': '#d18616', '--vscode-charts-purple': '#b180d7', '--vscode-charts-yellow': '#cca700',
  };
  const s = document.createElement('style');
  s.textContent = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=block');" + ':root{color-scheme:dark;' + Object.entries(v).map(([k, x]) => k + ':' + x).join(';') + '}';
  document.head.appendChild(s);
  document.body.className = 'vscode-dark';
  return document.fonts.ready.then(() => true);
})()`;

/** The overview and health as a demo workspace would have them, and a few more tasks in the tree and the list. */
const DEMO = `(() => {
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
const WORDING = `(() => {
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
    ...(${JSON.stringify(JETBRAINS)} ? [[/Tip: select text in an editor and run “Claudestrator: Start a Task from Selection”\\./, 'Tip: select text in an editor, right-click it and choose “Start a Claudestrator Task from Selection”.']] : []),
    // The preview's throwaway folders, wherever a path shows them: as a checkout of the demo workspace.
    [/(?:\\/private)?\\/var\\/folders\\/[^\\s/]+\\/[^\\s/]+\\/T\\/cs-preview-[\\w-]+/g, '/Users/alex/code/acme-shop'],
    [/[\\w]+\\/T\\/cs-preview-[\\w-]+/g, 'code/acme-shop'],
    [/cs-preview-[\\w-]+/g, 'acme-shop'],
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

const until = async (b, expr, ms = 120000, every = 500) => {
  for (let t = 0; t < ms; t += every) {
    if (await b.eval(expr)) return true;
    await b.sleep(every);
  }
  throw new Error(`timed out waiting for: ${expr.slice(0, 120)}`);
};
const card = (b) => b.eval(`(async () => { await window.CS.loadOverview(); return window.CS.S.overview.tasks.find((t) => t.title.startsWith(${JSON.stringify(TASK.slice(0, 30))})) || null; })()`);

async function shot(b, name) {
  await b.eval(WORDING);
  await b.sleep(150);
  await b.eval('window.scrollTo(0, 0); true');
  await b.shot(path.join(OUT, `${name}.png`), { viewport: true });
  console.log(path.relative(path.resolve(ROOT, '..'), path.join(OUT, `${name}.png`)));
}

async function main() {
  const preview = await startPreview();
  const b = await launch({ port: 9334, profile: mkdtempSync(path.join(os.tmpdir(), 'cs-shots-chrome-')), width: W, height: H, scale: SCALE });
  try {
    await b.goto(URL_);
    await b.eval('sessionStorage.clear()');
    await b.goto(URL_);
    await b.eval(DEMO);
    if (JETBRAINS) await b.eval(IDE_THEME);
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

    // 10: the epic being written in the composer.
    await b.eval(`(() => { const S = window.CS.S; S.draft.text = ''; S.draft.group = ''; S.draft.instructions = []; S.ui.extraEdit = { kind: 'group', id: ${JSON.stringify(ids.group)}, type: 'epic', label: 'Checkout revamp', jira: 'SHOP-120', text: 'All signup and checkout endpoints live under /v2; keep the /orders responses as they are.', defaults: [${JSON.stringify(ids.inst)}], baseBranch: '' }; window.CS.persist(); window.CS.go({ name: 'home' }); return true; })()`);
    await until(b, `!!document.querySelector('[data-region="extra-editor"] input, .extra-editor input')`, 15000).catch(() => undefined);
    await b.sleep(1200);
    await shot(b, '10-groups');

    // 01: the task in plain words, in its epic, with the instruction the epic ticks.
    await b.eval(`(() => { const S = window.CS.S; S.ui.extraEdit = null; S.draft.text = ${JSON.stringify(TASK)}; S.draft.group = ${JSON.stringify(ids.group)}; S.draft.instructions = [${JSON.stringify(ids.inst)}]; window.CS.persist(); window.CS.go({ name: 'home' }); return true; })()`);
    await b.sleep(1800);
    await shot(b, '01-new-task');

    // The task runs: up to its plan.
    await b.eval('window.CS.views.home.start()');
    await until(b, `(async () => { await window.CS.loadOverview(); const t = window.CS.S.overview.tasks.find((x) => x.title.startsWith(${JSON.stringify(TASK.slice(0, 30))})); return t && t.checkpoint && t.checkpoint.id === 'approve-plan'; })()`, 180000, 1000);
    const id = (await card(b)).taskId;
    await b.eval(`window.CS.go({ name: 'task', taskId: ${JSON.stringify(id)} })`);
    await until(b, `!!document.querySelector('.checkpoint')`);
    await b.sleep(1500);
    await shot(b, '02-plan-approval');

    // 03: approved; the developers at work.
    await b.eval(`[...document.querySelectorAll('.checkpoint button')].find((x) => /Approve plan/.test(x.textContent)).click()`);
    await until(b, `(async () => { await window.CS.loadOverview(); const t = window.CS.S.overview.tasks.find((x) => x.taskId === ${JSON.stringify(id)}); return t && t.status.group === 'running' && t.live && /developer/.test(t.live.text || '') && t.round === 1; })()`, 180000, 700);
    await b.sleep(3500);
    await shot(b, '03-running');

    // 04: the reviewer's blocker sends the developer back: a fix round.
    await until(b, `(async () => { await window.CS.loadOverview(); const t = window.CS.S.overview.tasks.find((x) => x.taskId === ${JSON.stringify(id)}); return t && t.round >= 2 && t.status.group === 'running'; })()`, 300000, 700);
    await b.sleep(2500);
    await shot(b, '04-fix-round');

    // 05: committed; the push and the draft PRs wait for you.
    await until(b, `(async () => { await window.CS.loadOverview(); const t = window.CS.S.overview.tasks.find((x) => x.taskId === ${JSON.stringify(id)}); return t && t.checkpoint && t.checkpoint.id === 'confirm-push'; })()`, 300000, 1000);
    await b.eval(`window.CS.go({ name: 'task', taskId: ${JSON.stringify(id)} })`);
    await until(b, `!!document.querySelector('.checkpoint')`);
    await b.sleep(1500);
    await shot(b, '05-confirm-push');

    // 06: every task, by what needs you; 07-09: the setup.
    await b.eval(`window.CS.go({ name: 'home' })`);
    await b.sleep(1800);
    await b.eval(`(() => { const S = window.CS.S; S.draft.text = ''; S.draft.group = ''; S.draft.instructions = []; window.CS.persist(); window.CS.go({ name: 'home' }); return true; })()`);
    await b.sleep(1800);
    await shot(b, '06-tasks');
    for (const [name, route] of [['07-agents', 'agents'], ['08-scenarios', 'scenarios'], ['09-repos', 'repos']]) {
      await b.eval(`window.CS.go({ name: '${route}' })`);
      await b.sleep(2000);
      await shot(b, name);
    }
  } finally {
    b.close();
    preview.kill();
  }
}

await main();
