// 手机布局回归（U-05）：390×844，app.html?work=weather 的四步
//  - 每步没有横向滚动；顶栏「‹ 作品」、▾ 切换作品、⋯ 菜单、四步分段条都在且够大（≥ 44px）
//  - 采购：底部吸附主按钮；「换开发板…」卡片在手机上是底部抽屉，真点得到（不被清单盖住），能关
//  - 实验台：五个底部工具；串口抽屉 peek → 半屏 → 全屏 → 收起，输入框发送后清空；
//    构建树点 BME280 → 属性抽屉，预设 32° 让固件读数变成 32；零件库全屏页、分类筛选、关闭；
//    连线：横幅里选线 → 按住引脚有放大镜 → 松手接到 5V → 接错线卡片 → 撤销
//  - 组装：锁定页有「回实验台」；预置检查点后解锁，装完六层 → 成品
//  - 成品（P2-17）：3D 全屏、底部按键格按 BOOT 串口出 UNIT F、点串口条开半屏抽屉再收起；8 个成品逐个看全屏、无横向滚动、键够大
//  - 全程不请求外部域名（P2-19 自托管字体）
//  - 全程页面无报错
// 用法：node tools/webtest/mobile.mjs [dist 目录，默认 web/dist]。截图在 Reviews/web/mobile-*
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
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=390,844'],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[mobile] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
// 自托管字体后整站不该再连外部域名（fonts.googleapis / gstatic 之类）
const external = [];
page.on('request', (r) => {
  const u = r.url();
  if (/^https?:/.test(u) && !u.startsWith(base)) external.push(u);
});
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

/** 元素可见、在视口里、≥ 44px 高，而且中心点真能点到它（没被别的东西盖住） */
const tappable = (sel) =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return 'missing';
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return 'hidden';
    if (r.height < 44 - 0.5) return `h=${r.height}`;
    if (r.left < -0.5 || r.right > innerWidth + 0.5) return `x=${r.left}..${r.right}`;
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top && (top === e || e.contains(top)) ? 'ok' : `covered by ${top?.id || top?.tagName}`;
  }, sel);
const noHScroll = () => page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
const visible = (sel) =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  }, sel);
async function clickText(sel, text) {
  return page.evaluate(
    (s, t) => {
      const e = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().startsWith(t));
      e?.click();
      return !!e;
    },
    sel,
    text,
  );
}
async function stepCheck(name) {
  const [sw, iw] = await noHScroll();
  report(`${name}：无横向滚动`, sw <= iw, `${sw}/${iw}`);
}

// ---- 采购
// debug=1 才挂 __tbApp.faults()（接线检查结果），与 wiremode.mjs 相同
await page.goto(base + '/app?work=weather&debug=1#shop', { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await waitFor(page, () => globalThis.__tbApp?.store.get().step === 'shop' && !!document.querySelector('#mNext #next'), null, 30000);
await stepCheck('采购');
for (const s of ['#crumbHome', '#workMenuBtn', '#moreBtn', '#steps [data-step="bench"]', '#mNext #next']) report(`采购：${s} 可点`, (await tappable(s)) === 'ok', await tappable(s));
report('采购：「‹ 作品」回首页', await page.$eval('#crumbHome', (e) => e.getAttribute('href') === './'));
report('采购：组装、成品带锁', await page.evaluate(() => ['assemble', 'product'].every((s) => !!document.querySelector(`#steps [data-step="${s}"] svg`))));
await clickText('#toolbar button', '换开发板');
await waitFor(page, () => !document.querySelector('.qcard')?.hidden);
report('采购：换开发板抽屉可见、真点得到', (await visible('.qcard')) && (await tappable('.qcard [data-id="esp32-c3-devkitm-1"], .qcard button[data-id]')) === 'ok', await tappable('.qcard button[data-id]'));
await page.screenshot({ path: path.join(outDir, 'mobile-shop-board.png') });
await page.click('.qcard [data-card-close]');
report('采购：换开发板抽屉能关', await waitFor(page, () => document.querySelector('.qcard')?.hidden));

// ---- ▾ 切换作品、⋯ 菜单
await page.click('#workMenuBtn');
report('▾ 作品菜单列出作品', await waitFor(page, () => document.querySelectorAll('#workMenu [role=menuitemradio]').length >= 7));
await page.click('#workMenuBtn');
await page.click('#moreBtn');
report('⋯ 菜单有任务书、换固件、暗色', await waitFor(page, () => /任务书/.test(document.querySelector('#moreMenu')?.textContent) && /换固件/.test(document.querySelector('#moreMenu')?.textContent) && /暗色|亮色/.test(document.querySelector('#moreMenu')?.textContent)));
await page.click('#moreBtn');

// ---- 实验台
await page.click('#mNext #next');
await waitFor(page, () => globalThis.__tbApp.store.get().step === 'bench' && globalThis.__tbApp.store.get().simSeconds > 0.5, null, 30000);
await sleep(300);
await stepCheck('实验台');
for (const t of ['select', 'wire', 'lib', 'meter', 'more']) report(`实验台：工具「${t}」可点`, (await tappable(`[data-mtool="${t}"]`)) === 'ok', await tappable(`[data-mtool="${t}"]`));
report('实验台：检查点横幅', (await tappable('#cpGo')) === 'ok', await tappable('#cpGo'));
await page.screenshot({ path: path.join(outDir, 'mobile-bench.png') });

// 串口抽屉
const sheet = () => page.$eval('#dock', (e) => e.dataset.sheet);
report('串口抽屉：peek 可点', (await tappable('#sheetPeek')) === 'ok', await tappable('#sheetPeek'));
await page.click('#sheetPeek');
report('串口抽屉：点开半屏', await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'half'));
await page.click('#dock button[aria-label="全屏"]');
report('串口抽屉：全屏', await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'full'));
report('串口抽屉：发送按钮可点', (await tappable('#serialSend')) === 'ok', await tappable('#serialSend'));
await page.type('#serialIn', 'help');
await page.click('#serialSend');
report('串口抽屉：发送后输入框清空', await waitFor(page, () => document.querySelector('#serialIn').value === ''));
await page.screenshot({ path: path.join(outDir, 'mobile-serial.png') });
await page.click('#dock button[aria-label="半屏"]');
await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'half');
await page.click('#sheetGrab');
report('串口抽屉：收回 peek', await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'peek'), await sheet());

// 构建树点 BME280 → 属性抽屉 → 预设 32°
await page.click('[data-mtool="lib"]');
await waitFor(page, () => !!document.querySelector('[data-left="tree"]'));
await page.click('[data-left="tree"]');
await sleep(150);
report('构建树：点 BME280', await clickText('#tree [role=treeitem]', 'BME280'));
report('属性抽屉打开', await waitFor(page, () => !document.querySelector('#props')?.closest('[hidden]') && document.querySelector('#props')?.getBoundingClientRect().height > 100));
report('属性抽屉：关闭钮可点', (await tappable('#propsClose')) === 'ok', await tappable('#propsClose'));
const thumb = await page.evaluate(() => {
  const s = document.querySelector('#props input[type=range]');
  return s ? parseFloat(getComputedStyle(s, '::-webkit-slider-thumb').height) || s.getBoundingClientRect().height : 0;
});
report('属性抽屉：滑块够大（≥ 28px）', thumb >= 28, `${thumb}px`);
report('属性抽屉：有数字输入', await page.evaluate(() => !!document.querySelector('#props input[type=number]')));
report('属性抽屉：点预设 32°', await clickText('#props button', '32°'));
const t32 = await waitFor(page, () => /T=32\.00/.test(document.querySelector('#sheetPeek')?.textContent ?? ''), null, 15000);
report('固件读数变成 32 °C', t32, await page.$eval('#sheetPeek', (e) => e.textContent.slice(0, 60)));
await page.screenshot({ path: path.join(outDir, 'mobile-props.png') });
await page.click('#propsClose');
report('属性抽屉能关', await waitFor(page, () => !document.querySelector('#props') || document.querySelector('#props').getBoundingClientRect().height === 0));

// 零件库全屏页
await page.click('[data-mtool="lib"]');
await waitFor(page, () => !!document.querySelector('[data-left="lib"]'));
await page.click('[data-left="lib"]');
await waitFor(page, () => document.querySelectorAll('#partLib a[data-lib]').length > 5);
const nAll = await page.$$eval('#partLib a[data-lib]', (a) => a.length);
// 全屏页 = 零件库所在的左栏铺满视口（零件库本身有内边距）
const lib = await page.evaluate(() => {
  const r = document.querySelector('#partLib').closest('aside').getBoundingClientRect();
  return [r.left, r.top, r.width, r.height].map(Math.round);
});
report('零件库：全屏页', lib[0] === 0 && lib[1] === 0 && lib[2] >= 389 && lib[3] >= 843, lib.join(','));
const kind = await page.$$eval('#partLib [data-kind]', (b) => b.map((x) => x.dataset.kind).filter((k) => k && k !== 'all'));
await page.click(`#partLib [data-kind="${kind[0]}"]`);
await sleep(150);
const nKind = await page.$$eval('#partLib a[data-lib]', (a) => a.length);
report('零件库：分类筛选', nKind > 0 && nKind < nAll, `${nAll} → ${nKind}（${kind[0]}）`);
report('零件库：关闭钮可点', (await tappable('#libClose')) === 'ok', await tappable('#libClose'));
await page.click('#libClose');
report('零件库能关', await waitFor(page, () => !document.querySelector('#partLib') || document.querySelector('#partLib').getBoundingClientRect().height === 0));

// 连线：横幅选线 → 按住引脚有放大镜 → 松手接上
await page.click('[data-mtool="wire"]');
report('连线：横幅列出可改的线', await waitFor(page, () => document.querySelectorAll('#wireBanner [data-wpick]').length > 3));
await page.click('#wireBanner [data-wpick="wire:3V3~bme280:VIN"]');
await waitFor(page, () => document.querySelectorAll('#pinRings [data-ring]').length > 10);
const p5 = await page.$eval('#pinRings [data-ring="5V"]', (e) => {
  const r = e.getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
});
await page.mouse.move(p5[0], p5[1]);
await page.mouse.down();
const lens = await waitFor(page, () => !!document.querySelector('#pinLens'), null, 3000);
report('连线：按住引脚出放大镜', lens && /5V/.test(await page.$eval('#pinLens', (e) => e.textContent)), lens ? await page.$eval('#pinLens', (e) => e.textContent.slice(0, 30)) : '');
await page.screenshot({ path: path.join(outDir, 'mobile-lens.png') });
await page.mouse.up();
report('连线：松手接到 5V → 接错线卡片', await waitFor(page, () => !!document.querySelector('#wrongWire')));
report('接错线卡片：撤销可点', (await tappable('#wrongWire [data-ww="undo"]')) === 'ok', await tappable('#wrongWire [data-ww="undo"]'));
await page.click('#wrongWire [data-ww="undo"]');
report(
  '撤销后回到 3V3、没有问题',
  await waitFor(page, () => !document.querySelector('#wrongWire') && globalThis.__tbApp.faults().length === 0),
  await page.evaluate(() => JSON.stringify(globalThis.__tbApp.faults()).slice(0, 200)),
);
await page.keyboard.press('Escape');
await waitFor(page, () => !document.querySelector('#wireBanner'));

// ---- 组装：锁定页
await page.click('#steps [data-step="assemble"]');
await waitFor(page, () => globalThis.__tbApp.store.get().step === 'assemble' && !!document.querySelector('#toBench'));
await stepCheck('组装（锁定）');
report('组装锁定：「回实验台」可点', (await tappable('#toBench')) === 'ok', await tappable('#toBench'));

// 预置检查点进度（和 asm3d.mjs 一样；"自己的固件通过才算"在 levels.mjs 里测）后解锁
await page.evaluate(() => {
  const p = {};
  for (const id of ['01', '02', '03', '04', '05', '06']) p[id] = { fp: 'test', at: '预置' };
  localStorage.setItem('tryboard-app-checks:weather', JSON.stringify(p));
  localStorage.removeItem('tryboard-app-asm:weather');
});
await page.reload({ waitUntil: 'load' });
await waitFor(page, () => globalThis.__tbApp?.store.get().step === 'assemble' && !!document.querySelector('.asm3d-stage canvas'), null, 40000);
await sleep(500);
await stepCheck('组装');
report('组装：3D 在最上面', await page.evaluate(() => {
  const a = document.querySelector('.asm3d-stage').getBoundingClientRect();
  const p = document.querySelector('#props').getBoundingClientRect();
  return a.top < p.top && a.width >= innerWidth - 40;
}));
for (let i = 0; i < 12; i++) {
  const done = await page.evaluate(() => !document.querySelector('#mNext #next').disabled);
  if (done) break;
  // 一层一层装：有「装上…」点它，碰到放哪儿的选择就选第一个
  if (!(await clickText('#props button', '装上'))) await clickText('#props button', '放');
  await sleep(700);
}
report('组装：装完六层，主按钮可点', await page.evaluate(() => !document.querySelector('#mNext #next').disabled) && (await tappable('#mNext #next')) === 'ok');
await page.screenshot({ path: path.join(outDir, 'mobile-assemble.png') });

// ---- 成品
await page.click('#mNext #next');
await waitFor(page, () => globalThis.__tbApp.store.get().step === 'product' && !!document.querySelector('#mSerial'), null, 20000);
// 等固件起来、串口条有读数再按键
await waitFor(page, () => /T=/.test(document.querySelector('#mSerial')?.textContent ?? ''), null, 20000);
await stepCheck('成品');
report('成品：一行串口条', (await visible('#mSerial')) && /T=/.test(await page.$eval('#mSerial', (e) => e.textContent)));
// 成品全屏（P2-17）：3D 占满顶栏以下、底部面板之上；底部面板贴底
const full = () =>
  page.evaluate(() => {
    const m = document.querySelector('#mProduct')?.getBoundingClientRect();
    const sh = document.querySelector('#mProductSheet')?.getBoundingClientRect();
    const top = document.querySelector('#steps')?.getBoundingClientRect();
    const cv = [...document.querySelectorAll('#mProduct canvas, #mProduct svg.prod-svg')].map((e) => e.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!m || !sh || !top || !cv) return `missing m=${!!m} sheet=${!!sh} view=${!!cv}`;
    const ok = Math.abs(m.bottom - innerHeight) < 1 && Math.abs(sh.bottom - innerHeight) < 1 && m.top <= top.bottom + 1 && cv.width >= innerWidth - 1 && cv.height >= innerHeight * 0.45;
    return ok ? 'ok' : `m=${m.top}..${m.bottom} sheet=${sh.top}..${sh.bottom} view=${cv.width}x${cv.height}`;
  });
report('成品：3D 全屏', (await full()) === 'ok', await full());
// BOOT 在底部按键格里；看按下 / 松开（pointerdown / up），要真实点击，不能只派 click 事件
report('成品：按 BOOT 可点', (await tappable('#toolbar [data-tool="p-boot"]')) === 'ok', await tappable('#toolbar [data-tool="p-boot"]'));
await page.click('#toolbar [data-tool="p-boot"]');
const unitF = await waitFor(page, () => /UNIT F/.test(document.querySelector('#console')?.textContent ?? ''), null, 15000);
report('成品：按 BOOT 后串口出 UNIT F', unitF, unitF ? '' : await page.evaluate(() => `console=${(document.querySelector('#console')?.textContent ?? '').slice(-120)}`));
await page.screenshot({ path: path.join(outDir, 'mobile-product.png') });
// 点串口条 → 实验台同一个串口抽屉（半屏），收起回到全屏
report('成品：串口条可点', (await tappable('#mSerialOpen')) === 'ok', await tappable('#mSerialOpen'));
await page.click('#mSerialOpen');
const half = await waitFor(page, () => document.querySelector('#dock')?.dataset.sheet === 'half' && document.querySelector('#dock')?.getBoundingClientRect().height > innerHeight * 0.4, null, 3000);
report('成品：点串口条开半屏串口抽屉', half, half ? '' : `sheet=${await page.evaluate(() => document.querySelector('#dock')?.dataset.sheet)}`);
await page.screenshot({ path: path.join(outDir, 'mobile-product-serial.png') });
if (half) await page.click('#sheetGrab');
report('成品：串口抽屉收起后串口条回来', await waitFor(page, () => !document.querySelector('#dock[data-sheet="half"]') && !!document.querySelector('#mSerialOpen'), null, 3000));
report('成品：收起后串口条可点', (await tappable('#mSerialOpen')) === 'ok', await tappable('#mSerialOpen'));

// ---- 示例页（U-07/U-10）：空白作品 + 示例固件，只有采购 / 实验台两步；换固件抽屉要盖在串口抽屉、底栏之上
await page.goto(`${base}/app?work=blank&example=bme280#bench`, { waitUntil: 'load' });
await waitFor(page, () => globalThis.__tbApp?.store.get().step === 'bench' && globalThis.__tbApp.store.get().simSeconds > 0.5, null, 30000);
await stepCheck('示例页');
report('示例页：只有两步', (await page.$$eval('#steps [data-step]', (b) => b.map((x) => x.dataset.step).join())) === 'shop,bench');
await page.click('#moreBtn');
await waitFor(page, () => !!document.querySelector('#moreMenu #swapFw'));
await page.click('#moreMenu #swapFw');
report('示例页：换固件抽屉打开', await waitFor(page, () => !!document.querySelector('#fwMenu [data-fw="upload"]')));
await stepCheck('换固件抽屉');
{
  const bad = [];
  for (const s of ['[data-chip="esp32c3"]', '[data-chip="esp32s3"]', '[data-ex="bme280"]', '[data-fw="all"]', '[data-fw="upload"]']) {
    const r = await tappable(`#fwMenu ${s}`);
    if (r !== 'ok') bad.push(`${s}:${r}`);
  }
  report('换固件抽屉：芯片、示例、全部、上传都 ≥ 44px 且没被盖住', bad.length === 0, bad.join(' '));
}
await page.screenshot({ path: path.join(outDir, 'mobile-fwsheet.png') });
await page.keyboard.press('Escape');
report('换固件抽屉：Esc 能关', await waitFor(page, () => !document.querySelector('#fwMenu')));

// ---- 每个成品（预览模式 ?work=X#product）：全屏、无横向滚动、按键格每个键都够大且点得到，按动作键不报错
const WORKS = { weather: 'p-boot', spin: 'p-boot', lens: 'p-boot', usbkey: 'p-key-4', lamp: 'p-knob-r', ruler: 'p-near', tilt: 'p-tilt-r', imu: 'p-level' };
for (const [w, key] of Object.entries(WORKS)) {
  await page.goto(`${base}/app?work=${w}#product`, { waitUntil: 'load' });
  const up = await waitFor(page, (k) => globalThis.__tbApp?.store.get().step === 'product' && !!document.querySelector(`#toolbar [data-tool="${k}"]`), key, 30000);
  if (!up) {
    report(`成品 ${w}：按键格出来`, false);
    continue;
  }
  await sleep(1500);
  await stepCheck(`成品 ${w}`);
  report(`成品 ${w}：3D 全屏`, (await full()) === 'ok', await full());
  const tools = await page.$$eval('#toolbar [data-tool]', (b) => b.map((x) => x.dataset.tool));
  const bad = [];
  for (const t of tools) {
    const r = await tappable(`#toolbar [data-tool="${t}"]`);
    if (r !== 'ok') bad.push(`${t}:${r}`);
  }
  report(`成品 ${w}：按键格 ${tools.length} 键都 ≥ 44px 且点得到`, tools.length >= 3 && bad.length === 0, bad.join(' '));
  await page.click(`#toolbar [data-tool="${key}"]`);
  await sleep(800);
  await page.screenshot({ path: path.join(outDir, `mobile-product-${w}.png`) });
}

// ---- 虚拟手机（C-01）：BLE 示例 → 构建树「虚拟手机」→ 属性抽屉里扫描、连接；按钮够大、无横向滚动
await page.goto(`${base}/app?work=blank&example=c3-ble-hr#bench`, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
if (await waitFor(page, () => globalThis.__tbApp?.store.get().simSeconds > 0.5, null, 30000)) {
  await page.click('[data-mtool="lib"]');
  await waitFor(page, () => !!document.querySelector('[data-left="tree"]'));
  await page.click('[data-left="tree"]');
  report('虚拟手机：构建树里有', await waitFor(page, () => !!document.querySelector('#tree [data-kind="ble"]')));
  await page.click('#tree [data-kind="ble"]');
  report('虚拟手机：属性抽屉里出现', await waitFor(page, () => !!document.querySelector('#blePhone #bleScan')));
  report('虚拟手机：扫描键 ≥ 44px', (await tappable('#bleScan')) === 'ok', await tappable('#bleScan'));
  await page.click('#bleScan');
  report('虚拟手机：扫到 TryBoard-HR', await waitFor(page, () => !!document.querySelector('#blePhone [data-dev] [data-act="connect"]'), null, 15000));
  await page.click('#blePhone [data-dev] [data-act="connect"]');
  report('虚拟手机：连上、出服务', await waitFor(page, () => !!document.querySelector('[data-char="2A37"]'), null, 15000));
  report('虚拟手机：#bleDisc 可点', (await tappable('#bleDisc')) === 'ok', await tappable('#bleDisc'));
  await page.$eval('[data-char="FFE1"]', (e) => e.scrollIntoView({ block: 'center' }));
  await sleep(200);
  for (const s of ['[data-char="2A19"] [data-act="read"]', '[data-char="FFE1"] [data-act="write"]'])
    report(`虚拟手机：${s} 可点`, (await tappable(s)) === 'ok', await tappable(s));
  await stepCheck('虚拟手机');
  await page.screenshot({ path: path.join(outDir, 'mobile-ble-phone.png') });
} else report('BLE 示例启动', false);

report('不请求外部域名', external.length === 0, external.slice(0, 3).join(' | '));
report('页面无报错', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`[mobile] ${fails ? 'FAIL' : 'PASS'}（${fails} 项失败）`);
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
