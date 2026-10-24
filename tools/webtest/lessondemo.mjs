// Beginner "Show me how" (PLAN H-05): demo beats, controls, bench untouched, "I will wire it myself" ring states.
// Usage: node tools/webtest/lessondemo.mjs [dist]
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
  console.log(`[lessondemo] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const attr = (page, sel, k) => page.$eval(sel, (e, k) => e.getAttribute(k), k).catch(() => null);
const text = (page, sel) => page.$eval(sel, (e) => e.textContent).catch(() => '');
/** What the demo must never change: wiring edits, scene parts and the wire table rows */
const bench = (page) =>
  page.evaluate(() => {
    const s = globalThis.__tbApp.session;
    const m = s.wireMods; return JSON.stringify({ drop: m.drop ?? [], rt: m.retarget ?? {}, parts: s.scene.parts.length, rows: document.querySelectorAll('#wireTable [data-wire]').length });
  });
/** Real mouse click on a pin ring once it stops moving (the camera eases), as wiremode.mjs does */
async function clickRing(page, id) {
  const at = () => page.$eval(`#pinRings [data-ring="${id}"]`, (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  let b = await at();
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const c = await at();
    const still = Math.abs(c[0] - b[0]) < 0.5 && Math.abs(c[1] - b[1]) < 0.5;
    b = c;
    if (still) break;
  }
  b = await page.$eval(`#pinRings [data-ring="${id}"]`, (e, c) => {
    const r = e.getBoundingClientRect();
    for (const k of [0, 0.25, 0.4])
      for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const x = c[0] + dx * k * r.width, y = c[1] + dy * k * r.height;
        if (document.elementFromPoint(x, y)?.closest('[data-ring]') === e) return [x, y];
      }
    return c;
  }, b);
  await page.mouse.click(b[0], b[1]);
}

const page = await open('/app?work=weather&debug=1&beginner=1#bench');
if (await has(page, '[data-left="wires"]')) await page.click('[data-left="wires"]');
await page.click('#lessonSteps [data-step="2"]');
await waitFor(page, () => document.querySelector('#lessonCard')?.dataset.step === '2', null, 3000);
report('step 3 card has "Show me how"', await has(page, '#lessonDemoBtn'));
report('left lesson card keeps #cpGo', /Show me how/.test(await text(page, '#lessonCp #cpGo')));
const before = await bench(page);

// 1. Play: four beats, one at a time
await page.click('#lessonDemoBtn');
const up = await waitFor(page, () => document.querySelector('#lessonDemo')?.dataset.beat === '1', null, 3000);
report('demo opens on beat 1', up && /Find GPIO5/.test(await text(page, '#lessonDemoTitle')), await text(page, '#lessonDemoTitle'));
report('badge: bench not changed', /bench won't be changed/.test(await text(page, '#lessonDemoBadge')));
report('stage marks the demo', (await attr(page, '#stage', 'data-lesson-demo')) === 'play');
report('control buttons >= 44px', await page.$$eval('#lessonDemo [data-demo]', (bs) => bs.length === 6 && bs.every((b) => b.getBoundingClientRect().height >= 44)));
await page.click('[data-demo="play"]');
report('pause', (await attr(page, '#lessonDemo', 'data-paused')) === '1' && (await attr(page, '[data-demo="play"]', 'aria-label')) === 'Resume');
await page.click('[data-demo="slow"]');
report('0.5x', (await attr(page, '#lessonDemo', 'data-speed')) === '0.5' && (await attr(page, '[data-demo="slow"]', 'aria-pressed')) === 'true');
await sleep(1200);
await page.screenshot({ path: path.join(outDir, 'lessondemo-1.png') });
const titles = [/Orange wire/, /Black wire/, /closed loop/];
for (let n = 2; n <= 4; n++) {
  await page.click('[data-demo="next"]');
  await waitFor(page, (n) => document.querySelector('#lessonDemo')?.dataset.beat === String(n), n, 3000);
  report(`next -> beat ${n}`, (await attr(page, '#lessonDemo', 'data-beat')) === String(n) && titles[n - 2].test(await text(page, '#lessonDemoTitle')), await text(page, '#lessonDemoTitle'));
  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, `lessondemo-${n}.png`) });
}
report('paused demo stays on the last beat', (await attr(page, '#lessonDemo', 'data-beat')) === '4');
report('last beat shows current', !!(await attr(page, '#stage', 'data-flow')));
report('next disabled on the last beat', await page.$eval('[data-demo="next"]', (e) => e.disabled));
await page.click('[data-demo="prev"]');
report('prev -> beat 3', (await attr(page, '#lessonDemo', 'data-beat')) === '3');
await sleep(300);
report('leaving the current beat turns current back off', !(await attr(page, '#stage', 'data-flow')));
report('bench wiring unchanged by the demo', (await bench(page)) === before, await bench(page));

// 2. Resume at 1x: the clock moves on by itself
await page.click('[data-demo="slow"]');
await page.click('[data-demo-seg="1"]');
await page.click('[data-demo="play"]');
const auto = await waitFor(page, () => document.querySelector('#lessonDemo')?.dataset.beat === '2', null, 9000);
report('playing advances to the next beat', auto && (await attr(page, '#lessonDemo', 'data-paused')) === '0');

// 3. "I'll wire it myself": demo gone, one target ring; the bench already has this wire
await page.click('[data-demo="self"]');
await waitFor(page, () => !!document.querySelector('#lessonSelf [data-self-ring]'), null, 3000);
report('self: demo closed, ring on GPIO5', !(await has(page, '#lessonDemo')) && (await attr(page, '#lessonSelf [data-self-ring]', 'data-self-ring')) === 'GPIO5');
report('self: wire already there -> says so, offers unplug', (await attr(page, '#lessonSelf', 'data-state')) === 'set' && /already connected/.test(await text(page, '#lessonSelfHint')) && (await has(page, '[data-demo="unplug"]')));
report('self: bench still unchanged', (await bench(page)) === before && !(await attr(page, '#stage', 'data-flow')));
const ringVis = await page.$eval('#lessonSelf [data-self-ring]', (e) => !e.hidden && e.getBoundingClientRect().width > 0);
report('self: ring visible', ringVis);
await page.screenshot({ path: path.join(outDir, 'lessondemo-self.png') });
await page.click('[data-demo="unplug"]');
await waitFor(page, () => document.querySelector('#lessonSelf')?.dataset.state === 'todo', null, 3000);
report('unplug -> ring waits (blue)', (await attr(page, '#lessonSelf', 'data-state')) === 'todo');
await page.click('[data-demo="plug"]');
await waitFor(page, () => document.querySelectorAll('#pinRings [data-ring]').length > 10, null, 3000);
await clickRing(page, 'GPIO6');
await waitFor(page, () => document.querySelector('#lessonSelf')?.dataset.state === 'wrong', null, 3000);
const wrong = await text(page, '#lessonSelfHint');
report('neighbour pin -> "one column" hint', (await attr(page, '#lessonSelf', 'data-state')) === 'wrong' && /One column/.test(wrong), wrong);
await page.screenshot({ path: path.join(outDir, 'lessondemo-wrong.png') });
if (await has(page, '[data-ww="keep"]')) await page.click('[data-ww="keep"]');
await page.click('[data-demo="plug"]');
await waitFor(page, () => document.querySelectorAll('#pinRings [data-ring]').length > 10, null, 3000);
await clickRing(page, 'GPIO5');
await waitFor(page, () => document.querySelector('#lessonSelf')?.dataset.state === 'ok', null, 3000);
report('right pin -> ring turns green', (await attr(page, '#lessonSelf [data-self-ring]', 'data-state')) === 'ok', await text(page, '#lessonSelfHint'));
await page.screenshot({ path: path.join(outDir, 'lessondemo-ok.png') });
await page.click('[data-demo="done"]');
report('done closes the ring', !(await has(page, '#lessonSelf')) && !(await attr(page, '#stage', 'data-lesson-demo')));
report('wiring back to the original', (await bench(page)) === before, await bench(page));

// 4. #cpGo opens the demo too; Escape leaves it
await page.click('#lessonCp #cpGo');
report('#cpGo opens the demo', await waitFor(page, () => document.querySelector('#lessonDemo')?.dataset.beat === '1', null, 3000));
await page.keyboard.press('Escape');
report('Escape exits', await waitFor(page, () => !document.querySelector('#lessonDemo'), null, 2000));
await page.close();

// 5. Beginner mode off: today's checkpoint card and Show me, no demo button
const off = await open('/app?work=weather&debug=1&beginner=0#bench');
report('off: no demo UI', !(await has(off, '#lessonDemoBtn')) && !(await has(off, '#lessonDemo')) && (await has(off, '#cpCard #cpGo')));
await off.click('#cpGo');
await sleep(500);
report('off: Show me only selects / frames', !(await has(off, '#lessonDemo')));
await off.close();

report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails ? `[lessondemo] ${fails} FAIL` : '[lessondemo] all PASS');
process.exit(fails ? 1 : 0);
