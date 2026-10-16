// 逻辑分析仪事件对拍（P1-05）：网页实时运行记下的事件序列 = 命令行 `--trace-io` 按同一份输入日志重放出来的前 N 条（逐字）。
//  1. app.html?work=weather 实验台实时运行；⌘K 执行「把室温设为 35 ℃」（触发蜂鸣器 PWM）
//  2. 暂停，取网页事件仓库的文本（iotrace.ts eventLine）、输入日志、观察的引脚
//  3. 命令行 tryboard run --inputs 日志 --trace-io 文件 --trace-pins 同一组引脚，比对
//  4. 事件里有 BME280 一次读 8 字节（START 0x76 W · 0xF7 · RESTART 0x76 R · 8 B · STOP）、舵机 50 Hz、蜂鸣器 2.7 kHz
// 用法：node tools/webtest/traceio.mjs（先 tools/build_web.sh）。产物在 Reviews/web/traceio-*
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
const FW = path.join(root, 'firmware/build/weather/flash.bin');
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
  console.log(`[traceio] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
await page.goto(base + '/app.html?work=weather&debug=1#bench', { waitUntil: 'load' });
const booted = await waitFor(page, () => /T=23\.50 C/.test(document.getElementById('console').textContent), null, 30000);
report('weather 实验台实时运行（串口 T=23.50）', booted);
await waitFor(page, () => globalThis.__tbApp?.store.get().simSeconds > 1.5, null, 30000);
const did = await page.evaluate(() => globalThis.__tbApp.cmdk.exec('室温 35'));
const alarm = await waitFor(page, () => document.getElementById('console').textContent.includes('ALARM ON'), null, 15000);
report('⌘K「把室温设为 35 ℃」→ 串口 ALARM ON', did === '把室温设为 35 ℃' && alarm, `执行了「${did}」`);
const t1 = await page.evaluate(() => globalThis.__tbApp.store.get().simSeconds);
await waitFor(page, (t) => globalThis.__tbApp.store.get().simSeconds > t + 0.8, t1, 15000);
// 暂停后取：快照会先把 worker 里攒着的事件发过来（消息有序）
const web = await page.evaluate(async () => {
  const s = globalThis.__tbApp.session;
  s.sim.pause();
  await new Promise((r) => setTimeout(r, 300));
  const snap = await s.snapshot();
  await new Promise((r) => setTimeout(r, 100));
  return { log: snap.log, text: s.io.text(), n: s.io.raw.length, pins: s.ioPins(), dropped: s.io.dropped + s.io.coreDropped };
});
fs.writeFileSync(path.join(outDir, 'traceio-web.txt'), web.text);
fs.writeFileSync(path.join(outDir, 'traceio-inputs.json'), JSON.stringify(web.log, null, 1));
report('网页事件仓库有事件、没丢', web.n > 1000 && web.dropped === 0, `${web.n} 条，观察 GPIO ${web.pins.join(',')}，到 ${(web.log.endMs / 1000).toFixed(3)} s`);

// 输入日志 → --inputs 文本（与 inputlog.ts toScript 同格式：秒向下取整到微秒）
const sec = (ms) => (Math.floor(ms * 1000) / 1e6).toFixed(6);
const act = (e) => (e.kind === 'gpio' ? `gpio${e.pin}=${e.level < 0 ? 'z' : e.level ? 1 : 0}` : e.kind === 'env' ? `env=${e.temp},${e.humidity},${e.pressure}` : e.kind === 'pot' ? `mv${e.pin}=${e.mv}` : null);
const script = web.log.events.flatMap((e) => (act(e) ? [`${sec(e.tMs)}:${act(e)}`] : [])).join('\n') + '\n';
const inputsFile = path.join(outDir, 'traceio-inputs.txt');
fs.writeFileSync(inputsFile, script);
const traceFile = path.join(outDir, 'traceio-cli.txt');
const i2c = web.log.i2c.map((d) => `${d.kind}@0x${d.addr.toString(16)}`).join(',');
// 命令行多跑 50ms：网页暂停前已经记下、但时刻在暂停点之后的 I2C 事件（事务层按位时序预先盖戳）也要有
const seconds = String(web.log.endMs / 1000 + 0.05);
const p = spawnSync(CLI, ['run', FW, '--seconds', seconds, '--i2c', i2c, '--inputs', inputsFile, '--trace-io', traceFile, '--trace-pins', web.pins.join(',')], { maxBuffer: 64 << 20 });
fs.writeFileSync(path.join(outDir, 'traceio-cli.stderr'), p.stderr);
const cli = fs.readFileSync(traceFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const wl = web.text.split('\n').filter(Boolean);
let diff = wl.findIndex((l, i) => l !== cli[i]);
report('网页事件 = 命令行 --trace-io 前 N 条（逐字）', p.status === 0 && diff < 0 && cli.length >= wl.length, diff < 0 ? `${wl.length} 条一致（命令行共 ${cli.length} 条）` : `第 ${diff + 1} 条不同：网页 ${JSON.stringify(wl[diff])} / 命令行 ${JSON.stringify(cli[diff])}`);

// 内容：BME280 突发读 8 字节、舵机 50 Hz、蜂鸣器 2.7 kHz
const burst = wl.findIndex((l, i) => /I2C0 DATA f7 W ACK$/.test(l) && /RESTART/.test(wl[i + 1]) && /ADDR 76 R ACK$/.test(wl[i + 2]) && wl.slice(i + 3, i + 11).every((x) => / R (N?ACK)$/.test(x)) && / R NACK$/.test(wl[i + 10]) && /STOP$/.test(wl[i + 11]));
report('事件里有 0x76 读 8 字节（0xF7 起）', burst >= 0, burst >= 0 ? wl.slice(burst - 2, burst + 12).map((l) => l.split(' ').slice(1).join(' ')).join(' | ').slice(0, 160) : '');
const servo = wl.find((l) => /^\d+ PWM 4 \d+ 50000$/.test(l));
const buzz = wl.find((l) => /^\d+ PWM 5 3276[78] 27\d{5}$/.test(l));
report('PWM：GPIO4 舵机 50 Hz、GPIO5 蜂鸣器 2.7 kHz 50%', !!servo && !!buzz, `${servo} / ${buzz}`);

// 时间线回退（P0-03）：回到「运行 #1」这一步（= 改室温之前那一刻），事件仓库按回退重放重建，仍与命令行前 N 条一致
const sk = await page.evaluate(async () => {
  const a = globalThis.__tbApp;
  const i = a.hist.steps().findIndex((s) => s.op.k === 'run' && s.op.n === 1);
  const r = await a.hist.seek(i);
  await new Promise((res) => setTimeout(res, 300));
  return { r, text: a.session.io.text(), n: a.session.io.raw.length };
});
const sl = sk.text.split('\n').filter(Boolean);
diff = sl.findIndex((l, i) => l !== cli[i]);
const lastT = Number(sl.at(-1)?.split(' ')[0] ?? 0);
report('回退到「运行 #1」（改室温之前）：事件按重放重建，与命令行前 N 条一致', !!sk.r && diff < 0 && sl.length > 100 && sl.length < wl.length && lastT <= sk.r.untilMs * 160000 + 20000, sk.r ? `回到 ${(sk.r.untilMs / 1000).toFixed(3)} s，${sl.length} 条${diff < 0 ? '' : `；第 ${diff + 1} 条不同`}` : '回退失败');

await browser.close();
server.close();
if (errors.length) console.log('[traceio] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[traceio] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
