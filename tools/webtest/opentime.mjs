// First-open time of lazy dock panes and steps (R-12): click -> real content in the page, cold (right after boot) and
// after the idle prefetch; desktop and 4x CPU-throttled 390x844. Usage: node tools/webtest/opentime.mjs [dist] [--json out]
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const dist = path.resolve(args.find((a, i) => !a.startsWith('--') && !['--json', '--only'].includes(args[i - 1])) ?? path.join(root, 'web/dist'));
const LIMIT = 300;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.glb': 'model/gltf-binary' };
// Same static gzip host as perf.mjs, so chunk fetches cost what users pay
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  const ext = path.extname(f);
  const gz = ['.html', '.js', '.css', '.wasm', '.json', '.svg'].includes(ext);
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
  const s = fs.createReadStream(f);
  (gz ? s.pipe(zlib.createGzip({ level: 6 })) : s).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu'] });

async function waitFor(page, fn, arg = null, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

// kind dock: click [data-dock=id]; kind step: set location.hash. ready: selector of the real content; chunk: file prefix.
const ITEMS = [
  { id: 'code', kind: 'dock', ex: 'weather', ready: '#codeView', chunk: 'code' },
  { id: 'tasks', kind: 'dock', ex: 'weather', ready: '#tasksPane', chunk: 'tasks' },
  { id: 'analyzer', kind: 'dock', ex: 'weather', ready: '#analyzer:not([hidden])', mready: '#dock #analyzer.in-sheet:not([hidden])', chunk: 'analyzer' },
  { id: 'net', kind: 'dock', ex: 'c3-wifi-resilient', ready: '#netPane', chunk: 'netpane' },
  { id: 'usb', kind: 'dock', ex: 's3-usb-keyboard', ready: '#usbState', chunk: 'usbpane' },
  { id: 'ble', kind: 'dock', ex: 'c3-ble-hr', ready: '#bleAir', chunk: 'blepane' },
  // Steps run on the weather work with its checkpoints preset as passed (as levels.mjs does), so Assemble / Product open
  { id: 'shop', kind: 'step', work: 'weather', ready: '.shop-stage', chunk: 'shop' },
  { id: 'assemble', kind: 'step', work: 'weather', q: '&asm=svg', ready: '.asm-box [data-part]', chunk: 'assemble' },
  { id: 'product', kind: 'step', work: 'weather', ready: '#pBoot', chunk: 'product' },
];
const ALL_CHUNKS = ['analyzer', 'code', 'shop', 'assemble', 'product', 'tasks', 'usbpane', 'blepane', 'netpane'];

async function one(item, { mobile, warm }) {
  const page = await browser.newPage();
  // Beginner mode is on by default (H-01); these checks target the full bench
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
  await page.setViewport(mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
  // Cold: the pane / step chunk is held at the network until the click, so the idle prefetch cannot have warmed it
  const held = [];
  let hold = !warm;
  if (!warm) {
    await page.setRequestInterception(true);
    page.on('request', (req) => (hold && req.url().includes(`/assets/${item.chunk}-`) ? held.push(req) : req.continue()));
  }
  // The page calls this right after its click, so held chunks start arriving no earlier than a click-time fetch would
  await page.exposeFunction('__tbRelease', () => {
    hold = false;
    for (const req of held.splice(0)) req.continue().catch(() => null);
  });
  const url = item.work ? `${base}/app?work=${item.work}${item.q ?? ""}#bench` : `${base}/app?work=blank&example=${item.ex}#bench`;
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  if (item.work) {
    await page.evaluate((w) => {
      const c = {};
      for (const id of ['01', '02', '03', '04', '05', '06']) c[id] = { fp: 'test', at: 'preset' };
      localStorage.setItem(`tryboard-app-checks:${w}`, JSON.stringify(c));
    }, item.work);
    await page.reload({ waitUntil: 'load', timeout: 120000 });
  }
  const booted = await waitFor(page, () => (globalThis.__tbApp?.store.get().simSeconds ?? 0) > 0.2, null, 120000);
  // The phone dock shows its tabs once the peek sheet is opened
  if (mobile && item.kind === 'dock') await page.evaluate(() => document.getElementById('sheetPeek')?.click());
  if (item.kind === 'dock') await waitFor(page, (id) => !!document.querySelector(`[data-dock="${id}"]`), item.id, 60000);
  // Prefetched: wait until the idle queue has fetched every lazy chunk (capped), then a little more for evaluation
  if (warm) await waitFor(page, (cs) => cs.every((c) => performance.getEntriesByType('resource').some((e) => e.name.includes(`/assets/${c}-`))), ALL_CHUNKS, 30000);
  // Both modes let boot-time long tasks (first frame, shader warm-up) finish, so the time is the open, not the boot
  await sleep(1500);
  const sel = mobile && item.mready ? item.mready : item.ready;
  const r = await page.evaluate(
    async ({ id, kind, sel, chunk }) => {
      const had = performance.getEntriesByType('resource').some((e) => e.name.includes(`/assets/${chunk}-`));
      const t0 = performance.now();
      const tab = document.querySelector(`[data-dock="${id}"]`);
      if (kind === 'dock' && !tab) return { ms: null, prefetched: had, sawLoading: false };
      if (kind === 'dock') tab.click();
      else location.hash = id;
      void globalThis.__tbRelease();
      const done = () => !document.querySelector('.step-loading') && !document.querySelector('.pane-loading') && !!document.querySelector(sel);
      let sawLoading = false;
      while (performance.now() - t0 < 20000) {
        await new Promise((r) => requestAnimationFrame(() => r()));
        if (document.querySelector('.step-loading, .pane-loading')) sawLoading = true;
        if (done()) {
          // When the chunk response ended, relative to the click (negative = before it, i.e. prefetched)
          const e = performance.getEntriesByType('resource').find((x) => x.name.includes(`/assets/${chunk}-`));
          return { ms: Math.round(performance.now() - t0), prefetched: had, sawLoading, chunkEnd: e ? Math.round(e.responseEnd - t0) : null };
        }
      }
      const why = { loading: !!document.querySelector('.step-loading, .pane-loading'), step: globalThis.__tbApp?.store.get().step, hash: location.hash, ids: [...document.querySelectorAll('#layer [id], main [id]')].slice(0, 12).map((e) => e.id) };
      return { ms: -1, prefetched: had, sawLoading, why: JSON.stringify(why) };
    },
    { id: item.id, kind: item.kind, sel, chunk: item.chunk },
  );
  await page.close();
  return { id: item.id, mobile, warm, booted, ...r, ok: r.ms === null || (r.ms >= 0 && r.ms < LIMIT), errors: errors.length, firstError: errors[0] ?? '' };
}

const only = args.includes('--desktop') ? [false] : [false, true];
const rows = [];
for (const mobile of only)
  for (const warm of [false, true])
    for (const item of ITEMS.filter((i) => !args.includes('--only') || args[args.indexOf('--only') + 1].split(',').includes(i.id))) {
      const r = await one(item, { mobile, warm });
      rows.push(r);
      console.log(`[open] ${mobile ? 'mobile4x' : 'desktop '} ${warm ? 'prefetched' : 'cold      '} ${item.id.padEnd(9)} ${String(r.ms ?? 'n/a').padStart(5)} ms  chunk ${r.prefetched ? 'cached ' : 'fetched'} (end ${r.chunkEnd ?? '-'} ms)  ${r.ok ? 'PASS' : 'FAIL'}  errors ${r.errors}${r.why ? ' ' + r.why : ''}${r.firstError ? ' (' + r.firstError + ')' : ''}`);
    }
const fails = rows.filter((r) => !r.ok || r.errors);
console.log(`[open] ${rows.length - fails.length}/${rows.length} under ${LIMIT} ms without errors`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
await browser.close();
server.close();
process.exitCode = fails.length ? 1 : 0;
