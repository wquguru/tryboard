// Fine sampling parity (D-04): the analyzer's exported VCD = tryboard run --vcd on the same input log (byte for byte).
// Usage: node tools/webtest/vcd.mjs (after tools/build_web.sh); output in Reviews/web/vcd-*
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
const FW = path.join(root, 'firmware/build/c3-dht11/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
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
  console.log(`[vcd] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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

const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/app?work=blank&example=c3-dht11&debug=1#bench', { waitUntil: 'load' });
const booted = await waitFor(page, () => globalThis.__tbApp?.analyzer && globalThis.__tbApp.store.get().simSeconds > 0.2, null, 30000);
report('c3-dht11 example boots on the bench', booted);

// Fine sampling on GPIO5, triggered by the next edge (the firmware's 20 ms start pulse), 30 ms window
const started = await page.evaluate(() => {
  const a = globalThis.__tbApp.analyzer;
  a.open('GPIO5');
  return a.fineStart({ pin: 5, len: 0.03 });
});
const closed = await waitFor(page, () => {
  const a = globalThis.__tbApp;
  const st = a.analyzer.fine().state;
  return st && st.t1 !== null && a.store.get().simSeconds * 160e6 > st.t1 + 160e6 * 0.02 && a.analyzer.fine().wave;
}, null, 60000);
report('triggered window opens and closes', started && closed);

const web = await page.evaluate(async () => {
  const a = globalThis.__tbApp;
  const s = a.session;
  s.sim.pause();
  await new Promise((r) => setTimeout(r, 300));
  const snap = await s.snapshot();
  const vcd = await a.analyzer.exportVcd(false);
  const raw = await s.vcdText();
  const f = a.analyzer.fine();
  // Cursor A in the middle of the 3rd decoded data-bit high pulse
  const w = f.wave;
  let pt = '';
  let want = null;
  if (w) {
    const ups = [];
    for (let i = 1; i + 1 < w.t.length; i++) {
      const low = (w.t[i] - w.t[i - 1]) / 160, high = (w.t[i + 1] - w.t[i]) / 160;
      if (w.v[i] === 1 && low > 35 && low < 65 && high < 100) ups.push([w.t[i], w.t[i + 1], high]);
    }
    const u = ups[2];
    if (u) {
      a.analyzer.setCursor('a', (u[0] + u[1]) / 2 / 160e6);
      pt = a.analyzer.pulseText();
      want = u[2] > 60 ? 1 : 0;
    }
  }
  return { log: snap.log, vcd, raw: raw.text, state: f.state, frame: f.frame, nbits: f.bits.length, pt, want, env: a.store.get().env };
});
fs.writeFileSync(path.join(outDir, 'vcd-web.vcd'), web.vcd);
fs.writeFileSync(path.join(outDir, 'vcd-inputs.json'), JSON.stringify(web.log, null, 1));
report('export = worker VCD text, edges counted, none dropped', web.vcd.length > 0 && web.vcd === web.raw && web.state.edges > 80 && web.state.dropped === 0, `${web.state.edges} edges, window ${web.state.t0}..${web.state.t1} cycles`);
const env = web.log.events.find((e) => e.kind === 'env') ?? web.env;
report('DHT11 overlay decodes 40 bits with the slider readings and a good checksum', web.nbits >= 40 && web.frame?.ok && web.frame.humidity === Math.round(env.humidity) && Math.abs(web.frame.temp - env.temp) < 0.11, JSON.stringify(web.frame));
report('cursor readout: high pulse width and bit', new RegExp(`^High \\d+(\\.\\d+)? µs → ${web.want}$`).test(web.pt), JSON.stringify(web.pt));

// Same input log through the CLI with the window the web trigger picked
const sec = (ms) => (Math.floor(ms * 1000) / 1e6).toFixed(6);
const act = (e) => (e.kind === 'gpio' ? `gpio${e.pin}=${e.level < 0 ? 'z' : e.level ? 1 : 0}` : e.kind === 'env' ? `env=${e.temp},${e.humidity},${e.pressure}` : e.kind === 'pot' ? `mv${e.pin}=${e.mv}` : null);
const script = web.log.events.flatMap((e) => (act(e) ? [`${sec(e.tMs)}:${act(e)}`] : [])).join('\n') + '\n';
const inputsFile = path.join(outDir, 'vcd-inputs.txt');
fs.writeFileSync(inputsFile, script);
const cliVcd = path.join(outDir, 'vcd-cli.vcd');
const win = `${(web.state.t0 / CPU_HZ).toPrecision(17)}..${(web.state.t1 / CPU_HZ).toPrecision(17)}`;
const seconds = String(web.log.endMs / 1000 + 0.01);
const args = ['run', FW, '--seconds', seconds, '--dht11', String(web.log.dht11 ?? 5), '--inputs', inputsFile, '--vcd', cliVcd, '--vcd-pins', '5', '--vcd-window', win];
const p = spawnSync(CLI, args, { maxBuffer: 64 << 20 });
fs.writeFileSync(path.join(outDir, 'vcd-cli.stderr'), p.stderr);
const cli = p.status === 0 && fs.existsSync(cliVcd) ? fs.readFileSync(cliVcd, 'utf8') : '';
const wl = web.vcd.split('\n'), cl = cli.split('\n');
const d = wl.findIndex((l, i) => l !== cl[i]);
report('web VCD = tryboard run --vcd (byte for byte)', p.status === 0 && cli === web.vcd, cli === web.vcd ? `${web.vcd.length} bytes; tryboard ${args.slice(2).join(' ')}` : `exit ${p.status}; line ${d + 1}: web ${JSON.stringify(wl[d])} / CLI ${JSON.stringify(cl[d])}`);
const tline = p.stderr.toString().split('\n').find((l) => l.startsWith('[tryboard] timing-sensitive:'));
report('CLI flags the busy-wait timing on GPIO5', !!tline && /GPIO5 busy-wait esp_rom_delay_us/.test(tline), tline ?? '');

// Busy-wait note shows with the "confirm on real hardware" badge
const note = await page.evaluate(() => {
  const n = document.querySelector('[data-a="note"]');
  return n && !n.hidden ? n.textContent : '';
});
report('busy-wait note with the real-hardware badge', /Confirm on real hardware/.test(note), note.slice(0, 120));

await browser.close();
server.close();
if (errors.length) console.log('[vcd] page errors:\n  ' + errors.join('\n  '));
console.log(`[vcd] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
