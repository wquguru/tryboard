// F-08f: the self-written Arduino NEC IR sender (RMT + 38 kHz carrier) uploaded on the web like a user's own .bin; serial and
// fingerprint must match the CLI. Usage: node tools/webtest/irnec.mjs (after tools/build_web.sh, the release CLI and tools/build_arduino.sh ir-nec-rmt)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toScript, cliArgs } from '../../web/src/inputlog.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const CLI = path.join(root, 'core/target/release/tryboard');
const BIN = path.join(root, 'firmware/build/arduino-ir-nec-rmt/flash.bin');
const DONE = 'TRYBOARD_OK ir-nec-rmt';
const SENT = 'ir sent NEC addr=0x00 cmd=0x36';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
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
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[irnec] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
/** CLI run with check.py's fingerprint rules (same as m5board.mjs) */
function cliRun(args, tag) {
  const p = spawnSync(CLI, ['run', ...args], { maxBuffer: 64 << 20 });
  const out = path.join(outDir, `irnec-${tag}.stdout`);
  const err = path.join(outDir, `irnec-${tag}.stderr`);
  fs.writeFileSync(out, p.stdout);
  fs.writeFileSync(err, p.stderr);
  const fp = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools'))}); import check
out = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace'); err = open(sys.argv[2], 'rb').read().decode('utf-8', 'replace')
print(check.fingerprint(out, check.canonical_report(err)))`, out, err], { encoding: 'utf8' }).trim();
  return { stdout: p.stdout.toString('utf8'), stderr: p.stderr.toString('utf8'), fp, code: p.status };
}

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}/app?work=blank&example=c3-wifi-resilient#bench`);
  await waitFor(page, () => !!globalThis.__tbApp?.session?.sim, null, 40000);
  // Same path as a user's own .bin: the firmware menu's file input
  await (await page.$('#fwPick')).uploadFile(BIN);
  await waitFor(page, (n) => globalThis.__tbApp.session.fwName === n, 'flash.bin', 10000);
  const up = await waitFor(page, (w) => globalThis.__tbApp.session.consoleText().includes(w), DONE, 60000);
  const text = await page.evaluate(() => globalThis.__tbApp.session.consoleText());
  report('web serial shows the NEC send lines', up && text.split(SENT).length === 3, text.slice(-160).replace(/\n/g, ' | '));
  await page.screenshot({ path: path.join(outDir, 'irnec.png') });

  await page.evaluate(() => globalThis.__tbApp.session.sim.pause());
  const snap = await page.evaluate(() => globalThis.__tbApp.session.sim.snapshot());
  const log = snap.log;
  const file = path.join(outDir, 'irnec-inputs.txt');
  fs.writeFileSync(file, toScript(log));
  const SECS = Math.max(2, Math.ceil(log.endMs / 1000));
  const wv = await page.evaluate((l, s) => globalThis.__tbReplay(l, s), log, SECS);
  const fpArgs = cliArgs(log, BIN, file, SECS).slice(2);
  fpArgs.splice(fpArgs.indexOf('--inputs'), 0, '--gpio-log', '--ws2812-log');
  const cf = cliRun(fpArgs, 'fp');
  report('web verify fingerprint = CLI fingerprint', wv.fingerprint === cf.fp && !wv.error, `web ${wv.fingerprint} / CLI ${cf.fp}${wv.error ? ' error ' + wv.error : ''}`);
  // The CLI eye on the IR LED decodes what the same firmware sends (the web has no IR receiver part yet)
  const eye = cliRun([BIN, '--seconds', '1', '--ir', '-,4'], 'eye');
  report('CLI eye decodes NEC 0x00 / 0x36', eye.stderr.includes('IR LED GPIO4: NEC address=0xFF00 command=0xC936 (38.0 kHz carrier)'));
  report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(`[irnec] ${fails ? 'FAIL' : 'PASS'} (${fails} failed, ${errors.length} page errors)`);
process.exit(fails ? 1 : 0);
