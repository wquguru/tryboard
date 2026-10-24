// F-04a tutorial parts: use the bench controls (light / Wave / card) -> export inputs -> web replay and CLI --inputs fingerprints match.
// Usage: node tools/webtest/parts.mjs [c3-pir-relay c3-rc522 c3-ds18b20 c3-ili9341-temp c3-sh1106-pir esp32-ir arduino-lib-irremote arduino-lib-irremote-rx arduino-lib-irremote-loop c3-i2c-trio] (after the web build); logs in Reviews/web/parts-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { partsArgs, rc522Spec } from '../../web/src/partsdev.ts';
import { i2cArgs } from '../../web/src/i2cdevs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CLI = path.join(root, 'core/target/release/tryboard');

// Per example: what to click and what the firmware must print in the replay
const CASES = {
  'c3-pir-relay': { clicks: [['[data-luxset="2"]', '光线 暗'], ['[data-pir="wave"]', '继电器 吸合']], expect: ['光线 暗', '继电器 吸合'], tail: 3.5 },
  'c3-rc522': { clicks: [['[data-card="DEADBEEF"]', '读到卡 UID DE:AD:BE:EF'], ['[data-card="none"]', '卡已移开'], ['[data-card="04A1B2C3D4E5F6"]', '读到卡 UID 04:A1']], expect: ['RC522 版本 0x92 天线 开', '读到卡 UID DE:AD:BE:EF (4 字节) SAK 08 ATQA 0400', '卡已移开', '读到卡 UID 04:A1:B2:C3:D4:E5:F6 (7 字节)'], tail: 1 },
  'c3-ds18b20': { clicks: [], wait: '设备 2 温度', expect: ['总线上共 2 个 DS18B20', '设备 1 温度 23.5000', '设备 2 温度 24.0000'], tail: 1 },
  // F-04a2 screens: the TFT and SH1106 parts must reach the CLI as --spi ili9341 / --i2c-bus ...:sh1106@0x3c (P2-16 wired pads)
  'c3-ili9341-temp': { clicks: [], wait: '屏幕显示', expect: ['ILI9341 温度屏启动', '屏幕显示 23.5 °C（舒适）', 'TRYBOARD_OK c3-ili9341-temp'], cli: ['--spi', 'ili9341'], tail: 1 },
  // F-08f IR pair: bench remote key -> RMT RX; `seen` = what the IR LED card shows from the eye (wasm tb_ir_events)
  'esp32-ir': { clicks: [['[data-ir="FF00,BA45"]', 'IR 收到 遥控器 地址=FF00 命令=BA45'], ['[data-ir="repeat"]', 'IR 收到 重复码 地址=FF00 命令=BA45']], expect: ['IR 收到 自己发的 地址=0440 命令=3003', 'IR 收到 遥控器 地址=FF00 命令=BA45', 'IR 收到 重复码 地址=FF00 命令=BA45'], seen: 'NEC address=0x0440 command=0x3003', cli: ['--ir', '19,18'], tail: 1 },
  // F-08h IRremote SimpleSender: LEDC carrier envelope on GPIO4 -> the IR LED card's eye decodes the last of 3 NEC frames
  'arduino-lib-irremote': { clicks: [], wait: 'TRYBOARD_OK lib-irremote', expect: ['ir sent NEC addr=0x00 cmd=0x34', 'ir sent NEC addr=0x00 cmd=0x36', 'TRYBOARD_OK lib-irremote'], seen: 'NEC address=0xFF00 command=0xC936', cli: ['--ir', '-,4'], tail: 1 },
  'arduino-lib-irremote-rx': { clicks: [['[data-ir="FF00,BA45"]', 'ir NEC addr=0x00 cmd=0x45'], ['[data-ir="repeat"]', 'ir NEC addr=0x00 cmd=0x45 repeat']], expect: ['TRYBOARD_OK lib-irremote-rx ready', 'ir NEC addr=0x00 cmd=0x45', 'ir NEC addr=0x00 cmd=0x45 repeat'], cli: ['--ir', '5'], tail: 1 },
  // G-15 loopback: IR LED GPIO4 (LEDC) -> receiver GPIO5 on the same bench; no clicks, the sketch sends 3 codes itself
  'arduino-lib-irremote-loop': { clicks: [], wait: 'TRYBOARD_OK lib-irremote-loop', expect: ['ir sent NEC addr=0x10 cmd=0x41', 'ir got NEC addr=0x10 cmd=0x41', 'ir got NEC addr=0x10 cmd=0x43', 'ir loopback 3/3', 'TRYBOARD_OK lib-irremote-loop'], seen: 'NEC address=0xEF10 command=0xBC43', cli: ['--ir', '5,4'], tail: 1 },
  // G-09 I2C trio: the env slider must reach AHT20 / DS3231 (input log env=) and the bench parts the CLI as one pin bus
  'c3-i2c-trio': { clicks: [['env:temp=31', 'ds3231 31.00 C']], wait: 'TRYBOARD_OK c3-i2c-trio', expect: ['I2C scan (SDA=GPIO6, SCL=GPIO7): 0x38 0x40 0x68', 'checks: aht20=4/4 ina219=4/4 ds3231_time=4/4 alarm1=1', 'TRYBOARD_OK c3-i2c-trio', 'ds3231 31.00 C'], i2c: ['aht20', 'ina219', 'ds3231'], cli: ['--i2c-bus', 'sda=6,scl=7:aht20@0x38,ina219@0x40,ds3231@0x68'], tail: 2 },
  'c3-sh1106-pir': { clicks: [['[data-pir="wave"]', '有人经过，第 1 次']], expect: ['SH1106 人体感应屏启动', 'TRYBOARD_OK c3-sh1106-pir', '有人经过，第 1 次'], cli: ['--i2c-bus', 'sda=6,scl=7:sh1106@0x3c'], tail: 1 },
};
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);

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
  console.log(`[parts] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const hasText = (page, s, ms) => waitFor(page, (x) => document.getElementById('console').textContent.includes(x), s, ms);
function cliRun(fw, args, tag) {
  const p = spawnSync(CLI, ['run', fw, ...args], { maxBuffer: 64 << 20 });
  const out = path.join(outDir, `parts-${tag}.stdout`);
  const err = path.join(outDir, `parts-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), stderr: p.stderr.toString('utf8'), fp, code: p.status };
}
async function exportInputs(page) {
  return page.evaluate(async () => {
    let blobText = '';
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => { blobText = b; return orig.call(URL, b); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('moreBtn').click();
    for (let i = 0; i < 20 && !document.querySelector('[data-more="inputs"]'); i++) await new Promise((r) => setTimeout(r, 50));
    document.querySelector('[data-more="inputs"]').click();
    for (let i = 0; i < 50 && !blobText; i++) await new Promise((r) => setTimeout(r, 50));
    URL.createObjectURL = orig;
    HTMLAnchorElement.prototype.click = click;
    return blobText ? await blobText.text() : '';
  });
}

for (const id of ids) {
  const c = CASES[id];
  const fw = path.join(root, 'web/public/fw', id, 'flash.bin');
  const page = await browser.newPage();
  // Beginner mode is on by default (H-01); these checks target the full bench
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tb-beginner', '0'); } catch {} });
  page.on('pageerror', (e) => errors.push(`${id}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${id}: ${m.text()}`); });
  await page.goto(base + `/app?work=blank&example=${id}#bench`, { waitUntil: 'load' });
  const booted = await waitFor(page, () => parseFloat(document.getElementById('simtime').textContent) > 0.5, null, 30000);
  report(`${id}: bench boots`, booted);
  for (const [sel, want] of c.clicks) {
    // 'env:<key>=<v>' drags the example's environment slider instead of clicking
    const env = /^env:(\w+)=(.+)$/.exec(sel);
    const css = env ? `input[data-env="${env[1]}"]` : sel;
    const ok = await page.waitForSelector(css, { timeout: 10000 }).then(() => true).catch(() => false);
    if (ok && env) await page.$eval(css, (r, v) => { r.value = v; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }, env[2]);
    else if (ok) await page.click(sel);
    report(`${id}: click ${sel} -> serial "${want}"`, ok && (await hasText(page, want, 15000)));
  }
  if (c.seen) report(`${id}: IR LED card shows "${c.seen}"`, await waitFor(page, (x) => [...document.querySelectorAll('[data-ir-seen]')].some((e) => e.textContent.includes(x)), c.seen, 15000));
  if (c.wait) report(`${id}: serial "${c.wait}"`, await hasText(page, c.wait, 30000));
  await page.click('#runPause');
  await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
  await sleep(300);
  const log = await page.evaluate(() => globalThis.__tbInputLog());
  await page.screenshot({ path: path.join(outDir, `parts-${id}.png`) });
  fs.writeFileSync(path.join(outDir, `parts-${id}-inputs.json`), JSON.stringify(log, null, 1));
  const kinds = log.events.map((e) => e.kind + (e.kind === 'pir' ? `=${e.on ? 1 : 0}` : e.kind === 'lux' ? `=${e.lux}` : e.kind === 'card' ? `=${e.uid}` : e.kind === 'ir' ? `=${e.code}` : '')).join(' ');
  // I2C modules ride in log.i2c (CLI --i2c-bus), not log.parts (GPIO parts with their own flags)
  const carried = c.i2c ? c.i2c.every((k) => JSON.stringify(log.i2c ?? []).includes(k)) : !!log.parts;
  report(`${id}: input log carries the parts and their actions`, carried, `${JSON.stringify(c.i2c ? log.i2c : log.parts)}; ${kinds}`);
  const text = await exportInputs(page);
  const inputsFile = path.join(outDir, `parts-${id}-inputs.txt`);
  fs.writeFileSync(inputsFile, text);
  const SECS = Math.ceil(log.endMs / 1000 + c.tail);
  const web = await page.evaluate((l, s) => globalThis.__tbReplay(l, s), log, SECS);
  fs.writeFileSync(path.join(outDir, `parts-${id}-web.stdout`), web.stdout || '');
  fs.writeFileSync(path.join(outDir, `parts-${id}-web.report`), web.report || String(web.error));
  // Same --spi / --i2c derivation as inputlog.ts cliArgs (LCD panel first, then RC522)
  const spi = [...(log.lcd || log.spi ? [log.spi ?? 'gc9a01'] : []), ...(rc522Spec(log.parts ?? {}, log.chip) ? [rc522Spec(log.parts ?? {}, log.chip)] : [])];
  const i2c = i2cArgs(log.i2c ?? []);
  // The web report always lists WS2812 decoders (an RMT TX pin gets one), so the CLI needs --ws2812-log for the same lines
  const args = ['--seconds', String(SECS), '--gpio-log', '--ws2812-log', ...i2c, ...(spi.length ? ['--spi', spi.join(',')] : []), ...partsArgs(log.parts ?? {}), '--inputs', inputsFile];
  const r = cliRun(fw, args, id);
  report(`${id}: web replay and CLI fingerprints match`, web.fingerprint === r.fp && !web.error && r.code === 0, `web ${web.fingerprint} / CLI ${r.fp}; CLI ${args.join(' ')}`);
  if (c.cli) report(`${id}: CLI args carry ${c.cli.join(' ')}`, args.join(' ').includes(c.cli.join(' ')), args.join(' '));
  const miss = c.expect.filter((s) => !web.stdout.includes(s));
  report(`${id}: replay serial has the expected lines`, !miss.length, miss.length ? `missing ${JSON.stringify(miss)}` : `${c.expect.length} lines`);
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[parts] page errors:\n  ' + errors.join('\n  '));
console.log(`[parts] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
