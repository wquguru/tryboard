import { createBench, type SceneSpec } from './board3d';
import type { Env, FromWorker, ToWorker } from './worker';

interface Example {
  id: string;
  title: string;
  about: string;
  tags: string[];
  scene?: SceneSpec;
  /** 'env'：显示环境滑块（温度 / 湿度 / 气压）；对象：模拟输入滑块 */
  controls?: (string | AnalogControl)[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const consoleEl = $<HTMLPreElement>('console');
const runBtn = $<HTMLButtonElement>('run');
const resetBtn = $<HTMLButtonElement>('reset');
const exampleSel = $<HTMLSelectElement>('example');

const bench = createBench($('stage'));
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

let wasm: ArrayBuffer | null = null;
let rom: ArrayBuffer | null = null;
let flash: ArrayBuffer | null = null;
let running = false;
let examples: Example[] = [];
let scene: SceneSpec = { parts: [] };
interface AnalogControl {
  type: 'analog';
  pin: number;
  label: string;
  max_mv: number;
  value: number;
}
/** 各引脚上的模拟电压（mV）：复位后要重新下发 */
const analog = new Map<number, { mv: number; max: number }>();
const env: Env = { temp: 23.5, humidity: 45, pressure: 101325 };

/** 场景里的 I2C 器件 → 模拟总线上要挂的器件 */
function i2cDevices() {
  const kind: Record<string, string> = { oled: 'ssd1306', bme280: 'bme280' };
  return scene.parts.flatMap((p) => ('addr' in p && kind[p.type] ? [{ kind: kind[p.type], addr: p.addr }] : []));
}

function log(text: string, cls?: string) {
  const atBottom = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 8;
  if (cls) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    consoleEl.appendChild(s);
  } else {
    consoleEl.appendChild(document.createTextNode(text));
  }
  // 控制台只留最近约 200KB
  if (consoleEl.textContent!.length > 200_000) consoleEl.textContent = consoleEl.textContent!.slice(-150_000);
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function setRunning(r: boolean) {
  running = r;
  runBtn.textContent = r ? '❚❚ 暂停' : '▶ 运行';
}

async function fetchBuf(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

function boot(autorun: boolean) {
  if (!wasm || !rom || !flash) return;
  consoleEl.textContent = '';
  log('[试板] 上电，加载固件…\n', 'sys');
  bench.setPowered(true);
  bench.setRgb([0, 0, 0]);
  pendingAutorun = autorun;
  send({ type: 'boot', wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), i2c: i2cDevices(), env: { ...env } });
}
let pendingAutorun = false;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'booted':
      for (const [pin, a] of analog) send({ type: 'analog', pin, mv: a.mv });
      runBtn.disabled = resetBtn.disabled = false;
      if (pendingAutorun) {
        send({ type: 'run' });
        setRunning(true);
      }
      break;
    case 'error':
      log(`[试板] 启动失败：${m.message}\n`, 'err');
      bench.setPowered(false);
      break;
    case 'tick':
      if (m.console) log(m.console);
      bench.setGpio(m.gpio, m.enable, m.pwm);
      if (m.leds) bench.setRgb(m.leds[0] ?? [0, 0, 0]);
      $('simtime').textContent = `${m.simSeconds.toFixed(3)} s`;
      if (m.running) {
        const r = $('ratio');
        r.textContent = `${m.ratio.toFixed(2)}× 实时`;
        r.classList.toggle('slow', m.ratio < 0.9);
      }
      break;
    case 'oled':
      bench.setOled(m.pixels);
      break;
    case 'stopped':
      setRunning(false);
      log(`\n[试板] 停止：${m.reason}\n`, 'err');
      break;
  }
};

runBtn.onclick = () => {
  if (running) {
    send({ type: 'pause' });
    setRunning(false);
  } else {
    send({ type: 'run' });
    setRunning(true);
  }
};
resetBtn.onclick = () => boot(true);
$<HTMLSelectElement>('speed').onchange = (e) => send({ type: 'speed', factor: Number((e.target as HTMLSelectElement).value) });
$('clear').onclick = () => (consoleEl.textContent = '');
$<HTMLFormElement>('uartForm').onsubmit = (e) => {
  e.preventDefault();
  const inp = $<HTMLInputElement>('uartIn');
  send({ type: 'uart', text: inp.value + '\n' });
  inp.value = '';
};
$<HTMLInputElement>('upload').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  flash = await f.arrayBuffer();
  $('about').innerHTML = `<p>自定义固件：${f.name}（${(f.size / 1024).toFixed(0)} KB）</p><p class="muted">支持 ESP-IDF / Arduino 构建出的完整 flash 镜像（含分区表），或单独的 app .bin。</p>`;
  boot(true);
};
bench.onButton((name, down) => {
  if (name === 'BOOT') send({ type: 'gpio', pin: 9, level: down ? 0 : -1 });
  if (name === 'RST' && !down) boot(true);
});

async function loadExample(id: string, autorun: boolean) {
  const ex = examples.find((e) => e.id === id)!;
  $('about').innerHTML = `<p><b>${ex.title}</b></p><p>${ex.about}</p><p>${ex.tags.map((t) => `<span class="tag ${t.startsWith('✓') ? 'ok' : ''}">${t}</span>`).join('')}</p>`;
  scene = ex.scene ?? { parts: [] };
  bench.setScene(scene);
  analog.clear();
  if (ex.controls?.includes('env')) envControls();
  for (const c of ex.controls ?? []) if (typeof c === 'object' && c.type === 'analog') analogControl(c);
  flash = await fetchBuf(`./fw/${id}/flash.bin`);
  boot(autorun);
}

/** 环境滑块：改的是虚拟世界，传感器读到的随之变化 */
function envControls() {
  const box = document.createElement('div');
  box.className = 'env';
  const rows: [keyof Env, string, number, number, number, (v: number) => string][] = [
    ['temp', '温度', -20, 50, 0.5, (v) => `${v.toFixed(1)} °C`],
    ['humidity', '湿度', 0, 100, 1, (v) => `${v.toFixed(0)} %`],
    ['pressure', '气压', 90000, 110000, 50, (v) => `${(v / 100).toFixed(1)} hPa`],
  ];
  for (const [k, name, min, max, step, fmt] of rows) {
    const row = document.createElement('label');
    row.innerHTML = `<span>${name}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${env[k]}" /><output>${fmt(env[k])}</output>`;
    const input = row.querySelector('input')!;
    input.oninput = () => {
      env[k] = Number(input.value);
      row.querySelector('output')!.textContent = fmt(env[k]);
      send({ type: 'env', ...env });
    };
    box.appendChild(row);
  }
  $('about').appendChild(box);
}

/** 模拟输入滑块（电位器等）：与 3D 旋钮双向同步 */
function analogControl(c: AnalogControl) {
  analog.set(c.pin, { mv: c.value, max: c.max_mv });
  const box = document.createElement('div');
  box.className = 'env';
  const row = document.createElement('label');
  row.innerHTML = `<span>旋钮</span><input type="range" min="0" max="${c.max_mv}" step="10" value="${c.value}" /><output>${c.value} mV</output>`;
  const input = row.querySelector('input')!;
  const out = row.querySelector('output')!;
  const apply = (mv: number, from3d: boolean) => {
    analog.set(c.pin, { mv, max: c.max_mv });
    out.textContent = `${mv.toFixed(0)} mV`;
    if (from3d) input.value = String(mv);
    else bench.setPot(c.pin, mv / c.max_mv);
    send({ type: 'analog', pin: c.pin, mv });
  };
  input.oninput = () => apply(Number(input.value), false);
  bench.onPot((pin, v) => {
    if (pin === c.pin) apply(v * c.max_mv, true);
  });
  bench.setPot(c.pin, c.value / c.max_mv);
  const hint = document.createElement('div');
  hint.className = 'muted';
  hint.textContent = c.label + '：拖滑块或直接拖 3D 里的旋钮';
  box.append(hint, row);
  $('about').appendChild(box);
}

exampleSel.onchange = () => loadExample(exampleSel.value, true);

(async () => {
  try {
    [wasm, rom] = await Promise.all([fetchBuf('./wasm/tryboard.wasm'), fetchBuf('./rom/esp32c3_rev3_rom.elf')]);
    examples = await (await fetch('./fw/examples.json')).json();
    for (const e of examples) exampleSel.add(new Option(e.title, e.id));
    const want = new URLSearchParams(location.search).get('example');
    const first = examples.find((e) => e.id === want) ?? examples[0];
    exampleSel.value = first.id;
    await loadExample(first.id, new URLSearchParams(location.search).get('autorun') !== '0');
  } catch (err) {
    log(`[试板] 资源加载失败：${err}\n`, 'err');
  }
})();
