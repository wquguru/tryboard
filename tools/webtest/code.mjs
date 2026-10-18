// 底部坞「代码」页签回归（P2-15）：
//  1. weather 打开代码页签 → 显示 main.c，里面有 app_main；行号、高亮、切换文件；源码按需下载
//  2. 换成上传的 .bin → 显示「没有源码」和原因
//  3. 手机 390×844 底部坞也能切到代码页签，无横向滚动
// 用法：node tools/webtest/code.mjs [dist 目录，默认 web/dist]。截图在 Reviews/web/code-*
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
  const f = path.join(dist, u === '/' ? 'index.html' : u);
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
  console.log(`[code] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
async function open(url, vp) {
  const page = await browser.newPage();
  if (vp) await page.setViewport(vp);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(base + url, { waitUntil: 'load' });
  await waitFor(page, () => globalThis.__tbApp?.hist && globalThis.__tbApp.store.get().simSeconds > 0.3, null, 30000);
  return page;
}
const state = (page) => page.$eval('#codeView', (e) => [e.dataset.state, e.dataset.fw ?? '', e.textContent]).catch(() => ['', '', '']);

// 1. 桌面：weather 打开代码页签 → main.c 里有 app_main；切到头文件；行号从 1 起
{
  const page = await open('/app.html?work=weather&debug=1#bench');
  const lazyBefore = await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /src\.json/.test(r.name)));
  await page.click('[data-dock="code"]');
  const ok = await waitFor(page, () => document.querySelector('#codeView')?.dataset.state === 'ok');
  const [st, fw, text] = await state(page);
  const files = await page.$$eval('#codeView [data-file]', (es) => es.map((e) => e.dataset.file));
  report('weather 代码页签显示 app_main', ok && st === 'ok' && fw === 'weather' && /void app_main\(void\)/.test(text), `${st} ${fw} files=${files.join(',')}`);
  report('源码按需下载（打开页签前没取 src.json）', !lazyBefore);
  const hl = await page.$$eval('#codeBody span', (es) => new Set(es.map((e) => e.className)).size);
  const first = await page.$eval('#codeBody tr td', (e) => e.textContent);
  report('行号 + 高亮', first === '1' && hl >= 4, `首行号=${first} 记号类=${hl}`);
  const h = files.find((f) => f.endsWith('.h'));
  if (h) await page.click(`#codeView [data-file="${h}"]`);
  const sel = await page.$eval('#codeView [aria-selected="true"]', (e) => e.dataset.file).catch(() => '');
  report('切换文件', !!h && sel === h, sel);
  await page.screenshot({ path: path.join(outDir, 'code-weather.png') });
  // 2. 换成上传的 .bin：显示没有源码和原因
  await page.evaluate(async () => {
    const buf = await (await fetch('./fw/s3-blink/flash.bin')).arrayBuffer();
    await globalThis.__tbApp.session.loadFirmware(buf, 'mine.bin');
  });
  const none = await waitFor(page, () => document.querySelector('#codeView')?.dataset.state === 'none');
  const [, , t2] = await state(page);
  report('上传 .bin 后显示没有源码', none && /没有源码/.test(t2) && /mine\.bin/.test(t2), t2.slice(0, 60));
  await page.screenshot({ path: path.join(outDir, 'code-upload.png') });
  await page.close();
}
// 3. 手机：底部坞切到代码页签也能看（无横向滚动）
{
  const page = await open('/app.html?work=weather&debug=1#bench', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.click('#sheetPeek');
  await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'half');
  await page.click('#dock button[aria-label="全屏"]');
  const tab = await waitFor(page, () => !!document.querySelector('[data-dock="code"]'));
  if (tab) await page.click('[data-dock="code"]');
  const ok = await waitFor(page, () => document.querySelector('#codeView')?.dataset.state === 'ok');
  const [, fw, text] = await state(page);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  report('手机代码页签', ok && /app_main/.test(text) && wide <= 0, `fw=${fw} 横向溢出=${wide}`);
  await page.screenshot({ path: path.join(outDir, 'code-phone.png') });
  await page.close();
}
report('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[code] ${fails ? 'FAIL' : 'PASS'}（${fails} 项失败）`);
process.exit(fails ? 1 : 0);
