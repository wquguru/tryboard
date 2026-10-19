// 虚拟手机配网验收（C-02）：网页「网络」页签里一步步点 → 导出输入日志 → 命令行 --inputs 重放，串口逐字节相同。
//  1. 电脑布局：打开 c3-softap-prov，坞里出现「网络」页签；拿起手机 → 点板子热点 → 「需要登录此网络」→ 打开 → 表单提交
//     → 串口「拿到 IP 192.168.5.100」，「提交之后」三项都打勾；固件自己重启后页签还在
//  2. 暂停、导出输入日志：手机每一步都是 phone=… 动作；命令行按同一份日志重放到同一模拟时刻，串口逐字节相同
//  3. 换成不用 Wi-Fi 的示例（blink）：「网络」页签不出现
//  4. 手机布局 390×844：抽屉里的「网络」页签一次一步，三步走完；无横向滚动，主按钮 ≥ 44px
// 用法：node tools/webtest/softap.mjs（先 tools/build_web.sh）。日志与截图在 Reviews/web/softap-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const FW = path.join(root, 'firmware/build/c3-softap-prov/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
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
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[softap] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const fwConsole = (page) => page.$eval('#console', (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''));
const hasText = (page, sel, t) => waitFor(page, ([s, x]) => (document.querySelector(s)?.textContent ?? '').includes(x), [sel, t], 20000);
/** 底部坞里名字是 name 的页签 */
const tabSel = async (page, name) =>
  page.evaluateHandle((n) => [...document.querySelectorAll('#dock [role=tab]')].find((b) => b.textContent.trim().startsWith(n)) ?? null, name);
async function clickTab(page, name) {
  const h = await tabSel(page, name);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
}
async function newPage(w, h, mobile) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile });
  p.on('pageerror', (e) => errors.push(`${e}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return p;
}
/** 元素滚进视口再点（手机抽屉里要先滚） */
async function tap(page, sel) {
  const el = await page.waitForSelector(sel, { timeout: 15000 }).catch(() => null);
  if (!el) return false;
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await el.click();
  return true;
}

// ---- 1. 电脑布局走一遍
const page = await newPage(1440, 1000);
await page.goto(base + '/app?work=blank&example=c3-softap-prov#bench', { waitUntil: 'load' });
report('固件开出热点（串口「配网页 … 已就绪」）', await hasText(page, '#console', '配网页 http://192.168.4.1/ 已就绪'));
report('坞里出现「网络」页签', await waitFor(page, () => [...document.querySelectorAll('#dock [role=tab]')].some((b) => b.textContent.trim() === '网络'), null, 10000));
await clickTab(page, '网络');
report('拿起手机', await tap(page, '#phoneOn'));
const seen = await waitFor(page, () => !!document.querySelector('[data-ssid="TryBoard-Setup"]'), null, 15000);
report('手机看到板子的热点 TryBoard-Setup', seen);
await tap(page, '[data-ssid="TryBoard-Setup"]');
report('连上分到 192.168.4.2', await hasText(page, '#phoneIp', '192.168.4.2'));
report('弹出「需要登录此网络」', await hasText(page, '#phoneCaptive', '需要登录此网络'));
await tap(page, '#phoneOpen');
report('登录页「设备配网」带表单', await waitFor(page, () => !!document.querySelector('#phoneForm input[name=ssid]'), null, 15000));
const pre = await page.$$eval('#phoneForm input', (l) => l.map((i) => i.value).join('/'));
report('表单预填 MyHome / 12345678', pre === 'MyHome/12345678', pre);
await page.screenshot({ path: path.join(outDir, 'softap-form.png') });
await tap(page, '#phoneSubmit');
report('串口：收到 SSID=MyHome', await hasText(page, '#console', '收到 SSID=MyHome（密码 8 位）'));
report('串口：拿到 IP 192.168.5.100', await hasText(page, '#console', '拿到 IP 192.168.5.100 网关 192.168.5.1'));
const after = await waitFor(page, () => document.querySelectorAll('#phoneAfter [data-ok]').length === 3, null, 15000);
report('「提交之后」三项打勾', after, await page.$eval('#phoneAfter', (e) => e.textContent.slice(0, 80)));
report('固件自己重启后从 NVS 直接连上', await hasText(page, '#console', 'NVS 里记着 Wi-Fi：MyHome，直接连接'));
report('重启后「网络」页签还在、还选着', await page.evaluate(() => !!document.querySelector('#netPane')));
await page.screenshot({ path: path.join(outDir, 'softap-after.png') });

// ---- 2. 导出输入日志 → 命令行重放
await page.click('#runPause');
await waitFor(page, () => /已暂停/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
const text = await page.evaluate(async () => {
  let blob = null;
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  document.getElementById('moreBtn').click();
  for (let i = 0; i < 20 && !document.querySelector('[data-more="inputs"]'); i++) await new Promise((r) => setTimeout(r, 50));
  document.querySelector('[data-more="inputs"]').click();
  for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 50));
  URL.createObjectURL = orig;
  HTMLAnchorElement.prototype.click = click;
  return blob ? await blob.text() : '';
});
const inputsFile = path.join(outDir, 'softap-inputs.txt');
fs.writeFileSync(inputsFile, text);
fs.writeFileSync(path.join(outDir, 'softap-web.stdout'), live);
const acts = text.split('\n').filter((l) => /:phone=/.test(l)).map((l) => l.replace(/^[\d.]+:phone=/, ''));
report('输入日志记下手机每一步（on / join / open / post）', acts.length === 4 && acts[0] === 'on' && acts[1] === 'join,TryBoard-Setup' && acts[2] === 'open' && /^post,,ssid=MyHome&pass=12345678$/.test(acts[3]), acts.join(' | '));
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), '--inputs', inputsFile], { maxBuffer: 64 << 20 });
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'softap-cli.stdout'), p.stdout);
fs.writeFileSync(path.join(outDir, 'softap-cli.stderr'), p.stderr);
let at = -1;
if (cli !== live) at = Math.max(0, [...cli].findIndex((c, i) => c !== live[i]));
report('命令行 --inputs 重放 = 网页串口（逐字节）', cli === live && p.status === 0 && cli.includes('拿到 IP 192.168.5.100'),
  cli === live ? `${live.length} 字节，${cycles} 周期` : `第 ${at} 字节起不同（命令行 ${cli.length} / 网页 ${live.length}）：${JSON.stringify(cli.slice(at, at + 50))} vs ${JSON.stringify(live.slice(at, at + 50))}`);
await page.close();

// ---- 3. 不用 Wi-Fi 的固件没有「网络」页签
const pb = await newPage(1440, 1000);
await pb.goto(base + '/app?work=blank&example=blink#bench', { waitUntil: 'load' });
await waitFor(pb, () => parseFloat(document.getElementById('simtime')?.textContent) > 1.5, null, 20000);
report('blink：没有「网络」页签', await pb.evaluate(() => ![...document.querySelectorAll('#dock [role=tab]')].some((b) => b.textContent.trim() === '网络')));
await pb.close();

// ---- 4. 手机布局
const pm = await newPage(390, 844, true);
await pm.goto(base + '/app?work=blank&example=c3-softap-prov#bench', { waitUntil: 'load' });
await waitFor(pm, () => (document.getElementById('console')?.textContent ?? '').includes('已就绪'), null, 30000);
await tap(pm, '#sheetPeek');
await waitFor(pm, () => document.querySelector('#dock')?.dataset.sheet === 'half', null, 5000);
report('手机：抽屉里有「网络」页签', await clickTab(pm, '网络'));
await tap(pm, '#phoneOn');
await waitFor(pm, () => !!document.querySelector('[data-ssid="TryBoard-Setup"]'), null, 15000);
const oneStep = await pm.evaluate(() => document.querySelectorAll('[id^=phoneStep]').length);
report('手机：一次只显示一步', oneStep === 1, `${oneStep} 部手机`);
const tapH = await pm.$$eval('#netPane [data-phone-step], #netPane [data-ssid]', (l) => Math.min(...l.map((e) => e.getBoundingClientRect().height)));
report('手机：步骤按钮 / 热点行 ≥ 44px', tapH >= 44, `${tapH}px`);
await tap(pm, '[data-ssid="TryBoard-Setup"]');
await hasText(pm, '#phoneCaptive', '需要登录此网络');
await tap(pm, '#phoneOpen');
await waitFor(pm, () => !!document.querySelector('#phoneSubmit'), null, 15000);
report('手机：自动翻到第 3 步', await pm.evaluate(() => !!document.querySelector('#phoneStep3') && !document.querySelector('#phoneStep2')));
await tap(pm, '#phoneSubmit');
report('手机：提交后拿到 IP', await waitFor(pm, () => document.querySelectorAll('#phoneAfter [data-ok]').length === 3, null, 20000));
const [sw, iw] = await pm.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
report('手机：无横向滚动', sw <= iw, `${sw} / ${iw}`);
await pm.screenshot({ path: path.join(outDir, 'softap-mobile.png') });
await pm.close();

await browser.close();
server.close();
if (errors.length) console.log('[softap] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[softap] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
