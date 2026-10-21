// Environment scenario (F-11): a scripted temperature ramp and BOOT press on the web -> export -> CLI --inputs is byte-identical.
// Usage: node tools/webtest/scenario.mjs (after tools/build_web.sh); logs in Reviews/web/scenario-*
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
const FW = path.join(root, 'firmware/build/weather/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');
const BUZZER = 5;

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
  console.log(`[scenario] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
  const out = path.join(outDir, `scenario-${tag}.stdout`);
  const err = path.join(outDir, `scenario-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), fp, code: p.status };
}

// ---- 1. Install a scenario (temperature ramp crossing the 35 ℃ alarm, one BOOT press) and power up again
const SC = { len: 6000, tracks: [{ k: 'temp', kf: [[0, 24], [3000, 36]] }, { k: 'btn', pin: 0, presses: [[4000, 150]] }] };
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/app?work=blank&example=weather#bench', { waitUntil: 'load' });
report('bench weather runs live', await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console').textContent), null, 30000));
await page.evaluate((sc) => globalThis.__tbSetScenario(sc, true), SC);
const t24 = await waitFor(page, () => /T=24\.00 C/.test(document.getElementById('console').textContent), null, 30000);
report('scenario t=0 value applied at power-up (T=24.00)', t24);
const alarm = await waitFor(page, () => document.getElementById('console').textContent.includes('ALARM ON'), null, 30000);
report('ramp crosses 35 ℃ -> ALARM ON', alarm);
const unitF = await waitFor(page, () => document.getElementById('console').textContent.includes('UNIT F'), null, 30000);
report('scripted BOOT press -> UNIT F', unitF);
await waitFor(page, () => parseFloat(document.getElementById('simtime').textContent) > 6.6, null, 30000);
await page.click('#runPause');
await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
await page.screenshot({ path: path.join(outDir, 'scenario-web.png') });
fs.writeFileSync(path.join(outDir, 'scenario-inputs.json'), JSON.stringify(log, null, 1));
fs.writeFileSync(path.join(outDir, 'scenario-web.stdout'), live);
const envs = log.events.filter((e) => e.kind === 'env');
// Slice boundaries add one cycle (1/160000 ms), which the µs script format drops. 24 -> 36 ℃ in 3 s: 120 steps of 0.1 ℃, thinned to one line per 100 ms
const okLog = envs.length >= 28 && envs.length <= 32 && envs.every((e) => Math.abs(e.tMs - Math.round(e.tMs)) < 0.001) && envs.at(-1).temp === 36 && log.events.some((e) => e.kind === 'gpio' && e.pin === 0 && e.level === 0 && Math.round(e.tMs) === 4000) && log.events.some((e) => e.kind === 'gpio' && e.pin === 0 && e.level === -1 && Math.round(e.tMs) === 4150);
report('input log holds the compiled scenario at integer ms', okLog, `${envs.length} env lines, ${log.events.length} events, until ${(log.endMs / 1000).toFixed(3)} s`);

// ---- 2. Export through the page's ⋯ "Export input log"
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
const inputsFile = path.join(outDir, 'scenario-inputs.txt');
fs.writeFileSync(inputsFile, text);
report('export input log contains the scenario lines', /^4\.000000:gpio0=0$/m.test(text) && /^3\.000000:env=36,/m.test(text));

// ---- 3. CLI --inputs to the same simulated time: serial byte-identical
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const seconds = String((cycles + 0.5) / CPU_HZ);
const i2c = log.i2c.map((d) => `${d.kind}@0x${d.addr.toString(16)}`).join(',');
const a = cliRun(['--seconds', seconds, '--i2c', i2c, '--inputs', inputsFile], 'live');
// The console keeps the first power-up's lines above the restart; compare the scripted run (same first line as a cold boot)
const run = live.slice(Math.max(0, live.length - a.stdout.length));
const same = a.stdout === run && live.startsWith(a.stdout.split('\n')[0]);
let diffAt = [...a.stdout].findIndex((c, i) => c !== run[i]);
if (!same && diffAt < 0) diffAt = Math.min(a.stdout.length, live.length);
report('CLI --inputs replay = live web serial (byte for byte)', same && a.code === 0 && a.stdout.includes('ALARM ON') && a.stdout.includes('UNIT F'),
  same ? `${run.length} bytes, ${cycles} cycles` : `differs from byte ${diffAt} (CLI ${a.stdout.length} / web ${run.length}): ${JSON.stringify(a.stdout.slice(diffAt, diffAt + 40))} vs ${JSON.stringify(run.slice(diffAt, diffAt + 40))}`);

// ---- 4. Fingerprint: web verify worker vs CLI on the same log
const SECS = Math.max(7, Math.ceil(log.endMs / 1000));
const web = await page.evaluate((l, s, p) => globalThis.__tbReplay(l, s, p), log, SECS, BUZZER);
const c = cliRun(['--seconds', String(SECS), '--gpio-log', '--ws2812-log', '--pwm-log', String(BUZZER), '--i2c', i2c, '--inputs', inputsFile], 'fp');
report('web replay and CLI replay fingerprints match', web.fingerprint === c.fp && !web.error, `web ${web.fingerprint} / CLI ${c.fp}`);

await browser.close();
server.close();
if (errors.length) console.log('[scenario] page errors:\n  ' + errors.join('\n  '));
console.log(`[scenario] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
