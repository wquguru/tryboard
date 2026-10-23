// 3D assembly (P1-07) + parametric case export (P1-08): real mouse drags, retest ✗ / ✓, explode / section / ruler, STL / 3MF, SVG fallback.
// Checkpoint progress is preset in localStorage (levels.mjs tests the real thing). Usage: node tools/webtest/asm3d.mjs
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
const dlDir = path.join(outDir, 'asm3d-dl');
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });
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
  console.log(`[asm3d] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `asm3d-${name}.png`) });

const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
await page.goto(`${base}/app?work=weather#bench`, { waitUntil: 'load' });
await page.evaluate(() => {
  const p = {};
  for (const id of ['01', '02', '03', '04', '05', '06']) p[id] = { fp: 'test', at: 'preset' };
  localStorage.setItem('tryboard-app-checks:weather', JSON.stringify(p));
  localStorage.removeItem('tryboard-app-asm:weather');
  localStorage.removeItem('tryboard-app-case:weather');
});
await page.goto(`${base}/app?work=weather#assemble`, { waitUntil: 'load' });
await page.reload({ waitUntil: 'load' });
const ready = await waitFor(page, () => !!globalThis.__tbAsm3d && !!document.querySelector('.asm3d-stage canvas'), null, 40000);
report('Assemble step is a 3D view (parametric case + three.js)', ready);
await sleep(1500);
await shot(page, 'start');

const msg = () => page.$eval('#props .asm-msg', (e) => e.textContent).catch(() => '');
async function drag(id, key) {
  // Parts fly back to the tray with a transition: wait until it settles before pressing
  let from = null;
  for (let i = 0; i < 30; i++) {
    const p = await page.evaluate((x) => globalThis.__tbAsm3d.partScreen(x), id);
    if (p && from && Math.hypot(p[0] - from[0], p[1] - from[1]) < 0.5) break;
    from = p;
    await sleep(100);
  }
  const to = await page.evaluate(([i, k]) => globalThis.__tbAsm3d.slotScreen(i, k), [id, key]);
  if (!from || !to) return false;
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let s = 1; s <= 14; s++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * s) / 14, from[1] + ((to[1] - from[1]) * s) / 14);
    await sleep(16);
  }
  await sleep(120);
  await page.mouse.up();
  await sleep(250);
  return true;
}
const asmState = () => page.evaluate(() => globalThis.__tbApp.store.get().assembly);
const tool = (id) => page.click(`#toolbar button[data-tool="${id}"]`);

// Wrong order: drag the front panel first
await drag('front');
report('wrong order is blocked (front panel first)', /“Front panel” can’t go in yet/.test(await msg()), (await msg()).trim());

async function assemble(bmeKey, from = 0) {
  const order = ['shell', 'board', 'bme', 'servo', 'oled', 'front'];
  for (const id of order.slice(from)) {
    await drag(id, id === 'bme' ? bmeKey : undefined);
    if (id === 'bme') await shot(page, `bme-${bmeKey}`);
  }
  return asmState();
}
let a = await assemble('B');
report('real mouse drag 6/6 (BME280 next to the chip)', a?.placed.length === 6 && a.choice.bme === 'B' && a.effects.sensorOffset === 2.5, JSON.stringify(a && { n: a.placed.length, choice: a.choice, fx: a.effects }));
await sleep(500);
await shot(page, 'done-B');

async function retest() {
  await tool('asm-retest');
  await waitFor(page, () => /Retest (failed|passed)/.test(document.getElementById('verdict').textContent), null, 120000);
  return page.$eval('#verdict', (e) => e.textContent);
}
let v = await retest();
const rows = await page.$eval('#props', (e) => e.textContent);
report('power-on retest ✗ (sensor against the chip, reads high)', /Retest failed/.test(v) && /25\.0 ℃|26\.0 ℃/.test(rows), `${v} · ${(rows.match(/Sensor reads [\d.]+ ℃/) ?? [''])[0]}`);
await shot(page, 'retest-bad');

// Step back ×5 (retest, front, OLED, servo, BME280) to the board step, then drag BME280 next to the vent
for (let i = 0; i < 5; i++) await tool('asm-undo');
a = await asmState();
report('step back ×5 to the board step', a?.placed.length === 2, JSON.stringify(a?.placed));
a = await assemble('A', 2);
report('finish with BME280 next to the vent', a?.placed.length === 6 && a.choice.bme === 'A' && a.effects.sensorOffset === 0 && a.clean, JSON.stringify(a && a.choice));
v = await retest();
report('power-on retest ✓', /Retest passed/.test(v), v);
await shot(page, 'retest-ok');

// Tools: explode, section, ruler
await tool('asm-explode');
await sleep(900);
await shot(page, 'explode');
report('explode', await page.evaluate(() => globalThis.__tbAsm3d.exploded()));
await tool('asm-explode');
await tool('asm-section');
await sleep(600);
await shot(page, 'section');
report('section', await page.evaluate(() => globalThis.__tbAsm3d.section()));
await tool('asm-ruler');
await sleep(600);
const rt = await page.evaluate(() => globalThis.__tbAsm3d.rulerText());
report('ruler: BME280 to chip distance', rt.some((t) => /BME280 to chip ≈ \d+ mm/.test(t)), rt.join(' | '));
await shot(page, 'ruler');
await tool('asm-ruler');
await tool('asm-section');

// The Product step uses this assembly
await page.click('#next');
const prod = await waitFor(page, () => location.hash === '#product' && !document.querySelector('.prod-preview:not([hidden])'), null, 10000);
report('assembled -> Product step (not the reference product)', prod);

// Shop case details: height 28 -> too short; export
await page.evaluate(() => {
  globalThis.__tbApp.store.set({ selection: { kind: 'part', id: 'enclosure-weather' } });
  location.hash = 'shop';
});
await waitFor(page, () => !!document.querySelector('#props [data-cpn="height"]'), null, 10000);
await page.$eval('#props [data-cpn="height"]', (i) => {
  i.value = '28';
  i.dispatchEvent(new Event('change'));
});
await sleep(300);
const warnTxt = await page.$eval('#props', (e) => e.textContent);
report('height 28 mm -> too short for the servo', /Too short/.test(warnTxt) && /Minimum height\s*31 mm/.test(warnTxt.replace(/\s+/g, ' ')), (warnTxt.match(/Too short[^)]*\)/) ?? [''])[0]);
await shot(page, 'shop-low');
await page.$eval('#props [data-cpn="height"]', (i) => {
  i.value = '34';
  i.dispatchEvent(new Event('change'));
});
await sleep(300);
for (const fmt of ['stl', '3mf']) {
  await page.evaluate(() => (globalThis.__tbCase = null));
  await page.click(`#props [data-export="${fmt}"]`);
  await waitFor(page, () => !!globalThis.__tbCase, null, 30000);
  const r = await page.evaluate(() => globalThis.__tbCase);
  const file = path.join(dlDir, r?.name ?? 'x');
  await waitFor(page, () => true, null, 100);
  for (let i = 0; i < 30 && !fs.existsSync(file); i++) await sleep(200);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  report(`export ${fmt.toUpperCase()}: downloaded ${size} bytes, read back`, !!r && r.check.ok && size === r.bytes && /h34/.test(r.name), r ? `${r.name} ${r.check.text}` : 'no result');
}
await shot(page, 'shop-export');

// Back to Assemble: the case rebuilds at the new height (34 mm) and the timeline replays into it
await page.evaluate(() => (location.hash = 'assemble'));
const rebuilt = await waitFor(page, () => /34 mm/.test(document.querySelector('.a3-disc')?.textContent ?? '') && globalThis.__tbApp.store.get().assembly?.placed.length === 6, null, 30000);
report('height changed, back to Assemble: case rebuilt, assembly replayed 6/6', rebuilt);
await sleep(800);
await shot(page, 'rebuilt');

// SVG fallback
const p2 = await browser.newPage();
p2.on('pageerror', (e) => errors.push(`svg: ${e}`));
await p2.goto(`${base}/app?work=weather&asm=svg#assemble`, { waitUntil: 'load' });
const svgOk = await waitFor(p2, () => !!document.querySelector('.asm-shell svg [data-part="shell"]'), null, 30000);
await p2.click('.asm-shell [data-part="shell"]');
await sleep(200);
const s2 = await p2.evaluate(() => globalThis.__tbApp.store.get().assembly?.placed ?? []);
report('?asm=svg fallback: SVG view assembles', svgOk && s2.length >= 1, JSON.stringify(s2));
await p2.close();

// G-03c RFID door (SVG assembly): reader on the steel back box -> retest reads no card and fails; against the card zone -> passes;
// then the 3D product's strike follows the relay (a whitelisted card opens it for 3 s)
{
  const p3 = await browser.newPage();
  p3.on('pageerror', (e) => errors.push(`door: ${e}`));
  p3.on('console', (m) => { if (m.type() === 'error') errors.push(`door: ${m.text()}`); });
  await p3.goto(`${base}/app?work=door#bench`, { waitUntil: 'load' });
  await p3.evaluate(() => {
    const c = {};
    for (const id of ['door-1', 'door-2', 'door-3', 'door-4']) c[id] = { fp: 'test', at: 'preset' };
    localStorage.setItem('tryboard-app-checks:door', JSON.stringify(c));
    localStorage.removeItem('tryboard-app-asm:door');
  });
  await p3.goto(`${base}/app?work=door#assemble`, { waitUntil: 'load' });
  await p3.reload({ waitUntil: 'load' });
  await p3.waitForSelector('.asm-box [data-part]', { timeout: 30000 });
  const click = async (sel) => {
    for (let i = 0; i < 20; i++) {
      try {
        await p3.waitForSelector(sel, { timeout: 5000 });
        await p3.click(sel);
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`cannot click ${sel}`);
  };
  const build = async (pick) => {
    for (const k of ['back', 'board', 'relay', 'buzzer', 'led', 'oled', 'rc522', 'front']) {
      await click(`.asm-box [data-part="${k}"]`);
      if (k === 'rc522') await click(`.asm-box [data-k="pick${pick}"]`);
    }
    await click('#toolbar [data-tool="asm-retest"]');
    await waitFor(p3, () => /Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 10000);
    await waitFor(p3, () => !!document.querySelector('#props .verdict-line') && !/Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 120000);
    return {
      v: await p3.$eval('#props .result-card', (e) => e.dataset.verdict).catch(() => ''),
      txt: await p3.$eval('#props', (e) => e.textContent),
      a: await p3.evaluate(() => globalThis.__tbApp.store.get().assembly),
    };
  };
  try {
    const bad = await build('B');
    report('door: reader on the steel back box -> cards never reach the RC522, retest fails', bad.a?.effects?.cardBlock === true && (bad.v === 'bad' || bad.v === 'shifted'), `${bad.v} ${(bad.txt.match(/Retest result.{0,200}/) ?? [''])[0]}`);
    await shot(p3, 'door-bad');
    await click('#toolbar [data-tool="asm-reset"]');
    const good = await build('A');
    report('door: reader against the card zone -> retest passes, assembly clean', good.a?.effects?.cardBlock === false && good.v === 'ok' && /Assembly 8\/8, no warnings/.test(good.txt), `${good.v} ${(good.txt.match(/Retest result.{0,80}/) ?? [''])[0]}`);
    await shot(p3, 'door-ok');
    await click('#next');
    const ready = await waitFor(p3, () => location.hash === '#product' && !!globalThis.__tbProduct?.state && !!document.querySelector('canvas'), null, 30000);
    // Let the live sim reach the card polling loop before tapping
    await sleep(2500);
    const closed0 = await p3.evaluate(() => globalThis.__tbProduct.state().open);
    // The level script may leave a card on the reader or the 10 s lockout running: lift it, then tap and retap until the strike opens
    const tap = async (uid) => p3.evaluate((u) => globalThis.__tbApp.session.sim.partInput({ kind: 'card', uid: u }), uid);
    let opened = false;
    for (let i = 0; i < 8 && !opened; i++) {
      await tap('none');
      await sleep(600);
      await tap('DEADBEEF');
      opened = await waitFor(p3, () => globalThis.__tbProduct.state().open === true, null, 3000);
    }
    await sleep(400);
    await shot(p3, 'door-open');
    await p3.evaluate(() => globalThis.__tbApp.session.sim.partInput({ kind: 'card', uid: 'none' }));
    const reclosed = await waitFor(p3, () => globalThis.__tbProduct.state().open === false, null, 15000);
    report('door: 3D product strike follows the relay (whitelisted card opens it, closes again after 3 s)', ready && closed0 === false && opened && reclosed, `ready=${ready} closed0=${closed0} opened=${opened} reclosed=${reclosed}`);
  } catch (e) {
    report('door: flow finished', false, String(e).slice(0, 200));
  }
  await p3.close();
}

// G-04c IR night light (SVG assembly): receiver behind the opaque wall -> retest receives no remote code and fails; in the IR window ->
// passes; then a real click on key 3 of the 3D remote sends ir=FF00,A15E and the strip turns blue
{
  const p4 = await browser.newPage();
  await p4.setViewport({ width: 1280, height: 860 });
  p4.on('pageerror', (e) => errors.push(`irlamp: ${e}`));
  p4.on('console', (m) => { if (m.type() === 'error') errors.push(`irlamp: ${m.text()}`); });
  await p4.goto(`${base}/app?work=irlamp#bench`, { waitUntil: 'load' });
  await p4.evaluate(() => {
    const c = {};
    for (const id of ['irlamp-1', 'irlamp-2', 'irlamp-3', 'irlamp-4']) c[id] = { fp: 'test', at: 'preset' };
    localStorage.setItem('tryboard-app-checks:irlamp', JSON.stringify(c));
    localStorage.removeItem('tryboard-app-asm:irlamp');
  });
  await p4.goto(`${base}/app?work=irlamp#assemble`, { waitUntil: 'load' });
  await p4.reload({ waitUntil: 'load' });
  await p4.waitForSelector('.asm-box [data-part]', { timeout: 30000 });
  const click = async (sel) => {
    for (let i = 0; i < 20; i++) {
      try {
        await p4.waitForSelector(sel, { timeout: 5000 });
        await p4.click(sel);
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`cannot click ${sel}`);
  };
  const build = async (pick) => {
    for (const k of ['base', 'board', 'shifter', 'strip', 'irrx', 'shade']) {
      await click(`.asm-box [data-part="${k}"]`);
      if (k === 'strip') await click('.asm-box [data-k="choose_strip"] [data-k="pickA"]');
      if (k === 'irrx') await click(`.asm-box [data-k="choose_irrx"] [data-k="pick${pick}"]`);
    }
    await click('#toolbar [data-tool="asm-retest"]');
    await waitFor(p4, () => /Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 10000);
    await waitFor(p4, () => !!document.querySelector('#props .verdict-line') && !/Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 120000);
    return {
      v: await p4.$eval('#props .result-card', (e) => e.dataset.verdict).catch(() => ''),
      txt: await p4.$eval('#props', (e) => e.textContent),
      a: await p4.evaluate(() => globalThis.__tbApp.store.get().assembly),
    };
  };
  try {
    const bad = await build('B');
    report('irlamp: receiver behind the opaque wall -> no remote code arrives, retest fails', bad.a?.effects?.irBlock === true && (bad.v === 'bad' || bad.v === 'shifted'), `${bad.v} ${(bad.txt.match(/Retest result.{0,200}/) ?? [''])[0]}`);
    await shot(p4, 'irlamp-bad');
    await click('#toolbar [data-tool="asm-reset"]');
    const good = await build('A');
    report('irlamp: receiver in the IR window -> retest passes, assembly clean', good.a?.effects?.irBlock === false && good.v === 'ok' && /Assembly 6\/6, no warnings/.test(good.txt), `${good.v} ${(good.txt.match(/Retest result.{0,80}/) ?? [''])[0]}`);
    await shot(p4, 'irlamp-ok');
    await click('#next');
    const ready = await waitFor(p4, () => location.hash === '#product' && !!globalThis.__tbProduct?.state && !!document.querySelector('canvas'), null, 30000);
    // Let the live sim reach the receive loop before pressing a key
    await sleep(2500);
    const blue = () => p4.evaluate(() => {
      const s = globalThis.__tbProduct.strip();
      return s.length === 8 && s.every((c) => c[2] > 40 && c[2] > 2 * c[0] && c[2] > 2 * c[1]);
    });
    let sent = '', turned = false;
    for (let i = 0; i < 4 && !turned; i++) {
      const [x, y] = await p4.evaluate(() => globalThis.__tbProduct.handlePos());
      await p4.mouse.click(x, y);
      sent = await p4.evaluate(() => globalThis.__tbProduct.state().key);
      turned = await waitFor(p4, () => {
        const s = globalThis.__tbProduct.strip();
        return s.length === 8 && s.every((c) => c[2] > 40 && c[2] > 2 * c[0] && c[2] > 2 * c[1]);
      }, null, 4000);
    }
    await sleep(300);
    await shot(p4, 'irlamp-3d');
    report('irlamp: clicking key 3 on the 3D remote sends ir=FF00,A15E and the strip turns blue', ready && sent === 'FF00,A15E' && turned && (await blue()), `ready=${ready} sent=${sent} turned=${turned}`);
  } catch (e) {
    report('irlamp: flow finished', false, String(e).slice(0, 200));
  }
  await p4.close();
}

// G-05c cloud reporter (SVG assembly): AHT20 against the board -> every published t is 2.5 ℃ high, cloud-4's room temperature item
// fails the retest; by the vents -> passes; then the 3D tablet shows the readings and its interval=2 button changes the interval
{
  const p5 = await browser.newPage();
  await p5.setViewport({ width: 1280, height: 860 });
  p5.on('pageerror', (e) => errors.push(`cloud: ${e}`));
  p5.on('console', (m) => { if (m.type() === 'error') errors.push(`cloud: ${m.text()}`); });
  await p5.goto(`${base}/app?work=cloud#bench`, { waitUntil: 'load' });
  await p5.evaluate(() => {
    const c = {};
    for (const id of ['cloud-1', 'cloud-prov', 'cloud-2', 'cloud-3', 'cloud-4']) c[id] = { fp: 'test', at: 'preset' };
    localStorage.setItem('tryboard-app-checks:cloud', JSON.stringify(c));
    localStorage.removeItem('tryboard-app-asm:cloud');
  });
  await p5.goto(`${base}/app?work=cloud#assemble`, { waitUntil: 'load' });
  await p5.reload({ waitUntil: 'load' });
  await p5.waitForSelector('.asm-box [data-part]', { timeout: 30000 });
  const click = async (sel) => {
    for (let i = 0; i < 20; i++) {
      try {
        await p5.waitForSelector(sel, { timeout: 5000 });
        await p5.click(sel);
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`cannot click ${sel}`);
  };
  const build = async (pick) => {
    for (const k of ['case', 'board', 'aht', 'usb', 'lid']) {
      await click(`.asm-box [data-part="${k}"]`);
      if (k === 'aht') await click(`.asm-box [data-k="choose_aht"] [data-k="pick${pick}"]`);
    }
    await click('#toolbar [data-tool="asm-retest"]');
    await waitFor(p5, () => /Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 10000);
    await waitFor(p5, () => !!document.querySelector('#props .verdict-line') && !/Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 120000);
    return {
      v: await p5.$eval('#props .result-card', (e) => e.dataset.verdict).catch(() => ''),
      txt: await p5.$eval('#props', (e) => e.textContent),
      a: await p5.evaluate(() => globalThis.__tbApp.store.get().assembly),
    };
  };
  try {
    const bad = await build('B');
    report('cloud: AHT20 against the board -> JSON t reads 2.5 ℃ high, retest fails', bad.a?.effects?.sensorOffset === 2.5 && (bad.v === 'bad' || bad.v === 'shifted') && /JSON temperature \(room, not the board\)/.test(bad.txt) && /Sensor reads 26\.0 ℃/.test(bad.txt), `${bad.v} ${(bad.txt.match(/Retest result.{0,200}/) ?? [''])[0]}`);
    await shot(p5, 'cloud-bad');
    await click('#toolbar [data-tool="asm-reset"]');
    const good = await build('A');
    report('cloud: AHT20 by the vents -> retest passes, assembly clean', good.a?.effects?.sensorOffset === 0 && good.v === 'ok' && /Assembly 5\/5, no warnings/.test(good.txt), `${good.v} ${(good.txt.match(/Retest result.{0,80}/) ?? [''])[0]}`);
    await shot(p5, 'cloud-ok');
    await click('#next');
    const ready = await waitFor(p5, () => location.hash === '#product' && !!globalThis.__tbProduct?.state && !!document.querySelector('canvas'), null, 30000);
    const reported = await waitFor(p5, () => (globalThis.__tbCloud?.reports ?? []).length > 0 && globalThis.__tbCloud.sub, null, 30000);
    let sent = '', changed = false;
    for (let i = 0; i < 4 && !changed; i++) {
      const [x, y] = await p5.evaluate(() => globalThis.__tbProduct.handlePos());
      await p5.mouse.click(x, y);
      sent = await p5.evaluate(() => globalThis.__tbProduct.state().key);
      changed = await waitFor(p5, () => globalThis.__tbCloud.interval === 2, null, 6000);
    }
    await sleep(300);
    await shot(p5, 'cloud-3d');
    const t0 = await p5.evaluate(() => globalThis.__tbCloud.reports.at(-1)?.t);
    report('cloud: 3D tablet shows readings; clicking interval=2 sends the command and the firmware switches to 2 s', ready && reported && sent === 'interval=2' && changed && Math.abs(t0 - 23.5) < 0.6, `ready=${ready} reported=${reported} sent=${sent} changed=${changed} t=${t0}`);
  } catch (e) {
    report('cloud: flow finished', false, String(e).slice(0, 200));
  }
  await p5.close();
}

// G-17c AMOLED clock: steel weight glued over the antenna -> the phone never hears the clock, amoclock-4's time sync retest fails;
// weight in the foot passes; then a real mouse swipe on the 3D screen turns the page and a click on the 3D phone sets the time
{
  const p6 = await browser.newPage();
  await p6.setViewport({ width: 1280, height: 860 });
  p6.on('pageerror', (e) => errors.push(`amoclock: ${e}`));
  p6.on('console', (m) => { if (m.type() === 'error') errors.push(`amoclock: ${m.text()}`); });
  await p6.goto(`${base}/app?work=amoclock#bench`, { waitUntil: 'load' });
  await p6.evaluate(() => {
    const c = {};
    for (const id of ['amoclock-1', 'amoclock-2', 'amoclock-3', 'amoclock-4']) c[id] = { fp: 'test', at: 'preset' };
    localStorage.setItem('tryboard-app-checks:amoclock', JSON.stringify(c));
    localStorage.removeItem('tryboard-app-asm:amoclock');
  });
  await p6.goto(`${base}/app?work=amoclock#assemble`, { waitUntil: 'load' });
  await p6.reload({ waitUntil: 'load' });
  await p6.waitForSelector('.asm-box [data-part]', { timeout: 30000 });
  const click = async (sel) => {
    for (let i = 0; i < 20; i++) {
      try {
        await p6.waitForSelector(sel, { timeout: 5000 });
        await p6.click(sel);
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`cannot click ${sel}`);
  };
  const build = async (pick) => {
    for (const k of ['stand', 'weight', 'board', 'usb', 'bezel']) {
      await click(`.asm-box [data-part="${k}"]`);
      if (k === 'weight') await click(`.asm-box [data-k="choose_weight"] [data-k="pick${pick}"]`);
    }
    await click('#toolbar [data-tool="asm-retest"]');
    await waitFor(p6, () => /Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 10000);
    await waitFor(p6, () => !!document.querySelector('#props .verdict-line') && !/Retesting/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 120000);
    return {
      v: await p6.$eval('#props .result-card', (e) => e.dataset.verdict).catch(() => ''),
      txt: await p6.$eval('#props', (e) => e.textContent),
      a: await p6.evaluate(() => globalThis.__tbApp.store.get().assembly),
    };
  };
  try {
    const bad = await build('B');
    report('amoclock: steel weight over the antenna -> phone cannot find the clock, retest fails', bad.a?.effects?.antennaDb > 0 && (bad.v === 'bad' || bad.v === 'shifted'), `${bad.v} db=${bad.a?.effects?.antennaDb} ${(bad.txt.match(/Retest result.{0,200}/) ?? [''])[0]}`);
    await shot(p6, 'amoclock-bad');
    await click('#toolbar [data-tool="asm-reset"]');
    const good = await build('A');
    report('amoclock: weight in the foot -> retest passes, assembly clean', !good.a?.effects?.antennaDb && good.v === 'ok' && /Assembly 5\/5, no warnings/.test(good.txt), `${good.v} ${(good.txt.match(/Retest result.{0,80}/) ?? [''])[0]}`);
    await shot(p6, 'amoclock-ok');
    await click('#next');
    const ready = await waitFor(p6, () => location.hash === '#product' && !!globalThis.__tbProduct?.clock && !!document.querySelector('canvas'), null, 30000);
    const clock = () => p6.evaluate(() => globalThis.__tbProduct.clock());
    await waitFor(p6, () => !!globalThis.__tbProduct.clock().time, null, 20000);
    // A real mouse drag right to left across the 3D screen = swipe left -> next page
    let paged = false;
    for (let i = 0; i < 3 && !paged; i++) {
      const p0 = (await clock()).page;
      const pts = await p6.evaluate(() => [400, 330, 260, 190, 120].map((x) => globalThis.__tbProduct.screenPos(x, 240)));
      await p6.mouse.move(...pts[0]);
      await p6.mouse.down();
      for (const pt of pts.slice(1)) {
        await p6.mouse.move(...pt, { steps: 4 });
        await sleep(60);
      }
      await p6.mouse.up();
      paged = await waitFor(p6, (q) => globalThis.__tbProduct.clock().page !== q, p0, 4000);
    }
    const [px, py] = await p6.evaluate(() => globalThis.__tbProduct.phonePos());
    await p6.mouse.click(px, py);
    const synced = await waitFor(p6, () => !!globalThis.__tbProduct.clock().sync, null, 20000);
    await sleep(300);
    await shot(p6, 'amoclock-3d');
    const c = await clock();
    report('amoclock: swiping the 3D screen turns the page; clicking the 3D phone sets the time over BLE', ready && paged && synced, `ready=${ready} paged=${paged} page=${c.page} sync=${c.sync} phone=${c.phone}`);
  } catch (e) {
    report('amoclock: flow finished', false, String(e).slice(0, 200));
  }
  await p6.close();
}

await page.evaluate(() => localStorage.clear());
await browser.close();
server.close();
if (errors.length) console.log('[asm3d] page errors:\n  ' + errors.join('\n  '));
console.log(`[asm3d] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
