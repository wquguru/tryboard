// Input-log replay (P0-19): press BOOT and drag the temperature on the web -> export inputs -> CLI --inputs replay is byte-identical.
// Usage: node tools/webtest/replay.mjs (after tools/build_web.sh); logs and screenshots in Reviews/web/replay-*
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
  console.log(`[replay] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
  const out = path.join(outDir, `replay-${tag}.stdout`);
  const err = path.join(outDir, `replay-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), fp, code: p.status };
}

// ---- 1. Act on the web page
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/app?work=blank&example=weather#bench', { waitUntil: 'load' });
const booted = await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console').textContent), null, 30000);
report('bench weather runs live (serial T=23.50)', booted);
await waitFor(page, () => parseFloat(document.getElementById('simtime').textContent) > 1.0, null, 30000);
// Mouse press on the 3D BOOT button: hold ~150 ms wall time (firmware debounces 30 ms simulated)
const pos = await page.evaluate(() => globalThis.__tbButtonPos('BOOT'));
if (pos) {
  await page.mouse.move(pos[0], pos[1]);
  await page.mouse.down();
  const t0 = await simNow(page);
  await waitFor(page, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.1, t0, 10000);
  await page.mouse.up();
}
const unitF = await waitFor(page, () => document.getElementById('console').textContent.includes('UNIT F'), null, 15000);
report('mouse press on the 3D BOOT -> serial UNIT F', !!pos && unitF, pos ? `@${pos.map(Math.round).join(',')}` : 'BOOT not found');
// Temperature slider to 35 ℃ (value + input event, like agent-browser fill); the example card renders after the example list loads
await page.waitForSelector('.env input', { timeout: 10000 }).catch(() => {});
await page.$eval('.env input', (r) => { r.value = '35'; r.dispatchEvent(new Event('input')); });
const alarm = await waitFor(page, () => document.getElementById('console').textContent.includes('ALARM ON'), null, 15000);
report('temperature to 35 ℃ -> serial ALARM ON', alarm);
const tAlarm = await simNow(page);
await waitFor(page, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.6, tAlarm, 15000);
// Read after pausing: the log's endMs is the simulated time the page stopped at
await page.click('#runPause');
await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
await page.screenshot({ path: path.join(outDir, 'replay-web.png') });
fs.writeFileSync(path.join(outDir, 'replay-inputs.json'), JSON.stringify(log, null, 1));
fs.writeFileSync(path.join(outDir, 'replay-web.stdout'), live);
const kinds = log.events.map((e) => e.kind + (e.kind === 'gpio' ? `${e.pin}=${e.level}` : e.kind === 'env' ? `=${e.temp}` : '')).join(' ');
const okLog = log.events.some((e) => e.kind === 'gpio' && e.pin === 0 && e.level === 0) && log.events.some((e) => e.kind === 'gpio' && e.pin === 0 && e.level === -1) && log.events.some((e) => e.kind === 'env' && e.temp === 35);
report('input log records BOOT down / up and temperature 35', okLog, `${kinds}; until ${(log.endMs / 1000).toFixed(3)} s`);

// ---- 2. Export as --inputs text through the page's own export button
const text = await page.evaluate(async () => {
  let blobText = '';
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobText = b; return orig.call(URL, b); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  // "Export input log" in the top bar ⋯ menu
  document.getElementById('moreBtn').click();
  for (let i = 0; i < 20 && !document.querySelector('[data-more="inputs"]'); i++) await new Promise((r) => setTimeout(r, 50));
  document.querySelector('[data-more="inputs"]').click();
  for (let i = 0; i < 50 && !blobText; i++) await new Promise((r) => setTimeout(r, 50));
  URL.createObjectURL = orig;
  HTMLAnchorElement.prototype.click = click;
  return blobText ? await blobText.text() : '';
});
const inputsFile = path.join(outDir, 'replay-inputs.txt');
fs.writeFileSync(inputsFile, text);
report('export input log button gives --inputs text', /^# TryBoard input log/.test(text) && /:env=35,/.test(text) && /:gpio0=0/.test(text), `${text.split('\n').filter((l) => l && !l.startsWith('#')).length} lines`);

// ---- 3. CLI replays to the same simulated time: serial byte-identical to the live web run
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const seconds = String((cycles + 0.5) / CPU_HZ);
const i2c = log.i2c.map((d) => `${d.kind}@0x${d.addr.toString(16)}`).join(',');
const a = cliRun(['--seconds', seconds, '--i2c', i2c, '--inputs', inputsFile], 'live');
let same = a.stdout === live;
let diffAt = -1;
if (!same) {
  diffAt = [...a.stdout].findIndex((c, i) => c !== live[i]);
  if (diffAt < 0) diffAt = Math.min(a.stdout.length, live.length);
}
report('CLI --inputs replay = live web serial (byte for byte)', same && a.code === 0 && a.stdout.includes('ALARM ON') && a.stdout.includes('UNIT F'),
  same ? `${live.length} bytes, ${cycles} cycles` : `differs from byte ${diffAt} (CLI ${a.stdout.length} / web ${live.length}): ${JSON.stringify(a.stdout.slice(diffAt, diffAt + 40))} vs ${JSON.stringify(live.slice(diffAt, diffAt + 40))}`);

// ---- 4. Fingerprint: the web verify worker and the CLI each run the same log for 3 s (GPIO / WS2812 / buzzer PWM observations)
const SECS = Math.max(3, Math.ceil(log.endMs / 1000));
const web = await page.evaluate((l, s, p) => globalThis.__tbReplay(l, s, p), log, SECS, BUZZER);
const c = cliRun(['--seconds', String(SECS), '--gpio-log', '--ws2812-log', '--pwm-log', String(BUZZER), '--i2c', i2c, '--inputs', inputsFile], 'fp');
fs.writeFileSync(path.join(outDir, 'replay-web-verify.json'), JSON.stringify(web, null, 1));
report('web replay and CLI replay fingerprints match (serial + observations)', web.fingerprint === c.fp && !web.error, `web ${web.fingerprint} / CLI ${c.fp}`);
const buzz = /PWM GPIO5: \d+ changes, duty [\d.]+\.\.0\.5\d*, freq 2700/.test(web.report);
report('replay: buzzer GPIO5 gives 2700 Hz 50% PWM', buzz, (web.report.match(/PWM GPIO5: .*/) || [''])[0]);

await browser.close();
server.close();
if (errors.length) console.log('[replay] page errors:\n  ' + errors.join('\n  '));
console.log(`[replay] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
