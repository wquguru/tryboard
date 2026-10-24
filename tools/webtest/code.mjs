// Dock Code tab (P2-15): weather main.c with line numbers / highlight / file switch, lazy src.json, uploaded .bin -> No source, mobile.
// Usage: node tools/webtest/code.mjs [dist dir, default web/dist]; screenshots in Reviews/web/code-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.resolve(process.argv[2] ?? path.join(root, 'web/dist'));
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Extensionless paths (/app, /select) map to .html, like Vite preview and static hosting (DESIGN_V2 §7.2)
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!f.startsWith(dist) || !fs.existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[code] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
const errors = [];
async function open(url, vp) {
  const page = await browser.newPage();
  // Beginner mode is on by default (H-01); these checks target the full bench
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
  if (vp) await page.setViewport(vp);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.setItem('tb-beginner', '0'); });
  await page.goto(base + url, { waitUntil: 'load' });
  await waitFor(page, () => globalThis.__tbApp?.hist && globalThis.__tbApp.store.get().simSeconds > 0.3, null, 30000);
  return page;
}
const state = (page) => page.$eval('#codeView', (e) => [e.dataset.state, e.dataset.fw ?? '', e.textContent]).catch(() => ['', '', '']);

// 1. Desktop: weather Code tab -> main.c has app_main; switch to a header; line numbers start at 1
{
  const page = await open('/app?work=weather&debug=1#bench');
  const lazyBefore = await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /src\.json/.test(r.name)));
  await page.click('[data-dock="code"]');
  const ok = await waitFor(page, () => document.querySelector('#codeView')?.dataset.state === 'ok');
  const [st, fw, text] = await state(page);
  const files = await page.$$eval('#codeView [data-file]', (es) => es.map((e) => e.dataset.file));
  report('weather Code tab shows app_main', ok && st === 'ok' && fw === 'weather' && /void app_main\(void\)/.test(text), `${st} ${fw} files=${files.join(',')}`);
  report('source loads lazily (no src.json before opening the tab)', !lazyBefore);
  const hl = await page.$$eval('#codeBody span', (es) => new Set(es.map((e) => e.className)).size);
  const first = await page.$eval('#codeBody tr td', (e) => e.textContent);
  report('line numbers + highlighting', first === '1' && hl >= 4, `first line=${first} token classes=${hl}`);
  const h = files.find((f) => f.endsWith('.h'));
  if (h) await page.click(`#codeView [data-file="${h}"]`);
  const sel = await page.$eval('#codeView [aria-selected="true"]', (e) => e.dataset.file).catch(() => '');
  report('switch file', !!h && sel === h, sel);
  await page.screenshot({ path: path.join(outDir, 'code-weather.png') });
  // 2. Swap in an uploaded .bin: No source and the reason
  await page.evaluate(async () => {
    const buf = await (await fetch('./fw/s3-blink/flash.bin')).arrayBuffer();
    await globalThis.__tbApp.session.loadFirmware(buf, 'mine.bin');
  });
  const none = await waitFor(page, () => document.querySelector('#codeView')?.dataset.state === 'none');
  const [, , t2] = await state(page);
  report('uploaded .bin shows No source', none && /No source/.test(t2) && /mine\.bin/.test(t2), t2.slice(0, 60));
  await page.screenshot({ path: path.join(outDir, 'code-upload.png') });
  await page.close();
}
// 3. Mobile: the dock's Code tab works too (no horizontal scroll)
{
  const page = await open('/app?work=weather&debug=1#bench', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.click('#sheetPeek');
  await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'half');
  await page.click('#dock button[aria-label="Full screen"]');
  const tab = await waitFor(page, () => !!document.querySelector('[data-dock="code"]'));
  if (tab) await page.click('[data-dock="code"]');
  const ok = await waitFor(page, () => document.querySelector('#codeView')?.dataset.state === 'ok');
  const [, fw, text] = await state(page);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  report('mobile Code tab', ok && /app_main/.test(text) && wide <= 0, `fw=${fw} horizontal overflow=${wide}`);
  await page.screenshot({ path: path.join(outDir, 'code-phone.png') });
  await page.close();
}
report('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[code] ${fails ? 'FAIL' : 'PASS'} (${fails} failed)`);
process.exit(fails ? 1 : 0);
