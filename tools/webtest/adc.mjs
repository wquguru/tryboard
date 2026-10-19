// ADC model parity (D-02): ideal / real toggle on the pot bench -> panel and serial react -> exported adc= lines
// replay byte-identical in the CLI. Usage: node tools/webtest/adc.mjs (after tools/build_web.sh); output in Reviews/web/adc-*
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
const FW = path.join(root, 'firmware/build/pot/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');
const LED = 5;

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
  console.log(`[adc] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
/** The firmware's own output in the web console (without the [TryBoard] notice spans) */
const fwConsole = (page) => page.$eval('#console', (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''));
/** One CLI run: raw stdout plus the fingerprint computed with check.py's rules */
function cliRun(args, tag) {
  const p = spawnSync(CLI, ['run', FW, ...args], { maxBuffer: 64 << 20 });
  const out = path.join(outDir, `adc-${tag}.stdout`);
  const err = path.join(outDir, `adc-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), fp, code: p.status };
}


// ---- 1. Web: ideal, then real, on the pot example (GPIO2, ADC1 ch 2)
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/app?work=blank&example=pot#bench', { waitUntil: 'load' });
report('bench pot runs live (serial ADC raw)', await waitFor(page, () => /ADC raw=/.test(document.getElementById('console').textContent), null, 30000));
await page.waitForSelector('[data-adc-mode="ideal"]', { timeout: 10000 }).catch(() => {});
report('ADC panel rendered (toggle, bars, pin grid)', !!(await page.$('[data-adc-mode="ideal"]')) && !!(await page.$('[data-adc-bars]')) && !!(await page.$('[data-adc-pins]')));
const setMv = (mv) => page.$eval('.env input[data-analog="2"]', (r, v) => { r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); }, mv);
const spreadText = () => page.$eval('[data-adc-spread]', (e) => e.textContent).catch(() => '');
await page.click('[data-adc-mode="ideal"]');
await setMv(1250);
const ideal = await waitFor(page, () => document.getElementById('console').textContent.includes('ADC raw=2048'), null, 15000);
report('ideal: 1250 mV -> serial ADC raw=2048 (exact linear code)', ideal);
const flat = await waitFor(page, () => {
  const s = document.querySelector('[data-adc-spread]')?.textContent ?? '';
  return Number(document.querySelector('[data-adc-bars]')?.getAttribute('data-adc-bars')) >= 8 && /\S/.test(s) && !/\d/.test(s);
}, null, 15000);
report('ideal: panel spread says every reading is the same', flat, await spreadText());
await page.screenshot({ path: path.join(outDir, 'adc-ideal.png') });
await page.click('[data-adc-mode="real"]');
const real = await waitFor(page, () => /ADC raw=18[2-6]\d/.test(document.getElementById('console').textContent.split('ADC raw=2048').pop()), null, 15000);
report('real: 1250 mV -> serial ADC raw near 1847 (typical-chip curve)', real);
const spread = await waitFor(page, () => {
  const m = (document.querySelector('[data-adc-spread]')?.textContent ?? '').match(/(\d+)\D+(\d+)/);
  return !!m && Number(m[2]) > Number(m[1]) && Number(m[2]) - Number(m[1]) < 20;
}, null, 15000);
report('real: panel shows a small spread (noise)', spread, await spreadText());
const tReal = await simNow(page);
await waitFor(page, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.3, tReal, 15000);
await page.click('#runPause');
await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
await page.screenshot({ path: path.join(outDir, 'adc-web.png') });
fs.writeFileSync(path.join(outDir, 'adc-web.stdout'), live);

// ---- 2. Export as --inputs text through the page's own export button
const text = await page.evaluate(async () => {
  let blobText = '';
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobText = b; return orig.call(URL, b); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  document.getElementById('moreBtn').click();
  for (let i = 0; i < 20 && !document.querySelector('[data-more="inputs"]'); i++) await new Promise((r) => setTimeout(r, 50));
  document.querySelector('[data-more="inputs"]').click();
  for (let i = 0; i < 50 && !blobText; i++) await new Promise((r) => setTimeout(r, 50));
  URL.createObjectURL = orig;
  HTMLAnchorElement.prototype.click = click;
  return blobText ? await blobText.text() : '';
});
const inputsFile = path.join(outDir, 'adc-inputs.txt');
fs.writeFileSync(inputsFile, text);
report('input log carries adc=ideal and adc=real', /:adc=ideal/.test(text) && /:adc=real/.test(text) && /:mv2=1250/.test(text));

// ---- 3. CLI replay to the same simulated time: serial byte-identical (noise is seeded, so it must match too)
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const a = cliRun(['--seconds', String((cycles + 0.5) / CPU_HZ), '--inputs', inputsFile], 'live');
let diffAt = -1;
if (a.stdout !== live) diffAt = Math.max(0, [...a.stdout].findIndex((c, i) => c !== live[i]));
report('CLI --inputs replay = live web serial (byte for byte)', a.stdout === live && a.code === 0 && a.stdout.includes('ADC raw=2048'),
  diffAt < 0 ? `${live.length} bytes` : `differs from byte ${diffAt} (CLI ${a.stdout.length} / web ${live.length}): ${JSON.stringify(a.stdout.slice(diffAt, diffAt + 40))} vs ${JSON.stringify(live.slice(diffAt, diffAt + 40))}`);

// ---- 4. Fingerprint: web verify worker vs CLI on the same log (serial + LED PWM)
const SECS = Math.max(3, Math.ceil(log.endMs / 1000));
const web = await page.evaluate((l, s, p) => globalThis.__tbReplay(l, s, p), log, SECS, LED);
const c = cliRun(['--seconds', String(SECS), '--gpio-log', '--ws2812-log', '--pwm-log', String(LED), '--inputs', inputsFile], 'fp');
report('web replay and CLI replay fingerprints match', web.fingerprint === c.fp && !web.error, `web ${web.fingerprint} / CLI ${c.fp}`);

await browser.close();
server.close();
if (errors.length) console.log('[adc] page errors:\n  ' + errors.join('\n  '));
console.log(`[adc] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
