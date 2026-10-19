// Mobile layout (U-05, 390×844): every step of weather, drawers, wiring, product fullscreen, all products; no h-scroll, ≥ 44px, no external hosts.
// Usage: node tools/webtest/mobile.mjs [dist dir, default web/dist]; screenshots in Reviews/web/mobile-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.resolve(process.argv[2] ?? path.join(root, 'web/dist'));
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };
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
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=390,844'],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[mobile] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
page.on('pageerror', (e) => errors.push(String(e)));
// With self-hosted fonts the site must not reach external hosts (fonts.googleapis / gstatic and the like)
const external = [];
page.on('request', (r) => {
  const u = r.url();
  if (/^https?:/.test(u) && !u.startsWith(base)) external.push(u);
});
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

/** Element is visible, in the viewport, ≥ 44px tall, and its centre really hits it (not covered) */
const tappable = (sel) =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return 'missing';
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return 'hidden';
    if (r.height < 44 - 0.5) return `h=${r.height}`;
    if (r.left < -0.5 || r.right > innerWidth + 0.5) return `x=${r.left}..${r.right}`;
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top && (top === e || e.contains(top)) ? 'ok' : `covered by ${top?.id || top?.tagName}`;
  }, sel);
const noHScroll = () => page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
const visible = (sel) =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  }, sel);
async function clickText(sel, text) {
  return page.evaluate(
    (s, t) => {
      const e = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().startsWith(t));
      e?.click();
      return !!e;
    },
    sel,
    text,
  );
}
async function stepCheck(name) {
  const [sw, iw] = await noHScroll();
  report(`${name}: no horizontal scroll`, sw <= iw, `${sw}/${iw}`);
}

// ---- Shop
// debug=1 exposes __tbApp.faults() (wiring check results), as in wiremode.mjs
await page.goto(base + '/app?work=weather&debug=1#shop', { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await waitFor(page, () => globalThis.__tbApp?.store.get().step === 'shop' && !!document.querySelector('#mNext #next'), null, 30000);
await stepCheck('Shop');
for (const s of ['#crumbHome', '#workMenuBtn', '#moreBtn', '#steps [data-step="bench"]', '#mNext #next']) report(`Shop: ${s} tappable`, (await tappable(s)) === 'ok', await tappable(s));
report('Shop: ‹ Works goes home', await page.$eval('#crumbHome', (e) => e.getAttribute('href') === './'));
report('Shop: Assemble and Product are locked', await page.evaluate(() => ['assemble', 'product'].every((s) => !!document.querySelector(`#steps [data-step="${s}"] svg`))));
await clickText('#toolbar button', 'Swap dev board');
await waitFor(page, () => !document.querySelector('.qcard')?.hidden);
report('Shop: swap-board drawer visible and tappable', (await visible('.qcard')) && (await tappable('.qcard [data-id="esp32-c3-devkitm-1"], .qcard button[data-id]')) === 'ok', await tappable('.qcard button[data-id]'));
await page.screenshot({ path: path.join(outDir, 'mobile-shop-board.png') });
await page.click('.qcard [data-card-close]');
report('Shop: swap-board drawer closes', await waitFor(page, () => document.querySelector('.qcard')?.hidden));

// ---- ▾ work switcher, ⋯ menu
await page.click('#workMenuBtn');
report('▾ work menu lists the works', await waitFor(page, () => document.querySelectorAll('#workMenu [role=menuitemradio]').length >= 7));
await page.click('#workMenuBtn');
await page.click('#moreBtn');
report('⋯ menu has Brief, Change firmware, dark mode', await waitFor(page, () => /Task brief/.test(document.querySelector('#moreMenu')?.textContent) && /Change firmware/.test(document.querySelector('#moreMenu')?.textContent) && /Switch to (dark|light)/.test(document.querySelector('#moreMenu')?.textContent)));
await page.click('#moreBtn');

// ---- Bench
await page.click('#mNext #next');
await waitFor(page, () => globalThis.__tbApp.store.get().step === 'bench' && globalThis.__tbApp.store.get().simSeconds > 0.5, null, 30000);
await sleep(300);
await stepCheck('Bench');
for (const t of ['select', 'wire', 'lib', 'meter', 'more']) report(`Bench: tool ${t} tappable`, (await tappable(`[data-mtool="${t}"]`)) === 'ok', await tappable(`[data-mtool="${t}"]`));
report('Bench: checkpoint banner', (await tappable('#cpGo')) === 'ok', await tappable('#cpGo'));
await page.screenshot({ path: path.join(outDir, 'mobile-bench.png') });

// Serial drawer
const sheet = () => page.$eval('#dock', (e) => e.dataset.sheet);
report('serial drawer: peek tappable', (await tappable('#sheetPeek')) === 'ok', await tappable('#sheetPeek'));
await page.click('#sheetPeek');
report('serial drawer: opens to half screen', await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'half'));
await page.click('#dock button[aria-label="Full screen"]');
report('serial drawer: full screen', await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'full'));
report('serial drawer: send button tappable', (await tappable('#serialSend')) === 'ok', await tappable('#serialSend'));
await page.type('#serialIn', 'help');
await page.click('#serialSend');
report('serial drawer: input clears after sending', await waitFor(page, () => document.querySelector('#serialIn').value === ''));
await page.screenshot({ path: path.join(outDir, 'mobile-serial.png') });
await page.click('#dock button[aria-label="Half screen"]');
await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'half');
await page.click('#sheetGrab');
report('serial drawer: back to peek', await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'peek'), await sheet());

// Build tree BME280 -> props drawer -> preset 32°
await page.click('[data-mtool="lib"]');
await waitFor(page, () => !!document.querySelector('[data-left="tree"]'));
await page.click('[data-left="tree"]');
await sleep(150);
report('build tree: tap BME280', await clickText('#tree [role=treeitem]', 'BME280'));
report('props drawer opens', await waitFor(page, () => !document.querySelector('#props')?.closest('[hidden]') && document.querySelector('#props')?.getBoundingClientRect().height > 100));
report('props drawer: close button tappable', (await tappable('#propsClose')) === 'ok', await tappable('#propsClose'));
const thumb = await page.evaluate(() => {
  const s = document.querySelector('#props input[type=range]');
  return s ? parseFloat(getComputedStyle(s, '::-webkit-slider-thumb').height) || s.getBoundingClientRect().height : 0;
});
report('props drawer: slider thumb big enough (≥ 28px)', thumb >= 28, `${thumb}px`);
report('props drawer: has a number input', await page.evaluate(() => !!document.querySelector('#props input[type=number]')));
report('props drawer: tap preset 32°', await clickText('#props button', '32°'));
const t32 = await waitFor(page, () => /T=32\.00/.test(document.querySelector('#sheetPeek')?.textContent ?? ''), null, 15000);
report('firmware reading becomes 32 °C', t32, await page.$eval('#sheetPeek', (e) => e.textContent.slice(0, 60)));
await page.screenshot({ path: path.join(outDir, 'mobile-props.png') });
await page.click('#propsClose');
report('props drawer closes', await waitFor(page, () => !document.querySelector('#props') || document.querySelector('#props').getBoundingClientRect().height === 0));

// Part library full-screen page
await page.click('[data-mtool="lib"]');
await waitFor(page, () => !!document.querySelector('[data-left="lib"]'));
await page.click('[data-left="lib"]');
await waitFor(page, () => document.querySelectorAll('#partLib a[data-lib]').length > 5);
const nAll = await page.$$eval('#partLib a[data-lib]', (a) => a.length);
// Full-screen page = the library's left column fills the viewport (the library itself has padding)
const lib = await page.evaluate(() => {
  const r = document.querySelector('#partLib').closest('aside').getBoundingClientRect();
  return [r.left, r.top, r.width, r.height].map(Math.round);
});
report('part library: full-screen page', lib[0] === 0 && lib[1] === 0 && lib[2] >= 389 && lib[3] >= 843, lib.join(','));
const kind = await page.$$eval('#partLib [data-kind]', (b) => b.map((x) => x.dataset.kind).filter((k) => k && k !== 'all'));
await page.click(`#partLib [data-kind="${kind[0]}"]`);
await sleep(150);
const nKind = await page.$$eval('#partLib a[data-lib]', (a) => a.length);
report('part library: category filter', nKind > 0 && nKind < nAll, `${nAll} -> ${nKind} (${kind[0]})`);
report('part library: close button tappable', (await tappable('#libClose')) === 'ok', await tappable('#libClose'));
await page.click('#libClose');
report('part library closes', await waitFor(page, () => !document.querySelector('#partLib') || document.querySelector('#partLib').getBoundingClientRect().height === 0));

// Wiring: pick a wire in the banner -> hold a pin for the loupe -> release to connect
await page.click('[data-mtool="wire"]');
report('wiring: banner lists wires to move', await waitFor(page, () => document.querySelectorAll('#wireBanner [data-wpick]').length > 3));
await page.click('#wireBanner [data-wpick="wire:3V3~bme280:VIN"]');
await waitFor(page, () => document.querySelectorAll('#pinRings [data-ring]').length > 10);
const p5 = await page.$eval('#pinRings [data-ring="5V"]', (e) => {
  const r = e.getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
});
await page.mouse.move(p5[0], p5[1]);
await page.mouse.down();
const lens = await waitFor(page, () => !!document.querySelector('#pinLens'), null, 3000);
report('wiring: holding a pin shows the loupe', lens && /5V/.test(await page.$eval('#pinLens', (e) => e.textContent)), lens ? await page.$eval('#pinLens', (e) => e.textContent.slice(0, 30)) : '');
await page.screenshot({ path: path.join(outDir, 'mobile-lens.png') });
await page.mouse.up();
report('wiring: release on 5V -> wrong-wire card', await waitFor(page, () => !!document.querySelector('#wrongWire')));
report('wrong-wire card: undo tappable', (await tappable('#wrongWire [data-ww="undo"]')) === 'ok', await tappable('#wrongWire [data-ww="undo"]'));
await page.click('#wrongWire [data-ww="undo"]');
report(
  'after undo back on 3V3, no issues',
  await waitFor(page, () => !document.querySelector('#wrongWire') && globalThis.__tbApp.faults().length === 0),
  await page.evaluate(() => JSON.stringify(globalThis.__tbApp.faults()).slice(0, 200)),
);
await page.keyboard.press('Escape');
await waitFor(page, () => !document.querySelector('#wireBanner'));

// ---- Assemble: locked page
await page.click('#steps [data-step="assemble"]');
await waitFor(page, () => globalThis.__tbApp.store.get().step === 'assemble' && !!document.querySelector('#toBench'));
await stepCheck('Assemble (locked)');
report('Assemble locked: back-to-bench tappable', (await tappable('#toBench')) === 'ok', await tappable('#toBench'));

// Preset checkpoint progress to unlock (as in asm3d.mjs; levels.mjs tests that only your own firmware counts)
await page.evaluate(() => {
  const p = {};
  for (const id of ['01', '02', '03', '04', '05', '06']) p[id] = { fp: 'test', at: 'preset' };
  localStorage.setItem('tryboard-app-checks:weather', JSON.stringify(p));
  localStorage.removeItem('tryboard-app-asm:weather');
});
await page.reload({ waitUntil: 'load' });
await waitFor(page, () => globalThis.__tbApp?.store.get().step === 'assemble' && !!document.querySelector('.asm3d-stage canvas'), null, 40000);
await sleep(500);
await stepCheck('Assemble');
report('Assemble: 3D on top', await page.evaluate(() => {
  const a = document.querySelector('.asm3d-stage').getBoundingClientRect();
  const p = document.querySelector('#props').getBoundingClientRect();
  return a.top < p.top && a.width >= innerWidth - 40;
}));
for (let i = 0; i < 12; i++) {
  const done = await page.evaluate(() => !document.querySelector('#mNext #next').disabled);
  if (done) break;
  // Layer by layer: tap Install when present, otherwise pick the first placement choice
  if (!(await clickText('#props button', 'Install'))) await clickText('#props button', 'Next to');
  await sleep(700);
}
report('Assemble: six layers done, main button tappable', await page.evaluate(() => !document.querySelector('#mNext #next').disabled) && (await tappable('#mNext #next')) === 'ok');
await page.screenshot({ path: path.join(outDir, 'mobile-assemble.png') });

// ---- Product
await page.click('#mNext #next');
await waitFor(page, () => globalThis.__tbApp.store.get().step === 'product' && !!document.querySelector('#mSerial'), null, 20000);
// Wait for the firmware and a serial reading before pressing keys
await waitFor(page, () => /T=/.test(document.querySelector('#mSerial')?.textContent ?? ''), null, 20000);
await stepCheck('Product');
report('Product: one-line serial strip', (await visible('#mSerial')) && /T=/.test(await page.$eval('#mSerial', (e) => e.textContent)));
// Product fullscreen (P2-17): 3D fills below the top bar and above the bottom panel, which sticks to the bottom
const full = () =>
  page.evaluate(() => {
    const m = document.querySelector('#mProduct')?.getBoundingClientRect();
    const sh = document.querySelector('#mProductSheet')?.getBoundingClientRect();
    const top = document.querySelector('#steps')?.getBoundingClientRect();
    const cv = [...document.querySelectorAll('#mProduct canvas, #mProduct svg.prod-svg')].map((e) => e.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!m || !sh || !top || !cv) return `missing m=${!!m} sheet=${!!sh} view=${!!cv}`;
    const ok = Math.abs(m.bottom - innerHeight) < 1 && Math.abs(sh.bottom - innerHeight) < 1 && m.top <= top.bottom + 1 && cv.width >= innerWidth - 1 && cv.height >= innerHeight * 0.45;
    return ok ? 'ok' : `m=${m.top}..${m.bottom} sheet=${sh.top}..${sh.bottom} view=${cv.width}x${cv.height}`;
  });
report('Product: 3D fullscreen', (await full()) === 'ok', await full());
// BOOT is in the bottom key grid and reacts to pointerdown / up, so it needs a real click, not a synthetic click event
report('Product: BOOT tappable', (await tappable('#toolbar [data-tool="p-boot"]')) === 'ok', await tappable('#toolbar [data-tool="p-boot"]'));
await page.click('#toolbar [data-tool="p-boot"]');
const unitF = await waitFor(page, () => /UNIT F/.test(document.querySelector('#console')?.textContent ?? ''), null, 15000);
report('Product: BOOT -> serial UNIT F', unitF, unitF ? '' : await page.evaluate(() => `console=${(document.querySelector('#console')?.textContent ?? '').slice(-120)}`));
await page.screenshot({ path: path.join(outDir, 'mobile-product.png') });
// Tap the serial strip -> the bench serial drawer at half screen; closing it returns to fullscreen
report('Product: serial strip tappable', (await tappable('#mSerialOpen')) === 'ok', await tappable('#mSerialOpen'));
await page.click('#mSerialOpen');
const half = await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'half' && document.querySelector('#dock')?.getBoundingClientRect().height > innerHeight * 0.4, null, 3000);
report('Product: serial strip opens the half-screen drawer', half, half ? '' : `sheet=${await page.evaluate(() => document.querySelector('#dock')?.dataset.sheet)}`);
await page.screenshot({ path: path.join(outDir, 'mobile-product-serial.png') });
if (half) await page.click('#sheetGrab');
report('Product: serial strip returns after the drawer closes', await waitFor(page, () => !document.querySelector('#dock[data-sheet="half"]') && !!document.querySelector('#mSerialOpen'), null, 3000));
report('Product: serial strip tappable after closing', (await tappable('#mSerialOpen')) === 'ok', await tappable('#mSerialOpen'));
// Real-hardware checklist (D-06) sits in the Details drawer: card fits, checkboxes and both buttons are tap-sized
await page.click('#toolbar [data-tool="p-info"]');
report('Product: checklist in Details', await waitFor(page, () => document.querySelectorAll('#props .checklist li').length >= 3, null, 3000));
await page.$eval('#props .checklist', (e) => e.scrollIntoView());
report('Product: checklist tick tappable', (await tappable('#props .checklist li > label')) === 'ok', await tappable('#props .checklist li > label'));
await page.$eval('#props .checklist-acts', (e) => e.scrollIntoView({ block: 'center' }));
report('Product: checklist copy / print tappable', (await tappable('#props .checklist-acts button')) === 'ok', await tappable('#props .checklist-acts button'));
await page.screenshot({ path: path.join(outDir, 'mobile-checklist.png') });
await page.click('#propsClose');

// ---- Example page (U-07/U-10): blank work + example firmware, only Shop / Bench; the firmware drawer covers the serial drawer and bottom bar
await page.goto(`${base}/app?work=blank&example=bme280#bench`, { waitUntil: 'load' });
await waitFor(page, () => globalThis.__tbApp?.store.get().step === 'bench' && globalThis.__tbApp.store.get().simSeconds > 0.5, null, 30000);
await stepCheck('Example page');
report('example page: only two steps', (await page.$$eval('#steps [data-step]', (b) => b.map((x) => x.dataset.step).join())) === 'shop,bench');
await page.click('#moreBtn');
await waitFor(page, () => !!document.querySelector('#moreMenu #swapFw'));
await page.click('#moreMenu #swapFw');
report('example page: firmware drawer opens', await waitFor(page, () => !!document.querySelector('#fwMenu [data-fw="upload"]')));
await stepCheck('Firmware drawer');
{
  const bad = [];
  for (const s of ['[data-chip="esp32c3"]', '[data-chip="esp32s3"]', '[data-ex="bme280"]', '[data-fw="all"]', '[data-fw="upload"]']) {
    const r = await tappable(`#fwMenu ${s}`);
    if (r !== 'ok') bad.push(`${s}:${r}`);
  }
  report('firmware drawer: chip, examples, all and upload are ≥ 44px and uncovered', bad.length === 0, bad.join(' '));
}
await page.screenshot({ path: path.join(outDir, 'mobile-fwsheet.png') });
await page.keyboard.press('Escape');
report('firmware drawer: Esc closes it', await waitFor(page, () => !document.querySelector('#fwMenu')));

// ---- Every product (preview ?work=X#product): fullscreen, no h-scroll, every key ≥ 44px and tappable, action key raises no error
const WORKS = { weather: 'p-boot', spin: 'p-boot', lens: 'p-boot', usbkey: 'p-key-4', lamp: 'p-knob-r', ruler: 'p-near', tilt: 'p-tilt-r', imu: 'p-level' };
for (const [w, key] of Object.entries(WORKS)) {
  await page.goto(`${base}/app?work=${w}#product`, { waitUntil: 'load' });
  const up = await waitFor(page, (k) => globalThis.__tbApp?.store.get().step === 'product' && !!document.querySelector(`#toolbar [data-tool="${k}"]`), key, 30000);
  if (!up) {
    report(`Product ${w}: key grid appears`, false);
    continue;
  }
  await sleep(1500);
  await stepCheck(`Product ${w}`);
  report(`Product ${w}: 3D fullscreen`, (await full()) === 'ok', await full());
  const tools = await page.$$eval('#toolbar [data-tool]', (b) => b.map((x) => x.dataset.tool));
  const bad = [];
  for (const t of tools) {
    const r = await tappable(`#toolbar [data-tool="${t}"]`);
    if (r !== 'ok') bad.push(`${t}:${r}`);
  }
  report(`Product ${w}: all ${tools.length} keys ≥ 44px and tappable`, tools.length >= 3 && bad.length === 0, bad.join(' '));
  await page.click(`#toolbar [data-tool="${key}"]`);
  await sleep(800);
  await page.screenshot({ path: path.join(outDir, `mobile-product-${w}.png`) });
}

// ---- Virtual phone (C-01): BLE example -> build tree phone -> scan and connect in the props drawer; big buttons, no h-scroll
await page.goto(`${base}/app?work=blank&example=c3-ble-hr#bench`, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
if (await waitFor(page, () => globalThis.__tbApp?.store.get().simSeconds > 0.5, null, 30000)) {
  await page.click('[data-mtool="lib"]');
  await waitFor(page, () => !!document.querySelector('[data-left="tree"]'));
  await page.click('[data-left="tree"]');
  report('virtual phone: in the build tree', await waitFor(page, () => !!document.querySelector('#tree [data-kind="ble"]')));
  await page.click('#tree [data-kind="ble"]');
  report('virtual phone: shows in the props drawer', await waitFor(page, () => !!document.querySelector('#blePhone #bleScan')));
  report('virtual phone: scan button ≥ 44px', (await tappable('#bleScan')) === 'ok', await tappable('#bleScan'));
  await page.click('#bleScan');
  report('virtual phone: finds TryBoard-HR', await waitFor(page, () => !!document.querySelector('#blePhone [data-dev] [data-act="connect"]'), null, 15000));
  await page.click('#blePhone [data-dev] [data-act="connect"]');
  report('virtual phone: connects, services listed', await waitFor(page, () => !!document.querySelector('[data-char="2A37"]'), null, 15000));
  report('virtual phone: #bleDisc tappable', (await tappable('#bleDisc')) === 'ok', await tappable('#bleDisc'));
  await page.$eval('[data-char="FFE1"]', (e) => e.scrollIntoView({ block: 'center' }));
  await sleep(200);
  for (const s of ['[data-char="2A19"] [data-act="read"]', '[data-char="FFE1"] [data-act="write"]'])
    report(`virtual phone: ${s} tappable`, (await tappable(s)) === 'ok', await tappable(s));
  await stepCheck('Virtual phone');
  await page.screenshot({ path: path.join(outDir, 'mobile-ble-phone.png') });
} else report('BLE example starts', false);

report('no external hosts requested', external.length === 0, external.slice(0, 3).join(' | '));
report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`[mobile] ${fails ? 'FAIL' : 'PASS'} (${fails} failed)`);
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
