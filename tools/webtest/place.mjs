// 台面直接放零件回归（P2-16）：app.html?work=blank&debug=1#bench（空台面，S3）
//  1. 先跑 s3-blink（GPIO5 每 500 ms 翻转）；元件库里放不了的件是灰的、带原因
//  2. 把「LED 套件」拖到台面 → 逐根接线横幅；长脚只给 GPIO 圈，真实鼠标点 GPIO5；短脚只给 GND 圈，点 GND
//  3. 接完：场景里多了 led@5、接线表两根线、接线检查无问题；3D 里这颗灯的亮度跟着 GPIO5 亮灭（不是摆设）
//  4. 串口与命令行 tryboard run 同一固件逐行一致（放 LED 不重新上电、不改模拟）
//  5. 点「放」BME280，VCC 故意接 5V → 接线检查报 W2；同类模块再放一次被拦；Esc 取消放置
// 用法：node tools/webtest/place.mjs [dist 目录，默认 web/dist]。截图在 Reviews/web/place-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.resolve(process.argv[2] ?? path.join(root, 'web/dist'));
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // 无后缀地址（/app、/select）映射到 .html，与 Vite 预览和静态托管一致（DESIGN_V2 §7.2）
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
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[place] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
const errors = [];
const CLI = path.join(root, 'core/target/release/tryboard');
const FW = path.join(root, 'firmware/build/s3-blink/flash.bin');
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.evaluateOnNewDocument(() => localStorage.clear());
await page.goto(base + '/app?work=blank&debug=1#bench', { waitUntil: 'load' });
await waitFor(page, () => !!globalThis.__tbApp?.hist, null, 30000);
await page.evaluate(async () => {
  const buf = await (await fetch('./fw/s3-blink/flash.bin')).arrayBuffer();
  await globalThis.__tbApp.session.loadFirmware(buf, 's3-blink/flash.bin');
});
const ran = await waitFor(page, () => /LED ON/.test(document.getElementById('console').textContent), null, 30000);
report('空台面跑 s3-blink', ran);

const has = (sel) => page.$(sel).then(Boolean);
const toast = () => page.$eval('#toast', (e) => e.textContent).catch(() => '');
const rings = () => page.$$eval('#pinRings [data-ring]', (es) => es.map((e) => e.dataset.ring));
const stepIs = (s) => waitFor(page, (x) => document.querySelector('#placeBanner')?.dataset.step === x, s);
/** 真实鼠标点引脚圈：圈跟着相机投影走，取当前位置再点 */
async function clickRing(id) {
  await waitFor(
    page,
    (i) => {
      const e = document.querySelector(`#pinRings [data-ring="${i}"]`);
      return e && !e.hidden && e.getBoundingClientRect().width > 0;
    },
    id,
  );
  const b = await page.$eval(`#pinRings [data-ring="${id}"]`, (e) => {
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await page.mouse.move(b[0], b[1]);
  await page.mouse.click(b[0], b[1]);
}

// ---- 1. 元件库：能放的有「放」，放不了的灰掉并给原因
await page.click('[data-left="lib"]');
await waitFor(page, () => !!document.querySelector('#partLib [data-place="led-kit"]'));
const grey = await page.$$eval('#partLib [data-place][disabled]', (es) => es.map((e) => e.getAttribute('aria-label')));
const okN = await page.$$eval('#partLib [data-place]:not([disabled])', (es) => es.length);
report('元件库：可放的有「放」，放不了的灰掉带原因', okN >= 8 && grey.length > 0 && grey.every((g) => /放不了：.{4,}/.test(g)), `可放 ${okN}，灰 ${grey.length}：${grey[0] ?? ''}`);

// ---- 2. 拖 LED 到台面（元件库的拖动类型）→ 逐根接线
const ledsBefore = await page.evaluate(() => globalThis.__tbApp.session.bench.ledLevels().length);
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData('application/x-tryboard-part', 'led-kit');
  const st = document.getElementById('stage');
  const ev = (t) => new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 700, clientY: 400 });
  st.dispatchEvent(ev('dragover'));
  st.dispatchEvent(ev('drop'));
});
const s1 = await stepIs('IN');
const r1 = await rings();
report('拖到台面 → 接线横幅，长脚只给 GPIO 圈', s1 && r1.length > 10 && r1.every((r) => /^GPIO\d+$/.test(r)), `${r1.length} 个圈`);
await page.screenshot({ path: path.join(outDir, 'place-banner.png') });
await clickRing('GPIO5');
const s2 = await stepIs('GND');
const r2 = await rings();
report('点 GPIO5 → 下一根短脚，只给 GND 圈', s2 && r2.length === 1 && r2[0] === 'GND', r2.join(','));
await clickRing('GND');
await waitFor(page, () => !document.querySelector('#placeBanner'));
const placedToast = await toast();

// ---- 3. 接完：场景、接线表、接线检查、3D 灯跟着 GPIO5
const scene = await page.evaluate(() => globalThis.__tbApp.session.scene.parts);
const led = scene.find((p) => p.type === 'led');
report('场景里多了 led@5', !!led && led.pin === 5 && scene.length === 1, JSON.stringify(scene));
await page.click('[data-left="wires"]');
const rows = await page.$$eval('#wireTable [data-wire]', (es) => es.map((e) => e.dataset.wire));
const faults = await page.evaluate(() => globalThis.__tbApp.faults());
report('接线表两根线、接线检查无问题', rows.includes('wire:GPIO5~led:5:IN') && rows.includes('wire:GND~led:5:GND') && faults.length === 0, `${rows.join(' ')}；问题 ${faults.length}`);
report('放完提示', /已放 .*LED.*没发现问题/.test(placedToast), placedToast);
const seen = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 4000 && seen.size < 2) {
  const l = await page.evaluate(() => globalThis.__tbApp.session.bench.ledLevels().find((x) => x.pin === 5));
  if (l) seen.add(l.target);
  await sleep(80);
}
report('3D 里这颗 LED 跟着 GPIO5 亮灭', ledsBefore === 0 && seen.has(0) && seen.has(1), `之前 ${ledsBefore} 颗；看到亮度 ${[...seen].join('/')}`);
await page.click('[data-left="lib"]');
await page.screenshot({ path: path.join(outDir, 'place-led.png') });

// ---- 4. 与命令行对拍：串口逐行一致
await waitFor(page, () => (document.getElementById('console').textContent.match(/LED (ON |OFF) \(\d+\)/g) ?? []).length >= 6, null, 20000);
const web = (await page.$eval('#console', (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''))).split('\n').filter((l) => /^LED |TRYBOARD_OK/.test(l));
let cliLines = [];
if (fs.existsSync(CLI)) {
  const p = spawnSync(CLI, ['run', FW, '--seconds', '3'], { maxBuffer: 64 << 20 });
  cliLines = p.stdout.toString('utf8').split('\n').filter((l) => /^LED |TRYBOARD_OK/.test(l));
}
const n = Math.min(web.length, cliLines.length);
report('串口与命令行逐行一致', n >= 6 && web.slice(0, n).join('\n') === cliLines.slice(0, n).join('\n'), `${n} 行；网页 ${JSON.stringify(web[0])} 命令行 ${JSON.stringify(cliLines[0])}`);

// ---- 5. 点「放」BME280，VCC 接 5V → W2；再放一次被拦；Esc 取消
await page.click('#partLib [data-place="bme280"]');
await stepIs('VIN');
const rp = await rings();
report('BME280 VCC 只给电源圈', [...rp].sort().join(',') === '3V3,5V', rp.join(','));
await clickRing('5V');
await stepIs('GND');
await clickRing('GND');
await stepIs('SCL');
await clickRing('GPIO9');
await stepIs('SDA');
await clickRing('GPIO9');
const dupT = await toast();
await clickRing('GPIO8');
await waitFor(page, () => !document.querySelector('#placeBanner'));
const f2 = await page.evaluate(() => globalThis.__tbApp.faults());
const bme = (await page.evaluate(() => globalThis.__tbApp.session.scene.parts)).find((p) => p.type === 'bme280');
report('SDA 不能和 SCL 接同一根', /已经接了/.test(dupT), dupT);
report('BME280 VCC 接 5V → 接线检查报 W2', !!bme && bme.sda === 8 && bme.scl === 9 && f2.some((f) => f.rule === 'W2' && f.wires.includes('wire:3V3~bme280:VIN')), JSON.stringify(f2.map((f) => f.rule)));
await sleep(300);
await page.screenshot({ path: path.join(outDir, 'place-w2.png') });
await page.click('#partLib [data-place="bme280"]');
await sleep(200);
const again = await toast();
report('同类模块再放一次被拦', !(await has('#placeBanner')) && /已经有/.test(again), again);
const nBefore = (await page.evaluate(() => globalThis.__tbApp.session.scene.parts)).length;
await page.click('#partLib [data-place="ssd1306"]');
await waitFor(page, () => !!document.querySelector('#placeBanner'));
await page.keyboard.press('Escape');
await sleep(200);
const nAfter = (await page.evaluate(() => globalThis.__tbApp.session.scene.parts)).length;
report('Esc 取消放置，场景不变', !(await has('#placeBanner')) && !(await has('#pinRings')) && nAfter === nBefore, `${nBefore} → ${nAfter}`);
report('页面无报错', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[place] ${fails ? 'FAIL' : 'PASS'}（${fails} 项失败）`);
process.exit(fails ? 1 : 0);
