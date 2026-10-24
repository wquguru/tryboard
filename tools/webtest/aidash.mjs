// AI gateway dashboard (E-07b): s3-ai-dash example with the virtual PC in the Bluetooth dock; edited heartbeat reaches the
// firmware, swipe turns the page, and the exported input log (pc=…) replays byte for byte in the CLI.
// Usage: node tools/webtest/aidash.mjs (after tools/build_web.sh and cargo build --release -p tryboard-cli); screenshots in Reviews/web/aidash-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
let fails = 0, n = 0;
const report = (name, ok, extra = '') => {
  n++;
  console.log(`[aidash] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
// Beginner mode is on by default (H-01); these checks target the full bench
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(base + '/app?work=blank&example=s3-ai-dash#bench');
const out = () => page.evaluate(() => globalThis.__tbApp.session.consoleText());
const has = (re, ms = 20000) => waitFor(page, (s) => new RegExp(s, 'm').test(globalThis.__tbApp?.session?.consoleText() ?? ''), re.source, ms);
const count = async (re) => ((await out()).match(new RegExp(re.source, 'gm')) ?? []).length;

// ---- 1. Example opens with the virtual PC on: it finds Claude-Dash and the firmware goes ONLINE
report('firmware boots (TRYBOARD_OK)', await has(/TRYBOARD_OK s3-ai-dash/, 60000));
report('virtual PC connects -> 蓝牙 ONLINE', await has(/蓝牙 ONLINE/)); // lint: allow-cjk
const linked = await waitFor(page, () => document.querySelector('#pcPanel')?.getAttribute('data-active') === 'true' && /Claude-Dash/.test(document.querySelector('#pcStatus')?.textContent ?? ''), null, 15000);
report('Bluetooth dock: virtual PC panel shows Connected · Claude-Dash', linked, await page.$eval('#pcStatus', (e) => e.textContent).catch(() => 'no #pcStatus'));
report('first heartbeat parsed by the firmware', await has(/^心跳 #1 /)); // lint: allow-cjk
const frame = () => page.evaluate(() => {
  const f = globalThis.__tbApp.session.frame;
  let h = 0;
  const a = f.lcd ?? [];
  for (let i = 0; i < a.length; i += 7) h = (h * 31 + a[i]) | 0;
  return { n: a.length, w: f.lcdW, h: f.lcdH, hash: h };
});
const f0 = await frame();
report('480×480 dashboard frame on the AMOLED', f0.n === 480 * 480 * 4 && f0.w === 480 && f0.h === 480, JSON.stringify(f0));
await page.screenshot({ path: path.join(outDir, 'aidash-online.png') });

// ---- 2. Edit the heartbeat in the panel and send it (pc=hb): the firmware prints the parsed values
const setNum = async (k, v) => {
  await page.click(`[data-hb="${k}"]`, { clickCount: 3 });
  await page.keyboard.type(String(v));
};
await setNum('total', 5);
await setNum('running', 4);
await setNum('waiting', 1);
await setNum('tokens', 150000);
await setNum('tokens_today', 42000);
await page.click('#pcHbSend');
const parsed = await has(/^心跳 #\d+ total=5 running=4 waiting=1 tokens=150000 tokens_today=42000/); // lint: allow-cjk
report('edited heartbeat -> serial 心跳 total=5 running=4 waiting=1 tokens=150000', parsed); // lint: allow-cjk
await has(/^屏幕 已更新/); // lint: allow-cjk
await sleep(800);
const f1 = await frame();
report('screen redrawn after the edited heartbeat', f1.hash !== f0.hash);
report('panel shows the ack from the board', await waitFor(page, () => !!document.querySelector('#pcAck') && !!document.querySelector('#pcLastHb')?.textContent.includes('"running":4'), null, 10000));
await page.screenshot({ path: path.join(outDir, 'aidash-heartbeat.png') });

// ---- 3. Swipe left on the screen: page 2
const drag = async (x0, x1, y) => {
  const [ax, ay] = await page.evaluate((x, yy) => globalThis.__tbApp.session.bench.lcdPoint(x, yy), x0, y);
  const [bx, by] = await page.evaluate((x, yy) => globalThis.__tbApp.session.bench.lcdPoint(x, yy), x1, y);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(ax + ((bx - ax) * i) / 8, ay + ((by - ay) * i) / 8);
    await sleep(40);
  }
  await sleep(120);
  await page.mouse.up();
};
await drag(400, 80, 240);
report('swipe left -> page 2/4', await has(/^滑动 向左 dx=-?\d+ → 页 2\/4/)); // lint: allow-cjk
await sleep(600);
await page.screenshot({ path: path.join(outDir, 'aidash-swipe.png') });

// ---- 4. Turn the virtual PC off and on again from the panel (pc=off / pc=on)
const onlines = await count(/^蓝牙 ONLINE/); // lint: allow-cjk
await page.click('#pcToggle');
report('turn off -> firmware sees the disconnect', await has(/^蓝牙 断开/)); // lint: allow-cjk
await page.click('#pcToggle');
report('turn on again -> ONLINE again', await waitFor(page, ([s, k]) => (globalThis.__tbApp.session.consoleText().match(new RegExp(s, 'gm')) ?? []).length > k, [/^蓝牙 ONLINE/.source, onlines], 20000)); // lint: allow-cjk

// ---- 5. Pause, export the input log, replay with the CLI: serial byte-identical
await page.evaluate(() => globalThis.__tbApp.session.sim.pause());
await sleep(500);
const { log, live } = await page.evaluate(async () => ({ log: await globalThis.__tbApp.session.sim.inputLog(), live: globalThis.__tbApp.session.consoleText() }));
const script = toScript(log);
const file = path.join(outDir, 'aidash-inputs.txt');
fs.writeFileSync(file, script);
fs.writeFileSync(path.join(outDir, 'aidash-web.stdout'), live);
const acts = script.split('\n').filter((l) => /^\d/.test(l));
report('input log has pc=on, pc=hb, pc=off and the swipe', acts.some((l) => /:pc=on$/.test(l)) && acts.some((l) => /:pc=hb,/.test(l)) && acts.some((l) => /:pc=off$/.test(l)) && acts.some((l) => /:touch=/.test(l)), `${acts.length} inputs`);
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const args = cliArgs(log, path.join(root, 'firmware/build/s3-ai-dash/flash.bin'), file).slice(2);
const p = spawnSync(CLI, ['run', ...args, '--seconds', String((cycles + 0.5) / CPU_HZ)], { maxBuffer: 64 << 20 });
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'aidash-cli.stdout'), cli);
let at = [...cli].findIndex((c, i) => c !== live[i]);
if (at < 0 && cli.length !== live.length) at = Math.min(cli.length, live.length);
report('CLI --inputs replay = live web serial (byte for byte)', at < 0 && p.status === 0, at < 0 ? `${live.length} bytes, ${(log.endMs / 1000).toFixed(3)} s` : `differs at ${at} (CLI ${cli.length} / web ${live.length}): ${JSON.stringify(cli.slice(at, at + 50))} vs ${JSON.stringify(live.slice(at, at + 50))}`);
if (at >= 0) console.log(`[aidash] cli args: ${args.join(' ')}`);

report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[aidash] ${fails ? 'FAIL' : 'PASS'} (${n} checks${fails ? `, ${fails} failed` : ''})`);
process.exit(fails ? 1 : 0);
