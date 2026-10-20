// Share card (F-02): weather bench, press BOOT, ⋯ "Make a share card" -> PNG card + 6 s video. The QR is sampled from the
// rendered PNG pixels and decoded (web/test/qrdecode.ts); it must equal the share link, and that link must open the bench.
// Card and logs in Reviews/web/sharecard-*; usage: node tools/webtest/sharecard.mjs (needs web/dist).
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeQr } from '../../web/test/qrdecode.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,1000', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, total = 0;
const report = (name, ok, extra = '') => {
  total++;
  console.log(`[sharecard] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
};

/** Sample the QR modules of the card PNG at module centres (in the page, from the PNG data URL). */
const sampleQr = (page) =>
  page.evaluate(async () => {
    const c = globalThis.__tbCardLast;
    const img = new Image();
    img.src = c.png;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    const { x, y, module, size } = c.qr;
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    const m = [];
    for (let r = 0; r < size; r++)
      for (let q = 0; q < size; q++) {
        const i = ((y + r * module + (module >> 1)) * cv.width + x + q * module + (module >> 1)) * 4;
        m.push(px[i] + px[i + 1] + px[i + 2] < 384 ? 1 : 0);
      }
    // Quiet zone: the ring just outside the symbol must be white.
    let quiet = true;
    for (let k = -1; k <= size; k++)
      for (const [qx, qy] of [[k, -1], [k, size], [-1, k], [size, k]]) {
        const i = ((y + qy * module + (module >> 1)) * cv.width + x + qx * module + (module >> 1)) * 4;
        if (px[i] < 200) quiet = false;
      }
    return { m, size, quiet, w: img.width, h: img.height };
  });

// ---- 1. Weather bench, press BOOT so the link carries a run record
const page = await browser.newPage();
watch(page, 'card');
await page.goto(base + '/app?work=blank&example=weather#bench', { waitUntil: 'load' });
report('bench weather runs live', await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console').textContent), null, 30000));
await waitFor(page, () => parseFloat(document.getElementById('simtime').textContent) > 1.0, null, 30000);
const pos = await page.evaluate(() => globalThis.__tbButtonPos('BOOT'));
if (pos) {
  await page.mouse.move(pos[0], pos[1]);
  await page.mouse.down();
  await sleep(300);
  await page.mouse.up();
}
report('press BOOT -> serial UNIT F', !!pos && (await waitFor(page, () => document.getElementById('console').textContent.includes('UNIT F'), null, 15000)));

// ---- 2. ⋯ -> Make a share card
await page.click('#moreBtn');
await page.waitForSelector('[data-more="card"]', { timeout: 5000 });
await page.click('[data-more="card"]');
report('dialog opens with PNG card', await waitFor(page, () => !!globalThis.__tbCardLast?.png || !!globalThis.__tbCardLast?.error, null, 20000), (await page.evaluate(() => globalThis.__tbCardLast?.error)) ?? '');
const card = await page.evaluate(() => globalThis.__tbCardLast);
if (card?.png) fs.writeFileSync(path.join(outDir, 'sharecard-card.png'), Buffer.from(card.png.split(',')[1], 'base64'));
const s = await sampleQr(page);
report('card is 1080×1350', s.w === 1080 && s.h === 1350, `${s.w}×${s.h}`);
report('QR has a white quiet zone, module ≥ 2 px', s.quiet && card.qr.module >= 2, `v${card.qr.version}, ${card.qr.module} px/module`);
let decoded = '';
try {
  decoded = decodeQr(s.m, s.size).text;
} catch (e) {
  decoded = `decode error: ${e.message}`;
}
fs.writeFileSync(path.join(outDir, 'sharecard-link.txt'), `${card.url}\n${decoded}\n`);
report('QR decodes to the share link', decoded === card.url, `${decoded.length} chars`);
report('link carries the run record (short link, not truncated)', card.run && !card.truncated && /[?&]s=/.test(card.url));

// ---- 3. 6 s video
report('video recorded', await waitFor(page, () => !!globalThis.__tbCardLast?.video || !!globalThis.__tbCardLast?.error, null, 20000));
const v = await page.evaluate(() => globalThis.__tbCardLast.video);
const ext = v?.name.split('.').pop();
report('video name matches its mime', !!v && ext === (/mp4/.test(v.mime) ? 'mp4' : 'webm'), v ? `${v.name} ${v.mime}` : '');
report('video ≈ 6 s, > 20 KB', !!v && v.seconds > 5.5 && v.seconds < 7.5 && v.bytes > 20000, v ? `${v.seconds.toFixed(2)} s ${(v.bytes / 1024).toFixed(0)} KB` : '');
report('download buttons enabled', await page.evaluate(() => ['video', 'png', 'copy'].every((a) => !document.querySelector(`#cardDlg [data-act="${a}"]`).disabled)));
await page.screenshot({ path: path.join(outDir, 'sharecard-dialog.png') });
await page.keyboard.press('Escape');
report('Escape closes the dialog', await waitFor(page, () => !document.getElementById('cardDlg'), null, 3000));

// ---- 4. The decoded link opens the same bench and replays BOOT
const ctx2 = await browser.createBrowserContext();
const p2 = await ctx2.newPage();
watch(p2, 'open');
await p2.goto(decoded.startsWith('http') ? decoded : base + '/app', { waitUntil: 'load' });
report('decoded link replays BOOT (serial UNIT F)', await waitFor(p2, () => document.getElementById('console')?.textContent.includes('UNIT F'), null, 40000));
await ctx2.close();

// ---- 5. Phone 390×844: dialog fits, buttons ≥ 44 px
const ph = await browser.newPage();
watch(ph, 'phone');
await ph.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await ph.goto(base + '/app?work=blank&example=weather#bench', { waitUntil: 'load' });
await waitFor(ph, () => /T=23\.50 C/.test(document.getElementById('console')?.textContent ?? ''), null, 30000);
await ph.click('#moreBtn');
await ph.waitForSelector('[data-more="card"]', { timeout: 5000 });
await ph.click('[data-more="card"]');
await waitFor(ph, () => !!globalThis.__tbCardLast?.png, null, 20000);
const fit = await ph.evaluate(() => {
  const d = document.getElementById('cardDlg').getBoundingClientRect();
  const hs = [...document.querySelectorAll('#cardDlg button')].map((b) => b.getBoundingClientRect().height);
  return { scroll: document.documentElement.scrollWidth, left: d.left, right: d.right, minH: Math.min(...hs) };
});
report('phone: no horizontal scroll, buttons ≥ 44 px', fit.scroll <= 390 && fit.left >= 0 && fit.right <= 390 && fit.minH >= 44, JSON.stringify(fit));
await ph.screenshot({ path: path.join(outDir, 'sharecard-phone.png') });

const real = errors.filter((e) => !/favicon|404/.test(e));
report('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails ? `[sharecard] FAIL (${fails}/${total})` : `[sharecard] PASS (${total}/${total})`);
process.exit(fails ? 1 : 0);
