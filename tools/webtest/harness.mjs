// 线束（P2-11）与 USB 小键盘（P2-12）的网页验收：
//  1. 实验台：拉长 BME280 的线到 50 cm（总线 60 cm）→ 接线检查出 W6 警告，模拟器里固件读数跑偏（T 不再是 23.50）；150 cm → 阻断 + 器件不应答
//  2. 组装（检查点预置为已过）：排线拉到 60 cm → "超出规范"，复测不过；金属件贴着天线 → RSSI −87 dBm 连不上
//  3. USB 小键盘：首页 → 开始做 → 成品，点 3D 键帽 K1 和宏键 K4，虚拟电脑屏幕上出现 "aHello TryBoard"
// 用法：node tools/webtest/harness.mjs（先 tools/build_web.sh）。截图 Reviews/web/harness-*.png
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // 无后缀地址（/app、/select）映射到 .html，与 Vite 预览和静态托管一致（DESIGN_V2 §7.2）
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
let fails = 0, n = 0;
const report = (name, ok, extra = '') => {
  n++;
  console.log(`[harness] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}
async function open(url) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await page.goto(base + url, { waitUntil: 'load' });
  return page;
}
const lastT = () => {
  const m = [...(document.getElementById('console')?.textContent ?? '').matchAll(/T=(-?[\d.]+) C/g)].pop();
  return m ? Number(m[1]) : null;
};

// ---- 1. 实验台：线长
{
  const page = await open('/app?work=weather&debug=1#bench');
  await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console')?.textContent ?? '') && !!globalThis.__tbApp?.setWireLen, null, 40000);
  await page.evaluate(() => globalThis.__tbApp.setWireLen('bme280', 50));
  const w6 = await waitFor(page, () => globalThis.__tbApp.faults().some((f) => f.rule === 'W6'), null, 5000);
  const before = (await page.evaluate(() => document.getElementById('console').textContent.length)) ?? 0;
  const wrong = await waitFor(page, (n0) => {
    const tail = document.getElementById('console').textContent.slice(n0);
    const m = [...tail.matchAll(/T=(-?[\d.]+) C/g)].pop();
    return !!m && Number(m[1]) !== 23.5;
  }, before, 15000);
  const t = await page.evaluate(lastT);
  const short = await page.evaluate(() => globalThis.__tbApp.faults().find((f) => f.rule === 'W6')?.short);
  report('实验台：BME280 线拉到 50 cm → 接线检查 W6 警告，固件读数跑偏', w6 && wrong, `W6 ${short} · 读到 T=${t}`);
  // 选中那根线，看属性面板的线长与说明
  await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'wire', id: 'wire:GPIO8~bme280:SDA' } }));
  await sleep(600);
  const note = await page.$eval('#wireLenNote', (e) => e.textContent).catch(() => '');
  report('实验台：选中 SDA 线显示线长滑块与上升时间', /上升时间 \d+ ns/.test(note) && /超出规范/.test(note), note.slice(0, 60));
  await page.screenshot({ path: path.join(outDir, 'harness-bench.png') });
  await page.evaluate(() => globalThis.__tbApp.setWireLen('bme280', 140));
  const block = await waitFor(page, () => globalThis.__tbApp.faults().some((f) => f.rule === 'W6' && /上升/.test(f.short)), null, 5000);
  const nack = await waitFor(page, () => /unexpected nack|NACK/i.test(document.getElementById('console')?.textContent ?? '') || /不应答/.test(document.querySelector('#props')?.textContent ?? ''), null, 15000);
  report('实验台：150 cm → 器件不应答（NACK）', block && nack);
  await page.close();
}

// ---- 2. 组装：排线 + 天线
{
  const page = await open('/app?work=weather#bench');
  await page.evaluate(() => {
    const p = {};
    for (const id of ['01', '02', '03', '04', '05', '06']) p[id] = { fp: 'test', at: '预置' };
    localStorage.setItem('tryboard-app-checks:weather', JSON.stringify(p));
    localStorage.removeItem('tryboard-app-harness:weather');
  });
  await page.goto(`${base}/app?work=weather#assemble`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  const ready = await waitFor(page, () => !!document.querySelector('#hzWire'), null, 40000);
  await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console')?.textContent ?? ''), null, 30000);
  const set = (sel, v) => page.evaluate((a) => { const e = document.querySelector(a[0]); e.value = String(a[1]); e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); }, [sel, v]);
  await set('#hzWire', 60);
  await sleep(300);
  const txt = await page.$eval('#hzWireRes', (e) => e.textContent).catch(() => '');
  const before = await page.evaluate(() => document.getElementById('console').textContent.length);
  const wrong = await waitFor(page, (n0) => {
    const m = [...document.getElementById('console').textContent.slice(n0).matchAll(/T=(-?[\d.]+) C/g)].pop();
    return !!m && Number(m[1]) !== 23.5;
  }, before, 15000);
  const sim = await page.$eval('[data-k="hzSim"]', (e) => e.textContent).catch(() => '');
  report('组装：I2C 排线拉到 60 cm → "超出规范"、模拟器读数跑偏', ready && /超出规范/.test(txt) && wrong && /I2C 排线 60 cm/.test(sim), `${txt.slice(0, 40)} · ${sim.slice(0, 70)}`);
  await page.screenshot({ path: path.join(outDir, 'harness-asm-i2c.png') });
  await page.click('[data-obs="metal"]');
  await waitFor(page, () => !!document.querySelector('#hzDist'), null, 5000);
  await set('#hzDist', 0);
  await sleep(300);
  const ant = await page.$eval('#hzAntRes', (e) => e.textContent).catch(() => '');
  const sim2 = await waitFor(page, () => /天线遮挡 45 dB/.test(document.querySelector('[data-k="hzSim"]')?.textContent ?? ''), null, 5000);
  report('组装：金属件贴着天线 → 遮挡 45 dB，RSSI −87 dBm 连不上', /遮挡 45 dB/.test(ant) && /-87 dBm/.test(ant) && /连不上/.test(ant) && sim2, ant.slice(0, 60));
  await page.screenshot({ path: path.join(outDir, 'harness-asm-antenna.png') });
  await page.evaluate(() => localStorage.clear());
  await page.close();
}

// ---- 3. USB 小键盘：首页 → 成品，点键帽打字
{
  const page = await open('/');
  await waitFor(page, () => !!document.querySelector('.wk[data-work="usbkey"] [data-go]'), null, 10000);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('.wk[data-work="usbkey"] [data-go]')]);
  const shop = /work=usbkey/.test(page.url()) && page.url().endsWith('#shop');
  await page.evaluate(() => (location.hash = 'product'));
  const up = await waitFor(page, () => !!document.querySelector('.prod-stage canvas') && globalThis.__tbProduct?.usbState?.() === '已配置', null, 40000);
  report('USB 小键盘：首页「开始做」→ 成品页，虚拟电脑枚举成功', shop && up, page.url().replace(base, ''));
  const press = async (i) => {
    const p = await page.evaluate((k) => globalThis.__tbProduct.keyPos(k), i);
    await page.mouse.move(p[0], p[1]);
    await page.mouse.down();
    await sleep(150);
    await page.mouse.up();
    await sleep(150);
  };
  await press(0);
  await press(3);
  const typed = await waitFor(page, () => globalThis.__tbProduct.typed() === 'aHello TryBoard\n', null, 15000);
  await waitFor(page, () => document.querySelector('#props [data-live="typed"]')?.textContent === 'aHello TryBoard↵', null, 3000);
  const shown = await page.$eval('#props [data-live="typed"]', (e) => e.textContent).catch(() => '');
  report('USB 小键盘：点 K1、宏键 K4 → 电脑上打出 aHello TryBoard↵', typed && shown === 'aHello TryBoard↵', JSON.stringify(await page.evaluate(() => globalThis.__tbProduct.typed())));
  await sleep(800);
  await page.screenshot({ path: path.join(outDir, 'harness-usbkey.png') });
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[harness] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[harness] ${fails ? 'FAIL' : 'PASS'}（${n} 项，失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
