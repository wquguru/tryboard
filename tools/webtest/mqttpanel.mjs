// MQTT publish panel (F-08g): PubSubClient example, publish from the Network tab's MQTT view, broker log, CLI --inputs replay parity, mobile.
// Usage: node tools/webtest/mqttpanel.mjs (after tools/build_web.sh); logs and screenshots in Reviews/web/mqttpanel-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const EX = 'arduino-lib-pubsubclient';
const FW = path.join(root, `firmware/build/${EX}/flash.bin`);
const CLI = path.join(root, 'core/target/release/tryboard');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
  console.log(`[mqttpanel] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const fwConsole = (page) => page.$eval('#console', (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''));
const hasText = (page, sel, t, ms = 30000) => waitFor(page, ([s, x]) => (document.querySelector(s)?.textContent ?? '').includes(x), [sel, t], ms);
async function clickTab(page, name) {
  const h = await page.evaluateHandle((n) => [...document.querySelectorAll('#dock [role=tab]')].find((b) => b.textContent.trim().startsWith(n)) ?? null, name);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
}
async function newPage(w, h, mobile) {
  const p = await browser.newPage();
  // Beginner mode is on by default (H-01); these checks target the full bench
  await p.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile });
  p.on('pageerror', (e) => errors.push(`${e}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return p;
}
async function tap(page, sel) {
  const el = await page.waitForSelector(sel, { timeout: 15000 }).catch(() => null);
  if (!el) return false;
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await el.click();
  return true;
}
/** Replace an input's value the way a user would (select all, type) */
async function typeInto(page, sel, text) {
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(sel, text);
}
function fingerprint(out, err) {
  return execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
}

// ---- 1. Desktop: connect, open the MQTT view, publish twice (QoS 0, then QoS 1 to a custom topic)
const page = await newPage(1440, 1000);
await page.goto(base + `/app?work=blank&example=${EX}#bench`, { waitUntil: 'load' });
report('firmware connects to the broker', await hasText(page, '#console', 'mqtt subscribed tryboard/#'));
report('echo of its own publish', await hasText(page, '#console', 'mqtt message tryboard/hello hello world'));
await clickTab(page, 'Network');
report('Network tab offers the MQTT view', await tap(page, '[data-net="mqtt"]'));
report('broker log shows CONNECT / SUBSCRIBE', (await hasText(page, '#mqttLog', 'CONNECT tryboard-c3', 10000)) && (await hasText(page, '#mqttLog', 'SUBSCRIBE tryboard-c3 tryboard/# QoS 0', 10000)));
const topic0 = await page.$eval('#mqttTopic', (e) => e.value);
report('topic defaults from the subscription tryboard/# -> tryboard/in', topic0 === 'tryboard/in', topic0);
await typeInto(page, '#mqttMsg', 'from panel');
await page.click('#mqttSend');
report('serial: mqtt message tryboard/in from panel', await hasText(page, '#console', 'mqtt message tryboard/in from panel', 15000));
report('broker log: PUBLISH cloud tryboard/in', await hasText(page, '#mqttLog', 'PUBLISH cloud tryboard/in QoS 0 "from panel"', 10000));
await typeInto(page, '#mqttTopic', 'tryboard/cmd,x');
report('comma in topic disables Send', await page.$eval('#mqttSend', (b) => b.disabled));
await typeInto(page, '#mqttTopic', 'tryboard/led');
await typeInto(page, '#mqttMsg', 'on, bright');
await page.click('[data-mode="pub1"]');
await page.click('#mqttSend');
report('QoS 1 with a comma in the payload arrives', await hasText(page, '#console', 'mqtt message tryboard/led on, bright', 15000));
await page.screenshot({ path: path.join(outDir, 'mqttpanel-desktop.png') });

// ---- 2. Export the input log -> CLI replay (serial byte for byte) + web verify worker vs CLI fingerprint
await page.click('#runPause');
await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
const text = await page.evaluate(async () => {
  let blob = null;
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  document.getElementById('moreBtn').click();
  for (let i = 0; i < 20 && !document.querySelector('[data-more="inputs"]'); i++) await new Promise((r) => setTimeout(r, 50));
  document.querySelector('[data-more="inputs"]').click();
  for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 50));
  URL.createObjectURL = orig;
  HTMLAnchorElement.prototype.click = click;
  return blob ? await blob.text() : '';
});
const inputsFile = path.join(outDir, 'mqttpanel-inputs.txt');
fs.writeFileSync(inputsFile, text);
fs.writeFileSync(path.join(outDir, 'mqttpanel-web.stdout'), live);
const acts = text.split('\n').filter((l) => /:mqtt=/.test(l)).map((l) => l.replace(/^[\d.]+:mqtt=/, ''));
report('input log records both publishes', acts.length === 2 && acts[0] === 'pub,tryboard/in,from panel' && acts[1] === 'pub1,tryboard/led,on, bright', acts.join(' | '));
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), '--inputs', inputsFile], { maxBuffer: 64 << 20 });
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'mqttpanel-cli.stdout'), p.stdout);
fs.writeFileSync(path.join(outDir, 'mqttpanel-cli.stderr'), p.stderr);
let at = -1;
if (cli !== live) at = Math.max(0, [...cli].findIndex((c, i) => c !== live[i]));
report('CLI --inputs replay = web serial (byte for byte)', cli === live && p.status === 0 && cli.includes('mqtt message tryboard/led on, bright'),
  cli === live ? `${live.length} bytes, ${cycles} cycles` : `differs from byte ${at} (CLI ${cli.length} / web ${live.length}): ${JSON.stringify(cli.slice(at, at + 50))} vs ${JSON.stringify(live.slice(at, at + 50))}`);
const SECS = Math.max(3, Math.ceil(log.endMs / 1000));
const web = await page.evaluate((l, s) => globalThis.__tbReplay(l, s), log, SECS);
const fo = path.join(outDir, 'mqttpanel-fp.stdout');
const fe = path.join(outDir, 'mqttpanel-fp.stderr');
const c = spawnSync(CLI, ['run', FW, '--seconds', String(SECS), '--gpio-log', '--ws2812-log', '--inputs', inputsFile], { maxBuffer: 64 << 20 });
fs.writeFileSync(fo, c.stdout);
fs.writeFileSync(fe, c.stderr);
const cfp = fingerprint(fo, fe);
report('web replay and CLI replay fingerprints match', web.fingerprint === cfp && !web.error && c.stdout.toString().includes('tryboard/led on, bright'), `web ${web.fingerprint} / CLI ${cfp}`);
await page.close();

// ---- 3. Mobile: the MQTT view in the drawer, publish, touch targets, no horizontal scroll
const pm = await newPage(390, 844, true);
await pm.goto(base + `/app?work=blank&example=${EX}#bench`, { waitUntil: 'load' });
await hasText(pm, '#console', 'mqtt subscribed tryboard/#');
await tap(pm, '#sheetPeek');
await waitFor(pm, () => document.querySelector('#dock')?.dataset.sheet === 'half', null, 5000);
report('mobile: drawer has the Network tab', await clickTab(pm, 'Network'));
report('mobile: MQTT view', await tap(pm, '[data-net="mqtt"]'));
await typeInto(pm, '#mqttMsg', 'from phone');
await tap(pm, '#mqttSend');
report('mobile: message arrives', await hasText(pm, '#console', 'mqtt message tryboard/in from phone', 15000));
const tapH = await pm.$$eval('#mqttPub button, #mqttPub input, [data-net]', (l) => Math.min(...l.map((e) => e.getBoundingClientRect().height)));
report('mobile: buttons / fields ≥ 44px', tapH >= 44, `${tapH}px`);
const [sw, iw] = await pm.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
report('mobile: no horizontal scroll', sw <= iw, `${sw} / ${iw}`);
await pm.screenshot({ path: path.join(outDir, 'mqttpanel-mobile.png') });
await pm.close();

await browser.close();
server.close();
if (errors.length) console.log('[mqttpanel] page errors:\n  ' + errors.join('\n  '));
console.log(`[mqttpanel] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
