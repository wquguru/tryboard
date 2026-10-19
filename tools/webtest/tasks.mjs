// 任务时间线对拍（C-04）：网页实时运行记下的任务切换 = 命令行 `--trace-tasks` 同一固件同一时段的切换（核、任务名、起点周期、结束状态逐段相同）。
//  1. app.html?work=blank&example=<示例>（s3-dual / hello / s3-lvgl）实验台实时运行到串口出现 TRYBOARD_OK（lvgl：FPS）、模拟时间 > 1.2 s
//  2. 暂停，取网页任务仓库（tasktrace.ts）的切片，点开底部坞「任务」页签，导出的 Perfetto JSON 合法
//  3. 命令行 tryboard run --seconds <网页停住时刻> --trace-tasks 文件，比对起点在停住时刻之前的每一段
// 用法：node tools/webtest/tasks.mjs（先 tools/build_web.sh）。产物在 Reviews/web/tasks-*
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
  console.log(`[tasks] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const us = (c) => {
  const ns = (BigInt(c) * 2_000_000_000n + BigInt(CPU_HZ)) / (2n * BigInt(CPU_HZ));
  return `${ns / 1000n}.${(ns % 1000n).toString().padStart(3, '0')}`;
};

async function one(example, want, { ready = 'TRYBOARD_OK', args = [] } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${example}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${example}: ${m.text()}`); });
  await page.goto(`${base}/app?work=blank&example=${example}&debug=1#bench`, { waitUntil: 'load' });
  const ok = await waitFor(page, (r) => document.getElementById('console')?.textContent.includes(r), ready, 40000);
  await waitFor(page, () => globalThis.__tbApp?.store.get().simSeconds > 1.2, null, 30000);
  const web = await page.evaluate(async () => {
    const s = globalThis.__tbApp.session;
    s.sim.pause();
    await new Promise((r) => setTimeout(r, 300));
    await s.snapshot();
    await new Promise((r) => setTimeout(r, 100));
    const t = s.tasks;
    return { now: t.now, text: t.text(), chip: t.chip, cores: t.cores, names: t.tasks.map((x) => x.name), json: t.exportJson(), dropped: t.coreDropped + t.trimmed };
  });
  fs.writeFileSync(path.join(outDir, `tasks-${example}-web.txt`), web.text);
  fs.writeFileSync(path.join(outDir, `tasks-${example}-web.json`), web.json);
  let parsed = null;
  try { parsed = JSON.parse(web.json); } catch { /* 下面判失败 */ }
  report(`${example}：网页跑到 ${ready}，任务仓库有切换，导出 JSON 合法`, ok && !!parsed && web.text.length > 0 && web.dropped === 0, `${web.chip} ${web.cores} 核，任务 ${web.names.join('/')}，停在 ${(web.now / CPU_HZ).toFixed(4)} s`);
  // 「任务」页签：泳道画出来了
  await page.click('[data-dock="tasks"]');
  await waitFor(page, () => Number(document.getElementById('tasksPane')?.dataset.switches) > 0, null, 5000);
  const pane = await page.evaluate(() => ({
    cores: [...document.querySelectorAll('#tasksPane section[data-core]')].map((s) => [...s.querySelectorAll('[data-task]')].map((r) => r.dataset.task)),
    usage: [...document.querySelectorAll('#tasksUsage li')].map((l) => l.textContent),
    cred: document.getElementById('tasksCred')?.textContent ?? '',
  }));
  const lanesOk = want(pane.cores);
  report(`${example}：「任务」页签每核泳道`, lanesOk && pane.cred.includes('行为模拟'), JSON.stringify(pane.cores) + ' 占用 ' + pane.usage.join(' '));
  await page.screenshot({ path: path.join(outDir, `tasks-${example}.png`) });

  // 命令行同一固件、跑到网页停住的时刻
  const out = path.join(outDir, `tasks-${example}-cli.json`);
  const fw = path.join(root, 'firmware/build', example, 'flash.bin');
  const p = spawnSync(CLI, ['run', fw, '--seconds', String(web.now / CPU_HZ), '--trace-tasks', out, ...args], { maxBuffer: 64 << 20 });
  const cli = JSON.parse(fs.readFileSync(out, 'utf8')).traceEvents.filter((e) => e.ph === 'X' && e.pid === 1);
  // 起点在停住时刻之前的段：核、任务名、起点逐段相同；两边都已结束的段结束状态也相同
  // 任务名可能带空格（"Tmr Svc"）：首字段是核，末三字段是起点 / 终点 / 状态，中间都是名字
  const wl = web.text.split('\n').filter(Boolean).map((l) => l.split(' ')).map((f) => ({ c: +f[0], n: f.slice(1, -3).join(' '), t0: us(+f.at(-3)), t1: +f.at(-2), st: f.at(-1) }));
  // ts 取 JSON 原文（解析成浮点再格式化会在 .5 上换舍入）
  const raw = [...fs.readFileSync(out, 'utf8').matchAll(/"ph":"X","pid":1,.*?"ts":([0-9.]+)/g)].map((m) => m[1]);
  const cl = cli.map((e, i) => ({ c: e.tid, n: e.name, t0: raw[i], end: e.ts + e.dur, st: e.args.out }));
  const endUs = (web.now * 1e6) / CPU_HZ;
  const cut = cl.filter((x) => Number(x.t0) < endUs);
  let diff = -1;
  for (let i = 0; i < Math.max(wl.length, cut.length); i++) {
    const a = wl[i];
    const b = cut[i];
    const closed = a && b && (a.t1 * 1e6) / CPU_HZ < endUs - 1 && b.end < endUs - 1;
    if (!a || !b || a.c !== b.c || a.n !== b.n || a.t0 !== b.t0 || (closed && a.st !== b.st)) { diff = i; break; }
  }
  report(`${example}：网页切换序列 = 命令行 --trace-tasks（核、任务名、起点周期、结束状态）`, p.status === 0 && diff < 0, diff < 0 ? `${wl.length} 段一致` : `第 ${diff + 1} 段不同：网页 ${JSON.stringify(wl[diff])} / 命令行 ${JSON.stringify(cut[diff])}`);
  await page.close();
}

await one('s3-dual', (cores) => cores.length === 2 && cores[0].includes('w0') && !cores[0].includes('w1') && cores[1].includes('w1') && !cores[1].includes('w0') && cores[0].includes('IDLE0') && cores[1].includes('IDLE1'));
await one('hello', (cores) => cores.length === 1 && cores[0].includes('main') && cores[0].includes('IDLE'));
// 满负荷的 LVGL 圆屏：几千次切换（esp_timer / taskLVGL / Tmr Svc 等队列），SPI DMA 中断时序也要两边一致
await one('s3-lvgl', (cores) => cores.length === 2 && cores.flat().includes('taskLVGL') && cores.flat().includes('esp_timer'), { ready: 'FPS', args: ['--spi', 'gc9a01'] });

// 手机 390×844：抽屉里能切到「任务」，页面没有横向滚动
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push(`phone: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`phone: ${m.text()}`); });
  await page.goto(`${base}/app?work=blank&example=s3-dual&debug=1#bench`, { waitUntil: 'load' });
  await waitFor(page, () => document.getElementById('console')?.textContent.includes('TRYBOARD_OK'), null, 40000);
  await page.click('#sheetPeek');
  await waitFor(page, () => !!document.querySelector('[data-dock="tasks"]'), null, 5000);
  await page.click('[data-dock="tasks"]');
  const ph = await waitFor(page, () => Number(document.getElementById('tasksPane')?.dataset.switches) > 0, null, 5000);
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.getElementById('tasksPane').scrollWidth]);
  await page.screenshot({ path: path.join(outDir, 'tasks-phone.png') });
  report('手机 390×844：抽屉切到「任务」，无横向滚动', ph && sw[0] <= 390 && sw[1] <= 390, `scrollWidth 页面 ${sw[0]} / 面板 ${sw[1]}`);
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[tasks] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[tasks] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
