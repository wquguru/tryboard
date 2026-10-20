// Timeline seek cost (R-23): weather bench runs 3 s, then 10 timeline seeks to the end of run #1 (full replay) and 10 short
// seeks (50 ms, mostly fixed power-up cost); per-seek wall time and main-thread long tasks. Usage: node tools/webtest/seektime.mjs [dist] [--json out]
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const dist = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--json') ?? path.join(root, 'web/dist'));
const N = 10;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.glb': 'model/gltf-binary' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu'] });

async function waitFor(page, fn, arg = null, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[seektime] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
const errors = [];
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
// Long tasks observed from the first script on, collected per window by start time
await page.evaluateOnNewDocument(() => {
  globalThis.__lt = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => globalThis.__lt.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true });
});
await page.goto(base + '/app?work=blank&example=weather#bench', { waitUntil: 'load' });
report('weather runs 3 s', await waitFor(page, () => globalThis.__tbApp?.store.get().simSeconds > 3, null, 60000));

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[s.length >> 1], min: s[0], max: s.at(-1), mean: s.reduce((a, b) => a + b, 0) / s.length };
};
const res = await page.evaluate(async (n) => {
  const a = globalThis.__tbApp;
  const lt = (t0, t1) => globalThis.__lt.filter(([s]) => s >= t0 && s < t1);
  const one = async (fn) => {
    const t0 = performance.now();
    const snap = await fn();
    const t1 = performance.now();
    const l = lt(t0, t1);
    return { ms: t1 - t0, sim: snap?.simSeconds ?? snap?.sim ?? null, lt: l.length, ltMs: l.reduce((x, [, d]) => x + d, 0), ltMax: Math.max(0, ...l.map(([, d]) => d)) };
  };
  const step = () => a.hist.steps().findIndex((s) => s.op.k === 'run' && s.op.n === 1);
  const full = [];
  for (let k = 0; k < n; k++) full.push(await one(() => a.hist.seek(step())));
  const rec = a.hist.runs().find((r) => r.n === 1);
  const log = rec.snap.log;
  const rest = log.events.filter((e) => e.kind !== 'power');
  const env0 = rest[0]?.kind === 'env' ? { temp: rest[0].temp, humidity: rest[0].humidity, pressure: rest[0].pressure } : a.store.get().env;
  const events = rest[0]?.kind === 'env' ? rest.slice(1) : rest;
  const short = [];
  for (let k = 0; k < n; k++) short.push(await one(() => a.session.seek({ flash: rec.fw, i2c: log.i2c, lcd: log.lcd, servo: log.servo, power: log.power, encoder: log.encoder, sonar: log.sonar, touchInt: log.touchInt, env: env0, events, untilMs: 50 })));
  return { full, short, endMs: log.endMs, fp: a.hist.lastSeek()?.fingerprint, same: a.hist.lastSeek()?.same };
}, N);
for (const k of ['full', 'short']) {
  const s = stat(res[k].map((r) => r.ms));
  const l = res[k].reduce((x, r) => x + r.lt, 0);
  const lm = res[k].reduce((x, r) => x + r.ltMs, 0);
  const lmax = Math.max(...res[k].map((r) => r.ltMax));
  console.log(`[seektime] ${k} (${k === 'full' ? `to ${(res.endMs / 1000).toFixed(3)} s` : '50 ms'}) x${N}: median ${s.median.toFixed(1)} ms, min ${s.min.toFixed(1)}, max ${s.max.toFixed(1)}, mean ${s.mean.toFixed(1)}; long tasks ${l} (${lm.toFixed(0)} ms total, max ${lmax.toFixed(0)} ms)`);
  console.log(`[seektime]   each: ${res[k].map((r) => r.ms.toFixed(0)).join(' ')}`);
}
report('seek to end of run #1 keeps the run fingerprint', res.same === true, `fingerprint ${res.fp}`);
report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(res, null, 1));
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
