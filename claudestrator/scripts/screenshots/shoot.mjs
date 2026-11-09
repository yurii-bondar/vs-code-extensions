// The Marketplace screenshots (media/screenshots/*.png), from the real dashboard and made-up data only.
//   npm run build && node scripts/screenshots/shoot.mjs
// It starts the preview harness itself, with a throwaway HOME: none of your agents, libraries, MCP servers, accounts or
// GitHub login can reach a screenshot. One real task runs through the fake agent (plan, work, both reviewers at once, a
// fix round, push), and what the fake agent writes ("do it", feature.txt) is shown as a real agent would write it. The
// chrome around it (the account, the tools, the limits, the workspace's name) is made up too. The JetBrains plugin's
// Marketplace folder, when it is there, gets the same pictures.
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../design-sync/cdp.mjs';
import { ROOT, TASK, WORDING, card, openDemo, reviewersAtOnce, startPreview, until } from './demo.mjs';

const OUT = path.join(ROOT, 'media', 'screenshots');
const JETBRAINS_OUT = path.resolve(ROOT, '..', 'jetbrains', 'claudestrator', 'marketplace', 'screenshots');
const PORT = 4781;
const URL_ = `http://127.0.0.1:${PORT}/`;
const W = 1200, H = 750, SCALE = 2;

/** `focus`: an element, by a script that finds it, to scroll to the middle of the view first (inside its pane). */
async function shot(b, name, focus) {
  await b.eval(WORDING);
  await b.sleep(150);
  await b.eval('window.scrollTo(0, 0); true');
  if (focus) {
    await b.eval(`(() => { const el = ${focus}; if (el) el.scrollIntoView({ block: 'center' }); return true; })()`);
    await b.sleep(300);
  }
  await b.shot(path.join(OUT, `${name}.png`), { viewport: true });
  console.log(`media/screenshots/${name}.png`);
}

async function main() {
  const preview = await startPreview({ port: PORT });
  const b = await launch({ port: 9334, profile: mkdtempSync(path.join(os.tmpdir(), 'cs-shots-chrome-')), width: W, height: H, scale: SCALE });
  try {
    const ids = await openDemo(b, URL_);

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

    // 11: the reviewer and the appsec reviewer at work at the same time.
    await until(b, reviewersAtOnce(id), 300000, 300);
    await b.sleep(900);
    await shot(b, '11-parallel-review');

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

    // 12: the same task as a flow: the loop with both reviewers in it, and where the task waits now.
    await b.eval(`(() => { window.CS.S.ui.taskTab = 'flow'; window.CS.persist(); window.CS.go({ name: 'task', taskId: ${JSON.stringify(id)} }); return true; })()`);
    await until(b, `!!document.querySelector('[data-region="tab-flow"] *')`, 15000);
    await b.sleep(1500);
    // The pane scrolled to the loop, where the two reviewers sit side by side.
    await shot(b, '12-task-flow', `[...document.querySelectorAll('[data-region="tab-flow"] *')].filter((e) => e.children.length === 0 && /appsec-reviewer/.test(e.textContent)).pop()`);
    await b.eval(`(() => { window.CS.S.ui.taskTab = 'output'; window.CS.persist(); return true; })()`);

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

    // 13: a scenario of your own as a diagram: a Loop with two reviewers at once, and a step's own instructions.
    const sc = await b.eval(`window.CS.call('saveScenario', { label: 'Ship with security review', description: 'Plan, then code and both reviews until they approve', agents: [
      { name: 'planner' },
      { name: 'developer', loop: { rounds: 3 } },
      { name: 'tester', loop: { rounds: 3 } },
      { name: 'reviewer', loop: { rounds: 3 }, parallel: 1 },
      { name: 'appsec-reviewer', loop: { rounds: 3 }, parallel: 1, approve: { text: 'Read both reviews before the PRs' }, instructions: 'Start with the signup and password-reset endpoints: rate limits, and errors that do not tell which emails exist.' },
    ] }).then((r) => r.id)`);
    await b.sleep(1200);
    await b.eval(`window.CS.go({ name: 'scenario-diagram', scenario: ${JSON.stringify(sc)} })`);
    await until(b, `!!document.querySelector('.dg-node[data-i="4"]')`, 15000);
    await b.sleep(800);
    await b.eval(`document.querySelector('.dg-node[data-i="4"]').click(); true`);
    await b.sleep(1200);
    await shot(b, '13-scenario-diagram', `document.querySelector('.dg-node[data-i="4"]')`);

    if (existsSync(JETBRAINS_OUT)) {
      for (const f of readdirSync(OUT).filter((x) => x.endsWith('.png'))) copyFileSync(path.join(OUT, f), path.join(JETBRAINS_OUT, f));
      console.log(`copied to ${path.relative(ROOT, JETBRAINS_OUT)}`);
    }
  } finally {
    b.close();
    preview.kill();
  }
}

await main();
