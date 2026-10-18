// 实验台改接线回归（U-04）：app.html?work=weather&debug=1#bench
//  1. 接线表点 bme280:VIN → W 进改接：横幅、引脚圈出现；真实鼠标悬停引脚圈有提示
//  2. 真实鼠标点 5V 圈 → 接错线卡片（BME280 只吃 3.3 V），引脚圈收起，接线表写「原 3V3」
//  3. 卡片三个按钮：撤销（回到 3V3）/ 改接到别的针（回到改接模式）/ 保留；Esc 退出改接
//  4. ⌘Z / ⇧⌘Z 撤销重做这次改接；改回原针 → 接线检查无问题
//  5. 改接不重新上电：模拟器的指纹和改接前跑出来的一样往前走（串口照常、无报错）
// 用法：node tools/webtest/wiremode.mjs [dist 目录，默认 web/dist]。截图在 Reviews/web/wiremode-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  console.log(`[wiremode] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.evaluateOnNewDocument(() => localStorage.clear());
await page.goto(base + '/app?work=weather&debug=1#bench', { waitUntil: 'load' });
await waitFor(page, () => globalThis.__tbApp?.hist && globalThis.__tbApp.store.get().simSeconds > 0.5, null, 30000);

const W = 'wire:3V3~bme280:VIN';
const row = () => page.$eval(`#wireTable [data-wire="${W}"]`, (e) => e.textContent);
const has = (sel) => page.$(sel).then(Boolean);
const toast = () => page.$eval('#toast', (e) => e.textContent).catch(() => '');
/** 真实鼠标点引脚圈：圈跟着相机投影走，相机还在动（进改接时对焦、布局变化后重算投影）时取到的是旧位置，
 *  5V 和 GND 相邻，点偏一格就接到别的脚上；所以等位置连续两次读数不变再点 */
async function clickRing(id, hoverOnly = false) {
  const at = () =>
    page.$eval(`#pinRings [data-ring="${id}"]`, (e) => {
      const r = e.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
  let b = await at();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const c = await at();
    const still = Math.abs(c[0] - b[0]) < 0.5 && Math.abs(c[1] - b[1]) < 0.5;
    b = c;
    if (still) break;
  }
  // 相邻脚（5V / GND）的圈在某些视角下会叠一半：像人一样瞄圈里露出来、确实点得到它的那块，而不是死点圆心
  b = await page.$eval(
    `#pinRings [data-ring="${id}"]`,
    (e, c) => {
      const r = e.getBoundingClientRect();
      for (const k of [0, 0.25, 0.4])
        for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          const x = c[0] + dx * k * r.width, y = c[1] + dy * k * r.height;
          if (document.elementFromPoint(x, y)?.closest('[data-ring]') === e) return [x, y];
        }
      return c;
    },
    b,
  );
  await page.mouse.move(b[0], b[1]);
  if (!hoverOnly) await page.mouse.click(b[0], b[1]);
}
async function enterWire() {
  await page.click(`#wireTable [data-wire="${W}"]`);
  await page.keyboard.press('w');
  return waitFor(page, () => document.querySelectorAll('#pinRings [data-ring]').length > 10);
}

await page.click('[data-left="wires"]');
report('接线表这根线是 3V3', (await row()).includes('3V3') && !(await row()).includes('原'));
const sim0 = await page.evaluate(() => globalThis.__tbApp.store.get().simSeconds);

// ---- 1. 改接模式
report('W 进改接：横幅 + 引脚圈', (await enterWire()) && (await has('#wireBanner')));
const banner = await page.$eval('#wireBanner', (e) => e.textContent);
report('横幅写明改哪根线', banner.includes('bme280:VIN') && banner.includes('3V3'), banner);
await clickRing('GPIO4', true);
const tip = await waitFor(page, () => document.querySelector('#pinRings [role=tooltip]')?.textContent.includes('GPIO4'));
report('悬停引脚圈有提示（占用 / 空闲）', tip && (await page.$eval('#pinRings [role=tooltip]', (e) => /占用|空闲/.test(e.textContent))));
await page.screenshot({ path: path.join(outDir, 'wiremode-rings.png') });

// ---- 2. 接到 5V → 接错线
await clickRing('5V');
const ww = await waitFor(page, () => !!document.querySelector('#wrongWire'));
report('接到 5V → 接错线卡片', ww, ww ? await page.$eval('#wrongWire', (e) => e.textContent.slice(0, 80)) : '');
report('引脚圈收起', !(await has('#pinRings')) && !(await has('#wireBanner')));
report('接线表写「原 3V3」', (await row()).includes('5V') && (await row()).includes('原 3V3'), await row());
await page.screenshot({ path: path.join(outDir, 'wiremode-wrong.png') });

// ---- 3. 卡片按钮
await page.click('#wrongWire [data-ww="undo"]');
await waitFor(page, () => !document.querySelector('#wrongWire'));
report('撤销这次改接 → 回到 3V3', !(await has('#wrongWire')) && !(await row()).includes('原'), await row());

await enterWire();
await clickRing('5V');
await waitFor(page, () => !!document.querySelector('#wrongWire'));
await page.click('#wrongWire [data-ww="retry"]');
const back = await waitFor(page, () => !document.querySelector('#wrongWire') && !!document.querySelector('#pinRings [data-ring]'));
report('改接到别的针 → 撤销并回到改接模式', back && !(await row()).includes('原'));
await page.keyboard.press('Escape');
await waitFor(page, () => !document.querySelector('#wireBanner'));
report('Esc 退出改接', !(await has('#wireBanner')) && !(await has('#pinRings')));

await enterWire();
await clickRing('5V');
await waitFor(page, () => !!document.querySelector('#wrongWire'));
await page.click('#wrongWire [data-ww="keep"]');
await waitFor(page, () => !document.querySelector('#wrongWire'));
report('我知道，保留 → 卡片关、改接留着', !(await has('#wrongWire')) && (await row()).includes('原 3V3'));
const issues = await page.evaluate(() => globalThis.__tbApp.faults().length);
report('接线检查记一条问题', issues > 0, `faults=${issues}`);

// ---- 4. 撤销 / 重做
await page.keyboard.press('Escape');
await page.keyboard.down('Meta');
await page.keyboard.press('z');
await page.keyboard.up('Meta');
await waitFor(page, () => !document.querySelector('#wireTable [data-wire="wire:3V3~bme280:VIN"]')?.textContent.includes('原'));
report('⌘Z 撤销改接', !(await row()).includes('原'), await row());
await page.keyboard.down('Meta');
await page.keyboard.down('Shift');
await page.keyboard.press('z');
await page.keyboard.up('Shift');
await page.keyboard.up('Meta');
await waitFor(page, () => !!document.querySelector('#wireTable [data-wire="wire:3V3~bme280:VIN"]')?.textContent.includes('原'));
report('⇧⌘Z 重做改接', (await row()).includes('原 3V3'), await row());

await enterWire();
await clickRing('3V3');
await waitFor(page, () => !document.querySelector('#pinRings'));
await sleep(200);
const t = await toast();
report('改回原针 → 无问题', !(await row()).includes('原') && (await page.evaluate(() => globalThis.__tbApp.faults().length)) === 0 && t.includes('改回'), t);

// ---- 5. 模拟器照常跑
const sim1 = await page.evaluate(() => globalThis.__tbApp.store.get().simSeconds);
report('改接不打断模拟（时间往前走）', sim1 > sim0, `${sim0.toFixed(2)} → ${sim1.toFixed(2)} s`);
report('页面无报错', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[wiremode] ${fails ? 'FAIL' : 'PASS'}（${fails} 项失败）`);
process.exit(fails ? 1 : 0);
