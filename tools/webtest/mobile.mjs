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
  // Extensionless paths (/app, /select) and locale copies (/changelog.zh) map to .html, like Vite preview and static hosting
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = (!path.extname(f0) || !fs.existsSync(f0)) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
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
// Beginner mode is on by default (H-01); these checks target the full bench
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
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
// U-25 (DESIGN_V2 §10.3): guided / free groups, blank + my project first in the free group, current work checked
report('▾ work menu: guided and free group titles', await page.evaluate(() => document.querySelector('#workMenu #wmGuided')?.textContent === 'Guided works' && document.querySelector('#workMenu #wmFree')?.textContent === 'Free lab'));
report('▾ work menu: blank and my project lead the free group', await page.evaluate(() => {
  const first = document.querySelector('#workMenu [data-group="free"] [role=menuitemradio]')?.parentElement;
  return first?.dataset.row === 'free-top' && [...first.querySelectorAll('[role=menuitemradio]')].map((a) => a.dataset.work).join() === 'blank,custom';
}));
report('▾ work menu: guided rows show passed/total', await page.evaluate(() => [...document.querySelectorAll('#workMenu [data-group="guided"] [role=menuitemradio]')].every((a) => /^\d+\/\d+$/.test(a.lastElementChild?.textContent ?? ''))));
report('▾ work menu: current work is checked', await page.evaluate(() => [...document.querySelectorAll('#workMenu [aria-checked="true"]')].map((a) => a.dataset.work).join() === 'weather'));
report('▾ work menu: items tappable', (await tappable('#workMenu [data-work="blank"]')) === 'ok' && (await tappable('#workMenu [data-work="weather"]')) === 'ok', await tappable('#workMenu [data-work="blank"]'));
await page.click('#workMenuBtn');
// ⋯ is a grouped bottom sheet on phones (DESIGN_V2 §10.1, U-23)
await page.click('#moreBtn');
report('⋯ sheet opens with a scrim', await waitFor(page, () => !!document.querySelector('#moreMenu') && getComputedStyle(document.getElementById('moreScrim')).backgroundColor !== 'rgba(0, 0, 0, 0)'));
report('⋯ sheet sits at the bottom', await page.evaluate(() => Math.abs(document.getElementById('moreMenu').getBoundingClientRect().bottom - innerHeight) < 1));
const groups = await page.$$eval('#moreMenu [data-more-group] h3', (l) => l.map((e) => e.textContent));
report('⋯ sheet has four groups: Share / Firmware / Developer tools / Settings', groups.join('|') === 'Share|Firmware|Developer tools|Settings', groups.join('|'));
for (const s of ['[data-more="close"]', '[data-more="share-open"]', '[data-more="fw"]', '[data-more="dev"]', '[data-more="theme"] [data-theme-pref="dark"]', '[data-more="lang"] select', '[data-more="licenses"]'])
  report(`⋯ sheet: ${s} tappable`, (await tappable(s)) === 'ok', await tappable(s));
report('⋯ sheet rows ≥ 56px', await page.$$eval('#moreMenu [data-more="share-open"], #moreMenu [data-more="fw"], #moreMenu [data-more="dev"]', (l) => l.every((e) => e.getBoundingClientRect().height >= 55.5)));
report('⋯ sheet keeps the trademark notice', await page.$eval('#moreMenu', (e) => /ESP32 is a trademark of Espressif Systems\. TryBoard is not affiliated with Espressif\./.test(e.textContent)));
report('⋯ menu has Change firmware', await page.$eval('#moreMenu', (e) => /Change firmware/.test(e.textContent)));
report('⋯ developer tools start folded', await page.$eval('[data-more="dev"]', (e) => e.getAttribute('aria-expanded') === 'false' && !document.querySelector('[data-more="brief"]')));
await page.click('[data-more="dev"]');
report('⋯ developer tools expand: input log, Task brief, real network switch', await waitFor(page, () => !!document.querySelector('[data-more="inputs"]') && /Task brief/.test(document.querySelector('[data-more="brief"]')?.textContent) && document.querySelector('[data-more="realnet"]')?.getAttribute('role') === 'switch', null, 3000));
report('⋯ real network switch tappable', (await tappable('[data-more="realnet"]')) === 'ok', await tappable('[data-more="realnet"]'));
const theme0 = await page.evaluate(() => document.documentElement.dataset.theme);
report('⋯ theme is a three-way switch (system / light / dark)', await page.$$eval('[data-more="theme"] [role=radio]', (l) => l.map((e) => e.dataset.themePref).join() === 'system,light,dark'));
await page.click('[data-more="theme"] [data-theme-pref="dark"]');
report('⋯ dark mode applies', await waitFor(page, () => document.documentElement.dataset.theme === 'dark', null, 3000));
await page.click(`[data-more="theme"] [data-theme-pref="${theme0 === 'dark' ? 'dark' : 'light'}"]`);
const [msw, miw] = await noHScroll();
report('⋯ sheet: no horizontal scroll', msw <= miw, `${msw}/${miw}`);
await page.screenshot({ path: path.join(outDir, 'mobile-more.png') });
await page.click('[data-more="share-open"]');
report('⋯ share sub-sheet: three cards', await waitFor(page, () => ['share', 'card', 'file'].every((k) => !!document.querySelector(`#moreMenu [data-more="${k}"]`)), null, 3000));
for (const s of ['[data-more="back"]', '[data-more="share"]', '[data-more="card"]', '[data-more="file"]', '[data-more="link"]'])
  report(`⋯ share sub-sheet: ${s} tappable`, (await tappable(s)) === 'ok', await tappable(s));
await page.screenshot({ path: path.join(outDir, 'mobile-more-share.png') });
await page.click('[data-more="back"]');
report('⋯ share sub-sheet: ‹ back returns to the groups', await waitFor(page, () => !!document.querySelector('[data-more="share-open"]') && !document.querySelector('#moreMenu [data-more="card"]'), null, 3000));
await page.mouse.click(195, 60);
report('⋯ sheet closes on a scrim tap', await waitFor(page, () => !document.querySelector('#moreMenu'), null, 3000));
await page.click('#moreBtn');
await waitFor(page, () => !!document.querySelector('#moreMenu'), null, 3000);
await page.keyboard.press('Escape');
report('⋯ sheet closes on Esc', await waitFor(page, () => !document.querySelector('#moreMenu'), null, 3000));

// ---- Bench
await page.click('#mNext #next');
await waitFor(page, () => globalThis.__tbApp.store.get().step === 'bench' && globalThis.__tbApp.store.get().simSeconds > 0.5, null, 30000);
await sleep(300);
await stepCheck('Bench');
for (const t of ['select', 'wire', 'lib', 'meter', 'more']) report(`Bench: tool ${t} tappable`, (await tappable(`[data-mtool="${t}"]`)) === 'ok', await tappable(`[data-mtool="${t}"]`));
report('Bench: checkpoint banner', (await tappable('#cpGo')) === 'ok', await tappable('#cpGo'));
await page.screenshot({ path: path.join(outDir, 'mobile-bench.png') });

// More drawer (U-24, DESIGN_V2 §10.2): board controls -> capture -> view, BOOT first, sound tag, switch rows
await page.click('[data-mtool="more"]');
await waitFor(page, () => !!document.querySelector('#moreTools'), null, 3000);
const groupsOrder = await page.$$eval('#moreTools [data-group]', (g) => g.map((x) => x.dataset.group).join(','));
report('More: groups ordered act, media, view', groupsOrder === 'act,media,view', groupsOrder);
const titles = await page.$$eval('#moreTools [data-group-title]', (g) => g.map((x) => x.textContent.trim()).join(' | '));
report('More: group titles shown in order', titles === 'Board controls | Capture | View tools', titles);
report('More: BOOT is the first button of the first group', await page.evaluate(() => document.querySelector('#moreTools [data-group="act"] [data-tool]')?.dataset.tool === 'button'));
report('More: BOOT uses the primary colour', await page.$eval('#moreTools [data-tool="button"]', (e) => e.classList.contains('primary')));
report('More: heater shows a state tag', await page.evaluate(() => !!document.querySelector('#moreTools [data-tool="heat"] [data-state]')));
for (const id of ['ext', 'orbit']) {
  const sw = await page.$eval(`#moreTools [data-tool="${id}"]`, (e) => `${e.getAttribute('role')}:${e.getAttribute('aria-checked')}`).catch(() => 'missing');
  report(`More: ${id} is a switch row`, /^(switch|checkbox):(true|false)$/.test(sw), sw);
}
report('More: no state text in the 3D models row', await page.$eval('#moreTools [data-tool="ext"]', (e) => !/: (on|off)/.test(e.textContent)));
// Toasts still sit over bottom drawers until U-26 lands, so let one fade before tapping drawer rows
const toastGone = () => waitFor(page, () => document.querySelector('#toast')?.hidden !== false, null, 8000);
await toastGone();
for (const id of ['button', 'heat', 'photo', 'rec', 'ext', 'ruler']) report(`More: ${id} tappable`, (await tappable(`#moreTools [data-tool="${id}"]`)) === 'ok', await tappable(`#moreTools [data-tool="${id}"]`));
const soundState = () => page.$eval('#moreTools [data-tool="sound"] [data-state]', (e) => e.dataset.state).catch(() => 'missing');
report('More: sound toggle tappable', (await tappable('#moreTools [data-tool="sound"]')) === 'ok', await tappable('#moreTools [data-tool="sound"]'));
const s0 = await soundState();
await page.click('#moreTools [data-tool="sound"]');
const s1ok = await waitFor(page, (s) => document.querySelector('#moreTools [data-tool="sound"] [data-state]')?.dataset.state !== s, s0, 3000);
const s1 = await soundState();
report('More: sound toggles mute state', s0 === 'off' && s1ok && s1 === 'on', `${s0} -> ${s1}`);
await page.click('#moreTools [data-tool="sound"]');
report('More: sound mutes again', await waitFor(page, () => document.querySelector('#moreTools [data-tool="sound"] [data-state]')?.dataset.state === 'off', null, 3000));
await toastGone();
const ext0 = await page.$eval('#moreTools [data-tool="ext"]', (e) => e.getAttribute('aria-checked'));
await page.click('#moreTools [data-tool="ext"]');
report('More: 3D models switch flips', await waitFor(page, (v) => document.querySelector('#moreTools [data-tool="ext"]')?.getAttribute('aria-checked') !== v, ext0, 3000));
await page.click('#moreTools [data-tool="ext"]');
await waitFor(page, (v) => document.querySelector('#moreTools [data-tool="ext"]')?.getAttribute('aria-checked') === v, ext0, 3000);
await page.screenshot({ path: path.join(outDir, 'mobile-more.png') });
await page.click('[data-mtool="more"]');
report('More: drawer closes', await waitFor(page, () => !document.querySelector('#moreTools'), null, 3000));

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
{
  // U-26: a toast raised while the props drawer is open must sit above it, not on it
  await page.evaluate(() => globalThis.__tbApp.toast('Placed from the list: 5 (OLED, BME280, LED, button, buzzer)'));
  await sleep(600);
  const r = await page.evaluate(() => {
    const a = document.querySelector('#toast').getBoundingClientRect();
    const b = document.querySelector('#props').getBoundingClientRect();
    return { toastVisible: !document.querySelector('#toast').hidden, toastBottom: a.bottom, propsTop: b.top };
  });
  report('toast does not overlap the props drawer', r.toastVisible && r.toastBottom <= r.propsTop + 0.5, JSON.stringify(r));
  await page.screenshot({ path: path.join(outDir, 'mobile-props-toast.png') });
}
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
const prodTitles = await page.$$eval('#toolbar [data-group-title]', (g) => g.map((x) => x.textContent.trim()).join(' | '));
report('Product: buttons grouped Board controls -> Capture', prodTitles === 'Board controls | Capture', prodTitles);
report('Product: BOOT and heat in the first group', await page.evaluate(() => ['p-boot', 'p-heat'].every((k) => !!document.querySelector(`#toolbar [data-group="act"] [data-tool="${k}"]`))));
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

// ---- Phone placing (P2-16): library -> 44px Place -> drawer closes -> press-and-release each pin ring -> part on the bench
{
  const nParts = await page.evaluate(() => globalThis.__tbApp.session.scene.parts.length);
  await page.click('[data-mtool="lib"]');
  await waitFor(page, () => !!document.querySelector('[data-left="lib"]'));
  await page.click('[data-left="lib"]');
  await waitFor(page, () => !!document.querySelector('#partLib [data-place="led-kit"]'));
  // The LED row sits below the fold on a phone; scroll it in like a thumb would
  await page.$eval('#partLib [data-place="led-kit"]', (e) => e.scrollIntoView({ block: 'center' }));
  await sleep(200);
  report('phone placing: library Place is ≥ 44px and uncovered', (await tappable('#partLib [data-place="led-kit"]')) === 'ok', await tappable('#partLib [data-place="led-kit"]'));
  await page.click('#partLib [data-place="led-kit"]');
  const closed = await waitFor(page, () => !!document.querySelector('#placeBanner') && (!document.querySelector('#partLib') || document.querySelector('#partLib').getBoundingClientRect().height === 0));
  report('phone placing: library closes, place banner shows', closed);
  const pressRing = async (id) => {
    await waitFor(page, (i) => {
      const e = document.querySelector(`#pinRings [data-ring="${i}"]`);
      return e && !e.hidden && e.getBoundingClientRect().width > 0;
    }, id);
    const c = await page.$eval(`#pinRings [data-ring="${id}"]`, (e) => {
      const r = e.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
    await page.mouse.move(c[0], c[1]);
    await page.mouse.down();
    await sleep(120);
    await page.mouse.up();
  };
  const gpio = await page.$$eval('#pinRings [data-ring]', (r) => r.map((e) => e.dataset.ring).filter((x) => /^GPIO\d+$/.test(x)));
  const pin = gpio.includes('GPIO4') ? 'GPIO4' : gpio[0];
  await page.screenshot({ path: path.join(outDir, 'mobile-place.png') });
  await pressRing(pin);
  await waitFor(page, () => document.querySelector('#placeBanner')?.dataset.step === 'GND');
  await pressRing('GND');
  const placed = await waitFor(page, (n) => !document.querySelector('#placeBanner') && globalThis.__tbApp.session.scene.parts.length === n + 1, nParts);
  const led = (await page.evaluate(() => globalThis.__tbApp.session.scene.parts)).find((x) => x.type === 'led');
  report('phone placing: two ring taps place the LED on that pin', placed && led?.pin === +pin.slice(4), `${pin} -> ${JSON.stringify(led ?? null)}`);
  await stepCheck('Phone placing');
}

// ---- Every product (preview ?work=X#product): fullscreen, no h-scroll, every key ≥ 44px and tappable, action key raises no error
const WORKS = { weather: 'p-boot', spin: 'p-boot', lens: 'p-boot', usbkey: 'p-key-4', lamp: 'p-knob-r', ruler: 'p-near', tilt: 'p-tilt-r', imu: 'p-level', door: 'p-card-ok', irlamp: 'p-ir-power', cloud: 'p-cloud-2', dialtimer: 'p-dial-start', amoclock: 'p-amo-left' };
for (const [w, key] of Object.entries(WORKS)) {
  await page.goto(`${base}/app?work=${w}#product`, { waitUntil: 'load' });
  const up = await waitFor(page, (k) => globalThis.__tbApp?.store.get().step === 'product' && !!document.querySelector(`#toolbar [data-tool="${k}"]`), key, 30000);
  if (!up) {
    report(`Product ${w}: key grid appears`, false);
    continue;
  }
  await sleep(1500);
  await stepCheck(`Product ${w}`);
  // G-17c gave amoclock its 3D desk stand, so every work now goes fullscreen
  report(`Product ${w}: 3D fullscreen`, (await full()) === 'ok', await full());
  // Boot-time toasts (spin: brownout) can sit over the grid until U-26 moves them; wait for them like a user would
  await waitFor(page, () => document.querySelector('#toast')?.hidden !== false, null, 8000);
  const tools = await page.$$eval('#toolbar [data-tool]', (b) => b.map((x) => x.dataset.tool));
  const bad = [];
  for (const t of tools) {
    const r = await tappable(`#toolbar [data-tool="${t}"]`);
    if (r !== 'ok') bad.push(`${t}:${r}`);
  }
  report(`Product ${w}: all ${tools.length} keys ≥ 44px and tappable`, tools.length >= 3 && bad.length === 0, bad.join(' '));
  await page.click(`#toolbar [data-tool="${key}"]`);
  await sleep(800);
  // G-17b: the swipe key goes through touch= / release and the firmware turns the page
  if (w === 'amoclock') report('Product amoclock: swipe key turns to page 2/3', await waitFor(page, () => globalThis.__tbAmoclock?.page === 2, null, 15000), JSON.stringify(await page.evaluate(() => globalThis.__tbAmoclock)));
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

// ---- D-07: network conditions 2×2 and the analyzer (Waveform tab) in the bottom sheet
// Touch emulation only here: earlier sections assert the mouse-pointer layout
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await page.goto(`${base}/app?work=blank&example=c3-wifi-resilient#bench`, { waitUntil: 'load' });
if (await waitFor(page, () => globalThis.__tbApp?.store.get().simSeconds > 0.5, null, 30000)) {
  await page.click('#sheetPeek');
  report('D-07: Network tab in the sheet', await waitFor(page, () => !!document.querySelector('#dock [data-dock="net"]'), null, 20000));
  await page.click('#dock [data-dock="net"]');
  report('D-07: 4 presets', await waitFor(page, () => document.querySelectorAll('#netCond [role=radio]').length === 4, null, 10000));
  // Phone design folds the faults behind "Schedule a fault"
  report('D-07: fault toggle tappable', (await tappable('#faultToggle')) === 'ok', await tappable('#faultToggle'));
  await page.click('#faultToggle');
  report('D-07: 3 faults after unfolding', await waitFor(page, () => document.querySelectorAll('#netCond [data-fault]').length === 3));
  const cols = await page.$$eval('#netCond [role=radio]', (l) => new Set(l.map((e) => Math.round(e.getBoundingClientRect().left))).size);
  report('D-07: presets in 2 columns', cols === 2, `${cols} columns`);
  for (const s of ['[data-preset="flaky"]', '[data-fault="reboot"]']) {
    await page.$eval(s, (e) => e.scrollIntoView({ block: 'center' }));
    report(`D-07: ${s} tappable`, (await tappable(s)) === 'ok', await tappable(s));
  }
  await stepCheck('D-07 network');
  await page.screenshot({ path: path.join(outDir, 'mobile-net.png') });
  await page.click('#dock [data-dock="analyzer"]');
  report('D-07: analyzer shows in the sheet', await waitFor(page, () => !!document.querySelector('#dock #analyzer.in-sheet:not([hidden])')));
  for (const s of ['#analyzer [data-act="fine"]', '#analyzer [data-act="in"]', '#analyzer [data-act="follow"]'])
    report(`D-07: ${s} tappable`, (await tappable(s)) === 'ok', await tappable(s));
  await page.click('#analyzer [data-act="fine"]');
  report('D-07: fine-sampling form opens', await waitFor(page, () => !document.querySelector('#analyzer [data-a="fform"]').hidden));
  await page.$eval('#analyzer .ana-go', (e) => e.scrollIntoView({ block: 'center' }));
  report('D-07: start capture tappable', (await tappable('#analyzer .ana-go')) === 'ok', await tappable('#analyzer .ana-go'));
  // Two taps on the canvas place A then B (touch has no Shift)
  report('D-07: waveform tab opens the sheet full height', await page.$eval('#dock', (e) => e.dataset.sheet) === 'full');
  // Tap inside the part of the canvas the scrolling body shows
  const cv = await page.$eval('#analyzer canvas', (e) => {
    const r = e.getBoundingClientRect();
    const b = e.closest('.ana-body').getBoundingClientRect();
    const top = Math.max(r.top, b.top);
    return { x: r.left, y: (top + Math.min(r.bottom, b.bottom)) / 2, w: r.width };
  });
  await page.touchscreen.tap(cv.x + cv.w * 0.5, cv.y);
  await page.touchscreen.tap(cv.x + cv.w * 0.8, cv.y);
  await sleep(300);
  const cur = await page.$eval('#analyzer [data-a="cur"]', (e) => e.textContent);
  report('D-07: two taps place cursors A and B', /A .*B .*Δ/.test(cur), cur);
  await stepCheck('D-07 analyzer');
  await page.screenshot({ path: path.join(outDir, 'mobile-analyzer.png') });
  await page.click('#dock [data-dock="serial"]');
  report('D-07: analyzer returns to body when the tab closes', await waitFor(page, () => document.querySelector('#analyzer')?.parentElement === document.body));
} else report('D-07: wifi example starts', false);

// ---- H-07 beginner lesson on a phone: 3D on top, step panel below (?beginner=1 overrides the tb-beginner=0 prelude for these visits)
for (const lang of ['en', 'zh', 'ja', 'ko']) {
  await page.goto(`${base}/app?work=weather&beginner=1&lang=${lang}#bench`, { waitUntil: 'load' });
  const up = await waitFor(page, () => !!document.querySelector('#dock[data-lesson] #lessonSheet'), null, 20000);
  report(`H-07 ${lang}: lesson panel shows in the dock`, up);
  if (!up) continue;
  const geo = await page.evaluate(() => {
    const st = document.getElementById('stage').getBoundingClientRect();
    const sh = document.getElementById('lessonSheet').getBoundingClientRect();
    return { stage: Math.round(st.height), sheetTop: Math.round(sh.top), stageBottom: Math.round(st.bottom) };
  });
  report(`H-07 ${lang}: 3D stage on top, panel below`, geo.stage >= 240 && geo.sheetTop >= geo.stageBottom - 24, JSON.stringify(geo));
  for (const s of ['#mLessonPrev', '#mLessonNext', '#mLessonOpen'])
    report(`H-07 ${lang}: ${s} tappable`, (await tappable(s)) === 'ok', await tappable(s));
  await waitFor(page, () => !!document.querySelector('#lessonCallouts [data-callout]'), null, 8000);
  const nCo = await page.$$eval('#lessonCallouts [data-callout]', (l) => l.length);
  report(`H-07 ${lang}: at most 2 callouts`, nCo >= 1 && nCo <= 2, `${nCo}`);
  await stepCheck(`H-07 ${lang} panel`);
  if (lang === 'en') {
    const st0 = await page.$eval('#lessonSheet', (e) => e.dataset.step);
    await page.click('#mLessonNext');
    const fwd = await waitFor(page, (s) => document.querySelector('#lessonSheet')?.dataset.step === String(+s + 1), st0, 3000);
    report('H-07: next moves one step', fwd, `${st0} -> ${await page.$eval('#lessonSheet', (e) => e.dataset.step)}`);
    const nCo1 = await page.$$eval('#lessonCallouts [data-callout]', (l) => l.length);
    report('H-07: still at most 2 callouts after next', nCo1 <= 2, `${nCo1}`);
    await page.click('#mLessonPrev');
    report('H-07: previous moves back', await waitFor(page, (s) => document.querySelector('#lessonSheet')?.dataset.step === s, st0, 3000));
  }
  // Pull the panel up: Lesson is the first tab and keeps the step (with its to-do list)
  await page.click(lang === 'en' ? '#sheetGrab' : '#mLessonOpen');
  const full = await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'full' && !!document.querySelector('#dock #lessonSheet'), null, 3000);
  const firstTab = await page.$eval('#dock [role="tablist"] [data-dock]', (e) => `${e.dataset.dock}:${e.getAttribute('aria-selected')}`).catch(() => 'none');
  report(`H-07 ${lang}: panel pulls up full with the Lesson tab first`, full && firstTab === 'lesson:true', firstTab);
  for (const s of ['#mLessonNext', '#sheetSize']) report(`H-07 ${lang} full: ${s} tappable`, (await tappable(s)) === 'ok', await tappable(s));
  await stepCheck(`H-07 ${lang} full`);
  if (lang === 'en') await page.screenshot({ path: path.join(outDir, 'mobile-lesson-full.png') });
  await page.click('#sheetSize');
  report(`H-07 ${lang}: collapse returns to the step panel`, await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'peek' && !!document.querySelector('#lessonSheet'), null, 3000));
  if (lang === 'en') await page.screenshot({ path: path.join(outDir, 'mobile-lesson.png') });
}

// ---- H-32 lesson schematic on a phone: the panel shrinks to its footer, the paper ends above it (before: 280 px stage, ~197 px of sheet)
await page.goto(`${base}/app?work=weather&cp=03&beginner=1&lang=en#bench`, { waitUntil: 'load' });
if (await waitFor(page, () => !!document.querySelector('#dock[data-lesson] #lessonSheet'), null, 20000)) {
  await page.tap('[data-mtool="more"]');
  await waitFor(page, () => !!document.querySelector('[data-tool="schematic"]'), null, 3000);
  await page.tap('[data-tool="schematic"]');
  const up = await waitFor(page, () => document.querySelector('#schematic')?.dataset.layout === 'phone' && !!document.querySelector('#schematicSvg') && document.querySelector('#lessonSheet')?.hasAttribute('data-footer'), null, 5000);
  await sleep(300);
  const g = await page.evaluate(() => {
    // Visible sheet = svg box clipped by the scrolling paper and the viewport
    const s = document.getElementById('schematicSvg').getBoundingClientRect();
    const p = document.getElementById('schematicPaper').getBoundingClientRect();
    const top = Math.max(s.top, p.top, 0), bottom = Math.min(s.bottom, p.bottom, innerHeight);
    const left = Math.max(s.left, p.left, 0), right = Math.min(s.right, p.right, innerWidth);
    const d = document.getElementById('dock').getBoundingClientRect();
    const ov = Math.max(0, Math.min(bottom, d.bottom) - Math.max(top, d.top)) * Math.max(0, Math.min(right, d.right) - Math.max(left, d.left));
    return { top: Math.round(top), bottom: Math.round(bottom), h: Math.round(bottom - top), w: Math.round(right - left), dockTop: Math.round(d.top), overlap: Math.round(ov), sheet: document.getElementById('dock').dataset.sheet };
  });
  report('H-32: schematic shown with the lesson panel as a footer', up, JSON.stringify(g));
  report('H-32: visible sheet does not meet the lesson panel', g.sheet === 'peek' && g.overlap === 0 && g.bottom <= g.dockTop, JSON.stringify(g));
  report('H-32: visible sheet ≥ 400 px tall, ≥ 300 px wide', g.h >= 400 && g.w >= 300, JSON.stringify(g));
  for (const s of ['#mLessonPrev', '#mLessonNext', '#mLessonOpen', '[data-view-seg="3d"]'])
    report(`H-32: ${s} tappable`, (await tappable(s)) === 'ok', await tappable(s));
  await stepCheck('H-32 schematic');
  await page.screenshot({ path: path.join(outDir, 'mobile-lesson-schematic.png') });
  // Pulled up, the panel shows the whole step again; back on 3D the H-07 split returns
  await page.tap('#mLessonOpen');
  report('H-32: full panel keeps the step text', await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'full' && !document.querySelector('#lessonSheet')?.hasAttribute('data-footer'), null, 3000));
  await page.tap('#sheetSize');
  await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'peek', null, 3000);
  await page.tap('[data-view-seg="3d"]');
  const back = await waitFor(page, () => !document.querySelector('#schematic') && !document.querySelector('#lessonSheet')?.hasAttribute('data-footer') && document.getElementById('stage').getBoundingClientRect().height < 320, null, 3000);
  report('H-32: back to 3D restores the step panel', back, `${await page.$eval('#stage', (e) => Math.round(e.getBoundingClientRect().height))}`);
} else report('H-32: lesson panel shows', false);

// ---- F-12 changelog (static page): filters scroll inside their row, tap targets, no page-level horizontal scroll
// ?lang=en: the static pages pick a locale before paint (F-12b), so pin English whatever the browser language is
await page.goto(`${base}/changelog?lang=en`, { waitUntil: 'load' });
report('Changelog: filters shown with JS', await waitFor(page, () => !document.getElementById('clFilter')?.hidden));
for (const f of ['all', 'new', 'improve', 'announce']) {
  await page.$eval(`[data-filter="${f}"]`, (e) => e.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
  report(`Changelog: filter ${f} tappable`, (await tappable(`[data-filter="${f}"]`)) === 'ok', await tappable(`[data-filter="${f}"]`));
}
await page.click('[data-filter="improve"]');
const shown = await page.$$eval('article[data-tag]', (l) => l.filter((a) => !a.hidden).map((a) => a.dataset.tag));
report('Changelog: Improved filter keeps only improve entries', shown.length > 0 && shown.every((t) => t === 'improve'), shown.join(','));
await stepCheck('Changelog');
await page.click('[data-filter="all"]');
report('Changelog: first entry link tappable', (await tappable('article .cl-cta')) === 'ok', await tappable('article .cl-cta'));
await page.screenshot({ path: path.join(outDir, 'mobile-changelog.png') });
// F-12b: locale copies (longer Japanese / Korean labels, CJK dates) keep the page inside 390 px too
for (const p of ['/changelog.ja', '/licenses.ko']) {
  await page.goto(`${base}${p}`, { waitUntil: 'load' });
  report(`${p}: localized page served`, await page.evaluate(() => document.documentElement.lang !== 'en' && !!document.querySelector('h1')));
  await stepCheck(p);
}

report('no external hosts requested', external.length === 0, external.slice(0, 3).join(' | '));
report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`[mobile] ${fails ? 'FAIL' : 'PASS'} (${fails} failed)`);
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
