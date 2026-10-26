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
report('short toolbar', short === 'run,current,select,orbit,fit,button,view3d,schematic,more', short);
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
// H-10: running the lesson's code ticks the run task with what was detected; opening the "Check" answer ticks it too
const task = (page, i) => page.$eval(`#lessonCard li[data-task="${i}"]`, (e) => ({ done: e.dataset.done, text: e.querySelector('[data-detected]')?.textContent ?? '' })).catch(() => null);
const ranTick = await waitFor(page, () => document.querySelector('#lessonCard li[data-task="0"]')?.dataset.done === '1', null, 8000);
report('H-10 run: task ticked with the detected value', ranTick && /Detected/.test((await task(page, 0))?.text), JSON.stringify(await task(page, 0)));
report('H-10 run: next not ready yet', (await page.$eval('#lessonNext', (e) => e.dataset.ready)) === '0' && !(await has(page, '#lessonStepDone')));
await page.click('#lessonCard [data-reveal="1"]');
await waitFor(page, () => document.querySelector('#lessonCard li[data-task="1"]')?.dataset.done === '1', null, 3000);
report('H-10 reveal: opening the answer ticks it', (await task(page, 1))?.done === '1' && (await has(page, '#lessonCard [data-answer]')));
report('H-10 step done: next highlighted + green bar', (await page.$eval('#lessonNext', (e) => e.dataset.ready)) === '1' && (await has(page, '#lessonStepDone')) && (await cardStep(page)) === '3');
await page.screenshot({ path: path.join(outDir, 'beginner-h10-stepdone.png') });
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
// H-10: delay chip 100 ticks "Change 500 to 100" and names both values
report('H-10 delay: task waiting before the chip', (await task(page, 0))?.done === '0');
await waitFor(page, () => !!document.querySelector('#codeBody [data-chip="100"]'), null, 8000);
await page.click('#codeBody [data-chip="100"]');
await waitFor(page, () => document.querySelector('#lessonCard li[data-task="0"]')?.dataset.done === '1', null, 3000);
const dt = await task(page, 0);
report('H-10 delay: chip 100 ticks the task', dt?.done === '1' && /500.*100/.test(dt.text), JSON.stringify(dt));
const tsaved = await page.evaluate(() => JSON.parse(localStorage.getItem('tryboard-app-lesson-tasks:weather') ?? '{}'));
report('H-10 ticks stored per work + checkpoint + step', !!tsaved['01']?.['3']?.['0'] && !!tsaved['01']?.['4']?.['0'], JSON.stringify(tsaved));
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
await waitFor(page, (n) => document.querySelectorAll('#toolbar [data-tool]').length > n, 9, 3000);
const full = await tools(page);
report('more tools: full set + fewer', full === offTools + ',more', full);
await page.click('#toolbar [data-tool="more"]');
await waitFor(page, () => document.querySelectorAll('#toolbar [data-tool]').length === 9, null, 3000);
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
  ['02', /Lesson 2/, 'run,current,select,orbit,fit,button,view3d,schematic,more'],
  ['03', /Lesson 3/, 'run,select,orbit,fit,button,view3d,schematic,more'],
]) {
  const pg = await open(`/app?work=weather&cp=${cp}&debug=1&beginner=1#bench`);
  await waitFor(pg, () => !!document.querySelector('#lessonTitle'), null, 10000);
  const tt = await pg.$eval('#lessonTitle', (e) => e.textContent).catch(() => '');
  const cpText = await pg.$eval('#lessonCp', (e) => e.textContent).catch(() => '');
  report(`checkpoint ${cp}: lesson in the left column + top bar`, re.test(tt) && (await states(pg)) === 'now,todo,todo,todo,todo' && cpText.includes(`Checkpoint ${cp}`), JSON.stringify(tt));
  report(`checkpoint ${cp}: short toolbar`, (await tools(pg)) === tl, await tools(pg));
  if (cp === '02') {
    // H-10: three BOOT presses on step 4 tick "Press BOOT three times"; two are not enough
    await pg.click('#lessonSteps [data-step="3"]');
    await waitFor(pg, () => document.querySelector('#lessonCard')?.dataset.step === '3', null, 3000);
    const boot = () => pg.$eval('#lessonCard li[data-task="1"]', (e) => ({ done: e.dataset.done, text: e.querySelector('[data-detected]')?.textContent ?? '' }));
    for (let i = 0; i < 2; i++) {
      await pg.click('#toolbar [data-tool="button"]');
      await sleep(300);
    }
    report('H-10 BOOT: two presses leave the task open', (await boot()).done === '0');
    await pg.click('#toolbar [data-tool="button"]');
    await waitFor(pg, () => document.querySelector('#lessonCard li[data-task="1"]')?.dataset.done === '1', null, 3000);
    const bt = await boot();
    report('H-10 BOOT: third press ticks it ("pressed 3 times")', bt.done === '1' && /3/.test(bt.text), JSON.stringify(bt));
  }
  await pg.close();
}

// 5c. H-12: course map from the lesson head; 12 cards, 3 written, Esc closes, card 2 jumps to checkpoint 02
{
  const pg = await open('/app?work=weather&cp=01&debug=1&beginner=1#bench');
  await waitFor(pg, () => !!document.querySelector('#lessonMapBtn'), null, 10000);
  await pg.click('#lessonMapBtn');
  await waitFor(pg, () => !!document.querySelector('#lessonMap[role=dialog]'), null, 3000);
  const m = await pg.evaluate(() => ({
    n: document.querySelectorAll('#lessonMap [data-course]').length,
    live: [...document.querySelectorAll('#lessonMap [data-course]:not([disabled])')].map((e) => e.dataset.course).join(','),
    cur: document.querySelector('#lessonMap [data-course="1"]')?.dataset.state,
    focusIn: !!document.activeElement?.closest('#lessonMap'),
  }));
  report('lesson map: 12 cards, lessons 1-4 open, lesson 1 in progress', m.n === 12 && m.live === '1,2,3,4' && m.cur === 'current' && m.focusIn, JSON.stringify(m));
  await pg.screenshot({ path: path.join(outDir, 'beginner-map.png') });
  await pg.keyboard.press('Escape');
  report('lesson map: Esc closes, focus back on the button', await waitFor(pg, () => !document.querySelector('#lessonMap') && document.activeElement?.id === 'lessonMapBtn', null, 2000));
  await pg.click('#lessonMapBtn');
  await waitFor(pg, () => !!document.querySelector('#lessonMap [data-course="2"]'), null, 3000);
  await pg.click('#lessonMap [data-course="2"]');
  const ok = await waitFor(pg, () => !document.querySelector('#lessonMap') && /Lesson 2/.test(document.querySelector('#lessonTitle')?.textContent ?? ''), null, 5000);
  report('lesson map: card 2 opens weather 02', ok, await pg.$eval('#lessonTitle', (e) => e.textContent).catch(() => ''));
  await pg.close();
}

// 5d. H-14: info tabs over the step card; wiring rows come from wiring.ts, a row click lights the 3D wire
{
  const pg = await open('/app?work=weather&cp=03&debug=1&beginner=1#bench');
  await waitFor(pg, () => !!document.querySelector('#lessonInfo [role=tab]'), null, 10000);
  const tabs = await pg.$$eval('#lessonInfo [role=tab]', (bs) => bs.map((b) => b.dataset.infoTab).join(','));
  report('H-14 four info tabs', tabs === 'overview,wiring,code,params', tabs);
  const seen = {};
  for (const k of ['wiring', 'code', 'params', 'overview']) {
    await pg.click(`#lessonInfo [data-info-tab="${k}"]`);
    seen[k] = await waitFor(pg, (k) => document.querySelector('#lessonInfo [role=tabpanel]')?.dataset.infoTab === k && document.querySelector(`#lessonInfo [role=tab][data-info-tab="${k}"]`)?.getAttribute('aria-selected') === 'true', k, 2000);
  }
  report('H-14 tabs switch', Object.values(seen).every(Boolean), JSON.stringify(seen));
  await pg.click('#lessonInfo [data-info-tab="code"]');
  const code = await waitFor(pg, () => document.querySelectorAll('#lessonCodeNotes [data-code-line]').length >= 5 && /flush\(\)/.test(document.querySelector('#lessonCodeNotes [data-code-line="69"]')?.textContent ?? ''), null, 8000);
  report('H-14 code tab shows the source lines it explains', code);
  await pg.click('#lessonInfo [data-info-tab="params"]');
  const ps = await pg.$$eval('#lessonParams [data-param]', (es) => es.map((e) => e.dataset.source));
  report('H-14 params all carry a source', ps.length >= 4 && ps.every(Boolean), ps.join(','));
  await pg.click('#lessonInfo [data-info-tab="wiring"]');
  const rows = await pg.$$eval('#lessonWires tr[data-wire]', (es) => es.map((e) => e.dataset.wire));
  const bench = await pg.evaluate(() => globalThis.__tbApp.session.bench._debug.wires());
  report('H-14 wiring rows = lesson wires on the bench (LED + OLED)', rows.length === 6 && rows.every((r) => bench.includes(r)), `${rows.join(' ')} | bench ${bench.length}`);
  const id = 'wire:GPIO8~oled:SDA';
  await pg.click(`#lessonWires tr[data-wire="${id}"]`);
  const lit = await waitFor(pg, (id) => { const h = globalThis.__tbApp.session.bench._debug.hl(); return h?.kind === 'wire' && h.id === id; }, id, 3000);
  const row = await pg.$eval(`#lessonWires tr[data-wire="${id}"]`, (e) => e.getAttribute('aria-selected')).catch(() => null);
  report('H-14 clicking a row highlights that wire; the card stays', lit && row === 'true' && (await has(pg, '#lessonCard')), `row=${row}`);
  await pg.close();
}
{
  const pg = await open('/app?work=weather&cp=01&debug=1&beginner=1#bench', null, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await waitFor(pg, () => !!document.querySelector('#mLessonOpen'), null, 10000);
  await pg.tap('#mLessonOpen');
  const up = await waitFor(pg, () => document.querySelectorAll('#lessonSheet #lessonInfo [role=tab]').length === 4, null, 3000);
  const m = await pg.evaluate(() => {
    const tabs = [...document.querySelectorAll('#lessonInfo [role=tab]')].map((e) => e.getBoundingClientRect().height);
    return { sw: document.documentElement.scrollWidth, minH: Math.min(...tabs) };
  });
  report('H-14 phone: four tabs in the full panel, 44px, no horizontal scroll', up && m.sw <= 390 && m.minH >= 44, JSON.stringify(m));
  await pg.tap('#lessonInfo [data-info-tab="wiring"]');
  await waitFor(pg, () => !!document.querySelector('#lessonWires tr[data-wire]'), null, 3000);
  const rh = await pg.$$eval('#lessonWires tr[data-wire]', (es) => es.map((e) => Math.round(e.getBoundingClientRect().height)));
  const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
  report('H-14 phone: wiring rows ≥ 44px tall, no horizontal scroll', rh.length === 2 && rh.every((h) => h >= 44) && sw <= 390, `${rh} sw=${sw}`);
  await pg.tap('#lessonWires tr[data-wire="wire:GPIO5~led:5:IN"]');
  const lit = await waitFor(pg, () => globalThis.__tbApp.session.bench._debug.hl()?.id === 'wire:GPIO5~led:5:IN', null, 3000);
  report('H-14 phone: tapping a row highlights the wire', lit);
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
// H-12: phone map button is 44 px, the map is a full-screen 2-column sheet without horizontal scroll
const mb = await ph.$eval('#lessonMapBtn', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }).catch(() => [0, 0]);
report('phone: lesson map button 44px', mb[0] >= 44 && mb[1] >= 44, JSON.stringify(mb));
if (mb[0]) {
  await ph.tap('#lessonMapBtn');
  await waitFor(ph, () => !!document.querySelector('#lessonMap'), null, 3000);
  await sleep(200);
  const pm = await ph.evaluate(() => {
    const cards = [...document.querySelectorAll('#lessonMap [data-course]')].map((e) => e.getBoundingClientRect());
    const d = document.querySelector('#lessonMap');
    return { n: cards.length, cols: new Set(cards.map((r) => Math.round(r.left))).size, sw: Math.max(document.documentElement.scrollWidth, d.scrollWidth), w: Math.round(d.getBoundingClientRect().width) };
  });
  report('phone: lesson map full screen, 2 columns, no horizontal scroll', pm.n === 12 && pm.cols === 2 && pm.sw <= 390 && pm.w === 390, JSON.stringify(pm));
  await ph.screenshot({ path: path.join(outDir, 'beginner-phone-map.png') });
  await ph.keyboard.press('Escape');
}
await ph.screenshot({ path: path.join(outDir, 'beginner-phone.png') });
await ph.close();

// H-17 schematic view: symbols pick the same target as 3D, net flags light both ends, current estimate, phone layout
{
  const pg = await open('/app?work=weather&cp=01&debug=1&beginner=1#bench');
  await pg.click('#toolbar [data-tool="schematic"]');
  const up = await waitFor(pg, () => !!document.querySelector('#schematicSvg [data-ref="R1"]') && document.querySelector('#stage')?.dataset.view === 'schematic', null, 3000);
  report('H-17 lesson 01: schematic replaces the stage (U1 / R1 / D1)', up && (await pg.$$eval('#schematicSvg [data-ref]', (es) => es.map((e) => e.dataset.ref).join(','))) === 'U1,R1,D1');
  await pg.click('#schematicSvg [data-ref="R1"]');
  const lit = await waitFor(pg, () => { const h = globalThis.__tbApp.session.bench._debug.hl(); return h?.kind === 'part' && h.id === 'led:5'; }, null, 3000);
  report('H-17 clicking R1 selects the LED part on the 3D bench', lit && (await pg.$eval('#schematicCard', (e) => e.dataset.ref).catch(() => null)) === 'R1');
  await pg.click('#toolbar [data-tool="current"]');
  const flow = await waitFor(pg, () => /mA/.test(document.querySelector('#schematicSvg [data-flow="led:5"]')?.textContent ?? ''), null, 3000);
  report('H-17 Show current draws the loop with an mA estimate', flow);
  await pg.click('#toolbar [data-tool="view3d"]');
  report('H-17 back to 3D: overlay gone, highlight kept', !(await has(pg, '#schematic')) && (await pg.evaluate(() => globalThis.__tbApp.session.bench._debug.hl()?.id === 'led:5')));
  await pg.close();
}
{
  const pg = await open('/app?work=weather&cp=03&debug=1&beginner=1#bench');
  await pg.click('#toolbar [data-tool="schematic"]');
  await waitFor(pg, () => !!document.querySelector('#schematicSvg [data-net="SDA"]'), null, 3000);
  await pg.click('#schematicSvg [data-net="SDA"]');
  const lit = await waitFor(pg, () => globalThis.__tbApp.session.bench._debug.hl()?.id === 'wire:GPIO8~oled:SDA', null, 3000);
  const ends = await pg.$$eval('#schematicSvg [data-net="SDA"][aria-pressed="true"]', (es) => es.map((e) => e.dataset.end).sort().join(','));
  report('H-17 lesson 03: clicking SDA lights both flags and the 3D wire', lit && ends.split(',').length === 2, ends);
  await pg.close();
}
{
  const pg = await open('/app?work=weather&cp=03&debug=1&beginner=1#bench', null, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await waitFor(pg, () => !!document.querySelector('[data-mtool="more"]'), null, 5000);
  await pg.tap('[data-mtool="more"]');
  await waitFor(pg, () => !!document.querySelector('[data-tool="schematic"]'), null, 3000);
  await pg.tap('[data-tool="schematic"]');
  const up = await waitFor(pg, () => document.querySelector('#schematic')?.dataset.layout === 'phone', null, 3000);
  const m = await pg.evaluate(() => {
    const bs = [...document.querySelectorAll('#schematic button')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height);
    return { sw: document.documentElement.scrollWidth, minH: Math.min(...bs), n: bs.length };
  });
  report('H-17 phone: vertical schematic, buttons ≥ 44px, no horizontal scroll', up && m.sw <= 390 && m.minH >= 44, JSON.stringify(m));
  await pg.close();
}

report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails ? `[beginner] ${fails} FAIL` : '[beginner] all PASS');
process.exit(fails ? 1 : 0);
