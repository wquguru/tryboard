// 3D 装配（P1-07）与参数化外壳导出（P1-08）的网页验收：
//  1. 工作台 weather 组装步骤是 3D 视图（three.js + 参数化外壳），顺序错被拦下
//  2. 真实鼠标拖拽（mouse down / move / up）把零件拖到发亮槽位：BME280 拖到芯片旁 → 开机复测 ✗（温漂 +2.5 ℃）；
//     退回去拖到通风口旁 → 复测 ✓；装配状态与 store.assembly 结构一致（成品步骤能用）
//  3. 炸开、剖面、尺子（BME280 到芯片距离）
//  4. 采购页外壳详情：改高度出"太矮"警告；导出 STL / 3MF，文件大小与读回（three.js STLLoader / 3MFLoader）一致
//  5. ?asm=svg 兜底：SVG 视图还能装
// 检查点进度用 localStorage 预置（与"自己的固件通过"同一份存储；验收本身在 levels.mjs 里测）。
// 用法：node tools/webtest/asm3d.mjs（先 tools/build_web.sh）。截图在 Reviews/web/asm3d-*.png
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
const dlDir = path.join(outDir, 'asm3d-dl');
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(dist, u === '/' ? 'index.html' : u);
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
  console.log(`[asm3d] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `asm3d-${name}.png`) });

const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
await page.goto(`${base}/app.html?work=weather#bench`, { waitUntil: 'load' });
await page.evaluate(() => {
  const p = {};
  for (const id of ['01', '02', '03', '04', '05', '06']) p[id] = { fp: 'test', at: '预置' };
  localStorage.setItem('tryboard-app-checks:weather', JSON.stringify(p));
  localStorage.removeItem('tryboard-app-asm:weather');
  localStorage.removeItem('tryboard-app-case:weather');
});
await page.goto(`${base}/app.html?work=weather#assemble`, { waitUntil: 'load' });
await page.reload({ waitUntil: 'load' });
const ready = await waitFor(page, () => !!globalThis.__tbAsm3d && !!document.querySelector('.asm3d-stage canvas'), null, 40000);
report('组装步骤是 3D 视图（参数化外壳 + three.js）', ready);
await sleep(1500);
await shot(page, 'start');

const msg = () => page.$eval('#props .asm-msg', (e) => e.textContent).catch(() => '');
async function drag(id, key) {
  // 零件飞回托盘有个过渡：等它停稳再按下去（人也是看准了再抓）
  let from = null;
  for (let i = 0; i < 30; i++) {
    const p = await page.evaluate((x) => globalThis.__tbAsm3d.partScreen(x), id);
    if (p && from && Math.hypot(p[0] - from[0], p[1] - from[1]) < 0.5) break;
    from = p;
    await sleep(100);
  }
  const to = await page.evaluate(([i, k]) => globalThis.__tbAsm3d.slotScreen(i, k), [id, key]);
  if (!from || !to) return false;
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let s = 1; s <= 14; s++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * s) / 14, from[1] + ((to[1] - from[1]) * s) / 14);
    await sleep(16);
  }
  await sleep(120);
  await page.mouse.up();
  await sleep(250);
  return true;
}
const asmState = () => page.evaluate(() => globalThis.__tbApp.store.get().assembly);
const tool = (id) => page.click(`#toolbar button[data-tool="${id}"]`);

// 顺序错：先拖前面板
await drag('front');
report('顺序错被拦下（先拖前面板）', /还不能装「前面板」/.test(await msg()), (await msg()).trim());

async function assemble(bmeKey, from = 0) {
  const order = ['shell', 'board', 'bme', 'servo', 'oled', 'front'];
  for (const id of order.slice(from)) {
    await drag(id, id === 'bme' ? bmeKey : undefined);
    if (id === 'bme') await shot(page, `bme-${bmeKey}`);
  }
  return asmState();
}
let a = await assemble('B');
report('真实鼠标拖拽 6/6（BME280 拖到芯片旁）', a?.placed.length === 6 && a.choice.bme === 'B' && a.effects.sensorOffset === 2.5, JSON.stringify(a && { n: a.placed.length, choice: a.choice, fx: a.effects }));
await sleep(500);
await shot(page, 'done-B');

async function retest() {
  await tool('asm-retest');
  await waitFor(page, () => /复测 [✓✗]/.test(document.getElementById('verdict').textContent), null, 120000);
  return page.$eval('#verdict', (e) => e.textContent);
}
let v = await retest();
const rows = await page.$eval('#props', (e) => e.textContent);
report('开机复测 ✗（传感器贴芯片，读数偏高）', /复测 ✗/.test(v) && /25\.0 ℃|26\.0 ℃|偏/.test(rows), `${v} · ${(rows.match(/传感器读到 [\d.]+ ℃/) ?? [''])[0]}`);
await shot(page, 'retest-bad');

// 退回到装好开发板那一步（退一步 ×5：复测、前面板、OLED、舵机、BME280），再把 BME280 拖到通风口旁
for (let i = 0; i < 5; i++) await tool('asm-undo');
a = await asmState();
report('退一步 ×5 回到开发板装好', a?.placed.length === 2, JSON.stringify(a?.placed));
a = await assemble('A', 2);
report('拖到通风口旁装完', a?.placed.length === 6 && a.choice.bme === 'A' && a.effects.sensorOffset === 0 && a.clean, JSON.stringify(a && a.choice));
v = await retest();
report('开机复测 ✓', /复测 ✓/.test(v), v);
await shot(page, 'retest-ok');

// 工具：炸开、剖面、尺子
await tool('asm-explode');
await sleep(900);
await shot(page, 'explode');
report('炸开', await page.evaluate(() => globalThis.__tbAsm3d.exploded()));
await tool('asm-explode');
await tool('asm-section');
await sleep(600);
await shot(page, 'section');
report('剖面', await page.evaluate(() => globalThis.__tbAsm3d.section()));
await tool('asm-ruler');
await sleep(600);
const rt = await page.evaluate(() => globalThis.__tbAsm3d.rulerText());
report('尺子：BME280 到芯片距离', rt.some((t) => /到芯片 ≈ \d+ mm/.test(t)), rt.join(' | '));
await shot(page, 'ruler');
await tool('asm-ruler');
await tool('asm-section');

// 成品步骤用的是这份装配
await page.click('#next');
const prod = await waitFor(page, () => location.hash === '#product' && !document.querySelector('.prod-preview:not([hidden])'), null, 10000);
report('装完 → 成品步骤（不是参考成品）', prod);

// 采购页外壳详情：高度 28 → 太矮；导出
await page.evaluate(() => {
  globalThis.__tbApp.store.set({ selection: { kind: 'part', id: 'enclosure-weather' } });
  location.hash = 'shop';
});
await waitFor(page, () => !!document.querySelector('#props [data-cpn="height"]'), null, 10000);
await page.$eval('#props [data-cpn="height"]', (i) => {
  i.value = '28';
  i.dispatchEvent(new Event('change'));
});
await sleep(300);
const warnTxt = await page.$eval('#props', (e) => e.textContent);
report('高度改成 28 mm → 太矮装不下舵机', /太矮/.test(warnTxt) && /最低高度31 mm|最低高度\s*31 mm/.test(warnTxt.replace(/\s+/g, ' ')), (warnTxt.match(/太矮[^）]*）/) ?? [''])[0]);
await shot(page, 'shop-low');
await page.$eval('#props [data-cpn="height"]', (i) => {
  i.value = '34';
  i.dispatchEvent(new Event('change'));
});
await sleep(300);
for (const fmt of ['stl', '3mf']) {
  await page.evaluate(() => (globalThis.__tbCase = null));
  await page.click(`#props [data-export="${fmt}"]`);
  await waitFor(page, () => !!globalThis.__tbCase, null, 30000);
  const r = await page.evaluate(() => globalThis.__tbCase);
  const file = path.join(dlDir, r?.name ?? 'x');
  await waitFor(page, () => true, null, 100);
  for (let i = 0; i < 30 && !fs.existsSync(file); i++) await sleep(200);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  report(`导出 ${fmt.toUpperCase()}：下载 ${size} 字节，读回校验`, !!r && r.check.ok && size === r.bytes && /h34/.test(r.name), r ? `${r.name} ${r.check.text}` : '没有结果');
}
await shot(page, 'shop-export');

// 回到组装：外壳按新高度（34 mm）重建，装配按时间线重放进去
await page.evaluate(() => (location.hash = 'assemble'));
const rebuilt = await waitFor(page, () => /34 mm/.test(document.querySelector('.a3-disc')?.textContent ?? '') && globalThis.__tbApp.store.get().assembly?.placed.length === 6, null, 30000);
report('改了高度回到组装：外壳重建、装配重放 6/6', rebuilt);
await sleep(800);
await shot(page, 'rebuilt');

// SVG 兜底
const p2 = await browser.newPage();
p2.on('pageerror', (e) => errors.push(`svg: ${e}`));
await p2.goto(`${base}/app.html?work=weather&asm=svg#assemble`, { waitUntil: 'load' });
const svgOk = await waitFor(p2, () => !!document.querySelector('.asm-shell svg [data-part="shell"]'), null, 30000);
await p2.click('.asm-shell [data-part="shell"]');
await sleep(200);
const s2 = await p2.evaluate(() => globalThis.__tbApp.store.get().assembly?.placed ?? []);
report('?asm=svg 兜底：SVG 视图能装', svgOk && s2.length >= 1, JSON.stringify(s2));
await p2.close();

await page.evaluate(() => localStorage.clear());
await browser.close();
server.close();
if (errors.length) console.log('[asm3d] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[asm3d] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
