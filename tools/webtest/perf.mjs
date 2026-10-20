// Performance baseline (R-01): first-load bytes per entry, boot time, frame time, long tasks, sim speed.
// Usage: node tools/webtest/perf.mjs [dist dir] [--json out.json] [--desktop] [--only home,weather] [--lang zh] [--rtt 150]; desktop 1440×900 and 4× CPU-throttled 390×844.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const dist = path.resolve(args.find((a, i) => !a.startsWith('--') && !['--json', '--only', '--lang', '--rtt'].includes(args[i - 1])) ?? path.join(root, 'web/dist'));

// --lang zh: open every page with ?lang=zh (R-20 dictionary bytes are per locale).
const lang = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : null;
const withLang = (u) => (lang ? u.replace(/^([^?#]*)(\?[^#]*)?/, (m, p, q) => `${p}${q ? q + '&' : '?'}lang=${lang}`) : u);
// --rtt 150: add round-trip latency (10 Mbit/s) so request waterfalls show in the timings.
const rtt = args.includes('--rtt') ? +args[args.indexOf('--rtt') + 1] : 0;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.glb': 'model/gltf-binary' };
// Serve gzip like a static host would, so byte counts reflect what users download.
import zlib from 'node:zlib';
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  const ext = path.extname(f);
  const gz = ['.html', '.js', '.css', '.wasm', '.json', '.svg'].includes(ext);
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
  const s = fs.createReadStream(f);
  (gz ? s.pipe(zlib.createGzip({ level: 6 })) : s).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu'],
});

async function waitFor(page, fn, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

// Long tasks and frame intervals are collected in the page from navigation on.
const PROBE = () => {
  globalThis.__perf = { long: 0, longMs: 0, frames: [], tasks: [], rootMs: -1 };
  // First React render: the moment #root gets its first child (R-20 dictionary waterfall shows up here).
  new MutationObserver((l, o) => {
    if (document.getElementById('root')?.firstElementChild) (__perf.rootMs = Math.round(performance.now())), o.disconnect();
  }).observe(document, { childList: true, subtree: true });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        __perf.long++;
        __perf.longMs += e.duration;
        __perf.tasks.push([Math.round(e.startTime), Math.round(e.duration)]);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
};

function resKind(url) {
  const p = new URL(url).pathname;
  if (/\.woff2?$/.test(p)) return 'font';
  if (/\/assets\/i18n-[^/]*\.js$/.test(p)) return 'dict';
  if (p.includes('/rom/')) return 'rom';
  if (p.includes('/fw/')) return 'fw';
  if (/tryboard[^/]*\.wasm/.test(p)) return 'core';
  if (/\.wasm$/.test(p)) return 'wasm';
  if (/\.js$/.test(p)) return 'js';
  if (/\.css$/.test(p)) return 'css';
  return 'other';
}

async function measure(name, url, { mobile = false, ready = null, frameSec = 5, after = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport(mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (rtt) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: 1.25e6, uploadThroughput: 1.25e6 });
  let bytes = 0;
  // R-22: bytes per resource kind over the whole run; fonts, ROM, wasm and firmware all land after the load event.
  const kindOf = {};
  const byKind = {};
  // R-20: when the first dictionary chunk is requested, relative to the HTML request (a waterfall shows up as a late start).
  let docTs = null;
  let dictAt = null;
  cdp.on('Network.requestWillBeSent', (e) => {
    kindOf[e.requestId] = resKind(e.request.url);
    if (e.type === 'Document' && docTs === null) docTs = e.timestamp;
    if (kindOf[e.requestId] === 'dict' && dictAt === null && docTs !== null) dictAt = Math.round((e.timestamp - docTs) * 1000);
  });
  cdp.on('Network.loadingFinished', (e) => {
    bytes += e.encodedDataLength;
    const k = kindOf[e.requestId] ?? 'other';
    byKind[k] = (byKind[k] ?? 0) + e.encodedDataLength;
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
  await page.evaluateOnNewDocument(PROBE);
  const t0 = Date.now();
  await page.goto(base + withLang(url), { waitUntil: 'load', timeout: 120000 });
  const loadMs = Date.now() - t0;
  const loadBytes = bytes;
  let readyMs = null;
  if (ready) readyMs = (await waitFor(page, ready, 120000)) ? Date.now() - t0 : -1;
  if (after) await after(page);
  const renderMs = await page.evaluate(() => __perf.rootMs);
  // Frame sampling: rAF intervals over frameSec, plus sim seconds advanced per wall second.
  const fr = await page.evaluate(async (sec) => {
    const s0 = globalThis.__tbApp?.store.get().simSeconds ?? null;
    const w0 = performance.now();
    const ts = [];
    await new Promise((r) => {
      const tick = (t) => {
        ts.push(t);
        if (t - w0 < sec * 1000) requestAnimationFrame(tick);
        else r();
      };
      requestAnimationFrame(tick);
    });
    const s1 = globalThis.__tbApp?.store.get().simSeconds ?? null;
    const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
    const q = (p) => +(d[Math.min(d.length - 1, Math.floor(d.length * p))] ?? 0).toFixed(1);
    return { fps: +((d.length / sec)).toFixed(1), p50: q(0.5), p95: q(0.95), max: q(1), simRate: s0 === null ? null : +(((s1 - s0) / ((performance.now() - w0) / 1000))).toFixed(3), long: __perf.long, longMs: Math.round(__perf.longMs), tasks: __perf.tasks };
  }, frameSec);
  await page.close();
  return { name, url, mobile, loadMs, kb: Math.round(loadBytes / 1024), totalKb: Math.round(bytes / 1024), renderMs, dictAt, kindKb: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Math.round(v / 1024)])), readyMs, ...fr, errors: errors.length, firstError: errors[0] ?? '' };
}

const booted = () => (globalThis.__tbApp?.store.get().simSeconds ?? 0) > 0.2;
const openAnalyzer = async (page) => {
  await page.evaluate(() => document.querySelector('[data-dock="analyzer"]')?.click());
  await sleep(1500);
};
const rendered = () => (document.getElementById('root')?.childElementCount ?? 0) > 0;
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const S = [
  ['home', '/', { ready: rendered }],
  ['select', '/select', { ready: rendered }],
  ['lab weather', '/app?work=blank&example=weather#bench', { ready: booted }],
  ['lab weather + analyzer', '/app?work=blank&example=weather#bench', { ready: booted, after: openAnalyzer }],
  ['lab c3-lcd', '/app?work=blank&example=c3-lcd#bench', { ready: booted }],
  ['lab s3-lvgl', '/app?work=blank&example=s3-lvgl#bench', { ready: booted }],
];
const rows = [];
for (const mobile of args.includes('--desktop') ? [false] : [false, true]) for (const [n, u, o] of S) {
  if (ONLY && !ONLY.some((x) => n.includes(x))) continue;
  const r = await measure(n, u, { ...o, mobile });
  rows.push(r);
  console.log(`[perf] ${mobile ? 'mobile4x' : 'desktop '} ${n.padEnd(24)} load ${String(r.loadMs).padStart(5)} ms ${String(r.kb).padStart(5)} KB (total ${r.totalKb}) ready ${r.readyMs ?? '-'} ms render ${r.renderMs} ms dict@ ${r.dictAt ?? '-'} ms  fps ${r.fps} p50 ${r.p50} p95 ${r.p95} max ${r.max}  long ${r.long}/${r.longMs} ms  sim ${r.simRate ?? '-'}x  errors ${r.errors}${r.firstError ? ' (' + r.firstError + ')' : ''}`);
  console.log(`[perf]          bytes by kind (KB): ${Object.entries(r.kindKb).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
await browser.close();
server.close();
