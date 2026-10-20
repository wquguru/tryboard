// AMOLED all-in-one board (E-03): CO5300 picture, taps on the square screen, battery slider, USB and PWR key; CLI replay matches.
// Usage: node tools/webtest/amoled.mjs (after tools/build_web.sh and cargo build --release -p tryboard-cli); screenshots in Reviews/web/amoled-*
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
  console.log(`[amoled] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base + url);
  await waitFor(page, () => globalThis.__tbApp?.session?.consoleText().includes('TRYBOARD_OK'), null, 40000);
  return page;
}
const lines = (text, re) => text.replace(/\r/g, '').split('\n').filter((l) => re.test(l));
async function replay(page, fw, re) {
  const { log, out } = await page.evaluate(async () => ({ log: await globalThis.__tbApp.session.sim.inputLog(), out: globalThis.__tbApp.session.consoleText() }));
  const file = path.join(outDir, `amoled-${fw}-inputs.txt`);
  fs.writeFileSync(file, toScript(log));
  const args = cliArgs(log, path.join(root, `firmware/build/${fw}/flash.bin`), file, Math.floor(log.endMs) / 1000).slice(2);
  const p = spawnSync(CLI, ['run', ...args], { maxBuffer: 64 << 20 });
  const web = lines(out, re), cli = lines(p.stdout.toString(), re).slice(0, web.length);
  const diff = web.findIndex((l, i) => l !== cli[i]);
  return { same: web.length > 0 && diff < 0, web: web.length, cli: cli.length, events: log.events.length, diff: diff < 0 ? '' : `#${diff}: web "${web[diff]}" / CLI "${cli[diff]}"`, args: args.join(' ') };
}

// ---------------------------------------------------------------- 1. CO5300 picture on the square screen
{
  const page = await open('/app?work=blank&example=s3-co5300#bench');
  await sleep(500);
  const f = await page.evaluate(() => ({ n: globalThis.__tbApp.session.frame.lcd?.length ?? 0, w: globalThis.__tbApp.session.frame.lcdW, h: globalThis.__tbApp.session.frame.lcdH }));
  report('CO5300 480×480 frame reaches the 3D screen', f.n === 480 * 480 * 4 && f.w === 480 && f.h === 480, JSON.stringify(f));
  await page.screenshot({ path: path.join(outDir, 'amoled-co5300.png') });
  await page.close();
}

// ---------------------------------------------------------------- 2. Touch, battery, USB, PWR on the I2C bus
{
  const page = await open('/app?work=blank&example=s3-amoled-i2c#bench');
  const out = () => page.evaluate(() => globalThis.__tbApp.session.consoleText());
  report('all five I2C chips found', (await out()).includes('I2C 扫描完成：5/5 个器件')); // lint: allow-cjk
  const has = (re) => waitFor(page, (s) => new RegExp(s).test(globalThis.__tbApp.session.consoleText()), re.source, 5000);
  // Tap at panel pixel (120, 360): the CST9220 must report it within 2 px
  const [x, y] = await page.evaluate(() => globalThis.__tbApp.session.bench.lcdPoint(120, 360));
  await page.mouse.click(x, y, { delay: 120 });
  await has(/TOUCH UP/);
  const down = /TOUCH DOWN x=(\d+) y=(\d+)/.exec(await out());
  report('tap the square screen -> TOUCH at the tapped pixel', !!down && Math.abs(+down[1] - 120) <= 2 && Math.abs(+down[2] - 360) <= 2, down?.[0] ?? 'no TOUCH DOWN');
  // Board panel controls (the quick card renders the same component)
  await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'part', id: 'board' } }));
  await sleep(400);
  const slide = (v) => page.evaluate((val) => {
    const i = document.querySelector('input[data-act="battery"]');
    if (!i) return false;
    i.value = String(val);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, v);
  const click = (act) => page.evaluate((a) => {
    const b = document.querySelector(`[data-act="${a}"]`);
    b?.click();
    return !!b;
  }, act);
  report('battery slider to 100 % -> charge done', (await slide(100)) && (await has(/充电完成/))); // lint: allow-cjk
  report('unplug USB -> USB 拔出', (await click('usb')) && (await has(/USB 拔出/))); // lint: allow-cjk
  await slide(37);
  await sleep(300);
  report('PWR short press -> PWRON 短按, battery reads 37 %', (await click('pwr-short')) && (await has(/PWRON 短按/)) && (await has(/电量 37% USB 未插/))); // lint: allow-cjk
  report('PWR long press -> PWRON 长按', (await click('pwr-long')) && (await has(/PWRON 长按/))); // lint: allow-cjk
  // Second tap after the board events, so the replay interleaves input kinds
  const [x2, y2] = await page.evaluate(() => globalThis.__tbApp.session.bench.lcdPoint(400, 80));
  await page.mouse.click(x2, y2, { delay: 120 });
  report('second tap -> TOUCH near (400, 80)', await has(/TOUCH DOWN x=(39[89]|40[012]) y=(7[89]|8[012])\b/));
  await sleep(500);
  await page.screenshot({ path: path.join(outDir, 'amoled-i2c.png') });
  const r = await replay(page, 's3-amoled-i2c', /^(TOUCH|PWRON|USB|开始充电|充电完成|变化|发现|RTC|I2C)/); // lint: allow-cjk
  report('input log CLI replay matches line by line', r.same, `web ${r.web} lines / CLI ${r.cli} lines, ${r.events} inputs ${r.diff}`);
  if (!r.same) console.log(`[amoled] cli args: ${r.args}`);
  await page.close();
}

report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[amoled] ${fails ? 'FAIL' : 'PASS'} (${n} checks${fails ? `, ${fails} failed` : ''})`);
process.exit(fails ? 1 : 0);
