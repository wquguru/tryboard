// 网页冒烟测试：起静态服务器 → 本机 Chrome 打开示例 → 等串口出现期望文本 → 截图。
// 用法：node tools/webtest/webtest.mjs [示例id=blink] [期望文本=TRYBOARD_OK]
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const example = process.argv[2] || 'blink';
const expect = process.argv[3] || 'TRYBOARD_OK';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = path.join(dist, u === '/' ? 'index.html' : u);
  if (!f.startsWith(dist) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const t0 = Date.now();
await page.goto(`http://localhost:${port}/?example=${example}`, { waitUntil: 'load' });
let ok = false;
for (let i = 0; i < 120; i++) {
  const text = await page.$eval('#console', (e) => e.textContent);
  if (text.includes(expect)) { ok = true; break; }
  if (/停止：|启动失败/.test(text)) break;
  await new Promise((r) => setTimeout(r, 250));
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
// 环境滑块：把温度拖到 31.5°C，传感器读数要跟着变（验证 UI → worker → 模拟器件 → 固件 全链路）
if (ok && example === 'bme280' && (await page.$('.env input'))) {
  await page.$eval('.env input', (el) => {
    el.value = '31.5';
    el.dispatchEvent(new Event('input'));
  });
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await new Promise((r) => setTimeout(r, 250));
    seen = (await page.$eval('#console', (e) => e.textContent)).includes('T=31.50 C');
  }
  console.log(`[webtest] 环境滑块 → 读数 31.50°C: ${seen ? 'PASS' : 'FAIL'}`);
  ok = ok && seen;
}
// 旋钮：滑块拖到 2400mV，ADC 读数要跟着变（UI → worker → ADC → 固件）
if (ok && example === 'pot') {
  await page.$eval('.env input', (el) => {
    el.value = '2400';
    el.dispatchEvent(new Event('input'));
  });
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await new Promise((r) => setTimeout(r, 250));
    seen = /约 2[34]\d\d mV/.test(await page.$eval('#console', (e) => e.textContent));
  }
  console.log(`[webtest] 旋钮 → ADC 读数约 2400mV: ${seen ? 'PASS' : 'FAIL'}`);
  ok = ok && seen;
}
// 多拍几张，抓到 LED 亮和灭两种状态
for (let i = 0; i < 3; i++) {
  await page.screenshot({ path: path.join(outDir, `${example}-${i}.png`) });
  await new Promise((r) => setTimeout(r, 270));
}
const consoleText = await page.$eval('#console', (e) => e.textContent);
const ratio = await page.$eval('#ratio', (e) => e.textContent);
fs.writeFileSync(path.join(outDir, `${example}-console.txt`), consoleText);
await browser.close();
server.close();
console.log(`[webtest] ${example}: ${ok ? 'PASS' : 'FAIL'}（${secs}s，${ratio}）`);
if (errors.length) console.log('[webtest] 页面错误:\n  ' + errors.join('\n  '));
if (!ok) console.log(consoleText.slice(-1500));
process.exit(ok && !errors.length ? 0 : 1);
