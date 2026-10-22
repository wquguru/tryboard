// Logic-analyzer parity (P1-05): live web events = first N lines of CLI --trace-io replaying the same input log (verbatim); seeks too.
// Usage: node tools/webtest/traceio.mjs (after tools/build_web.sh); output in Reviews/web/traceio-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { i2cArgs } from '../../web/src/i2cdevs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const FW = path.join(root, 'firmware/build/weather/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');

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
  console.log(`[traceio] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
await page.goto(base + '/app?work=weather&debug=1#bench', { waitUntil: 'load' });
const booted = await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console').textContent), null, 30000);
report('weather bench runs live (serial T=23.50)', booted);
await waitFor(page, () => globalThis.__tbApp?.store.get().simSeconds > 1.5, null, 30000);
const did = await page.evaluate(() => globalThis.__tbApp.cmdk.exec('room temperature 35'));
const alarm = await waitFor(page, () => document.getElementById('console').textContent.includes('ALARM ON'), null, 15000);
report('⌘K Set room temperature to 35 ℃ -> serial ALARM ON', did === 'Set room temperature to 35 ℃' && alarm, `ran "${did}"`);
const t1 = await page.evaluate(() => globalThis.__tbApp.store.get().simSeconds);
await waitFor(page, (t) => globalThis.__tbApp.store.get().simSeconds > t + 0.8, t1, 15000);
// Read after pausing: the snapshot first flushes the worker's pending events (messages are ordered)
const web = await page.evaluate(async () => {
  const s = globalThis.__tbApp.session;
  s.sim.pause();
  await new Promise((r) => setTimeout(r, 300));
  const snap = await s.snapshot();
  await new Promise((r) => setTimeout(r, 100));
  return { log: snap.log, text: s.io.text(), n: s.io.raw.length, pins: s.ioPins(), dropped: s.io.dropped + s.io.coreDropped };
});
fs.writeFileSync(path.join(outDir, 'traceio-web.txt'), web.text);
fs.writeFileSync(path.join(outDir, 'traceio-inputs.json'), JSON.stringify(web.log, null, 1));
report('web event store has events, none dropped', web.n > 1000 && web.dropped === 0, `${web.n} events, watching GPIO ${web.pins.join(',')}, until ${(web.log.endMs / 1000).toFixed(3)} s`);

// Input log -> --inputs text (same format as inputlog.ts toScript: seconds floored to microseconds)
const sec = (ms) => (Math.floor(ms * 1000) / 1e6).toFixed(6);
const act = (e) => (e.kind === 'gpio' ? `gpio${e.pin}=${e.level < 0 ? 'z' : e.level ? 1 : 0}` : e.kind === 'env' ? `env=${e.temp},${e.humidity},${e.pressure}` : e.kind === 'pot' ? `mv${e.pin}=${e.mv}` : null);
const script = web.log.events.flatMap((e) => (act(e) ? [`${sec(e.tMs)}:${act(e)}`] : [])).join('\n') + '\n';
const inputsFile = path.join(outDir, 'traceio-inputs.txt');
fs.writeFileSync(inputsFile, script);
const traceFile = path.join(outDir, 'traceio-cli.txt');
const i2c = i2cArgs(web.log.i2c);
// Run the CLI 50 ms longer: I2C events logged before the pause but stamped after it (pre-stamped by bit timing) must exist too
const seconds = String(web.log.endMs / 1000 + 0.05);
const p = spawnSync(CLI, ['run', FW, '--seconds', seconds, ...i2c, '--inputs', inputsFile, '--trace-io', traceFile, '--trace-pins', web.pins.join(',')], { maxBuffer: 64 << 20 });
fs.writeFileSync(path.join(outDir, 'traceio-cli.stderr'), p.stderr);
const cli = fs.readFileSync(traceFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const wl = web.text.split('\n').filter(Boolean);
let diff = wl.findIndex((l, i) => l !== cli[i]);
report('web events = first N lines of CLI --trace-io (verbatim)', p.status === 0 && diff < 0 && cli.length >= wl.length, diff < 0 ? `${wl.length} lines match (CLI has ${cli.length})` : `line ${diff + 1} differs: web ${JSON.stringify(wl[diff])} / CLI ${JSON.stringify(cli[diff])}`);

// Content: BME280 8-byte burst read, servo 50 Hz, buzzer 2.7 kHz
const burst = wl.findIndex((l, i) => /I2C0 DATA f7 W ACK$/.test(l) && /RESTART/.test(wl[i + 1]) && /ADDR 76 R ACK$/.test(wl[i + 2]) && wl.slice(i + 3, i + 11).every((x) => / R (N?ACK)$/.test(x)) && / R NACK$/.test(wl[i + 10]) && /STOP$/.test(wl[i + 11]));
report('events include an 8-byte 0x76 read (from 0xF7)', burst >= 0, burst >= 0 ? wl.slice(burst - 2, burst + 12).map((l) => l.split(' ').slice(1).join(' ')).join(' | ').slice(0, 160) : '');
const servo = wl.find((l) => /^\d+ PWM 4 \d+ 50000$/.test(l));
const buzz = wl.find((l) => /^\d+ PWM 5 3276[78] 27\d{5}$/.test(l));
report('PWM: GPIO4 servo 50 Hz, GPIO5 buzzer 2.7 kHz 50%', !!servo && !!buzz, `${servo} / ${buzz}`);

// Seek (P0-03) to run #1: events are rebuilt by replay and must be a CLI prefix with nothing missing; pre-stamped I2C may pass
// the stop point by up to one FIFO batch (≈ 0.73 ms, DECISIONS P1-05), so only I2C lines within 1 ms may lie beyond it.
const seekCheck = (name, text, stopCyc, untilMs, extra) => {
  const sl = text.split('\n').filter(Boolean);
  const d = sl.findIndex((l, i) => l !== cli[i]);
  const t = (l) => Number(l.split(' ')[0]);
  const over = sl.filter((l) => t(l) > stopCyc);
  const nextT = cli[sl.length] ? t(cli[sl.length]) : Infinity;
  const lastT = sl.length ? t(sl.at(-1)) : 0;
  const ok = d < 0 && sl.length > 100 && sl.length < wl.length && nextT >= stopCyc && over.every((l) => / I2C\d /.test(l)) && lastT <= stopCyc + 160000;
  report(name, ok, `stopped at ${(stopCyc / CPU_HZ).toFixed(4)} s, ${sl.length} lines (live web ${wl.length}), ${over.length} past the stop${over.length ? ` (last +${lastT - stopCyc} cycles)` : ''}, CLI next ${nextT === Infinity ? 'none' : `+${nextT - stopCyc}`}${d < 0 ? '' : `; line ${d + 1} differs: web ${JSON.stringify(sl[d])} / CLI ${JSON.stringify(cli[d])}`}; seek point ${(untilMs / 1000).toFixed(4)} s (old rule "last ≤ seek + 20000 cycles" ${lastT <= Math.round(untilMs * 160000) + 20000 ? 'passes too' : 'would fail'})${extra ? '; ' + extra : ''}`);
};
const sk = await page.evaluate(async () => {
  const a = globalThis.__tbApp;
  const i = a.hist.steps().findIndex((s) => s.op.k === 'run' && s.op.n === 1);
  const r = await a.hist.seek(i);
  await new Promise((res) => setTimeout(res, 300));
  return { r, text: a.session.io.text(), sim: a.store.get().simSeconds };
});
if (!sk.r) report('seek to run #1 (before the temperature change): events rebuilt by replay match the CLI prefix', false, 'seek failed');
else seekCheck('seek to run #1 (before the temperature change): events rebuilt by replay match the CLI prefix', sk.text, Math.round(sk.sim * CPU_HZ), sk.r.untilMs);

// Cover the lucky case above deterministically: seek into the middle of an SSD1306 command batch in run #1 (0x3C in the CLI events)
const t = (l) => Number(l.split(' ')[0]);
const envAt = Math.round((web.log.events.find((e) => e.kind === 'env' && e.tMs > 1)?.tMs ?? 0) * 160000);
const oled = cli.map((l, i) => [l, i]).filter(([l, i]) => / I2C0 ADDR 3c W ACK$/.test(l) && t(l) < envAt - 160000 && t(l) > 160000 * 300).at(-1);
if (!oled) report('seek into an SSD1306 write: events rebuilt by replay match the CLI prefix', false, 'no 0x3C write in run #1 among the CLI events');
else {
  const midMs = (t(oled[0]) + 60000) / 160000;
  const mk = await page.evaluate(async (untilMs) => {
    const a = globalThis.__tbApp;
    const rec = a.hist.runs().find((r) => r.n === 1);
    const log = rec.snap.log;
    const rest = log.events.filter((e) => e.kind !== 'power');
    const env0 = rest[0]?.kind === 'env' ? { temp: rest[0].temp, humidity: rest[0].humidity, pressure: rest[0].pressure } : a.store.get().env;
    const events = rest[0]?.kind === 'env' ? rest.slice(1) : rest;
    const snap = await a.session.seek({ flash: rec.fw, i2c: log.i2c, lcd: log.lcd, servo: log.servo, power: log.power, encoder: log.encoder, sonar: log.sonar, touchInt: log.touchInt, env: env0, events, untilMs });
    await new Promise((res) => setTimeout(res, 300));
    return { text: a.session.io.text(), sim: snap.simSeconds };
  }, midMs);
  seekCheck('seek into an SSD1306 write: events rebuilt by replay match the CLI prefix', mk.text, Math.round(mk.sim * CPU_HZ), midMs);
}

await browser.close();
server.close();
if (errors.length) console.log('[traceio] page errors:\n  ' + errors.join('\n  '));
console.log(`[traceio] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
