// Beginner "What happened" + code highlight (H-03): lesson 01 step 4 runs s3-blink; first GPIO5 rows = CLI --trace-io cycles,
// code pane follows gpio_set_level, off = no lesson tab. Usage: node tools/webtest/lessonfeed.mjs [dist dir, default web/dist]; TB_CLI overrides the CLI path; output in Reviews/web/lessonfeed-*
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.resolve(process.argv[2] ?? path.join(root, 'web/dist'));
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CPU_HZ = 160_000_000;
const FW = path.join(root, 'firmware/build/s3-blink/flash.bin');
const CLI = process.env.TB_CLI || path.join(root, 'core/target/release/tryboard');
const N = 4;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f0 = path.join(dist, u === '/' ? 'index.html' : u);
  const f = !path.extname(f0) && fs.existsSync(f0 + '.html') ? f0 + '.html' : f0;
  if (!f.startsWith(dist) || !fs.existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[lessonfeed] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
const errors = [];
const page = await browser.newPage();
// Beginner on, lesson 01 parked on step 4 ("Run the code")
await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('tb-beginner', '1');
    localStorage.setItem('tryboard-app-lesson:weather', '{"01":3}');
  } catch {}
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto(base + '/app?work=weather&debug=1#bench', { waitUntil: 'load' });
await waitFor(page, () => globalThis.__tbApp?.hist && globalThis.__tbApp.store.get().simSeconds > 0.3, null, 30000);
const dockTab = () => page.$eval('#dock', (e) => e.dataset.tab).catch(() => null);
await waitFor(page, () => !!document.querySelector('#lessonCard'), null, 10000);
report('lesson up: dock opens on "What happened"', (await dockTab()) === 'lesson' && !!(await page.$('#dock [data-dock="lesson"]')), `tab=${await dockTab()}`);
report('feed present, step 4 card', !!(await page.$('#lessonFeed')) && (await page.$eval('#lessonCard', (e) => e.dataset.step)) === '3');
const pre = await page.$eval('#lessonFeed', (e) => `${e.querySelectorAll('[data-ev]').length}|${e.textContent}`);
report('empty before Run (the weather firmware drives no GPIO5 edges)', /^0\|.*Not run yet/.test(pre), pre.slice(0, 60));

await page.click('#lessonRun');
const got = await waitFor(page, (n) => document.querySelectorAll('#lessonFeed [data-ev]').length >= n, N + 1, 20000);
const hlRun = await page.$$eval('#codeBody tr[data-hl]', (rs) => rs.map((r) => r.dataset.line).join(','));
const codeOk = await page.$eval('#codeView', (e) => `${e.dataset.state}/${e.dataset.fw}/${e.querySelector('[aria-selected="true"][data-file]')?.dataset.file}`).catch(() => '');
const follow = await page.$eval('#codeFollow', (e) => e.textContent).catch(() => '');
await page.evaluate(() => globalThis.__tbApp.session.sim.pause());
await sleep(400);
const rows = await page.$$eval('#lessonFeed [data-ev]', (rs) => rs.map((r) => ({ t: Number(r.dataset.t), pin: Number(r.dataset.pin), v: Number(r.dataset.level), text: r.textContent })));
await page.screenshot({ path: path.join(outDir, 'lessonfeed-run.png') });
report(`feed has > ${N} rows after Run`, got, `${rows.length} rows`);
const order = rows.every((r, i) => i === 0 || r.t <= rows[i - 1].t);
report('newest row on top', order);
const first = [...rows].sort((a, b) => a.t - b.t).slice(0, N);
report('rows read in plain words', /LED on/.test(rows.find((r) => r.v)?.text ?? '') && /GPIO5 → high 3\.3 V/.test(rows.find((r) => r.v)?.text ?? '') && /LED off.*GPIO5 → low 0 V/.test(rows.find((r) => !r.v)?.text ?? ''), rows[0]?.text);
report('code pane: lesson source, gpio_set_level line followed', codeOk === 'ok/s3-blink/blink/main/main.c' && hlRun === '22' && /follows events/.test(follow), `${codeOk} hl=${hlRun} "${follow}"`);

// CLI reference for the same firmware
const traceFile = path.join(outDir, 'lessonfeed-cli.txt');
const p = spawnSync(CLI, ['run', FW, '--seconds', '1.2', '--trace-io', traceFile, '--trace-pins', '5'], { maxBuffer: 64 << 20 });
fs.writeFileSync(path.join(outDir, 'lessonfeed-cli.stderr'), p.stderr ?? '');
const cli = p.status === 0 ? fs.readFileSync(traceFile, 'utf8').split('\n').filter((l) => /^\d+ GPIO 5 \d$/.test(l)).slice(0, N).map((l) => l.split(' ')) : [];
const pair = first.map((w, i) => `${w.t}/${cli[i]?.[0]} (${(w.t / CPU_HZ * 1000).toFixed(3)} ms, ${w.v}/${cli[i]?.[3]})`).join('; ');
const same = cli.length === N && first.length === N && first.every((w, i) => w.t === Number(cli[i][0]) && w.v === Number(cli[i][3]));
const sameMs = cli.length === N && first.length === N && first.every((w, i) => Math.floor(w.t / 160000) === Math.floor(Number(cli[i][0]) / 160000) && w.v === Number(cli[i][3]));
report(`first ${N} GPIO5 rows = CLI --trace-io (same cycle)`, same, `web/cli: ${pair}${!same && sameMs ? ' (same ms only)' : ''}`);
fs.writeFileSync(path.join(outDir, 'lessonfeed-web.txt'), rows.map((r) => `${r.t} GPIO ${r.pin} ${r.v}  ${r.text}`).join('\n') + '\n');

// Still: the highlight goes back to the current step's lines (step 5 = the delay line)
await page.click('#lessonSteps [data-step="4"]');
const step5 = await waitFor(page, () => [...document.querySelectorAll('#codeBody tr[data-hl]')].map((r) => r.dataset.line).join(',') === '25', null, 5000);
report('paused: highlight follows the step (step 5 -> line 25)', step5, await page.$$eval('#codeBody tr[data-hl]', (rs) => rs.map((r) => r.dataset.line).join(',')));

// Raw serial is one click away
await page.click('#lessonRawSerial');
await waitFor(page, () => document.querySelector('#dock')?.dataset.tab === 'serial', null, 3000);
report('"Raw serial" switches to the serial tab', (await dockTab()) === 'serial' && /LED (ON|OFF)/.test(await page.$eval('#serialView', (e) => e.textContent)));

// Code tab in a lesson shows the same source and highlight
await page.click('#dock [data-dock="code"]');
await waitFor(page, () => document.querySelector('#codeView')?.dataset.state === 'ok', null, 5000);
report('Code tab: lesson source + highlight', (await page.$eval('#codeView', (e) => e.dataset.fw)) === 's3-blink' && (await page.$$eval('#codeBody tr[data-hl]', (rs) => rs.length)) === 1);

// Beginner off: no lesson tab, dock back on serial, code pane without highlight
await page.click('#dock [data-dock="lesson"]');
await page.click('#beginnerBtn');
await waitFor(page, () => !document.querySelector('#lessonSteps'), null, 3000);
report('off: no "What happened" tab, dock on serial', !(await page.$('#dock [data-dock="lesson"]')) && (await dockTab()) === 'serial', `tab=${await dockTab()}`);
await page.click('#dock [data-dock="code"]');
await waitFor(page, () => document.querySelector('#codeView')?.dataset.state === 'ok', null, 5000);
report('off: code pane has no highlight or follow note', !(await page.$('#codeBody tr[data-hl]')) && !(await page.$('#codeFollow')));

// ---- H-08: lessons 02 (BOOT button) and 03 (OLED over I2C), parked on their "Run" step
async function lessonPage(cp) {
  const p = await browser.newPage();
  await p.evaluateOnNewDocument((cp) => {
    try {
      localStorage.setItem('tb-beginner', '1');
      localStorage.setItem('tryboard-app-lesson:weather', JSON.stringify({ [cp]: 3 }));
    } catch {}
  }, cp);
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await p.goto(`${base}/app?work=weather&cp=${cp}&debug=1#bench`, { waitUntil: 'load' });
  await waitFor(p, () => globalThis.__tbApp?.hist && !!document.querySelector('#lessonCard'), null, 30000);
  return p;
}
const simNow = (p) => p.evaluate(() => parseFloat(document.getElementById('simtime')?.textContent ?? '0'));
const p2 = await lessonPage('02');
report('02: lesson 2 title + run step', /Lesson 2/.test(await p2.$eval('#lessonTitle', (e) => e.textContent).catch(() => '')) && !!(await p2.$('#lessonRun')));
await p2.click('#lessonRun');
await waitFor(p2, () => /s3-button/.test(document.querySelector('#toast')?.textContent ?? ''), null, 8000);
const t2 = await simNow(p2);
await waitFor(p2, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.5, t2, 15000);
const bpos = await p2.evaluate(() => globalThis.__tbButtonPos('BOOT'));
if (bpos) {
  await p2.mouse.move(bpos[0], bpos[1]);
  await p2.mouse.down();
  const t0 = await simNow(p2);
  await waitFor(p2, (t) => parseFloat(document.getElementById('simtime').textContent) > t + 0.15, t0, 10000);
  await p2.mouse.up();
}
const pressed = await waitFor(p2, () => {
  const rs = [...document.querySelectorAll('#lessonFeed [data-ev]')].map((r) => `${r.dataset.pin}/${r.dataset.level}`);
  return rs.includes('0/0') && rs.includes('0/1') && rs.includes('5/1');
}, null, 10000);
const rows2 = await p2.$$eval('#lessonFeed [data-ev]', (rs) => rs.map((r) => r.textContent).reverse());
report('02: BOOT press / release + LED on in the feed', !!bpos && pressed && rows2.some((x) => /BOOT pressed.*GPIO0 → low 0 V/.test(x)), rows2.join(' | ').slice(0, 200));
await p2.screenshot({ path: path.join(outDir, 'lessonfeed-02.png') });
await p2.close();

const p3 = await lessonPage('03');
report('03: lesson 3 title + run step', /Lesson 3/.test(await p3.$eval('#lessonTitle', (e) => e.textContent).catch(() => '')) && !!(await p3.$('#lessonRun')));
await p3.click('#lessonRun');
const i2c = await waitFor(p3, () => document.querySelectorAll('#lessonFeed [data-i2c="0x3C"]').length >= 2, null, 20000);
await p3.evaluate(() => globalThis.__tbApp.session.sim.pause());
await sleep(300);
const rows3 = await p3.$$eval('#lessonFeed [data-ev]', (rs) => rs.map((r) => ({ t: Number(r.dataset.t), a: r.dataset.i2c, n: Number(r.dataset.bytes), text: r.textContent })).reverse());
// One row per refresh: init + first frame merge (~1 KB), then ~1 s apart, never a row per transaction
const gaps = rows3.slice(1).map((r, i) => (r.t - rows3[i].t) / CPU_HZ);
report('03: I2C rows to 0x3C, one per refresh', i2c && rows3.every((r) => r.a === '0x3C' && r.n >= 1024) && gaps.every((g) => g > 0.9) && /Screen updated: \d+ bytes sent.*I2C → 0x3C/.test(rows3[0]?.text ?? ''), rows3.map((r) => `${(r.t / CPU_HZ).toFixed(2)}s ${r.n}B`).join(', '));
const hl3 = await p3.$$eval('#codeBody tr[data-hl]', (rs) => rs.map((r) => r.dataset.line).join(','));
report('03: code follows flush()', hl3 === '69', `hl=${hl3}`);
await p3.screenshot({ path: path.join(outDir, 'lessonfeed-03.png') });
await p3.close();

await browser.close();
server.close();
if (errors.length) console.log('[lessonfeed] page errors:\n  ' + errors.join('\n  '));
console.log(`[lessonfeed] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
