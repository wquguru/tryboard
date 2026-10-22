// Bench interaction (P0-03/04/11/12/13): clean default wiring, GPIO4 props + scope, BME280 card, power, timeline seek = CLI replay, ruler, W1–W5.
// Usage: node tools/webtest/interact.mjs (after tools/build_web.sh and cargo build --release -p tryboard-cli); screenshots in Reviews/web/interact-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { i2cArgs } from '../../web/src/i2cdevs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const FW = path.join(root, 'firmware/build/weather/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');

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
  console.log(`[interact] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
const simNow = (page) => page.evaluate(() => globalThis.__tbApp.store.get().simSeconds);
const waitSim = async (page, dt) => {
  const t = await simNow(page);
  return waitFor(page, (x) => globalThis.__tbApp.store.get().simSeconds > x, t + dt, 30000);
};
async function open(url) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(base + url, { waitUntil: 'load' });
  await waitFor(page, () => globalThis.__tbApp?.hist && globalThis.__tbApp.store.get().simSeconds > 0.5, null, 30000);
  return page;
}
const props = (page) => page.$eval('#props', (e) => e.textContent);
/** Real mouse click on a 3D target: try the projected centre, then circle around it if a wire covers it */
async function clickTarget(page, t) {
  const c = await screenOf(page, t);
  if (!c) return null;
  for (const [dx, dy] of [[0, 0], [0, 12], [12, 0], [-12, 0], [0, -12], [16, 16], [-16, 16], [16, -16], [-16, -16], [0, 24], [24, 0], [-24, 0]]) {
    await page.mouse.click(c.x + dx, c.y + dy);
    await sleep(120);
    const s = await page.evaluate(() => globalThis.__tbApp.store.get().selection);
    if (s && s.kind === t.kind && s.id === t.id) return { x: c.x + dx, y: c.y + dy };
  }
  return null;
}
/** Page coordinates of a 3D target (project is relative to the stage container) */
const screenOf = (page, t) => page.evaluate((t) => {
  const p = globalThis.__tbApp.session.pick.project(t);
  const r = document.getElementById('stage').getBoundingClientRect();
  return p && { x: r.left + p.x, y: r.top + p.y };
}, t);

// ---- 1. Default wiring has no issues (three works)
for (const work of ['weather', 'spin', 'lens']) {
  const page = await open(`/app?work=${work}&debug=1#bench`);
  const f = await page.evaluate(() => globalThis.__tbApp.faults());
  const tree = await page.$eval('details.tg[data-g="wire"] summary', (e) => e.textContent);
  report(`${work} default wiring has no issues`, f.length === 0 && /✓/.test(tree), `Wires ${tree.replace('Wires', '').trim()}${f.length ? ' ' + JSON.stringify(f) : ''}`);
  await page.close();
}

const page = await open('/app?work=weather&debug=1#bench');

// ---- 2. Click the GPIO4 pin
await page.evaluate(() => globalThis.__tbApp.session.bench._debug.controls && 0);
let pin = await clickTarget(page, { kind: 'pin', id: 'GPIO4' });
let sel = await page.evaluate(() => globalThis.__tbApp.store.get().selection);
if (!sel || sel.id !== 'GPIO4') {
  // If the click misses, pick it from the build tree (same selection)
  await page.$eval('details.tg[data-g="pin"]', (d) => (d.open = true));
  await page.click('.tn[data-kind="pin"][data-id="GPIO4"]');
}
sel = await page.evaluate(() => globalThis.__tbApp.store.get().selection);
await waitSim(page, 0.4);
let txt = await props(page);
const scopeInk = await page.$eval('canvas.scope', (c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 80) n++;
  return n;
});
report('click GPIO4 -> props: 50 Hz + pulse width + scope', sel?.id === 'GPIO4' && /50(\.0)? Hz/.test(txt) && /Pulse width\d\.\d{3} ms/.test(txt) && scopeInk > 50, `${pin ? 'mouse on 3D' : 'build tree'}; ${(txt.match(/PWM frequency.*?Pulse width[\d. ms]+/) ?? [''])[0]}; scope blue pixels ${scopeInk}`);
await page.screenshot({ path: path.join(outDir, 'interact-pin.png') });

// ---- 3. BME280 quick card
const bme = await clickTarget(page, { kind: 'part', id: 'bme280' });
const card = await waitFor(page, () => !document.querySelector('.qcard').hidden && /BME280/.test(document.querySelector('.qcard').textContent), null, 3000);
report('click BME280 -> quick card', card, bme ? `@${Math.round(bme.x)},${Math.round(bme.y)}` : 'BME280 not visible');
await page.$eval('.qcard input[data-env="temp"]', (r) => { r.value = '30'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
const t30 = await waitFor(page, () => globalThis.__tbApp.store.get().reading?.t === 30, null, 10000);
report('card temperature to 30 ℃ -> reading 30.00', t30);
await page.click('.qcard [data-act="heat"]');
const t38 = await waitFor(page, () => globalThis.__tbApp.store.get().reading?.t === 38 && globalThis.__tbApp.session.heat === 'bme280', null, 10000);
report('heat source -> reading 38.00, heat glow', t38);
await page.click('.qcard [data-act="chip"]');
const mm = await page.$eval('.qcard [data-live="chipmm"]', (e) => e.textContent);
report('distance to chip -> mm', /\d+\.\d mm/.test(mm), mm.slice(0, 60));
await page.screenshot({ path: path.join(outDir, 'interact-card.png') });
await page.click('.qcard [data-act="heat"]');
await waitFor(page, () => globalThis.__tbApp.store.get().reading?.t === 30, null, 10000);

// Power: click the servo supply wire -> card switches to external 5 V
const pw = await clickTarget(page, { kind: 'wire', id: 'wire:5V~servo:VCC' });
let pcard = await waitFor(page, () => !!document.querySelector('.qcard [data-power="ext"]'), null, 3000);
if (!pcard) {
  await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'power', id: 'usb' } }));
}
await page.click(pcard ? '.qcard [data-power="ext"]' : '#props [data-power="ext"]');
const ext = await waitFor(page, () => globalThis.__tbApp.session.power?.ext5v === true && /External 5 V 2 A/.test(document.getElementById('tree').textContent), null, 3000);
const bom = await page.evaluate(() => { const h = globalThis.__tbApp.store.get().bom; return JSON.stringify(h.ops.slice(1)); });
report('power to external 5 V -> build tree + list', ext, `${pcard ? 'supply wire card' : 'props panel'}; list ${bom}`);

// ---- 4. Run, change the environment, rewind
await page.evaluate(() => globalThis.__tbApp.session.reboot());
await waitFor(page, () => globalThis.__tbApp.hist.runs().length >= 2, null, 10000);
const r1 = await page.evaluate(() => globalThis.__tbApp.hist.runs().length);
await waitSim(page, 1.5);
await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'env', id: 'room' } }));
await page.$eval('#props input[data-env="humidity"]', (r) => { r.value = '60'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
await waitSim(page, 0.8);
await page.click('#runRestart');
await waitFor(page, (n) => globalThis.__tbApp.hist.runs().length > n, r1, 10000);
await waitSim(page, 2.2);
// No edits during run #(r1+1): its timeline step is the whole run, so seeking back must match its final fingerprint
await page.click('#runRestart');
await waitFor(page, (n) => globalThis.__tbApp.hist.runs().length > n + 1, r1, 10000);
await waitSim(page, 0.8);
await page.$eval('#props input[data-env="temp"]', (r) => { r.value = '12'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
await waitSim(page, 0.6);
const runs = await page.evaluate(() => globalThis.__tbApp.hist.runs().map((r) => ({ n: r.n, fp: r.fingerprint, end: r.snap?.log.endMs ?? null })));
const nRun2 = r1 + 1;
const rec2 = runs.find((r) => r.n === nRun2);
// Run history: select run #2, click run #(1) to compare
await page.evaluate((n) => globalThis.__tbApp.store.set({ selection: { kind: 'run', id: String(n) } }), nRun2);
await page.click(`.runrow[data-run="${nRun2 - 1}"]`);
const diff = await page.$$eval('.drow.ch .k', (e) => e.map((x) => x.textContent.replace('≠ ', '')));
report('run history: two runs compared with differences', diff.includes('Run ID') && diff.length >= 2, diff.join(', '));
await page.screenshot({ path: path.join(outDir, 'interact-runs.png') });
// Timeline back to run #2 (v2: the timeline lives in the dock's Runs tab, switch there first)
await page.click('[data-dock="runs"]');
const steps = await page.$$eval('.tl-step', (b) => b.map((x) => x.textContent));
const idx = steps.findIndex((t) => t.includes(`Run #${nRun2}`));
const btns = await page.$$('.tl-step');
await btns[idx].click();
await waitFor(page, () => globalThis.__tbApp.store.get().hist.seeked && !globalThis.__tbApp.store.get().hist.busy, null, 60000);
const seek = await page.evaluate(() => globalThis.__tbApp.hist.lastSeek());
report(`timeline back to run #${nRun2} -> ✓ same fingerprint`, !!rec2?.fp && seek?.fingerprint === rec2.fp && seek.same === true, `then ${rec2?.fp} · seek ${seek?.fingerprint} · ${(seek?.untilMs / 1000).toFixed(3)} s`);
await page.screenshot({ path: path.join(outDir, 'interact-seek.png') });

// CLI replays run #2's input log to the same time: check.py fingerprint matches (web seek = CLI replay)
if (fs.existsSync(CLI) && fs.existsSync(FW)) {
  const log = await page.evaluate((n) => globalThis.__tbApp.hist.runs().find((r) => r.n === n).snap.log, nRun2);
  const script = log.events.filter((e) => e.kind !== 'power').map((e) => {
    const t = (Math.floor(e.tMs * 1000) / 1e6).toFixed(6);
    const a = e.kind === 'env' ? `env=${e.temp},${e.humidity},${e.pressure}` : e.kind === 'gpio' ? `gpio${e.pin}=${e.level < 0 ? 'z' : e.level}` : null;
    return a && `${t}:${a}`;
  }).filter(Boolean).join('\n');
  const inputs = path.join(outDir, 'interact-run2.inputs');
  fs.writeFileSync(inputs, script + '\n');
  const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
  const i2c = i2cArgs(log.i2c);
  const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), ...i2c, '--inputs', inputs, '--gpio-log', '--ws2812-log'], { maxBuffer: 64 << 20 });
  const out = path.join(outDir, 'interact-run2.stdout'), err = path.join(outDir, 'interact-run2.stderr');
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  report(`CLI --inputs replay of run #${nRun2} -> same fingerprint`, fp === rec2?.fp, `CLI ${fp}`);
} else report('CLI replay (CLI or firmware missing)', false, CLI);

// Changing the environment at the seek point = new branch: run #3 is dropped
await page.evaluate(() => globalThis.__tbApp.hist.resume());
await waitSim(page, 0.3);
await page.click('#runRestart');
await waitFor(page, (n) => globalThis.__tbApp.hist.runs().length === n, nRun2 + 1, 10000);
const after = await page.evaluate(() => globalThis.__tbApp.hist.runs().map((r) => r.n).join(','));
report('run after a seek: later runs dropped, numbering continues from the seek point', after === Array.from({ length: nRun2 + 1 }, (_, i) => i + 1).join(','), `runs ${after}`);

// Ruler: toolbar ruler -> click BME280 and the board
await page.click('.tb-btn[data-tool="ruler"]');
// Clicks in ruler mode don't change the selection: reuse the BME280 point, then the OLED centre
const pb = await screenOf(page, { kind: 'part', id: 'oled' });
if (bme && pb) {
  await page.mouse.click(bme.x, bme.y);
  await sleep(150);
  await page.mouse.click(pb.x, pb.y);
}
await sleep(200);
const rtxt = await props(page);
report('ruler: click two parts -> mm', /Distance\d+\.\d mm/.test(rtxt), (rtxt.match(/Distance[\d.]+ mm/) ?? ['not measured'])[0]);
await page.click('.tb-btn[data-tool="select"]');

// ---- 5. Inject wiring faults (W1–W5): each turns red + issue count in the build tree
const kinds = [['drive', 'W1'], ['5v', 'W2'], ['nores', 'W3'], ['nognd', 'W4'], ['addr', 'W5']];
for (const [k, rule] of kinds) {
  await page.evaluate(() => globalThis.__tbApp.injectWiring('clear'));
  const wires = await page.evaluate((k) => globalThis.__tbApp.injectWiring(k), k);
  await sleep(150);
  const f = await page.evaluate(() => globalThis.__tbApp.faults());
  const tree = await page.$eval('details.tg[data-g="wire"] summary', (e) => e.textContent);
  report(`miswire ${k} -> ${rule} turns red`, f.some((x) => x.rule === rule) && wires.length > 0 && /issues: \d+/.test(tree), `${f.map((x) => x.rule + ':' + x.wires.length).join(' ')} · ${tree.replace('Wires', '').trim()}`);
  if (k === '5v') {
    await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'wire', id: 'wire:GPIO8~bme280:SDA' } }));
    await page.screenshot({ path: path.join(outDir, 'interact-fault.png') });
  }
}
await page.evaluate(() => globalThis.__tbApp.injectWiring('clear'));
const clean = await page.evaluate(() => globalThis.__tbApp.faults().length);
report('wiring restored -> no issues', clean === 0);

report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[interact] ${fails ? 'FAIL' : 'PASS'} (${fails} failed)`);
process.exit(fails ? 1 : 0);
