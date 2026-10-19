// Power / brownout (P1-02 / P1-04): s3-brownout on USB power browns out, external 5 V stops it, multimeter = solver, CLI replay identical.
// Usage: node tools/webtest/elec.mjs (after tools/build_web.sh); screenshots and logs in Reviews/web/elec-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toScript } from '../../web/src/inputlog.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const FW = path.join(root, 'firmware/build/s3-brownout/flash.bin');
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
  console.log(`[elec] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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

const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/app?work=weather#bench', { waitUntil: 'load' });
await waitFor(page, () => !!globalThis.__tbApp?.session?.sim, null, 30000);
// Swap firmware (same entry point as dropping a .bin on the bench)
await page.evaluate(async () => {
  const buf = await (await fetch('./fw/s3-brownout/flash.bin')).arrayBuffer();
  globalThis.__tbApp.session.loadFirmware(buf, 's3-brownout/flash.bin');
});
const conText = () => document.getElementById('console').textContent;
const brown = await waitFor(page, () => document.getElementById('console').textContent.includes('rst:0xf (BROWNOUT_RST)'), null, 40000);
const reason = await waitFor(page, () => document.getElementById('console').textContent.includes('reason=BROWNOUT'), null, 20000);
const e1 = await page.evaluate(() => globalThis.__tbApp.session.frame.elec);
report('USB only: servo sweep -> brownout reset, serial rst:0xf and reason=BROWNOUT', brown && reason && e1?.resets > 0, e1 ? `${e1.resets} resets, 3V3 min ${e1.min3v3.toFixed(3)} V, USB peak ${(e1.peakUsb * 1000).toFixed(0)} mA` : 'no elec readings');
const steps = await page.$$eval('.tl-step', (els) => els.map((e) => e.textContent));
report('timeline has a Brownout reset step', steps.some((t) => t.includes('Brownout reset')), steps.filter((t) => t.includes('Brownout')).join(' / '));
// Power panel: select USB 5 V under Power in the build tree, the reset count shows, then pick external 5 V 2 A
await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'power', id: 'usb' } }));
await sleep(400);
const ers = await page.$eval('[data-live="ers"]', (e) => e.textContent).catch(() => '');
report('power panel shows 3V3 min / peak current / reset count', /^\d+×$/.test(ers) && ers !== '0×', `brownout resets ${ers}`);
await page.screenshot({ path: path.join(outDir, 'elec-usb.png') });
const resetsBefore = (await page.evaluate(() => globalThis.__tbApp.session.frame.elec.resets));
await page.click('[data-power="ext"]');
const okExt = await waitFor(page, () => document.getElementById('console').textContent.includes('TRYBOARD_OK s3-brownout'), null, 40000);
await sleep(500);
const e2 = await page.evaluate(() => globalThis.__tbApp.session.frame.elec);
report('after switching to external 5 V no more resets, 12 sweeps (TRYBOARD_OK)', okExt && e2.power === 'ext' && e2.resets <= resetsBefore + 1, `${resetsBefore} resets before, ${e2.resets} in total (one sagging at the switch may still count); external peak ${(e2.peakServo * 1000).toFixed(0)} mA`);
// Measure 3V3 with the multimeter
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Multimeter')?.click());
await sleep(300);
await page.evaluate(() => [...document.querySelectorAll('[data-mpin="3V3"]')][0]?.click());
await sleep(600);
const mv = await page.$eval('[data-live="mv"]', (e) => e.textContent).catch(() => '');
const v33 = await page.evaluate(() => globalThis.__tbApp.session.frame.elec.v3v3);
report('multimeter 3V3 = solver 3V3 node voltage', mv === `${v33.toFixed(3)} V`, `meter ${mv} / solver ${v33.toFixed(6)} V`);
await page.screenshot({ path: path.join(outDir, 'elec-meter.png') });
// Pause -> this run's input log + full serial text
await page.evaluate(() => globalThis.__tbApp.session.sim.pause());
await sleep(400);
const snap = await page.evaluate(() => globalThis.__tbApp.session.snapshot());
const text = toScript({ ...snap.log, firmware: 's3-brownout' });
const inputsFile = path.join(outDir, 'elec-inputs.txt');
fs.writeFileSync(inputsFile, text);
fs.writeFileSync(path.join(outDir, 'elec-web.stdout'), snap.stdout);
report('input log has the power-up supply and the switch (--servo 4 --power usb, power=ext)', snap.log.servo === 4 && snap.log.power === 'usb' && /:power=ext$/m.test(text), `${(snap.log.endMs / 1000).toFixed(3)} s`);
const cycles = Math.round(snap.log.endMs * (CPU_HZ / 1000));
const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), '--servo', '4', '--power', 'usb', '--elec-report', '--inputs', inputsFile], { maxBuffer: 64 << 20 });
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'elec-cli.stdout'), cli);
fs.writeFileSync(path.join(outDir, 'elec-cli.stderr'), p.stderr);
let diffAt = -1;
if (cli !== snap.stdout) diffAt = Math.max(0, [...cli].findIndex((c, i) => c !== snap.stdout[i]));
const cliResets = Number((p.stderr.toString().match(/elec (\d+) brownout resets/) || [])[1]);
report('CLI replays the same log: serial byte-identical, same reset count', cli === snap.stdout && cliResets === e2.resets,
  cli === snap.stdout ? `${cli.length} bytes, resets web ${e2.resets} / CLI ${cliResets}` : `differs from byte ${diffAt}: ${JSON.stringify(cli.slice(diffAt, diffAt + 50))} vs ${JSON.stringify(snap.stdout.slice(diffAt, diffAt + 50))}`);

// ---- Wiring faults through the network solver (P2-14): inject each, panel / wrong-wire card show the solved current = CLI netlist
const p2 = await browser.newPage();
p2.on('pageerror', (e) => errors.push(`${e}`));
p2.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await p2.goto(base + '/app?work=weather&debug=1#bench', { waitUntil: 'load' });
await waitFor(p2, () => !!globalThis.__tbApp?.injectWiring && !!globalThis.__tbApp?.session?.sim, null, 30000);
const net = (cir) => {
  const r = spawnSync(CLI, ['elec-net', path.join(root, 'tools/elec', cir)]);
  return Object.fromEntries([...r.stdout.toString().matchAll(/^v\((\w+)\)@\S+ = (\S+)$/gm)].map((m) => [m[1], Number(m[2])]));
};
// CLI-side branch current: from node voltages and the netlist resistors (same circuit as the .cir comments)
const s3 = await p2.evaluate(() => globalThis.__tbApp.session.chip === 'esp32s3');
const FAULTS = [
  ['drive', 'W1', '11-gpio-fight.cir', (v) => (v.pin - v.vd) / 1],
  ['nores', 'W3', '12-led-nores.cir', (v) => (v.an - 1.8) / 10],
  ['short3v3', 'W7', s3 ? '16-short-3v3-s3.cir' : '13-short-3v3.cir', (v) => v.v33 / 0.05],
  ['short5v', 'W7', s3 ? '17-short-5v-s3.cir' : '14-short-5v.cir', (v) => v.v5 / 0.05],
  ['clamp', 'W2', '15-clamp-5v.cir', (v) => (v.v5 - v.pin) / 50],
];
for (const [k, rule, cir, cur] of FAULTS) {
  await p2.evaluate(() => globalThis.__tbApp.injectWiring('clear'));
  await p2.evaluate((k) => globalThis.__tbApp.injectWiring(k), k);
  const got = await waitFor(p2, (r) => globalThis.__tbApp.faults().some((f) => f.rule === r && f.mA !== null), rule, 10000);
  const f = await p2.evaluate((r) => globalThis.__tbApp.faults().find((x) => x.rule === r), rule);
  const cliMA = cur(net(cir)) * 1000;
  // The page shows 0.1 mA: within 0.05 mA counts as the same solution
  const same = got && f && Math.abs(f.mA - cliMA) <= 0.05 + 1e-9;
  await p2.evaluate((id) => globalThis.__tbApp.store.set({ selection: { kind: 'wire', id } }), f?.wires[0]);
  await sleep(300);
  const panel = await p2.$$eval('[data-est]', (els) => els.map((e) => e.textContent)).catch(() => []);
  const badge = await p2.$$eval('[data-est] [data-conf="估算"]', (els) => els.length).catch(() => 0); // lint: allow-cjk (ConfLevel id)
  await p2.evaluate((id) => globalThis.__tbApp.showWrongWire(id), f?.wires[0]);
  await sleep(300);
  const card = await p2.$eval('#wrongWire [data-ww="estimate"]', (e) => e.textContent).catch(() => '');
  await p2.screenshot({ path: path.join(outDir, `elec-fault-${k}.png`) });
  await p2.evaluate(() => document.querySelector('#wrongWire [data-ww="keep"]')?.click());
  report(`miswire ${k} -> ${rule}: web solve = CLI ${cir}`, same && panel.some((t) => t.includes(`${f.mA} mA`)) && badge > 0 && card.includes(`${f.mA} mA`) && !!f.est,
    f ? `web ${f.mA} mA / CLI ${cliMA.toFixed(3)} mA; ${f.est}` : 'issue not raised');
}
await p2.evaluate(() => globalThis.__tbApp.injectWiring('clear'));
report('wiring restored -> no issues', (await p2.evaluate(() => globalThis.__tbApp.faults().length)) === 0);

await browser.close();
server.close();
if (errors.length) console.log('[elec] page errors:\n  ' + errors.join('\n  '));
console.log(`[elec] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
