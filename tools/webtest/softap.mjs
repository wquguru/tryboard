// SoftAP provisioning phone (C-02): walk the Network tab, export inputs, CLI --inputs replay byte-identical; no tab for blink; mobile steps.
// Usage: node tools/webtest/softap.mjs (after tools/build_web.sh); logs and screenshots in Reviews/web/softap-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const FW = path.join(root, 'firmware/build/c3-softap-prov/flash.bin');
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
  console.log(`[softap] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const hasText = (page, sel, t) => waitFor(page, ([s, x]) => (document.querySelector(s)?.textContent ?? '').includes(x), [sel, t], 20000);
/** The dock tab called name */
const tabSel = async (page, name) =>
  page.evaluateHandle((n) => [...document.querySelectorAll('#dock [role=tab]')].find((b) => b.textContent.trim().startsWith(n)) ?? null, name);
async function clickTab(page, name) {
  const h = await tabSel(page, name);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
}
async function newPage(w, h, mobile) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile });
  p.on('pageerror', (e) => errors.push(`${e}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return p;
}
/** Scroll the element into view, then tap (the mobile drawer needs scrolling first) */
async function tap(page, sel) {
  const el = await page.waitForSelector(sel, { timeout: 15000 }).catch(() => null);
  if (!el) return false;
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await el.click();
  return true;
}

// ---- 1. Desktop walk-through
const page = await newPage(1440, 1000);
await page.goto(base + '/app?work=blank&example=c3-softap-prov#bench', { waitUntil: 'load' });
report('firmware opens its hotspot (serial portal ready)', await hasText(page, '#console', '配网页 http://192.168.4.1/ 已就绪')); // lint: allow-cjk (firmware serial)
report('dock shows the Network tab', await waitFor(page, () => [...document.querySelectorAll('#dock [role=tab]')].some((b) => b.textContent.trim() === 'Network'), null, 10000));
await clickTab(page, 'Network');
report('pick up the phone', await tap(page, '#phoneOn'));
const seen = await waitFor(page, () => !!document.querySelector('[data-ssid="TryBoard-Setup"]'), null, 15000);
report('phone sees the board hotspot TryBoard-Setup', seen);
await tap(page, '[data-ssid="TryBoard-Setup"]');
report('joins and gets 192.168.4.2', await hasText(page, '#phoneIp', '192.168.4.2'));
report('Sign in to this network pops up', await hasText(page, '#phoneCaptive', 'Sign in to this network'));
await tap(page, '#phoneOpen');
report('sign-in page has the provisioning form', await waitFor(page, () => !!document.querySelector('#phoneForm input[name=ssid]'), null, 15000));
const pre = await page.$$eval('#phoneForm input', (l) => l.map((i) => i.value).join('/'));
report('form prefilled MyHome / 12345678', pre === 'MyHome/12345678', pre);
await page.screenshot({ path: path.join(outDir, 'softap-form.png') });
await tap(page, '#phoneSubmit');
report('serial: got SSID=MyHome', await hasText(page, '#console', '收到 SSID=MyHome（密码 8 位）')); // lint: allow-cjk (firmware serial)
report('serial: got IP 192.168.5.100', await hasText(page, '#console', '拿到 IP 192.168.5.100 网关 192.168.5.1')); // lint: allow-cjk (firmware serial)
const after = await waitFor(page, () => document.querySelectorAll('#phoneAfter [data-ok]').length === 3, null, 15000);
report('After the submit: three items ticked', after, await page.$eval('#phoneAfter', (e) => e.textContent.slice(0, 80)));
report('after its own restart the firmware connects from NVS', await hasText(page, '#console', 'NVS 里记着 Wi-Fi：MyHome，直接连接')); // lint: allow-cjk (firmware serial)
report('after the restart the Network tab is still there and selected', await page.evaluate(() => !!document.querySelector('#netPane')));
await page.screenshot({ path: path.join(outDir, 'softap-after.png') });

// ---- 2. Export the input log -> CLI replay
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
const inputsFile = path.join(outDir, 'softap-inputs.txt');
fs.writeFileSync(inputsFile, text);
fs.writeFileSync(path.join(outDir, 'softap-web.stdout'), live);
const acts = text.split('\n').filter((l) => /:phone=/.test(l)).map((l) => l.replace(/^[\d.]+:phone=/, ''));
report('input log records every phone step (on / join / open / post)', acts.length === 4 && acts[0] === 'on' && acts[1] === 'join,TryBoard-Setup' && acts[2] === 'open' && /^post,,ssid=MyHome&pass=12345678$/.test(acts[3]), acts.join(' | '));
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), '--inputs', inputsFile], { maxBuffer: 64 << 20 });
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'softap-cli.stdout'), p.stdout);
fs.writeFileSync(path.join(outDir, 'softap-cli.stderr'), p.stderr);
let at = -1;
if (cli !== live) at = Math.max(0, [...cli].findIndex((c, i) => c !== live[i]));
report('CLI --inputs replay = web serial (byte for byte)', cli === live && p.status === 0 && cli.includes('拿到 IP 192.168.5.100'), // lint: allow-cjk (firmware serial)
  cli === live ? `${live.length} bytes, ${cycles} cycles` : `differs from byte ${at} (CLI ${cli.length} / web ${live.length}): ${JSON.stringify(cli.slice(at, at + 50))} vs ${JSON.stringify(live.slice(at, at + 50))}`);
await page.close();

// ---- 3. Firmware without Wi-Fi has no Network tab
const pb = await newPage(1440, 1000);
await pb.goto(base + '/app?work=blank&example=blink#bench', { waitUntil: 'load' });
await waitFor(pb, () => parseFloat(document.getElementById('simtime')?.textContent) > 1.5, null, 20000);
report('blink: no Network tab', await pb.evaluate(() => ![...document.querySelectorAll('#dock [role=tab]')].some((b) => b.textContent.trim() === 'Network')));
await pb.close();

// ---- 4. Mobile layout
const pm = await newPage(390, 844, true);
await pm.goto(base + '/app?work=blank&example=c3-softap-prov#bench', { waitUntil: 'load' });
await waitFor(pm, () => (document.getElementById('console')?.textContent ?? '').includes('已就绪'), null, 30000); // lint: allow-cjk (firmware serial)
await tap(pm, '#sheetPeek');
await waitFor(pm, () => document.querySelector('#dock')?.dataset.sheet === 'half', null, 5000);
report('mobile: drawer has the Network tab', await clickTab(pm, 'Network'));
await tap(pm, '#phoneOn');
await waitFor(pm, () => !!document.querySelector('[data-ssid="TryBoard-Setup"]'), null, 15000);
const oneStep = await pm.evaluate(() => document.querySelectorAll('[id^=phoneStep]').length);
report('mobile: one step at a time', oneStep === 1, `${oneStep} phones`);
const tapH = await pm.$$eval('#netPane [data-phone-step], #netPane [data-ssid]', (l) => Math.min(...l.map((e) => e.getBoundingClientRect().height)));
report('mobile: step buttons / hotspot rows ≥ 44px', tapH >= 44, `${tapH}px`);
await tap(pm, '[data-ssid="TryBoard-Setup"]');
await hasText(pm, '#phoneCaptive', 'Sign in to this network');
await tap(pm, '#phoneOpen');
await waitFor(pm, () => !!document.querySelector('#phoneSubmit'), null, 15000);
report('mobile: moves to step 3 by itself', await pm.evaluate(() => !!document.querySelector('#phoneStep3') && !document.querySelector('#phoneStep2')));
await tap(pm, '#phoneSubmit');
report('mobile: IP after the submit', await waitFor(pm, () => document.querySelectorAll('#phoneAfter [data-ok]').length === 3, null, 20000));
const [sw, iw] = await pm.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
report('mobile: no horizontal scroll', sw <= iw, `${sw} / ${iw}`);
await pm.screenshot({ path: path.join(outDir, 'softap-mobile.png') });
await pm.close();

await browser.close();
server.close();
if (errors.length) console.log('[softap] page errors:\n  ' + errors.join('\n  '));
console.log(`[softap] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
