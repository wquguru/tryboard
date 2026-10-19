// Web smoke test: static server -> local Chrome opens an example -> wait for the expected serial text -> screenshot.
// Usage: node tools/webtest/webtest.mjs [example id=blink] [expected text=TRYBOARD_OK]
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });
const example = process.argv[2] || 'blink';
const expect = process.argv[3] || 'TRYBOARD_OK';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Extensionless paths (/app, /select) map to .html, like Vite preview and static hosting (DESIGN_V2 §7.2)
  let f = path.join(dist, u === '/' ? 'index.html' : u);
  if (!path.extname(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!f.startsWith(dist) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const t0 = Date.now();
await page.goto(`http://localhost:${port}/app?work=blank&example=${example}#bench`, { waitUntil: 'load' });
let ok = false;
for (let i = 0; i < 120; i++) {
  const text = await page.$eval('#console', (e) => e.textContent);
  if (text.includes(expect)) { ok = true; break; }
  if (/\[TryBoard\] (Stopped|Failed to start): /.test(text)) break;
  await new Promise((r) => setTimeout(r, 250));
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
// Environment slider: drag temperature to 31.5°C and the reading follows (UI -> worker -> sim device -> firmware)
if (ok && example === 'bme280' && (await page.$('.env input'))) {
  await page.$eval('.env input', (el) => {
    el.value = '31.5';
    el.dispatchEvent(new Event('input'));
  });
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await new Promise((r) => setTimeout(r, 250));
    seen = (await page.$eval('#console', (e) => e.textContent)).includes('T=31.50 C');
  }
  console.log(`[webtest] environment slider -> reading 31.50°C: ${seen ? 'PASS' : 'FAIL'}`);
  ok = ok && seen;
}
// Knob: drag the slider to 2400mV and the ADC reading follows (UI -> worker -> ADC -> firmware)
// The firmware converts without calibration, so the real ADC (D-02, raw 3604) prints about 2200mV
if (ok && example === 'pot') {
  // The example card renders only after the example list loads; the firmware may print its first line before that
  await page.waitForSelector('.env input', { timeout: 5000 });
  await page.$eval('.env input', (el) => {
    el.value = '2400';
    el.dispatchEvent(new Event('input'));
  });
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await new Promise((r) => setTimeout(r, 250));
    seen = /约 2[12]\d\d mV/.test(await page.$eval('#console', (e) => e.textContent)); // lint: allow-cjk (firmware serial)
  }
  console.log(`[webtest] knob 2400mV -> uncalibrated reading about 2200mV: ${seen ? 'PASS' : 'FAIL'}`);
  ok = ok && seen;
}
// Native USB: the virtual PC shows enumeration; the keyboard example types its line, the CDC example echoes input
if (ok && example === 's3-usb-keyboard') {
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    seen = await page.$eval('#usbTyped', (e) => e.textContent.includes('Hello from TryBoard!')).catch(() => false);
    if (!seen) await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`[webtest] virtual PC receives keyboard input: ${seen ? 'PASS' : 'FAIL'}`);
  ok = ok && seen;
}
if (ok && example === 's3-usb-cdc') {
  await page.type('#usbCdcIn', 'ping');
  await page.keyboard.press('Enter');
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await new Promise((r) => setTimeout(r, 250));
    seen = await page.$eval('#usbCdcOut', (e) => e.textContent.includes('ECHO: PING')).catch(() => false);
  }
  console.log(`[webtest] USB serial terminal ping -> ECHO: PING: ${seen ? 'PASS' : 'FAIL'}`);
  ok = ok && seen;
}
// Serial input (P2-13): type in #serialIn and press Enter; the firmware echoes it (web -> worker -> UART RX FIFO -> firmware)
if (ok && example === 'echo') {
  await page.type('#serialIn', 'hello tryboard');
  await page.keyboard.press('Enter');
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await new Promise((r) => setTimeout(r, 250));
    seen = (await page.$eval('#console', (e) => e.textContent)).includes('ECHO: hello tryboard');
  }
  const cleared = await page.$eval('#serialIn', (e) => e.value === '');
  console.log(`[webtest] serial input hello tryboard -> ECHO: hello tryboard: ${seen && cleared ? 'PASS' : 'FAIL'}`);
  ok = ok && seen && cleared;
}
// Take a few shots to catch the LED both on and off
for (let i = 0; i < 3; i++) {
  await page.screenshot({ path: path.join(outDir, `${example}-${i}.png`) });
  await new Promise((r) => setTimeout(r, 270));
}
const consoleText = await page.$eval('#console', (e) => e.textContent);
const ratio = await page.$eval('#ratio', (e) => e.textContent);
fs.writeFileSync(path.join(outDir, `${example}-console.txt`), consoleText);
await browser.close();
server.close();
console.log(`[webtest] ${example}: ${ok ? 'PASS' : 'FAIL'} (${secs}s, ${ratio})`);
if (errors.length) console.log('[webtest] page errors:\n  ' + errors.join('\n  '));
if (!ok) console.log(consoleText.slice(-1500));
process.exit(ok && !errors.length ? 0 : 1);
