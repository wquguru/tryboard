// Editor test: blink example (LED@5 on the bench) -> upload bme280 firmware -> place BME280 from the library (SDA 6 / SCL 7) -> sensor reads
import puppeteer from 'puppeteer-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = root + '/web/dist';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(new URL(req.url, 'http://x').pathname); // Extensionless paths (/app, /select) map to .html, like Vite preview and static hosting (DESIGN_V2 §7.2)
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0; if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, r));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
// Beginner mode is on by default (H-01); these checks target the full bench
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.setItem('tb-beginner', '0'); });
await page.goto(`http://localhost:${server.address().port}/app?work=blank&example=blink#bench`, { waitUntil: 'load' });
await page.waitForFunction(() => !!globalThis.__tbApp?.hist, { timeout: 30000 });
await sleep(1000);
const input = await page.$('#fwPick');
await input.uploadFile(root + '/firmware/build/bme280/flash.bin');
await sleep(1500);
// Place BME280 from the library, wire it ring by ring: VCC 3V3, GND, SCL GPIO7, SDA GPIO6
async function clickRing(id) {
  await page.waitForFunction((i) => { const e = document.querySelector(`#pinRings [data-ring="${i}"]`); return e && !e.hidden && e.getBoundingClientRect().width > 0; }, { timeout: 10000 }, id);
  // Neighbouring rings (5V / GND) half overlap in the default view: aim at the visible, clickable part (as in wiremode.mjs)
  const b = await page.$eval(`#pinRings [data-ring="${id}"]`, (e) => {
    const r = e.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    for (const k of [0, 0.25, 0.4]) for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const x = cx + dx * k * r.width, y = cy + dy * k * r.height;
      if (document.elementFromPoint(x, y)?.closest('[data-ring]') === e) return [x, y];
    }
    return [cx, cy];
  });
  await page.mouse.click(b[0], b[1]);
}
await page.click('[data-left="lib"]');
await page.waitForSelector('#partLib [data-place="bme280"]');
await page.click('#partLib [data-place="bme280"]');
for (const ring of ['3V3', 'GND', 'GPIO7', 'GPIO6']) { try { await clickRing(ring); } catch (e) { console.log('DBG stuck at', ring, await page.evaluate(() => JSON.stringify({ banner: document.querySelector('#placeBanner')?.textContent, rings: [...document.querySelectorAll('#pinRings [data-ring]')].map((e) => e.dataset.ring + (e.hidden ? '(h)' : '') + Math.round(e.getBoundingClientRect().width)).join(' '), toast: document.querySelector('#toast')?.textContent, parts: globalThis.__tbApp.session.scene.parts.map((p) => p.type) }))); await page.screenshot({ path: root + '/Reviews/web/editor-stuck.png' }); throw e; } }
await page.waitForFunction(() => !document.querySelector('#placeBanner'), { timeout: 10000 });
let ok = false;
for (let i = 0; i < 40 && !ok; i++) { await sleep(250); ok = (await page.$eval('#console', (e) => e.textContent)).includes('TRYBOARD_OK bme280'); }
const parts = await page.evaluate(() => globalThis.__tbApp.session.scene.parts.map((p) => p.type));
ok = ok && parts.includes('bme280') && parts.includes('led');
await page.screenshot({ path: root + '/Reviews/web/editor.png' });
console.log('[edtest]', ok ? 'PASS' : 'FAIL', parts, errs);
await browser.close(); server.close();
