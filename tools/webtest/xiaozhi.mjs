// Voice assistant (F-09b-2 / F-09c): one hold-to-talk turn -> CLI --inputs byte-identical; fake mic + 3D BOOT -> WAV replays via --mic.
// Usage: node tools/webtest/xiaozhi.mjs (after tools/build_web.sh); logs in Reviews/web/xiaozhi-*; also checks 390×844 no h-scroll
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
const FW = path.join(root, 'firmware/build/s3-xiaozhi-lite/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');
const READY = '就绪：按住 BOOT 说话';
const DONE = 'TRYBOARD_OK s3-xiaozhi-lite turn 1';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.wav': 'audio/wav' };
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
  // Speaker needs Web Audio without a gesture; the fake capture device plays the sample clip as "my microphone" (F-09c),
  // and on macOS the sandboxed audio service cannot open that file (silence), hence the AudioService feature flags
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,1000', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=AudioServiceSandbox,AudioServiceOutOfProcess',
    `--use-file-for-fake-audio-capture=${path.join(root, 'tools/audio/xz_mic.wav')}`],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[xiaozhi] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const fwConsole = (page) => page.$eval('#console', (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''));
/** Page-side check (serialized by page.evaluate, so the text comes in as the argument) */
const has = (s) => document.getElementById('console').textContent.includes(s);
function cliRun(args, tag) {
  const p = spawnSync(CLI, ['run', FW, ...args], { maxBuffer: 64 << 20, cwd: root });
  const out = path.join(outDir, `xiaozhi-${tag}.stdout`);
  const err = path.join(outDir, `xiaozhi-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), stderr: p.stderr.toString('utf8'), fp, code: p.status };
}

// ---- 1. Example opens with the voice server on and the Voice tab shown
const page = await browser.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/app?work=blank&example=s3-xiaozhi-lite#bench', { waitUntil: 'load' });
report('firmware connects to the virtual server and is ready', await waitFor(page, has, READY, 90000));
report('Voice tab with server status', await waitFor(page, () => !!document.getElementById('xzTalk') && /1/.test(document.getElementById('xzStatus')?.textContent ?? ''), null, 10000));
await page.click('#sound');
const unmuted = await waitFor(page, () => globalThis.__tbAudio && !globalThis.__tbAudio.muted, null, 5000);
report('sound on', unmuted);

// ---- 2. Hold to talk for >= 1 s of simulated time, release, wait for the answer
const t0 = await simNow(page);
const box = await (await page.$('#xzTalk')).boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await waitFor(page, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 1.2, t0, 30000);
await page.mouse.up();
let peak = 0;
const tEnd = Date.now() + 60000;
while (Date.now() < tEnd) {
  const r = await page.evaluate(() => globalThis.__tbAudio?.pcm?.rms ?? 0);
  peak = Math.max(peak, r);
  if (await page.evaluate(has, DONE).catch(() => false)) break;
  await sleep(50);
}
const live0 = await fwConsole(page);
report('turn completes: heard Hello, spoke the answer, subtitle on the OLED', live0.includes(DONE) && live0.includes('识别结果：Hello') && live0.includes('字幕已显示'));
const bub = await page.$$eval('#xzChat [data-who]', (els) => els.map((e) => `${e.dataset.who}:${e.textContent}`));
report('chat bubbles (stt + tts)', bub.some((b) => b === 'user:Hello') && bub.some((b) => b.startsWith('bot:Hi, I am')), bub.join(' | '));
report('speaker analyser is non-silent during the answer', peak > 0.01, `peak RMS ${peak.toFixed(3)} (mode ${await page.evaluate(() => globalThis.__tbAudio?.pcm?.mode)})`);

// ---- 3. Pause, export the input log through ⋯
await sleep(500);
await page.click('#runPause');
await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
await page.screenshot({ path: path.join(outDir, 'xiaozhi-web.png') });
fs.writeFileSync(path.join(outDir, 'xiaozhi-inputs.json'), JSON.stringify(log, null, 1));
fs.writeFileSync(path.join(outDir, 'xiaozhi-web.stdout'), live);
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
const inputsFile = path.join(outDir, 'xiaozhi-inputs.txt');
fs.writeFileSync(inputsFile, text);
report('exported log has xz= and the BOOT hold', /:xz=on$/m.test(text) && /:xz=voice,demo$/m.test(text) && /:gpio0=0$/m.test(text) && /:gpio0=z$/m.test(text));
const hw = ['--i2s', (log.i2s ?? []).join(','), '--mic', `tools/audio/${log.mic}`, ...i2cArgs(log.i2c)];
report('log carries I2S pins and the mic clip', hw[1].split(',').sort().join(',') === 'inmp441@5:4:6,max98357a@15:16:7' && log.mic === 'xz_mic.wav', hw.join(' '));

// ---- 4. CLI --inputs to the same simulated time: serial byte-identical
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const seconds = String((cycles + 0.5) / CPU_HZ);
const a = cliRun(['--seconds', seconds, ...hw, '--inputs', inputsFile], 'live');
// The page console keeps the last ~200 KB (the firmware's Wi-Fi logs are chatty): when trimmed, compare from its first full line
const trimmed = live.length < a.stdout.length;
const web0 = trimmed ? live.slice(live.indexOf('\n') + 1) : live;
const run = a.stdout.slice(Math.max(0, a.stdout.length - web0.length));
const same = run === web0 && (trimmed || live.startsWith(a.stdout.split('\n')[0]));
let diffAt = [...run].findIndex((c, i) => c !== web0[i]);
if (!same && diffAt < 0) diffAt = Math.min(run.length, web0.length);
report('CLI --inputs replay = live web serial (byte for byte)', same && a.code === 0 && a.stdout.includes(DONE),
  same ? `${run.length} bytes${trimmed ? ' (page tail)' : ''}, ${cycles} cycles` : `differs from byte ${diffAt} (CLI ${run.length} / web ${web0.length}): ${JSON.stringify(run.slice(diffAt, diffAt + 40))} vs ${JSON.stringify(web0.slice(diffAt, diffAt + 40))}`);
const xzCli = a.stderr.split('\n').filter((l) => l.includes('[xz] ')).map((l) => l.replace(/^.*\[xz\] /, ''));
const xzWeb = await page.evaluate(() => [...document.querySelectorAll('#xzLog > div > span:last-child')].map((e) => e.textContent));
report('[xz] server log on the page = CLI [xz] lines', xzWeb.length > 5 && xzWeb.join('\n') === xzCli.slice(0, xzWeb.length).join('\n'), `${xzWeb.length} web / ${xzCli.length} CLI`);

// ---- 5. Fingerprint: web verify worker vs CLI on the same log
const SECS = Math.max(8, Math.ceil(log.endMs / 1000));
const web = await page.evaluate((l, s) => globalThis.__tbReplay(l, s), log, SECS);
const c = cliRun(['--seconds', String(SECS), '--gpio-log', '--ws2812-log', ...hw, '--inputs', inputsFile], 'fp');
report('web replay and CLI replay fingerprints match', web.fingerprint === c.fp && !web.error && c.stdout.includes(DONE), `web ${web.fingerprint} / CLI ${c.fp}`);
await page.close();

// ---- 7. My microphone (F-09c): fake capture device, hold the 3D BOOT, export the recording + inputs, CLI --mic replays it
/** Click `sel` with downloads intercepted; resolves to the blob's bytes (base64) or '' */
const grab = (p, sel) => p.evaluate(async (s) => {
  let blob = null;
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  if (s === 'inputs') {
    document.getElementById('moreBtn').click();
    for (let i = 0; i < 20 && !document.querySelector('[data-more="inputs"]'); i++) await new Promise((r) => setTimeout(r, 50));
    document.querySelector('[data-more="inputs"]').click();
  } else document.querySelector(s).click();
  for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 50));
  URL.createObjectURL = orig;
  HTMLAnchorElement.prototype.click = click;
  if (!blob) return '';
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}, sel);
const L = await browser.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await L.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
L.on('pageerror', (e) => errors.push(`${e}`));
L.on('console', (x) => { if (x.type() === 'error') errors.push(x.text()); });
await L.goto(base + '/app?work=blank&example=s3-xiaozhi-lite#bench', { waitUntil: 'load' });
await waitFor(L, has, READY, 90000);
await waitFor(L, () => !!document.getElementById('xzMicLive'), null, 10000);
await L.click('#xzMicLive');
const liveOn = await waitFor(L, () => document.getElementById('xzMicLive')?.getAttribute('aria-pressed') === 'true' && !!document.getElementById('xzMicExport'), null, 10000);
const micMsg = await L.$eval('#xzMicMsg', (e) => e.textContent).catch(() => '');
report('"My microphone" switches to the live source (fake capture device)', liveOn && !micMsg, micMsg);
const lv = await waitFor(L, () => Number(document.getElementById('xzMicLevel')?.getAttribute('aria-valuenow')) > 0, null, 10000);
report('input level meter moves', lv);
const bpos = await L.evaluate(() => globalThis.__tbButtonPos('BOOT'));
const t1 = await simNow(L);
await L.mouse.move(bpos[0], bpos[1]);
await L.mouse.down();
await waitFor(L, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 1.2, t1, 30000);
await L.mouse.up();
const turn = await waitFor(L, has, DONE, 60000);
report('hold the 3D BOOT with the live mic: turn completes', turn, bpos ? `BOOT @${bpos.map(Math.round).join(',')}` : 'BOOT not found');
await sleep(500);
await L.click('#runPause');
await waitFor(L, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const llog = await L.evaluate(() => globalThis.__tbInputLog());
const lweb = await fwConsole(L);
await L.screenshot({ path: path.join(outDir, 'xiaozhi-livemic.png') });
const wav = Buffer.from(await grab(L, '#xzMicExport'), 'base64');
const wavFile = path.join(outDir, 'xiaozhi-livemic.wav');
fs.writeFileSync(wavFile, wav);
const wavOk = wav.length > 44 && wav.toString('latin1', 0, 4) === 'RIFF' && wav.toString('latin1', 8, 12) === 'WAVE' && wav.readUInt16LE(34) === 16;
let nz = 0;
for (let i = 44; i + 1 < wav.length; i += 2) if (wav.readInt16LE(i)) nz++;
report('export recording (WAV): 16-bit RIFF with live samples', wavOk && nz > 1000, `${wav.length} bytes, rate ${wavOk ? wav.readUInt32LE(24) : '?'}, ${nz} non-zero samples`);
const ltext = Buffer.from(await grab(L, 'inputs'), 'base64').toString('utf8');
const linFile = path.join(outDir, 'xiaozhi-livemic-inputs.txt');
fs.writeFileSync(linFile, ltext);
report('3D BOOT logs the same levels as the pane button (gpio0=0 then gpio0=z)', /:gpio0=0$/m.test(ltext) && /:gpio0=z$/m.test(ltext) && !/:gpio0=1$/m.test(ltext));
const lcyc = Math.round(llog.endMs * (CPU_HZ / 1000));
const lhw = ['--i2s', (llog.i2s ?? []).join(','), '--mic', wavFile, ...i2cArgs(llog.i2c)];
const lr = cliRun(['--seconds', String((lcyc + 0.5) / CPU_HZ), ...lhw, '--inputs', linFile], 'livemic');
const ltrim = lweb.length < lr.stdout.length;
const lweb0 = ltrim ? lweb.slice(lweb.indexOf('\n') + 1) : lweb;
const lrun = lr.stdout.slice(Math.max(0, lr.stdout.length - lweb0.length));
const lsame = lrun === lweb0 && (ltrim || lweb.startsWith(lr.stdout.split('\n')[0]));
const ldiff = [...lrun].findIndex((ch, i) => ch !== lweb0[i]);
report('CLI --mic <exported WAV> --inputs <log> = live-mic web serial (byte for byte)', lsame && lr.code === 0 && lr.stdout.includes(DONE),
  lsame ? `${lrun.length} bytes` : `differs from byte ${ldiff}: ${JSON.stringify(lrun.slice(ldiff, ldiff + 60))} vs ${JSON.stringify(lweb0.slice(ldiff, ldiff + 60))}`);
// The log still names the sample clip (share links carry no audio): replaying with it must not reproduce the live talk
const ls = cliRun(['--seconds', String((lcyc + 0.5) / CPU_HZ), ...lhw.slice(0, 2), '--mic', `tools/audio/${llog.mic}`, ...lhw.slice(4), '--inputs', linFile], 'livemic-sample');
report('the log alone (sample clip) does not reproduce the live talk, the WAV is needed', llog.mic === 'xz_mic.wav' && ls.stdout !== lr.stdout);
await L.close();

// ---- 6. Phone 390×844: no horizontal scroll, talk button at least 44 px tall
const m = await browser.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await m.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
m.on('pageerror', (e) => errors.push(`${e}`));
m.on('console', (x) => { if (x.type() === 'error') errors.push(x.text()); });
await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await m.goto(base + '/app?work=blank&example=s3-xiaozhi-lite#bench', { waitUntil: 'load' });
// Phone: the dock is a peek bar; opening it shows the Voice tab the server switched to
await waitFor(m, () => !!document.getElementById('sheetPeek') && document.getElementById('console')?.textContent.includes('wifi'), null, 60000);
await m.click('#sheetPeek');
const tabOk = await waitFor(m, () => !!document.getElementById('xzTalk'), null, 10000);
report('390×844: drawer opens on the Voice tab', tabOk);
await sleep(800);
const geo = await m.evaluate(() => {
  const b = document.getElementById('xzTalk')?.getBoundingClientRect();
  const mb = document.getElementById('xzMicLive')?.getBoundingClientRect();
  return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: b?.height ?? 0, vis: (b?.width ?? 0) > 0, mic: mb?.height ?? 0 };
});
await m.screenshot({ path: path.join(outDir, 'xiaozhi-390.png') });
report('390×844: no horizontal scroll, talk and mic source buttons >= 44 px', geo.sw <= geo.cw && geo.vis && geo.h >= 44 && geo.mic >= 44, JSON.stringify(geo));

await browser.close();
server.close();
if (errors.length) console.log('[xiaozhi] page errors:\n  ' + errors.join('\n  '));
console.log(`[xiaozhi] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
