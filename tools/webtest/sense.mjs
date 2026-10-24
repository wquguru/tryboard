// IMU and touch screen (P2-02 / P2-03): real mouse drags the IMU module and taps / swipes the round screen; CLI replay matches line by line.
// Usage: node tools/webtest/sense.mjs (after tools/build_web.sh and cargo build --release -p tryboard-cli); screenshots in Reviews/web/sense-*
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

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Extensionless paths (/app, /select) map to .html, like Vite preview and static hosting (DESIGN_V2 §7.2)
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
  console.log(`[sense] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
async function open(url) {
  const page = await browser.newPage();
  // Beginner mode is on by default (H-01); these checks target the full bench
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base + url);
  await waitFor(page, () => globalThis.__tbApp?.session?.consoleText().includes('TRYBOARD_OK'), null, 40000);
  return page;
}
const lines = (text, re) => text.replace(/\r/g, '').split('\n').filter((l) => re.test(l));
/** This run's input log -> CLI replay, compare lines of one kind (CLI runs a bit longer, cut to the web line count) */
async function replay(page, fw, re) {
  const { log, out } = await page.evaluate(async () => ({ log: await globalThis.__tbApp.session.sim.inputLog(), out: globalThis.__tbApp.session.consoleText() }));
  const file = path.join(outDir, `sense-${fw}-inputs.txt`);
  fs.writeFileSync(file, toScript(log));
  const args = cliArgs(log, path.join(root, `firmware/build/${fw}/flash.bin`), file, Math.floor(log.endMs) / 1000).slice(2);
  const p = spawnSync(CLI, ['run', ...args], { maxBuffer: 64 << 20 });
  const web = lines(out, re), cli = lines(p.stdout.toString(), re).slice(0, web.length);
  return { same: web.length > 0 && JSON.stringify(web) === JSON.stringify(cli), web: web.length, cli: cli.length, events: log.events.length };
}

// ---------------------------------------------------------------- 1. IMU bench
{
  const page = await open('/app?work=imu#bench');
  report('IMU bench powers up', await page.evaluate(() => globalThis.__tbApp.session.consoleText().includes('MPU6050 WHO_AM_I 0x68 OK')));
  await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'part', id: 'mpu6050' } }));
  await sleep(300);
  await page.evaluate(async () => {
    for (const [k, v] of [['pitch', 30], ['roll', -20]]) {
      const i = document.querySelector(`.props input[data-pose="${k}"], input[data-pose="${k}"]`);
      for (let x = Math.sign(v) * 5; Math.abs(x) <= Math.abs(v); x += Math.sign(v) * 5) {
        i.value = String(x);
        i.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
      }
    }
  });
  const ok = await waitFor(page, () => {
    const m = globalThis.__tbApp.store.get().imu;
    return m && Math.abs(m.pitch - 30) < 0.5 && Math.abs(m.roll + 20) < 0.5 && m.gyro.every((g) => Math.abs(g) < 0.2);
  }, null, 8000);
  report('tilt sliders -> firmware readings', ok, JSON.stringify(await page.evaluate(() => globalThis.__tbApp.store.get().imu)));
  await page.screenshot({ path: path.join(outDir, 'sense-imu-slider.png') });
  // Real mouse drag on the IMU module
  const [x0, y0] = await page.evaluate(() => globalThis.__tbApp.session.bench.imuScreenPos());
  const p0 = await page.evaluate(() => globalThis.__tbApp.store.get().pose);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  let gyroSeen = 0;
  for (let i = 1; i <= 50; i++) {
    await page.mouse.move(x0 + i * 2, y0 - i * 0.8);
    await sleep(16);
    const g = await page.evaluate(() => globalThis.__tbApp.store.get().imu?.gyro);
    if (g && g.some((v) => Math.abs(v) > 5)) gyroSeen++;
  }
  await page.mouse.up();
  const p1 = await page.evaluate(() => globalThis.__tbApp.store.get().pose);
  report('drag the IMU module turns the bench, gyro reads angular rate', Math.abs(p1.yaw - p0.yaw) + Math.abs(p1.pitch - p0.pitch) > 10 && gyroSeen > 0, `pose ${JSON.stringify(p0)} -> ${JSON.stringify(p1)}, ${gyroSeen} samples with nonzero gyro`);
  const rest = await waitFor(page, (p) => {
    const m = globalThis.__tbApp.store.get().imu;
    return m && m.gyro.every((g) => Math.abs(g) < 0.2) && Math.abs(m.pitch - p.pitch) < 0.6;
  }, p1, 6000);
  report('after release gyro returns to zero, readings stay at the new pose', rest);
  await page.screenshot({ path: path.join(outDir, 'sense-imu-drag.png') });
  const r = await replay(page, 's3-imu', /^IMU /);
  report('IMU input log CLI replay matches', r.same, `web ${r.web} lines / CLI ${r.cli} lines, ${r.events} inputs`);
  // Product: drag the box
  await page.evaluate(() => (location.hash = 'product'));
  await sleep(800);
  const c = await page.evaluate(() => globalThis.__tbProduct?.center?.());
  const q0 = await page.evaluate(() => globalThis.__tbApp.store.get().pose);
  await page.mouse.move(c[0], c[1]);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(c[0] - i * 1.5, c[1] + i * 1.5);
    await sleep(16);
  }
  await page.mouse.up();
  const q1 = await page.evaluate(() => globalThis.__tbApp.store.get().pose);
  const follow = await waitFor(page, (p) => {
    const m = globalThis.__tbApp.store.get().imu;
    return m && Math.abs(m.pitch - p.pitch) < 0.6 && Math.abs(m.roll - p.roll) < 0.6;
  }, q1, 6000);
  report('Product: drag the box -> pose and firmware readings', JSON.stringify(q0) !== JSON.stringify(q1) && follow, `${JSON.stringify(q1)} read ${JSON.stringify(await page.evaluate(() => globalThis.__tbApp.store.get().imu))}`);
  await page.screenshot({ path: path.join(outDir, 'sense-imu-product.png') });
  await page.close();
}

// ---------------------------------------------------------------- 2. Round touch screen
{
  const page = await open('/app?work=touch#bench');
  report('touch bench powers up', await page.evaluate(() => globalThis.__tbApp.session.consoleText().includes('CST816S chip id 0xB5 OK')));
  const pt = (x, y) => page.evaluate((a, b) => globalThis.__tbApp.session.bench.lcdPoint(a, b), x, y);
  const out = () => page.evaluate(() => globalThis.__tbApp.session.consoleText());
  let [x, y] = await pt(60, 120);
  await page.mouse.click(x, y, { delay: 120 });
  const clicked = await waitFor(page, () => /GESTURE click/.test(globalThis.__tbApp.session.consoleText()), null, 5000);
  const down = /TOUCH DOWN x=(\d+) y=(\d+)/.exec(await out());
  report('tap the round screen -> coordinates and single tap', clicked && !!down && Math.abs(+down[1] - 60) <= 2 && Math.abs(+down[2] - 120) <= 2, down?.[0] ?? 'no TOUCH DOWN');
  [x, y] = await pt(50, 180);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) {
    const [a, b] = await pt(50 + k * 18, 180);
    await page.mouse.move(a, b);
    await sleep(40);
  }
  await page.mouse.up();
  report('horizontal drag -> swipe right', await waitFor(page, () => /GESTURE right/.test(globalThis.__tbApp.session.consoleText()), null, 5000));
  await sleep(500);
  const lit = await page.evaluate(() => globalThis.__tbApp.session.frame.lcd?.length ?? 0);
  report('round screen image is in 3D', lit === 240 * 240 * 4);
  await page.screenshot({ path: path.join(outDir, 'sense-touch.png') });
  const r = await replay(page, 's3-touch', /^(TOUCH|GESTURE) /);
  report('touch input log CLI replay matches', r.same, `web ${r.web} lines / CLI ${r.cli} lines, ${r.events} inputs`);
  await page.close();
}

report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[sense] ${fails ? 'FAIL' : 'PASS'} (${n} checks${fails ? `, ${fails} failed` : ''})`);
process.exit(fails ? 1 : 0);
