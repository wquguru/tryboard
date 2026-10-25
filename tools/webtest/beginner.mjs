// Beginner mode (H-01): weather lesson 01 steps, step card, short toolbar, switch off == today's bench, phone width.
// Usage: node tools/webtest/beginner.mjs [dist dir, default web/dist]; screenshots in Reviews/web/beginner-*
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
  console.log(`[beginner] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const tools = (page) => page.$$eval('#toolbar [data-tool]', (bs) => bs.map((b) => b.dataset.tool).join(','));
const has = (page, sel) => page.$(sel).then(Boolean);
const cardStep = (page) => page.$eval('#lessonCard', (e) => e.dataset.step).catch(() => null);
const states = (page) => page.$$eval('#lessonSteps [data-step]', (bs) => bs.map((b) => b.dataset.state).join(','));

// 1. Baseline: the stored choice is off, so the bench is exactly today's
const off = await open('/app?work=weather&debug=1#bench', () => localStorage.setItem('tb-beginner', '0'));
const offTools = await tools(off);
const offLeft = await off.$eval('#cpCard', (e) => e.textContent).catch(() => null);
report('off: checkpoint card, no lesson UI', !!offLeft && !(await has(off, '#lessonSteps')) && !(await has(off, '#lessonCard')) && !(await has(off, '#lessonTitle')));
report('off: switch present, unchecked', (await off.$eval('#beginnerBtn', (e) => e.getAttribute('aria-checked')).catch(() => null)) === 'false');
await off.close();

// 2. New visitor: on by default
const page = await open('/app?work=weather&debug=1#bench');
report('default on: steps / card / title', (await has(page, '#lessonSteps')) && (await has(page, '#lessonCard')) && (await has(page, '#lessonTitle')));
const title = await page.$eval('#lessonTitle', (e) => e.textContent).catch(() => '');
report('title names lesson 1', /Lesson 1/.test(title) && /Light up an LED/.test(title), JSON.stringify(title));
report('switch checked', (await page.$eval('#beginnerBtn', (e) => e.getAttribute('aria-checked'))) === 'true');
// H-11: with a lesson the dock keeps three tabs plus #dockMore; the rest are reachable through it
const dockTabs = (pg) => pg.$$eval('#dock [role="tab"][data-dock]', (bs) => bs.map((b) => b.dataset.dock).join(','));
report('H-11 on: dock = lesson,serial,code + #dockMore', (await dockTabs(page)) === 'lesson,serial,code' && (await has(page, '#dockMore')), await dockTabs(page));
await page.click('#dockMore');
const moreItems = await page.$$eval('#dockMoreMenu [data-more-tab]', (bs) => bs.map((b) => b.dataset.moreTab));
report('H-11 on: menu lists checks / issues', moreItems.includes('checks') && moreItems.includes('issues'), moreItems.join(','));
await page.click('#dockMoreMenu [data-more-tab="checks"]');
report('H-11 on: picking Checkpoints switches the dock', await waitFor(page, () => document.querySelector('#dock')?.dataset.tab === 'checks' && /More: /.test(document.querySelector('#dockMore')?.textContent || ''), null, 3000));
await page.click('#dock [data-dock="lesson"]');
report('five steps, first current', (await states(page)) === 'now,todo,todo,todo,todo', await states(page));
report('pass criteria folded in details', await page.$eval('#lessonCp details', (d) => !d.open).catch(() => false));
const short = await tools(page);
report('short toolbar', short === 'run,current,select,orbit,fit,button,more', short);
report('Previous disabled on step 1', await page.$eval('#lessonPrev', (e) => e.disabled));
// H-02 callouts: cards for the step, inside the viewport, leader end follows the camera
const callouts = (pg) =>
  pg.$$eval('#lessonCallouts [data-callout]', (cs) =>
    cs
      .filter((c) => c.style.display !== 'none')
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { key: c.dataset.callout, x: +c.dataset.x, y: +c.dataset.y, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0 };
      }),
  ).catch(() => []);
await waitFor(page, () => document.querySelectorAll('#lessonCallouts [data-callout][data-x]').length >= 3, null, 5000);
const co1 = await callouts(page);
report('callouts: step 1 has chip / gpio / usb in view', co1.map((c) => c.key).sort().join(',') === 'chip,gpio,usb' && co1.every((c) => c.inView), JSON.stringify(co1));
const spots = new Set(co1.map((c) => `${Math.round(c.x / 4)},${Math.round(c.y / 4)}`));
report('callouts: each points at its own spot', spots.size === co1.length);
await page.click('#toolbar [data-tool="orbit"]');
const st = await page.$eval('#stage', (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await page.mouse.move(st[0], st[1]);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(st[0] + i * 18, st[1] + i * 4);
await page.mouse.up();
await sleep(600);
const co2 = await callouts(page);
const moved = co1.filter((a) => { const b = co2.find((x) => x.key === a.key); return b && Math.hypot(b.x - a.x, b.y - a.y) > 10; }).length;
report('callouts: leaders follow the camera', moved >= 2, JSON.stringify(co2));
await page.click('#toolbar [data-tool="fit"]');
await page.click('#toolbar [data-tool="select"]');
await sleep(400);
await page.click('#lessonCallouts [data-callout="gpio"]');
const sel = await waitFor(page, () => JSON.stringify(globalThis.__tbApp.store.get().selection) === JSON.stringify({ kind: 'pin', id: 'GPIO5' }), null, 3000);
report('callouts: clicking a card selects its pin', sel);
await page.screenshot({ path: path.join(outDir, 'beginner-1.png') });

// 3. Walk the five steps with Next
for (let i = 1; i < 5; i++) {
  await page.click('#lessonNext');
  await waitFor(page, (n) => document.querySelector('#lessonCard')?.dataset.step === String(n), i, 3000);
  report(`next -> step ${i + 1}`, (await cardStep(page)) === String(i), `card=${await cardStep(page)} states=${await states(page)}`);
  const want = [3, 2, 3, 2, 1][i];
  await waitFor(page, (n) => document.querySelectorAll('#lessonCallouts [data-callout]').length === n, want, 3000);
  await sleep(300);
  const co = await callouts(page);
  report(`step ${i + 1}: ${want} callouts projected`, co.length === want && co.every((c) => c.inView), JSON.stringify(co));
}
await page.click('#lessonPrev');
await waitFor(page, () => document.querySelector('#lessonCard')?.dataset.step === '3', null, 3000);
report('previous goes back', (await cardStep(page)) === '3' && (await has(page, '#lessonRun')), `card=${await cardStep(page)}`);
// H-04 Show current: before the lesson's code runs the loop is drawn as if GPIO5 were high, with a note
const flow = (page) => page.$eval('#stage', (e) => ({ f: e.dataset.flow ?? null, n: Number(e.dataset.flowSegs ?? 0) }));
report('current: off by default', (await flow(page)).f === null && !(await has(page, '#flowNote')));
await page.click('#toolbar [data-tool="current"]');
await waitFor(page, () => !!document.querySelector('#stage')?.dataset.flow, null, 3000);
const fa = await flow(page);
report('current: assumed high before run', fa.f === 'assumed' && fa.n > 0 && (await has(page, '#flowNote')), JSON.stringify(fa));
report('current: switch pressed', (await page.$eval('#toolbar [data-tool="current"]', (e) => e.getAttribute('aria-pressed'))) === 'true');
await page.click('#lessonRun');
const ran = await waitFor(page, () => /s3-blink/.test(document.querySelector('#toast')?.textContent ?? ''), null, 8000);
report('run loads the lesson firmware', ran);
const fOn = await waitFor(page, () => { const e = document.querySelector('#stage'); return e?.dataset.flow === 'on' && Number(e.dataset.flowSegs) > 0; }, null, 8000);
const fOff = await waitFor(page, () => document.querySelector('#stage')?.dataset.flow === 'off', null, 4000);
const fOn2 = await waitFor(page, () => document.querySelector('#stage')?.dataset.flow === 'on', null, 4000);
report('current: follows GPIO5 on / off while running', fOn && fOff && fOn2 && !(await has(page, '#flowNote')));
await page.click('#toolbar [data-tool="current"]');
await waitFor(page, () => !document.querySelector('#stage')?.dataset.flow, null, 3000);
report('current: switch off clears', (await flow(page)).f === null);
const live = await waitFor(page, () => /Now: (high 3\.3 V|low 0 V)/.test(document.querySelector('[data-callout="gpio"] [data-live]')?.textContent ?? ''), null, 8000);
report('callouts: GPIO card shows the live level', live);
await page.click('#lessonSteps [data-step="4"]');
await waitFor(page, () => document.querySelector('#lessonCard')?.dataset.step === '4', null, 3000);
report('step list is clickable', (await cardStep(page)) === '4' && !(await has(page, '#lessonRun')));
await page.click('#lessonNext');
await waitFor(page, () => document.querySelector('#lessonCard')?.dataset.step === 'done', null, 3000);
report('finished: no callouts', !(await has(page, '#lessonCallouts')));
report('finish marks all steps done', (await cardStep(page)) === 'done' && (await states(page)) === 'done,done,done,done,done', await states(page));
const saved = await page.evaluate(() => localStorage.getItem('tryboard-app-lesson:weather'));
report('progress stored per work', saved === '{"01":5}', saved);
await page.click('#lessonSteps [data-step="2"]');
await page.reload({ waitUntil: 'load' });
await waitFor(page, () => !!document.querySelector('#lessonCard'), null, 30000);
report('progress survives reload', (await cardStep(page)) === '2', `card=${await cardStep(page)}`);

// 4. More tools expands to the full set and back
await page.click('#toolbar [data-tool="more"]');
await waitFor(page, (n) => document.querySelectorAll('#toolbar [data-tool]').length > n, 7, 3000);
const full = await tools(page);
report('more tools: full set + fewer', full === offTools + ',more', full);
await page.click('#toolbar [data-tool="more"]');
await waitFor(page, () => document.querySelectorAll('#toolbar [data-tool]').length === 7, null, 3000);
report('fewer tools: short again', (await tools(page)) === short);

// 5. Switch off: identical to the baseline, choice remembered (Show current left on is cleared with it)
await page.click('#toolbar [data-tool="current"]');
await waitFor(page, () => !!document.querySelector('#stage')?.dataset.flow, null, 3000);
await page.click('#beginnerBtn');
await waitFor(page, () => !document.querySelector('#lessonSteps') && !!document.querySelector('#cpCard'), null, 3000);
report('switch off: no current flow', await waitFor(page, () => !document.querySelector('#stage')?.dataset.flow && !document.querySelector('#flowNote'), null, 3000));
report('switch off: toolbar == baseline', (await tools(page)) === offTools, await tools(page));
const left = await page.$eval('#cpCard', (e) => e.textContent).catch(() => null);
report('switch off: checkpoint card == baseline', left === offLeft);
report('H-11 off: dock tabs restored, no #dockMore', (await page.$$eval('#dock [role="tab"][data-dock]', (bs) => bs.length)) > 3 && !(await has(page, '#dockMore')));
report('H-11 off: top-bar firmware button back', await page.$eval('#swapFw', (e) => !e.hidden).catch(() => false));
report('switch off: no lesson UI', !(await has(page, '#lessonCard')) && !(await has(page, '#lessonTitle')) && !(await has(page, '#lessonCallouts')));
// The search box was only hidden during the lesson: the same bound input is back and its list still opens
await page.click('#cmdk');
report('switch off: search still works', await waitFor(page, () => !!document.querySelector('#cmdk')?.offsetWidth && !!document.querySelector('#cmdkList')?.offsetHeight, null, 3000));
await page.keyboard.press('Escape');
report('choice stored', (await page.evaluate(() => localStorage.getItem('tb-beginner'))) === '0');
await page.click('#beginnerBtn');
await waitFor(page, () => !!document.querySelector('#lessonSteps'), null, 3000);
report('switch on again', (await cardStep(page)) === '2' && (await tools(page)) === short);
await page.screenshot({ path: path.join(outDir, 'beginner-2.png') });
await page.close();

// 5b. H-08: checkpoints 02 / 03 bring their own lessons (Button, OLED); 03 has no "Show current" loop
for (const [cp, re, tl] of [
  ['02', /Lesson 2/, 'run,current,select,orbit,fit,button,more'],
  ['03', /Lesson 3/, 'run,select,orbit,fit,button,more'],
]) {
  const pg = await open(`/app?work=weather&cp=${cp}&debug=1&beginner=1#bench`);
  await waitFor(pg, () => !!document.querySelector('#lessonTitle'), null, 10000);
  const tt = await pg.$eval('#lessonTitle', (e) => e.textContent).catch(() => '');
  const cpText = await pg.$eval('#lessonCp', (e) => e.textContent).catch(() => '');
  report(`checkpoint ${cp}: lesson in the left column + top bar`, re.test(tt) && (await states(pg)) === 'now,todo,todo,todo,todo' && cpText.includes(`Checkpoint ${cp}`), JSON.stringify(tt));
  report(`checkpoint ${cp}: short toolbar`, (await tools(pg)) === tl, await tools(pg));
  await pg.close();
}

// 6. Other works keep the switch but have no lesson
const door = await open('/app?work=door&debug=1&beginner=1#bench');
report('other work: switch, no lesson', (await has(door, '#beginnerBtn')) && !(await has(door, '#lessonSteps')) && (await tools(door)) !== short);
await door.close();

// 7. Phone 390x844 with beginner on: no horizontal scroll
const ph = await open('/app?work=weather&debug=1&beginner=1#bench', null, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await sleep(800);
const sw = await ph.evaluate(() => document.documentElement.scrollWidth);
report('phone: no horizontal scroll', sw <= 390, `scrollWidth=${sw}`);
report('phone: unchanged until H-07', !(await has(ph, '#lessonSteps')) && !(await has(ph, '#lessonTitle')));
await ph.screenshot({ path: path.join(outDir, 'beginner-phone.png') });
await ph.close();

report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails ? `[beginner] ${fails} FAIL` : '[beginner] all PASS');
process.exit(fails ? 1 : 0);
