// F-07b MicroPython main.py editor: upload the official C3 image -> edit main.py -> Run (raw-paste + soft reset) -> serial output
// -> CLI --inputs replay byte-identical; reload restores the kept bin and re-sends main.py (F-07c); Forget -> default firmware.

// Usage: node tools/webtest/micropython.mjs (after tools/build_web.sh and tools/fetch_third_party.sh --micropython; SKIP without the bin)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(root, 'third_party/micropython/ESP32_GENERIC_C3-20260824-v1.29.0.bin');
if (!fs.existsSync(BIN)) {
  console.log(`[micropython] SKIP: ${path.relative(root, BIN)} missing (tools/fetch_third_party.sh --micropython)`);
  process.exit(0);
}
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const CLI = process.env.TRYBOARD_CLI || path.join(root, 'core/target/release/tryboard');
// ; # \ and non-ASCII exercise the serial escapes (\xNN in the input log) and the bytes literal of the writer
const MAIN = `import time
print("mpy web", sum(range(10)), "a;b#c\\\\d", "你好")
for i in range(3):
    print("mpy tick", i)
    time.sleep_ms(100)
print("mpy end")
`;

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
  console.log(`[micropython] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const consoleHas = (page, s, ms) => waitFor(page, (x) => document.getElementById('console').textContent.includes(x), s, ms);

async function openWithBin(page) {
  await page.goto(base + '/app?work=blank&example=hello#bench', { waitUntil: 'load' });
  await waitFor(page, () => parseFloat(document.getElementById('simtime').textContent) > 0.2, null, 30000);
  await (await page.$('#fwPick')).uploadFile(BIN);
  const tab = await waitFor(page, () => !!document.querySelector('[data-dock="py"]'), null, 20000);
  const ready = await waitFor(page, () => document.getElementById('mpyRun') && !document.getElementById('mpyRun').disabled, null, 30000);
  return tab && ready;
}

// ---- 1. Upload, edit, run
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/app?work=blank&example=hello#bench', { waitUntil: 'load' });
await page.evaluate(() => localStorage.removeItem('tryboard-mpy-main'));
report('upload MicroPython C3 -> main.py tab, REPL ready', await openWithBin(page));
report('banner on serial', await consoleHas(page, 'MicroPython v1.29.0', 5000));
// The editor is a controlled textarea: set through the native setter so React sees an input event
await page.$eval('#mpyEditor', (el, v) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, MAIN);
await page.click('#mpyRun');
const done = await waitFor(page, () => /main\.py/.test(document.getElementById('mpyStatus')?.textContent ?? '') && document.getElementById('mpyStatus').className.includes('ok-ink'), null, 30000);
report('Run: raw-paste upload + soft reset', done, await page.$eval('#mpyStatus', (e) => e.textContent));
const ran = await consoleHas(page, 'mpy end', 20000);
const con = await fwConsole(page);
report('main.py output on serial', ran && con.includes('mpy web 45 a;b#c\\d 你好') && con.includes('mpy tick 2') && con.includes('MPY: soft reboot'));
report('output box in the pane', (await page.$eval('#mpyOut', (e) => e.textContent)).includes('mpy tick 2'));
// Ctrl-D button: soft reset runs main.py again
const before = (con.match(/mpy end/g) || []).length;
await page.click('#mpyCtrlD');
const again = await waitFor(page, (n) => (document.getElementById('console').textContent.match(/mpy end/g) || []).length > n, before, 15000);
report('Ctrl-D soft reset runs main.py again', again);
await page.screenshot({ path: path.join(outDir, 'micropython-web.png') });

// ---- 2. Export the input log, replay on the CLI to the same simulated time: serial byte-identical
await page.click('#runPause');
await waitFor(page, () => /Paused/.test(document.getElementById('runState').textContent), null, 5000);
await sleep(300);
const log = await page.evaluate(() => globalThis.__tbInputLog());
const live = await fwConsole(page);
const text = await page.evaluate(async () => {
  let blob = null;
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  document.getElementById('moreBtn').click();
  for (let i = 0; i < 20 && !document.querySelector('[data-more="inputs"]'); i++) await new Promise((r) => setTimeout(r, 50));
  document.querySelector('[data-more="inputs"]').click();
  for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 50));
  URL.createObjectURL = orig;
  HTMLAnchorElement.prototype.click = click;
  return blob ? await blob.text() : '';
});
const inputsFile = path.join(outDir, 'micropython-inputs.txt');
fs.writeFileSync(inputsFile, text);
fs.writeFileSync(path.join(outDir, 'micropython-web.stdout'), live);
report('input log has the raw-paste handshake (\\x01, \\x05A\\x01, \\x04) and escaped ; # \\', /uart=\\x01$/m.test(text) && /uart=\\x05A\\x01$/m.test(text) && /uart=\\x04$/m.test(text) && text.includes('a\\x3bb\\x23c'),
  `${text.split('\n').filter((l) => /:uart=/.test(l)).length} uart lines`);
const cycles = Math.round(log.endMs * (CPU_HZ / 1000));
const p = spawnSync(CLI, ['run', BIN, '--seconds', String((cycles + 0.5) / CPU_HZ), '--inputs', inputsFile], { maxBuffer: 64 << 20 });
if (p.error) throw new Error(`${CLI}: ${p.error.message} (build it with cargo build -p tryboard-cli --release, or set TRYBOARD_CLI)`);
const cli = p.stdout.toString('utf8');
fs.writeFileSync(path.join(outDir, 'micropython-cli.stdout'), cli);
// The console keeps the blank example's output from before the upload; the input log starts at the image swap
const mine = live.slice(Math.max(0, live.length - cli.length));
const same = cli.length > 0 && mine === cli && cli.startsWith('Performing initial setup') && !live.slice(0, live.length - cli.length).includes('MicroPython v');
let at = -1;
if (!same) at = Math.max(0, [...cli].findIndex((c, i) => c !== [...mine][i]));
report('CLI --inputs replay = web serial since the upload (byte for byte)', same && p.status === 0 && cli.includes('mpy tick 2'),
  same ? `${cli.length} chars, ${cycles} cycles` : `differs at ${at}: ${JSON.stringify(cli.slice(at, at + 40))} vs ${JSON.stringify(mine.slice(at, at + 40))}`);

// ---- 3. Reload (F-07c): the bin and main.py are kept in this browser; no re-upload, main.py is re-sent by itself
await page.reload({ waitUntil: 'load' });
const kept = await page.evaluate(() => localStorage.getItem('tryboard-mpy-main'));
report('main.py kept in this browser', kept === MAIN);
const restored = await waitFor(page, () => !!document.querySelector('[data-dock="py"]') && document.getElementById('mpyRun') && !document.getElementById('mpyRun').disabled, null, 40000);
report('reload without re-upload -> bin restored, main.py tab', restored);
report('saved main.py re-sent automatically after power-up', await consoleHas(page, 'mpy end', 30000));
await page.screenshot({ path: path.join(outDir, 'micropython-reload.png') });

// ---- 4. Forget the bin: next reload starts with the default firmware; uploading again still works
await page.click('#swapFw');
await waitFor(page, () => !!document.querySelector('[data-fw="forget"]'), null, 5000);
await page.click('[data-fw="forget"]');
const gone = await waitFor(page, async () => {
  const db = await new Promise((r) => { const q = indexedDB.open('tryboard-bins', 1); q.onsuccess = () => r(q.result); });
  const n = await new Promise((r) => { const q = db.transaction('bins').objectStore('bins').count(); q.onsuccess = () => r(q.result); });
  db.close();
  return n === 0;
}, null, 5000);
report('Forget deletes the local copy', gone);
await page.reload({ waitUntil: 'load' });
await waitFor(page, () => parseFloat(document.getElementById('simtime').textContent) > 1, null, 30000);
report('after Forget + reload: default firmware, no main.py tab', !(await page.$('[data-dock="py"]')) && !(await fwConsole(page)).includes('MicroPython v'));
report('upload again after Forget -> main.py tab', await openWithBin(page));

await browser.close();
server.close();
if (errors.length) console.log('[micropython] page errors:\n  ' + errors.join('\n  '));
console.log(`[micropython] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
