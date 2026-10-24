// Bench rewiring (U-04): W mode, rings + hover tips, 5V -> wrong-wire card, its three buttons, Esc, ⌘Z / ⇧⌘Z, no power cycle.
// Usage: node tools/webtest/wiremode.mjs [dist dir, default web/dist]; screenshots in Reviews/web/wiremode-*
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
  console.log(`[wiremode] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const page = await browser.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.setItem('tb-beginner', '0'); });
await page.goto(base + '/app?work=weather&debug=1#bench', { waitUntil: 'load' });
await waitFor(page, () => globalThis.__tbApp?.hist && globalThis.__tbApp.store.get().simSeconds > 0.5, null, 30000);

const W = 'wire:3V3~bme280:VIN';
const row = () => page.$eval(`#wireTable [data-wire="${W}"]`, (e) => e.textContent);
const has = (sel) => page.$(sel).then(Boolean);
const toast = () => page.$eval('#toast', (e) => e.textContent).catch(() => '');
/** Real mouse click on a pin ring: rings follow the moving camera and 5V sits next to GND,
 *  so wait until two position reads agree before clicking */
async function clickRing(id, hoverOnly = false) {
  const at = () =>
    page.$eval(`#pinRings [data-ring="${id}"]`, (e) => {
      const r = e.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
  let b = await at();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const c = await at();
    const still = Math.abs(c[0] - b[0]) < 0.5 && Math.abs(c[1] - b[1]) < 0.5;
    b = c;
    if (still) break;
  }
  // Neighbouring rings (5V / GND) half overlap in some views: aim at the visible, clickable part like a person would
  b = await page.$eval(
    `#pinRings [data-ring="${id}"]`,
    (e, c) => {
      const r = e.getBoundingClientRect();
      for (const k of [0, 0.25, 0.4])
        for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          const x = c[0] + dx * k * r.width, y = c[1] + dy * k * r.height;
          if (document.elementFromPoint(x, y)?.closest('[data-ring]') === e) return [x, y];
        }
      return c;
    },
    b,
  );
  await page.mouse.move(b[0], b[1]);
  if (!hoverOnly) await page.mouse.click(b[0], b[1]);
}
async function enterWire() {
  await page.click(`#wireTable [data-wire="${W}"]`);
  await page.keyboard.press('w');
  return waitFor(page, () => document.querySelectorAll('#pinRings [data-ring]').length > 10);
}

await page.click('[data-left="wires"]');
report('wire table: this wire is on 3V3', (await row()).includes('3V3') && !(await row()).includes('was '));
const sim0 = await page.evaluate(() => globalThis.__tbApp.store.get().simSeconds);

// ---- 1. Rewire mode
report('W enters rewire mode: banner + pin rings', (await enterWire()) && (await has('#wireBanner')));
const banner = await page.$eval('#wireBanner', (e) => e.textContent);
report('banner names the wire being moved', banner.includes('bme280:VIN') && banner.includes('3V3'), banner);
await clickRing('GPIO4', true);
const tip = await waitFor(page, () => document.querySelector('#pinRings [role=tooltip]')?.textContent.includes('GPIO4'));
report('hovering a pin ring shows a tip (used / free)', tip && (await page.$eval('#pinRings [role=tooltip]', (e) => /Used by|Free/.test(e.textContent))));
await page.screenshot({ path: path.join(outDir, 'wiremode-rings.png') });

// ---- 2. Connect to 5V -> wrong wire
await clickRing('5V');
const ww = await waitFor(page, () => !!document.querySelector('#wrongWire'));
report('connect to 5V -> wrong-wire card', ww, ww ? await page.$eval('#wrongWire', (e) => e.textContent.slice(0, 80)) : '');
report('pin rings close', !(await has('#pinRings')) && !(await has('#wireBanner')));
report('wire table says was 3V3', (await row()).includes('5V') && (await row()).includes('was 3V3'), await row());
await page.screenshot({ path: path.join(outDir, 'wiremode-wrong.png') });

// ---- 3. Card buttons
await page.click('#wrongWire [data-ww="undo"]');
await waitFor(page, () => !document.querySelector('#wrongWire'));
report('undo this rewire -> back on 3V3', !(await has('#wrongWire')) && !(await row()).includes('was '), await row());

await enterWire();
await clickRing('5V');
await waitFor(page, () => !!document.querySelector('#wrongWire'));
await page.click('#wrongWire [data-ww="retry"]');
const back = await waitFor(page, () => !document.querySelector('#wrongWire') && !!document.querySelector('#pinRings [data-ring]'));
report('move to another pin -> undo and back to rewire mode', back && !(await row()).includes('was '));
await page.keyboard.press('Escape');
await waitFor(page, () => !document.querySelector('#wireBanner'));
report('Esc leaves rewire mode', !(await has('#wireBanner')) && !(await has('#pinRings')));

await enterWire();
await clickRing('5V');
await waitFor(page, () => !!document.querySelector('#wrongWire'));
await page.click('#wrongWire [data-ww="keep"]');
await waitFor(page, () => !document.querySelector('#wrongWire'));
report('keep it -> card closes, rewire stays', !(await has('#wrongWire')) && (await row()).includes('was 3V3'));
const issues = await page.evaluate(() => globalThis.__tbApp.faults().length);
report('wiring check records an issue', issues > 0, `faults=${issues}`);

// ---- 4. Undo / redo
await page.keyboard.press('Escape');
await page.keyboard.down('Meta');
await page.keyboard.press('z');
await page.keyboard.up('Meta');
await waitFor(page, () => !document.querySelector('#wireTable [data-wire="wire:3V3~bme280:VIN"]')?.textContent.includes('was '));
report('⌘Z undoes the rewire', !(await row()).includes('was '), await row());
await page.keyboard.down('Meta');
await page.keyboard.down('Shift');
await page.keyboard.press('z');
await page.keyboard.up('Shift');
await page.keyboard.up('Meta');
await waitFor(page, () => !!document.querySelector('#wireTable [data-wire="wire:3V3~bme280:VIN"]')?.textContent.includes('was '));
report('⇧⌘Z redoes the rewire', (await row()).includes('was 3V3'), await row());

await enterWire();
await clickRing('3V3');
await waitFor(page, () => !document.querySelector('#pinRings'));
await sleep(200);
const t = await toast();
report('back on the original pin -> no issues', !(await row()).includes('was ') && (await page.evaluate(() => globalThis.__tbApp.faults().length)) === 0 && t.includes('back on'), t);

// ---- 5. The simulator keeps running
const sim1 = await page.evaluate(() => globalThis.__tbApp.store.get().simSeconds);
report('rewiring does not interrupt the simulation (time moves on)', sim1 > sim0, `${sim0.toFixed(2)} → ${sim1.toFixed(2)} s`);
report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[wiremode] ${fails ? 'FAIL' : 'PASS'} (${fails} failed)`);
process.exit(fails ? 1 : 0);
