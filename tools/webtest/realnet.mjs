// 「真实网络」开关验收（C-03）：外网用本机假服务器顶替（Chrome --proxy-server 把所有非本机的 http 请求交给它；本机地址默认不走代理），
// 所以这个脚本不访问公网，结果每次一样。真联网的走查在 agent-browser（Reviews/ab/C-03.md）。
//  1. 默认关：c3-http-real 两个外网请求都由虚拟服务器回答；开关 aria-checked=false
//  2. 点开关 → 确认弹层（只放行 HTTP、依赖外网、离线重放）→ 打开 → 重启：
//     example.com 不给跨域头 → 串口「原因 cors」、请求表那一行「失败」+ 跨域说明；httpbin.org 给跨域头 → 「真实回复」
//  3. 「保存回复，离线重放」导出的日志有 realnet=1 和两条 netreply；命令行 --inputs 重放 = 网页串口（逐字节），重放不联网
//  4. 回退到运行中途再继续：用记录的回复，不再联网（假服务器的计数不涨）
//  5. 开着真实网络跑检查点（桌面气象站 01）：结果标「依赖外网」、不显示运行编号
//  6. 手机布局 390×844：⋯ 菜单里有「真实网络」，弹层按钮 ≥ 44px，无横向滚动
// 用法：node tools/webtest/realnet.mjs（先 tools/build_web.sh）。日志与截图在 Reviews/web/realnet-*
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
const FW = path.join(root, 'firmware/build/c3-http-real/flash.bin');
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

// 假外网：example.com 不给跨域头（浏览器拦下），httpbin.org/get 给 Access-Control-Allow-Origin: *
const hits = { example: 0, httpbin: 0 };
const fake = http.createServer((req, res) => {
  // 走代理时 req.url 是绝对地址（http://example.com/）
  const u = new URL(req.url, `http://${req.headers.host ?? 'x'}`);
  const host = u.hostname;
  if (host === 'example.com') {
    hits.example++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    return res.end('<!doctype html><title>Example Domain</title>');
  }
  if (host === 'httpbin.org' && u.pathname === '/get') {
    hits.httpbin++;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end('{\n  "args": {}, \n  "url": "http://httpbin.org/get"\n}\n');
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fport = fake.address().port;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,1000', `--proxy-server=http://127.0.0.1:${fport}`],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[realnet] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const hasText = (page, sel, t, ms = 20000) => waitFor(page, ([s, x]) => (document.querySelector(s)?.textContent ?? '').includes(x), [sel, t], ms);
async function clickTab(page, name) {
  const h = await page.evaluateHandle((n) => [...document.querySelectorAll('#dock [role=tab]')].find((b) => b.textContent.trim().startsWith(n)) ?? null, name);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
}
async function newPage(w, h, mobile) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile });
  // 被浏览器按跨域拦下的那次 fetch 会在控制台报一条 CORS 错误：这正是要演示的情形，不算页面错误
  p.on('pageerror', (e) => errors.push(`${e}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/CORS|Access-Control-Allow-Origin|Failed to load resource|ERR_FAILED/.test(t)) return;
    errors.push(t);
  });
  return p;
}
async function tap(page, sel) {
  const el = await page.waitForSelector(sel, { timeout: 15000 }).catch(() => null);
  if (!el) return false;
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await el.click();
  return true;
}
/** 截下载：点 sel 后拿 Blob 文本（不真的下载） */
const grabDownload = (page, sel) =>
  page.evaluate(async (s) => {
    let blob = null;
    let name = '';
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { name = this.download; };
    document.querySelector(s).click();
    for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 50));
    URL.createObjectURL = orig;
    HTMLAnchorElement.prototype.click = click;
    return { text: blob ? await blob.text() : '', name };
  }, sel);

// ---- 1. 默认关
const page = await newPage(1440, 1000);
await page.goto(base + '/app?work=blank&example=c3-http-real#bench', { waitUntil: 'load' });
report('默认：虚拟服务器回答 example.com', await hasText(page, '#console', 'example.com：虚拟服务器回答（没开真实网络）'));
report('默认：httpbin.org 虚拟 404', await hasText(page, '#console', 'httpbin.org：虚拟服务器回 404（没开真实网络）'));
await hasText(page, '#console', 'TRYBOARD_OK c3-http-real');
report('默认：开关是关的', await page.$eval('#realnetBtn', (b) => b.getAttribute('aria-checked') === 'false'));
report('默认：没有联网', hits.example + hits.httpbin === 0, JSON.stringify(hits));

// ---- 2. 打开 → 确认 → 重启
await page.click('#realnetBtn');
const dlg = await page.waitForSelector('#realnetDlg', { timeout: 5000 }).catch(() => null);
const dlgText = dlg ? await dlg.evaluate((e) => e.textContent) : '';
report('确认弹层：只放行 HTTP / 依赖外网 / 离线重放', /只放行 HTTP/.test(dlgText) && /依赖外网/.test(dlgText) && /离线重放/.test(dlgText), dlgText.slice(0, 40));
await page.screenshot({ path: path.join(outDir, 'realnet-dialog.png') });
await page.click('#realnetDlg [data-act="on"]');
report('打开后开关 aria-checked=true', await waitFor(page, () => document.getElementById('realnetBtn')?.getAttribute('aria-checked') === 'true', null, 3000));
report('弹层关掉', await waitFor(page, () => !document.getElementById('realnetDlg'), null, 3000));
// 重启不清串口面板：和命令行比的是重启之后的部分（从重启前的长度往后找最后一次启动横幅）
const pre = (await fwConsole(page)).length;
await page.click('#runRestart');
report('example.com：串口「浏览器没放行，原因 cors」', await hasText(page, '#console', 'example.com：浏览器没放行，原因 cors'));
report('httpbin.org：串口「真实回复」', await hasText(page, '#console', 'httpbin.org：真实回复，url=http://httpbin.org/get'));
report('TRYBOARD_OK', await hasText(page, '#console', 'TRYBOARD_OK c3-http-real'));
report('假外网各收到请求（example 2 次：fetch + no-cors 诊断；httpbin 1 次）', hits.example === 2 && hits.httpbin === 1, JSON.stringify(hits));
await clickTab(page, '网络');
await page.click('[data-net="reqs"]').catch(() => {});
await waitFor(page, () => !!document.querySelector('#netRows'), null, 5000);
const rows = await page.$$eval('#netRows tbody tr', (l) => l.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())));
const ex = rows.find((r) => r[3].includes('http://example.com/'));
const hb = rows.find((r) => r[3].includes('httpbin.org/get'));
report('请求表：example.com 去向「真实」、状态「失败」、说明是跨域', !!ex && ex[2] === '真实' && ex[4] === '失败' && /跨域/.test(ex[3]), JSON.stringify(ex));
report('请求表：httpbin.org 去向「真实」、状态 200', !!hb && hb[2] === '真实' && hb[4] === '200', JSON.stringify(hb));
report('请求表：表头 时间/方法/去向/地址/状态/耗时', (await page.$$eval('#netRows th', (l) => l.map((t) => t.textContent).join('/'))) === '时间/方法/去向/地址/状态/耗时');
report('「本次已记录 2 条回复」', await hasText(page, '#realnetBar', '本次已记录 2 条回复', 5000), await page.$eval('#realnetBar', (e) => e.textContent).catch(() => ''));
await page.screenshot({ path: path.join(outDir, 'realnet-rows.png') });

// ---- 3. 保存回复 → 命令行重放
await page.click('#runPause');
await waitFor(page, () => /已暂停/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const all = await fwConsole(page);
const live = all.slice(all.indexOf('I (1) cpu_start: Unicore app', pre));
const dl = await grabDownload(page, '#saveReplies');
const inputsFile = path.join(outDir, 'realnet-inputs.txt');
fs.writeFileSync(inputsFile, dl.text);
fs.writeFileSync(path.join(outDir, 'realnet-web.stdout'), live);
const lines = dl.text.split('\n');
report('保存的文件名 *-realnet.txt', /-realnet\.txt$/.test(dl.name), dl.name);
report('日志：0 时刻 realnet=1', lines.some((l) => /^0(\.0+)?:realnet=1$/.test(l)), lines.find((l) => /realnet=/.test(l)) ?? '');
const replies = lines.filter((l) => /:netreply=/.test(l));
report('日志：两条 netreply（#1 cors 失败、#2 200 application/json）', replies.length === 2 && /netreply=1,0,\d+,cors,$/.test(replies[0]) && /netreply=2,200,\d+,application\/json,[A-Za-z0-9+/=]+$/.test(replies[1]), replies.map((l) => l.slice(0, 60)).join(' | '));
const before = { ...hits };
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), '--inputs', inputsFile], { maxBuffer: 64 << 20 });
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'realnet-cli.stdout'), p.stdout);
fs.writeFileSync(path.join(outDir, 'realnet-cli.stderr'), p.stderr);
let at = -1;
if (cli !== live) at = Math.max(0, [...cli].findIndex((c, i) => c !== live[i]));
report('命令行 --inputs 重放 = 网页串口（逐字节）', cli === live && p.status === 0 && cli.includes('httpbin.org：真实回复'),
  cli === live ? `${live.length} 字节，${cycles} 周期` : `第 ${at} 字节起不同（命令行 ${cli.length} / 网页 ${live.length}）：${JSON.stringify(cli.slice(at, at + 50))} vs ${JSON.stringify(live.slice(at, at + 50))}`);
report('命令行重放不联网', hits.example === before.example && hits.httpbin === before.httpbin);

// ---- 4. 回退：时间线回到这次运行的末尾（指纹和当时一样）；再回到两个请求之间、继续跑完（#2 用记录的回复）。两次都不联网
const sk = await page.evaluate(async () => {
  const a = globalThis.__tbApp;
  const steps = a.hist.steps();
  const n = Math.max(...steps.filter((s) => s.op.k === 'run').map((s) => s.op.n));
  const r = await a.hist.seek(steps.findIndex((s) => s.op.k === 'run' && s.op.n === n));
  return r && { same: r.same, fp: r.fingerprint };
});
report('时间线回到这次运行末尾：和当时一模一样', sk?.same === true, JSON.stringify(sk));
const reqAt = (n) => {
  const l = fs.readFileSync(path.join(outDir, 'realnet-cli.stderr'), 'utf8').split('\n').find((x) => x.includes(`real network request #${n} `));
  return l ? Number(l.match(/([\d.]+)s/)[1]) * 1000 : NaN;
};
// 第 1 个回复之后、第 2 个回复之前停住（第 2 个请求已经发出、还没回）
const r1 = log.events.find((e) => e.kind === 'netreply' && e.reply.startsWith('1,'));
const r2 = log.events.find((e) => e.kind === 'netreply' && e.reply.startsWith('2,'));
const mid = r1 && r2 ? Math.max(r1.tMs, reqAt(2)) + (r2.tMs - Math.max(r1.tMs, reqAt(2))) / 2 : NaN;
const mz = await page.evaluate(async (untilMs) => {
  const a = globalThis.__tbApp;
  const lg = await globalThis.__tbInputLog();
  const ev = lg.events.filter((e) => e.kind !== 'power');
  const env0 = ev[0]?.kind === 'env' ? ev.shift() : null;
  await a.session.seek({ flash: a.session.fwBuf, i2c: lg.i2c, lcd: lg.lcd, env: env0 ?? undefined, events: ev, untilMs });
  a.session.continueRun();
  return true;
}, mid).catch((e) => `${e}`);
const okMid = mz === true && (await hasText(page, '#console', 'httpbin.org：真实回复，url=http://httpbin.org/get', 20000));
report(`回到两个回复之间（${(mid / 1000).toFixed(3)} s）再继续：#2 用记录的回复`, okMid, String(mz));
report('回退和继续都不联网', hits.example === before.example && hits.httpbin === before.httpbin, JSON.stringify(hits));
const relog = await page.evaluate(async () => (await globalThis.__tbInputLog()).events.filter((e) => e.kind === 'netreply').map((e) => e.reply));
report('继续后的日志：两条回复与原来相同', relog.length === 2 && relog[0] === r1?.reply && relog[1] === r2?.reply, `${relog.length} 条`);

// ---- 关掉开关：不弹确认
await page.click('#runPause').catch(() => {});
await page.click('#realnetBtn');
await sleep(200);
report('关掉：不弹确认、aria-checked=false', !(await page.$('#realnetDlg')) && (await page.$eval('#realnetBtn', (b) => b.getAttribute('aria-checked'))) === 'false');
await page.close();

// ---- 5. 开着真实网络跑检查点：依赖外网、不记运行编号
const pc = await newPage(1440, 1000);
await pc.goto(base + '/app?work=weather#bench', { waitUntil: 'load' });
await pc.evaluate(() => { try { localStorage.removeItem('tryboard-app-checks:weather'); } catch { /* */ } });
await pc.waitForSelector('#realnetBtn', { timeout: 20000 });
await pc.click('#realnetBtn');
await pc.click('#realnetDlg [data-act="on"]');
await pc.waitForSelector('#tree .tn[data-kind="checkpoint"][data-id="01"]', { timeout: 30000 }).catch(() => null);
await pc.click('#tree .tn[data-kind="checkpoint"][data-id="01"]').catch(() => {});
const ref = await pc.waitForSelector('#runRef:not([disabled])', { timeout: 20000 }).catch(() => null);
if (ref) {
  await ref.click();
  const done = await waitFor(pc, () => !!document.querySelector('#realnetNote'), null, 60000);
  const txt = done ? await pc.$eval('#realnetNote', (e) => e.textContent) : '';
  report('检查点：结果标「依赖外网 · 不记运行编号」', /依赖外网/.test(txt) && /不记运行编号/.test(txt), txt.slice(0, 40));
  const card = await pc.$eval('#props .result-card', (e) => e.textContent).catch(() => '');
  report('检查点：结果卡标「依赖外网」', /依赖外网/.test(card), card.slice(0, 60));
  const runId = await pc.evaluate(() => [...document.querySelectorAll('.fp')].map((e) => e.textContent).join('|'));
  report('检查点：不显示运行编号', !/[0-9a-f]{8}/.test(runId), runId);
  const saved = await pc.evaluate(() => localStorage.getItem('tryboard-app-checks:weather') ?? '');
  report('进度：记 net、指纹为空', !saved || (/"net":true/.test(saved) && /"fp":""/.test(saved)), saved.slice(0, 120));
  await pc.screenshot({ path: path.join(outDir, 'realnet-check.png') });
} else report('检查点：找到「用参考固件试」', false);
await pc.close();

// ---- 6. 手机布局
const pm = await newPage(390, 844, true);
await pm.goto(base + '/app?work=blank&example=c3-http-real#bench', { waitUntil: 'load' });
await hasText(pm, '#console', 'TRYBOARD_OK', 30000);
await tap(pm, '#moreBtn');
report('手机：⋯ 菜单里有「真实网络：关」', await hasText(pm, '[data-more="realnet"]', '真实网络：关', 5000));
await tap(pm, '[data-more="realnet"]');
await pm.waitForSelector('#realnetDlg', { timeout: 5000 }).catch(() => null);
const bh = await pm.$$eval('#realnetDlg button', (l) => Math.min(...l.map((b) => b.getBoundingClientRect().height)));
report('手机：弹层按钮 ≥ 44px', bh >= 44, `${bh}px`);
const [sw, iw] = await pm.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
report('手机：无横向滚动', sw <= iw, `${sw} / ${iw}`);
await pm.screenshot({ path: path.join(outDir, 'realnet-mobile.png') });
await pm.close();

await browser.close();
server.close();
fake.close();
if (errors.length) console.log('[realnet] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[realnet] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
