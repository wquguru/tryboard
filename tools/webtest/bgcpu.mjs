// Background-tab main-thread CPU (R-11): load the lab, hide its tab behind a blank page, then measure 5 s of
// CDP Performance.getMetrics TaskDuration / ScriptDuration deltas. Worker threads are not counted.
// Usage: node tools/webtest/bgcpu.mjs [dist dir] [--label name] [--json out.json] (out.json gets {label: result} merged in)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const jsonOut = opt('--json');
const label = opt('--label') ?? 'run';
const dist = path.resolve(args.find((a, i) => !a.startsWith('--') && !['--json', '--label'].includes(args[i - 1])) ?? path.join(root, 'web/dist'));
const url = '/app?work=blank&example=weather#bench';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.glb': 'model/gltf-binary' };
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
const page = await browser.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
const cdp = await page.createCDPSession();
await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
await page.goto(base + url, { waitUntil: 'load', timeout: 120000 });
await sleep(6000);
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const window5 = async () => {
  const a = await metrics();
  const sim0 = await page.evaluate(() => globalThis.__tbApp?.store.get().simSeconds ?? null);
  await sleep(5000);
  const b = await metrics();
  const sim1 = await page.evaluate(() => globalThis.__tbApp?.store.get().simSeconds ?? null);
  const d = (k) => Math.round((b[k] - a[k]) * 1000);
  return { taskMs: d('TaskDuration'), scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), styleMs: d('RecalcStyleDuration'), simAdvanced: sim0 === null ? null : +(sim1 - sim0).toFixed(2) };
};
const fg = await window5();
const blank = await browser.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await blank.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
await blank.bringToFront();
await sleep(300);
const vis = await page.evaluate(() => ({ hidden: document.hidden, state: document.visibilityState }));
const prof = args.includes('--profile');
if (prof) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
}
const bg = await window5();
if (prof) {
  // Top self time while hidden, to find what still runs on the main thread
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const n = byId.get(id).callFrame;
    const k = `${n.functionName || '(anon)'} ${n.url.split('/').pop()}:${n.lineNumber + 1}`;
    self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  for (const [k, ms] of [...self].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((x, y) => y[1] - x[1]).slice(0, 15)) console.log(`[bgcpu] ${ms.toFixed(1).padStart(7)} ms  ${k}`);
}
const out = { label, dist: path.relative(root, dist), url, foreground: fg, background: bg, ...vis, errors: errors.length, firstError: errors[0] ?? '' };
console.log(`[bgcpu] ${label}: hidden=${vis.hidden} fg task ${fg.taskMs} / script ${fg.scriptMs} ms; bg task ${bg.taskMs} / script ${bg.scriptMs} ms per 5 s (sim +${bg.simAdvanced} s) errors ${errors.length}`);
if (jsonOut) {
  const prev = fs.existsSync(jsonOut) ? JSON.parse(fs.readFileSync(jsonOut, 'utf8')) : {};
  prev[label] = out;
  fs.writeFileSync(jsonOut, JSON.stringify(prev, null, 1));
}
await browser.close();
server.close();
if (!vis.hidden) {
  console.error('[bgcpu] FAIL: page did not become hidden');
  process.exit(1);
}
