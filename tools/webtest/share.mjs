// Share link (F-01a): press BOOT and change temperature -> make a ?s= link -> open it in a fresh browser context.
// The restored serial must equal the sharer's and the CLI --inputs replay byte for byte; fingerprints match. Logs in Reviews/web/share-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
// The page's own script parser (no imports, Node strips the types)
import { fromScript } from '../../web/src/inputlog.ts';
import { fileURLToPath } from 'node:url';
import { i2cArgs } from '../../web/src/i2cdevs.ts';

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
  console.log(`[share] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
  const out = path.join(outDir, `share-${tag}.stdout`);
  const err = path.join(outDir, `share-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), fp, code: p.status };
}

// ---- 1. Sharer: act on the web page, then pause
const page = await browser.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
page.on('pageerror', (e) => errors.push(`sharer: ${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`sharer: ${m.text()}`); });
await page.goto(base + '/app?work=blank&example=weather#bench', { waitUntil: 'load' });
report('bench weather runs live (serial T=23.50)', await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console').textContent), null, 30000));
await waitFor(page, () => parseFloat(document.getElementById('simtime').textContent) > 1.0, null, 30000);
const pos = await page.evaluate(() => globalThis.__tbButtonPos('BOOT'));
if (pos) {
  await page.mouse.move(pos[0], pos[1]);
  await page.mouse.down();
  const t0 = await simNow(page);
  await waitFor(page, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.1, t0, 10000);
  await page.mouse.up();
}
report('press BOOT -> serial UNIT F', !!pos && (await waitFor(page, () => document.getElementById('console').textContent.includes('UNIT F'), null, 15000)));
await page.waitForSelector('.env input', { timeout: 10000 }).catch(() => {});
await page.$eval('.env input', (r) => { r.value = '35'; r.dispatchEvent(new Event('input')); });
report('temperature 35 -> serial ALARM ON', await waitFor(page, () => document.getElementById('console').textContent.includes('ALARM ON'), null, 15000));
const tAlarm = await simNow(page);
await waitFor(page, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.6, tAlarm, 15000);
await page.click('#runPause');
await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
fs.writeFileSync(path.join(outDir, 'share-sharer.stdout'), live);

// ---- 2. Make the link (same code path as the ⋯ "Copy share link" item) and decode it in Node
const sh = await page.evaluate(() => globalThis.__tbShare());
fs.writeFileSync(path.join(outDir, 'share-url.txt'), sh.url + '\n');
const s = new URL(sh.url).searchParams.get('s');
const state = JSON.parse(zlib.inflateRawSync(Buffer.from(s, 'base64url')).toString('utf8'));
fs.writeFileSync(path.join(outDir, 'share-state.json'), JSON.stringify(state, null, 1));
report('link carries v1 state with firmware, run and BOOT / temperature actions', state.v === 1 && state.fw?.ex === 'weather' && /^[0-9a-f]{10}$/.test(state.fw.h) && state.run?.endMs === log.endMs && /:gpio0=0/.test(state.run.s) && /:env=35,/.test(state.run.s) && sh.url.length < 8000,
  `${sh.url.length} chars, endMs ${state.run?.endMs}`);

// ---- 3. Viewer: open the link in a fresh browser context (no shared storage)
const ctx2 = await browser.createBrowserContext();
const view = await ctx2.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await view.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
view.on('pageerror', (e) => errors.push(`viewer: ${e}`));
view.on('console', (m) => { if (m.type() === 'error') errors.push(`viewer: ${m.text()}`); });
await view.goto(sh.url, { waitUntil: 'load' });
const restoredOk = await waitFor(view, () => !!globalThis.__tbShareRestored, null, 60000);
const restored = restoredOk ? await view.evaluate(() => globalThis.__tbShareRestored) : { error: 'timeout' };
fs.writeFileSync(path.join(outDir, 'share-viewer.stdout'), restored.stdout ?? '');
const diff = (a, b) => { const i = [...a].findIndex((c, k) => c !== b[k]); return i < 0 ? Math.min(a.length, b.length) : i; };
report('viewer restores and fast-forwards to the same moment', restoredOk && !restored.error, restored.error ?? `${restored.simSeconds?.toFixed?.(3)} s`);
const vs = restored.stdout ?? '';
report('viewer serial = sharer serial (byte for byte)', vs === live, vs === live ? `${live.length} bytes` : `differs at ${diff(vs, live)}: ${JSON.stringify(vs.slice(diff(vs, live), diff(vs, live) + 40))} vs ${JSON.stringify(live.slice(diff(vs, live), diff(vs, live) + 40))}`);
const toast = await view.$eval('#toast', (e) => e.textContent).catch(() => '');
report('viewer sees the local-copy toast', /local copy/.test(toast), JSON.stringify(toast.slice(0, 80)));
const keys = await view.evaluate(() => Object.keys(localStorage));
fs.writeFileSync(path.join(outDir, 'share-viewer-keys.json'), JSON.stringify(keys, null, 1));
await view.screenshot({ path: path.join(outDir, 'share-viewer.png') });

// ---- 4. CLI replays the link's script to the same cycle: byte-identical serial
const inputsFile = path.join(outDir, 'share-inputs.txt');
fs.writeFileSync(inputsFile, state.run.s + '\n');
const cycles = Math.round(state.run.endMs * (CPU_HZ / 1000));
const i2c = i2cArgs(log.i2c);
const a = cliRun(['--seconds', String((cycles + 0.5) / CPU_HZ), ...i2c, '--inputs', inputsFile], 'cli');
report('CLI --inputs replay of the link = viewer serial (byte for byte)', a.code === 0 && a.stdout === vs && vs.includes('ALARM ON') && vs.includes('UNIT F'),
  a.stdout === vs ? `${vs.length} bytes, ${cycles} cycles` : `differs at ${diff(a.stdout, vs)} (CLI ${a.stdout.length} / web ${vs.length})`);

// ---- 5. Fingerprint: the viewer's verify worker runs the decoded log, the CLI runs the same file
const SECS = Math.max(3, Math.ceil(state.run.endMs / 1000));
const vlog = await view.evaluate(() => globalThis.__tbInputLog());
const web = await view.evaluate((l, s2, p) => globalThis.__tbReplay(l, s2, p), { ...vlog, events: fromScript(state.run.s), endMs: state.run.endMs }, SECS, BUZZER);
const c = cliRun(['--seconds', String(SECS), '--gpio-log', '--ws2812-log', '--pwm-log', String(BUZZER), ...i2c, '--inputs', inputsFile], 'fp');
report('viewer replay and CLI replay fingerprints match', web.fingerprint === c.fp && !web.error, `web ${web.fingerprint} / CLI ${c.fp}`);

// ---- 6. A damaged link opens the default bench with a toast, no crash
const bad = await ctx2.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await bad.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
bad.on('pageerror', (e) => errors.push(`bad link: ${e}`));
await bad.goto(base + '/app?s=AAAA_not-a-link#bench', { waitUntil: 'load' });
const badToast = await waitFor(bad, () => /damaged/.test(document.getElementById('toast')?.textContent ?? ''), null, 20000);
report('damaged link -> toast, default bench', badToast);
await ctx2.close();

// ---- 7. .tryboard file (F-01b): own bin (button) + BOOT presses -> file -> open by picker and by drop in fresh contexts
const OWN = path.join(root, 'firmware/build/button/flash.bin');
const ctx3 = await browser.createBrowserContext();
const own = await ctx3.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await own.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
own.on('pageerror', (e) => errors.push(`file sharer: ${e}`));
own.on('console', (m) => { if (m.type() === 'error') errors.push(`file sharer: ${m.text()}`); });
await own.goto(base + '/app?work=blank&example=weather#bench', { waitUntil: 'load' });
await waitFor(own, () => /T=23\.50 C/.test(document.getElementById('console').textContent), null, 30000);
await (await own.$('#fwPick')).uploadFile(OWN);
report('own bin (button) runs on the bench', await waitFor(own, () => document.getElementById('console').textContent.includes('BOOT'), null, 20000));
const press = async () => {
  const p = await own.evaluate(() => globalThis.__tbButtonPos('BOOT'));
  if (!p) return;
  await own.mouse.move(p[0], p[1]);
  await own.mouse.down();
  const t0 = await simNow(own);
  await waitFor(own, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.15, t0, 10000);
  await own.mouse.up();
  const t1 = await simNow(own);
  await waitFor(own, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.3, t1, 10000);
};
await press();
await press();
report('two BOOT presses -> TRYBOARD_OK button', await waitFor(own, () => document.getElementById('console').textContent.includes('TRYBOARD_OK button'), null, 15000));
await own.click('#runPause');
await waitFor(own, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const ownLog = await own.evaluate(() => globalThis.__tbInputLog());
const ownLive = await fwConsole(own);
const file = await own.evaluate(() => globalThis.__tbShareFile());
const bytes = Buffer.from(file.b64, 'base64');
const fileOut = path.join(outDir, 'share-own.tryboard');
fs.writeFileSync(fileOut, bytes);
const nl1 = bytes.indexOf(10), nl2 = bytes.indexOf(10, nl1 + 1);
const fst = JSON.parse(bytes.subarray(nl1 + 1, nl2).toString('utf8'));
const binBytes = bytes.subarray(nl2 + 1);
const ownBin = fs.readFileSync(OWN);
const crypto = await import('node:crypto');
report('.tryboard = header + state (run, no fw) + the exact bin', bytes.subarray(0, nl1).toString() === 'TRYBOARD 1' && file.own && file.run && !fst.fw && fst.bin?.name === 'flash.bin' && fst.bin.h === crypto.createHash('sha256').update(ownBin).digest('hex') && binBytes.equals(ownBin) && fst.run?.endMs === ownLog.endMs && /:gpio9=0/.test(fst.run.s),
  `${bytes.length} bytes, ${file.name}, endMs ${fst.run?.endMs}`);
await ctx3.close();

/** Open the file in a fresh context on the default bench; how = picker (#fwPick) or a page drop */
async function openFile(buf, how, tag) {
  const c = await browser.createBrowserContext();
  const p = await c.newPage();
  // Beginner mode is on by default (H-01); these checks target the full bench
  await p.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
  p.on('pageerror', (e) => errors.push(`${tag}: ${e}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
  await p.goto(base + '/app#bench', { waitUntil: 'load' });
  await waitFor(p, () => /T=23\.50 C/.test(document.getElementById('console').textContent), null, 30000);
  const f = path.join(outDir, `share-${tag}.tryboard`);
  fs.writeFileSync(f, buf);
  if (how === 'pick') await (await p.$('#fwPick')).uploadFile(f);
  else
    await p.evaluate((b64, name) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], name));
      const ev = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev('dragover'));
      document.body.dispatchEvent(ev('drop'));
    }, buf.toString('base64'), 'mine.tryboard');
  return { c, p };
}
const btnI2c = i2cArgs(ownLog.i2c);
const ownInputs = path.join(outDir, 'share-own-inputs.txt');
fs.writeFileSync(ownInputs, fst.run.s + '\n');
const ownCycles = Math.round(fst.run.endMs * (CPU_HZ / 1000));
const cliOwn = spawnSync(CLI, ['run', OWN, '--seconds', String((ownCycles + 0.5) / CPU_HZ), ...btnI2c, '--inputs', ownInputs], { maxBuffer: 64 << 20 }).stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'share-own-cli.stdout'), cliOwn);
for (const how of ['pick', 'drop']) {
  const { c, p } = await openFile(bytes, how, `file-${how}`);
  const ok = await waitFor(p, () => !!globalThis.__tbShareRestored, null, 60000);
  const r = ok ? await p.evaluate(() => globalThis.__tbShareRestored) : { error: 'timeout' };
  const rs = r.stdout ?? '';
  fs.writeFileSync(path.join(outDir, `share-file-${how}.stdout`), rs);
  report(`.tryboard via ${how}: restored own bin + actions = CLI --inputs replay (byte for byte)`, ok && !r.error && rs === cliOwn && rs.includes('TRYBOARD_OK button') && ownLive.endsWith(rs),
    r.error ?? (rs === cliOwn ? `${rs.length} bytes` : `differs at ${diff(rs, cliOwn)} (web ${rs.length} / CLI ${cliOwn.length})`));
  if (how === 'pick') await p.screenshot({ path: path.join(outDir, 'share-file.png') });
  await c.close();
}
// A flipped bin byte fails the sha256 check: toast, no reload, bench untouched
const bad2 = Buffer.from(bytes);
bad2[bad2.length - 100] ^= 0xff;
{
  const { c, p } = await openFile(bad2, 'pick', 'file-bad');
  const toastOk = await waitFor(p, () => /damaged/.test(document.getElementById('toast')?.textContent ?? ''), null, 15000);
  const url = p.url();
  report('tampered .tryboard -> damaged toast, page not reloaded', toastOk && !url.includes('?f='), url);
  await c.close();
}
// Built-in firmware with a run too long for any link: the section-2 run padded with 4000 random-time toggles of unused GPIO6
{
  const lines = state.run.s.split('\n');
  const t0 = 1.3, t1 = state.run.endMs / 1000 - 0.01;
  const times = Array.from({ length: 4000 }, () => t0 + Math.random() * (t1 - t0)).sort((x, y) => x - y);
  const pad = times.map((t, i) => `${t.toFixed(6)}:gpio6=${i % 2 ? 'z' : '0'}`);
  const long = { ...state, run: { endMs: state.run.endMs, s: [...lines, ...pad].join('\n') } };
  const enc = zlib.deflateRawSync(Buffer.from(JSON.stringify(long))).toString('base64url').length;
  const longFile = Buffer.concat([Buffer.from(`TRYBOARD 1\n${JSON.stringify(long)}\n`)]);
  const longInputs = path.join(outDir, 'share-long-inputs.txt');
  fs.writeFileSync(longInputs, long.run.s + '\n');
  const cl = cliRun(['--seconds', String((cycles + 0.5) / CPU_HZ), ...i2c, '--inputs', longInputs], 'long-cli');
  const { c, p } = await openFile(longFile, 'drop', 'file-long');
  const ok = await waitFor(p, () => !!globalThis.__tbShareRestored, null, 60000);
  const r = ok ? await p.evaluate(() => globalThis.__tbShareRestored) : { error: 'timeout' };
  const rs = r.stdout ?? '';
  report('.tryboard with a long run on built-in firmware (state far past a URL) restores = CLI replay', enc > 16000 && ok && !r.error && rs === cl.stdout && rs.includes('ALARM ON') && /\?f=[0-9a-f]{8}#bench$/.test(p.url()),
    r.error ?? `encoded state ${enc} chars, ${p.url().length}-char URL, ${rs === cl.stdout ? `${rs.length} bytes` : `differs at ${diff(rs, cl.stdout)}`}`);
  await c.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[share] page errors:\n  ' + errors.join('\n  '));
console.log(`[share] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
