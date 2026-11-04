// Captures the dashboard's screens from the preview (`npm run preview`, http://127.0.0.1:4780) as JSON trees, in the
// Claudestrator palette, for builder.js to rebuild in Penpot. Writes out/<screen>--<theme>.json (+ .png to compare) and
// out/screens.json, the boards to build and where they go.
//   node scripts/design-sync/capture.mjs                 every screen of SCREENS
//   node scripts/design-sync/capture.mjs task,home Dark  those screens, in those themes
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { applyTheme } from './themes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
const PREVIEW = process.env.PREVIEW_URL || 'http://127.0.0.1:4780/';
const walker = readFileSync(path.join(here, 'walker.js'), 'utf8');

const D = 1540; // a desktop board's width and the gap after it
const P = 500; // an IDE panel's
/** The boards of the design file's Screens page: which screen, in which theme, under what name, where. */
const SCREENS = [
  { screen: 'home', theme: 'Dark', name: 'Desktop · Tasks', x: 0, y: 0 },
  { screen: 'task', theme: 'Dark', name: 'Desktop · Task · Plan approval', x: D, y: 0 },
  { screen: 'agents', theme: 'Dark', name: 'Desktop · Agents', x: 2 * D, y: 0 },
  { screen: 'scenarios', theme: 'Dark', name: 'Desktop · Scenarios', x: 3 * D, y: 0 },
  { screen: 'repos', theme: 'Dark', name: 'Desktop · Repos & checks', x: 4 * D, y: 0 },
  { screen: 'mcp', theme: 'Dark', name: 'Desktop · Integrations', x: 5 * D, y: 0 },
  { screen: 'settings', theme: 'Dark', name: 'Desktop · Settings', x: 6 * D, y: 0 },
  { screen: 'home', theme: 'Light', name: 'Desktop · Tasks · Light', x: 0, y: 2500 },
  { screen: 'task', theme: 'Light', name: 'Desktop · Task · Plan approval · Light', x: D, y: 2500 },
  { screen: 'task', theme: 'HC Dark', name: 'Desktop · Task · Plan approval · HC Dark', x: 2 * D, y: 2500 },
  { screen: 'panel-task', theme: 'Dark', name: 'IDE panel · Task · Plan approval', x: 0, y: 4000 },
  { screen: 'panel-menu', theme: 'Dark', name: 'IDE panel · Menu open', x: P, y: 4000 },
  { screen: 'panel-folded', theme: 'Dark', name: 'IDE panel · Menu · Tasks folded', x: 2 * P, y: 4000 },
  { screen: 'panel-task', theme: 'Light', name: 'IDE panel · Task · Plan approval · Light', x: 3 * P, y: 4000 },
  { screen: 'panel-task', theme: 'HC Light', name: 'IDE panel · Task · Plan approval · HC Light', x: 4 * P, y: 4000 },
];

/** The task the task screens show: started once from the composer; the preview's fake agent stops it at the plan. */
const TASK_TITLE = 'Add input validation to the signup form: email format, password of 12+ characters, inline errors';

// Sample tasks beside the real one: a tree with stories, an epic, a group, and finished tasks.
const FIX = `(() => {
  const now = Date.now(); const iso = (m) => new Date(now - m * 60000).toISOString();
  const st = { waiting: { key: 'waiting', label: 'Plan approval', tone: 'warn', group: 'attention' }, push: { key: 'waiting', label: 'Confirm push', tone: 'warn', group: 'attention' }, running: { key: 'running', label: 'Running', tone: 'accent', group: 'running' }, done: { key: 'done', label: 'PRs opened', tone: 'ok', group: 'done' }, ready: { key: 'done', label: 'Not ready', tone: 'warn', group: 'done' }, stopped: { key: 'stopped', label: 'Stopped', tone: 'muted', group: 'stopped' } };
  const g = { loc: { id: 'g1', type: 'story', label: '[LOCALIZATION] K8s Job', jira: 'CP-1182' }, pl: { id: 'g2', type: 'story', label: '[PLINKO] Provably Fair', jira: 'CP-1125' }, ep: { id: 'g3', type: 'epic', label: '[PLINKO] Launch', jira: 'CP-1100' }, docs: { id: 'g4', type: 'group', label: 'Docs' } };
  const card = (taskId, title, s, group, m) => ({ taskId, title, source: null, scenario: 'deliver', status: st[s], checkpoint: s === 'waiting' ? { id: 'approve-plan', title: 'Plan approval', hint: 'Read the plan. Approve it, or say what to change and the planner revises it.' } : s === 'push' ? { id: 'confirm-push', title: 'Confirm push', hint: 'The review passed. Look at the diff, then push and open the PRs.' } : null, live: s === 'running' ? { text: 'developer is working', since: now - 192000 } : null, error: null, stopReason: undefined, round: 1, maxRounds: 2, phase: '', outcome: undefined, prs: {}, branch: s === 'running' ? 'feat/CP-1184-sync-texts' : null, repos: [], cost: 0.31, createdAt: iso(m + 30), updatedAt: iso(m), progress: { done: 3, total: 8 }, mini: [], ...(group ? { group } : {}) });
  const fx = [
    card('T-20261104-0815', 'CP-1184 Синк текстів: en.json', 'running', g.loc, 3),
    card('T-20261104-0611', 'Cache tariff lookups in the pricing service', 'push', null, 25),
    card('T-20261104-0702', 'CP-1183 Синк: таблиці', 'done', g.loc, 40), card('T-20261104-0544', 'CP-1181 Keys cleanup', 'done', g.loc, 300),
    card('T-20261103-1120', 'CP-1125 Provably Fair', 'done', g.pl, 50), card('T-20261103-1012', 'CP-1125 readiness', 'ready', g.pl, 60), card('T-20261102-0930', 'CP-1126 Seeds', 'done', g.pl, 2000),
    card('T-20261101-1800', 'CP-1101 Launch checklist', 'done', g.ep, 3000),
    card('T-20261103-1500', 'Write the API guide', 'stopped', g.docs, 600),
    card('T-20261104-0401', 'Bump eslint', 'done', null, 100),
  ];
  const order = ['attention', 'running', 'stopped', 'done'];
  const sort = (l) => l.sort((a, b) => order.indexOf(a.status.group) - order.indexOf(b.status.group)).map((t) => t.taskId);
  window.addEventListener('message', (e) => {
    const d = e.data && e.data.data;
    if (!(e.data && e.data.type === 'res' && d && Array.isArray(d.tasks) && Array.isArray(d.sections))) return;
    const tasks = [...d.tasks.filter((t) => !fx.some((f) => f.taskId === t.taskId)), ...fx];
    const sec = (key, kind, gr) => ({ key, kind, label: gr ? gr.label : 'Ungrouped', ...(gr && gr.jira ? { jira: gr.jira } : {}), taskIds: sort(tasks.filter((t) => (gr ? t.group && t.group.id === gr.id : !t.group))) });
    d.tasks = tasks;
    d.sections = [sec('epic:g3', 'epic', g.ep), sec('story:g1', 'story', g.loc), sec('story:g2', 'story', g.pl), sec('group:g4', 'group', g.docs), sec('ungrouped', 'ungrouped', null)];
  }, true);
  return true;
})()`;
// No real address or workspace name in the design file.
const MASK = `(() => { const re = /[\\w.+-]+@[\\w-]+\\.[\\w.]+/g; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (re.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(re, 'you@example.com'); if (/^cs-preview-/.test(n.nodeValue)) n.nodeValue = 'crash-provider-gaming'; } return true; })()`;
const until = async (b, expr, ms = 20000) => {
  for (let t = 0; t < ms; t += 300) {
    if (await b.eval(expr)) return true;
    await b.sleep(300);
  }
  return false;
};
const ROUTES = { home: 'home', agents: 'agents', scenarios: 'scenarios', repos: 'repos', mcp: 'mcp', settings: 'settings' };
const TASK_SCREENS = new Set(['task', 'panel-task', 'panel-menu', 'panel-folded']);
const MENU_SCREENS = new Set(['panel-menu', 'panel-folded']);
const profile = path.join(os.tmpdir(), 'claudestrator-design-sync-chrome');

/** Starts the task the task screens show, unless the preview has it, and waits for its plan to be up for approval. */
async function ensureTask() {
  const b = await launch({ profile });
  try {
    await b.goto(PREVIEW);
    await b.eval('sessionStorage.clear()');
    await b.goto(PREVIEW);
    await until(b, '!!(window.CS && window.CS.S.overview)');
    const has = `window.CS.S.overview.tasks.some((t) => t.title.startsWith(${JSON.stringify(TASK_TITLE.slice(0, 20))}) && t.status.group === 'attention')`;
    if (await b.eval(has)) return;
    await b.eval(`(() => { const t = document.querySelector('#composer-text'); t.value = ${JSON.stringify(TASK_TITLE)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await b.sleep(600);
    await b.eval(`document.querySelector('[data-action="start"]').click()`);
    if (!(await until(b, `(window.CS.loadOverview(), ${has})`, 120000))) throw new Error('the sample task did not reach its plan approval; is the preview started with PREVIEW_SETUP=1?');
  } finally {
    b.close();
  }
}

async function capture({ screen, theme }) {
  const narrow = screen.startsWith('panel-');
  const width = narrow ? 400 : 1440, height = narrow ? 792 : 900;
  const b = await launch({ profile, width, height });
  try {
    await b.send('Network.enable');
    await b.send('Network.setCacheDisabled', { cacheDisabled: true });
    await b.goto(PREVIEW);
    await b.eval('sessionStorage.clear()');
    await b.goto(PREVIEW);
    await b.eval(FIX);
    await b.eval(applyTheme(theme));
    if (screen === 'panel-folded') await b.eval('window.CS.S.ui.tasksOpen = false; true');
    if (TASK_SCREENS.has(screen)) {
      await b.eval(`window.CS.go({ name: 'home' })`);
      await until(b, `!!document.querySelector('.task-card')`);
      const id = await b.eval(`(window.CS.S.overview.tasks.find((t) => t.title.startsWith(${JSON.stringify(TASK_TITLE.slice(0, 20))})) || {}).taskId`);
      await b.eval(`window.CS.go({ name: 'task', taskId: ${JSON.stringify(id)} })`);
      await until(b, `!!document.querySelector('[data-region="task-steps"] *')`);
      await b.sleep(1500);
      if (MENU_SCREENS.has(screen)) {
        await b.eval(`document.querySelector('.topbar [data-action="toggle-nav"]').click()`);
        await b.sleep(600);
      }
    } else {
      await b.eval(`window.CS.go({ name: ${JSON.stringify(ROUTES[screen])} })`);
      await b.sleep(2000);
    }
    await b.eval(applyTheme(theme));
    await b.sleep(400);
    await b.eval(MASK);
    await b.eval('document.activeElement && document.activeElement.blur(); true');
    // The whole page in the window, so the rail is as tall as the page; a menu open over the page stays a sheet as
    // tall as the window.
    const full = await b.eval('Math.max(document.documentElement.scrollHeight, innerHeight)');
    if (full > height && !MENU_SCREENS.has(screen)) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: full, deviceScaleFactor: 1, mobile: false });
      await b.sleep(500);
    }
    const json = await b.eval(walker);
    const file = `${screen}--${theme.replace(/ /g, '-')}.json`;
    writeFileSync(path.join(outDir, file), json);
    await b.shot(path.join(outDir, file.replace(/\.json$/, '.png')));
    console.log(`${file} ${Math.round(json.length / 1024)}KB`);
    return { file, ...(MENU_SCREENS.has(screen) && { h: height }) };
  } finally {
    b.close();
  }
}

const [screensArg, themesArg] = process.argv.slice(2);
const wanted = SCREENS.filter((s) => (!screensArg || screensArg.split(',').includes(s.screen)) && (!themesArg || themesArg.split(',').includes(s.theme)));
if (!wanted.length) throw new Error(`no screen matches; screens: ${[...new Set(SCREENS.map((s) => s.screen))].join(', ')}`);
mkdirSync(outDir, { recursive: true });
if (wanted.some((s) => TASK_SCREENS.has(s.screen))) await ensureTask();
const boards = [];
for (const s of wanted) boards.push({ ...(await capture(s)), name: s.name, x: s.x, y: s.y });
// The stamp tells builder.js which boards on the page come from this capture, and so are built already.
writeFileSync(path.join(outDir, 'screens.json'), JSON.stringify({ stamp: new Date().toISOString(), boards }, null, 1));
console.log(`out/screens.json: ${boards.length} boards`);
