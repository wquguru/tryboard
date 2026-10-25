// Part card (H-13): lesson 01 LED resistor / colour → estimated mA, 3D rebuild, prop: task tick, undo-safe scene edit.
// Usage: node tools/webtest/partcard.mjs [dist dir, default web/dist]; screenshots in Reviews/web/partcard-*
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
  console.log(`[partcard] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
/** Fresh page in its own context (empty storage); `pre` runs before every document */
async function open(url, pre, viewport) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (viewport) await page.setViewport(viewport);
  if (pre) await page.evaluateOnNewDocument(pre);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(base + url, { waitUntil: 'load' });
  await waitFor(page, () => globalThis.__tbApp?.hist && globalThis.__tbApp.store.get().simSeconds > 0.3, null, 30000);
  return page;
}
const has = (page, sel) => page.$(sel).then(Boolean);
const ma = (page) => page.$eval('#ledMa', (e) => Number(e.dataset.ma || NaN)).catch(() => NaN);
const bright = (page) => page.evaluate(() => globalThis.__tbApp.session.bench.ledLevels().find((l) => l.pin === 5)?.bright ?? null);
const ledSpec = (page) => page.evaluate(() => globalThis.__tbApp.session.scene.parts.find((p) => p.type === 'led' && p.pin === 5) ?? null);
const task = (page, i) => page.$eval(`#lessonCard li[data-task="${i}"]`, (e) => e.dataset.done).catch(() => null);

// Weather lesson 01, step 2 "Place the LED and resistor"
const page = await open('/app?work=weather&debug=1#bench');
await page.click('#lessonSteps [data-step="1"]');
await waitFor(page, () => document.querySelector('#lessonCard')?.dataset.step === '1', null, 3000);
report('lesson 01 step 2 open', (await page.$eval('#lessonCard', (e) => e.dataset.step).catch(() => null)) === '1');
report('resistor task waiting', (await task(page, 1)) === '0');
const how = await page.$eval('#lessonCard li[data-task="1"]', (e) => e.textContent).catch(() => '');
report('resistor task no longer says "later update"', !/later update/.test(how), how);
await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'part', id: 'led:5' } }));
await waitFor(page, () => !!document.querySelector('#ledCard'), null, 5000);
report('LED card shown', await has(page, '#ledCard'));
await waitFor(page, () => Number(document.querySelector('#ledMa')?.dataset.ma) > 0, null, 8000);
const m220 = await ma(page);
const b220 = await bright(page);
report('220 Ω red ≈ 5.7 mA', Math.abs(m220 - 5.7) < 0.1, `mA=${m220} bright=${b220}`);
report('card shows the estimate badge', await has(page, '#ledMa [data-conf]'));
await page.click('#ledCard [data-ohm="1000"]');
await waitFor(page, () => document.querySelector('#ledCard')?.dataset.ohm === '1000' && Math.abs(Number(document.querySelector('#ledMa')?.dataset.ma) - 1.44) < 0.05, null, 5000);
const m1k = await ma(page);
report('1 kΩ red ≈ 1.5 mA (±0.1)', Math.abs(m1k - 1.5) <= 0.1, `mA=${m1k}`);
report('scene PartSpec carries ohm 1000', (await ledSpec(page))?.ohm === 1000, JSON.stringify(await ledSpec(page)));
const b1k = await bright(page);
report('3D LED dimmer after 1 kΩ', b1k !== null && b220 !== null && b1k < b220, `bright ${b220} → ${b1k}`);
await waitFor(page, () => document.querySelector('#lessonCard li[data-task="1"]')?.dataset.done === '1', null, 3000);
report('prop:led:5.ohm=1000 ticks the task', !!(await page.$('#lessonCard li[data-task][data-done="1"]')) && (await task(page, 1)) === '1');
await page.screenshot({ path: path.join(outDir, 'partcard-1k.png') });
await page.click('#ledCard [data-ledcolor="green"]');
await waitFor(page, () => document.querySelector('#ledCard')?.dataset.color === 'green' && Number(document.querySelector('#ledMa')?.dataset.ma) < 1.4, null, 5000);
const mg = await ma(page);
report('green at 1 kΩ draws less (≈ 1.25 mA)', mg < m1k && Math.abs(mg - 1.25) < 0.05, `mA=${mg}`);
report('green lens colour in the scene', (await ledSpec(page))?.color === 0x22e04a);
await page.click('#ledCard [data-ledcolor="blue"]');
await waitFor(page, () => document.querySelector('#ledCard')?.dataset.color === 'blue' && Number(document.querySelector('#ledMa')?.dataset.ma) < 0.6, null, 5000);
const mb = await ma(page);
report('blue at 1 kΩ ≈ 0.48 mA', Math.abs(mb - 0.48) < 0.05, `mA=${mb}`);
await page.screenshot({ path: path.join(outDir, 'partcard-blue.png') });
report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
