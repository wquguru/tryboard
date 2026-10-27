// H-38: a file chosen while the props panel re-renders (dialog open) must still start the check, with no retry.
// Usage: node tools/webtest/upload.mjs (after tools/build_web.sh); screenshot in Reviews/web/upload-remount.png
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
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = (!path.extname(f0) || !fs.existsSync(f0)) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
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
  console.log(`[upload] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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

// Take the input as the dialog would hold it, force a props remount, then hand the file to that same handle
{
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
  page.on('pageerror', (e) => errors.push(`${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/app?work=weather&cp=01#bench', { waitUntil: 'load' });
  const sel = '#props [data-drop="check"]';
  await page.waitForSelector(`${sel} input:not([disabled])`, { timeout: 30000 });
  // Let post-load renders settle so the remount below is the one this test causes
  await sleep(1500);
  const input = await page.$(`${sel} input:not([disabled])`);
  await page.$eval(sel, (e) => (e.dataset.h38 = '1'));
  await page.$eval('#tree .tn[data-kind="checkpoint"][data-id="01"]', (e) => e.click());
  const remounted = await waitFor(page, (s) => !!document.querySelector(s) && !document.querySelector(`${s}[data-h38]`), sel, 10000);
  report('props panel remounted the drop box after the input was taken', remounted);
  const err = await input.uploadFile(path.join(root, 'firmware/build/blink/flash.bin')).then(() => '', (e) => String(e).slice(0, 120));
  const busy = await waitFor(page, (s) => !!document.querySelector(`${s}.busy, #props .verdict-line`), sel, 5000);
  report('file given to the pre-remount input -> check starts (busy)', busy, err);
  const ok = busy && (await waitFor(page, () => document.querySelector('#props .result-card')?.dataset.verdict === 'ok', null, 90000));
  const who = await page.$eval('#props .verdict-line', (e) => e.textContent.trim()).catch(() => '');
  report('... and reaches verdict ok for flash.bin', ok && /flash\.bin/.test(who), who);
  await page.screenshot({ path: path.join(outDir, 'upload-remount.png') });
  await page.evaluate(() => localStorage.clear());
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[upload] page errors:\n  ' + errors.join('\n  '));
console.log(`[upload] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
