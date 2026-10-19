// Advisor v3 (U-15, DESIGN_V2 §8.2): Just-now line + undo, share link, brief without commands, main button URL, mobile, zero boards.
// Usage: node tools/webtest/selectv3.mjs [dist dir, default web/dist]; screenshots in Reviews/web/selectv3-*
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
  args: ['--window-size=1440,900'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[selectv3] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(80);
  }
  return false;
}
const errors = [];
async function open(url, vp) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // The clipboard needs permissions in headless mode, so record writes instead
  await page.evaluateOnNewDocument(() => {
    globalThis.__clip = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => (globalThis.__clip.push(t), Promise.resolve()) }, configurable: true });
  });
  await page.goto(base + url);
  await waitFor(page, () => !!document.querySelector('#templates') && !!globalThis.__tbSelect);
  return page;
}
const S = (page) => page.evaluate(() => globalThis.__tbSelect);
const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const DESK = { width: 1440, height: 900 };

// ---------------------------------------------------------------- ① Just now + undo
{
  const page = await open('/select?t=weather', DESK);
  const s0 = await S(page);
  report('old link ?t=weather opens the weather station', s0.state.t === 'weather' && /XIAO/.test(await page.$eval('#boardName', (e) => e.textContent)));
  report('no Just-now line at first', !(await page.$('#recent')));
  await click(page, '[data-part="buzzer"]');
  await waitFor(page, () => !!document.querySelector('#recent'));
  const t1 = await page.$eval('#recentText', (e) => e.textContent);
  report('add buzzer -> Just now states recommendation, pin, price change', /^Added buzzer → recommendation unchanged; uses 1 more pin \S+; reference price \+¥/i.test(t1), t1);
  report('URL follows (replaceState)', await page.evaluate(() => new URLSearchParams(location.search).get('add') === 'buzzer'));
  await click(page, '[data-q="bat"]');
  await waitFor(page, () => /No battery/.test(document.querySelector('#recentText')?.textContent));
  const t2 = await page.$eval('#recentText', (e) => e.textContent);
  report('turn off battery -> recommends another board with the price change', /^No battery → recommendation changes to .+; reference price [+−]¥/.test(t2), t2);
  await click(page, '[data-budget="60"]');
  await waitFor(page, () => /Budget ¥60/.test(document.querySelector('#recentText')?.textContent));
  await click(page, '#undo');
  await click(page, '#undo');
  await waitFor(page, () => /Added buzzer/i.test(document.querySelector('#recentText')?.textContent));
  report('two undos in a row return to Added buzzer', (await S(page)).state.bat === null && (await S(page)).state.budget === 0);
  await click(page, '#undo');
  await waitFor(page, () => !document.querySelector('#recent'));
  const s1 = await S(page);
  report('one more undo -> state, URL and verdict as at the start', JSON.stringify(s1.state) === JSON.stringify(s0.state) && (await page.evaluate(() => location.search)) === '?t=weather' && s1.brief === s0.brief);
  // I have it: not on the undo stack, stored locally, only in the shopping link
  await click(page, '[data-have="bme280"]');
  await waitFor(page, () => globalThis.__tbSelect.have.includes('bme280'));
  report('I have it shows no Just-now line and is stored locally', !(await page.$('#recent')) && (await page.evaluate(() => JSON.parse(localStorage.getItem('tryboard-have') || '[]').includes('bme280'))));
  // Terms: only the first occurrence is marked; the popover opens and Esc closes it
  const terms = await page.$$eval('[data-term]', (es) => es.map((e) => e.dataset.term));
  report('terms marked only on first occurrence', terms.length > 0 && new Set(terms).size === terms.length, terms.join(','));
  await page.focus('[data-term="I2C"]');
  await page.keyboard.press('Enter');
  const pop = await waitFor(page, () => /For your project: .*D4/.test(document.querySelector('[data-term-pop="I2C"]')?.textContent ?? ''));
  report('keyboard opens the I2C explanation, two sentences incl. For your project', pop, await page.evaluate(() => document.querySelector('[data-term-pop="I2C"]')?.textContent));
  await page.keyboard.press('Escape');
  report('Esc closes the explanation', await waitFor(page, () => !document.querySelector('[data-term-pop="I2C"]')));
  // All details
  await click(page, '#detailsBtn');
  report('all details: pin table, power breakdown, real board only, basis', await waitFor(page, () => ['Pin table', 'Power breakdown', 'Real board only', 'Basis'].every((t) => document.querySelector('#details')?.textContent.includes(t))));
  report('confidence shown only as icons (no old coloured badges)', (await page.$$('[data-conf]')).length >= 8 && !(await page.$('.conf.font-bold')));
  await page.screenshot({ path: path.join(outDir, 'selectv3-desktop.png'), fullPage: true });
  await page.close();
}

// ---------------------------------------------------------------- ② Share link ③ brief ④ main button
{
  const page = await open('/select?t=weather', DESK);
  await click(page, '[data-part="buzzer"]');
  await click(page, '[data-budget="120"]');
  await waitFor(page, () => /Budget ¥120/.test(document.querySelector('#recentText')?.textContent));
  // Click the second board in the comparison
  const second = await page.$$eval('#compare [data-board]', (es) => es[1]?.dataset.board);
  await click(page, `#compare [data-board="${second}"]`);
  await waitFor(page, (b) => globalThis.__tbSelect.state.board === b, second);
  await click(page, '[data-have="oled"]');
  await waitFor(page, () => globalThis.__tbSelect.have.includes('oled'));
  const a = await S(page);
  const nameA = await page.$eval('#boardName', (e) => e.textContent);
  await click(page, '#share');
  await waitFor(page, () => globalThis.__clip.length > 0);
  const shared = await page.evaluate(() => globalThis.__clip.at(-1));
  report('share link = address bar, without I have it', shared === (await page.evaluate(() => location.href)) && !/have=/.test(shared), shared);

  // ③ Brief
  await click(page, '#copyBrief');
  await waitFor(page, () => globalThis.__clip.length > 1);
  const copied = await page.evaluate(() => globalThis.__clip.at(-1));
  const shown = await page.$eval('#briefText', (e) => e.textContent);
  report('copied brief = brief on the page', copied === a.brief && shown === a.brief);
  report('brief has no npx / command lines', !/npx|idf\.py|tryboard run|\$ /.test(copied));
  report('brief has four sections + checkpoints + local package last line', ['## Hardware', '## Pins', '## Requirements', '## Acceptance'].every((h) => copied.includes(h)) && /1\. Boots without crashing, prints to serial/.test(copied) && /I2C 0x76 responds \(BME280\)/.test(copied) && copied.trim().endsWith('To run offline, install packages/tryboard locally from the repo'));

  // ④ Main button
  const href = await page.$eval('#go', (e) => e.getAttribute('href'));
  const q = new URLSearchParams(href.split('?')[1].split('#')[0]);
  const st = a.state;
  const want = { t: st.t, add: st.add.join(','), budget: String(st.budget), board: second, have: a.have.join(',') };
  const bad = Object.entries(want).filter(([k, v]) => (q.get(k) ?? '') !== v);
  report('main button ./app?work=custom…#shop, params match the page', href.startsWith('./app?work=custom') && href.endsWith('#shop') && bad.length === 0 && !q.has('bat') && !q.has('net'), href);
  report('main button text', /Start building with this →/.test(await page.$eval('#go', (e) => e.textContent)) && /Go to shopping, list filled in/.test(await page.$eval('#go', (e) => e.textContent)));
  await page.close();

  // ② Open the share link in a new page
  const p2 = await open(shared.replace(/^https?:\/\/[^/]+/, ''), DESK);
  const b = await S(p2);
  report('share link gives the same verdict', (await p2.$eval('#boardName', (e) => e.textContent)) === nameA && b.brief === a.brief && JSON.stringify(b.state) === JSON.stringify(a.state), nameA);
  await p2.close();
}

// ---------------------------------------------------------------- Zero boards
{
  const page = await open('/select?t=weather&req=bt_classic&budget=60', DESK);
  const opts = await page.$$eval('[data-relax]', (es) => es.map((e) => e.textContent));
  report('zero boards: offers Drop X -> N boards and a looser budget', !!(await page.$('#none')) && opts.some((t) => /^Drop/.test(t)) && opts.some((t) => /budget/i.test(t)), opts.join(' | '));
  await click(page, '[data-relax]');
  report('one click gives a board and can be undone', (await waitFor(page, () => !!document.querySelector('#boardName'))) && !!(await page.$('#undo')));
  await page.close();
}

// ---------------------------------------------------------------- Boards that cannot be simulated: still clickable, runs on a C3 instead
{
  const page = await open('/select?t=weather', DESK);
  const c6 = await page.$$eval('#compare [data-board]', (es) => es.find((e) => /Not yet · runs on a C3 instead/.test(e.textContent))?.dataset.board);
  report('comparison marks unsimulated boards Not yet · runs on a C3 instead', !!c6, c6);
  if (c6) {
    await click(page, `#compare [data-board="${c6}"]`);
    await waitFor(page, (b) => globalThis.__tbSelect.state.board === b, c6);
    report('click it -> answer switches board, firmware marked real board only', (await page.$eval('[data-stat="sim"] [data-conf]', (e) => e.dataset.conf)) === '必须上真机' /* lint: allow-cjk (conf id) */ && /instead/.test(await page.$eval('#reason', (e) => e.textContent)));
  }
  await page.close();
}

// ---------------------------------------------------------------- ⑤ Mobile
{
  const page = await open('/select?t=weather', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const tappable = (sel) =>
    page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return 'missing';
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return 'hidden';
      if (r.height < 43.5) return `h=${r.height}`;
      if (r.left < -0.5 || r.right > innerWidth + 0.5) return `x=${r.left}..${r.right}`;
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top && (top === e || e.contains(top)) ? 'ok' : `covered by ${top?.id || top?.className}`;
    }, sel);
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 0.5);
  report('mobile: no horizontal scroll', await noHScroll());
  for (const sel of ['#go', '#mobileBar #share', '[data-t="weather"]', '[data-edit="parts"]', '[data-edit="qs"]']) report(`mobile: ${sel} ≥ 44px tappable`, (await tappable(sel)) === 'ok', await tappable(sel));
  await click(page, '[data-edit="qs"]');
  for (const sel of ['[data-q="bat"]', '[data-budget="60"]', '#moreReq']) report(`mobile: ${sel} ≥ 44px tappable`, (await tappable(sel)) === 'ok', await tappable(sel));
  await click(page, '[data-edit="parts"]');
  for (const sel of ['[data-part="buzzer"]', '[data-have="bme280"]', '#addPart']) report(`mobile: ${sel} ≥ 44px tappable`, (await tappable(sel)) === 'ok', await tappable(sel));
  await click(page, '[data-part="buzzer"]');
  report('mobile: changing parts shows Just now', await waitFor(page, () => /Added buzzer/i.test(document.querySelector('#recentText')?.textContent)));
  report('mobile: #undo ≥ 44px', (await tappable('#undo')) === 'ok', await tappable('#undo'));
  await click(page, '#detailsBtn');
  report('mobile: no horizontal scroll with details open', await noHScroll());
  await click(page, '[data-term="I2C"]');
  report('mobile: terms open as a bottom sheet', await waitFor(page, () => {
    const e = document.querySelector('[data-term-pop="I2C"]');
    return e && Math.abs(e.getBoundingClientRect().bottom - innerHeight) < 2;
  }));
  await page.keyboard.press('Escape');
  report('mobile: Esc closes the sheet', await waitFor(page, () => !document.querySelector('[data-term-pop="I2C"]')));
  report('mobile: three boards as swipe cards', await page.evaluate(() => [...document.querySelectorAll('#compare [data-board]')].every((e) => Math.round(e.getBoundingClientRect().width) === 300)));
  await page.screenshot({ path: path.join(outDir, 'selectv3-mobile.png'), fullPage: true });
  await page.close();
}

report('no errors throughout', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails ? `[selectv3] FAIL (${fails} failed)` : '[selectv3] PASS (0 failed)');
process.exit(fails ? 1 : 0);
