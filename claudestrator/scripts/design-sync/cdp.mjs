// A minimal Chrome DevTools Protocol driver (no dependencies): a headless Chrome, JS evaluated in its page, screenshots.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

/** Chrome's binary: `CHROME`, else where it is installed on macOS, Linux or Windows. */
function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const known = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const found = known.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found: set CHROME to its binary');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, profile, width = 1440, height = 900, scale = 1 }) {
  const proc = spawn(chromePath(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let info;
  for (let i = 0; i < 50 && !info; i++) {
    await sleep(200);
    try {
      info = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      // not listening yet
    }
  }
  if (!info) throw new Error(`Chrome did not open its debugging port ${port}`);
  const page = info.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (!m.id || !pending.has(m.id)) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  const api = {
    send,
    sleep,
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(1500);
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
      return r.result.value;
    },
    /** A PNG of the page as it is now: the whole of it, or (`viewport`) what the window shows. */
    async shot(file, { viewport = false } = {}) {
      const h = viewport ? height : await api.eval('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)');
      // The clip is in page coordinates: the window's view starts where it is scrolled to.
      const y = viewport ? await api.eval('window.scrollY') : 0;
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !viewport, clip: { x: 0, y, width, height: Math.min(h, 4000), scale: 1 } });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    close() {
      try {
        ws.close();
      } catch {
        // closed already
      }
      proc.kill();
    },
  };
  return api;
}
