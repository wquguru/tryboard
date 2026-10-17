// 检查点 / 装配 / 首页的网页验收（旧关卡页 levels.html 已并入工作台 app.html 的检查点，P0-21）：
//  1. 工作台每个作品的检查点跑参考固件，必须"通过"，且运行指纹与 tools/check.py（原生内核）完全一致
//  2. 旧链接 levels.html#04 / #07-lens 重定向到 app.html 并选中对应检查点
//  3. 上传自己的固件验收，进度记住（刷新后结论按钮仍是 1/6）
//  4. 装配（views/assembly，实验台 index.html 的"装配 · 成品"视图）：鼠标拖拽、顺序错被拦、
//     BME280 贴芯片开机后固件读数偏高 2.5 ℃、spin 舵盘装偏提示、lens 开机圆屏有画面
//  5. 作品首页：三张卡片跑真实固件（串口读数、OLED / 圆屏有画面、按 BOOT 屏幕重画），三个入口到达正确页面，手机宽度不溢出
//  6. 实验台 weather 示例的装配视图：点选装配 → 开机 → 成品屏幕有画面
// 用法：node tools/webtest/levels.mjs（先 tools/build_web.sh）。截图在 Reviews/web/levels-*.png
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(dist, u === '/' ? 'index.html' : u);
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
  console.log(`[levels] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function open(url) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await page.goto(base + url, { waitUntil: 'load' });
  return page;
}
/** 点一个会被重画的元素：在页面里按选择器现找现点（不持有节点句柄，避免 Node is detached） */
async function clickEl(page, sel) {
  await page.waitForSelector(sel, { timeout: 30000 });
  for (let i = 0; i < 10; i++) {
    // HTML 元素直接 click()；SVG 里的零件（没有 click()）用真鼠标点，节点被换掉就重找
    const kind = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return 'none'; if (typeof e.click === 'function') { e.click(); return 'done'; } return 'svg'; }, sel);
    if (kind === 'done') return;
    if (kind === 'svg') {
      try {
        await page.click(sel);
        return;
      } catch {
        /* 重画中，重找 */
      }
    }
    await sleep(200);
  }
  throw new Error(`点不到 ${sel}`);
}
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}

// 原生内核的结论与指纹
const native = {};
const cli = (() => { try { return execFileSync(path.join(root, 'tools/check.py'), ['--ref', '--all'], { encoding: 'utf8' }); } catch (e) { return e.stdout; } })();
for (const m of cli.matchAll(/检查点 ([\w-]+) .*：(通过|未通过)\s+指纹 (\S+)/g)) native[m[1]] = { ok: m[2] === '通过', fp: m[3] };

// ---- 1. 工作台检查点：参考固件，指纹与命令行一致
const fpOf = (page) => page.$eval('#props .kv .v.fp', (e) => e.textContent.trim()).catch(() => '');
async function runRef(page, id) {
  // 构建树在上电 / 时间线更新时会整块重画：点的那一刻节点可能刚被换掉（Node is detached），重找一次再点
  for (let i = 0; ; i++) {
    await page.waitForSelector(`#tree .tn[data-kind="checkpoint"][data-id="${id}"]`, { timeout: 30000 });
    try {
      await page.click(`#tree .tn[data-kind="checkpoint"][data-id="${id}"]`);
      break;
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(300);
    }
  }
  await page.waitForSelector('#runRef:not([disabled])', { timeout: 30000 });
  await page.click('#runRef');
  await waitFor(page, () => !!document.querySelector('#props .verdict-line') && !document.querySelector('#runRef')?.disabled && !document.querySelector('#props .drop.busy'), null, 90000);
  const text = await page.$eval('#props', (e) => e.textContent).catch(() => '');
  const raw = await page.evaluate(() => globalThis.__tbLastVerify);
  fs.writeFileSync(path.join(outDir, `levels-${id}-web.json`), JSON.stringify(raw, null, 1));
  return { ok: /✓ 通过/.test(text), fp: await fpOf(page), text };
}
for (const [work, cps] of [['weather', ['01', '02', '03', '04', '05', '06']], ['spin', ['spin-1', 'spin-2', '07-spin']], ['lens', ['lens-1', 'lens-2', '07-lens']], ['usbkey', ['usbkey-1', 'usbkey-2', 'usbkey-3']], ['lamp', ['lamp-1', 'lamp-2', 'lamp-3']], ['ruler', ['ruler-1', 'ruler-2', 'ruler-3']], ['tilt', ['tilt-1', 'tilt-2', 'tilt-3']]]) {
  const page = await open(`/app.html?work=${work}#bench`);
  for (const id of cps) {
    const r = await runRef(page, id);
    const n = native[id];
    report(`检查点 ${id}（${work}）参考固件`, r.ok && n?.ok && r.fp === n.fp, `网页 ${r.ok ? '通过' : '未通过'} ${r.fp} / 命令行 ${n?.fp}`);
    if (!r.ok) console.log(r.text.slice(0, 600));
    if (id === '06' || id === '07-spin') await page.screenshot({ path: path.join(outDir, `levels-cp-${id}.png`) });
  }
  await page.close();
}

// ---- 2. 旧关卡页重定向
for (const [hash, work, cp] of [['04', 'weather', '04'], ['07-lens', 'lens', '07-lens'], ['', 'weather', null]]) {
  const page = await open(`/levels.html${hash ? '#' + hash : ''}`);
  await waitFor(page, () => location.pathname.endsWith('/app.html'), null, 10000);
  const sel = cp ? await waitFor(page, (cp) => document.querySelector(`#tree .tn[data-kind="checkpoint"][data-id="${cp}"]`)?.getAttribute('aria-selected') === 'true' && document.querySelector('#props')?.textContent.includes(`检查点 ${cp}`), cp, 30000) : true;
  const u = new URL(page.url());
  report(`旧链接 levels.html#${hash} → app.html?work=${work}${cp ? '&cp=' + cp : ''}#bench${cp ? '，选中检查点 ' + cp : ''}`, u.pathname.endsWith('/app.html') && u.searchParams.get('work') === work && u.searchParams.get('cp') === cp && u.hash === '#bench' && sel, page.url().replace(base, ''));
  if (hash === '04') await page.screenshot({ path: path.join(outDir, 'levels-redirect-04.png') });
  await page.close();
}

// ---- 3. 上传自己的固件（C3 版点灯也满足检查点 01 的条件），进度记住
{
  const page = await open('/app.html?work=weather&cp=01#bench');
  await page.waitForSelector('#props [data-drop="check"] input', { timeout: 30000 });
  const input = await page.$('#props [data-drop="check"] input');
  await input.uploadFile(path.join(root, 'firmware/build/blink/flash.bin'));
  await waitFor(page, () => /✓ 通过/.test(document.querySelector('#props .verdict-line')?.textContent ?? ''), null, 90000);
  const who = await page.$eval('#props .verdict-line', (e) => e.textContent).catch(() => '');
  const tree = await page.$eval('#tree .tn[data-kind="checkpoint"][data-id="01"] .tn-st', (e) => e.className).catch(() => '');
  await page.reload({ waitUntil: 'load' });
  const kept = await waitFor(page, () => /检查点 1\/6/.test(document.getElementById('verdict')?.textContent ?? ''), null, 30000);
  report('上传自己的固件 → 检查点 01 通过，刷新后进度还在（1/6）', /flash\.bin/.test(who) && /ok/.test(tree) && kept, who.trim());
  await page.evaluate(() => localStorage.clear());
  await page.close();
}

// ---- 4. 装配：实验台的"装配 · 成品"视图（与组装步骤 P0-16 接手前共用 views/assembly）
async function openAsm(example) {
  const p = await open(`/index.html?example=${example}`);
  await p.waitForSelector('#viewTabs:not([hidden])', { timeout: 30000 });
  await p.click('#viewTabs [data-v="asm"]');
  await p.waitForSelector('#asmBox [data-part]');
  return p;
}
{
  const page = await openAsm('weather');
  // 鼠标拖拽：零件卡片 → 舞台上该层的位置（SVG 坐标换成屏幕坐标）
  const drag = async (part, sx, sy) => {
    const from = await page.$eval(`#asmBox [data-part="${part}"]`, (g) => { const r = g.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    const to = await page.$eval('#asmBox svg', (s, [x, y]) => { const p = new DOMPoint(x, y).matrixTransform(s.getScreenCTM()); return [p.x, p.y]; }, [sx, sy]);
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8);
    await page.mouse.up();
    await sleep(50);
  };
  const iso = (L, x, y) => [505 + 0.866 * x - 0.866 * y, 292 - L * 30 + 0.5 * x + 0.5 * y];
  const assemble = async (spot) => {
    for (const [L, k] of ['shell', 'board', 'bme', 'servo', 'oled', 'front'].entries()) {
      const [x, y] = k === 'bme' ? (spot === 'A' ? iso(2, 146, 55) : iso(2, 92, 43)) : iso(L, 90, 50);
      await drag(k, x, y);
    }
    return page.$eval('#asmBox', (e) => e.textContent.includes('6/6'));
  };
  await drag('front', ...iso(0, 90, 50));
  report('装配：顺序错被拦下', await page.$eval('#asmBox', (e) => e.textContent.includes('还不能装「前面板」')));
  report('装配：鼠标拖拽 6/6（传感器贴芯片）', await assemble('B'));
  await page.click('#asmBox [data-k="power"]');
  // 室温 23.5，传感器贴着芯片：固件读到的温度偏高 2.5 ℃（第 06 关原来的"装法改变读数"用例）
  const hot = await waitFor(page, () => /T=26\.00 C/.test(document.getElementById('console')?.textContent ?? ''), null, 20000);
  report('装配：BME280 贴芯片 → 开机后固件读数 T=26.00（室温 23.5 + 2.5）', hot);
  await page.screenshot({ path: path.join(outDir, 'levels-asm-bad.png') });
  await page.click('#asmBox [data-k="reopen"]');
  await page.click('#asmBox [data-k="reset"]');
  report('装配：鼠标拖拽 6/6（通风口旁）', await assemble('A'));
  await page.$eval('#console', (e) => (e.textContent = ''));
  await page.click('#asmBox [data-k="power"]');
  const lit = await waitFor(page, () => !!document.querySelector('#asmBox [data-k="product"]:not([hidden]) image[href]') && /T=23\.50 C/.test(document.getElementById('console')?.textContent ?? ''), null, 20000);
  report('装配：通风口旁 → 开机后读数 T=23.50、成品屏幕有画面', lit);
  await page.screenshot({ path: path.join(outDir, 'levels-asm-product.png') });
  await page.close();
}
{
  // spin：舵盘直接按上（错一个齿）→ 开机后成品上提示偏角，圆屏有画面
  const page = await openAsm('spin');
  await page.click('#asmBox [data-part="base"]');
  await page.click('#asmBox [data-part="servo"]');
  await page.click('#asmBox [data-k="pickX"]');
  for (const k of ['board', 'lcd', 'body', 'hair']) await page.click(`#asmBox [data-part="${k}"]`);
  await page.click('#asmBox [data-k="power"]');
  const ok = await waitFor(page, () => !!document.querySelector('#asmBox [data-k="product"]:not([hidden]) image[href]') && /装偏 14\.4°/.test(document.querySelector('#asmBox [data-k="note"]')?.textContent ?? ''), null, 20000);
  report('装配 · spin：舵盘装偏 → 成品提示偏 14.4°，圆屏有画面', ok);
  await page.screenshot({ path: path.join(outDir, 'levels-asm-spin.png') });
  await page.close();
}
{
  const page = await openAsm('lens');
  for (const k of ['base', 'board', 'lcd', 'bezel', 'dome']) await page.click(`#asmBox [data-part="${k}"]`);
  await page.click('#asmBox [data-k="pickH"]');
  await page.click('#asmBox [data-k="power"]');
  const ok = await waitFor(page, () => !!document.querySelector('#asmBox [data-k="product"]:not([hidden]) image[href]'), null, 20000);
  report('装配 · lens → 开机后圆屏有画面', ok);
  await page.screenshot({ path: path.join(outDir, 'levels-asm-lens.png') });
  await page.close();
}

{
  // P2-09：超声波尺子在工作台组装，探头缩在孔里 → 开机复测里模拟器的 HC-SR04 也只能量到孔壁（读数 3 cm、蜂鸣器一直响），
  // 判定项真的挂掉；改成"伸出前面板"再复测通过。先用自己上传的固件过三个检查点（解锁组装）
  const page = await open('/app.html?work=ruler#bench');
  try {
    for (const [id, ref] of [['ruler-1', 'ruler-dist'], ['ruler-2', 'ruler-oled'], ['ruler-3', 'ruler']]) {
      await page.waitForSelector(`#tree .tn[data-kind="checkpoint"][data-id="${id}"]`, { timeout: 30000 });
      await clickEl(page, `#tree .tn[data-kind="checkpoint"][data-id="${id}"]`);
      await page.waitForSelector('#props [data-drop="check"] input:not([disabled])', { timeout: 30000 });
      // 属性面板会被重画：拿到输入框就立刻上传，节点被换掉就重找
      for (let k = 0; ; k++) {
        try {
          const input = await page.$('#props [data-drop="check"] input:not([disabled])');
          await input.uploadFile(path.join(root, `firmware/build/${ref}/flash.bin`));
          break;
        } catch (e) {
          if (k >= 4) throw e;
          await sleep(300);
        }
      }
      // 先等进入"模拟中"，再等这一关的结论（免得读到上一关的结论就去点下一关）
      await waitFor(page, () => !!document.querySelector('#props .drop.busy'), null, 15000);
      await waitFor(page, () => /✓ 通过|✗/.test(document.querySelector('#props .verdict-line')?.textContent ?? '') && !document.querySelector('#props .drop.busy'), null, 120000);
    }
    await page.evaluate(() => (location.hash = 'assemble'));
    await page.waitForSelector('.asm-box [data-part]', { timeout: 30000 });
    const build = async (pick) => {
      for (const k of ['shell', 'board', 'sonar', 'buzzer', 'oled', 'front']) {
        await clickEl(page, `.asm-box [data-part="${k}"]`);
        if (k === 'sonar') await clickEl(page, `.asm-box [data-k="pick${pick}"]`);
      }
      await clickEl(page, '#toolbar [data-tool="asm-retest"]');
      // 先等进入"复测中"，再等跑完（免得读到上一次的结果）
      await waitFor(page, () => /复测中/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 10000);
      await waitFor(page, () => !!document.querySelector('#props .verdict-line') && !/复测中/.test(document.querySelector('#retestBtn')?.textContent ?? ''), null, 120000);
      return page.$eval('#props', (e) => e.textContent);
    };
    const bad = await build('B');
    report('组装 · ruler：探头缩在孔里 → 开机复测读不到 15 cm、节奏不对（装法进模拟器）', /✗ 未通过/.test(bad) && /✗串口出现 “DIST 15\.0 cm”/.test(bad) && /1\.8–2\.5 s 响 0 声/.test(bad), bad.match(/复测结果.{0,160}/)?.[0]);
    await clickEl(page, '#toolbar [data-tool="asm-reset"]').catch(() => {});
    const good = await build('A');
    report('组装 · ruler：探头伸出前面板 → 开机复测通过', /✓ 通过/.test(good) && /装配 6\/6，没有警告/.test(good), good.match(/复测结果.{0,60}/)?.[0]);
  } catch (e) {
    report('组装 · ruler：流程跑完', false, String(e).slice(0, 200));
  }
  await page.close();
}

// ---- 5. 作品首页
{
  const home = await open('/home.html');
  const cards = await home.$$eval('.wk', (els) => els.map((e) => ({ work: e.dataset.work, go: e.querySelector('[data-go]')?.getAttribute('href'), cps: e.dataset.cps })));
  // 卡片由作品定义（web/src/app/works.ts）生成：P2-12 加了 USB 小键盘，P2-09 加了旋钮台灯、超声波尺子、体感小人
  report('首页：七张作品卡（气象站 / 小黄 / 透镜 / USB 小键盘 / 旋钮台灯 / 超声波尺子 / 体感小人）', cards.map((c) => c.work).join() === 'weather,spin,lens,usbkey,lamp,ruler,tilt', JSON.stringify(cards.map((c) => c.work)));
  await home.screenshot({ path: path.join(outDir, 'levels-home-0.png') });
  // 气象站卡：跑真实固件 → 状态行是串口读数、成品屏幕有 OLED 画面；按住 BOOT → 固件切 ℉，屏幕重画
  await home.click('[data-run="weather"]');
  const reading = await waitFor(home, () => /T=23\.50 C/.test(document.querySelector('.wk[data-work="weather"] [data-status]').textContent), null, 30000);
  const oled = await waitFor(home, () => !!document.querySelector('.wk[data-work="weather"] image[data-k="oled"][href]'));
  report('首页：气象站卡跑真实固件（串口 T=23.50、OLED 有画面）', reading && oled);
  const before = await home.$eval('.wk[data-work="weather"] image[data-k="oled"]', (e) => e.getAttribute('href'));
  const b = await home.$eval('.wk[data-work="weather"] [data-k="boot"]', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await home.mouse.move(b[0], b[1]);
  await home.mouse.down();
  await sleep(250);
  await home.mouse.up();
  const changed = await waitFor(home, (h) => document.querySelector('.wk[data-work="weather"] image[data-k="oled"]').getAttribute('href') !== h, before, 5000);
  report('首页：按 BOOT 后屏幕重画（切 ℉）', changed);
  // 小黄卡：跑真实固件 → 圆屏有画面；同一时间只跑一张（气象站回到示意图）
  await home.click('[data-run="spin"]');
  const spin = await waitFor(home, () => !!document.querySelector('.wk[data-work="spin"] image[data-k="lcd"][href]'), null, 20000);
  const single = await home.$$eval('.wk.live', (e) => e.map((x) => x.dataset.work).join());
  report('首页：小黄卡跑真实固件 → 圆屏有画面，同时只跑一张', spin && single === 'spin', single);
  await sleep(600);
  await home.screenshot({ path: path.join(outDir, 'levels-home-spin.png') });
  await home.click('[data-run="lens"]');
  const lens = await waitFor(home, () => !!document.querySelector('.wk[data-work="lens"] image[data-k="lcd"][href]'), null, 20000);
  report('首页：透镜卡跑真实固件 → 圆屏有画面', lens);
  // P2-09 自动生成的卡片也能跑真实固件：尺子卡 OLED 有画面、读数随演示挡板变；台灯卡灯条亮
  await home.click('[data-run="ruler"]');
  const ruler = await waitFor(home, () => !!document.querySelector('.wk[data-work="ruler"] image[data-k="oled"][href]') && /DIST \d/.test(document.querySelector('.wk[data-work="ruler"] [data-status]').textContent), null, 30000);
  report('首页：尺子卡跑真实固件 → OLED 有画面、串口有距离', ruler);
  await home.click('[data-run="lamp"]');
  const lamp = await waitFor(home, () => document.querySelector('.wk[data-work="lamp"] [data-k="led0"]')?.getAttribute('fill') !== '#2A2A28', null, 30000);
  report('首页：台灯卡跑真实固件 → 灯带亮', lamp);
  // USB 小键盘卡：跑真实固件 → 虚拟电脑枚举出 TryBoard Macro Pad；点 K1 键帽 → 屏幕上打出 a
  await home.click('[data-run="usbkey"]');
  const enumd = await waitFor(home, () => /TryBoard Macro Pad/.test(document.querySelector('.wk[data-work="usbkey"] [data-k="dev"]')?.textContent ?? ''), null, 20000);
  const k1 = await home.$eval('.wk[data-work="usbkey"] [data-k="key0"]', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await home.mouse.move(k1[0], k1[1]);
  await home.mouse.down();
  await sleep(200);
  await home.mouse.up();
  const typedA = await waitFor(home, () => /^a▌?$/.test(document.querySelector('.wk[data-work="usbkey"] [data-k="l0"]')?.textContent ?? ''), null, 10000);
  report('首页：USB 小键盘卡跑真实固件 → 电脑枚举出键盘，点 K1 打出 a', enumd && typedA);
  await home.screenshot({ path: path.join(outDir, 'levels-home-full.png'), fullPage: true });
  await home.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(300);
  const overflow = await home.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  report('首页：手机宽度无横向滚动', !overflow);
  await home.screenshot({ path: path.join(outDir, 'levels-home-phone.png') });
  await home.close();
  // 入口：每张卡的"做这个"进采购（卡上 data-cps 的检查点数与工作台一致），"用选型助手"进选型助手，"我有固件了"进空白实验台
  for (const c of cards) {
    const p = await open('/home.html');
    await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click(`.wk[data-work="${c.work}"] [data-go]`)]);
    const u = new URL(p.url());
    const n = c.cps.match(/\d+/)?.[0];
    // 采购页的结论按钮显示规则提醒数（P0-07 起），检查点进度要到实验台看
    await p.evaluate(() => (location.hash = 'bench'));
    const v = await waitFor(p, (n) => new RegExp(`检查点 0?\\d*/${n}`).test(document.getElementById('verdict')?.textContent ?? ''), n, 30000);
    report(`首页「做这个」（${c.work}）→ app.html?work=${c.work}#shop，检查点数 ${n} 与工作台一致`, u.pathname.endsWith('/app.html') && u.searchParams.get('work') === c.work && u.hash === '#shop' && v, p.url().replace(base, ''));
    await p.close();
  }
  for (const [sel, want, check] of [['#ownIdea', '/advisor.html', () => !!document.querySelector('#templates')], ['#haveFw', '/app.html', () => new URLSearchParams(location.search).get('work') === 'blank' && location.hash === '#bench' && /空白实验台/.test(document.getElementById('workName')?.textContent ?? '')]]) {
    const p = await open('/home.html');
    await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click(sel)]);
    const ok = await waitFor(p, check, null, 15000);
    report(`首页入口 ${sel} → ${want}`, new URL(p.url()).pathname.endsWith(want) && ok, p.url().replace(base, ''));
    await p.close();
  }
}

// ---- 6. 实验台 weather 示例的装配视图（键盘 / 点选方式装配）
const lab = await open('/index.html?example=weather');
await lab.waitForSelector('#viewTabs:not([hidden])', { timeout: 20000 });
await lab.click('#viewTabs [data-v="asm"]');
for (const k of ['shell', 'board', 'bme']) await lab.click(`#asmBox [data-part="${k}"]`);
await lab.click('#asmBox [data-k="pickA"]');
for (const k of ['servo', 'oled', 'front']) await lab.click(`#asmBox [data-part="${k}"]`);
await lab.click('#asmBox [data-k="power"]');
const labLit = await waitFor(lab, () => !!document.querySelector('#asmBox [data-k="product"]:not([hidden]) image[href]'), null, 20000);
const logged = await lab.$eval('#console', (e) => e.textContent.includes('装配：开机'));
report('实验台：点选装配 → 开机 → 成品有画面，操作记进串口', labLit && logged);
await sleep(800);
await lab.screenshot({ path: path.join(outDir, 'levels-lab-product.png') });
await lab.close();

await browser.close();
server.close();
if (errors.length) console.log('[levels] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[levels] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
