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

// 时间线回退（P0-03）：回到「运行 #1」这一步（= 改室温之前那一刻），事件仓库按回退重放重建，仍与命令行前 N 条一致。
// 回退点（= ⌘K 执行那一刻）由墙钟决定。I2C 事件按位时序预先盖戳（DECISIONS P1-05）：回退点落在 SSD1306 写屏的
// 一批命令表中间时，这一批后面的事件时刻会越过回退点最多一批 FIFO（32 B × 9 位 × 404 周期 ≈ 0.73 ms）。
// 所以不能要求"末条时刻 ≤ 回退点 + 一点余量"（那样回退点落进写屏窗口就挂，2026-10-16 间歇失败的根因），
// 而是：①逐条是命令行前缀；②没漏：命令行下一条的时刻 ≥ 停住的周期；③越过停住点的只能是 I2C、且不超过 1 ms。
const seekCheck = (name, text, stopCyc, untilMs, extra) => {
  const sl = text.split('\n').filter(Boolean);
  const d = sl.findIndex((l, i) => l !== cli[i]);
  const t = (l) => Number(l.split(' ')[0]);
  const over = sl.filter((l) => t(l) > stopCyc);
  const nextT = cli[sl.length] ? t(cli[sl.length]) : Infinity;
  const lastT = sl.length ? t(sl.at(-1)) : 0;
  const ok = d < 0 && sl.length > 100 && sl.length < wl.length && nextT >= stopCyc && over.every((l) => / I2C\d /.test(l)) && lastT <= stopCyc + 160000;
  report(name, ok, `停在 ${(stopCyc / CPU_HZ).toFixed(4)} s，${sl.length} 条（网页实时 ${wl.length}），越过停住点 ${over.length} 条${over.length ? `（末条 +${lastT - stopCyc} 周期）` : ''}，命令行下一条 ${nextT === Infinity ? '无' : `+${nextT - stopCyc}`}${d < 0 ? '' : `；第 ${d + 1} 条不同：网页 ${JSON.stringify(sl[d])} / 命令行 ${JSON.stringify(cli[d])}`}；回退点 ${(untilMs / 1000).toFixed(4)} s（旧判据「末条 ≤ 回退点 + 20000 周期」${lastT <= Math.round(untilMs * 160000) + 20000 ? '也过' : '会挂'}）${extra ? '；' + extra : ''}`);
};
const sk = await page.evaluate(async () => {
  const a = globalThis.__tbApp;
  const i = a.hist.steps().findIndex((s) => s.op.k === 'run' && s.op.n === 1);
  const r = await a.hist.seek(i);
  await new Promise((res) => setTimeout(res, 300));
  return { r, text: a.session.io.text(), sim: a.store.get().simSeconds };
});
if (!sk.r) report('回退到「运行 #1」（改室温之前）：事件按重放重建，与命令行前 N 条一致', false, '回退失败');
else seekCheck('回退到「运行 #1」（改室温之前）：事件按重放重建，与命令行前 N 条一致', sk.text, Math.round(sk.sim * CPU_HZ), sk.r.untilMs);

// 确定性覆盖上面那个靠运气的情形：直接回退到运行 #1 里一次 SSD1306 写屏命令表的中间（命令行事件里找 0x3C 的事务）
const t = (l) => Number(l.split(' ')[0]);
const envAt = Math.round((web.log.events.find((e) => e.kind === 'env' && e.tMs > 1)?.tMs ?? 0) * 160000);
const oled = cli.map((l, i) => [l, i]).filter(([l, i]) => / I2C0 ADDR 3c W ACK$/.test(l) && t(l) < envAt - 160000 && t(l) > 160000 * 300).at(-1);
if (!oled) report('回退到 SSD1306 写屏事务中间：事件按重放重建，与命令行前 N 条一致', false, '命令行事件里没找到运行 #1 的 0x3C 写屏');
else {
  const midMs = (t(oled[0]) + 60000) / 160000;
  const mk = await page.evaluate(async (untilMs) => {
    const a = globalThis.__tbApp;
    const rec = a.hist.runs().find((r) => r.n === 1);
    const log = rec.snap.log;
    const rest = log.events.filter((e) => e.kind !== 'power');
    const env0 = rest[0]?.kind === 'env' ? { temp: rest[0].temp, humidity: rest[0].humidity, pressure: rest[0].pressure } : a.store.get().env;
    const events = rest[0]?.kind === 'env' ? rest.slice(1) : rest;
    const snap = await a.session.seek({ flash: rec.fw, i2c: log.i2c, lcd: log.lcd, servo: log.servo, power: log.power, encoder: log.encoder, sonar: log.sonar, touchInt: log.touchInt, env: env0, events, untilMs });
    await new Promise((res) => setTimeout(res, 300));
    return { text: a.session.io.text(), sim: snap.simSeconds };
  }, midMs);
  seekCheck('回退到 SSD1306 写屏事务中间：事件按重放重建，与命令行前 N 条一致', mk.text, Math.round(mk.sim * CPU_HZ), midMs);
}

await browser.close();
server.close();
if (errors.length) console.log('[traceio] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[traceio] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
