// 编辑器测试：上传 bme280 固件 → 加 BME280 + LED → 应重启并读到传感器
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
await page.goto(`http://localhost:${server.address().port}/?example=blink`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1500));
const input = await page.$('#upload');
await input.uploadFile(root + '/firmware/build/bme280/flash.bin');
await new Promise((r) => setTimeout(r, 1500));
await page.select('#editor select[name=kind]', 'bme280');
await page.click('#editor form button[type=submit]');
await page.select('#editor select[name=kind]', 'led');
await page.select('#editor select[name=pin]', '5');
await page.click('#editor form button[type=submit]');
let ok = false;
for (let i = 0; i < 40 && !ok; i++) { await new Promise((r) => setTimeout(r, 250)); ok = (await page.$eval('#console', (e) => e.textContent)).includes('TRYBOARD_OK bme280'); }
const parts = await page.$$eval('#editor .parts li span', (els) => els.map((e) => e.textContent));
await page.screenshot({ path: root + '/Reviews/web/editor.png' });
console.log('[edtest]', ok ? 'PASS' : 'FAIL', parts, errs);
await browser.close(); server.close();
