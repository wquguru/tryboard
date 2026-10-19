// Site-wide OG image (DESIGN_V2 §8.5, PLAN U-19): render og.html to web/dist/og.png (1200×630), check every dist HTML has og tags.
// Usage: node tools/webtest/og.mjs after vite build (build_web.sh calls it); file:// only, no network; non-zero exit on any failure.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../web/dist');
const out = path.join(dist, 'og.png');
const W = 1200;
const H = 630;
if (!fs.existsSync(dist)) {
  console.error(`[og] no ${dist}: run vite build first`);
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
let fails = 0;
try {
  const page = await browser.newPage();
  // Local files only: og.html must not make network requests (fonts and images are inline or system)
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().startsWith('file:') ? r.continue() : (console.error(`[og] blocked network request ${r.url()}`), fails++, r.abort())));
  await page.goto(pathToFileURL(path.join(here, 'og.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts?.ready);
  const el = await page.$('#og');
  await el.screenshot({ path: out });
} finally {
  await browser.close();
}

const b = fs.readFileSync(out);
const size = b.length > 24 && b.readUInt32BE(12) === 0x49484452 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
const sizeOk = !!size && size[0] === W && size[1] === H;
console.log(`[og] ${path.relative(process.cwd(), out)} ${size?.join('×') ?? 'not a PNG'} ${(b.length / 1024).toFixed(0)} KB: ${sizeOk ? 'PASS' : 'FAIL'}`);
if (!sizeOk) fails++;

// Every entry needs these (og:image points at the file rendered above)
const NEED = ['og:title', 'og:description', 'og:image', 'og:type', 'twitter:card'];
for (const f of fs.readdirSync(dist).filter((x) => x.endsWith('.html')).sort()) {
  const html = fs.readFileSync(path.join(dist, f), 'utf8');
  const miss = NEED.filter((k) => !new RegExp(`<meta[^>]+(?:property|name)="${k}"[^>]+content="[^"]+"`).test(html));
  const img = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(html)?.[1];
  const imgOk = !!img && fs.existsSync(path.join(dist, img));
  const large = /name="twitter:card"[^>]+content="summary_large_image"/.test(html);
  const ok = !miss.length && imgOk && large;
  console.log(`[og] ${f}: ${ok ? 'PASS' : 'FAIL'}${miss.length ? `  missing ${miss.join(' ')}` : ''}${imgOk ? '' : `  og:image ${img ?? 'none'} does not exist`}${large ? '' : '  twitter:card is not summary_large_image'}`);
  if (!ok) fails++;
}
process.exit(fails ? 1 : 0);
