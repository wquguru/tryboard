// 编辑器测试：blink 示例（台面已有 LED@5）→ 上传 bme280 固件 → 元件库放 BME280（SDA 6 / SCL 7）→ 应读到传感器
import puppeteer from 'puppeteer-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = root + '/web/dist';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(new URL(req.url, 'http://x').pathname); const f = path.join(dist, u === '/' ? 'index.html' : u); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, r));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.evaluateOnNewDocument(() => localStorage.clear());
await page.goto(`http://localhost:${server.address().port}/app.html?work=blank&example=blink#bench`, { waitUntil: 'load' });
await page.waitForFunction(() => !!globalThis.__tbApp?.hist, { timeout: 30000 });
await sleep(1000);
const input = await page.$('#fwPick');
await input.uploadFile(root + '/firmware/build/bme280/flash.bin');
await sleep(1500);
// 元件库「放」BME280，按引脚圈逐根接：VCC 3V3、GND、SCL GPIO7、SDA GPIO6
async function clickRing(id) {
  await page.waitForFunction((i) => { const e = document.querySelector(`#pinRings [data-ring="${i}"]`); return e && !e.hidden && e.getBoundingClientRect().width > 0; }, { timeout: 10000 }, id);
  const b = await page.$eval(`#pinRings [data-ring="${id}"]`, (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await page.mouse.click(b[0], b[1]);
}
await page.click('[data-left="lib"]');
await page.waitForSelector('#partLib [data-place="bme280"]');
await page.click('#partLib [data-place="bme280"]');
for (const ring of ['3V3', 'GND', 'GPIO7', 'GPIO6']) await clickRing(ring);
await page.waitForFunction(() => !document.querySelector('#placeBanner'), { timeout: 10000 });
let ok = false;
for (let i = 0; i < 40 && !ok; i++) { await sleep(250); ok = (await page.$eval('#console', (e) => e.textContent)).includes('TRYBOARD_OK bme280'); }
const parts = await page.evaluate(() => globalThis.__tbApp.session.scene.parts.map((p) => p.type));
ok = ok && parts.includes('bme280') && parts.includes('led');
await page.screenshot({ path: root + '/Reviews/web/editor.png' });
console.log('[edtest]', ok ? 'PASS' : 'FAIL', parts, errs);
await browser.close(); server.close();
