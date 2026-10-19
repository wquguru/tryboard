// 选板作品（work=custom，U-17）的网页 × 命令行对拍：
//  1. 网页按 ?t=weather&bat=1 生成的检查点（globalThis.__tbCustomLevels）与 fixtures/custom-thermo.json 逐字相同
//     ——fixture 是 genLevels 对 xiao-c3 + bme280 + ssd1306 + 电池的输出，check.py / npm 包用它判
//  2. 命令行：c3-thermo 过全部要判的检查点、手动项「不判」；hello 在 I2C 项上未通过，结论里有「要 ≥」
//  3. 网页：先跑演示固件 → 每条检查点 ✓、真买卡出现，指纹与命令行一致；上传 hello → I2C 项 ✗、写「要 ≥」，指纹一致
// 用法：node tools/webtest/custom.mjs（先 tools/build_web.sh、tools/build_fw.sh c3-thermo hello）。截图在 Reviews/web/custom-*.png
// genlevels.ts 或选板数据（模板零件、引脚表）改了：UPDATE_FIXTURE=1 node tools/webtest/custom.mjs 用网页生成的结果重写 fixture，再看 diff 是否合理
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

// ---- 命令行（原生内核）
const native = (fw, id) => {
  let out;
  try {
    out = execFileSync(path.join(root, 'tools/check.py'), [path.join(root, `firmware/build/${fw}/flash.bin`), '--level-json', fixture, '--level', id], { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout;
  }
  const m = /：(通过|未通过|必须上真机，不判)(?:\s+指纹 (\S+))?/.exec(out) ?? [];
  return { verdict: m[1], fp: m[2], out };
};
const cli = {};
for (const id of [...judged, ...manual]) {
  const r = native('c3-thermo', id);
  cli[id] = r;
  report(`命令行 c3-thermo ${id}`, manual.includes(id) ? r.verdict === '必须上真机，不判' : r.verdict === '通过', r.out.trim().split('\n')[0]);
}
const helloId = judged.find((id) => levels.find((l) => l.id === id).i2c_ack);
const cliHello = native('hello', helloId);
report(`命令行 hello ${helloId} 未通过且写「要 ≥」`, cliHello.verdict === '未通过' && cliHello.out.includes('要 ≥'), cliHello.out.trim().split('\n').slice(0, 2).join(' / '));

// ---- 网页
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
  // 每次独立上下文：不带上一轮存在本机的进度
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await page.goto(base + url, { waitUntil: 'load' });
  return page;
}
const waitFor = (page, fn, arg, timeout) => page.waitForFunction(fn, { timeout, polling: 200 }, arg).then(() => true, () => false);
const cpMark = (page, id) => page.$eval(`[data-cp="${id}"] span:last-child`, (e) => e.textContent.trim()).catch(() => '');
/** 选中一条检查点，读属性面板里的结论与指纹 */
async function pick(page, id) {
  for (let i = 0; i < 5; i++) {
    const ok = await page.evaluate((id) => { const b = document.querySelector(`[data-cp="${id}"]`); b?.click(); return !!b; }, id);
    if (ok && (await waitFor(page, (id) => document.querySelector('#props')?.textContent.includes(`检查点 ${id}`) && !!document.querySelector('#props .kv .v.fp'), id, 5000))) break;
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
    console.log(`[custom] 已用网页生成的 ${web.length} 条检查点重写 ${path.relative(root, fixture)}，请重新运行对拍`);
    process.exit(0);
  }
  report('网页生成的检查点与 fixture 相同', JSON.stringify(web) === JSON.stringify(levels), `${web?.length} 条`);
  await page.click('#customPlaced [data-custom-demo]');
  const buy = await waitFor(page, () => !!document.querySelector('#buyCard'), null, 120000);
  await page.screenshot({ path: path.join(outDir, 'custom-buy.png') });
  report('演示固件跑完出现真买卡', buy);
  const fpBuy = await page.$eval('#buyCard [data-buy-fp]', (e) => e.textContent.trim()).catch(() => '');
  report('真买卡指纹与命令行一致', fpBuy && fpBuy === cli[judged[0]].fp, `网页 ${fpBuy} / 命令行 ${cli[judged[0]].fp}`);
  // 真买卡是浮层：关掉再点检查点
  await page.evaluate(() => document.querySelector('#buyCard button[aria-label="关闭"]')?.click());
  for (const id of judged) {
    const mark = await cpMark(page, id);
    const r = await pick(page, id);
    report(`网页 c3-thermo ${id} ✓，指纹一致`, mark === '✓' && r.verdict === 'ok' && r.fp === cli[id].fp, `标记 ${mark} 网页 ${r.fp} / 命令行 ${cli[id].fp}`);
  }
  for (const id of manual) report(`手动项 ${id} 不在要判的列表里`, !(await page.$(`[data-cp="${id}"]`)) && !!(await page.$('[data-cp-manual]')));
  await page.close();
}
{
  const page = await open(url);
  await page.waitForSelector('#fwPick', { timeout: 30000 });
  // 等实验台挂好（说明卡出现），再拖入 hello
  await page.waitForSelector('#customPlaced', { timeout: 30000 });
  const input = await page.$('#fwPick');
  await input.uploadFile(path.join(root, 'firmware/build/hello/flash.bin'));
  const done = await waitFor(page, (id) => document.querySelector(`[data-cp="${id}"] span:last-child`)?.textContent.trim() === '✗', helloId, 120000);
  const r = await pick(page, helloId);
  await page.screenshot({ path: path.join(outDir, 'custom-hello.png') });
  report(`网页 hello ${helloId} ✗ 且写「要 ≥」，指纹一致`, done && r.text.includes('要 ≥') && r.fp === cliHello.fp, `网页 ${r.fp} / 命令行 ${cliHello.fp}`);
  await page.close();
}

await browser.close();
server.close();
if (errors.length) console.log('[custom] 页面错误:\n  ' + errors.join('\n  '));
console.log(`[custom] ${fails || errors.length ? 'FAIL' : 'PASS'}（失败 ${fails} 项，页面错误 ${errors.length} 条）`);
process.exit(fails || errors.length ? 1 : 0);
