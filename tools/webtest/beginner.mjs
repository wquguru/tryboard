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
// H-27: digital blink keeps the LED card on on / off, never a PWM percentage
const ledLive = await waitFor(page, () => /^Now: (on|off)$/.test(document.querySelector('[data-callout="led"] [data-live]')?.textContent ?? ''), null, 8000);
report('H-27 lesson 1: LED card shows on / off', ledLive, await page.$eval('[data-callout="led"] [data-live]', (e) => e.textContent).catch(() => 'no card'));
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
// H-30: "Finish" with tasks left and checkpoint 01 not passed is not a done lesson: last step stays, "not done yet" hint
await waitFor(page, () => document.querySelector('#lessonCard')?.dataset.todo === '1', null, 3000);
const fin = await page.evaluate(() => ({ step: document.querySelector('#lessonCard')?.dataset.step, panel: !!document.querySelector('#courseDone'), left: Number(document.querySelector('#lessonTodo')?.dataset.left), next: document.querySelector('#lessonNext')?.disabled }));
report('finished: no callouts', !(await has(page, '#lessonCallouts')));
report('H-30 finish without the rule: last step stays, no done panel, tasks left shown', fin.step === '4' && !fin.panel && fin.left > 0 && fin.next === true && (await states(page)) === 'done,done,done,done,now', JSON.stringify({ ...fin, states: await states(page) }));
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
  report('lesson map: 12 cards, all 12 lessons open, lesson 1 in progress', m.n === 12 && m.live === '0,1,2,3,4,5,6,7,8,9,10,11' && m.cur === 'current' && m.focusIn, JSON.stringify(m));
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

// 5c2. H-20: ticks alone finish a lesson (no ✓); a passing checkpoint adds the ✓ on the map and the done panel.
// Storage is preset before load: every task index 0..9 of steps 0..9 ticked, step progress past the last step, passes in checks.
{
  const ticks = (cp) => ({ [cp]: Object.fromEntries([...Array(10).keys()].map((s) => [s, Object.fromEntries([...Array(10).keys()].map((i) => [i, {}]))])) });
  const preset = (pass) =>
    `localStorage.setItem('tb-beginner','1');` +
    `localStorage.setItem('tryboard-app-lesson-tasks:usbkey', ${JSON.stringify(JSON.stringify(ticks('usbkey-2')))});` +
    `localStorage.setItem('tryboard-app-lesson-tasks:weather', ${JSON.stringify(JSON.stringify(ticks('01')))});` +
    `localStorage.setItem('tryboard-app-lesson:weather', '{"01":5}');` +
    (pass ? `localStorage.setItem('tryboard-app-checks:usbkey', '{"usbkey-2":{"fp":"h20","at":"t","own":true}}');` + `localStorage.setItem('tryboard-app-checks:weather', '{"01":{"fp":"h20","at":"t","own":true}}');` : '');
  for (const pass of [false, true]) {
    const pg = await open('/app?work=weather&cp=01&debug=1&beginner=1#bench', preset(pass));
    const panel = await waitFor(pg, () => !!document.querySelector('#courseDone'), null, 10000);
    const p = await pg.evaluate(() => ({ state: document.querySelector('#courseDone')?.dataset.state, ck: !!document.querySelector('#courseDone [data-cp-passed]') }));
    report(`H-20 done panel (${pass ? 'checkpoint passed' : 'ticks only'})`, panel && p.state === 'done' && p.ck === pass, JSON.stringify(p));
    if (pass) await pg.screenshot({ path: path.join(outDir, 'beginner-h20-panel.png') });
    await pg.click('#lessonMapBtn');
    await waitFor(pg, () => !!document.querySelector('#lessonMap [data-course="10"]'), null, 3000);
    const m = await pg.evaluate(() => {
      const c = (n) => document.querySelector(`#lessonMap [data-course="${n}"]`);
      return { s1: c(1)?.dataset.state, s10: c(10)?.dataset.state, ck1: !!c(1)?.querySelector('[data-cp-passed]'), ck10: !!c(10)?.querySelector('[data-cp-passed]'), done: document.querySelector('#lessonMapProgress')?.dataset.done, bar: document.querySelector('#courseBar')?.dataset.done };
    });
    report(`H-20 map (${pass ? 'checkpoint passed: ✓' : 'ticks only: done, no ✓'})`, m.s1 === 'done' && m.s10 === 'done' && m.ck1 === pass && m.ck10 === pass && m.done === m.bar && Number(m.done) >= 2, JSON.stringify(m));
    await pg.screenshot({ path: path.join(outDir, `beginner-h20-map-${pass ? 'cp' : 'ticks'}.png`) });
    await pg.close();
  }
}

// 5c3. H-30: past the last step the done panel follows the done rule, not the step. Lesson 10 (usbkey-2) never passes on its own.
// Steps 1-4 preset ticked, step 5 (three "Think" reveals) open: hint + locked button; revealing the three brings the panel in place.
{
  const ticks = { 'usbkey-2': Object.fromEntries([0, 1, 2, 3].map((s) => [s, Object.fromEntries([...Array(10).keys()].map((i) => [i, {}]))])) };
  const pre =
    `localStorage.setItem('tb-beginner','1');` +
    `localStorage.setItem('tryboard-app-lesson:usbkey', '{"usbkey-2":5}');` +
    `localStorage.setItem('tryboard-app-lesson-tasks:usbkey', ${JSON.stringify(JSON.stringify(ticks))});`;
  const pg = await open('/app?work=usbkey&cp=usbkey-2&debug=1&beginner=1#bench', pre);
  await waitFor(pg, () => document.querySelector('#lessonCard')?.dataset.todo === '1', null, 10000);
  const a = await pg.evaluate(() => ({
    step: document.querySelector('#lessonCard')?.dataset.step,
    panel: !!document.querySelector('#courseDone'),
    todo: [...document.querySelectorAll('#lessonTodo [data-todo-step]')].map((b) => b.dataset.todoStep).join(','),
    left: document.querySelector('#lessonTodo')?.dataset.left,
    next: document.querySelector('#lessonNext')?.disabled,
  }));
  report('H-30 lesson 10 at the end, step 5 open: no done panel, hint names step 5', a.step === '4' && !a.panel && a.todo === '4' && a.left === '3' && a.next === true, JSON.stringify(a));
  await pg.screenshot({ path: path.join(outDir, 'beginner-h30-todo.png') });
  for (const i of [0, 1, 2]) await pg.click(`#lessonCard [data-reveal="${i}"]`);
  const shown = await waitFor(pg, () => document.querySelector('#lessonCard')?.dataset.step === 'done' && !!document.querySelector('#courseDone'), null, 3000);
  const b = await pg.evaluate(() => ({ todo: !!document.querySelector('#lessonTodo'), state: document.querySelector('#courseDone')?.dataset.state, map: document.querySelector('#courseBar [data-course-dot="10"]')?.dataset.state }));
  report('H-30 ticking the last tasks there brings the done panel', shown && !b.todo && b.state === 'done', JSON.stringify(b));
  await pg.screenshot({ path: path.join(outDir, 'beginner-h30-done.png') });
  await pg.close();
}
// Phone sheet: nothing ticked → hint, no panel; a stored checkpoint pass alone → panel
{
  const phone = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const base = `localStorage.setItem('tb-beginner','1');` + `localStorage.setItem('tryboard-app-lesson:usbkey', '{"usbkey-2":5}');`;
  for (const pass of [false, true]) {
    const pre = base + (pass ? `localStorage.setItem('tryboard-app-checks:usbkey', '{"usbkey-2":{"fp":"h30","at":"t","own":true}}');` : '');
    const pg = await open('/app?work=usbkey&cp=usbkey-2&debug=1&beginner=1#bench', pre, phone);
    await waitFor(pg, () => !!document.querySelector('#lessonSheet'), null, 10000);
    await waitFor(pg, () => (pass ? !!document.querySelector('#lessonSheet #courseDone') : !!document.querySelector('#lessonSheet #lessonTodo')), null, 5000);
    const m = await pg.evaluate(() => ({
      step: document.querySelector('#lessonSheet')?.dataset.step,
      panel: !!document.querySelector('#lessonSheet #courseDone'),
      todo: !!document.querySelector('#lessonSheet #lessonTodo'),
      left: document.querySelector('#lessonTodo')?.dataset.left,
      sw: document.documentElement.scrollWidth,
    }));
    const ok = pass ? m.step === 'done' && m.panel && !m.todo : m.step === '4' && !m.panel && m.todo && Number(m.left) > 3;
    report(`H-30 phone sheet at the end (${pass ? 'checkpoint passed: panel' : 'nothing done: hint, no panel'})`, ok && m.sw <= 390, JSON.stringify(m));
    if (!pass) await pg.screenshot({ path: path.join(outDir, 'beginner-h30-phone.png') });
    await pg.close();
  }
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
  const fit = await pg.evaluate(() => {
    const svg = document.querySelector('#schematicSvg');
    const scale = Number(svg.dataset.scale);
    const min = Math.min(...[...svg.querySelectorAll('text')].map((e) => parseFloat(getComputedStyle(e).fontSize))) * scale;
    const p = document.querySelector('#schematicPaper');
    const tb = document.querySelector('#toolbar').getBoundingClientRect();
    const notes = document.querySelector('#schematicNotes').getBoundingClientRect();
    return { scale, min, fits: p.scrollWidth <= p.clientWidth + 1 && p.scrollHeight <= p.clientHeight + 1, clear: notes.bottom <= tb.top || notes.left >= tb.right, paperBottom: p.getBoundingClientRect().bottom <= tb.top };
  });
  report('H-17 desktop lesson 03: text ≥ 12 px, sheet fits the paper, notes and paper clear of the toolbar', fit.scale >= 1 && fit.min >= 12 && fit.fits && fit.clear && fit.paperBottom, JSON.stringify(fit));
  await pg.click('#schematicSvg [data-net="SDA"]');
  const lit = await waitFor(pg, () => globalThis.__tbApp.session.bench._debug.hl()?.id === 'wire:GPIO8~oled:SDA', null, 3000);
  const ends = await pg.$$eval('#schematicSvg [data-net="SDA"][aria-pressed="true"]', (es) => es.map((e) => e.dataset.end).sort().join(','));
  report('H-17 lesson 03: clicking SDA lights both flags and the 3D wire', lit && ends.split(',').length === 2, ends);
  await pg.close();
}
// H-25: smaller laptop screen keeps sheet text ≥ 11 px rendered (measured from the svg box, not data-scale); OLED symbol drawn
{
  const pg = await open('/app?work=weather&cp=03&debug=1&beginner=1#bench', null, { width: 1280, height: 800, deviceScaleFactor: 1 });
  await pg.click('#toolbar [data-tool="schematic"]');
  await waitFor(pg, () => !!document.querySelector('#schematicSvg [data-net="SDA"]'), null, 3000);
  const m = await pg.evaluate(() => {
    const svg = document.querySelector('#schematicSvg');
    const k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    const min = Math.min(...[...svg.querySelectorAll('text')].map((e) => parseFloat(getComputedStyle(e).fontSize))) * k;
    return { k: +k.toFixed(3), min: +min.toFixed(2), oled: !!svg.querySelector('[data-part="oled"][data-sym="oled"] [data-glyph="oled"]') };
  });
  report('H-25 1280×800 lesson 03: text ≥ 11 px, OLED drawn with its screen symbol', m.min >= 11 && m.oled, JSON.stringify(m));
  await pg.close();
}
// H-25 lesson 02: the BOOT button is SW1 on GPIO0, and clicking it picks the same 3D button
{
  const pg = await open('/app?work=weather&cp=02&debug=1&beginner=1#bench');
  await pg.click('#toolbar [data-tool="schematic"]');
  const up = await waitFor(pg, () => !!document.querySelector('#schematicSvg [data-ref="SW1"][data-sym="button"]'), null, 3000);
  if (up) await pg.click('#schematicSvg [data-ref="SW1"]');
  const card = await waitFor(pg, () => document.querySelector('#schematicCard')?.dataset.ref === 'SW1' && globalThis.__tbApp.store.get().selection?.kind === 'button', null, 3000);
  report('H-25 lesson 02: BOOT drawn as SW1, click selects the BOOT button', up && card);
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

// H-16 lesson 8 on S3: the feed stays quiet while the work's own build runs, then s3-bme280 reads every 1 s (160 M cycles, as the CLI)
{
  const pg = await open('/app?work=weather&cp=04&debug=1&beginner=1#bench');
  await sleep(1500);
  const rows = () => pg.$$eval('[data-t]', (xs) => xs.map((x) => Number(x.dataset.t)).sort((a, b) => a - b));
  const before = (await rows()).length;
  for (const b of await pg.$$('#lessonSteps [data-step]')) {
    if (await pg.$('#lessonRun')) break;
    await b.click();
    await sleep(300);
  }
  await pg.click('#lessonRun');
  await waitFor(pg, () => document.querySelectorAll('[data-t]').length >= 5, null, 20000);
  const ts = await rows();
  const gaps = ts.slice(2).map((t, i) => t - ts[i + 1]);
  report('lesson 8 S3: no feed rows before the lesson code runs', before === 0, `rows=${before}`);
  report('lesson 8 S3: sensor reads 1 s apart', gaps.length >= 3 && gaps.every((g) => Math.abs(g - 160_000_000) < 1_600_000), gaps.join(','));
  await pg.close();
}

// H-27 lesson 4 (s3-fade, LEDC GPIO5): the LED and GPIO5 cards show the duty as a percentage that breathes
{
  const pg = await open('/app?work=basics&cp=basics-pwm&debug=1&beginner=1#bench');
  for (let i = 0; i < 5 && !(await pg.$('#lessonRun')); i++) {
    await pg.click('#lessonNext');
    await sleep(300);
  }
  await pg.click('#lessonRun');
  const pctOf = (key) => pg.$eval(`[data-callout="${key}"] [data-live]`, (e) => e.textContent).catch(() => '');
  const pctRe = /^Now: (\d+) % brightness \(PWM 5000 Hz\)$/;
  const got = await waitFor(pg, () => /^Now: \d+ % brightness/.test(document.querySelector('[data-callout="led"] [data-live]')?.textContent ?? ''), null, 20000);
  const a = await pctOf('led');
  // Wait for the duty to move on rather than sleeping a fixed time
  const moved = await waitFor(pg, (a0) => { const s = document.querySelector('[data-callout="led"] [data-live]')?.textContent ?? ''; return /^Now: \d+ % brightness/.test(s) && s !== a0; }, a, 8000);
  const b = await pctOf('led');
  const va = +(pctRe.exec(a)?.[1] ?? -1);
  const vb = +(pctRe.exec(b)?.[1] ?? -1);
  report('H-27 lesson 4: LED card shows the PWM brightness in %', got && va >= 0 && va <= 100, a);
  report('H-27 lesson 4: brightness changes between samples (0-100)', moved && vb >= 0 && vb <= 100 && va !== vb, `${a} -> ${b}`);
  const gp = await waitFor(pg, () => /%/.test(document.querySelector('[data-callout="gpio"] [data-live]')?.textContent ?? ''), null, 8000);
  report('H-27 lesson 4: GPIO5 card shows the duty in %', gp, await pctOf('gpio'));
  await pg.close();
}

// H-21 lesson 11 (weather 06): the feed narrates BME280 reads next to OLED frames; the case task ticks only without warnings
{
  const pg = await open('/app?work=weather&cp=06&debug=1&beginner=1#bench');
  const both = await waitFor(pg, () => !!document.querySelector('[data-i2c="0x76"]') && !!document.querySelector('[data-i2c="0x3C"]'), null, 20000);
  const rows = await pg.$$eval('[data-i2c]', (xs) => xs.map((x) => `${x.dataset.i2c}:${x.dataset.bytes}`));
  report('H-21 lesson 11: feed shows BME280 (0x76) and OLED (0x3C) rows', both, rows.slice(-6).join(','));
  // Register read: 1 register byte written + 8 read back (rd(0xF7, d, 8)); init writes are 2 bytes
  report('H-21 lesson 11: a 0x76 row counts the bytes read back', rows.some((r) => /^0x76:(9|\d{2,})$/.test(r)), rows.filter((r) => r.startsWith('0x76')).slice(-3).join(','));
  const last = await pg.$$('#lessonSteps [data-step]');
  await last[last.length - 1].click();
  const asmTask = '#lessonCard [data-kind="asm"]';
  await waitFor(pg, (s) => !!document.querySelector(s), asmTask, 3000);
  // The bench probe sends asm:done=clean|warn from store.assembly, as the Assemble step does when the last part goes in
  const fake = (clean) => pg.evaluate((c) => globalThis.__tbApp.store.set({ assembly: { placed: ['case'], choice: {}, total: 1, clean: c, effects: {}, retest: null } }), clean);
  await fake(false);
  const warned = await waitFor(pg, (s) => !!document.querySelector(`${s} [data-warn]`), asmTask, 3000);
  const doneWarn = await pg.$eval(asmTask, (e) => e.dataset.done).catch(() => '');
  report('H-21 lesson 11: case with warnings does not tick and says why', warned && doneWarn === '0', `done=${doneWarn}`);
  await fake(true);
  const ticked = await waitFor(pg, (s) => document.querySelector(s)?.dataset.done === '1', asmTask, 3000);
  report('H-21 lesson 11: case without warnings ticks', ticked && !(await has(pg, `${asmTask} [data-warn]`)));
  await pg.close();
}

// H-19 lesson 0 runs no code: open / reload keep the basics firmware off; lesson 4 (in-page pick or course link) and beginner off run it
{
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(String(e)));
  pg.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const l0 = '/app?work=basics&cp=lesson-0&beginner=1#bench';
  const state = () =>
    pg.evaluate(() => {
      const a = globalThis.__tbApp;
      return { run: document.querySelector('#runGroup')?.dataset.run ?? null, running: !!a?.store.get().running, sim: !!a?.session.sim, serial: a?.session.consoleText().slice(-40) ?? null, boots: a?.session.bootCount ?? -1, runs: a?.store.get().hist.runs ?? -1, lesson: document.querySelector('#lessonCard') ? document.body.dataset.lesson : null };
    });
  const still = (st) => st.run !== 'run' && !st.running && !st.sim && st.serial === '';
  const live = () => !!globalThis.__tbApp?.store.get().running && globalThis.__tbApp.session.consoleText().length > 0;
  for (const how of ['open', 'reload']) {
    if (how === 'open') await pg.goto(base + l0, { waitUntil: 'load' });
    else await pg.reload({ waitUntil: 'load' });
    await waitFor(pg, () => !!globalThis.__tbApp?.hist && !!document.querySelector('#lessonCard'), null, 30000);
    await sleep(3000);
    const st = await state();
    report(`H-19 lesson 0 ${how}: never booted, not running, serial empty`, st.lesson === 'lesson-0' && still(st) && st.boots === 0 && st.runs === 0, JSON.stringify(st));
    if (how === 'open') report('H-19 lesson 0: no Run button in the lesson toolbar', !(await tools(pg)).split(',').includes('run'), await tools(pg));
  }
  // Another step (assemble) and back must not power it up either
  await pg.evaluate(() => (location.hash = 'assemble'));
  await sleep(1500);
  await pg.evaluate(() => (location.hash = 'bench'));
  await sleep(1500);
  report('H-19 lesson 0: assemble and back stays off', still(await state()), JSON.stringify(await state()));
  // In-page: picking lesson 4's checkpoint (basics-pwm) powers the work's firmware up
  await pg.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'checkpoint', id: 'basics-pwm' } }));
  const pick = await waitFor(pg, () => document.body.dataset.lesson === 'basics-pwm', null, 5000);
  report('H-19 lesson 0 → lesson 4 (in page): runs with serial output', pick && (await waitFor(pg, live, null, 20000)), JSON.stringify(await state()));
  report('H-19 lesson 4 (in page): Run button back', (await tools(pg)).split(',').includes('run'), await tools(pg));
  // Course link (goLesson) to lesson 4, then back to lesson 0 and switch beginner off
  await pg.goto(base + '/app?work=basics&cp=basics-pwm&beginner=1#bench', { waitUntil: 'load' });
  const l4 = await waitFor(pg, () => document.body.dataset.lesson === 'basics-pwm', null, 30000);
  report('H-19 lesson 4 link: runs with serial output', l4 && (await waitFor(pg, live, null, 20000)), JSON.stringify(await state()));
  await pg.goto(base + l0, { waitUntil: 'load' });
  await waitFor(pg, () => !!globalThis.__tbApp?.hist && !!document.querySelector('#lessonCard'), null, 30000);
  await sleep(1500);
  report('H-19 lesson 4 → lesson 0: firmware off again', still(await state()), JSON.stringify(await state()));
  await pg.click('#beginnerBtn');
  report('H-19 beginner off: the work runs as usual', await waitFor(pg, live, null, 20000), JSON.stringify(await state()));
  // Back on with ?cp=lesson-0 still in the URL: the running firmware is stopped
  await pg.click('#beginnerBtn');
  report('H-19 beginner on again: lesson 0 stops the running firmware', await waitFor(pg, (f) => !globalThis.__tbApp.store.get().running && !globalThis.__tbApp.session.sim && globalThis.__tbApp.session.consoleText() === '' && document.querySelector('#runGroup')?.dataset.run !== 'run', null, 5000), JSON.stringify(await state()));
  // Undo / rewind with the firmware held off must not touch a missing sim
  const n0 = errors.length;
  if (await pg.$eval('#undoBtn', (b) => !b.disabled).catch(() => false)) await pg.click('#undoBtn');
  await sleep(1500);
  report('H-19 lesson 0 held: undo raises no page error', errors.length === n0, errors.slice(n0).join(' | '));
  await ctx.close();
}

// H-29 leaving lesson 0 powers the work up again (a kept own bin included); lesson 0's timeline drops earlier runs
{
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(String(e)));
  pg.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const l0 = '/app?work=basics&cp=lesson-0&beginner=1#bench';
  const st = () =>
    pg.evaluate(() => {
      const a = globalThis.__tbApp;
      return { run: document.querySelector('#runGroup')?.dataset.run ?? null, sim: !!a?.session.sim, fw: a?.session.fwName ?? null, serial: a?.session.consoleText().slice(-40) ?? '', runs: a?.store.get().hist.runs ?? -1, tlRuns: document.querySelectorAll('#timeline [data-id^="run:"]').length, lesson: document.body.dataset.lesson ?? null };
    });
  const ready = () => waitFor(pg, () => !!globalThis.__tbApp?.hist && !!document.querySelector('#lessonCard'), null, 30000);
  // Top bar Running and an LED line on the serial (basics: "LED ON"; weather: "LED=green")
  const ledLive = () => document.querySelector('#runGroup')?.dataset.run === 'run' && !!globalThis.__tbApp?.store.get().running && /LED/.test(globalThis.__tbApp.session.consoleText());
  const noRuns = (s) => s.runs === 0 && s.tlRuns === 0 && !s.sim && s.serial === '' && s.run !== 'run';
  const lesson0 = async () => {
    await pg.goto(base + l0, { waitUntil: 'load' });
    await ready();
    await sleep(2000);
  };
  // Lesson 4 runs first; lesson 0 opened after it lists no run
  await pg.goto(base + '/app?work=basics&cp=basics-pwm&beginner=1#bench', { waitUntil: 'load' });
  await ready();
  report('H-29 lesson 4 runs before lesson 0', await waitFor(pg, ledLive, null, 20000), JSON.stringify(await st()));
  await lesson0();
  let s = await st();
  report('H-29 lesson 0 after lesson 4: no run on the timeline', s.lesson === 'lesson-0' && noRuns(s), JSON.stringify(s));
  // Next lesson (1, weather: a reload into another work) runs its firmware
  await pg.click('#courseNext');
  const on1 = await waitFor(pg, () => document.body.dataset.lesson === '01', null, 30000);
  report('H-29 lesson 0 → lesson 1: Running with an LED line', on1 && (await waitFor(pg, ledLive, null, 20000)), JSON.stringify(await st()));
  // Same work in page: the lesson map's lesson 4 card
  await lesson0();
  await pg.click('#lessonMapBtn');
  await waitFor(pg, () => !!document.querySelector('#lessonMap [data-course="4"]:not([disabled])'), null, 3000);
  await pg.click('#lessonMap [data-course="4"]');
  const on4 = await waitFor(pg, () => document.body.dataset.lesson === 'basics-pwm', null, 5000);
  report('H-29 lesson 0 → lesson 4 (map, same work): Running with an LED line', on4 && (await waitFor(pg, ledLive, null, 20000)), JSON.stringify(await st()));
  // Lab (beginner off) runs; back on stops it and the timeline drops that run; off again starts at run #1
  await lesson0();
  await pg.click('#beginnerBtn');
  report('H-29 lesson 0 → lab (beginner off): Running with an LED line', await waitFor(pg, ledLive, null, 20000), JSON.stringify(await st()));
  await pg.click('#beginnerBtn');
  const dropped = await waitFor(pg, () => document.querySelectorAll('#timeline [data-id^="run:"]').length === 0 && globalThis.__tbApp.store.get().hist.runs === 0, null, 5000);
  s = await st();
  report('H-29 lesson 0 again: the stopped run leaves the timeline', dropped && noRuns(s), JSON.stringify(s));
  await pg.click('#beginnerBtn');
  const back = await waitFor(pg, ledLive, null, 20000);
  s = await st();
  report('H-29 lab again: runs as run #1', back && s.runs === 1 && s.tlRuns === 1, JSON.stringify(s));
  await pg.click('#beginnerBtn');
  await waitFor(pg, () => !globalThis.__tbApp.session.sim, null, 5000);
  // A bin kept in this browser (F-07c) comes back when lesson 0 is left in page
  const own = path.join(outDir, 'h29-own.bin');
  fs.copyFileSync(path.join(root, 'firmware/build/s3-blink-100/flash.bin'), own);
  await pg.goto(base + '/app?work=basics&cp=basics-pwm&beginner=1#bench', { waitUntil: 'load' });
  await ready();
  await waitFor(pg, ledLive, null, 20000);
  await (await pg.$('#fwPick')).uploadFile(own);
  // keepOwn stores the bin after the power-up, so wait for this work's pointer (ownbin.ts PTR)
  const kept = await waitFor(pg, () => globalThis.__tbApp.session.fwName === 'h29-own.bin' && Object.keys(localStorage).some((k) => k.startsWith('tryboard-ownbin:') && k.includes('basics')), null, 10000);
  await lesson0();
  s = await st();
  report('H-29 lesson 0 with a kept bin: still off', kept && noRuns(s), JSON.stringify(s));
  await pg.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'checkpoint', id: 'basics-pwm' } }));
  const ownBack = await waitFor(pg, () => globalThis.__tbApp.session.fwName === 'h29-own.bin' && !!globalThis.__tbApp.store.get().running, null, 20000);
  report('H-29 lesson 0 → lesson 4: the kept bin is restored', ownBack, JSON.stringify(await st()));
  await pg.close();
}

// H-23 lesson 5 (lamp-strip, GPIO5): each restart while running brings back the first strip row
{
  const pg = await open('/app?work=lamp&cp=lamp-1&debug=1&beginner=1#bench');
  for (let i = 0; i < 6 && !(await pg.$('#lessonRun')); i++) {
    await pg.click('#lessonNext');
    await sleep(300);
  }
  await pg.click('#lessonRun');
  const lit = () => !!document.querySelector('[data-lit="8"]');
  const first = await waitFor(pg, lit, null, 20000);
  report('H-23 lesson 5: first strip row after running the lesson code', first);
  const n = Number(process.env.H23_RESTARTS ?? 3);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    // Tag the old run's rows so a restart that never happened cannot pass on them
    const run0 = await pg.evaluate(() => (document.querySelectorAll('[data-lit]').forEach((x) => (x.dataset.old = '1')), globalThis.__tbApp.store.get().run));
    await pg.click('#runRestart');
    const booted = await waitFor(pg, (r) => globalThis.__tbApp.store.get().run > r, run0, 10000);
    if (booted && (await waitFor(pg, () => !!document.querySelector('[data-lit="8"]:not([data-old])'), null, 8000))) hits++;
  }
  report(`H-23 lesson 5: strip row after each of ${n} restarts`, hits === n, `${hits}/${n}`);
  await pg.close();
}

// H-22 lesson 9 (s3-pot, wiper GPIO4): build tree and Wiring tab list the pot and its 3 wires; the knob survives scene rebuilds
{
  const pg = await open('/app?work=adc&debug=1&beginner=1#bench');
  const potWires = ['wire:3V3~pot:VCC', 'wire:GPIO4~pot:OUT', 'wire:GND~pot:GND'];
  const tree = await pg.evaluate(() => ({
    parts: [...document.querySelectorAll('[data-kind=part]')].map((e) => e.dataset.id),
    wires: [...document.querySelectorAll('[data-kind=wire]')].map((e) => e.dataset.id),
  }));
  report('H-22 lesson 9: build tree lists the pot and its 3 wires', tree.parts.includes('pot') && potWires.every((w) => tree.wires.includes(w)), JSON.stringify(tree));
  await pg.click('[data-left="wires"]');
  await waitFor(pg, () => !!document.querySelector('#wireTable tr[data-wire]'), null, 3000);
  const tab = await pg.$$eval('#wireTable tr[data-wire]', (es) => es.map((e) => e.dataset.wire));
  report('H-22 lesson 9: Wiring tab lists the pot\'s 3 wires', potWires.every((w) => tab.includes(w)), tab.join(' '));
  // The lesson card used to squeeze the list to ~2 rows: the last pot wire must be on screen without scrolling
  const fit = await pg.$eval('#wireTable tr[data-wire="wire:GND~pot:GND"]', (e) => {
    const box = e.closest('.overflow-auto').getBoundingClientRect();
    return { row: Math.round(e.getBoundingClientRect().bottom), box: Math.round(box.bottom) };
  });
  report('H-22 lesson 9: Wiring tab shows all pot wires without scrolling (1440x900)', fit.row <= fit.box + 2, JSON.stringify(fit));
  const knob = () =>
    pg.evaluate(() => {
      const s = globalThis.__tbApp.session;
      const p = s.bench._debug.pots()[0];
      const adc = (document.querySelector('#console')?.textContent ?? '').match(/ADC raw=\s*(\d+)/g)?.pop();
      return { ...p, mv: s.analog.get(4), raw: Number(adc?.replace(/\D+/, '') ?? -1) };
    });
  await pg.evaluate(() => globalThis.__tbApp.session.bench._debug.turnPot(4, 0.9));
  await waitFor(pg, () => / raw=\s*3[67]\d\d/.test((document.querySelector('#console')?.textContent ?? '').split('ADC').pop()), null, 8000);
  const k0 = await knob();
  const same = (k) => k.id !== k0.id && Math.abs(k.v - k0.v) < 0.01 && Math.abs(k.rot + (k.v - 0.5) * 1.5 * Math.PI) < 1e-6 && k.mv === k0.mv;
  // Rebuild 1: "Run this lesson's code" reloads the firmware, which rebuilds the 3D scene
  for (let i = 0; i < 6 && !(await pg.$('#lessonRun')); i++) {
    await pg.click('#lessonNext');
    await sleep(300);
  }
  await pg.click('#lessonRun');
  await waitFor(pg, (id) => globalThis.__tbApp.session.bench._debug.pots()[0]?.id !== id, k0.id, 8000);
  await waitFor(pg, () => /ADC raw/.test(document.querySelector('#console')?.textContent ?? ''), null, 8000);
  const k1 = await knob();
  report('H-22 lesson 9: knob kept after firmware reload (rebuild)', same(k1) && Math.abs(k1.raw - k0.raw) < 50, `${JSON.stringify(k0)} -> ${JSON.stringify(k1)}`);
  // Rebuild 2: change another part's parameter (LED colour)
  await pg.evaluate(() => {
    const s = globalThis.__tbApp.session;
    const sc = JSON.parse(JSON.stringify(s.scene));
    const l = sc.parts.find((p) => p.type === 'led');
    l.color = l.color === 'red' ? 'green' : 'red';
    s.applyScene(sc, s.power, 'H-22');
  });
  await waitFor(pg, (id) => globalThis.__tbApp.session.bench._debug.pots()[0]?.id !== id, k1.id, 5000);
  const k2 = await knob();
  report('H-22 lesson 9: knob kept after a part edit (rebuild)', same(k2) && k2.id !== k1.id, `${JSON.stringify(k2)}`);
  await pg.close();
}

// H-28 lesson 5 "Change it": colour chips on line 66 swap in the prebuilt green / blue build and tick their tasks
{
  const pg = await open('/app?work=lamp&cp=lamp-1&debug=1&beginner=1#bench');
  await pg.click('#lessonSteps [data-step="4"]');
  await waitFor(pg, () => document.querySelector('#lessonCard')?.dataset.step === '4', null, 3000);
  for (const [i, hex, rgb] of [[0, '0x00FF00', [0, 64, 0]], [1, '0x0000FF', [0, 0, 64]]]) {
    const sel = `#codeBody [data-chip="${hex}"]`;
    await waitFor(pg, (s) => !!document.querySelector(s), sel, 8000);
    await pg.click(sel);
    // All 8 LEDs in the worker's last strip frame carry the scaled colour of the clicked build
    const lit = await waitFor(pg, ([fw, want]) => {
      const s = globalThis.__tbApp.session;
      const leds = s.frame.strips?.[5] ?? [];
      return s.fwName === `${fw}/flash.bin` && leds.length === 8 && leds.every((c) => c.join() === want.join());
    }, [hex === '0x00FF00' ? 'lamp-strip-green' : 'lamp-strip-blue', rgb], 20000);
    const strip = await pg.evaluate(() => JSON.stringify([globalThis.__tbApp.session.fwName, globalThis.__tbApp.session.frame.strips?.[5]?.[7]]));
    report(`H-28 lesson 5: chip ${hex} runs its build, strip turns ${rgb.join(',')}`, lit, strip);
    const ticked = await waitFor(pg, (k) => document.querySelector(`#lessonCard li[data-task="${k}"]`)?.dataset.done === '1', i, 3000);
    const tk = await task(pg, i);
    report(`H-28 lesson 5: chip ${hex} ticks its task`, ticked && !!tk?.text.includes(hex), JSON.stringify(tk));
    // H-34: the code panel follows the running variant (its CMakeLists tab and -D WARM), not the default build
    const v = hex === '0x00FF00' ? 'lamp-strip-green' : 'lamp-strip-blue';
    const shown = await waitFor(pg, ([v, hex]) => {
      const cv = document.querySelector('#codeView');
      return cv?.dataset.fw === v && !!cv.querySelector(`[data-file="${v}/main/CMakeLists.txt"]`) && !!document.querySelector('#codeDefines')?.textContent?.includes(`WARM=${hex}`) && !cv.querySelector('[data-file="lamp-strip/main/CMakeLists.txt"]');
    }, [v, hex], 8000);
    const lbl = await pg.evaluate(() => JSON.stringify([document.querySelector('#codeView')?.dataset.fw, [...document.querySelectorAll('#codeView [data-file]')].map((b) => b.dataset.file), document.querySelector('#codeDefines')?.textContent]));
    report(`H-34 lesson 5: chip ${hex} code panel labels ${v}`, shown, lbl);
  }
  await waitFor(pg, () => !!document.querySelector('#codeBody [data-chip="0x0000FF"]'), null, 8000);
  report('H-28 lesson 5: blue chip is the pressed one', (await pg.$eval('#codeBody [data-chip="0x0000FF"]', (b) => b.getAttribute('aria-pressed'))) === 'true');
  // H-34: back to the default colour restores the lamp-strip labels
  await pg.click('#codeBody [data-chip="0xFF9933"]');
  const back = await waitFor(pg, () => {
    const cv = document.querySelector('#codeView');
    return cv?.dataset.fw === 'lamp-strip' && !!cv.querySelector('[data-file="lamp-strip/main/CMakeLists.txt"]') && !document.querySelector('#codeDefines')?.textContent?.includes('WARM') && globalThis.__tbApp.session.fwName === 'lamp-strip/flash.bin';
  }, null, 20000);
  const lb = await pg.evaluate(() => JSON.stringify([document.querySelector('#codeView')?.dataset.fw, globalThis.__tbApp.session.fwName, document.querySelector('#codeDefines')?.textContent]));
  report('H-34 lesson 5: default chip restores lamp-strip labels', back, lb);
  await pg.close();
}

// H-31 1280×720: the lesson card fits the right panel (only #lessonScroll scrolls), title and buttons in view; tree still shown
for (const [no, url] of [[1, 'work=weather&cp=01'], [5, 'work=lamp&cp=lamp-1'], [9, 'work=adc'], [11, 'work=weather&cp=06']]) {
  const pg = await open(`/app?${url}&debug=1&beginner=1#bench`, null, { width: 1280, height: 720, deviceScaleFactor: 1 });
  await waitFor(pg, () => !!document.querySelector('#lessonCard #lessonNext'), null, 5000);
  const m = await pg.evaluate(() => {
    const c = document.querySelector('#lessonCard');
    const sc = document.querySelector('#lessonScroll').getBoundingClientRect();
    const b = (s) => document.querySelector(s)?.getBoundingClientRect();
    const vis = (r) => !!r && r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1;
    const aside = b('#props');
    return {
      card: [c.scrollHeight, c.clientHeight],
      foot: document.querySelector('#lessonFoot').scrollHeight <= document.querySelector('#lessonFoot').clientHeight + 1,
      next: Math.round(b('#lessonNext').bottom),
      prev: Math.round(b('#lessonPrev').bottom),
      panel: Math.round(Math.min(aside.bottom, innerHeight)),
      h2: vis(b('#lessonCard h2')),
      task: vis(b('#lessonCard li[data-task="0"]')),
      tree: ['[data-kind=part]', '[data-kind=wire]'].map((s) => {
        const w = b(s), box = document.querySelector(s)?.closest('.overflow-auto').getBoundingClientRect();
        return !!w && w.height > 0 && w.bottom <= box.bottom + 1;
      }),
    };
  });
  const fit = m.card[0] <= m.card[1] + 1 && m.foot && m.next <= m.panel && m.prev <= m.panel && m.h2;
  report(`H-31 1280×720 lesson ${no}: card fits the panel, title and Previous / Next in view`, fit, JSON.stringify(m));
  // Lesson 11's step text is long enough that its first task sits just below the fold (DECISIONS 2026-10-27 H-31)
  if (no !== 11) report(`H-31 1280×720 lesson ${no}: first "Try it" task visible without scrolling`, m.task, JSON.stringify(m));
  // Lesson 11 has a dozen parts, so its wires sit further down the (half-column) tree; lesson 9's pot wires must show (H-22)
  report(`H-31 1280×720 lesson ${no}: build tree still visible beside the card (H-22)`, m.tree[0] && (no === 11 || m.tree[1]), JSON.stringify(m));
  if (no === 9) {
    // Lesson 9's left step list only gets what the tree leaves, so the current step must scroll into it
    for (let i = 1; i <= 4; i++) {
      await pg.click('#lessonNext');
      await waitFor(pg, (k) => document.querySelector('#lessonCard')?.dataset.step === String(k), i, 3000);
    }
    const left = await waitFor(pg, () => {
      const r = document.querySelector('#lessonSteps [aria-current="step"]')?.getBoundingClientRect();
      const box = document.querySelector('#lessonSteps').closest('.overflow-auto').getBoundingClientRect();
      return document.querySelector('#lessonCard')?.dataset.step === '4' && !!r && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    }, null, 3000);
    report('H-31 1280×720 lesson 9: Next to step 5, left list keeps it in view', left);
    const nx = await pg.$eval('#lessonNext', (e) => Math.round(e.getBoundingClientRect().bottom) <= innerHeight - 200);
    report('H-31 1280×720 lesson 9 step 5: Finish button still above the dock', nx);
    // Past the last step with tasks left (H-30): the "not done yet" list scrolls, the card and its buttons still fit
    await pg.click('#lessonNext');
    await waitFor(pg, () => !!document.querySelector('#lessonCard[data-todo] #lessonTodo'), null, 3000);
    const td = await pg.evaluate(() => {
      const c = document.querySelector('#lessonCard');
      return { card: [c.scrollHeight, c.clientHeight], next: Math.round(document.querySelector('#lessonNext').getBoundingClientRect().bottom), panel: Math.round(document.querySelector('#props').getBoundingClientRect().bottom), h2: Math.round(document.querySelector('#lessonCard h2').getBoundingClientRect().bottom), scroll: Math.round(document.querySelector('#lessonScroll').getBoundingClientRect().bottom) };
    });
    report('H-31 1280×720 lesson 9 not done yet: card fits, title and locked Next in view', td.card[0] <= td.card[1] + 1 && td.next <= td.panel && td.h2 <= td.scroll, JSON.stringify(td));
  }
  await pg.close();
}

report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails ? `[beginner] ${fails} FAIL` : '[beginner] all PASS');
process.exit(fails ? 1 : 0);
