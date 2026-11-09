// The README's demo GIF (media/screenshots/demo.gif): one task from plain words to the push you confirm, recorded from
// the real dashboard with made-up data only, as the screenshots are (demo.mjs).
//   npm run build && node scripts/screenshots/demo-gif.mjs
// Frames are taken while the fake agent works and held longer where you would look (the plan, both reviewers at work,
// the push). The GIF has one palette, and a frame keeps only the pixels that changed: the rest is transparent over the
// frame before it, which keeps a long recording small.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { launch } from '../design-sync/cdp.mjs';
import { ROOT, TASK, WORDING, card, openDemo, reviewersAtOnce, startPreview, until } from './demo.mjs';

// gifenc is CommonJS: its functions come from the default export.
const { GIFEncoder, applyPalette, quantize } = gifenc;
const OUT = path.join(ROOT, 'media', 'screenshots', 'demo.gif');
const PORT = 4782;
const W = 1200, H = 750;
/** How long a frame taken while the agents work stays on screen, and how often one is taken: about 5× real time. */
const TICK_MS = 160, EVERY_MS = 800;

const frames = [];
const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-gif-frames-'));

/** One frame of what the window shows now, on screen for `ms`. */
async function frame(b, ms) {
  await b.eval(WORDING);
  const file = path.join(dir, `${String(frames.length).padStart(4, '0')}.png`);
  await b.shot(file, { viewport: true });
  frames.push({ file, ms });
}

/** Frames every EVERY_MS until `expr` holds, each on screen for TICK_MS. */
async function record(b, expr, ms = 300000) {
  for (let t = 0; t < ms; t += EVERY_MS) {
    if (await b.eval(expr)) return;
    await frame(b, TICK_MS);
    await b.sleep(EVERY_MS);
  }
  throw new Error(`timed out waiting for: ${expr.slice(0, 120)}`);
}

const taskIs = (id, cond) => `(async () => { await window.CS.loadOverview(); const t = window.CS.S.overview.tasks.find((x) => x.taskId === ${JSON.stringify(id)}); return Boolean(t && (${cond})); })()`;

function encode(file) {
  const images = frames.map((f) => PNG.sync.read(readFileSync(f.file)).data);
  // One palette from a sample of the frames, and its last index for the pixels a frame leaves as they were.
  const step = Math.max(1, Math.floor(images.length / 12));
  const sample = images.filter((_, i) => i % step === 0);
  const joined = new Uint8Array(sample.reduce((n, d) => n + d.length, 0));
  sample.reduce((at, d) => (joined.set(d, at), at + d.length), 0);
  const palette = quantize(joined, 255);
  const clear = palette.length;
  const gif = GIFEncoder();
  let prev = null;
  images.forEach((data, i) => {
    const index = applyPalette(data, palette);
    const out = prev ? index.map((c, p) => (c === prev[p] ? clear : c)) : index;
    gif.writeFrame(out, W, H, { ...(i === 0 && { palette: [...palette, [0, 0, 0]] }), delay: frames[i].ms, transparent: i > 0, transparentIndex: clear, dispose: 1 });
    prev = index;
  });
  gif.finish();
  writeFileSync(file, gif.bytes());
}

async function main() {
  const preview = await startPreview({ port: PORT, delay: 900 });
  const b = await launch({ port: 9335, profile: mkdtempSync(path.join(os.tmpdir(), 'cs-gif-chrome-')), width: W, height: H, scale: 1 });
  try {
    const ids = await openDemo(b, `http://127.0.0.1:${PORT}/`);
    await b.eval(`(() => { const S = window.CS.S; S.draft.text = ''; S.draft.group = ${JSON.stringify(ids.group)}; S.draft.instructions = [${JSON.stringify(ids.inst)}]; window.CS.persist(); window.CS.go({ name: 'home' }); return true; })()`);
    await until(b, `!!document.getElementById('composer-text')`, 15000);
    await b.sleep(1200);
    await frame(b, 900);

    // The task typed in plain words.
    for (let n = 1; n <= 10; n++) {
      const text = TASK.slice(0, Math.round((TASK.length * n) / 10));
      await b.eval(`(() => { const el = document.getElementById('composer-text'); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await b.sleep(120);
      await frame(b, n === 10 ? 1800 : 110);
    }

    // The planner at work, then the plan that waits for you.
    await b.eval('window.CS.views.home.start()');
    await until(b, `(async () => { await window.CS.loadOverview(); return Boolean(window.CS.S.overview.tasks.find((x) => x.title.startsWith(${JSON.stringify(TASK.slice(0, 30))}))); })()`, 30000, 300);
    const id = (await card(b)).taskId;
    await b.eval(`window.CS.go({ name: 'task', taskId: ${JSON.stringify(id)} })`);
    await record(b, taskIs(id, "t.checkpoint && t.checkpoint.id === 'approve-plan'"));
    await until(b, `!!document.querySelector('.checkpoint')`);
    await b.sleep(1200);
    await frame(b, 3200);

    // Approved: the developers per repo, the tester, then both reviewers at once.
    await b.eval(`[...document.querySelectorAll('.checkpoint button')].find((x) => /Approve plan/.test(x.textContent)).click()`);
    await record(b, reviewersAtOnce(id));
    await b.sleep(400);
    await frame(b, 2600);

    // The blocker one of them found goes back to the developer: a fix round, a second review, the commit.
    await record(b, taskIs(id, "t.checkpoint && t.checkpoint.id === 'confirm-push'"));
    await until(b, `!!document.querySelector('.checkpoint')`);
    await b.sleep(1200);
    await frame(b, 3200);

    // The same task as a flow: the review loop with the two reviewers side by side.
    await b.eval(`(() => { window.CS.S.ui.taskTab = 'flow'; window.CS.persist(); window.CS.go({ name: 'task', taskId: ${JSON.stringify(id)} }); return true; })()`);
    await until(b, `!!document.querySelector('[data-region="tab-flow"] *')`, 15000);
    await b.sleep(1200);
    await b.eval(`(() => { const el = [...document.querySelectorAll('[data-region="tab-flow"] *')].filter((e) => e.children.length === 0 && /appsec-reviewer/.test(e.textContent)).pop(); if (el) el.scrollIntoView({ block: 'center' }); return true; })()`);
    await b.sleep(400);
    await frame(b, 3600);
  } finally {
    b.close();
    preview.kill();
  }
  encode(OUT);
  console.log(`media/screenshots/demo.gif: ${frames.length} frames, ${(readFileSync(OUT).length / 1048576).toFixed(1)} MB`);
}

await main();
