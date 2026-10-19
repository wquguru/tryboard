// Custom work (U-17) web × CLI: generated checkpoints = fixtures/custom-thermo.json, c3-thermo passes, hello fails I2C with "need ≥".
// Usage: node tools/webtest/custom.mjs (after build_web.sh, build_fw.sh c3-thermo hello); UPDATE_FIXTURE=1 rewrites the fixture from the web
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
const fixture = path.join(root, 'tools/webtest/fixtures/custom-thermo.json');
const levels = JSON.parse(fs.readFileSync(fixture, 'utf8'));
const judged = levels.filter((l) => !l.manual).map((l) => l.id);
const manual = levels.filter((l) => l.manual).map((l) => l.id);

let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[custom] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

// ---- CLI (native core)
const native = (fw, id) => {
  let out;
  try {
    out = execFileSync(path.join(root, 'tools/check.py'), [path.join(root, `firmware/build/${fw}/flash.bin`), '--level-json', fixture, '--level', id], { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout;
  }
  const m = /: (PASS|FAIL|needs real hardware, not judged)(?:\s+fingerprint (\S+))?/.exec(out) ?? [];
  return { verdict: m[1], fp: m[2], out };
};
const cli = {};
for (const id of [...judged, ...manual]) {
  const r = native('c3-thermo', id);
  cli[id] = r;
  report(`CLI c3-thermo ${id}`, manual.includes(id) ? r.verdict === 'needs real hardware, not judged' : r.verdict === 'PASS', r.out.trim().split('\n')[0]);
}
const helloId = judged.find((id) => levels.find((l) => l.id === id).i2c_ack);
const cliHello = native('hello', helloId);
report(`CLI hello ${helloId} fails and says need ≥`, cliHello.verdict === 'FAIL' && cliHello.out.includes('need ≥'), cliHello.out.trim().split('\n').slice(0, 2).join(' / '));

// ---- Web
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
async function open(url) {
  // A fresh context each time: no progress left in local storage by the previous round
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await page.goto(base + url, { waitUntil: 'load' });
  return page;
}
const waitFor = (page, fn, arg, timeout) => page.waitForFunction(fn, { timeout, polling: 200 }, arg).then(() => true, () => false);
const cpMark = (page, id) => page.$eval(`[data-cp="${id}"] span:last-child`, (e) => e.textContent.trim()).catch(() => '');
/** Select a checkpoint and read the verdict and fingerprint from the properties panel */
async function pick(page, id) {
  for (let i = 0; i < 5; i++) {
    const ok = await page.evaluate((id) => { const b = document.querySelector(`[data-cp="${id}"]`); b?.click(); return !!b; }, id);
    if (ok && (await waitFor(page, (id) => document.querySelector('#props')?.textContent.includes(`Checkpoint ${id}`) && !!document.querySelector('#props .kv .v.fp'), id, 5000))) break;
    await sleep(300);
  }
  return {
    text: await page.$eval('#props', (e) => e.textContent).catch(() => ''),
    verdict: await page.$eval('#props .result-card', (e) => e.dataset.verdict).catch(() => ''),
    fp: await page.$eval('#props .kv .v.fp', (e) => e.textContent.trim()).catch(() => ''),
  };
}

const url = '/app?work=custom&t=weather&bat=1#bench';
{
  const page = await open(url);
  await page.waitForSelector('#customPlaced [data-custom-demo]', { timeout: 30000 });
  const web = await page.evaluate(() => globalThis.__tbCustomLevels);
  if (process.env.UPDATE_FIXTURE) {
    fs.writeFileSync(fixture, JSON.stringify(web, null, 2) + '\n');
    console.log(`[custom] rewrote ${path.relative(root, fixture)} with ${web.length} web-generated checkpoints; run again to compare`);
    process.exit(0);
  }
  report('web-generated checkpoints equal the fixture', JSON.stringify(web) === JSON.stringify(levels), `${web?.length} checkpoints`);
  await page.click('#customPlaced [data-custom-demo]');
  const buy = await waitFor(page, () => !!document.querySelector('#buyCard'), null, 120000);
  await page.screenshot({ path: path.join(outDir, 'custom-buy.png') });
  report('demo firmware run shows the buy-for-real card', buy);
  const fpBuy = await page.$eval('#buyCard [data-buy-fp]', (e) => e.textContent.trim()).catch(() => '');
  report('buy card fingerprint matches the CLI', fpBuy && fpBuy === cli[judged[0]].fp, `web ${fpBuy} / CLI ${cli[judged[0]].fp}`);
  // The buy card is an overlay: close it before clicking checkpoints
  await page.evaluate(() => document.querySelector('#buyCard button[aria-label="Close"]')?.click());
  for (const id of judged) {
    const mark = await cpMark(page, id);
    const r = await pick(page, id);
    // The demo firmware counts as a reference run ◐ (U-22); only your own firmware earns ✓
    report(`web c3-thermo ${id} ◐ reference run, same fingerprint`, mark === '◐' && r.verdict === 'ok' && r.fp === cli[id].fp, `mark ${mark} web ${r.fp} / CLI ${cli[id].fp}`);
  }
  for (const id of manual) report(`manual item ${id} is not in the judged list`, !(await page.$(`[data-cp="${id}"]`)) && !!(await page.$('[data-cp-manual]')));
  await page.close();
}
{
  const page = await open(url);
  await page.waitForSelector('#fwPick', { timeout: 30000 });
  // Wait for the bench to mount (the info card appears), then drop in hello
  await page.waitForSelector('#customPlaced', { timeout: 30000 });
  const input = await page.$('#fwPick');
  await input.uploadFile(path.join(root, 'firmware/build/hello/flash.bin'));
  const done = await waitFor(page, (id) => document.querySelector(`[data-cp="${id}"] span:last-child`)?.textContent.trim() === '✗', helloId, 120000);
  const r = await pick(page, helloId);
  await page.screenshot({ path: path.join(outDir, 'custom-hello.png') });
  report(`web hello ${helloId} ✗ says need ≥, same fingerprint`, done && r.text.includes('need ≥') && r.fp === cliHello.fp, `web ${r.fp} / CLI ${cliHello.fp}`);
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[custom] page errors:\n  ' + errors.join('\n  '));
console.log(`[custom] ${fails || errors.length ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails || errors.length ? 1 : 0);
