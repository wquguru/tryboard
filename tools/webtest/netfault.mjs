// Network faults (D-01): web reboot + presets on c3-wifi-resilient -> export inputs -> CLI replay must match byte for byte.
// Usage: node tools/webtest/netfault.mjs (after tools/build_web.sh); logs and screenshots in Reviews/web/netfault-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const FW = path.join(root, 'firmware/build/c3-wifi-resilient/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');
const OK = 'TRYBOARD_OK c3-wifi-resilient';

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
  console.log(`[netfault] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const simNow = (page) => page.$eval('#simtime', (e) => parseFloat(e.textContent) || 0);
const waitSim = (page, dt, ms = 60000) => simNow(page).then((t) => waitFor(page, (x) => parseFloat(document.getElementById('simtime').textContent) > x, t + dt, ms));
const fwConsole = (page) => page.$eval('#console', (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''));
const hasText = (page, sel, t, ms = 20000) => waitFor(page, ([s, x]) => (document.querySelector(s)?.textContent ?? '').includes(x), [sel, t], ms);
async function clickTab(page, name) {
  const h = await page.evaluateHandle((n) => [...document.querySelectorAll('#dock [role=tab]')].find((b) => b.textContent.trim().startsWith(n)) ?? null, name);
  const el = h.asElement();
  if (!el) return false;
  await el.evaluate((e) => e.scrollIntoView({ block: 'nearest', inline: 'center' }));
  await el.click();
  return true;
}
function newPageErrors(p) {
  p.on('pageerror', (e) => errors.push(`${e}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
}
function cliRun(args, tag) {
  const p = spawnSync(CLI, ['run', FW, ...args], { maxBuffer: 64 << 20 });
  const out = path.join(outDir, `netfault-${tag}.stdout`);
  const err = path.join(outDir, `netfault-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), stderr: p.stderr.toString('utf8'), fp, code: p.status };
}

// ---- 1. Desktop: router reboot from the Network tab
const page = await browser.newPage();
newPageErrors(page);
await page.goto(base + '/app?work=blank&example=c3-wifi-resilient#bench', { waitUntil: 'load' });
report('resilient firmware gets an IP', await hasText(page, '#console', '拿到 IP', 40000)); // lint: allow-cjk (firmware serial)
await waitFor(page, () => [...document.querySelectorAll('#dock [role=tab]')].some((b) => b.textContent.trim().startsWith('Network')), null, 20000);
report('Network tab opens', await clickTab(page, 'Network'));
report('Network conditions panel with 4 presets and 3 faults', await waitFor(page, () => document.querySelectorAll('#netCond [role=radio]').length === 4 && document.querySelectorAll('#netCond [data-fault]').length === 3, null, 10000));
await waitSim(page, 2);
await page.click('[data-fault="reboot"]');
const reason = await hasText(page, '#console', '断开 reason=', 60000); // lint: allow-cjk (firmware serial)
report('router reboot -> firmware reports a disconnect reason', reason, ((await fwConsole(page)).match(/断开 reason=\d+/) || [''])[0]); // lint: allow-cjk (firmware serial)
report('firmware reconnects and requests succeed again', await hasText(page, '#console', OK, 90000));
report('summary chip says reconnected', await hasText(page, '#netSummary', 'reconnected after', 10000), await page.$eval('#netSummary', (e) => e.textContent).catch(() => ''));
const rows = await page.$$eval('#netRows tr[data-kind=cond]', (l) => l.map((r) => r.textContent));
report('timeline lists the fault and the reconnect', rows.some((r) => r.includes('Router reboot')) && rows.some((r) => r.includes('Reconnected')), `${rows.length} rows`);
await page.screenshot({ path: path.join(outDir, 'netfault-web.png') });
// Presets: weak shows the top-bar chip, back to stable hides it (both go into the log)
await page.click('[data-preset="weak"]');
report('weak preset -> top-bar chip', await hasText(page, '#netChip', 'Weak signal', 5000));
await waitSim(page, 3);
await page.click('[data-preset="normal"]');
report('back to stable -> chip hidden', await waitFor(page, () => !document.getElementById('netChip'), null, 5000));
await waitSim(page, 1);
await page.click('#runPause');
await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
fs.writeFileSync(path.join(outDir, 'netfault-inputs.json'), JSON.stringify(log, null, 1));
fs.writeFileSync(path.join(outDir, 'netfault-web.stdout'), live);
const kinds = log.events.map((e) => e.kind + (e.kind === 'net' ? '=' + e.preset : e.kind === 'netfault' ? '=' + e.fault : '')).join(' ');
report('input log records netfault=reboot, net=weak, net=normal', /netfault=reboot.*net=weak.*net=normal/.test(kinds), kinds);

// ---- 2. Export through the page's own button
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
const inputsFile = path.join(outDir, 'netfault-inputs.txt');
fs.writeFileSync(inputsFile, text);
report('exported script has netfault= / net= lines', /:netfault=reboot/.test(text) && /:net=weak/.test(text) && /:net=normal/.test(text));

// ---- 3. CLI replays to the same simulated time: serial byte-identical
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const a = cliRun(['--seconds', String((cycles + 0.5) / CPU_HZ), '--inputs', inputsFile], 'live');
const same = a.stdout === live;
let diffAt = -1;
if (!same) {
  diffAt = [...a.stdout].findIndex((c, i) => c !== live[i]);
  if (diffAt < 0) diffAt = Math.min(a.stdout.length, live.length);
}
report('CLI --inputs replay = live web serial (byte for byte)', same && a.code === 0 && a.stdout.includes(OK),
  same ? `${live.length} bytes, ${cycles} cycles` : `differs from byte ${diffAt} (CLI ${a.stdout.length} / web ${live.length}): ${JSON.stringify(a.stdout.slice(diffAt, diffAt + 40))} vs ${JSON.stringify(live.slice(diffAt, diffAt + 40))}`);
report('CLI prints the network summary line', /\[tryboard\] network: .*faults 1, disconnects 1, reconnected after/.test(a.stderr), (a.stderr.match(/\[tryboard\] network: .*/) || [''])[0]);

// ---- 4. Fingerprint: web verify worker vs CLI on the same log
const SECS = Math.ceil(log.endMs / 1000);
const web = await page.evaluate((l, s) => globalThis.__tbReplay(l, s), log, SECS);
const c = cliRun(['--seconds', String(SECS), '--gpio-log', '--ws2812-log', '--inputs', inputsFile], 'fp');
report('web replay and CLI replay fingerprints match', web.fingerprint === c.fp && !web.error && web.stdout.includes(OK), `web ${web.fingerprint} / CLI ${c.fp}`);
await page.close();

// ---- 5. Phone layout (390×844): 2×2 presets of 48px, fault list ≥ 44px, no horizontal scroll
const pm = await browser.newPage();
newPageErrors(pm);
await pm.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await pm.goto(base + '/app?work=blank&example=c3-wifi-resilient#bench', { waitUntil: 'load' });
await hasText(pm, '#console', '拿到 IP', 40000); // lint: allow-cjk (firmware serial)
await waitFor(pm, () => [...document.querySelectorAll('#dock [role=tab]')].some((b) => b.textContent.trim().startsWith('Network')), null, 20000);
const peek = await pm.$('#sheetPeek:not([hidden])');
if (peek) await peek.click();
await clickTab(pm, 'Network');
await pm.waitForSelector('#netCond [role=radio]', { timeout: 10000 }).catch(() => null);
const ph = await pm.$$eval('#netCond [role=radio]', (l) => l.map((b) => Math.round(b.getBoundingClientRect().height)));
report('phone: 4 preset buttons are 48px tall', ph.length === 4 && ph.every((h) => h >= 48), ph.join(','));
await pm.click('#faultToggle');
const fh = await pm.$$eval('#netCond [data-fault]', (l) => l.map((b) => Math.round(b.getBoundingClientRect().height)));
report('phone: fault buttons ≥ 44px', fh.length === 3 && fh.every((h) => h >= 44), fh.join(','));
await pm.click('[data-preset="flaky"]');
report('phone: top-bar chip shows the preset', await hasText(pm, '#netChip', 'Flaky', 5000));
const [sw, iw] = await pm.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
report('phone: no horizontal scroll', sw <= iw, `${sw} / ${iw}`);
await pm.screenshot({ path: path.join(outDir, 'netfault-phone.png') });
await pm.close();

await browser.close();
server.close();
if (errors.length) console.log('[netfault] page errors:\n  ' + errors.join('\n  '));
console.log(`[netfault] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
