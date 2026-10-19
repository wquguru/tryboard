// 3D assembly (P1-07) + parametric case export (P1-08): real mouse drags, retest ✗ / ✓, explode / section / ruler, STL / 3MF, SVG fallback.
// Checkpoint progress is preset in localStorage (levels.mjs tests the real thing). Usage: node tools/webtest/asm3d.mjs
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
const dlDir = path.join(outDir, 'asm3d-dl');
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });
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
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[asm3d] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `asm3d-${name}.png`) });

const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
await page.goto(`${base}/app?work=weather#bench`, { waitUntil: 'load' });
await page.evaluate(() => {
  const p = {};
  for (const id of ['01', '02', '03', '04', '05', '06']) p[id] = { fp: 'test', at: 'preset' };
  localStorage.setItem('tryboard-app-checks:weather', JSON.stringify(p));
  localStorage.removeItem('tryboard-app-asm:weather');
  localStorage.removeItem('tryboard-app-case:weather');
});
await page.goto(`${base}/app?work=weather#assemble`, { waitUntil: 'load' });
await page.reload({ waitUntil: 'load' });
const ready = await waitFor(page, () => !!globalThis.__tbAsm3d && !!document.querySelector('.asm3d-stage canvas'), null, 40000);
report('Assemble step is a 3D view (parametric case + three.js)', ready);
await sleep(1500);
await shot(page, 'start');

const msg = () => page.$eval('#props .asm-msg', (e) => e.textContent).catch(() => '');
async function drag(id, key) {
  // Parts fly back to the tray with a transition: wait until it settles before pressing
  let from = null;
  for (let i = 0; i < 30; i++) {
    const p = await page.evaluate((x) => globalThis.__tbAsm3d.partScreen(x), id);
    if (p && from && Math.hypot(p[0] - from[0], p[1] - from[1]) < 0.5) break;
    from = p;
    await sleep(100);
  }
  const to = await page.evaluate(([i, k]) => globalThis.__tbAsm3d.slotScreen(i, k), [id, key]);
  if (!from || !to) return false;
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let s = 1; s <= 14; s++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * s) / 14, from[1] + ((to[1] - from[1]) * s) / 14);
    await sleep(16);
  }
  await sleep(120);
  await page.mouse.up();
  await sleep(250);
  return true;
}
const asmState = () => page.evaluate(() => globalThis.__tbApp.store.get().assembly);
const tool = (id) => page.click(`#toolbar button[data-tool="${id}"]`);

// Wrong order: drag the front panel first
await drag('front');
report('wrong order is blocked (front panel first)', /“Front panel” can’t go in yet/.test(await msg()), (await msg()).trim());

async function assemble(bmeKey, from = 0) {
  const order = ['shell', 'board', 'bme', 'servo', 'oled', 'front'];
  for (const id of order.slice(from)) {
    await drag(id, id === 'bme' ? bmeKey : undefined);
    if (id === 'bme') await shot(page, `bme-${bmeKey}`);
  }
  return asmState();
}
let a = await assemble('B');
report('real mouse drag 6/6 (BME280 next to the chip)', a?.placed.length === 6 && a.choice.bme === 'B' && a.effects.sensorOffset === 2.5, JSON.stringify(a && { n: a.placed.length, choice: a.choice, fx: a.effects }));
await sleep(500);
await shot(page, 'done-B');

async function retest() {
  await tool('asm-retest');
  await waitFor(page, () => /Retest (failed|passed)/.test(document.getElementById('verdict').textContent), null, 120000);
  return page.$eval('#verdict', (e) => e.textContent);
}
let v = await retest();
const rows = await page.$eval('#props', (e) => e.textContent);
report('power-on retest ✗ (sensor against the chip, reads high)', /Retest failed/.test(v) && /25\.0 ℃|26\.0 ℃/.test(rows), `${v} · ${(rows.match(/Sensor reads [\d.]+ ℃/) ?? [''])[0]}`);
await shot(page, 'retest-bad');

// Step back ×5 (retest, front, OLED, servo, BME280) to the board step, then drag BME280 next to the vent
for (let i = 0; i < 5; i++) await tool('asm-undo');
a = await asmState();
report('step back ×5 to the board step', a?.placed.length === 2, JSON.stringify(a?.placed));
a = await assemble('A', 2);
report('finish with BME280 next to the vent', a?.placed.length === 6 && a.choice.bme === 'A' && a.effects.sensorOffset === 0 && a.clean, JSON.stringify(a && a.choice));
v = await retest();
report('power-on retest ✓', /Retest passed/.test(v), v);
await shot(page, 'retest-ok');

// Tools: explode, section, ruler
await tool('asm-explode');
await sleep(900);
await shot(page, 'explode');
report('explode', await page.evaluate(() => globalThis.__tbAsm3d.exploded()));
await tool('asm-explode');
await tool('asm-section');
await sleep(600);
await shot(page, 'section');
report('section', await page.evaluate(() => globalThis.__tbAsm3d.section()));
await tool('asm-ruler');
await sleep(600);
const rt = await page.evaluate(() => globalThis.__tbAsm3d.rulerText());
report('ruler: BME280 to chip distance', rt.some((t) => /BME280 to chip ≈ \d+ mm/.test(t)), rt.join(' | '));
await shot(page, 'ruler');
await tool('asm-ruler');
await tool('asm-section');

// The Product step uses this assembly
await page.click('#next');
const prod = await waitFor(page, () => location.hash === '#product' && !document.querySelector('.prod-preview:not([hidden])'), null, 10000);
report('assembled -> Product step (not the reference product)', prod);

// Shop case details: height 28 -> too short; export
await page.evaluate(() => {
  globalThis.__tbApp.store.set({ selection: { kind: 'part', id: 'enclosure-weather' } });
  location.hash = 'shop';
});
await waitFor(page, () => !!document.querySelector('#props [data-cpn="height"]'), null, 10000);
await page.$eval('#props [data-cpn="height"]', (i) => {
  i.value = '28';
  i.dispatchEvent(new Event('change'));
});
await sleep(300);
const warnTxt = await page.$eval('#props', (e) => e.textContent);
report('height 28 mm -> too short for the servo', /Too short/.test(warnTxt) && /Minimum height\s*31 mm/.test(warnTxt.replace(/\s+/g, ' ')), (warnTxt.match(/Too short[^)]*\)/) ?? [''])[0]);
await shot(page, 'shop-low');
await page.$eval('#props [data-cpn="height"]', (i) => {
  i.value = '34';
  i.dispatchEvent(new Event('change'));
});
await sleep(300);
for (const fmt of ['stl', '3mf']) {
  await page.evaluate(() => (globalThis.__tbCase = null));
  await page.click(`#props [data-export="${fmt}"]`);
  await waitFor(page, () => !!globalThis.__tbCase, null, 30000);
  const r = await page.evaluate(() => globalThis.__tbCase);
  const file = path.join(dlDir, r?.name ?? 'x');
  await waitFor(page, () => true, null, 100);
  for (let i = 0; i < 30 && !fs.existsSync(file); i++) await sleep(200);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  report(`export ${fmt.toUpperCase()}: downloaded ${size} bytes, read back`, !!r && r.check.ok && size === r.bytes && /h34/.test(r.name), r ? `${r.name} ${r.check.text}` : 'no result');
}
await shot(page, 'shop-export');

// Back to Assemble: the case rebuilds at the new height (34 mm) and the timeline replays into it
await page.evaluate(() => (location.hash = 'assemble'));
const rebuilt = await waitFor(page, () => /34 mm/.test(document.querySelector('.a3-disc')?.textContent ?? '') && globalThis.__tbApp.store.get().assembly?.placed.length === 6, null, 30000);
report('height changed, back to Assemble: case rebuilt, assembly replayed 6/6', rebuilt);
await sleep(800);
await shot(page, 'rebuilt');

// SVG fallback
const p2 = await browser.newPage();
p2.on('pageerror', (e) => errors.push(`svg: ${e}`));
await p2.goto(`${base}/app?work=weather&asm=svg#assemble`, { waitUntil: 'load' });
const svgOk = await waitFor(p2, () => !!document.querySelector('.asm-shell svg [data-part="shell"]'), null, 30000);
await p2.click('.asm-shell [data-part="shell"]');
await sleep(200);
const s2 = await p2.evaluate(() => globalThis.__tbApp.store.get().assembly?.placed ?? []);
report('?asm=svg fallback: SVG view assembles', svgOk && s2.length >= 1, JSON.stringify(s2));
await p2.close();

await page.evaluate(() => localStorage.clear());
await browser.close();
server.close();
if (errors.length) console.log('[asm3d] page errors:\n  ' + errors.join('\n  '));
console.log(`[asm3d] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
