// 实验台交互回归（P0-03 / P0-04 / P0-11 / P0-12 / P0-13）：app.html?work=weather&debug=1#bench
//  1. 三个作品默认接线没有问题；注入五种错误接线各标红（W1–W5），构建树"连线"显示问题数
//  2. 点 GPIO4（真实鼠标点 3D 针脚）→ 属性面板 50 Hz + 脉宽，示波器有波形
//  3. 点 BME280 → 快捷卡片：拖温度、热源（+8 ℃ 读数跟着变）、量到芯片（毫米）；供电切外接 5 V
//  4. 重启（顶栏运行组）→ 改湿度 → 再跑（这次不编辑）→ 再跑并改温度 → 时间线点回不编辑的那次：指纹与它收尾时的一致；
//     再用命令行按那次的输入日志重放到同一时刻，check.py 的指纹也一致；尺子、运行历史对比、回退后再跑丢掉后面的分支
// 用法：node tools/webtest/interact.mjs（先 tools/build_web.sh、cargo build --release -p tryboard-cli）。截图在 Reviews/web/interact-*
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
  console.log(`[interact] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const simNow = (page) => page.evaluate(() => globalThis.__tbApp.store.get().simSeconds);
const waitSim = async (page, dt) => {
  const t = await simNow(page);
  return waitFor(page, (x) => globalThis.__tbApp.store.get().simSeconds > x, t + dt, 30000);
};
async function open(url) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(base + url, { waitUntil: 'load' });
  await waitFor(page, () => globalThis.__tbApp?.hist && globalThis.__tbApp.store.get().simSeconds > 0.5, null, 30000);
  return page;
}
const props = (page) => page.$eval('#props', (e) => e.textContent);
/** 真实鼠标点 3D 目标：先点 project 给的中心，被别的东西挡住（导线从上面跨过）就在周围找一圈 */
async function clickTarget(page, t) {
  const c = await screenOf(page, t);
  if (!c) return null;
  for (const [dx, dy] of [[0, 0], [0, 12], [12, 0], [-12, 0], [0, -12], [16, 16], [-16, 16], [16, -16], [-16, -16], [0, 24], [24, 0], [-24, 0]]) {
    await page.mouse.click(c.x + dx, c.y + dy);
    await sleep(120);
    const s = await page.evaluate(() => globalThis.__tbApp.store.get().selection);
    if (s && s.kind === t.kind && s.id === t.id) return { x: c.x + dx, y: c.y + dy };
  }
  return null;
}
/** 3D 里某个目标的页面坐标（project 是相对台面容器的） */
const screenOf = (page, t) => page.evaluate((t) => {
  const p = globalThis.__tbApp.session.pick.project(t);
  const r = document.getElementById('stage').getBoundingClientRect();
  return p && { x: r.left + p.x, y: r.top + p.y };
}, t);

// ---- 1. 默认接线无问题（三个作品）
for (const work of ['weather', 'spin', 'lens']) {
  const page = await open(`/app?work=${work}&debug=1#bench`);
  const f = await page.evaluate(() => globalThis.__tbApp.faults());
  const tree = await page.$eval('details.tg[data-g="wire"] summary', (e) => e.textContent);
  report(`${work} 默认接线没有问题`, f.length === 0 && /✓/.test(tree), `连线 ${tree.replace('连线', '').trim()}${f.length ? ' ' + JSON.stringify(f) : ''}`);
  await page.close();
}

const page = await open('/app?work=weather&debug=1#bench');

// ---- 2. 点 GPIO4 针脚
await page.evaluate(() => globalThis.__tbApp.session.bench._debug.controls && 0);
let pin = await clickTarget(page, { kind: 'pin', id: 'GPIO4' });
let sel = await page.evaluate(() => globalThis.__tbApp.store.get().selection);
if (!sel || sel.id !== 'GPIO4') {
  // 点不准就从构建树选（同一个 selection）
  await page.$eval('details.tg[data-g="pin"]', (d) => (d.open = true));
  await page.click('.tn[data-kind="pin"][data-id="GPIO4"]');
}
sel = await page.evaluate(() => globalThis.__tbApp.store.get().selection);
await waitSim(page, 0.4);
let txt = await props(page);
const scopeInk = await page.$eval('canvas.scope', (c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 80) n++;
  return n;
});
report('点 GPIO4 → 属性：50 Hz + 脉宽 + 示波器', sel?.id === 'GPIO4' && /50(\.0)? Hz/.test(txt) && /脉宽\d\.\d{3} ms/.test(txt) && scopeInk > 50, `${pin ? '鼠标点 3D' : '构建树'}；${(txt.match(/PWM 频率[^脉]*脉宽[\d. ms]+/) ?? [''])[0]}；示波器蓝色像素 ${scopeInk}`);
await page.screenshot({ path: path.join(outDir, 'interact-pin.png') });

// ---- 3. BME280 快捷卡片
const bme = await clickTarget(page, { kind: 'part', id: 'bme280' });
const card = await waitFor(page, () => !document.querySelector('.qcard').hidden && /BME280/.test(document.querySelector('.qcard').textContent), null, 3000);
report('点 BME280 → 弹快捷卡片', card, bme ? `@${Math.round(bme.x)},${Math.round(bme.y)}` : '看不到 BME280');
await page.$eval('.qcard input[data-env="temp"]', (r) => { r.value = '30'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
const t30 = await waitFor(page, () => globalThis.__tbApp.store.get().reading?.t === 30, null, 10000);
report('卡片拖温度到 30 ℃ → 读数 30.00', t30);
await page.click('.qcard [data-act="heat"]');
const t38 = await waitFor(page, () => globalThis.__tbApp.store.get().reading?.t === 38 && globalThis.__tbApp.session.heat === 'bme280', null, 10000);
report('放上热源 → 读数 38.00、热晕', t38);
await page.click('.qcard [data-act="chip"]');
const mm = await page.$eval('.qcard [data-live="chipmm"]', (e) => e.textContent);
report('量到芯片 → 毫米', /\d+\.\d mm/.test(mm), mm.slice(0, 60));
await page.screenshot({ path: path.join(outDir, 'interact-card.png') });
await page.click('.qcard [data-act="heat"]');
await waitFor(page, () => globalThis.__tbApp.store.get().reading?.t === 30, null, 10000);

// 供电：点舵机供电线 → 卡片切外接 5 V
const pw = await clickTarget(page, { kind: 'wire', id: 'wire:5V~servo:VCC' });
let pcard = await waitFor(page, () => !!document.querySelector('.qcard [data-power="ext"]'), null, 3000);
if (!pcard) {
  await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'power', id: 'usb' } }));
}
await page.click(pcard ? '.qcard [data-power="ext"]' : '#props [data-power="ext"]');
const ext = await waitFor(page, () => globalThis.__tbApp.session.power?.ext5v === true && /外接 5 V 2 A/.test(document.getElementById('tree').textContent), null, 3000);
const bom = await page.evaluate(() => { const h = globalThis.__tbApp.store.get().bom; return JSON.stringify(h.ops.slice(1)); });
report('供电切外接 5 V → 构建树 + 清单', ext, `${pcard ? '点供电线卡片' : '属性面板'}；清单 ${bom}`);

// ---- 4. 运行、改环境、回退
await page.evaluate(() => globalThis.__tbApp.session.reboot());
await waitFor(page, () => globalThis.__tbApp.hist.runs().length >= 2, null, 10000);
const r1 = await page.evaluate(() => globalThis.__tbApp.hist.runs().length);
await waitSim(page, 1.5);
await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'env', id: 'room' } }));
await page.$eval('#props input[data-env="humidity"]', (r) => { r.value = '60'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
await waitSim(page, 0.8);
await page.click('#runRestart');
await waitFor(page, (n) => globalThis.__tbApp.hist.runs().length > n, r1, 10000);
await waitSim(page, 2.2);
// 运行 #(r1+1) 期间不做编辑：时间线上"运行"这一步 = 整次运行，回退后应与收尾时的指纹一致
await page.click('#runRestart');
await waitFor(page, (n) => globalThis.__tbApp.hist.runs().length > n + 1, r1, 10000);
await waitSim(page, 0.8);
await page.$eval('#props input[data-env="temp"]', (r) => { r.value = '12'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
await waitSim(page, 0.6);
const runs = await page.evaluate(() => globalThis.__tbApp.hist.runs().map((r) => ({ n: r.n, fp: r.fingerprint, end: r.snap?.log.endMs ?? null })));
const nRun2 = r1 + 1;
const rec2 = runs.find((r) => r.n === nRun2);
// 运行历史：选运行 #2，点运行 #(1) 对比
await page.evaluate((n) => globalThis.__tbApp.store.set({ selection: { kind: 'run', id: String(n) } }), nRun2);
await page.click(`.runrow[data-run="${nRun2 - 1}"]`);
const diff = await page.$$eval('.drow.ch .k', (e) => e.map((x) => x.textContent.replace('≠ ', '')));
report('运行历史：两次运行对比差异项', diff.includes('运行编号') && diff.length >= 2, diff.join('、'));
await page.screenshot({ path: path.join(outDir, 'interact-runs.png') });
// 时间线点回运行 #2（v2：时间线在底部坞的「运行记录」页签里，先切过去）
await page.click('[data-dock="runs"]');
const steps = await page.$$eval('.tl-step', (b) => b.map((x) => x.textContent));
const idx = steps.findIndex((t) => t.includes(`运行 #${nRun2}`));
const btns = await page.$$('.tl-step');
await btns[idx].click();
await waitFor(page, () => globalThis.__tbApp.store.get().hist.seeked && !globalThis.__tbApp.store.get().hist.busy, null, 60000);
const seek = await page.evaluate(() => globalThis.__tbApp.hist.lastSeek());
report(`时间线回到运行 #${nRun2} → ✓ 指纹一致`, !!rec2?.fp && seek?.fingerprint === rec2.fp && seek.same === true, `当时 ${rec2?.fp} · 回退 ${seek?.fingerprint} · ${(seek?.untilMs / 1000).toFixed(3)} s`);
await page.screenshot({ path: path.join(outDir, 'interact-seek.png') });

// 命令行按运行 #2 的输入日志重放到同一时刻：check.py 的指纹一致（网页回退 = 命令行重放）
if (fs.existsSync(CLI) && fs.existsSync(FW)) {
  const log = await page.evaluate((n) => globalThis.__tbApp.hist.runs().find((r) => r.n === n).snap.log, nRun2);
  const script = log.events.filter((e) => e.kind !== 'power').map((e) => {
    const t = (Math.floor(e.tMs * 1000) / 1e6).toFixed(6);
    const a = e.kind === 'env' ? `env=${e.temp},${e.humidity},${e.pressure}` : e.kind === 'gpio' ? `gpio${e.pin}=${e.level < 0 ? 'z' : e.level}` : null;
    return a && `${t}:${a}`;
  }).filter(Boolean).join('\n');
  const inputs = path.join(outDir, 'interact-run2.inputs');
  fs.writeFileSync(inputs, script + '\n');
  const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
  const i2c = log.i2c.map((d) => `${d.kind}@0x${d.addr.toString(16)}`).join(',');
  const p = spawnSync(CLI, ['run', FW, '--seconds', String((cycles + 0.5) / CPU_HZ), '--i2c', i2c, '--inputs', inputs, '--gpio-log', '--ws2812-log'], { maxBuffer: 64 << 20 });
  const out = path.join(outDir, 'interact-run2.stdout'), err = path.join(outDir, 'interact-run2.stderr');
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  report(`命令行 --inputs 重放运行 #${nRun2} → 指纹一致`, fp === rec2?.fp, `命令行 ${fp}`);
} else report('命令行重放（缺 CLI 或固件）', false, CLI);

// 从回退点改环境 = 新分支：运行 #3 被丢掉
await page.evaluate(() => globalThis.__tbApp.hist.resume());
await waitSim(page, 0.3);
await page.click('#runRestart');
await waitFor(page, (n) => globalThis.__tbApp.hist.runs().length === n, nRun2 + 1, 10000);
const after = await page.evaluate(() => globalThis.__tbApp.hist.runs().map((r) => r.n).join(','));
report('回退后再跑：后面的运行丢掉、编号接着回退点', after === Array.from({ length: nRun2 + 1 }, (_, i) => i + 1).join(','), `运行 ${after}`);

// 尺子：工具条尺子 → 点 BME280 和开发板
await page.click('.tb-btn[data-tool="ruler"]');
// 尺子模式下点击不改 selection：用前面找到的 BME280 点位，再点 OLED 中心
const pb = await screenOf(page, { kind: 'part', id: 'oled' });
if (bme && pb) {
  await page.mouse.click(bme.x, bme.y);
  await sleep(150);
  await page.mouse.click(pb.x, pb.y);
}
await sleep(200);
const rtxt = await props(page);
report('尺子：点两个零件 → 毫米', /距离\d+\.\d mm/.test(rtxt), (rtxt.match(/距离[\d.]+ mm/) ?? ['没量到'])[0]);
await page.click('.tb-btn[data-tool="select"]');

// ---- 5. 注入错误接线（W1–W5），每条标红 + 构建树问题数
const kinds = [['drive', 'W1'], ['5v', 'W2'], ['nores', 'W3'], ['nognd', 'W4'], ['addr', 'W5']];
for (const [k, rule] of kinds) {
  await page.evaluate(() => globalThis.__tbApp.injectWiring('clear'));
  const wires = await page.evaluate((k) => globalThis.__tbApp.injectWiring(k), k);
  await sleep(150);
  const f = await page.evaluate(() => globalThis.__tbApp.faults());
  const tree = await page.$eval('details.tg[data-g="wire"] summary', (e) => e.textContent);
  report(`错误接线 ${k} → ${rule} 标红`, f.some((x) => x.rule === rule) && wires.length > 0 && /处问题/.test(tree), `${f.map((x) => x.rule + ':' + x.wires.length).join(' ')} · ${tree.replace('连线', '').trim()}`);
  if (k === '5v') {
    await page.evaluate(() => globalThis.__tbApp.store.set({ selection: { kind: 'wire', id: 'wire:GPIO8~bme280:SDA' } }));
    await page.screenshot({ path: path.join(outDir, 'interact-fault.png') });
  }
}
await page.evaluate(() => globalThis.__tbApp.injectWiring('clear'));
const clean = await page.evaluate(() => globalThis.__tbApp.faults().length);
report('接线复原 → 无问题', clean === 0);

report('页面无报错', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`[interact] ${fails ? 'FAIL' : 'PASS'}（${fails} 项失败）`);
process.exit(fails ? 1 : 0);
