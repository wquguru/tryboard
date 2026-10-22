// Placing parts (P2-16): LED kit ring by ring, 3D LED follows GPIO5, serial = CLI, BME280 on 5V -> W2, Esc, SDA/SCL swapped -> W8 + not found.
// Usage: node tools/webtest/place.mjs [dist dir, default web/dist]; screenshots in Reviews/web/place-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
  console.log(`[place] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const CLI = path.join(root, 'core/target/release/tryboard');
const FW = path.join(root, 'firmware/build/s3-blink/flash.bin');
let page;
/** Fresh page (own browser context: the bench project persists across reloads) */
async function newPage() {
  const ctx = await browser.createBrowserContext();
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.evaluateOnNewDocument(() => localStorage.clear());
}
await newPage();
await page.goto(base + '/app?work=blank&debug=1#bench', { waitUntil: 'load' });
await waitFor(page, () => !!globalThis.__tbApp?.hist, null, 30000);
await page.evaluate(async () => {
  const buf = await (await fetch('./fw/s3-blink/flash.bin')).arrayBuffer();
  await globalThis.__tbApp.session.loadFirmware(buf, 's3-blink/flash.bin');
});
const ran = await waitFor(page, () => /LED ON/.test(document.getElementById('console').textContent), null, 30000);
report('blank bench runs s3-blink', ran);

const has = (sel) => page.$(sel).then(Boolean);
const toast = () => page.$eval('#toast', (e) => e.textContent).catch(() => '');
const rings = () => page.$$eval('#pinRings [data-ring]', (es) => es.map((e) => e.dataset.ring));
const stepIs = (s) => waitFor(page, (x) => document.querySelector('#placeBanner')?.dataset.step === x, s);
/** Real mouse click on a pin ring: rings follow the camera projection, so read the current position first */
async function clickRing(id) {
  await waitFor(
    page,
    (i) => {
      const e = document.querySelector(`#pinRings [data-ring="${i}"]`);
      return e && !e.hidden && e.getBoundingClientRect().width > 0;
    },
    id,
  );
  const b = await page.$eval(`#pinRings [data-ring="${id}"]`, (e) => {
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await page.mouse.move(b[0], b[1]);
  await page.mouse.click(b[0], b[1]);
}

// ---- 1. Part library: placeable parts have Place, the rest are greyed out with a reason
await page.click('[data-left="lib"]');
await waitFor(page, () => !!document.querySelector('#partLib [data-place="led-kit"]'));
const grey = await page.$$eval('#partLib [data-place][disabled]', (es) => es.map((e) => e.getAttribute('aria-label')));
const okN = await page.$$eval('#partLib [data-place]:not([disabled])', (es) => es.length);
report('part library: placeable parts have Place, others greyed with a reason', okN >= 8 && grey.length > 0 && grey.every((g) => /can't be placed: .{4,}/.test(g)), `placeable ${okN}, grey ${grey.length}: ${grey[0] ?? ''}`);

// ---- 2. Drag the LED onto the bench (library drag type) -> wire one lead at a time
const ledsBefore = await page.evaluate(() => globalThis.__tbApp.session.bench.ledLevels().length);
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData('application/x-tryboard-part', 'led-kit');
  const st = document.getElementById('stage');
  const ev = (t) => new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 700, clientY: 400 });
  st.dispatchEvent(ev('dragover'));
  st.dispatchEvent(ev('drop'));
});
const s1 = await stepIs('IN');
const r1 = await rings();
report('drop on the bench -> wiring banner, long lead offers only GPIO rings', s1 && r1.length > 10 && r1.every((r) => /^GPIO\d+$/.test(r)), `${r1.length} rings`);
await page.screenshot({ path: path.join(outDir, 'place-banner.png') });
await clickRing('GPIO5');
const s2 = await stepIs('GND');
const r2 = await rings();
report('click GPIO5 -> next the short lead, only GND ring', s2 && r2.length === 1 && r2[0] === 'GND', r2.join(','));
await clickRing('GND');
await waitFor(page, () => !document.querySelector('#placeBanner'));
const placedToast = await toast();

// ---- 3. Done: scene, wire table, wiring check, 3D LED follows GPIO5
const scene = await page.evaluate(() => globalThis.__tbApp.session.scene.parts);
const led = scene.find((p) => p.type === 'led');
report('scene gains led@5', !!led && led.pin === 5 && scene.length === 1, JSON.stringify(scene));
await page.click('[data-left="wires"]');
const rows = await page.$$eval('#wireTable [data-wire]', (es) => es.map((e) => e.dataset.wire));
const faults = await page.evaluate(() => globalThis.__tbApp.faults());
report('wire table has two wires, wiring check clean', rows.includes('wire:GPIO5~led:5:IN') && rows.includes('wire:GND~led:5:GND') && faults.length === 0, `${rows.join(' ')}; issues ${faults.length}`);
report('placed toast', /Placed .*LED.*found no problems/.test(placedToast), placedToast);
const seen = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 4000 && seen.size < 2) {
  const l = await page.evaluate(() => globalThis.__tbApp.session.bench.ledLevels().find((x) => x.pin === 5));
  if (l) seen.add(l.target);
  await sleep(80);
}
report('this LED in 3D follows GPIO5 on / off', ledsBefore === 0 && seen.has(0) && seen.has(1), `${ledsBefore} before; brightness seen ${[...seen].join('/')}`);
await page.click('[data-left="lib"]');
await page.screenshot({ path: path.join(outDir, 'place-led.png') });

// ---- 4. Compare with the CLI: serial line by line
await waitFor(page, () => (document.getElementById('console').textContent.match(/LED (ON |OFF) \(\d+\)/g) ?? []).length >= 6, null, 20000);
const web = (await page.$eval('#console', (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''))).split('\n').filter((l) => /^LED |TRYBOARD_OK/.test(l));
let cliLines = [];
if (fs.existsSync(CLI)) {
  const p = spawnSync(CLI, ['run', FW, '--seconds', '3'], { maxBuffer: 64 << 20 });
  cliLines = p.stdout.toString('utf8').split('\n').filter((l) => /^LED |TRYBOARD_OK/.test(l));
}
const n = Math.min(web.length, cliLines.length);
report('serial matches the CLI line by line', n >= 6 && web.slice(0, n).join('\n') === cliLines.slice(0, n).join('\n'), `${n} lines; web ${JSON.stringify(web[0])} CLI ${JSON.stringify(cliLines[0])}`);

// ---- 5. Place BME280 with VCC on 5V -> W2; a second one is blocked; Esc cancels
await page.click('#partLib [data-place="bme280"]');
await stepIs('VIN');
const rp = await rings();
report('BME280 VCC offers only power rings', [...rp].sort().join(',') === '3V3,5V', rp.join(','));
await clickRing('5V');
await stepIs('GND');
await clickRing('GND');
await stepIs('SCL');
await clickRing('GPIO9');
await stepIs('SDA');
await clickRing('GPIO9');
const dupT = await toast();
await clickRing('GPIO8');
await waitFor(page, () => !document.querySelector('#placeBanner'));
const f2 = await page.evaluate(() => globalThis.__tbApp.faults());
const bme = (await page.evaluate(() => globalThis.__tbApp.session.scene.parts)).find((p) => p.type === 'bme280');
report('SDA cannot share the SCL pin', /is already wired to/.test(dupT), dupT);
report('BME280 VCC on 5V -> wiring check reports W2', !!bme && bme.sda === 8 && bme.scl === 9 && f2.some((f) => f.rule === 'W2' && f.wires.includes('wire:3V3~bme280:VIN')), JSON.stringify(f2.map((f) => f.rule)));
await sleep(300);
await page.screenshot({ path: path.join(outDir, 'place-w2.png') });
await page.click('#partLib [data-place="bme280"]');
await sleep(200);
const again = await toast();
report('a second module of the same kind is blocked', !(await has('#placeBanner')) && /already a .* on the bench/.test(again), again);
const nBefore = (await page.evaluate(() => globalThis.__tbApp.session.scene.parts)).length;
await page.click('#partLib [data-place="ssd1306"]');
await waitFor(page, () => !!document.querySelector('#placeBanner'));
await page.keyboard.press('Escape');
await sleep(200);
const nAfter = (await page.evaluate(() => globalThis.__tbApp.session.scene.parts)).length;
report('Esc cancels placing, scene unchanged', !(await has('#placeBanner')) && !(await has('#pinRings')) && nAfter === nBefore, `${nBefore} -> ${nAfter}`);

// ---- 6. I2C follows the wired pads (P2-16): s3-bme280 drives SDA GPIO8 / SCL GPIO9; swapped wires -> no 0x76 + W8, right wires -> found
const BME_FW = path.join(root, 'firmware/build/s3-bme280/flash.bin');
async function bmeRun(scl, sda) {
  await page.close();
  await newPage();
  await page.goto(base + '/app?work=blank&debug=1#bench', { waitUntil: 'load' });
  await waitFor(page, () => !!globalThis.__tbApp?.hist, null, 30000);
  await page.evaluate(async () => {
    const buf = await (await fetch('./fw/s3-bme280/flash.bin')).arrayBuffer();
    await globalThis.__tbApp.session.loadFirmware(buf, 's3-bme280/flash.bin');
  });
  const scans = () => document.getElementById('console').textContent.split('\n').filter((l) => /^I2C scan .*:/.test(l)).length;
  await waitFor(page, scans, null, 30000);
  await page.click('[data-left="lib"]');
  await waitFor(page, () => !!document.querySelector('#partLib [data-place="bme280"]'));
  await page.click('#partLib [data-place="bme280"]');
  for (const [step, ring] of [['VIN', '3V3'], ['GND', 'GND'], ['SCL', scl], ['SDA', sda]]) {
    await stepIs(step);
    await clickRing(ring);
  }
  const len0 = await page.$eval('#console', (e) => e.textContent.length);
  await waitFor(page, () => !document.querySelector('#placeBanner'));
  // Placing reboots the sim; without a device the firmware aborts after its scan and reboots in a loop (pin buses survive it).
  // Wait for a finished scan printed after placing: one followed by the chip id line or the abort.
  await waitFor(page, () => globalThis.__tbApp.session.i2cFw.length > 0, null, 30000);
  await waitFor(page, (l0) => {
    const t = document.getElementById('console').textContent;
    const i = t.lastIndexOf('I2C scan');
    return i >= 0 && (i > l0 || t.length < l0) && /\n(BME280 chip id|abort\(\))/.test(t.slice(i));
  }, len0, 60000);
  await sleep(300);
  const scan = (await page.$eval('#console', (e) => e.textContent)).split('\n').filter((l) => l.startsWith('I2C scan')).pop() ?? '';
  const faults = await page.evaluate(() => globalThis.__tbApp.faults().map((f) => ({ rule: f.rule, short: f.short, detail: f.detail })));
  const bme = (await page.evaluate(() => globalThis.__tbApp.session.scene.parts)).find((p) => p.type === 'bme280');
  // Same pads on the CLI (--i2c-bus, as inputlog cliArgs): the scan line must match
  const cli = fs.existsSync(CLI) ? spawnSync(CLI, ['run', BME_FW, '--seconds', '1.5', '--i2c-bus', `sda=${bme?.sda},scl=${bme?.scl}:bme280@0x76`], { maxBuffer: 64 << 20 }).stdout.toString('utf8').split('\n').find((l) => l.startsWith('I2C scan')) ?? '' : '';
  return { scan, faults, bme, cli };
}
const sw = await bmeRun('GPIO8', 'GPIO9');
const w8 = sw.faults.find((f) => f.rule === 'W8');
report('SDA / SCL swapped -> firmware scan finds nothing, same as the CLI', !!sw.bme && sw.bme.sda === 9 && sw.bme.scl === 8 && !/0x76/.test(sw.scan) && sw.scan === sw.cli, `web ${JSON.stringify(sw.scan)} CLI ${JSON.stringify(sw.cli)}`);
report('SDA / SCL swapped -> wiring check W8 says swap the wires', !!w8 && /SDA \/ SCL swapped/.test(w8.short) && /GPIO8/.test(w8.detail), JSON.stringify(w8 ?? sw.faults.map((f) => f.rule)));
await sleep(300);
await page.screenshot({ path: path.join(outDir, 'place-i2c-swapped.png') });
const okRun = await bmeRun('GPIO9', 'GPIO8');
report('SDA / SCL right -> firmware finds 0x76, same as the CLI, no W8', /0x76/.test(okRun.scan) && okRun.scan === okRun.cli && !okRun.faults.some((f) => f.rule === 'W8'), `web ${JSON.stringify(okRun.scan)} CLI ${JSON.stringify(okRun.cli)}; ${okRun.faults.map((f) => f.rule).join(',')}`);
report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[place] ${fails ? 'FAIL' : 'PASS'} (${fails} failed)`);
process.exit(fails ? 1 : 0);
