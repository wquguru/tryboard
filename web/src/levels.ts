// 关卡页：7 关，每关的通过条件来自 firmware/levels.json，判定规则与 tools/check.py 相同。
// 参考固件通过只说明关卡本身能过；只有你上传的固件通过才记进度（存在本机浏览器里）。
import levelsJson from '../../firmware/levels.json';
import { checkCommand, type Level } from './checks';
import { verifyLevel, type VerifyOutcome } from './verify';
import { fetchBuf } from './assets';
import { LiveSim } from './live';
import { createAssembly, CHIP_HEAT_OFFSET } from './views/assembly';
import { createShowcase, type ShowKind } from './views/showcase';

const levels = levelsJson as Level[];
const $ = (id: string) => document.getElementById(id)!;
const KEY = 'tryboard-levels';
type Progress = Record<string, { fp: string; at: string }>;
function loadProgress(): Progress {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Progress;
  } catch {
    return {};
  }
}
function saveProgress(p: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式存不了，进度只在本页有效 */
  }
}
let progress = loadProgress();
let examples: string[] = [];
const uploads: Record<string, { name: string; buf: ArrayBuffer }> = {};
const results: Record<string, { who: string; out: VerifyOutcome }> = {};
let running = false;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const selected = () => levels.find((l) => '#' + l.id === location.hash) ?? levels.find((l) => !progress[l.id]) ?? levels[0];

function renderTabs() {
  const cur = selected();
  const firstTodo = levels.find((l) => !progress[l.id]);
  $('passed').textContent = `已通过 ${levels.filter((l) => progress[l.id]).length} / ${levels.length}`;
  $('tabs').innerHTML = levels
    .map((l) => {
      const done = !!progress[l.id];
      const now = !done && l === firstTodo;
      return `<button type="button" role="tab" class="lv-tab ${done ? 'done' : now ? 'now' : ''}" aria-selected="${l === cur}" data-id="${l.id}">
<span class="top"><span class="num">${l.id}</span><span class="chip">${done ? '已通过' : now ? '下一关' : '未开始'}</span></span>
<span class="t">${l.title}</span><span class="g">${l.goal}</span></button>`;
    })
    .join('');
  $('tabs').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => (location.hash = b.dataset.id!)));
}

function resultHtml(l: Level) {
  const r = results[l.id];
  if (!r) {
    const p = progress[l.id];
    return p ? `<div class="lv-result"><span class="ok">✓ 你已经通过（${esc(p.at)}）</span><span class="dim">运行指纹 <b>${p.fp}</b></span></div>` : '';
  }
  const o = r.out;
  const rows = o.results.map((x) => `<span class="${x.ok ? 'ok' : 'bad'}">${x.ok ? '✓' : '✗'} ${esc(x.text)}</span>`).join('');
  return `<div class="lv-result" aria-live="polite"><span><b>${esc(r.who)}</b>：${o.ok ? '<span class="ok">通过</span>' : '<span class="bad">未通过</span>'} <span class="dim">· 模拟 ${o.sim.toFixed(2)} s</span></span>${rows}<span class="dim">运行指纹 <b>${o.fingerprint}</b> · 同一固件、同样输入，网页和命令行都是这个</span></div>`;
}

function renderDetail() {
  const l = selected();
  const up = uploads[l.id];
  const canRun = !!l.ref;
  const inLab = l.ref && examples.includes(l.ref);
  $('detail').innerHTML = `<div class="col">
<div style="display:flex;flex-direction:column;gap:6px"><span class="mono" style="font-size:13px;font-weight:700;color:var(--accent-ink)">第 ${l.id} 关</span><h2 style="font-size:34px">${l.title}</h2><span style="font-size:17px;color:var(--dim)">${l.goal}</span></div>
<div class="lv-f"><span class="lv-k">通过条件</span><span style="font-size:17px;font-weight:700">${l.pass}</span></div>
<div class="lv-row"><div><span class="lv-k">新增零件</span><span>${l.buy}</span></div><div><span class="lv-k">学到</span><span>${l.learn}</span></div></div>
${canRun ? `<div class="lv-btns">
<label class="btn dark">${up ? '换一个 .bin' : '上传你的 .bin 验收'}<input id="upload" type="file" accept=".bin" /></label>
<button type="button" class="btn" id="runRef">跑参考固件</button>
${inLab ? `<a class="btn" href="./index.html?example=${l.ref}">在实验台打开</a>` : ''}
</div>
<span class="mono" id="runState" style="font-size:13px;color:var(--dim)">${up ? `已选：${esc(up.name)}` : ''}</span>` : ''}
${resultHtml(l)}
</div>
<div class="col wide">
<span class="lv-k">交给 AI 的任务书</span>
<pre class="lv-brief">${esc(l.brief)}</pre>
<div class="lv-btns"><button type="button" class="btn" id="copy">复制任务书</button></div>
${canRun ? `<span class="lv-k">验收命令 · 你和 AI 用同一条</span><pre class="code">${esc(checkCommand(l))}</pre>` : ''}
</div>`;
  $('copy').onclick = async () => {
    const text = l.brief + (canRun ? `\n\n通过条件：${l.pass}\n验收：${checkCommand(l)}` : '');
    try {
      await navigator.clipboard.writeText(text);
      $('copy').textContent = '已复制';
    } catch {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector('.lv-brief')!);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
      $('copy').textContent = '已选中，按 ⌘C / Ctrl+C 复制';
    }
  };
  if (!canRun) return;
  ($('upload') as HTMLInputElement).onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    uploads[l.id] = { name: f.name, buf: await f.arrayBuffer() };
    if (l.assembly) live?.load(uploads[l.id].buf);
    run(l, uploads[l.id].buf, f.name, true);
  };
  $('runRef').onclick = async () => run(l, await fetchBuf(`./fw/${l.ref}/flash.bin`), `参考固件 ${l.ref}`, false);
  ($('runRef') as HTMLButtonElement).disabled = running;
}

async function run(l: Level, flash: ArrayBuffer, who: string, own: boolean) {
  if (running) return;
  running = true;
  renderDetail();
  const st = () => document.getElementById('runState');
  try {
    // 第 6 关：装配也算。传感器贴着芯片，模拟器里的传感器就读到更高的温度
    const bad = l.assembly && asm?.state().bme === 'B';
    const env = l.assembly ? { temp: 23.5 + (bad ? CHIP_HEAT_OFFSET : 0), humidity: 45, pressure: 101325 } : undefined;
    const out = await verifyLevel(l, flash, (t) => { const e = st(); if (e) e.textContent = `模拟中 ${t.toFixed(1)} / ${l.seconds} s…`; }, env);
    if (l.assembly) {
      const s = asm!.state();
      const ok = s.placed.length === 6 && s.bme === 'A';
      out.results.push({ ok, text: s.placed.length < 6 ? `装配 ${s.placed.length}/6，还没装完（在下面拖零件）` : ok ? '装配 6/6，没有警告' : `装配 6/6，但传感器贴着芯片（读数偏高约 ${CHIP_HEAT_OFFSET} ℃）` });
      out.ok = out.results.every((r) => r.ok);
    }
    results[l.id] = { who, out };
    if (own && out.ok) {
      progress[l.id] = { fp: out.fingerprint, at: new Date().toLocaleString('zh-CN', { hour12: false }) };
      saveProgress(progress);
    }
  } catch (e) {
    results[l.id] = { who, out: { ok: false, results: [{ ok: false, text: `运行失败：${e}` }], fingerprint: '—', stdout: '', sim: 0 } };
  }
  running = false;
  renderTabs();
  renderDetail();
}

// 第 6 关的装配区、第 7 关的成品示意
let live: LiveSim | null = null;
let asm: ReturnType<typeof createAssembly> | null = null;
let extraFor = '';
function renderExtra() {
  const l = selected();
  if (extraFor === l.id) return;
  extraFor = l.id;
  live?.pause();
  const box = $('extra');
  box.innerHTML = '';
  if (l.assembly) {
    box.innerHTML = `<div class="stack" style="gap:12px"><div class="sec-head"><h2 style="font-size:28px">装进壳里</h2><span class="mono">拖零件 → 合上 → 开机</span></div><div id="asm"></div><div class="note"><span>↑ 装好再点上面的验收：BME280 贴着芯片，读数会偏高，验收就过不了</span><span>${uploads[l.id] ? '跑的是你上传的固件' : '跑的是参考固件 weather'}</span></div></div>`;
    let productMode = false;
    let offset = 0;
    const apply = () => live!.setOffset(productMode ? offset : 0);
    live ??= new LiveSim({
      fw: uploads[l.id]?.buf ?? `./fw/${l.ref}/flash.bin`,
      i2c: [{ kind: 'ssd1306', addr: 0x3c }, { kind: 'bme280', addr: 0x76 }],
      env: { temp: 23.5, humidity: 45, pressure: 101325 },
      onFrame: (f) => asm?.update(f, live!.env.temp),
    });
    asm = createAssembly(
      $('asm'),
      {
        boot: (d) => live!.press(d),
        temp: (d) => live!.setTemp(live!.env.temp + d),
        offset: (d) => {
          offset = d;
          apply();
          delete results[l.id];
          renderDetail();
        },
        mode: (m) => {
          productMode = m === 'product';
          apply();
          if (productMode) live!.resume();
        },
        step: () => {
          if (results[l.id]) {
            delete results[l.id];
            renderDetail();
          }
        },
      },
      { servoPin: 4 },
    );
    live.start();
  } else if (!l.ref) {
    box.innerHTML = `<div class="grid3">${(['spin', 'lens', 'weather'] as ShowKind[]).map((k) => `<div class="stack" style="gap:10px"><div data-show="${k}"></div><span style="font-weight:900;font-size:18px">${{ spin: '会转身的小黄', lens: '透镜里的小人', weather: '温湿度检测器' }[k]}</span><span style="font-size:14px;color:var(--dim)">${{ spin: '第 5 关的舵机 + 一块小屏', lens: '换成 1.28″ 圆屏 GC9A01（模拟器暂不支持）', weather: '第 6 关装好的就是它' }[k]}</span></div>`).join('')}</div>`;
    box.querySelectorAll<HTMLElement>('[data-show]').forEach((el) => createShowcase(el, el.dataset.show as ShowKind));
  }
}

function render() {
  renderTabs();
  renderDetail();
  renderExtra();
}
window.addEventListener('hashchange', render);
fetch('./fw/examples.json')
  .then((r) => r.json())
  .then((ex: { id: string }[]) => {
    examples = ex.map((e) => e.id);
    renderDetail();
  })
  .catch(() => {});
render();
