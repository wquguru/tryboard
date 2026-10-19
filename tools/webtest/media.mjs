// Photo / 10 s recording (P2-10): PNG is 2x the canvas CSS size, webm video track = canvas pixels, Opus track with sound on.
// Usage: node tools/webtest/media.mjs (after tools/build_web.sh); downloads in Reviews/web/media-dl/
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
const dlDir = path.join(outDir, 'media-dl');
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Extensionless paths (/app, /select) map to .html, like Vite preview and static hosting (DESIGN_V2 §7.2)
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
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, n = 0;
const report = (name, ok, extra = '') => {
  n++;
  console.log(`[media] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
/** Wait for a new file with this extension (Chrome writes .crdownload first, then renames) */
async function newFile(ext, before, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = fs.readdirSync(dlDir).find((x) => x.endsWith(ext) && !before.has(x));
    if (f) {
      await sleep(300);
      return path.join(dlDir, f);
    }
    await sleep(200);
  }
  return null;
}
const pngSize = (b) => (b.length > 24 && b.readUInt32BE(12) === 0x49484452 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);
/** webm: EBML header + video track PixelWidth(0xB0) / PixelHeight(0xBA) (unsigned int elements) */
function webmInfo(b) {
  const ebml = b.readUInt32BE(0) === 0x1a45dfa3;
  const uint = (id) => {
    for (let i = 0; i < b.length - 3; i++) {
      if (b[i] !== id) continue;
      const sz = b[i + 1];
      if (sz < 0x81 || sz > 0x84) continue;
      const len = sz - 0x80;
      let v = 0;
      for (let k = 0; k < len; k++) v = v * 256 + b[i + 2 + k];
      if (v > 16 && v < 10000) return v;
    }
    return null;
  };
  return { ebml, w: uint(0xb0), h: uint(0xba), opus: b.includes(Buffer.from('A_OPUS')), vp: b.includes(Buffer.from('V_VP8')) || b.includes(Buffer.from('V_VP9')) };
}

async function open(url) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  await page.goto(base + url, { waitUntil: 'load' });
  return page;
}
const tool = (page, id) => page.click(`button[data-tool="${id}"]`);

async function photo(page, label, canvasSel) {
  const before = new Set(fs.readdirSync(dlDir));
  await tool(page, label === 'Bench' ? 'photo' : 'p-photo');
  const f = await newFile('.png', before);
  const b = f ? fs.readFileSync(f) : Buffer.alloc(0);
  const sz = pngSize(b);
  const css = await page.$eval(canvasSel, (c) => [Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)]);
  const meta = await page.evaluate(() => globalThis.__tbCapture?.photo);
  const want = css.map((v) => v * 2);
  report(`${label}: photo downloads PNG ${want.join('×')} (canvas ${css.join('×')} × 2)`, !!f && b.length > 20_000 && !!sz && Math.abs(sz[0] - want[0]) <= 1 && Math.abs(sz[1] - want[1]) <= 1 && meta?.width === sz[0] && meta?.bytes === b.length, `${f ? path.basename(f) : 'no file'} ${b.length} B ${sz?.join('×')} render ${meta?.renderW}×${meta?.renderH}`);
  return f;
}

async function record(page, label, canvasSel, withSound) {
  const before = new Set(fs.readdirSync(dlDir));
  const t0 = Date.now();
  await tool(page, label === 'Bench' ? 'rec' : 'p-rec');
  const f = await newFile('.webm', before, 25000);
  const secs = (Date.now() - t0) / 1000;
  const b = f ? fs.readFileSync(f) : Buffer.alloc(0);
  const info = b.length ? webmInfo(b) : {};
  const px = await page.$eval(canvasSel, (c) => [c.width, c.height]);
  const meta = await page.evaluate(() => globalThis.__tbCapture?.video);
  report(
    `${label}: 10 s recording downloads webm (${px.join('×')}${withSound ? ', with sound' : ''})`,
    !!f && b.length > 50_000 && info.ebml && info.vp && info.w === px[0] && info.h === px[1] && secs > 9.5 && secs < 20 && meta?.seconds > 9.5 && meta?.seconds < 11 && meta?.bytes === b.length && (!withSound || (info.opus && meta?.audio)),
    `${f ? path.basename(f) : 'no file'} ${b.length} B ${info.w}×${info.h} vp=${info.vp} opus=${info.opus} recorded ${meta?.seconds?.toFixed(2)} s`,
  );
}

// ---- 1. Weather product: photo + 10 s recording with sound
{
  const page = await open('/app?work=weather#product');
  const ok = await waitFor(page, () => !!document.querySelector('.prod-stage canvas') && /T=/.test(document.querySelector('#props')?.textContent ?? ''), null, 40000);
  report('weather Product page opens (3D + serial reading)', ok);
  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, 'media-product.png') });
  await photo(page, 'Product (weather)', '.prod-stage canvas');
  // Sound on (user gesture: click the button), then record
  await page.click('#pSound');
  await waitFor(page, () => globalThis.__tbAudio && !globalThis.__tbAudio.muted, null, 5000);
  await record(page, 'Product (weather)', '.prod-stage canvas', true);
  await page.close();
}

// ---- 2. Bench: photo + 10 s recording (sound off: video track only)
{
  const page = await open('/app?work=weather#bench');
  const ok = await waitFor(page, () => !!document.querySelector('.stage canvas, #stage canvas, canvas') && !!document.querySelector('button[data-tool="photo"]'), null, 40000);
  report('Bench opens', ok);
  await sleep(1500);
  const sel = await page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    c.setAttribute('data-main', '1');
    return 'canvas[data-main="1"]';
  });
  await photo(page, 'Bench', sel);
  await record(page, 'Bench', sel, false);
  await page.close();
}

// ---- 3. USB keypad product (P2-12) photo
{
  const page = await open('/app?work=usbkey#product');
  const ok = await waitFor(page, () => !!document.querySelector('.prod-stage canvas') && /configured/.test(document.querySelector('#props')?.textContent ?? ''), null, 40000);
  report('USB keypad Product page: virtual PC sees configured', ok);
  await sleep(1000);
  await photo(page, 'Product (USB keypad)', '.prod-stage canvas');
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[media] page errors:\n  ' + errors.join('\n  '));
console.log(`[media] ${fails ? 'FAIL' : 'PASS'} (${n} checks, ${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
