// 输入日志重放验收（P0-19）：网页上真的操作一遍 → 导出输入日志 → 命令行按同一份日志重放 → 结果逐字节相同。
//  1. 实验台打开 weather，实时运行；用鼠标按 3D 板子上的 BOOT（切 ℉），再把温度滑块拖到 35 ℃（触发蜂鸣器报警）
//  2. 暂停，取输入日志（模拟时间戳）和网页串口输出，导出成 --inputs 文本（与「导出输入」按钮同一个 toScript）
//  3. 命令行 `tryboard run --inputs` 跑到同一个模拟时刻：串口输出必须与网页实时运行看到的完全一致
//  4. 网页验收 worker（__tbReplay）与命令行按同一日志各跑一遍：串口 + 观察记录的指纹必须相同
// 用法：node tools/webtest/replay.mjs（先 tools/build_web.sh）。日志与截图在 Reviews/web/replay-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const FW = path.join(root, 'firmware/build/weather/flash.bin');
const CLI = path.join(root, 'core/target/release/tryboard');
const BUZZER = 5;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // 无后缀地址（/app、/select）映射到 .html，与 Vite 预览和静态托管一致（DESIGN_V2 §7.2）
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
  console.log(`[replay] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const simNow = (page) => page.$eval('#simtime', (e) => parseFloat(e.textContent) || 0);
/** 网页串口里固件自己的输出（去掉 [试板] 提示那些带 class 的 span） */
const fwConsole = (page) => page.$eval('#console', (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''));
/** 命令行跑一遍：返回 stdout 原样字节解码 + 用 check.py 的规则算出的指纹 */
function cliRun(args, tag) {
  const p = spawnSync(CLI, ['run', FW, ...args], { maxBuffer: 64 << 20 });
  const out = path.join(outDir, `replay-${tag}.stdout`);
  const err = path.join(outDir, `replay-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), fp, code: p.status };
}

// ---- 1. 网页上操作
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/app?work=blank&example=weather#bench', { waitUntil: 'load' });
const booted = await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console').textContent), null, 30000);
report('实验台 weather 实时运行（串口 T=23.50）', booted);
await waitFor(page, () => parseFloat(document.getElementById('simtime').textContent) > 1.0, null, 30000);
// 鼠标按 3D 里的 BOOT：按住约 150ms 墙钟（固件消抖 30ms 模拟时间）
const pos = await page.evaluate(() => globalThis.__tbButtonPos('BOOT'));
if (pos) {
  await page.mouse.move(pos[0], pos[1]);
  await page.mouse.down();
  const t0 = await simNow(page);
  await waitFor(page, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.1, t0, 10000);
  await page.mouse.up();
}
const unitF = await waitFor(page, () => document.getElementById('console').textContent.includes('UNIT F'), null, 15000);
report('鼠标按 3D 板上的 BOOT → 串口 UNIT F', !!pos && unitF, pos ? `@${pos.map(Math.round).join(',')}` : '找不到 BOOT');
// 温度滑块拖到 35 ℃（与 agent-browser fill 同效：改值 + input 事件）；右栏「这个示例」卡在示例清单取回后才渲染
await page.waitForSelector('.env input', { timeout: 10000 }).catch(() => {});
await page.$eval('.env input', (r) => { r.value = '35'; r.dispatchEvent(new Event('input')); });
const alarm = await waitFor(page, () => document.getElementById('console').textContent.includes('ALARM ON'), null, 15000);
report('温度拖到 35 ℃ → 串口 ALARM ON', alarm);
const tAlarm = await simNow(page);
await waitFor(page, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.6, tAlarm, 15000);
// 暂停后再取：日志的 endMs 就是网页停下的那个模拟时刻
await page.click('#runPause');
await waitFor(page, () => /已暂停/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
await page.screenshot({ path: path.join(outDir, 'replay-web.png') });
fs.writeFileSync(path.join(outDir, 'replay-inputs.json'), JSON.stringify(log, null, 1));
fs.writeFileSync(path.join(outDir, 'replay-web.stdout'), live);
const kinds = log.events.map((e) => e.kind + (e.kind === 'gpio' ? `${e.pin}=${e.level}` : e.kind === 'env' ? `=${e.temp}` : '')).join(' ');
const okLog = log.events.some((e) => e.kind === 'gpio' && e.pin === 0 && e.level === 0) && log.events.some((e) => e.kind === 'gpio' && e.pin === 0 && e.level === -1) && log.events.some((e) => e.kind === 'env' && e.temp === 35);
report('输入日志记下 BOOT 按下 / 松开和温度 35', okLog, `${kinds}；到 ${(log.endMs / 1000).toFixed(3)} s`);

// ---- 2. 导出成 --inputs 文本：用网页自己的 toScript（与「导出输入」按钮一致）
const text = await page.evaluate(async () => {
  let blobText = '';
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobText = b; return orig.call(URL, b); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  // 顶栏 ⋯ 菜单里的「导出输入日志」
  document.getElementById('moreBtn').click();
  for (let i = 0; i < 20 && !document.querySelector('[data-more="inputs"]'); i++) await new Promise((r) => setTimeout(r, 50));
  document.querySelector('[data-more="inputs"]').click();
  for (let i = 0; i < 50 && !blobText; i++) await new Promise((r) => setTimeout(r, 50));
  URL.createObjectURL = orig;
  HTMLAnchorElement.prototype.click = click;
  return blobText ? await blobText.text() : '';
});
const inputsFile = path.join(outDir, 'replay-inputs.txt');
fs.writeFileSync(inputsFile, text);
report('「导出输入」按钮给出 --inputs 文本', /^# 试板输入日志/.test(text) && /:env=35,/.test(text) && /:gpio0=0/.test(text), `${text.split('\n').filter((l) => l && !l.startsWith('#')).length} 条`);

// ---- 3. 命令行重放到同一模拟时刻：串口与网页实时运行逐字节一致
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const seconds = String((cycles + 0.5) / CPU_HZ);
const i2c = log.i2c.map((d) => `${d.kind}@0x${d.addr.toString(16)}`).join(',');
const a = cliRun(['--seconds', seconds, '--i2c', i2c, '--inputs', inputsFile], 'live');
let same = a.stdout === live;
let diffAt = -1;
if (!same) {
  diffAt = [...a.stdout].findIndex((c, i) => c !== live[i]);
  if (diffAt < 0) diffAt = Math.min(a.stdout.length, live.length);
}
report('命令行 --inputs 重放 = 网页实时串口（逐字节）', same && a.code === 0 && a.stdout.includes('ALARM ON') && a.stdout.includes('UNIT F'),
  same ? `${live.length} 字节，${cycles} 周期` : `第 ${diffAt} 字节起不同（命令行 ${a.stdout.length} / 网页 ${live.length}）：${JSON.stringify(a.stdout.slice(diffAt, diffAt + 40))} vs ${JSON.stringify(live.slice(diffAt, diffAt + 40))}`);

// ---- 4. 指纹：网页验收 worker 与命令行按同一日志各跑 3 秒（带 GPIO / WS2812 / 蜂鸣器 PWM 观察记录）
const SECS = Math.max(3, Math.ceil(log.endMs / 1000));
const web = await page.evaluate((l, s, p) => globalThis.__tbReplay(l, s, p), log, SECS, BUZZER);
const c = cliRun(['--seconds', String(SECS), '--gpio-log', '--ws2812-log', '--pwm-log', String(BUZZER), '--i2c', i2c, '--inputs', inputsFile], 'fp');
fs.writeFileSync(path.join(outDir, 'replay-web-verify.json'), JSON.stringify(web, null, 1));
report('网页重放与命令行重放指纹相同（串口 + 观察记录）', web.fingerprint === c.fp && !web.error, `网页 ${web.fingerprint} / 命令行 ${c.fp}`);
const buzz = /PWM GPIO5: \d+ 次变化，占空比 [\d.]+\.\.0\.5\d*，频率 2700/.test(web.report);
report('重放里蜂鸣器 GPIO5 出 2700 Hz 50% PWM', buzz, (web.report.match(/PWM GPIO5: .*/) || [''])[0]);

await browser.close();
server.close();
if (errors.length) console.log('[replay] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[replay] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
