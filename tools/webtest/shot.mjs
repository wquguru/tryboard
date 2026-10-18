// 截图：node tools/webtest/shot.mjs <页面路径含参数> <输出 png> [宽] [高] [fullPage=1]
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const [page0, out, w = '1440', h = '900', full = '1'] = process.argv.slice(2);
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
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${server.address().port}/${page0}`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, fullPage: full === '1' });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log(`[shot] ${out}${overflow ? '（有横向滚动！）' : ''}${errors.length ? '\n页面错误: ' + errors.join('\n') : ''}`);
await browser.close(); server.close();
