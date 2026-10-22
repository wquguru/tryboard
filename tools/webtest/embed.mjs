// Embed page (F-03): another-origin host frames /embed?s=; nothing loads before the click, then serial = CLI --inputs = /app,
// the iframe's real localStorage stays empty and "Open in TryBoard" opens /app with the same s. Logs in Reviews/web/embed-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The page's own share format and script parser (Node strips the types)
import { encodeState, fwHash } from '../../web/src/app/sharestate.ts';
import { fromScript, toScriptBody } from '../../web/src/inputlog.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const CLI = path.join(root, 'core/target/release/tryboard');
const FW = path.join(dist, 'fw/weather/flash.bin');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
// Site server (localhost) and host-page server (127.0.0.1): different origins, like a blog framing the site
const site = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!f.startsWith(dist) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => site.listen(0, 'localhost', r));
const base = `http://localhost:${site.address().port}`;
let hostHtml = '';
const host = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(hostHtml);
});
await new Promise((r) => host.listen(0, '127.0.0.1', r));
const hostUrl = `http://127.0.0.1:${host.address().port}/post.html`;

// ---- Shared state: weather firmware, press BOOT (units -> F) then heat to 35 °C (ALARM ON), stop at 3 s
const buf = fs.readFileSync(FW);
const h = await fwHash(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const script = toScriptBody(fromScript('1.2:gpio0=0\n1.4:gpio0=1\n2:env=35,45,101325'));
const state = { v: 1, w: 'blank:weather', fw: { ex: 'weather', h }, run: { endMs: 3000, s: script } };
const s = await encodeState(state);
const embedUrl = `${base}/embed?s=${s}`;
fs.writeFileSync(path.join(outDir, 'embed-url.txt'), embedUrl + '\n');
hostHtml = fs.readFileSync(path.join(root, 'tools/webtest/fixtures/embed-host.html'), 'utf8').replace('__SRC__', embedUrl);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1000,900'],
  defaultViewport: { width: 1000, height: 900, deviceScaleFactor: 1 },
});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[embed] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(target, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await target.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
const diff = (a, b) => { const i = [...a].findIndex((c, k) => c !== b[k]); return i < 0 ? Math.min(a.length, b.length) : i; };

// ---- 1. Host page loads the poster: no wasm, firmware or three.js yet
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
const reqs = [];
page.on('request', (r) => reqs.push(r.url()));
page.on('pageerror', (e) => errors.push(`host: ${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`host: ${m.text()}`); });
await page.goto(hostUrl, { waitUntil: 'load' });
let frame = null;
for (let i = 0; i < 100 && !frame; i++) {
  frame = page.frames().find((f) => f.url().startsWith(base + '/embed'));
  if (!frame) await sleep(100);
}
report('host page frames /embed from another origin', !!frame && new URL(hostUrl).origin !== base, frame ? '' : page.frames().map((f) => f.url().slice(0, 60)).join(' | '));
if (!frame) process.exit(1);
report('poster shows the work title and a play button', await waitFor(frame, () => document.body.dataset.state === 'poster' && !!document.getElementById('embedPlay') && /weather/i.test(document.querySelector('.tb-embed-title')?.textContent ?? ''), null, 15000));
await sleep(1500);
const heavy = (u) => /\.wasm|flash\.bin|three\.module|\/rom\//.test(u);
const early = reqs.filter(heavy);
report('no wasm / firmware / three.js before the click', early.length === 0, early.length ? early.join(', ') : `${reqs.length} requests`);
const keys0 = await frame.evaluate(() => Object.keys(localStorage).length);
await page.screenshot({ path: path.join(outDir, 'embed-poster.png') });

// ---- 2. Click: wasm loads, the shared actions replay to 3 s, the firmware keeps running
await frame.click('#embedPlay');
const restoredOk = await waitFor(frame, () => !!globalThis.__tbShareRestored, null, 60000);
const restored = restoredOk ? await frame.evaluate(() => globalThis.__tbShareRestored) : { error: 'timeout' };
report('click -> wasm fetched', reqs.some((u) => /\.wasm/.test(u)));
report('shared actions replayed', restoredOk && !restored.error, restored.error ?? `${restored.simSeconds?.toFixed?.(3)} s`);
const es = restored.stdout ?? '';
const er = restored.report ?? '';
fs.writeFileSync(path.join(outDir, 'embed-restored.stdout'), es);
report('serial shows UNIT F and ALARM ON', es.includes('UNIT F') && es.includes('ALARM ON'));
report('serial panel prints live output', await waitFor(frame, () => /T=\d/.test(document.getElementById('console').textContent), null, 20000));
await sleep(1000);
await page.screenshot({ path: path.join(outDir, 'embed-running.png') });

// ---- 3. CLI --inputs replay of the same script to the same cycle: byte-identical serial
const log = await frame.evaluate(() => globalThis.__tbEmbed.session.sim.inputLog());
const inputsFile = path.join(outDir, 'embed-inputs.txt');
fs.writeFileSync(inputsFile, script + '\n');
const cycles = Math.round(state.run.endMs * (CPU_HZ / 1000));
const i2c = log.i2c.map((d) => `${d.kind}@0x${d.addr.toString(16)}`).join(',');
const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), '--i2c', i2c, '--inputs', inputsFile], { maxBuffer: 64 << 20 });
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'embed-cli.stdout'), cli);
report('CLI --inputs replay = embed serial (byte for byte)', p.status === 0 && cli === es, cli === es ? `${es.length} bytes` : `differs at ${diff(cli, es)} (CLI ${cli.length} / embed ${es.length})`);

// ---- 4. Controls: pause stops sim time, restart re-powers
await frame.click('#embedRun');
await sleep(400);
const tp = await frame.$eval('#simtime', (e) => e.textContent);
await sleep(800);
report('pause holds sim time', tp === (await frame.$eval('#simtime', (e) => e.textContent)), tp);
await frame.click('#embedRun');
report('resume advances sim time', await waitFor(frame, (t0) => document.getElementById('simtime').textContent !== t0, tp, 5000));
await frame.click('#embedSerial');
report('serial collapses', await frame.$eval('#console', (e) => e.hidden));
await frame.click('#embedSerial');

// ---- 5. Storage: nothing written in the iframe's real localStorage
const keys1 = await frame.evaluate(() => globalThis.__tbEmbedRealKeys());
report('iframe localStorage untouched', keys0 === 0 && keys1.length === 0, JSON.stringify(keys1));
// The shim itself: a page write lands in memory only
const probe = await frame.evaluate(() => { localStorage.setItem('tb-probe', '1'); return { mem: localStorage.getItem('tb-probe'), real: globalThis.__tbEmbedRealKeys() }; });
report('writes go to the in-memory copy', probe.mem === '1' && !probe.real.includes('tb-probe'), JSON.stringify(probe.real));

// ---- 6. "Open in TryBoard" opens /app with the same s in a new tab (sandbox lets the popup escape)
const href = await frame.$eval('#embedOpen', (a) => a.href);
report('open link = /app?s=<same s>', href === `${base}/app?s=${s}`, href.slice(0, 80));
const popup = new Promise((r) => ctx.once('targetcreated', r));
await frame.click('#embedOpen');
const tgt = await Promise.race([popup, sleep(10000).then(() => null)]);
const app = tgt ? await tgt.page() : null;
report('click opens a new tab on the lab page', !!app && (await waitFor(app, () => location.pathname.startsWith('/app'), null, 10000)));

// ---- 7. The full lab page restores the same s to the same serial
if (app) {
  app.on('pageerror', (e) => errors.push(`app: ${e}`));
  const ok = await waitFor(app, () => !!globalThis.__tbShareRestored, null, 60000);
  const as = ok ? (await app.evaluate(() => globalThis.__tbShareRestored)).stdout ?? '' : '';
  report('full page serial = embed serial (same s)', ok && as === es, as === es ? `${as.length} bytes` : `differs at ${diff(as, es)}`);
}

// ---- 7b. F-03b paced replay (&replay=1): sim time starts from 0, BOOT / heat land at their own time, the end state equals the fast-forward
const pp = await ctx.newPage();
pp.on('pageerror', (e) => errors.push(`paced: ${e}`));
pp.on('console', (m) => { if (m.type() === 'error') errors.push(`paced: ${m.text()}`); });
await pp.goto(embedUrl + '&replay=1', { waitUntil: 'load' });
await waitFor(pp, () => document.body.dataset.state === 'poster', null, 10000);
report('paced: poster offers "Replay at original speed", preselected by &replay=1', await pp.evaluate(() => document.getElementById('embedPaced')?.checked === true));
await pp.click('#embedPlay');
await waitFor(pp, () => document.body.dataset.state === 'ready', null, 60000);
// Sample (sim seconds, progress tag) until the replay ends; timing checks below use the page's per-tick trace
const seen = [];
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  const o = await pp.evaluate(() => ({ t: globalThis.__tbEmbed.store.get().simSeconds, tag: !!document.getElementById('embedReplay'), done: !!globalThis.__tbShareRestored }));
  seen.push(o);
  if (o.done) break;
  await sleep(100);
}
fs.writeFileSync(path.join(outDir, 'embed-paced-samples.json'), JSON.stringify(seen));
const first = seen.find((o) => !o.done);
report('paced: sim time starts near 0 with a progress tag', !!first && first.t < 1.0 && first.tag, first ? `${first.t.toFixed(2)} s` : 'no sample');
// Per-tick trace from the page (sim seconds at the tick's end, its serial chunk, room °C): exact under load, unlike 100 ms samples
const trace = await pp.evaluate(() => globalThis.__tbEmbed.trace ?? []);
fs.writeFileSync(path.join(outDir, 'embed-paced-trace.json'), JSON.stringify(trace));
let acc = '';
const iF = trace.findIndex(([, c]) => (acc += c).includes('UNIT F'));
const fT = iF >= 0 ? trace[iF][0] : NaN;
const preF = iF > 0 ? trace[iF - 1][0] : NaN; // last tick end without UNIT F yet
report('paced: UNIT F appears only after the BOOT press at 1.2 s', trace.length > 0 && trace[0][0] < 1.0 && fT >= 1.1 && preF > 1.0, iF >= 0 ? `first in tick ending ${fT.toFixed(3)} s, previous ${preF.toFixed(3)} s` : 'never');
const iH = trace.findIndex(([, , temp]) => temp === 35);
const hT = iH >= 0 ? trace[iH][0] : NaN;
const preH = iH > 0 ? trace[iH - 1][0] : NaN;
report('paced: room temperature follows the log (35 °C from 2 s)', hT >= 1.9 && preH > 1.8, iH >= 0 ? `at ${hT.toFixed(3)} s, previous ${preH.toFixed(3)} s` : 'never');
const pr = await pp.evaluate(() => globalThis.__tbShareRestored ?? {});
report('paced: end state = fast-forward (serial and report at the same cycle)', pr.paced === true && pr.stdout === es && pr.report === er, pr.stdout === es ? `${es.length} bytes, report ${pr.report === er ? 'same' : 'differs'}` : `differs at ${diff(pr.stdout ?? '', es)}`);
report('paced: progress tag gone after the end', await waitFor(pp, () => !document.getElementById('embedReplay'), null, 5000));
await pp.screenshot({ path: path.join(outDir, 'embed-paced.png') });
// Skip to end mid-replay = the usual fast-forward
await pp.goto(embedUrl + '&replay=1', { waitUntil: 'load' });
await waitFor(pp, () => document.body.dataset.state === 'poster', null, 10000);
await pp.click('#embedPlay');
await waitFor(pp, () => document.body.dataset.state === 'ready' && !!document.getElementById('embedSkip'), null, 60000);
await pp.click('#embedRun');
await sleep(300);
const pt = await pp.$eval('#simtime', (e) => e.textContent);
await sleep(600);
report('paced: pause holds sim time mid-replay', pt === (await pp.$eval('#simtime', (e) => e.textContent)) && parseFloat(pt) < 3, pt);
await pp.click('#embedSkip');
await waitFor(pp, () => !!globalThis.__tbShareRestored, null, 60000);
const sk = await pp.evaluate(() => ({ r: globalThis.__tbShareRestored, tag: !!document.getElementById('embedReplay'), run: document.getElementById('embedRun').getAttribute('aria-pressed') }));
report('paced: Skip to end = fast-forward serial, then runs on', sk.r.stdout === es && sk.r.report === er && !sk.tag && sk.run === 'false', `${sk.r.stdout?.length} bytes`);
await pp.close();

// ---- 8. Damaged link: message and a link home, no crash
const bad = await ctx.newPage();
bad.on('pageerror', (e) => errors.push(`bad: ${e}`));
await bad.goto(base + '/embed?s=AAAA_not-a-link', { waitUntil: 'load' });
report('damaged link -> error message', await waitFor(bad, () => document.body.dataset.state === 'error' && !!document.getElementById('embedOpen'), null, 10000));

// ---- 9. Phone width: no horizontal scroll in the poster or the run view
const m = await ctx.newPage();
await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await m.goto(embedUrl, { waitUntil: 'load' });
await waitFor(m, () => document.body.dataset.state === 'poster', null, 10000);
const sw = () => document.documentElement.scrollWidth <= innerWidth;
const posterFits = await m.evaluate(sw);
const paceH = await m.$eval('.tb-embed-pace', (e) => e.getBoundingClientRect().height);
report('390 px: "Replay at original speed" >= 44 px', paceH >= 44, `${paceH} px`);
await m.click('#embedPlay');
await waitFor(m, () => document.body.dataset.state === 'ready', null, 60000);
report('390 px: no horizontal scroll (poster and run view)', posterFits && (await m.evaluate(sw)));
const small = await m.$$eval('.tb-embed-btn, #embedOpen', (els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.id));
report('390 px: touch targets >= 44 px', small.length === 0, small.join(','));
await m.screenshot({ path: path.join(outDir, 'embed-mobile.png') });

await ctx.close();
await browser.close();
site.close();
host.close();
if (errors.length) console.log('[embed] page errors:\n  ' + errors.join('\n  '));
console.log(`[embed] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
