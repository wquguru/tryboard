// 供电 / 欠压复位网页验收（P1-02 / P1-04）：
//  1. 实验台 app.html?work=weather#bench（只有 USB 供电），换上 s3-brownout 固件（舵机 0↔180° 半路反向扫动）
//  2. 应出现欠压复位：串口 rst:0xf (BROWNOUT_RST)、BOOT 2 reason=BROWNOUT，时间线多一步「欠压复位」，供电面板复位次数 > 0
//  3. 供电切到外接 5 V（点属性面板的按钮）→ 之后不再复位，扫满 12 次打印 TRYBOARD_OK
//  4. 万用表量 3V3：读数 = 求解器的 3V3 节点电压（worker tick 里的 elec.v3v3）
//  5. 暂停，取这次运行的输入日志（含 power=ext 切换），命令行 `--servo 4 --power usb --inputs` 重放到同一时刻：串口逐字节相同
// 用法：node tools/webtest/elec.mjs（先 tools/build_web.sh）。截图、日志在 Reviews/web/elec-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toScript } from '../../web/src/inputlog.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const FW = path.join(root, 'firmware/build/s3-brownout/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');

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
  console.log(`[elec] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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

const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/app.html?work=weather#bench', { waitUntil: 'load' });
await waitFor(page, () => !!globalThis.__tbApp?.session?.sim, null, 30000);
// 换固件（与把 .bin 拖进台面同一个入口）
await page.evaluate(async () => {
  const buf = await (await fetch('./fw/s3-brownout/flash.bin')).arrayBuffer();
  globalThis.__tbApp.session.loadFirmware(buf, 's3-brownout/flash.bin');
});
const conText = () => document.getElementById('console').textContent;
const brown = await waitFor(page, () => document.getElementById('console').textContent.includes('rst:0xf (BROWNOUT_RST)'), null, 40000);
const reason = await waitFor(page, () => document.getElementById('console').textContent.includes('reason=BROWNOUT'), null, 20000);
const e1 = await page.evaluate(() => globalThis.__tbApp.session.frame.elec);
report('只有 USB：舵机扫动 → 欠压复位，串口 rst:0xf 与 reason=BROWNOUT', brown && reason && e1?.resets > 0, e1 ? `复位 ${e1.resets} 次，3V3 最低 ${e1.min3v3.toFixed(3)} V，USB 峰值 ${(e1.peakUsb * 1000).toFixed(0)} mA` : '没有 elec 读数');
const steps = await page.$$eval('.tl-step', (els) => els.map((e) => e.textContent));
report('时间线出现「欠压复位」一步', steps.some((t) => t.includes('欠压复位')), steps.filter((t) => t.includes('欠压')).join(' / '));
// 供电面板：点构建树「供电」里的 USB 5 V，复位次数显示出来，再点"外接 5 V 2 A"
await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'power', id: 'usb' } }));
await sleep(400);
const ers = await page.$eval('[data-live="ers"]', (e) => e.textContent).catch(() => '');
report('供电面板显示 3V3 最低 / 峰值电流 / 复位次数', /\d+ 次/.test(ers) && ers !== '0 次', `欠压复位 ${ers}`);
await page.screenshot({ path: path.join(outDir, 'elec-usb.png') });
const resetsBefore = (await page.evaluate(() => globalThis.__tbApp.session.frame.elec.resets));
await page.click('[data-power="ext"]');
const okExt = await waitFor(page, () => document.getElementById('console').textContent.includes('TRYBOARD_OK s3-brownout'), null, 40000);
await sleep(500);
const e2 = await page.evaluate(() => globalThis.__tbApp.session.frame.elec);
report('切到外接 5 V 后不再复位，扫满 12 次（TRYBOARD_OK）', okExt && e2.power === 'ext' && e2.resets <= resetsBefore + 1, `切换前复位 ${resetsBefore} 次，之后共 ${e2.resets} 次（切换那一刻正在掉压的那次可能还算）；外接峰值 ${(e2.peakServo * 1000).toFixed(0)} mA`);
// 万用表量 3V3
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === '万用表')?.click());
await sleep(300);
await page.evaluate(() => [...document.querySelectorAll('[data-mpin="3V3"]')][0]?.click());
await sleep(600);
const mv = await page.$eval('[data-live="mv"]', (e) => e.textContent).catch(() => '');
const v33 = await page.evaluate(() => globalThis.__tbApp.session.frame.elec.v3v3);
report('万用表量 3V3 = 求解器 3V3 节点电压', mv === `${v33.toFixed(3)} V`, `表 ${mv} / 求解器 ${v33.toFixed(6)} V`);
await page.screenshot({ path: path.join(outDir, 'elec-meter.png') });
// 暂停 → 这次运行的输入日志 + 串口全文
await page.evaluate(() => globalThis.__tbApp.session.sim.pause());
await sleep(400);
const snap = await page.evaluate(() => globalThis.__tbApp.session.snapshot());
const text = toScript({ ...snap.log, firmware: 's3-brownout' });
const inputsFile = path.join(outDir, 'elec-inputs.txt');
fs.writeFileSync(inputsFile, text);
fs.writeFileSync(path.join(outDir, 'elec-web.stdout'), snap.stdout);
report('输入日志带上电供电与切换（--servo 4 --power usb、power=ext）', snap.log.servo === 4 && snap.log.power === 'usb' && /:power=ext$/m.test(text), `${(snap.log.endMs / 1000).toFixed(3)} s`);
const cycles = Math.round(snap.log.endMs * (CPU_HZ / 1000));
const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), '--servo', '4', '--power', 'usb', '--elec-report', '--inputs', inputsFile], { maxBuffer: 64 << 20 });
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'elec-cli.stdout'), cli);
fs.writeFileSync(path.join(outDir, 'elec-cli.stderr'), p.stderr);
let diffAt = -1;
if (cli !== snap.stdout) diffAt = Math.max(0, [...cli].findIndex((c, i) => c !== snap.stdout[i]));
const cliResets = Number((p.stderr.toString().match(/电气 欠压复位 (\d+) 次/) || [])[1]);
report('命令行按同一日志重放：串口逐字节相同、复位次数相同', cli === snap.stdout && cliResets === e2.resets,
  cli === snap.stdout ? `${cli.length} 字节，复位 网页 ${e2.resets} / 命令行 ${cliResets}` : `第 ${diffAt} 字节起不同：${JSON.stringify(cli.slice(diffAt, diffAt + 50))} vs ${JSON.stringify(snap.stdout.slice(diffAt, diffAt + 50))}`);

await browser.close();
server.close();
if (errors.length) console.log('[elec] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[elec] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
