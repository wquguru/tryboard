// Harness (P2-11): long I2C wire -> W6 + drifting readings / NACK, metal at the antenna -> −87 dBm; USB keypad (P2-12) home -> typing.
// Usage: node tools/webtest/harness.mjs (after tools/build_web.sh); screenshots in Reviews/web/harness-*.png
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Extensionless paths (/app, /select) map to .html, like Vite preview and static hosting (DESIGN_V2 §7.2)
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
let fails = 0, n = 0;
const report = (name, ok, extra = '') => {
  n++;
  console.log(`[harness] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}
async function open(url) {
  const page = await browser.newPage();
  // Beginner mode is on by default (H-01); these checks target the full bench
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await page.goto(base + url, { waitUntil: 'load' });
  return page;
}
const lastT = () => {
  const m = [...(document.getElementById('console')?.textContent ?? '').matchAll(/T=(-?[\d.]+) C/g)].pop();
  return m ? Number(m[1]) : null;
};

// ---- 1. Bench: wire length
{
  const page = await open('/app?work=weather&debug=1#bench');
  await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console')?.textContent ?? '') && !!globalThis.__tbApp?.setWireLen, null, 40000);
  await page.evaluate(() => globalThis.__tbApp.setWireLen('bme280', 50));
  const w6 = await waitFor(page, () => globalThis.__tbApp.faults().some((f) => f.rule === 'W6'), null, 5000);
  const before = (await page.evaluate(() => document.getElementById('console').textContent.length)) ?? 0;
  const wrong = await waitFor(page, (n0) => {
    const tail = document.getElementById('console').textContent.slice(n0);
    const m = [...tail.matchAll(/T=(-?[\d.]+) C/g)].pop();
    return !!m && Number(m[1]) !== 23.5;
  }, before, 15000);
  const t = await page.evaluate(lastT);
  const short = await page.evaluate(() => globalThis.__tbApp.faults().find((f) => f.rule === 'W6')?.short);
  report('bench: BME280 wire to 50 cm -> W6 warning, firmware readings drift', w6 && wrong, `W6 ${short} · read T=${t}`);
  // Select that wire and read its length and note in the properties panel
  await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'wire', id: 'wire:GPIO8~bme280:SDA' } }));
  await sleep(600);
  const note = await page.$eval('#wireLenNote', (e) => e.textContent).catch(() => '');
  report('bench: selected SDA wire shows length slider and rise time', /Rise time \d+ ns/.test(note) && /out of spec/.test(note), note.slice(0, 60));
  await page.screenshot({ path: path.join(outDir, 'harness-bench.png') });
  await page.evaluate(() => globalThis.__tbApp.setWireLen('bme280', 140));
  const block = await waitFor(page, () => globalThis.__tbApp.faults().some((f) => f.rule === 'W6' && /Rise/.test(f.short)), null, 5000);
  const nack = await waitFor(page, () => /unexpected nack|NACK/i.test(document.getElementById('console')?.textContent ?? '') || /does not answer/.test(document.querySelector('#props')?.textContent ?? ''), null, 15000);
  report('bench: 150 cm -> device does not answer (NACK)', block && nack);
  await page.close();
}

// ---- 2. Assemble: I2C cable + antenna
{
  const page = await open('/app?work=weather#bench');
  await page.evaluate(() => {
    const p = {};
    for (const id of ['01', '02', '03', '04', '05', '06']) p[id] = { fp: 'test', at: 'preset' };
    localStorage.setItem('tryboard-app-checks:weather', JSON.stringify(p));
    localStorage.removeItem('tryboard-app-harness:weather');
  });
  await page.goto(`${base}/app?work=weather#assemble`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  const ready = await waitFor(page, () => !!document.querySelector('#hzWire'), null, 40000);
  await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console')?.textContent ?? ''), null, 30000);
  const set = (sel, v) => page.evaluate((a) => { const e = document.querySelector(a[0]); e.value = String(a[1]); e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); }, [sel, v]);
  await set('#hzWire', 60);
  await sleep(300);
  const txt = await page.$eval('#hzWireRes', (e) => e.textContent).catch(() => '');
  const before = await page.evaluate(() => document.getElementById('console').textContent.length);
  const wrong = await waitFor(page, (n0) => {
    const m = [...document.getElementById('console').textContent.slice(n0).matchAll(/T=(-?[\d.]+) C/g)].pop();
    return !!m && Number(m[1]) !== 23.5;
  }, before, 15000);
  const sim = await page.$eval('[data-k="hzSim"]', (e) => e.textContent).catch(() => '');
  report('assemble: I2C cable to 60 cm -> readings will be wrong, simulator readings drift', ready && /readings will be wrong/.test(txt) && wrong && /I2C wire 60 cm/.test(sim), `${txt.slice(0, 40)} · ${sim.slice(0, 70)}`);
  await page.screenshot({ path: path.join(outDir, 'harness-asm-i2c.png') });
  await page.click('[data-obs="metal"]');
  await waitFor(page, () => !!document.querySelector('#hzDist'), null, 5000);
  await set('#hzDist', 0);
  await sleep(300);
  const ant = await page.$eval('#hzAntRes', (e) => e.textContent).catch(() => '');
  const sim2 = await waitFor(page, () => /antenna blockage 45 dB/.test(document.querySelector('[data-k="hzSim"]')?.textContent ?? ''), null, 5000);
  report('assemble: metal against the antenna -> 45 dB loss, RSSI −87 dBm cannot connect', /Antenna loss 45 dB/.test(ant) && /-87 dBm/.test(ant) && /cannot connect/.test(ant) && sim2, ant.slice(0, 60));
  await page.screenshot({ path: path.join(outDir, 'harness-asm-antenna.png') });
  await page.evaluate(() => localStorage.clear());
  await page.close();
}

// ---- 3. USB keypad: home -> Product, click keycaps to type
{
  const page = await open('/');
  await waitFor(page, () => !!document.querySelector('.wk[data-work="usbkey"] [data-go]'), null, 10000);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('.wk[data-work="usbkey"] [data-go]')]);
  const shop = /work=usbkey/.test(page.url()) && page.url().endsWith('#shop');
  await page.evaluate(() => (location.hash = 'product'));
  const up = await waitFor(page, () => !!document.querySelector('.prod-stage canvas') && globalThis.__tbProduct?.usbState?.() === 'configured', null, 40000);
  report('USB keypad: home start -> Product page, virtual PC enumerates it', shop && up, page.url().replace(base, ''));
  const press = async (i) => {
    const p = await page.evaluate((k) => globalThis.__tbProduct.keyPos(k), i);
    await page.mouse.move(p[0], p[1]);
    await page.mouse.down();
    await sleep(150);
    await page.mouse.up();
    await sleep(150);
  };
  await press(0);
  await press(3);
  const typed = await waitFor(page, () => globalThis.__tbProduct.typed() === 'aHello TryBoard\n', null, 15000);
  await waitFor(page, () => document.querySelector('#props [data-live="typed"]')?.textContent === 'aHello TryBoard↵', null, 3000);
  const shown = await page.$eval('#props [data-live="typed"]', (e) => e.textContent).catch(() => '');
  report('USB keypad: K1 and macro key K4 -> PC types aHello TryBoard↵', typed && shown === 'aHello TryBoard↵', JSON.stringify(await page.evaluate(() => globalThis.__tbProduct.typed())));
  await sleep(800);
  await page.screenshot({ path: path.join(outDir, 'harness-usbkey.png') });
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[harness] page errors:\n  ' + errors.join('\n  '));
console.log(`[harness] ${fails ? 'FAIL' : 'PASS'} (${n} checks, ${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
