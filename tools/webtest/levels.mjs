// 关卡 / 装配 / 首页的网页验收：
//  1. 关卡页每关跑参考固件，必须"通过"，且运行指纹与 tools/check.py（原生内核）完全一致
//  2. 第 6 关用鼠标真实拖拽装配：装对通过；BME280 贴芯片则验收不过（读数偏高）
//  3. 上传自己的固件验收，进度记住
//  4. 首页实时跑 weather：串口读数、OLED 画面、按住 BOOT 切 ℉
//  5. 实验台 weather 示例的装配视图：点选装配 → 开机 → 成品屏幕有画面
// 用法：node tools/webtest/levels.mjs（先 tools/build_web.sh）。截图在 Reviews/web/levels-*.png
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
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
  console.log(`[levels] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function open(url) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await page.goto(base + url, { waitUntil: 'load' });
  return page;
}
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}
const resultText = (page) => page.$eval('.lv-result', (e) => e.textContent).catch(() => '');

// 原生内核的结论与指纹
const native = {};
const cli = (() => { try { return execFileSync(path.join(root, 'tools/check.py'), ['--ref', '--all'], { encoding: 'utf8' }); } catch (e) { return e.stdout; } })();
for (const m of cli.matchAll(/第 ([\w-]+) 关 .*?：(\S+)\s+指纹 (\S+)/g)) native[m[1]] = { ok: m[2] === '通过', fp: m[3] };

// ---- 1. 每关参考固件（第 6 关先装配）
const page = await open('/levels.html#01');
async function runRef(id) {
  await page.evaluate((id) => (location.hash = id), id);
  await page.waitForSelector('#runRef');
  await page.click('#runRef');
  await waitFor(page, () => /指纹/.test(document.querySelector('.lv-result')?.textContent ?? '') && !document.querySelector('#runRef')?.disabled, null, 60000);
  const t = await resultText(page);
  const raw = await page.evaluate(() => globalThis.__tbLastVerify);
  fs.writeFileSync(path.join(outDir, `levels-${id}-web.json`), JSON.stringify(raw, null, 1));
  return { ok: /：通过/.test(t), fp: (t.match(/运行指纹 (\S+)/) || [])[1], text: t };
}
// 鼠标拖拽：零件卡片 → 舞台上该层的位置（SVG 坐标换成屏幕坐标）
async function drag(part, sx, sy) {
  const from = await page.$eval(`[data-part="${part}"]`, (g) => { const r = g.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  const to = await page.$eval('#asm svg', (s, [x, y]) => { const p = new DOMPoint(x, y).matrixTransform(s.getScreenCTM()); return [p.x, p.y]; }, [sx, sy]);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8);
  await page.mouse.up();
  await sleep(50);
}
const iso = (L, x, y) => [505 + 0.866 * x - 0.866 * y, 292 - L * 30 + 0.5 * x + 0.5 * y];
async function assemble(spot) {
  const ORDER = ['shell', 'board', 'bme', 'servo', 'oled', 'front'];
  for (const [L, k] of ORDER.entries()) {
    const [x, y] = k === 'bme' ? (spot === 'A' ? iso(2, 146, 55) : iso(2, 92, 43)) : iso(L, 90, 50);
    await drag(k, x, y);
  }
  return page.$eval('#asm', (e) => e.textContent.includes('6/6'));
}

for (const id of ['01', '02', '03', '04', '05', '06']) {
  if (id === '06') {
    await page.evaluate(() => (location.hash = '06'));
    await page.waitForSelector('#asm [data-part="shell"]');
    await page.$eval('#asm', (e) => e.scrollIntoView({ block: 'center' }));
    await sleep(100);
    // 先故意装错顺序：前面板不能先装
    await drag('front', ...iso(0, 90, 50));
    const blocked = await page.$eval('#asm', (e) => e.textContent.includes('还不能装「前面板」'));
    report('装配：顺序错被拦下', blocked);
    const done = await assemble('B');
    report('装配：鼠标拖拽 6/6（传感器贴芯片）', done);
    const bad = await runRef('06');
    report('第 06 关：传感器贴芯片 → 不通过', !bad.ok && /有警告/.test(bad.text) && /温度.*偏差 2\.5/.test(bad.text), bad.text.match(/温度[^✓✗]*/)?.[0]);
    await page.screenshot({ path: path.join(outDir, 'levels-06-bad.png'), fullPage: true });
    await page.click('#asm [data-k="reset"]');
    await page.$eval('#asm', (e) => e.scrollIntoView({ block: 'center' }));
    report('装配：鼠标拖拽 6/6（通风口旁）', await assemble('A'));
    await page.click('#asm [data-k="power"]');
    const lit = await waitFor(page, () => !!document.querySelector('#asm [data-k="product"]:not([hidden]) image[href]'));
    report('装配：开机后成品屏幕有画面', lit);
    await page.screenshot({ path: path.join(outDir, 'levels-06-product.png'), fullPage: true });
  }
  const r = await runRef(id);
  const n = native[id];
  report(`第 ${id} 关参考固件`, r.ok && n?.ok && r.fp === n.fp, `网页 ${r.ok ? '通过' : '未通过'} ${r.fp} / 命令行 ${n?.fp}`);
  if (!r.ok) console.log(r.text);
  if (id === '01') await page.screenshot({ path: path.join(outDir, 'levels-01.png'), fullPage: true });
}

// spin 装配：舵盘直接按上（错一个齿）→ 开机后成品上提示偏角，圆屏有画面
await page.evaluate(() => (location.hash = '07-spin'));
await page.waitForSelector('#asm [data-template="spin"]');
await page.$eval('#asm', (e) => e.scrollIntoView({ block: 'center' }));
await page.click('#asm [data-part="base"]');
await page.click('#asm [data-part="servo"]');
await page.click('#asm [data-k="pickX"]');
for (const k of ['board', 'lcd', 'body', 'hair']) await page.click(`#asm [data-part="${k}"]`);
await page.click('#asm [data-k="power"]');
const spinOk = await waitFor(page, () => !!document.querySelector('#asm [data-k="product"]:not([hidden]) image[href]') && /装偏 14\.4°/.test(document.querySelector('#asm [data-k="note"]')?.textContent ?? ''), null, 20000);
report('第 07 关 · spin 装配：舵盘装偏 → 成品提示偏 14.4°，圆屏有画面', spinOk);
await sleep(600);
await page.screenshot({ path: path.join(outDir, 'levels-07-spin.png'), fullPage: true });
{
  const r = await runRef('07-spin');
  report('第 07 关 · spin：舵盘装偏 → 验收不通过（有装配警告）', !r.ok && /有警告/.test(r.text) && r.fp === native['07-spin']?.fp, r.fp);
  await page.$eval('#asm', (e) => e.scrollIntoView({ block: 'center' }));
  await page.click('#asm [data-k="reopen"]');
  await page.click('#asm [data-k="reset"]');
  await page.click('#asm [data-part="base"]');
  await page.click('#asm [data-part="servo"]');
  await page.click('#asm [data-k="pickC"]');
  for (const k of ['board', 'lcd', 'body', 'hair']) await page.click(`#asm [data-part="${k}"]`);
}
await page.evaluate(() => (location.hash = '07-lens'));
await page.waitForSelector('#asm [data-template="lens"]');
await page.$eval('#asm', (e) => e.scrollIntoView({ block: 'center' }));
for (const k of ['base', 'board', 'lcd', 'bezel', 'dome']) await page.click(`#asm [data-part="${k}"]`);
await page.click('#asm [data-k="pickH"]');
await page.click('#asm [data-k="power"]');
const lensOk = await waitFor(page, () => !!document.querySelector('#asm [data-k="product"]:not([hidden]) image[href]'), null, 20000);
report('第 07 关 · lens 装配 → 开机后圆屏有画面', lensOk);
await sleep(600);
await page.$eval('#asm', (e) => e.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: path.join(outDir, 'levels-07-lens.png') });
for (const v of ['lens', 'spin']) {
  const r = await runRef(`07-${v}`);
  const n = native[`07-${v}`];
  report(`第 07 关 · ${v} 参考固件`, r.ok && n?.ok && r.fp === n.fp, `网页 ${r.ok ? '通过' : '未通过'} ${r.fp} / 命令行 ${n?.fp}`);
  if (!r.ok) console.log(r.text);
}


// ---- 3. 上传自己的固件（C3 版点灯也满足第 1 关的条件）
await page.evaluate(() => (location.hash = '01'));
await page.waitForSelector('#upload');
const input = await page.$('#upload');
await input.uploadFile(path.join(root, 'firmware/build/blink/flash.bin'));
await waitFor(page, () => /flash\.bin：.*指纹/.test(document.querySelector('.lv-result')?.textContent ?? ''), null, 60000);
const own = await resultText(page);
const passedChip = await page.$eval('.lv-tab[data-id="01"] .chip', (e) => e.textContent);
report('上传自己的固件 → 通过并记进度', /：通过/.test(own) && passedChip === '已通过', passedChip + ' ' + own);
await page.close();

// ---- 4. 首页
const home = await open('/home.html');
const reading = await waitFor(home, () => /T=23\.50 C/.test(document.getElementById('benchLine').textContent), null, 30000);
const oled = await waitFor(home, () => !!document.querySelector('#bench image[href]'));
report('首页：实验桌跑真实固件（串口 T=23.50、OLED 有画面）', reading && oled);
await home.screenshot({ path: path.join(outDir, 'levels-home-0.png') });
// 按住 BOOT → 固件切 ℉，屏幕重画（OLED 图像变化）
const before = await home.$eval('#bench image', (e) => e.getAttribute('href'));
const b = await home.$eval('#bench [data-k="boot"]', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
await home.mouse.move(b[0], b[1]);
await home.mouse.down();
await sleep(250);
await home.mouse.up();
const changed = await waitFor(home, (h) => document.querySelector('#bench image').getAttribute('href') !== h, before, 5000);
report('首页：按 BOOT 后屏幕重画（切 ℉）', changed);
await home.click('[data-run="spin"]');
const homeSpin = await waitFor(home, () => !!document.querySelector('[data-show="spin"] image[href]'), null, 20000);
report('首页：小黄卡片「跑真实固件」→ 圆屏有画面', homeSpin);
await sleep(800);
await home.$eval('[data-show="spin"]', (e) => e.scrollIntoView({ block: 'center' }));
await home.screenshot({ path: path.join(outDir, 'levels-home-spin.png') });
await home.screenshot({ path: path.join(outDir, 'levels-home-full.png'), fullPage: true });
await home.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await sleep(300);
const overflow = await home.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
report('首页：手机宽度无横向滚动', !overflow);
await home.screenshot({ path: path.join(outDir, 'levels-home-phone.png') });
await home.close();

// ---- 5. 实验台 weather 示例的装配视图（键盘 / 点选方式装配）
const lab = await open('/index.html?example=weather');
await lab.waitForSelector('#viewTabs:not([hidden])', { timeout: 20000 });
await lab.click('#viewTabs [data-v="asm"]');
for (const k of ['shell', 'board', 'bme']) await lab.click(`#asmBox [data-part="${k}"]`);
await lab.click('#asmBox [data-k="pickA"]');
for (const k of ['servo', 'oled', 'front']) await lab.click(`#asmBox [data-part="${k}"]`);
await lab.click('#asmBox [data-k="power"]');
const labLit = await waitFor(lab, () => !!document.querySelector('#asmBox [data-k="product"]:not([hidden]) image[href]'), null, 20000);
const logged = await lab.$eval('#console', (e) => e.textContent.includes('装配：开机'));
report('实验台：点选装配 → 开机 → 成品有画面，操作记进串口', labLit && logged);
await sleep(800);
await lab.screenshot({ path: path.join(outDir, 'levels-lab-product.png') });
await lab.close();

await browser.close();
server.close();
if (errors.length) console.log('[levels] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[levels] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
