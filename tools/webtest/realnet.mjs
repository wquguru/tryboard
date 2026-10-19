// Real-network switch (C-03): a local fake internet behind Chrome --proxy-server, so results never depend on the public net.
// Usage: node tools/webtest/realnet.mjs (after tools/build_web.sh); logs and screenshots in Reviews/web/realnet-*
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
const FW = path.join(root, 'firmware/build/c3-http-real/flash.bin');
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

// Fake internet: example.com sends no CORS header (the browser blocks it), httpbin.org/get sends Access-Control-Allow-Origin: *
const hits = { example: 0, httpbin: 0 };
const fake = http.createServer((req, res) => {
  // Through the proxy req.url is absolute (http://example.com/)
  const u = new URL(req.url, `http://${req.headers.host ?? 'x'}`);
  const host = u.hostname;
  if (host === 'example.com') {
    hits.example++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    return res.end('<!doctype html><title>Example Domain</title>');
  }
  if (host === 'httpbin.org' && u.pathname === '/get') {
    hits.httpbin++;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end('{\n  "args": {}, \n  "url": "http://httpbin.org/get"\n}\n');
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fport = fake.address().port;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,1000', `--proxy-server=http://127.0.0.1:${fport}`],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[realnet] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const hasText = (page, sel, t, ms = 20000) => waitFor(page, ([s, x]) => (document.querySelector(s)?.textContent ?? '').includes(x), [sel, t], ms);
async function clickTab(page, name) {
  const h = await page.evaluateHandle((n) => [...document.querySelectorAll('#dock [role=tab]')].find((b) => b.textContent.trim().startsWith(n)) ?? null, name);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
}
async function newPage(w, h, mobile) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile });
  // The CORS-blocked fetch logs a console error: that is the case under test, not a page error
  p.on('pageerror', (e) => errors.push(`${e}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/CORS|Access-Control-Allow-Origin|Failed to load resource|ERR_FAILED/.test(t)) return;
    errors.push(t);
  });
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
/** Intercept a download: click sel and return the Blob text (no real download) */
const grabDownload = (page, sel) =>
  page.evaluate(async (s) => {
    let blob = null;
    let name = '';
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { name = this.download; };
    document.querySelector(s).click();
    for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 50));
    URL.createObjectURL = orig;
    HTMLAnchorElement.prototype.click = click;
    return { text: blob ? await blob.text() : '', name };
  }, sel);

// ---- 1. Off by default
const page = await newPage(1440, 1000);
await page.goto(base + '/app?work=blank&example=c3-http-real#bench', { waitUntil: 'load' });
report('default: virtual server answers example.com', await hasText(page, '#console', 'example.com：虚拟服务器回答（没开真实网络）')); // lint: allow-cjk (firmware serial)
report('default: httpbin.org virtual 404', await hasText(page, '#console', 'httpbin.org：虚拟服务器回 404（没开真实网络）')); // lint: allow-cjk (firmware serial)
await hasText(page, '#console', 'TRYBOARD_OK c3-http-real');
report('default: the switch is off', await page.$eval('#realnetBtn', (b) => b.getAttribute('aria-checked') === 'false'));
report('default: nothing went online', hits.example + hits.httpbin === 0, JSON.stringify(hits));

// ---- 2. Turn on -> confirm -> restart
await page.click('#realnetBtn');
const dlg = await page.waitForSelector('#realnetDlg', { timeout: 5000 }).catch(() => null);
const dlgText = dlg ? await dlg.evaluate((e) => e.textContent) : '';
report('confirm dialog: only HTTP / needs internet / replay offline', /Only HTTP is allowed/.test(dlgText) && /needs internet/.test(dlgText) && /replayed offline/.test(dlgText), dlgText.slice(0, 40));
await page.screenshot({ path: path.join(outDir, 'realnet-dialog.png') });
await page.click('#realnetDlg [data-act="on"]');
report('after turning on the switch is aria-checked=true', await waitFor(page, () => document.getElementById('realnetBtn')?.getAttribute('aria-checked') === 'true', null, 3000));
report('dialog closes', await waitFor(page, () => !document.getElementById('realnetDlg'), null, 3000));
// A restart keeps the console: compare the part after the restart (last boot banner past the old length)
const pre = (await fwConsole(page)).length;
await page.click('#runRestart');
report('example.com: serial says the browser blocked it, reason cors', await hasText(page, '#console', 'example.com：浏览器没放行，原因 cors')); // lint: allow-cjk (firmware serial)
report('httpbin.org: serial shows a real reply', await hasText(page, '#console', 'httpbin.org：真实回复，url=http://httpbin.org/get')); // lint: allow-cjk (firmware serial)
report('TRYBOARD_OK', await hasText(page, '#console', 'TRYBOARD_OK c3-http-real'));
report('fake internet got the requests (example twice: fetch + no-cors probe; httpbin once)', hits.example === 2 && hits.httpbin === 1, JSON.stringify(hits));
await clickTab(page, 'Network');
await page.click('[data-net="reqs"]').catch(() => {});
await waitFor(page, () => !!document.querySelector('#netRows'), null, 5000);
const rows = await page.$$eval('#netRows tbody tr', (l) => l.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())));
const ex = rows.find((r) => r[3].includes('http://example.com/'));
const hb = rows.find((r) => r[3].includes('httpbin.org/get'));
report('request table: example.com destination Real, status Failed, CORS note', !!ex && ex[2] === 'Real' && ex[4] === 'Failed' && /does not allow cross-origin requests \(CORS\)/.test(ex[3]), JSON.stringify(ex));
report('request table: httpbin.org destination Real, status 200', !!hb && hb[2] === 'Real' && hb[4] === '200', JSON.stringify(hb));
report('request table: headers Time/Method/Destination/Address/Status/Duration', (await page.$$eval('#netRows th', (l) => l.map((t) => t.textContent).join('/'))) === 'Time/Method/Destination/Address/Status/Duration');
report('2 replies recorded this run', await hasText(page, '#realnetBar', '2 replies recorded this run', 5000), await page.$eval('#realnetBar', (e) => e.textContent).catch(() => ''));
await page.screenshot({ path: path.join(outDir, 'realnet-rows.png') });

// ---- 3. Save replies -> CLI replay
await page.click('#runPause');
await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const all = await fwConsole(page);
const live = all.slice(all.indexOf('I (1) cpu_start: Unicore app', pre));
const dl = await grabDownload(page, '#saveReplies');
const inputsFile = path.join(outDir, 'realnet-inputs.txt');
fs.writeFileSync(inputsFile, dl.text);
fs.writeFileSync(path.join(outDir, 'realnet-web.stdout'), live);
const lines = dl.text.split('\n');
report('saved file name *-realnet.txt', /-realnet\.txt$/.test(dl.name), dl.name);
report('log: realnet=1 at time 0', lines.some((l) => /^0(\.0+)?:realnet=1$/.test(l)), lines.find((l) => /realnet=/.test(l)) ?? '');
const replies = lines.filter((l) => /:netreply=/.test(l));
report('log: two netreply lines (#1 cors failure, #2 200 application/json)', replies.length === 2 && /netreply=1,0,\d+,cors,$/.test(replies[0]) && /netreply=2,200,\d+,application\/json,[A-Za-z0-9+/=]+$/.test(replies[1]), replies.map((l) => l.slice(0, 60)).join(' | '));
const before = { ...hits };
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), '--inputs', inputsFile], { maxBuffer: 64 << 20 });
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'realnet-cli.stdout'), p.stdout);
fs.writeFileSync(path.join(outDir, 'realnet-cli.stderr'), p.stderr);
let at = -1;
if (cli !== live) at = Math.max(0, [...cli].findIndex((c, i) => c !== live[i]));
report('CLI --inputs replay = web serial (byte for byte)', cli === live && p.status === 0 && cli.includes('httpbin.org：真实回复'), // lint: allow-cjk (firmware serial)
  cli === live ? `${live.length} bytes, ${cycles} cycles` : `differs from byte ${at} (CLI ${cli.length} / web ${live.length}): ${JSON.stringify(cli.slice(at, at + 50))} vs ${JSON.stringify(live.slice(at, at + 50))}`);
report('CLI replay stays offline', hits.example === before.example && hits.httpbin === before.httpbin);

// ---- 4. Rewind: seek to this run's end (same fingerprint), then between the two replies and continue (#2 uses the recorded reply); both offline
const sk = await page.evaluate(async () => {
  const a = globalThis.__tbApp;
  const steps = a.hist.steps();
  const n = Math.max(...steps.filter((s) => s.op.k === 'run').map((s) => s.op.n));
  const r = await a.hist.seek(steps.findIndex((s) => s.op.k === 'run' && s.op.n === n));
  return r && { same: r.same, fp: r.fingerprint };
});
report('timeline back to the end of this run: identical to then', sk?.same === true, JSON.stringify(sk));
const reqAt = (n) => {
  const l = fs.readFileSync(path.join(outDir, 'realnet-cli.stderr'), 'utf8').split('\n').find((x) => x.includes(`real network request #${n} `));
  return l ? Number(l.match(/([\d.]+)s/)[1]) * 1000 : NaN;
};
// Stop after reply 1 and before reply 2 (request 2 already sent, not answered yet)
const r1 = log.events.find((e) => e.kind === 'netreply' && e.reply.startsWith('1,'));
const r2 = log.events.find((e) => e.kind === 'netreply' && e.reply.startsWith('2,'));
const mid = r1 && r2 ? Math.max(r1.tMs, reqAt(2)) + (r2.tMs - Math.max(r1.tMs, reqAt(2))) / 2 : NaN;
const mz = await page.evaluate(async (untilMs) => {
  const a = globalThis.__tbApp;
  const lg = await globalThis.__tbInputLog();
  const ev = lg.events.filter((e) => e.kind !== 'power');
  const env0 = ev[0]?.kind === 'env' ? ev.shift() : null;
  await a.session.seek({ flash: a.session.fwBuf, i2c: lg.i2c, lcd: lg.lcd, env: env0 ?? undefined, events: ev, untilMs });
  a.session.continueRun();
  return true;
}, mid).catch((e) => `${e}`);
const okMid = mz === true && (await hasText(page, '#console', 'httpbin.org：真实回复，url=http://httpbin.org/get', 20000)); // lint: allow-cjk (firmware serial)
report(`back between the two replies (${(mid / 1000).toFixed(3)} s) and continue: #2 uses the recorded reply`, okMid, String(mz));
report('rewind and continue stay offline', hits.example === before.example && hits.httpbin === before.httpbin, JSON.stringify(hits));
const relog = await page.evaluate(async () => (await globalThis.__tbInputLog()).events.filter((e) => e.kind === 'netreply').map((e) => e.reply));
report('log after continuing: both replies as before', relog.length === 2 && relog[0] === r1?.reply && relog[1] === r2?.reply, `${relog.length} replies`);

// ---- Turning it off: no confirmation
await page.click('#runPause').catch(() => {});
await page.click('#realnetBtn');
await sleep(200);
report('off: no confirmation, aria-checked=false', !(await page.$('#realnetDlg')) && (await page.$eval('#realnetBtn', (b) => b.getAttribute('aria-checked'))) === 'false');
await page.close();

// ---- 5. Checkpoint with the real network on: needs internet, no run ID
const pc = await newPage(1440, 1000);
await pc.goto(base + '/app?work=weather#bench', { waitUntil: 'load' });
await pc.evaluate(() => { try { localStorage.removeItem('tryboard-app-checks:weather'); } catch { /* */ } });
await pc.waitForSelector('#realnetBtn', { timeout: 20000 });
await pc.click('#realnetBtn');
await pc.click('#realnetDlg [data-act="on"]');
await pc.waitForSelector('#tree .tn[data-kind="checkpoint"][data-id="01"]', { timeout: 30000 }).catch(() => null);
await pc.click('#tree .tn[data-kind="checkpoint"][data-id="01"]').catch(() => {});
const ref = await pc.waitForSelector('#runRef:not([disabled])', { timeout: 20000 }).catch(() => null);
if (ref) {
  await ref.click();
  const done = await waitFor(pc, () => !!document.querySelector('#realnetNote'), null, 60000);
  const txt = done ? await pc.$eval('#realnetNote', (e) => e.textContent) : '';
  report('checkpoint: result says needs internet, no run ID', /Needs internet/.test(txt) && /no run ID/.test(txt), txt.slice(0, 40));
  const card = await pc.$eval('#props .result-card', (e) => e.textContent).catch(() => '');
  report('checkpoint: result card says needs internet', /Needs internet/.test(card), card.slice(0, 60));
  const runId = await pc.evaluate(() => [...document.querySelectorAll('.fp')].map((e) => e.textContent).join('|'));
  report('checkpoint: no run ID shown', !/[0-9a-f]{8}/.test(runId), runId);
  const saved = await pc.evaluate(() => localStorage.getItem('tryboard-app-checks:weather') ?? '');
  report('progress: net recorded, fingerprint empty', !saved || (/"net":true/.test(saved) && /"fp":""/.test(saved)), saved.slice(0, 120));
  await pc.screenshot({ path: path.join(outDir, 'realnet-check.png') });
} else report('checkpoint: found Try reference firmware', false);
await pc.close();

// ---- 6. Mobile layout
const pm = await newPage(390, 844, true);
await pm.goto(base + '/app?work=blank&example=c3-http-real#bench', { waitUntil: 'load' });
await hasText(pm, '#console', 'TRYBOARD_OK', 30000);
await tap(pm, '#moreBtn');
report('mobile: ⋯ menu has Real network: off', await hasText(pm, '[data-more="realnet"]', 'Real network: off', 5000));
await tap(pm, '[data-more="realnet"]');
await pm.waitForSelector('#realnetDlg', { timeout: 5000 }).catch(() => null);
const bh = await pm.$$eval('#realnetDlg button', (l) => Math.min(...l.map((b) => b.getBoundingClientRect().height)));
report('mobile: dialog buttons ≥ 44px', bh >= 44, `${bh}px`);
const [sw, iw] = await pm.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
report('mobile: no horizontal scroll', sw <= iw, `${sw} / ${iw}`);
await pm.screenshot({ path: path.join(outDir, 'realnet-mobile.png') });
await pm.close();

await browser.close();
server.close();
fake.close();
if (errors.length) console.log('[realnet] page errors:\n  ' + errors.join('\n  '));
console.log(`[realnet] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
