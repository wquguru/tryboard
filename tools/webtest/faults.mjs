// Fault checkpoints (F-05): for each level, the bench as found must fail and the fix must pass, with the web verdict and run ID
// equal to tools/check.py given the same switches. Usage: node tools/webtest/faults.mjs (after tools/build_web.sh)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
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
  console.log(`[faults] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
async function waitFor(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}
/** Click by selector, re-found each try: the panels re-render on timeline updates */
async function clickEl(page, sel) {
  await page.waitForSelector(sel, { timeout: 30000 });
  for (let i = 0; i < 10; i++) {
    if (await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel)) return;
    await sleep(200);
  }
  throw new Error(`cannot click ${sel}`);
}

/** check.py verdict and run ID; args after `--level <id>` are the bench switches */
function cli(fw, id, flags) {
  let out;
  try {
    out = execFileSync(path.join(root, 'tools/check.py'), [fw, '--level', id, ...flags], { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout;
  }
  const m = out.match(/^Checkpoint ([\w-]+) .*: (PASS|FAIL)\s+fingerprint (\S+)/m);
  return m ? { ok: m[2] === 'PASS', fp: m[3] } : { ok: null, fp: '' };
}

const fpOf = (page) => page.$eval('#props .kv .v.fp', (e) => e.textContent.trim()).catch(() => '');
const verdictOf = (page) => page.$eval('#props .result-card', (e) => e.dataset.verdict).catch(() => '');
async function pick(page, id) {
  await clickEl(page, `#tree .tn[data-kind="checkpoint"][data-id="${id}"]`);
  await page.waitForSelector(`#faultKnobs[data-level="${id}"]`, { timeout: 30000 });
}
async function setKnob(page, flag, v) {
  await clickEl(page, `#faultKnobs button[data-flag="${flag}"][data-v="${v}"]`);
  await waitFor(page, ([f, x]) => document.querySelector(`#faultKnobs button[data-flag="${f}"][data-v="${x}"]`)?.getAttribute('aria-pressed') === 'true', [flag, v], 5000);
}
async function finish(page) {
  await waitFor(page, () => !!globalThis.__tbLastVerify && !!document.querySelector('#props .verdict-line') && !document.querySelector('#runRef')?.disabled && !document.querySelector('#props .drop.busy'), null, 120000);
  return { ok: (await verdictOf(page)) === 'ok', fp: await fpOf(page) };
}
async function runBench(page) {
  await page.evaluate(() => (globalThis.__tbLastVerify = null));
  await clickEl(page, '#runRef:not([disabled])');
  return finish(page);
}
async function runOwn(page, bin) {
  await page.evaluate(() => (globalThis.__tbLastVerify = null));
  for (let k = 0; ; k++) {
    try {
      const input = await page.$('#props [data-drop="check"] input:not([disabled])');
      await input.uploadFile(bin);
      break;
    } catch (e) {
      if (k >= 4) throw e;
      await sleep(300);
    }
  }
  return finish(page);
}

const levels = JSON.parse(fs.readFileSync(path.join(root, 'firmware/levels.json'), 'utf8')).filter((l) => l.fault);
report('3–5 fault checkpoints in levels.json', levels.length >= 3 && levels.length <= 5, levels.map((l) => l.id).join(' '));
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// Fresh profile: no saved switches, every bench starts as found
await page.goto(`${base}/app?work=faults#bench`, { waitUntil: 'load' });
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tryboard-fault-knobs:')) localStorage.removeItem(k); });
await page.reload({ waitUntil: 'load' });
for (const l of levels) {
  const f = l.fault;
  const merged = [...(l.args ?? [])];
  for (let i = 0; i + 1 < (f.args ?? []).length; i += 2) {
    const j = merged.indexOf(f.args[i]);
    if (j >= 0) merged[j + 1] = f.args[i + 1];
    else merged.push(f.args[i], f.args[i + 1]);
  }
  const found = (f.knobs ?? []).flatMap((k) => { const j = merged.indexOf(k.flag); return [k.flag, j >= 0 ? merged[j + 1] : k.options[0].v]; });
  await pick(page, l.id);
  const refBin = path.join(root, `firmware/build/${l.ref}/flash.bin`);
  // As found: fails on both sides with the same run ID
  const w0 = await runBench(page);
  const c0 = cli(refBin, l.id, found);
  report(`${l.id} as found`, !w0.ok && c0.ok === false && w0.fp === c0.fp, `web ${w0.ok ? 'pass' : 'fail'} ${w0.fp} / CLI ${c0.ok ? 'pass' : 'fail'} ${c0.fp}`);
  // Fixed: the reference bench fix through the switches, or the reference firmware fix dropped in
  let w1, c1;
  if (f.fix) {
    for (let i = 0; i + 1 < f.fix.length; i += 2) await setKnob(page, f.fix[i], f.fix[i + 1]);
    const fixed = found.slice();
    for (let i = 0; i + 1 < f.fix.length; i += 2) fixed[fixed.indexOf(f.fix[i]) + 1] = f.fix[i + 1];
    w1 = await runBench(page);
    c1 = cli(refBin, l.id, fixed);
  } else {
    const bin = path.join(root, `firmware/build/${f.fix_ref}/flash.bin`);
    w1 = await runOwn(page, bin);
    c1 = cli(bin, l.id, found);
  }
  report(`${l.id} fixed`, w1.ok && c1.ok && w1.fp === c1.fp, `web ${w1.ok ? 'pass' : 'fail'} ${w1.fp} / CLI ${c1.ok ? 'pass' : 'fail'} ${c1.fp}`);
  await page.screenshot({ path: path.join(outDir, `faults-${l.id}.png`) });
}
// Switches survive a reload (per-viewer convenience) and the shown command carries them
await page.reload({ waitUntil: 'load' });
await pick(page, 'fault-wire');
const cmd = await page.$eval('#faultKnobs', (e) => e.textContent);
report('switches kept after reload, command carries them', cmd.includes('--level fault-wire --i2c-wire 20'));
await browser.close();
server.close();
if (errors.length) console.log('[faults] page errors:\n  ' + errors.join('\n  '));
console.log(`[faults] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
