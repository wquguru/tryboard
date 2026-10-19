// Start-up CPU profile of a lab page: top self-time and top call stacks (R-15 diagnosis).
// Usage: node tools/webtest/prof.mjs [url path] [--nocache] [--prewarm] [--gl] [--mobile] [--click=<css>] (serves web/dist like perf.mjs; --nocache matches perf.mjs)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('--')) ?? '/app?work=blank&example=weather#bench';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404), res.end();
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu'] });
// --prewarm: open and close one lab page first, like perf.mjs's earlier rows
if (argv.includes('--prewarm')) {
  const p0 = await browser.newPage();
  await p0.goto(`http://localhost:${server.address().port}/app?work=blank&example=weather#bench`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, +(process.env.PREWARM_MS ?? 4000)));
  await p0.close();
  await new Promise((r) => setTimeout(r, +(process.env.PREWARM_GAP ?? 0)));
}
const page = await browser.newPage();
await page.setViewport(argv.includes('--mobile') ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
const cdp = await page.createCDPSession();
// --mobile: same 390×844 viewport and 4× CPU throttle as perf.mjs's mobile rows
if (argv.includes('--mobile')) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
if (argv.includes('--nocache')) await cdp.send('Network.enable'), await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.evaluateOnNewDocument(() => {
  globalThis.__long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => __long.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true });
});
// --gl: log program links that block > 20 ms, with three's SHADER_NAME and defines
if (argv.includes('--gl')) await page.evaluateOnNewDocument(() => {
  globalThis.__gl = [];
  Error.stackTraceLimit = 40;
  const P = WebGL2RenderingContext.prototype;
  for (const fn of ['getProgramParameter', 'getActiveUniform', 'getUniformLocation', 'getProgramInfoLog', 'getShaderInfoLog', 'getShaderParameter', 'getAttribLocation', 'getActiveAttrib']) {
    const orig = P[fn];
    P[fn] = function (prog, ...a) {
      const t = performance.now(), r = orig.call(this, prog, ...a), d = performance.now() - t;
      if (d > 20) {
        const src = prog instanceof WebGLProgram ? this.getAttachedShaders(prog).map((sh) => this.getShaderSource(sh)).join('\n') : this.getShaderSource(prog) ?? '';
        __gl.push([fn, Math.round(t), Math.round(d), new Error().stack.split('\n').slice(9, 22).map((l) => l.trim().replace(/http:[^ ]*assets\//, '')).join(' < '), (src.match(/#define SHADER_NAME (.*)/) ?? [])[1], src.split('\n').filter((l) => /^#define [A-Z_]+$/.test(l)).slice(0, 12).join(' ')]);
      }
      return r;
    };
  }
});
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await page.goto(`http://localhost:${server.address().port}${url}`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 4000));
// --click=<css>: profile what happens after clicking it (e.g. --click='[data-dock="analyzer"]')
const click = argv.find((a) => a.startsWith('--click='))?.slice(8);
if (click) {
  await page.evaluate(() => (__long.length = 0));
  await cdp.send('Profiler.stop');
  await cdp.send('Profiler.start');
  await page.evaluate((c) => document.querySelector(c)?.click(), click);
  await new Promise((r) => setTimeout(r, 3000));
}
const long = await page.evaluate(() => __long);
// performance.mark() entries the page set (R-16: start-up phases)
const marks = await page.evaluate(() => performance.getEntriesByType('mark').map((m) => `${m.name}@${Math.round(m.startTime)}`).join(' '));
if (argv.includes('--gl')) console.log('== slow links', JSON.stringify(await page.evaluate(() => __gl), null, 1));
// DUMP='<js expr>': print a page value (e.g. a debug global) after the run
if (process.env.DUMP) console.log('== dump', JSON.stringify(await page.evaluate(process.env.DUMP)));
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const dt = new Map();
profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i + 1] ?? 0) / 1000));
const self = new Map();
const stacks = new Map();
const name = (n) => `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
const native = {};
for (const [id, ms] of dt) {
  const n = byId.get(id);
  if (['(idle)', '(program)', '(garbage collector)'].includes(n.callFrame.functionName)) {
    native[n.callFrame.functionName] = Math.round((native[n.callFrame.functionName] ?? 0) + ms);
    continue;
  }
  self.set(name(n), (self.get(name(n)) ?? 0) + ms);
  const st = [];
  for (let p = id; p && st.length < (process.env.DEPTH ?? 8); p = parent.get(p)) st.push(name(byId.get(p)));
  const k = st.join(' < ');
  stacks.set(k, (stacks.get(k) ?? 0) + ms);
}
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(5)} ms  ${k.slice(0, process.env.DEPTH ? 4000 : 220)}`).join('\n');
console.log('== long tasks [start ms, duration ms]', JSON.stringify(long), '\n== marks', marks, '\n== native', JSON.stringify(native));
// Inclusive time per function (each sample counted once per distinct frame on its stack); INCL=<n> rows
if (process.env.INCL) {
  const incl = new Map();
  for (const [id, ms] of dt) {
    const seen = new Set();
    for (let p = id; p; p = parent.get(p)) seen.add(name(byId.get(p)));
    // FOCUS=<function name>: only samples under that function
    if (process.env.FOCUS && ![...seen].some((k) => k.startsWith(process.env.FOCUS + ' '))) continue;
    for (const k of seen) incl.set(k, (incl.get(k) ?? 0) + ms);
  }
  console.log('== inclusive\n' + top(incl, +process.env.INCL));
}
console.log('== self time\n' + top(self, 20) + '\n== stacks\n' + top(stacks, 15));
await browser.close();
server.close();
