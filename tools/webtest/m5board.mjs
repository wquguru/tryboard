// M5Stack board presets on the web (M5-09b; Grove Port A units + mid-run environment, M5-09d): pick a preset, upload a locally built M5 .bin, compare with `tryboard run --board [--grove]`.
// Usage: node tools/webtest/m5board.mjs (after tools/build_web.sh, cargo build --release -p tryboard-cli and tools/build_arduino.sh for the arduino-m5-* bins; those stay local, see docs/M5STACK.md §7). Screenshots / logs in Reviews/web/m5board-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toScript, cliArgs } from '../../web/src/inputlog.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CLI = path.join(root, 'core/target/release/tryboard');
const CPU_HZ = 160_000_000;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!f.startsWith(dist) || !fs.existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
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
  console.log(`[m5board] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
/** CLI run with check.py's fingerprint rules (same as replay.mjs) */
function cliRun(args, tag) {
  const p = spawnSync(CLI, ['run', ...args], { maxBuffer: 64 << 20 });
  const out = path.join(outDir, `m5board-${tag}.stdout`);
  const err = path.join(outDir, `m5board-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), fp, code: p.status };
}

const CASES = [
  { fw: 'arduino-m5-probe-atoms3', board: 'm5atoms3', start: 's3-blink', want: 'M5PROBE board=M5AtomS3 board_id=11', done: 'TRYBOARD_OK m5-probe' },
  { fw: 'arduino-m5-probe-stickc_plus2', board: 'm5stickcplus2', start: 'esp32-hello', want: 'M5PROBE board=M5StickCPlus2 board_id=5', done: 'TRYBOARD_OK m5-probe' },
  { fw: 'arduino-m5-cardputer-demo', board: 'm5cardputer', start: 's3-blink', want: 'CARDPUTER ready board=14 display=240x135 keyboard=74hc138', done: 'CARDPUTER ready', keys: true },
  { fw: 'arduino-m5-env-atoms3', board: 'm5atoms3', grove: 'env4', start: 's3-blink', want: 'ENV ready unit=4 port_a=2/1', done: 'ENV4 t=', env: { temp: 35.6, humidity: 12.9, pressure: 102260 }, after: 'ENV4 t=35.6 h=12.9 p=1022.6' },
  { fw: 'arduino-m5-env-stickc_plus2', board: 'm5stickcplus2', grove: 'env3', start: 'esp32-hello', want: 'ENV ready unit=3 port_a=32/33', done: 'ENV3 t=', env: { temp: 30.2, humidity: 60.4, pressure: 99870 }, after: 'ENV3 t=30.2 h=60.4 p=998.7' },
];

for (const c of CASES) {
  const bin = path.join(root, `firmware/build/${c.fw}/flash.bin`);
  if (!fs.existsSync(bin)) {
    report(`${c.board}: ${c.fw} built`, false, 'missing; run tools/build_arduino.sh');
    continue;
  }
  const page = await browser.newPage();
  const tag = c.grove ? `${c.board}-${c.grove}` : c.board;
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}/app?work=blank&example=${c.start}#bench`);
  await waitFor(page, () => !!globalThis.__tbApp?.session?.sim, null, 40000);
  // Upload through the firmware menu's file input (same path as a user's own .bin), then pick the preset like the board panel does
  const input = await page.$('#fwPick');
  await input.uploadFile(bin);
  await waitFor(page, (n) => globalThis.__tbApp.session.fwName === n, 'flash.bin', 10000);
  await page.evaluate((board, grove) => {
    const s = globalThis.__tbApp.session;
    s.applyScene({ ...s.scene, board, ...(grove ? { grove } : {}) }, s.power ?? { ext5v: false }, 'preset');
  }, c.board, c.grove);
  const up = await waitFor(page, (w) => globalThis.__tbApp.session.consoleText().includes(w), c.done, 60000);
  const out = await page.evaluate(() => globalThis.__tbApp.session.consoleText());
  report(`${c.board}: firmware identifies the board`, up && out.includes(c.want), up ? c.want : out.slice(-200).replace(/\n/g, ' | '));
  if (c.env) {
    // Environment controls mid-run (logged env=…): the Grove unit's next reading follows
    await page.evaluate((e) => globalThis.__tbApp.session.setEnv(e), c.env);
    const moved = await waitFor(page, (w) => globalThis.__tbApp.session.consoleText().includes(w), c.after, 30000);
    report(`${c.board} + ${c.grove}: reading follows the environment`, moved, moved ? c.after : (await page.evaluate(() => globalThis.__tbApp.session.consoleText())).slice(-200).replace(/\n/g, ' | '));
  }
  if (c.keys) {
    // Physical keys on the bench -> Cardputer matrix (logged key=…)
    await page.mouse.click(700, 450);
    for (const k of ['h', 'i', 'Space', 'Comma', 'Enter']) {
      await page.keyboard.press(k.length === 1 ? k : k === 'Space' ? ' ' : k === 'Comma' ? ',' : k, { delay: 120 });
      await sleep(150);
    }
    const typed = await waitFor(page, () => globalThis.__tbApp.session.consoleText().includes('CARDPUTER line=hi ,'), null, 20000);
    report(`${c.board}: typed keys reach the Cardputer keyboard`, typed, typed ? 'CARDPUTER line=hi ,' : (await page.evaluate(() => globalThis.__tbApp.session.consoleText())).slice(-200).replace(/\n/g, ' | '));
  }
  await page.screenshot({ path: path.join(outDir, `m5board-${tag}.png`) });

  // Input log -> CLI --inputs replay: serial matches the live web run byte for byte.
  // Pause first, then take one snapshot: its log (endMs) and its stdout (since the preset boot) describe the same instant, like replay.mjs
  await page.evaluate(() => globalThis.__tbApp.session.sim.pause());
  const snap = await page.evaluate(() => globalThis.__tbApp.session.sim.snapshot());
  const log = snap.log;
  report(`${c.board}: input log header carries the preset`, log.board === c.board && log.grove === c.grove, `board=${log.board} grove=${log.grove}`);
  if (c.env) report(`${c.board} + ${c.grove}: input log has the env change`, log.events.filter((e) => e.kind === 'env').length >= 2, toScript(log).split('\n').filter((l) => l.includes('env=')).join(' | '));
  const file = path.join(outDir, `m5board-${tag}-inputs.txt`);
  fs.writeFileSync(file, toScript(log));
  const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
  const args = cliArgs(log, bin, file, (cycles + 0.5) / CPU_HZ).slice(2);
  const live = cliRun(args, `${tag}-live`);
  const web = snap.stdout;
  fs.writeFileSync(path.join(outDir, `m5board-${tag}-web.stdout`), web);
  let at = [...live.stdout].findIndex((ch, i) => ch !== web[i]);
  if (at < 0 && live.stdout.length !== web.length) at = Math.min(live.stdout.length, web.length);
  report(`${c.board}: CLI ${args.filter((a) => a.startsWith('--')).join(' ')} replay = web serial (byte for byte)`, at < 0 && web.length > 0 && !snap.truncated && live.code === 0,
    at < 0 ? `${web.length} bytes, ${cycles} cycles` : `differs from byte ${at} (CLI ${live.stdout.length} / web ${web.length}): ${JSON.stringify(live.stdout.slice(at, at + 60))} vs ${JSON.stringify(web.slice(at, at + 60))}`);
  // The serial panel shows the same bytes: the preset boot's output is the tail of the console (earlier boots precede it)
  const panel = await page.evaluate(() => globalThis.__tbApp.session.consoleText());
  fs.writeFileSync(path.join(outDir, `m5board-${tag}-web.txt`), panel);
  report(`${c.board}: serial panel ends with the run's serial`, panel.endsWith(web), JSON.stringify(panel.slice(-80)));

  // Fingerprint: verify worker vs CLI on the same log
  const SECS = Math.max(3, Math.ceil(log.endMs / 1000));
  const wv = await page.evaluate((l, s) => globalThis.__tbReplay(l, s), log, SECS);
  const fpArgs = cliArgs(log, bin, file, SECS).slice(2);
  fpArgs.splice(fpArgs.indexOf('--inputs'), 0, '--gpio-log', '--ws2812-log');
  const cf = cliRun(fpArgs, `${tag}-fp`);
  fs.writeFileSync(path.join(outDir, `m5board-${tag}-verify.json`), JSON.stringify(wv, null, 1));
  report(`${c.board}: web verify fingerprint = CLI --board fingerprint`, wv.fingerprint === cf.fp && !wv.error, `web ${wv.fingerprint} / CLI ${cf.fp}${wv.error ? ' error ' + wv.error : ''}`);
  await page.close();
}

report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails ? `[m5board] ${fails} FAILED` : '[m5board] all passed');
process.exit(fails ? 1 : 0);
