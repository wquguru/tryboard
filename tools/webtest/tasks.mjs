// Task timeline parity (C-04): web task switches (s3-dual / hello / s3-lvgl) = CLI --trace-tasks up to the pause; Tasks tab lanes; mobile.
// Usage: node tools/webtest/tasks.mjs (after tools/build_web.sh); output in Reviews/web/tasks-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const CLI = path.join(root, 'core/target/release/tryboard');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!f.startsWith(dist) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[tasks] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
const us = (c) => {
  const ns = (BigInt(c) * 2_000_000_000n + BigInt(CPU_HZ)) / (2n * BigInt(CPU_HZ));
  return `${ns / 1000n}.${(ns % 1000n).toString().padStart(3, '0')}`;
};

async function one(example, want, { ready = 'TRYBOARD_OK', args = [] } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${example}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${example}: ${m.text()}`); });
  await page.goto(`${base}/app?work=blank&example=${example}&debug=1#bench`, { waitUntil: 'load' });
  const ok = await waitFor(page, (r) => document.getElementById('console')?.textContent.includes(r), ready, 40000);
  await waitFor(page, () => globalThis.__tbApp?.store.get().simSeconds > 1.2, null, 30000);
  const web = await page.evaluate(async () => {
    const s = globalThis.__tbApp.session;
    s.sim.pause();
    await new Promise((r) => setTimeout(r, 300));
    await s.snapshot();
    await new Promise((r) => setTimeout(r, 100));
    const t = s.tasks;
    return { now: t.now, text: t.text(), chip: t.chip, cores: t.cores, names: t.tasks.map((x) => x.name), json: t.exportJson(), dropped: t.coreDropped + t.trimmed };
  });
  fs.writeFileSync(path.join(outDir, `tasks-${example}-web.txt`), web.text);
  fs.writeFileSync(path.join(outDir, `tasks-${example}-web.json`), web.json);
  let parsed = null;
  try { parsed = JSON.parse(web.json); } catch { /* judged as a failure below */ }
  report(`${example}: web reaches ${ready}, task store has switches, exported JSON is valid`, ok && !!parsed && web.text.length > 0 && web.dropped === 0, `${web.chip} ${web.cores} cores, tasks ${web.names.join('/')}, paused at ${(web.now / CPU_HZ).toFixed(4)} s`);
  // Tasks tab: the lanes are drawn
  await page.click('[data-dock="tasks"]');
  await waitFor(page, () => Number(document.getElementById('tasksPane')?.dataset.switches) > 0, null, 5000);
  const pane = await page.evaluate(() => ({
    cores: [...document.querySelectorAll('#tasksPane section[data-core]')].map((s) => [...s.querySelectorAll('[data-task]')].map((r) => r.dataset.task)),
    usage: [...document.querySelectorAll('#tasksUsage li')].map((l) => l.textContent),
    cred: document.getElementById('tasksCred')?.textContent ?? '',
  }));
  const lanesOk = want(pane.cores);
  report(`${example}: Tasks tab has a lane per core`, lanesOk && pane.cred.includes('Behaviour model'), JSON.stringify(pane.cores) + ' usage ' + pane.usage.join(' '));
  await page.screenshot({ path: path.join(outDir, `tasks-${example}.png`) });

  // CLI: same firmware, run up to the moment the web paused
  const out = path.join(outDir, `tasks-${example}-cli.json`);
  const fw = path.join(root, 'firmware/build', example, 'flash.bin');
  const p = spawnSync(CLI, ['run', fw, '--seconds', String(web.now / CPU_HZ), '--trace-tasks', out, ...args], { maxBuffer: 64 << 20 });
  const cli = JSON.parse(fs.readFileSync(out, 'utf8')).traceEvents.filter((e) => e.ph === 'X' && e.pid === 1);
  // Segments starting before the pause: same core, task name, start; segments ended on both sides also share the end state
  // Task names may contain spaces ("Tmr Svc"): first field is the core, last three start / end / state, the rest is the name
  const wl = web.text.split('\n').filter(Boolean).map((l) => l.split(' ')).map((f) => ({ c: +f[0], n: f.slice(1, -3).join(' '), t0: us(+f.at(-3)), t1: +f.at(-2), st: f.at(-1) }));
  // Take ts from the raw JSON (parsing to float and reformatting changes rounding on .5)
  const raw = [...fs.readFileSync(out, 'utf8').matchAll(/"ph":"X","pid":1,.*?"ts":([0-9.]+)/g)].map((m) => m[1]);
  const cl = cli.map((e, i) => ({ c: e.tid, n: e.name, t0: raw[i], end: e.ts + e.dur, st: e.args.out }));
  const endUs = (web.now * 1e6) / CPU_HZ;
  const cut = cl.filter((x) => Number(x.t0) < endUs);
  let diff = -1;
  for (let i = 0; i < Math.max(wl.length, cut.length); i++) {
    const a = wl[i];
    const b = cut[i];
    const closed = a && b && (a.t1 * 1e6) / CPU_HZ < endUs - 1 && b.end < endUs - 1;
    if (!a || !b || a.c !== b.c || a.n !== b.n || a.t0 !== b.t0 || (closed && a.st !== b.st)) { diff = i; break; }
  }
  report(`${example}: web switch sequence = CLI --trace-tasks (core, task name, start cycle, end state)`, p.status === 0 && diff < 0, diff < 0 ? `${wl.length} segments match` : `segment ${diff + 1} differs: web ${JSON.stringify(wl[diff])} / CLI ${JSON.stringify(cut[diff])}`);
  await page.close();
}

await one('s3-dual', (cores) => cores.length === 2 && cores[0].includes('w0') && !cores[0].includes('w1') && cores[1].includes('w1') && !cores[1].includes('w0') && cores[0].includes('IDLE0') && cores[1].includes('IDLE1'));
await one('hello', (cores) => cores.length === 1 && cores[0].includes('main') && cores[0].includes('IDLE'));
// Fully loaded LVGL round screen: thousands of switches (esp_timer / taskLVGL / Tmr Svc); SPI DMA interrupt timing must match too
await one('s3-lvgl', (cores) => cores.length === 2 && cores.flat().includes('taskLVGL') && cores.flat().includes('esp_timer'), { ready: 'FPS', args: ['--spi', 'gc9a01'] });

// Phone 390×844: the drawer reaches Tasks, no horizontal page scroll
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push(`phone: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`phone: ${m.text()}`); });
  await page.goto(`${base}/app?work=blank&example=s3-dual&debug=1#bench`, { waitUntil: 'load' });
  await waitFor(page, () => document.getElementById('console')?.textContent.includes('TRYBOARD_OK'), null, 40000);
  await page.click('#sheetPeek');
  await waitFor(page, () => !!document.querySelector('[data-dock="tasks"]'), null, 5000);
  await page.click('[data-dock="tasks"]');
  const ph = await waitFor(page, () => Number(document.getElementById('tasksPane')?.dataset.switches) > 0, null, 5000);
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.getElementById('tasksPane').scrollWidth]);
  await page.screenshot({ path: path.join(outDir, 'tasks-phone.png') });
  report('phone 390×844: drawer switches to Tasks, no horizontal scroll', ph && sw[0] <= 390 && sw[1] <= 390, `scrollWidth page ${sw[0]} / pane ${sw[1]}`);
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[tasks] page errors:\n  ' + errors.join('\n  '));
console.log(`[tasks] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
