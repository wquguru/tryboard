// 全站静态 OG 图（DESIGN_V2 §8.5，PLAN U-19）：把 og.html 渲染成 web/dist/og.png（1200×630），再查 dist 里每个 HTML 入口都带 og 标签。
// 放在 tools/webtest 是为了用这里已有的 puppeteer-core，不新增依赖；页面走 file://、不连外网。
// 用法：vite build 之后 node tools/webtest/og.mjs（tools/build_web.sh 末尾会调）。任何一项不对就非零退出。
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
  console.error(`[og] 没有 ${dist}：先 vite build`);
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
  // 只许读本地文件：og.html 不该有任何外网请求（字体、图片都内联或用系统字体）
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().startsWith('file:') ? r.continue() : (console.error(`[og] 拦下外网请求 ${r.url()}`), fails++, r.abort())));
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
console.log(`[og] ${path.relative(process.cwd(), out)} ${size?.join('×') ?? '不是 PNG'} ${(b.length / 1024).toFixed(0)} KB: ${sizeOk ? 'PASS' : 'FAIL'}`);
if (!sizeOk) fails++;

// 每个入口都要有这几样（og:image 指向的文件就是上面这张）
const NEED = ['og:title', 'og:description', 'og:image', 'og:type', 'twitter:card'];
for (const f of fs.readdirSync(dist).filter((x) => x.endsWith('.html')).sort()) {
  const html = fs.readFileSync(path.join(dist, f), 'utf8');
  const miss = NEED.filter((k) => !new RegExp(`<meta[^>]+(?:property|name)="${k}"[^>]+content="[^"]+"`).test(html));
  const img = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(html)?.[1];
  const imgOk = !!img && fs.existsSync(path.join(dist, img));
  const large = /name="twitter:card"[^>]+content="summary_large_image"/.test(html);
  const ok = !miss.length && imgOk && large;
  console.log(`[og] ${f}: ${ok ? 'PASS' : 'FAIL'}${miss.length ? `  缺 ${miss.join(' ')}` : ''}${imgOk ? '' : `  og:image ${img ?? '无'} 不存在`}${large ? '' : '  twitter:card 不是 summary_large_image'}`);
  if (!ok) fails++;
}
process.exit(fails ? 1 : 0);
