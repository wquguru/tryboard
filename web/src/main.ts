import { createBench, type ChipId, type SceneSpec } from "./board3d";
import { mountEditor, needsReboot } from "./editor";
import type { Env, FromWorker, ToWorker } from './worker';
import { createUsbPanel } from './usbpanel';
import type { UsbView } from './usb3d';
import { fetchBuf, imageChip, ROM_FILE } from './assets';
import { createAssembly } from './views/assembly';
import { emptyFrame } from './views/common';

interface Example {
  id: string;
  title: string;
  about: string;
  tags: string[];
  scene?: SceneSpec;
  /** 缺省 esp32c3 */
  chip?: ChipId;
  /** 'env'：显示环境滑块（温度 / 湿度 / 气压）；对象：模拟输入滑块 */
  controls?: (string | AnalogControl)[];
  /** 有装配视图（零件装进外壳、开机看成品） */
  assembly?: boolean;
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
let flash: ArrayBuffer | null = null;
/** 各芯片的 ROM（按需下载，esp-rom-elfs，Apache-2.0） */
const roms: Partial<Record<ChipId, ArrayBuffer>> = {};
const CHIP_LABEL: Record<ChipId, string> = { esp32c3: 'ESP32-C3 · 160MHz', esp32s3: 'ESP32-S3 · 双核 160MHz' };
/** 板载 BOOT 键所在引脚（启动后由模拟器告知） */
let bootPin = 9;

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
/** 装配视图里传感器贴着芯片时，传感器看到的温度比室温高；只在"装进壳里开机"后生效 */
let sensorOffset = 0;
const sensedEnv = (): Env => ({ ...env, temp: env.temp + sensorOffset });
const sendEnv = () => send({ type: 'env', ...sensedEnv() });

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

async function boot(autorun: boolean) {
  if (!wasm || !flash) return;
  const chip = imageChip(flash);
  bench.setBoard(chip);
  $('chip').textContent = CHIP_LABEL[chip];
  const rom = (roms[chip] ??= await fetchBuf(`./rom/${ROM_FILE[chip]}`));
  consoleEl.textContent = '';
  log(`[试板] 上电（${chip === 'esp32s3' ? 'ESP32-S3' : 'ESP32-C3'}），加载固件…\n`, 'sys');
  editor.setChip(chip);
  bench.setPowered(true);
  bench.setRgb([0, 0, 0]);
  bench.setUsb(null);
  usbPanel.reset();
  pendingAutorun = autorun;
  send({ type: 'boot', wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), i2c: i2cDevices(), env: sensedEnv() });
}

const usbPanel = createUsbPanel(document.querySelector('.panel.info')!, (text) => send({ type: 'usbcdc', text }));
let pendingAutorun = false;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'booted':
      bootPin = m.bootPin;
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
      bench.setGpio(m.gpio, m.enable, m.pwm, m.gpioHi, m.enableHi);
      if (m.leds) bench.setRgb(m.leds[0] ?? [0, 0, 0]);
      frame.pwm = m.pwm;
      frame.running = m.running;
      if (m.leds) frame.rgb = m.leds[0] ?? null;
      asm?.update(frame, env.temp);
      $('simtime').textContent = `${m.simSeconds.toFixed(3)} s`;
      if (m.running) {
        const r = $('ratio');
        r.textContent = `${m.ratio.toFixed(2)}× 实时`;
        r.classList.toggle('slow', m.ratio < 0.9);
      }
      break;
    case 'oled':
      bench.setOled(m.pixels);
      frame.oled = m.pixels;
      asm?.update(frame, env.temp);
      break;
    case 'usb': {
      const v: UsbView | null = m.json ? JSON.parse(m.json) : null;
      usbPanel.update(v);
      bench.setUsb(v);
      break;
    }
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
  $('about').innerHTML = `<p>自定义固件：${f.name}（${(f.size / 1024).toFixed(0)} KB）</p><p class="muted">支持 ESP-IDF / Arduino 构建出的完整 flash 镜像（含分区表），或单独的 app .bin。在下面「面包板元件」里按你的实物接线加元件。</p>`;
  customFirmware = true;
  exampleControls = [];
  let opt = exampleSel.querySelector('option[value="__custom"]') as HTMLOptionElement | null;
  if (!opt) exampleSel.add((opt = new Option('', '__custom')));
  opt.text = `自定义：${f.name}`;
  exampleSel.value = '__custom';
  try {
    scene = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '') as SceneSpec;
  } catch {
    scene = { parts: [] };
  }
  bench.setScene(scene);
  syncControls();
  editor.render();
  ($('editorBox') as HTMLDetailsElement).open = true;
  boot(true);
};
bench.onButton((name, down) => {
  if (name === 'BOOT') send({ type: 'gpio', pin: bootPin, level: down ? 0 : -1 });
  if (name === 'RST' && !down) boot(true);
});

async function loadExample(id: string, autorun: boolean) {
  customFirmware = false;
  const ex = examples.find((e) => e.id === id)!;
  const chip = ex.chip ?? 'esp32c3';
  const badge = `<span class="tag chip">${chip === 'esp32s3' ? 'ESP32-S3' : 'ESP32-C3'}</span>`;
  $('about').innerHTML = `<p><b>${ex.title}</b></p><p>${ex.about}</p><p>${badge}${ex.tags.map((t) => `<span class="tag ${t.startsWith('✓') ? 'ok' : ''}">${t}</span>`).join('')}</p>`;
  scene = ex.scene ?? { parts: [] };
  bench.setBoard(chip);
  bench.setScene(scene);
  exampleControls = ex.controls ?? [];
  syncControls();
  editor.render();
  flash = await fetchBuf(`./fw/${id}/flash.bin`);
  setupAssembly(!!ex.assembly);
  boot(autorun);
}

// ---------------------------------------------------------------- 装配视图（叠在 3D 舞台上）
const frame = emptyFrame();
let asm: ReturnType<typeof createAssembly> | null = null;
let asmOffset = 0;
let asmProduct = false;
const viewTabs = $('viewTabs');
const asmBox = $('asmBox');
function setView(v: '3d' | 'asm') {
  viewTabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === v)));
  asmBox.hidden = v !== 'asm';
  $('hint').hidden = v === 'asm';
}
viewTabs.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => setView(b.dataset.v as '3d' | 'asm')));
function setupAssembly(on: boolean) {
  viewTabs.hidden = !on;
  sensorOffset = 0;
  asmOffset = 0;
  asmProduct = false;
  asm = null;
  asmBox.innerHTML = '';
  setView('3d');
  if (!on) return;
  const apply = () => {
    sensorOffset = asmProduct ? asmOffset : 0;
    sendEnv();
  };
  asm = createAssembly(
    asmBox,
    {
      boot: (d) => send({ type: 'gpio', pin: bootPin, level: d ? 0 : -1 }),
      temp: (d) => {
        env.temp = Math.max(-20, Math.min(50, env.temp + d));
        const r = document.querySelector<HTMLInputElement>('.env input');
        if (r) {
          r.value = String(env.temp);
          r.dispatchEvent(new Event('input'));
        } else sendEnv();
      },
      offset: (d) => {
        asmOffset = d;
        apply();
      },
      mode: (m) => {
        asmProduct = m === 'product';
        apply();
      },
      step: (t) => log(`[试板] 装配：${t}\n`, 'sys'),
    },
    { servoPin: 4 },
  );
  asm.update(frame, env.temp);
}

let exampleControls: (string | AnalogControl)[] = [];

/** 面板上的滑块由场景决定：有 BME280 就给环境滑块，每个电位器一个旋钮滑块（示例可给初值） */
function syncControls() {
  $('controls').innerHTML = '';
  analog.clear();
  if (scene.parts.some((p) => p.type === 'bme280')) envControls();
  for (const p of scene.parts) {
    if (p.type !== 'pot') continue;
    const preset = exampleControls.find((c): c is AnalogControl => typeof c === 'object' && c.type === 'analog' && c.pin === p.pin);
    analogControl(preset ?? { type: 'analog', pin: p.pin, label: `电位器（GPIO${p.pin}）`, max_mv: 3300, value: 1650 });
  }
}

const CUSTOM_KEY = 'tryboard-custom-scene';
const editor = mountEditor(
  $('editor'),
  () => scene,
  (next) => {
    const reboot = needsReboot(scene, next);
    scene = next;
    bench.setScene(scene);
    syncControls();
    if (customFirmware) {
      try {
        localStorage.setItem(CUSTOM_KEY, JSON.stringify(scene));
      } catch {
        /* 隐私模式下存不了，不影响使用 */
      }
    }
    if (reboot) {
      log('\n[试板] I2C 器件变了，重新上电\n', 'sys');
      boot(true);
    }
  },
);
let customFirmware = false;

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
      sendEnv();
    };
    box.appendChild(row);
  }
  $('controls').appendChild(box);
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
  $('controls').appendChild(box);
}

exampleSel.onchange = () => {
  if (exampleSel.value !== '__custom') loadExample(exampleSel.value, true);
};

(async () => {
  try {
    wasm = await fetchBuf('./wasm/tryboard.wasm');
    examples = await (await fetch('./fw/examples.json')).json();
    for (const e of examples) exampleSel.add(new Option(`${e.chip === 'esp32s3' ? '[S3] ' : ''}${e.title}`, e.id));
    const want = new URLSearchParams(location.search).get('example');
    const first = examples.find((e) => e.id === want) ?? examples[0];
    exampleSel.value = first.id;
    await loadExample(first.id, new URLSearchParams(location.search).get('autorun') !== '0');
  } catch (err) {
    log(`[试板] 资源加载失败：${err}\n`, 'err');
  }
})();
