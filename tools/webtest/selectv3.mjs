// 选板 v3 回归（U-15，DESIGN_V2 §8.2）：
//  ① 改零件 / 问题出「刚才」行，撤销（可连续）回到原状态
//  ② 打开分享链接得到同一结论（板子、任务书、状态）
//  ③ 任务书里没有 npx（也没有其它命令行），最后一行指本地包
//  ④ 主按钮地址以 ./app?work=custom 开头，参数与页面状态一致（board 写明、have 只在这里）
//  ⑤ 390×844 无横向滚动，主要触控目标 ≥ 44px；术语弹层能开、Esc 能关；0 块板时给「去掉 X → N 块」
// 用法：node tools/webtest/selectv3.mjs [dist 目录，默认 web/dist]。截图在 Reviews/web/selectv3-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.resolve(process.argv[2] ?? path.join(root, 'web/dist'));
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // 无后缀地址（/app、/select）映射到 .html，与 Vite 预览和静态托管一致（DESIGN_V2 §7.2）
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
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
  args: ['--window-size=1440,900'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[selectv3] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(80);
  }
  return false;
}
const errors = [];
async function open(url, vp) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // 剪贴板在无头浏览器里要权限，换成记下来
  await page.evaluateOnNewDocument(() => {
    globalThis.__clip = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => (globalThis.__clip.push(t), Promise.resolve()) }, configurable: true });
  });
  await page.goto(base + url);
  await waitFor(page, () => !!document.querySelector('#templates') && !!globalThis.__tbSelect);
  return page;
}
const S = (page) => page.evaluate(() => globalThis.__tbSelect);
const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const DESK = { width: 1440, height: 900 };

// ---------------------------------------------------------------- ① 刚才 + 撤销
{
  const page = await open('/select?t=weather', DESK);
  const s0 = await S(page);
  report('旧链接 ?t=weather 打开温湿度计', s0.state.t === 'weather' && /XIAO/.test(await page.$eval('#boardName', (e) => e.textContent)));
  report('一开始没有「刚才」行', !(await page.$('#recent')));
  await click(page, '[data-part="buzzer"]');
  await waitFor(page, () => !!document.querySelector('#recent'));
  const t1 = await page.$eval('#recentText', (e) => e.textContent);
  report('加蜂鸣器 → 「刚才」写明推荐变没变、引脚、价差', /^加了蜂鸣器 → 推荐没变，多占 1 个引脚 \S+，参考价 \+¥/.test(t1), t1);
  report('地址跟着变（replaceState）', await page.evaluate(() => new URLSearchParams(location.search).get('add') === 'buzzer'));
  await click(page, '[data-q="bat"]');
  await waitFor(page, () => /不用电池/.test(document.querySelector('#recentText')?.textContent));
  const t2 = await page.$eval('#recentText', (e) => e.textContent);
  report('关「用电池」→ 推荐换板并给出价差', /^不用电池 → 推荐换成 .+，参考价 [+−]¥/.test(t2), t2);
  await click(page, '[data-budget="60"]');
  await waitFor(page, () => /预算 ¥60/.test(document.querySelector('#recentText')?.textContent));
  await click(page, '#undo');
  await click(page, '#undo');
  await waitFor(page, () => /加了蜂鸣器/.test(document.querySelector('#recentText')?.textContent));
  report('连续撤销两步回到「加了蜂鸣器」', (await S(page)).state.bat === null && (await S(page)).state.budget === 0);
  await click(page, '#undo');
  await waitFor(page, () => !document.querySelector('#recent'));
  const s1 = await S(page);
  report('再撤销 → 状态、地址、结论回到原样', JSON.stringify(s1.state) === JSON.stringify(s0.state) && (await page.evaluate(() => location.search)) === '?t=weather' && s1.brief === s0.brief);
  // 我已有：不进撤销栈、存本机、只进采购链接
  await click(page, '[data-have="bme280"]');
  await waitFor(page, () => globalThis.__tbSelect.have.includes('bme280'));
  report('「我已有」不出「刚才」行，存进本机', !(await page.$('#recent')) && (await page.evaluate(() => JSON.parse(localStorage.getItem('tryboard-have') || '[]').includes('bme280'))));
  // 术语：第一次出现的才标；弹层能开，Esc 关
  const terms = await page.$$eval('[data-term]', (es) => es.map((e) => e.dataset.term));
  report('术语只标第一次出现', terms.length > 0 && new Set(terms).size === terms.length, terms.join(','));
  await page.focus('[data-term="I2C"]');
  await page.keyboard.press('Enter');
  const pop = await waitFor(page, () => /对你的项目：.*D4/.test(document.querySelector('[data-term-pop="I2C"]')?.textContent ?? ''));
  report('键盘打开 I2C 解释，两句话含「对你的项目」', pop, await page.evaluate(() => document.querySelector('[data-term-pop="I2C"]')?.textContent));
  await page.keyboard.press('Escape');
  report('Esc 关掉解释', await waitFor(page, () => !document.querySelector('[data-term-pop="I2C"]')));
  // 全部细节
  await click(page, '#detailsBtn');
  report('全部细节展开：引脚表、功耗分解、必须上真机、计算依据', await waitFor(page, () => ['引脚表', '功耗分解', '必须上真机', '计算依据'].every((t) => document.querySelector('#details')?.textContent.includes(t))));
  report('可信度全用图标（没有旧彩色徽章）', (await page.$$('[data-conf]')).length >= 8 && !(await page.$('.conf.font-bold')));
  await page.screenshot({ path: path.join(outDir, 'selectv3-desktop.png'), fullPage: true });
  await page.close();
}

// ---------------------------------------------------------------- ② 分享链接 ③ 任务书 ④ 主按钮
{
  const page = await open('/select?t=weather', DESK);
  await click(page, '[data-part="buzzer"]');
  await click(page, '[data-budget="120"]');
  await waitFor(page, () => /预算 ¥120/.test(document.querySelector('#recentText')?.textContent));
  // 对比里点第二块
  const second = await page.$$eval('#compare [data-board]', (es) => es[1]?.dataset.board);
  await click(page, `#compare [data-board="${second}"]`);
  await waitFor(page, (b) => globalThis.__tbSelect.state.board === b, second);
  await click(page, '[data-have="oled"]');
  await waitFor(page, () => globalThis.__tbSelect.have.includes('oled'));
  const a = await S(page);
  const nameA = await page.$eval('#boardName', (e) => e.textContent);
  await click(page, '#share');
  await waitFor(page, () => globalThis.__clip.length > 0);
  const shared = await page.evaluate(() => globalThis.__clip.at(-1));
  report('分享链接 = 地址栏，不带「我已有」', shared === (await page.evaluate(() => location.href)) && !/have=/.test(shared), shared);

  // ③ 任务书
  await click(page, '#copyBrief');
  await waitFor(page, () => globalThis.__clip.length > 1);
  const copied = await page.evaluate(() => globalThis.__clip.at(-1));
  const shown = await page.$eval('#briefText', (e) => e.textContent);
  report('复制的任务书 = 页面上的任务书', copied === a.brief && shown === a.brief);
  report('任务书没有 npx / 命令行', !/npx|idf\.py|tryboard run|\$ /.test(copied));
  report('任务书四节 + 验收检查点 + 最后一行本地包', ['## 硬件', '## 引脚', '## 要求', '## 验收'].every((h) => copied.includes(h)) && /1\. 开机不崩溃，串口有输出/.test(copied) && /I2C 0x76 有回应（BME280）/.test(copied) && copied.trim().endsWith('想离线跑的，从仓库本地装 packages/tryboard'));

  // ④ 主按钮
  const href = await page.$eval('#go', (e) => e.getAttribute('href'));
  const q = new URLSearchParams(href.split('?')[1].split('#')[0]);
  const st = a.state;
  const want = { t: st.t, add: st.add.join(','), budget: String(st.budget), board: second, have: a.have.join(',') };
  const bad = Object.entries(want).filter(([k, v]) => (q.get(k) ?? '') !== v);
  report('主按钮 ./app?work=custom…#shop，参数与页面一致', href.startsWith('./app?work=custom') && href.endsWith('#shop') && bad.length === 0 && !q.has('bat') && !q.has('net'), href);
  report('主按钮文字', /按这套开始做 →/.test(await page.$eval('#go', (e) => e.textContent)) && /进采购，清单已填好/.test(await page.$eval('#go', (e) => e.textContent)));
  await page.close();

  // ② 新页面打开分享链接
  const p2 = await open(shared.replace(/^https?:\/\/[^/]+/, ''), DESK);
  const b = await S(p2);
  report('打开分享链接得到同一结论', (await p2.$eval('#boardName', (e) => e.textContent)) === nameA && b.brief === a.brief && JSON.stringify(b.state) === JSON.stringify(a.state), nameA);
  await p2.close();
}

// ---------------------------------------------------------------- 0 块板
{
  const page = await open('/select?t=weather&req=bt_classic&budget=60', DESK);
  const opts = await page.$$eval('[data-relax]', (es) => es.map((e) => e.textContent));
  report('0 块板：给出「去掉 X → N 块」和预算放宽', !!(await page.$('#none')) && opts.some((t) => /^去掉/.test(t)) && opts.some((t) => /预算/.test(t)), opts.join(' | '));
  await click(page, '[data-relax]');
  report('点一条就有板子，并能撤销', (await waitFor(page, () => !!document.querySelector('#boardName'))) && !!(await page.$('#undo')));
  await page.close();
}

// ---------------------------------------------------------------- 不能仿真的板：仍可点，写「用 C3 代替运行」
{
  const page = await open('/select?t=weather', DESK);
  const c6 = await page.$$eval('#compare [data-board]', (es) => es.find((e) => /暂不能 · 用 C3 代替运行/.test(e.textContent))?.dataset.board);
  report('对比里不能仿真的板写「暂不能 · 用 C3 代替运行」', !!c6, c6);
  if (c6) {
    await click(page, `#compare [data-board="${c6}"]`);
    await waitFor(page, (b) => globalThis.__tbSelect.state.board === b, c6);
    report('点它 → 答案换板、能跑固件标「必须上真机」', (await page.$eval('[data-stat="sim"] [data-conf]', (e) => e.dataset.conf)) === '必须上真机' && /代替运行/.test(await page.$eval('#reason', (e) => e.textContent)));
  }
  await page.close();
}

// ---------------------------------------------------------------- ⑤ 手机
{
  const page = await open('/select?t=weather', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const tappable = (sel) =>
    page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return 'missing';
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return 'hidden';
      if (r.height < 43.5) return `h=${r.height}`;
      if (r.left < -0.5 || r.right > innerWidth + 0.5) return `x=${r.left}..${r.right}`;
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top && (top === e || e.contains(top)) ? 'ok' : `covered by ${top?.id || top?.className}`;
    }, sel);
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 0.5);
  report('手机：无横向滚动', await noHScroll());
  for (const sel of ['#go', '#mobileBar #share', '[data-t="weather"]', '[data-edit="parts"]', '[data-edit="qs"]']) report(`手机：${sel} ≥ 44px 可点`, (await tappable(sel)) === 'ok', await tappable(sel));
  await click(page, '[data-edit="qs"]');
  for (const sel of ['[data-q="bat"]', '[data-budget="60"]', '#moreReq']) report(`手机：${sel} ≥ 44px 可点`, (await tappable(sel)) === 'ok', await tappable(sel));
  await click(page, '[data-edit="parts"]');
  for (const sel of ['[data-part="buzzer"]', '[data-have="bme280"]', '#addPart']) report(`手机：${sel} ≥ 44px 可点`, (await tappable(sel)) === 'ok', await tappable(sel));
  await click(page, '[data-part="buzzer"]');
  report('手机：改零件出「刚才」', await waitFor(page, () => /加了蜂鸣器/.test(document.querySelector('#recentText')?.textContent)));
  report('手机：#undo ≥ 44px', (await tappable('#undo')) === 'ok', await tappable('#undo'));
  await click(page, '#detailsBtn');
  report('手机：展开细节后仍无横向滚动', await noHScroll());
  await click(page, '[data-term="I2C"]');
  report('手机：术语是底部抽屉', await waitFor(page, () => {
    const e = document.querySelector('[data-term-pop="I2C"]');
    return e && Math.abs(e.getBoundingClientRect().bottom - innerHeight) < 2;
  }));
  await page.keyboard.press('Escape');
  report('手机：Esc 关抽屉', await waitFor(page, () => !document.querySelector('[data-term-pop="I2C"]')));
  report('手机：三块板横滑卡片', await page.evaluate(() => [...document.querySelectorAll('#compare [data-board]')].every((e) => Math.round(e.getBoundingClientRect().width) === 300)));
  await page.screenshot({ path: path.join(outDir, 'selectv3-mobile.png'), fullPage: true });
  await page.close();
}

report('全程无报错', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails ? `[selectv3] ✗ ${fails} 项失败` : '[selectv3] ✓ 全部通过');
process.exit(fails ? 1 : 0);
