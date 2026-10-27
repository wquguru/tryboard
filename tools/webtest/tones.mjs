// Lesson 6 buzzer (H-24): the Web Audio output really plays do / re / mi (262 / 294 / 330 Hz), judged on AnalyserNode spectra (AGENTS §6.3).
// Usage: node tools/webtest/tones.mjs [dist dir, default web/dist] [--runs N]; samples in Reviews/web/tones-<run>.json
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const runsAt = argv.indexOf('--runs');
const RUNS = runsAt >= 0 ? Number(argv.splice(runsAt, 2)[1]) : 1;
const dist = path.resolve(argv[0] ?? path.join(root, 'web/dist'));
const outDir = path.join(root, 'Reviews/web');
fs.mkdirSync(outDir, { recursive: true });

const NOTES = [
  ['do', 262],
  ['re', 294],
  ['mi', 330],
];
/** Test-only tap with no smoothing: 8192 points (~170 ms at 48 kHz) fit inside one 270 ms note. */
const HI_FFT = 8192;
const SAMPLE_S = 4;

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
  args: ['--use-angle=metal', '--enable-gpu', '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`[tones] ${name}: ${ok ? 'PASS' : 'FAIL'}${extra ? '  ' + extra : ''}`);
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
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** In the page: sample the product analyser and a hi-res tap every 20 ms of audio time. */
function sampler(hiFft, seconds) {
  const a = globalThis.__tbApp.session.audio;
  const ctx = a.ctx;
  const lo = a.analyser;
  const hi = ctx.createAnalyser();
  hi.fftSize = hiFft;
  hi.smoothingTimeConstant = 0;
  lo.connect(hi);
  const lb = new Float32Array(lo.frequencyBinCount);
  const hb = new Float32Array(hi.frequencyBinCount);
  // Strongest bin, refined by a parabola through its neighbours (dB), as [Hz, dB, raw bin Hz]
  const peak = (an, b) => {
    an.getFloatFrequencyData(b);
    let k = 1;
    for (let i = 2; i < b.length - 1; i++) if (b[i] > b[k]) k = i;
    const [y0, y1, y2] = [b[k - 1], b[k], b[k + 1]];
    const d = y0 - 2 * y1 + y2 < 0 ? (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2) : 0;
    const w = ctx.sampleRate / an.fftSize;
    return [(k + d) * w, y1, k * w];
  };
  return new Promise((done) => {
    const out = { rate: ctx.sampleRate, loFft: lo.fftSize, loSmooth: lo.smoothingTimeConstant, hiFft, samples: [] };
    const t0 = ctx.currentTime;
    const id = setInterval(() => {
      const [lHz, lDb, lBin] = peak(lo, lb);
      const [hHz, hDb] = peak(hi, hb);
      out.samples.push({ t: +(ctx.currentTime - t0).toFixed(4), sim: a.state.lastFreq, on: a.state.sounding, peakHz: a.state.peakHz, lHz, lBin, lDb, hHz, hDb });
      if (ctx.currentTime - t0 >= seconds) {
        clearInterval(id);
        lo.disconnect(hi);
        done(out);
      }
    }, 20);
  });
}

/** Runs of consecutive loud hi-res samples at one pitch (within 2 %); a run is one note as heard. */
function runsOf(samples) {
  const runs = [];
  let cur = null;
  for (const s of samples) {
    const loud = s.hDb > -60;
    if (loud && cur && Math.abs(s.hHz - cur.f) / cur.f < 0.02) {
      cur.s.push(s);
      continue;
    }
    if (cur && cur.s.length) runs.push(cur);
    cur = loud ? { f: s.hHz, s: [s] } : null;
  }
  if (cur) runs.push(cur);
  // At least 100 ms of steady pitch; shorter blips are window edges straddling two notes
  return runs.filter((r) => r.s[r.s.length - 1].t - r.s[0].t >= 0.1).map((r) => ({ ...r, f: median(r.s.map((s) => s.hHz)) }));
}

const summary = [];
const errors = [];
for (let run = 1; run <= RUNS; run++) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}/app?work=basics&cp=basics-buzz&debug=1#bench`, { waitUntil: 'load' });
  await waitFor(page, () => globalThis.__tbApp?.hist && globalThis.__tbApp.store.get().simSeconds > 0.3, null, 30000);
  // The lesson's own firmware loads from the "run" step's button, like a learner would
  for (let i = 0; i < 5 && !(await page.$('#lessonRun')); i++) {
    await page.click('#lessonNext');
    await sleep(300);
  }
  await page.click('#lessonRun');
  const fw = await waitFor(page, () => /音符 mi 330 Hz/.test(globalThis.__tbApp.session.consoleText()), null, 30000);
  report(`run ${run}: lesson 6 firmware plays (serial shows mi 330 Hz)`, fw, await page.evaluate(() => globalThis.__tbApp.session.fwName));
  await page.click('#sound');
  const on = await waitFor(page, () => globalThis.__tbAudio && !globalThis.__tbAudio.muted && globalThis.__tbAudio.playing, null, 8000);
  report(`run ${run}: sound on, buzzer playing`, on, JSON.stringify(await page.evaluate(() => ({ muted: globalThis.__tbAudio?.muted, ctx: globalThis.__tbApp.session.audio.ctx?.state }))));
  const data = await page.evaluate(sampler, HI_FFT, SAMPLE_S);
  fs.writeFileSync(path.join(outDir, `tones-${run}.json`), JSON.stringify(data, null, 1));
  const loBin = data.rate / data.loFft;
  const hiBin = data.rate / data.hiFft;
  const runs = runsOf(data.samples);
  const row = { run, rate: data.rate, loBin, hiBin, notes: {} };
  for (const [name, f] of NOTES) {
    // Product analyser tolerance: the stricter of +-1 bin and +-3 %; the hi-res tap is held to +-1 of its own bins
    const loTol = Math.min(loBin, 0.03 * f);
    const mine = runs.filter((r) => Math.abs(r.f - f) <= hiBin);
    // Product analyser (smoothing 0.8): judge the middle of each heard note, away from the blend at its edges
    const mids = mine.flatMap((r) => {
      const a = r.s[0].t + 0.06;
      const b = r.s[r.s.length - 1].t - 0.03;
      return r.s.filter((s) => s.t >= a && s.t <= b);
    });
    const loOk = mids.filter((s) => Math.abs(s.lBin - f) <= loTol).length;
    const hHz = mine.length ? median(mine.map((r) => r.f)) : NaN;
    const lBin = mids.length ? median(mids.map((s) => s.lBin)) : NaN;
    const lHz = mids.length ? median(mids.map((s) => s.lHz)) : NaN;
    const hDb = mine.length ? median(mine.flatMap((r) => r.s.map((s) => s.hDb))) : NaN;
    const lDb = mids.length ? median(mids.map((s) => s.lDb)) : NaN;
    row.notes[name] = { f, heard: mine.length, hHz: +hHz.toFixed(2), hDb: +hDb.toFixed(1), lBin: +lBin.toFixed(1), lHz: +lHz.toFixed(2), lDb: +lDb.toFixed(1), loOk, loN: mids.length, loTol: +loTol.toFixed(2) };
    report(
      `run ${run}: ${name} ${f} Hz heard on the hi-res tap (+-${hiBin.toFixed(2)} Hz)`,
      mine.length >= 2,
      `${mine.length} notes, median ${hHz.toFixed(2)} Hz @ ${hDb.toFixed(1)} dB`,
    );
    report(
      `run ${run}: ${name} product analyser peak bin within +-${loTol.toFixed(2)} Hz`,
      mids.length >= 3 && loOk / mids.length >= 0.9 && Math.abs(lBin - f) <= loTol,
      `${loOk}/${mids.length} samples, median bin ${lBin.toFixed(1)} Hz (interpolated ${lHz.toFixed(2)}) @ ${lDb.toFixed(1)} dB`,
    );
  }
  // Heard in the firmware's order: every steady note is one of the three and follows do -> re -> mi -> do
  const seq = runs.map((r) => NOTES.findIndex(([, f]) => Math.abs(r.f - f) <= hiBin));
  const ordered = seq.every((k) => k >= 0) && seq.every((k, i) => i === 0 || k === (seq[i - 1] + 1) % 3);
  report(`run ${run}: only do / re / mi heard, in melody order`, seq.length >= 6 && ordered, seq.map((k) => (k >= 0 ? NOTES[k][0] : '?')).join(' '));
  row.seq = seq;
  summary.push(row);
  await ctx.close();
}
report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
fs.writeFileSync(path.join(outDir, 'tones-summary.json'), JSON.stringify(summary, null, 1));
await browser.close();
server.close();
console.log(`[tones] ${fails ? `${fails} FAIL` : 'all PASS'}`);
process.exit(fails ? 1 : 0);
