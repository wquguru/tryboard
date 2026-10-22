// Checkpoints (reference firmware, fingerprint = tools/check.py), old-link redirects, upload progress, assembly, home cards (P0-21).
// Usage: node tools/webtest/levels.mjs (after tools/build_web.sh); screenshots in Reviews/web/levels-*.png
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
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
  console.log(`[levels] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function open(url) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await page.goto(base + url, { waitUntil: 'load' });
  return page;
}
/** Click an element that gets re-rendered: look it up by selector each time (no handle, so no "Node is detached") */
async function clickEl(page, sel) {
  await page.waitForSelector(sel, { timeout: 30000 });
  for (let i = 0; i < 10; i++) {
    // HTML elements: click(); SVG parts (no click()) get a real mouse click, re-found if the node was replaced
    const kind = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return 'none'; if (typeof e.click === 'function') { e.click(); return 'done'; } return 'svg'; }, sel);
    if (kind === 'done') return;
    if (kind === 'svg') {
      try {
        await page.click(sel);
        return;
      } catch {
        /* re-rendering, look again */
      }
    }
    await sleep(200);
  }
  throw new Error(`cannot click ${sel}`);
}
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}

// Verdicts and fingerprints from the native core
const native = {};
const cli = (() => { try { return execFileSync(path.join(root, 'tools/check.py'), ['--ref', '--all'], { encoding: 'utf8' }); } catch (e) { return e.stdout; } })();
for (const m of cli.matchAll(/^Checkpoint ([\w-]+) .*: (PASS|FAIL)\s+fingerprint (\S+)/gm)) native[m[1]] = { ok: m[2] === 'PASS', fp: m[3] };

// ---- 1. Bench checkpoints: reference firmware, fingerprint equals the CLI
const fpOf = (page) => page.$eval('#props .kv .v.fp', (e) => e.textContent.trim()).catch(() => '');
// Result card state (ok / bad / stall / shifted, DESIGN_V2 §9.2): judged by data-verdict, not by the wording
const verdictOf = (page) => page.$eval('#props .result-card', (e) => e.dataset.verdict).catch(() => '');
async function runRef(page, id) {
  // The build tree re-renders on power-up / timeline updates: the node may be replaced mid-click, so find it again
  for (let i = 0; ; i++) {
    await page.waitForSelector(`#tree .tn[data-kind="checkpoint"][data-id="${id}"]`, { timeout: 30000 });
    try {
      await page.click(`#tree .tn[data-kind="checkpoint"][data-id="${id}"]`);
      break;
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(300);
    }
  }
  // With a saved pass the result card is restored: clear the last raw output and wait for this run to finish
  await page.evaluate(() => (globalThis.__tbLastVerify = null));
  await clickEl(page, '#runRef:not([disabled])');
  await waitFor(page, () => !!globalThis.__tbLastVerify && !!document.querySelector('#props .verdict-line') && !document.querySelector('#runRef')?.disabled && !document.querySelector('#props .drop.busy'), null, 90000);
  const text = await page.$eval('#props', (e) => e.textContent).catch(() => '');
  const raw = await page.evaluate(() => globalThis.__tbLastVerify);
  fs.writeFileSync(path.join(outDir, `levels-${id}-web.json`), JSON.stringify(raw, null, 1));
  return { ok: (await verdictOf(page)) === 'ok', fp: await fpOf(page), text };
}
for (const [work, cps] of [['weather', ['01', '02', '03', '04', '05', '06']], ['spin', ['spin-1', 'spin-2', '07-spin']], ['lens', ['lens-1', 'lens-2', '07-lens']], ['usbkey', ['usbkey-1', 'usbkey-2', 'usbkey-3']], ['lamp', ['lamp-1', 'lamp-2', 'lamp-3']], ['ruler', ['ruler-1', 'ruler-2', 'ruler-3']], ['tilt', ['tilt-1', 'tilt-2', 'tilt-3']], ['door', ['door-1', 'door-2', 'door-3', 'door-4']], ['irlamp', ['irlamp-1', 'irlamp-2', 'irlamp-3', 'irlamp-4']]]) {
  const page = await open(`/app?work=${work}#bench`);
  for (const id of cps) {
    const r = await runRef(page, id);
    const n = native[id];
    report(`checkpoint ${id} (${work}) reference firmware`, r.ok && n?.ok && r.fp === n.fp, `web ${r.ok ? 'pass' : 'fail'} ${r.fp} / CLI ${n?.fp}`);
    if (!r.ok) console.log(r.text.slice(0, 600));
    if (id === '06' || id === '07-spin') await page.screenshot({ path: path.join(outDir, `levels-cp-${id}.png`) });
  }
  await page.close();
}

// ---- 1b. Two checkpoint grades (U-22): run all with built-in firmware -> all ◐, CLI fingerprints, assembly unlocked;
//      old progress (no own field) stays ✓ and is not downgraded by the reference firmware
{
  const W = ['01', '02', '03', '04', '05', '06'];
  const marks = (page) => page.$$eval('#tree .tn[data-kind="checkpoint"]', (els) => els.map((e) => e.textContent.trim().slice(-1)));
  const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('tryboard-app-checks:weather') ?? '{}'));
  const page = await open('/app?work=weather#bench');
  await page.evaluate(() => ['checks', 'asm', 'case'].forEach((k) => localStorage.removeItem(`tryboard-app-${k}:weather`)));
  await page.reload({ waitUntil: 'load' });
  await clickEl(page, '#cpAllRef:not([disabled])').catch(async (e) => {
    console.log('[levels] #cpCard:', await page.$eval('#cpCard', (x) => x.outerHTML.slice(0, 600)).catch(() => 'none'), page.url());
    throw e;
  });
  const all = await waitFor(page, () => /All 6 checkpoints (pass|ran)/.test(document.querySelector('#cpCard')?.textContent ?? ''), null, 600000);
  const m = await marks(page);
  const sv = await saved(page);
  await page.screenshot({ path: path.join(outDir, 'levels-allref.png') });
  report('run all with built-in firmware: 6/6 pass, all ◐, local progress saved as reference', all && m.join('') === '◐◐◐◐◐◐' && W.every((id) => sv[id]?.own === false), `${m.join('')} ${JSON.stringify(Object.values(sv).map((v) => v.own))}`);
  report('run IDs of the full run equal CLI check.py --ref', W.every((id) => sv[id]?.fp === native[id]?.fp), W.map((id) => `${id}:${sv[id]?.fp}/${native[id]?.fp}`).join(' '));
  report('card says My firmware 0/6', /My firmware 0\/6/.test(await page.$eval('#cpCard', (e) => e.textContent).catch(() => '')));
  await page.goto(`${base}/app?work=weather&asm=svg#assemble`, { waitUntil: 'load' });
  report('assembly unlocked after the reference run (still after reload)', await waitFor(page, () => !!document.querySelector('.asm-box [data-part]') && !document.querySelector('#lockList'), null, 30000));
  // Progress saved by older versions has no own field: counts as own firmware; a reference run does not overwrite it
  await page.evaluate((fp) => {
    localStorage.setItem('tryboard-app-checks:weather', JSON.stringify({ '01': { fp, at: 'old' } }));
    localStorage.removeItem('tryboard-app-asm:weather');
  }, native['01']?.fp);
  await page.goto(`${base}/app?work=weather&asm=svg#assemble`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#lockList', { timeout: 30000 });
  const lock = await page.$$eval('#lockList li', (els) => els.map((e) => e.textContent.trim()[0]).join(''));
  report('assembly lock card: old progress 01 is ✓, rest ○, has "Run all with built-in firmware"', lock === '✓○○○○○' && !!(await page.$('#lockAllRef')), lock);
  await page.evaluate(() => (location.hash = 'bench'));
  const r = await runRef(page, '01');
  const m2 = await marks(page);
  const sv2 = await saved(page);
  report('old progress not downgraded: 01 after a reference run is still ✓, local record unchanged', r.ok && m2[0] === '✓' && sv2['01']?.at === 'old' && sv2['01']?.own !== false, `${m2.join('')} ${JSON.stringify(sv2['01'])}`);
  await page.evaluate(() => localStorage.removeItem('tryboard-app-checks:weather'));
  await page.close();
}

// ---- 2. Old levels page redirects
for (const [hash, work, cp] of [['04', 'weather', '04'], ['07-lens', 'lens', '07-lens'], ['', 'weather', null]]) {
  const page = await open(`/levels.html${hash ? '#' + hash : ''}`);
  await waitFor(page, () => location.pathname.endsWith('/app'), null, 10000);
  const sel = cp ? await waitFor(page, (cp) => document.querySelector(`#tree .tn[data-kind="checkpoint"][data-id="${cp}"]`)?.getAttribute('aria-selected') === 'true' && document.querySelector('#props')?.textContent.includes(`Checkpoint ${cp}`), cp, 30000) : true;
  const u = new URL(page.url());
  report(`old link levels.html#${hash} -> app?work=${work}${cp ? '&cp=' + cp : ''}#bench${cp ? ', checkpoint ' + cp + ' selected' : ''}`, u.pathname.endsWith('/app') && u.searchParams.get('work') === work && u.searchParams.get('cp') === cp && u.hash === '#bench' && sel, page.url().replace(base, ''));
  if (hash === '04') await page.screenshot({ path: path.join(outDir, 'levels-redirect-04.png') });
  await page.close();
}

// ---- 3. Upload own firmware (C3 blink also meets checkpoint 01), progress is remembered
{
  const page = await open('/app?work=weather&cp=01#bench');
  // The panel re-renders after load and replaces the input, so a stale node loses the upload: retry until busy or a verdict
  for (let i = 0; i < 5; i++) {
    await page.waitForSelector('#props [data-drop="check"] input', { timeout: 30000 });
    const input = await page.$('#props [data-drop="check"] input');
    // It can also re-render between the two steps: a missing or detached node means try again
    await input?.uploadFile(path.join(root, 'firmware/build/blink/flash.bin')).catch(() => {});
    const started = await waitFor(page, () => !!document.querySelector('#props [data-drop="check"].busy, #props .verdict-line'), null, 3000);
    if (started) break;
  }
  await waitFor(page, () => document.querySelector('#props .result-card')?.dataset.verdict === 'ok', null, 90000);
  const who = await page.$eval('#props .verdict-line', (e) => e.textContent).catch(() => '');
  const tree = await page.$eval('#tree .tn[data-kind="checkpoint"][data-id="01"] .tn-st', (e) => e.className).catch(() => '');
  await page.reload({ waitUntil: 'load' });
  const kept = await waitFor(page, () => /Checkpoints 1\/6/.test(document.getElementById('verdict')?.textContent ?? ''), null, 30000);
  report('upload own firmware -> checkpoint 01 passes, progress kept after reload (1/6)', /flash\.bin/.test(who) && /ok/.test(tree) && kept, who.trim());
  await page.evaluate(() => localStorage.clear());
  await page.close();
}

// ---- 4. Assembly: flat view of the Assemble step (?asm=svg, views/assembly) -> power-on retest -> Product (U-08)
const CPS = { weather: ['01', '02', '03', '04', '05', '06'], spin: ['spin-1', 'spin-2', '07-spin'], lens: ['lens-1', 'lens-2', '07-lens'] };
async function openAsm(work) {
  const p = await open(`/app?work=${work}#bench`);
  // Preset all checkpoints as passed (unlocks assembly) and clear the last assembly, as asm3d.mjs does
  await p.evaluate(([w, ids]) => {
    const c = {};
    for (const id of ids) c[id] = { fp: 'test', at: 'preset' };
    localStorage.setItem(`tryboard-app-checks:${w}`, JSON.stringify(c));
    localStorage.removeItem(`tryboard-app-asm:${w}`);
    localStorage.removeItem(`tryboard-app-case:${w}`);
  }, [work, CPS[work]]);
  await p.goto(`${base}/app?work=${work}&asm=svg#assemble`, { waitUntil: 'load' });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('.asm-box [data-part]', { timeout: 30000 });
  return p;
}
/** Click power-on retest, wait for it to finish, return the properties panel text */
async function retest(page) {
  await clickEl(page, '#toolbar [data-tool="asm-retest"]');
  await waitFor(page, () => /Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 10000);
  await waitFor(page, () => !!document.querySelector('#props .verdict-line') && !/Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 120000);
  return page.$eval('#props', (e) => e.textContent);
}
/** Go to the Product step and wait for the screen to get a frame */
async function toProduct(page) {
  await page.evaluate(() => (location.hash = 'product'));
  return waitFor(page, () => location.hash === '#product' && !!globalThis.__tbProduct?.screen?.(), null, 30000);
}
{
  const page = await openAsm('weather');
  // Mouse drag: part card -> its layer position on the stage (SVG coordinates converted to screen)
  const drag = async (part, sx, sy) => {
    const from = await page.$eval(`.asm-box [data-part="${part}"]`, (g) => { const r = g.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    const to = await page.$eval('.asm-box svg', (s, [x, y]) => { const p = new DOMPoint(x, y).matrixTransform(s.getScreenCTM()); return [p.x, p.y]; }, [sx, sy]);
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8);
    await page.mouse.up();
    await sleep(50);
  };
  const iso = (L, x, y) => [505 + 0.866 * x - 0.866 * y, 292 - L * 30 + 0.5 * x + 0.5 * y];
  const assemble = async (spot) => {
    for (const [L, k] of ['shell', 'board', 'bme', 'servo', 'oled', 'front'].entries()) {
      const [x, y] = k === 'bme' ? (spot === 'A' ? iso(2, 146, 55) : iso(2, 92, 43)) : iso(L, 90, 50);
      await drag(k, x, y);
    }
    return page.$eval('.asm-box', (e) => e.textContent.includes('6/6'));
  };
  await drag('front', ...iso(0, 90, 50));
  report('assembly: wrong order is blocked', await page.$eval('.asm-box', (e) => e.textContent.includes('“Front panel” can’t go in yet')));
  report('assembly: mouse drag 6/6 (sensor against the chip)', await assemble('B'));
  // Room 23.5 ℃ with the sensor against the chip: the retest firmware reads 2.5 ℃ high (old level 06 case)
  const hot = await retest(page);
  const hotV = await verdictOf(page);
  report('assembly: BME280 against the chip -> retest reads 26.0 ℃ (room 23.5 + 2.5), retest fails', (hotV === 'bad' || hotV === 'shifted') && /26\.0 ℃/.test(hot), hot.match(/Retest result.{0,120}/)?.[0]);
  await page.screenshot({ path: path.join(outDir, 'levels-asm-bad.png') });
  await clickEl(page, '#toolbar [data-tool="asm-reset"]');
  report('assembly: mouse drag 6/6 (next to the vent)', await assemble('A'));
  const good = await retest(page);
  report('assembly: next to the vent -> retest passes', (await verdictOf(page)) === 'ok', good.match(/Retest result.{0,60}/)?.[0]);
  // The timeline records the assembly and the retest
  const tl = await page.$eval('#timeline', (e) => e.textContent).catch(() => '');
  report('assembly: steps recorded in the timeline', /Power-on retest/.test(tl), tl.slice(-120));
  const lit = await toProduct(page);
  const reading = await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console')?.textContent ?? ''), null, 20000);
  report('assembly: Product step powers on -> reads T=23.50, product screen has a frame', lit && reading);
  await sleep(800);
  await page.screenshot({ path: path.join(outDir, 'levels-asm-product.png') });
  await page.close();
}
{
  // spin: horn pressed on directly (one tooth off) -> Product shows the offset, round LCD has a frame
  const page = await openAsm('spin');
  await clickEl(page, '.asm-box [data-part="base"]');
  await clickEl(page, '.asm-box [data-part="servo"]');
  await clickEl(page, '.asm-box [data-k="pickX"]');
  for (const k of ['board', 'lcd', 'body', 'hair']) await clickEl(page, `.asm-box [data-part="${k}"]`);
  const full = await page.$eval('.asm-box', (e) => e.textContent.includes('6/6'));
  const lit = await toProduct(page);
  const note = await waitFor(page, () => /horn is 14\.4° off/.test(document.getElementById('props')?.textContent ?? ''), null, 10000);
  report('assembly · spin: horn off -> Product says 14.4° off, round LCD has a frame', full && lit && note, `full=${full} lit=${lit} ${(await page.$eval('#props', (e) => e.textContent)).slice(0, 300)}`);
  await page.screenshot({ path: path.join(outDir, 'levels-asm-spin.png') });
  await page.close();
}
{
  const page = await openAsm('lens');
  for (const k of ['base', 'board', 'lcd', 'bezel', 'dome']) await clickEl(page, `.asm-box [data-part="${k}"]`);
  await clickEl(page, '.asm-box [data-k="pickH"]');
  const lit = await toProduct(page);
  report('assembly · lens -> Product round LCD has a frame', lit);
  await page.screenshot({ path: path.join(outDir, 'levels-asm-lens.png') });
  await page.close();
}

{
  // P2-09: ruler probes recessed in the holes -> the simulated HC-SR04 only sees the hole wall (3 cm), so the retest really fails;
  // poking them out passes. Pass the three checkpoints with uploaded firmware first (unlocks assembly)
  const page = await open('/app?work=ruler#bench');
  try {
    for (const [id, ref] of [['ruler-1', 'ruler-dist'], ['ruler-2', 'ruler-oled'], ['ruler-3', 'ruler']]) {
      await page.waitForSelector(`#tree .tn[data-kind="checkpoint"][data-id="${id}"]`, { timeout: 30000 });
      await clickEl(page, `#tree .tn[data-kind="checkpoint"][data-id="${id}"]`);
      await page.waitForSelector('#props [data-drop="check"] input:not([disabled])', { timeout: 30000 });
      // The properties panel re-renders: upload as soon as the input exists, re-find it if replaced
      for (let k = 0; ; k++) {
        try {
          const input = await page.$('#props [data-drop="check"] input:not([disabled])');
          await input.uploadFile(path.join(root, `firmware/build/${ref}/flash.bin`));
          break;
        } catch (e) {
          if (k >= 4) throw e;
          await sleep(300);
        }
      }
      // Wait for busy first, then this checkpoint's verdict (not the previous one's)
      await waitFor(page, () => !!document.querySelector('#props .drop.busy'), null, 15000);
      await waitFor(page, () => ['ok', 'bad'].includes(document.querySelector('#props .result-card')?.dataset.verdict) && !document.querySelector('#props .drop.busy'), null, 120000);
    }
    await page.evaluate(() => (location.hash = 'assemble'));
    await page.waitForSelector('.asm-box [data-part]', { timeout: 30000 });
    const build = async (pick) => {
      for (const k of ['shell', 'board', 'sonar', 'buzzer', 'oled', 'front']) {
        await clickEl(page, `.asm-box [data-part="${k}"]`);
        if (k === 'sonar') await clickEl(page, `.asm-box [data-k="pick${pick}"]`);
      }
      await clickEl(page, '#toolbar [data-tool="asm-retest"]');
      // Wait for retesting first, then for the end (not the previous result)
      await waitFor(page, () => /Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 10000);
      await waitFor(page, () => !!document.querySelector('#props .verdict-line') && !/Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 120000);
      return page.$eval('#props', (e) => e.textContent);
    };
    const bad = await build('B');
    const badV = await verdictOf(page);
    report('assemble · ruler: probes recessed -> retest misses 15 cm, wrong rhythm (mounting goes into the simulator)', (badV === 'bad' || badV === 'shifted') && /✗serial shows "DIST 15\.0 cm"/.test(bad) && /1\.8–2\.5 s: buzzer silent/.test(bad), bad.match(/Retest result.{0,300}/)?.[0]);
    await clickEl(page, '#toolbar [data-tool="asm-reset"]').catch(() => {});
    const good = await build('A');
    report('assemble · ruler: probes out of the front panel -> retest passes', (await verdictOf(page)) === 'ok' && /Assembly 6\/6, no warnings/.test(good), good.match(/Retest result.{0,60}/)?.[0]);
  } catch (e) {
    report('assemble · ruler: flow finished', false, String(e).slice(0, 200));
  }
  await page.close();
}

// ---- 5. Home page project cards
{
  const home = await open('/');
  const cards = await home.$$eval('.wk', (els) => els.map((e) => ({ work: e.dataset.work, go: e.querySelector('[data-go]')?.getAttribute('href'), cps: e.dataset.cps })));
  // Cards come from web/src/app/works.ts: P2-12 added the USB keypad, P2-09 the knob lamp, ultrasonic ruler and tilt figure, G-03 the door lock, G-04 the IR night light
  report('home: nine project cards (weather / spin / lens / usbkey / lamp / ruler / tilt / door / irlamp)', cards.map((c) => c.work).join() === 'weather,spin,lens,usbkey,lamp,ruler,tilt,door,irlamp', JSON.stringify(cards.map((c) => c.work)));
  await home.screenshot({ path: path.join(outDir, 'levels-home-0.png') });
  // Weather card runs real firmware: status line shows the serial reading, OLED has a frame; holding BOOT switches to ℉ and redraws
  await home.click('[data-run="weather"]');
  const reading = await waitFor(home, () => /T=23\.50 C/.test(document.querySelector('.wk[data-work="weather"] [data-status]').textContent), null, 30000);
  const oled = await waitFor(home, () => !!document.querySelector('.wk[data-work="weather"] image[data-k="oled"][href]'));
  report('home: weather card runs real firmware (serial T=23.50, OLED has a frame)', reading && oled);
  const before = await home.$eval('.wk[data-work="weather"] image[data-k="oled"]', (e) => e.getAttribute('href'));
  const b = await home.$eval('.wk[data-work="weather"] [data-k="boot"]', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await home.mouse.move(b[0], b[1]);
  await home.mouse.down();
  await sleep(250);
  await home.mouse.up();
  const changed = await waitFor(home, (h) => document.querySelector('.wk[data-work="weather"] image[data-k="oled"]').getAttribute('href') !== h, before, 5000);
  report('home: screen redraws after BOOT (switch to ℉)', changed);
  // Spin card: round LCD gets a frame; only one card runs at a time (weather stops, back to the sketch)
  await home.click('[data-run="spin"]');
  const spin = await waitFor(home, () => !!document.querySelector('.wk[data-work="spin"] image[data-k="lcd"][href]'), null, 20000);
  const single = await home.$$eval('.wk.live', (e) => e.map((x) => x.dataset.work).join());
  report('home: spin card runs real firmware -> round LCD frame, only one card runs', spin && single === 'spin', single);
  await sleep(600);
  await home.screenshot({ path: path.join(outDir, 'levels-home-spin.png') });
  await home.click('[data-run="lens"]');
  const lens = await waitFor(home, () => !!document.querySelector('.wk[data-work="lens"] image[data-k="lcd"][href]'), null, 20000);
  report('home: lens card runs real firmware -> round LCD frame', lens);
  // P2-09 generated cards run real firmware too: ruler OLED shows the distance, the lamp strip lights up
  await home.click('[data-run="ruler"]');
  const ruler = await waitFor(home, () => !!document.querySelector('.wk[data-work="ruler"] image[data-k="oled"][href]') && /DIST \d/.test(document.querySelector('.wk[data-work="ruler"] [data-status]').textContent), null, 30000);
  report('home: ruler card runs real firmware -> OLED frame, distance on serial', ruler);
  await home.click('[data-run="lamp"]');
  const lamp = await waitFor(home, () => document.querySelector('.wk[data-work="lamp"] [data-k="led0"]')?.getAttribute('fill') !== '#2A2A28', null, 30000);
  report('home: lamp card runs real firmware -> strip lights up', lamp);
  // G-03 door card: C3 firmware with RC522 + SH1106; the demo taps the whitelisted card, the OLED gets a frame and the strike opens
  await home.click('[data-run="door"]');
  const door = await waitFor(home, () => !!document.querySelector('.wk[data-work="door"] image[data-k="oled"][href]') && document.querySelector('.wk[data-work="door"] [data-k="bolt"]')?.getAttribute('x') === '532', null, 30000);
  report('home: door card runs real firmware -> OLED frame, whitelisted card opens the strike', door, await home.$eval('.wk[data-work="door"] [data-status]', (e) => e.textContent));
  // G-04 IR night light card: the demo presses digit 2 (0x18) at 1.5 s; the decoded code shows and the strip turns green
  await home.click('[data-run="irlamp"]');
  const irl = await waitFor(home, () => /00,18/.test(document.querySelector('.wk[data-work="irlamp"] [data-k="code"]')?.textContent ?? '') && document.querySelector('.wk[data-work="irlamp"] [data-k="led0"]')?.getAttribute('fill') === 'rgb(32,255,64)', null, 30000);
  report('home: irlamp card runs real firmware -> remote code decoded, strip turns green', irl, await home.$eval('.wk[data-work="irlamp"] [data-status]', (e) => e.textContent));
  // USB keypad card: the virtual PC enumerates TryBoard Macro Pad; clicking K1 types a
  await home.click('[data-run="usbkey"]');
  const enumd = await waitFor(home, () => /TryBoard Macro Pad/.test(document.querySelector('.wk[data-work="usbkey"] [data-k="dev"]')?.textContent ?? ''), null, 20000);
  const k1 = await home.$eval('.wk[data-work="usbkey"] [data-k="key0"]', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await home.mouse.move(k1[0], k1[1]);
  await home.mouse.down();
  await sleep(200);
  await home.mouse.up();
  const typedA = await waitFor(home, () => /^a▌?$/.test(document.querySelector('.wk[data-work="usbkey"] [data-k="l0"]')?.textContent ?? ''), null, 10000);
  report('home: USB keypad card runs real firmware -> PC enumerates it, K1 types a', enumd && typedA);
  await home.screenshot({ path: path.join(outDir, 'levels-home-full.png'), fullPage: true });
  await home.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(300);
  const overflow = await home.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  report('home: no horizontal scroll at phone width', !overflow);
  await home.screenshot({ path: path.join(outDir, 'levels-home-phone.png') });
  await home.close();
  // Entries: each card's start button goes to Shop (data-cps equals the bench checkpoint count), #ownIdea to /select, #haveFw to the blank Bench
  for (const c of cards) {
    const p = await open('/');
    await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click(`.wk[data-work="${c.work}"] [data-go]`)]);
    const u = new URL(p.url());
    const n = c.cps.match(/\d+/)?.[0];
    // The Shop verdict button shows rule warnings (since P0-07); checkpoint progress is on the Bench
    await p.evaluate(() => (location.hash = 'bench'));
    const v = await waitFor(p, (n) => new RegExp(`Checkpoints 0?\\d*/${n}`).test(document.getElementById('verdict')?.textContent ?? ''), n, 30000);
    report(`home start (${c.work}) -> /app?work=${c.work}#shop, ${n} checkpoints as on the Bench`, u.pathname.endsWith('/app') && u.searchParams.get('work') === c.work && u.hash === '#shop' && v, p.url().replace(base, ''));
    await p.close();
  }
  const isSelect = () => !!document.querySelector('#templates');
  for (const [sel, want, check] of [['#ownIdea', '/select', isSelect], ['#haveFw', '/app', () => new URLSearchParams(location.search).get('work') === 'blank' && location.hash === '#bench' && /^Blank$/.test(document.getElementById('workName')?.textContent ?? '')]]) {
    const p = await open('/');
    await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click(sel)]);
    const ok = await waitFor(p, check, null, 15000);
    report(`home entry ${sel} -> ${want}`, new URL(p.url()).pathname.endsWith(want) && ok, p.url().replace(base, ''));
    await p.close();
  }
}

// ---- 5b. Old .html addresses -> new ones (DESIGN_V2 §7.2): bookmarks keep working, query and hash carried over
{
  for (const [from, want, check] of [
    ['/home.html#works', (u) => u.pathname.endsWith('/') && u.hash === '#works', () => !!document.querySelector('.wk')],
    ['/advisor.html?t=weather', (u) => u.pathname.endsWith('/select') && u.searchParams.get('t') === 'weather', () => !!document.querySelector('#templates')],
    ['/index.html?example=blink', (u) => u.pathname.endsWith('/app') && u.searchParams.get('work') === 'blank' && u.searchParams.get('example') === 'blink' && u.hash === '#bench', () => !!document.getElementById('workName')],
    ['/levels.html#04', (u) => u.pathname.endsWith('/app') && !!u.searchParams.get('work') && u.hash === '#bench', () => !!document.getElementById('workName')],
    ['/licenses.html', (u) => u.pathname.endsWith('/licenses.html'), () => /Licenses (&|and) credits/.test(document.querySelector('h1')?.textContent ?? '')],
    ['/changelog', (u) => u.pathname.endsWith('/changelog'), () => /What's new/.test(document.querySelector('h1')?.textContent ?? '') && !!document.querySelector('link[rel=alternate][href="./changelog.xml"]')],
    ['/licenses', (u) => u.pathname.endsWith('/licenses'), () => !!document.querySelector('a[href="./THIRD_PARTY_NOTICES.txt"]') && !!document.querySelector('a[href="./tryboard.spdx.json"]')],
  ]) {
    const p = await open(from);
    const ok = await waitFor(p, check, null, 15000);
    const u = new URL(p.url());
    report(`old address ${from} -> ${u.pathname.replace(/^.*\//, '/')}${u.search}${u.hash}`, want(u) && ok, p.url().replace(base, ''));
    await p.close();
  }
}

// ---- 6. Examples (blank Bench) reach assembly too: the example card's make-it-real link -> project Shop; click assembly -> Product frame
{
  const ex = await open('/app?work=blank&example=weather#bench');
  await ex.waitForSelector('#props [data-ex-work="weather"]', { timeout: 30000 });
  await Promise.all([ex.waitForNavigation({ waitUntil: 'load' }), clickEl(ex, '#props [data-ex-work="weather"]')]);
  const u = new URL(ex.url());
  report('example card make-it-real -> /app?work=weather#shop', u.searchParams.get('work') === 'weather' && u.hash === '#shop', ex.url().replace(base, ''));
  await ex.close();
  const page = await openAsm('weather');
  for (const k of ['shell', 'board', 'bme']) await clickEl(page, `.asm-box [data-part="${k}"]`);
  await clickEl(page, '.asm-box [data-k="pickA"]');
  for (const k of ['servo', 'oled', 'front']) await clickEl(page, `.asm-box [data-part="${k}"]`);
  const full = await page.$eval('.asm-box', (e) => e.textContent.includes('6/6'));
  const lit = await toProduct(page);
  report('bench: click-to-assemble -> Product has a frame', full && lit);
  await sleep(800);
  await page.screenshot({ path: path.join(outDir, 'levels-lab-product.png') });
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[levels] page errors:\n  ' + errors.join('\n  '));
console.log(`[levels] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
