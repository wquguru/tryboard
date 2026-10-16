import { createBench, type ChipId, type SceneSpec } from "./board3d";
import { mountEditor, needsReboot } from "./editor";
import type { Env, FromWorker, ToWorker } from './worker';
import { createUsbPanel } from './usbpanel';
import type { UsbView } from './usb3d';
import { fetchBuf, imageChip, ROM_FILE } from './assets';
import { createAssembly } from './views/assembly';
import { emptyFrame } from './views/common';
import { BuzzerAudio } from './audio';
import { MicInput } from './micinput';
import { toScript, type InputLog } from './inputlog';
import { PoseRate, type Pose } from './imupose';

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
  /** 有装配视图（零件装进外壳、开机看成品）：模板名（weather / spin / lens），true 等同 weather */
  assembly?: boolean | string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const consoleEl = $<HTMLPreElement>('console');
const runBtn = $<HTMLButtonElement>('run');
const resetBtn = $<HTMLButtonElement>('reset');
const exampleSel = $<HTMLSelectElement>('example');

const bench = createBench($('stage'));
// 蜂鸣器声音（默认静音）：按钮放在工具栏里，点一下就是浏览器要的用户手势
const audio = new BuzzerAudio();
$('run').parentElement!.insertBefore(audio.button(), $('upload').parentElement);
/** 场景里接了蜂鸣器的引脚 → 让 worker 每个时间片采样这些脚的 PWM */
function syncBuzzers() {
  const pins = scene.parts.flatMap((p) => (p.type === 'buzzer' ? [p.pin] : []));
  audio.setPins(pins);
  audio.setSpeaker(scene.parts.some((p) => p.type === 'max98357a'));
  send({ type: 'watchPwm', pins });
}

// ---------------------------------------------------------------- I2S 音频（P2-06）
/** 场景里的 I2S 器件 → 上电时挂上的器件（引脚按芯片固定，见 board3d 的 I2S_WIRING） */
const i2sDevices = () => scene.parts.flatMap((p) => (p.type === 'max98357a' || p.type === 'inmp441' ? [p.type] : []));
/** 麦克风声源：测试 WAV（tools/audio/ 生成，随网站发布在 audio/ 下）/ 安静 / 浏览器麦克风 */
const MIC_SOURCES: [string, string][] = [
  ['sine1k.wav', '1 kHz 正弦（测试 WAV）'],
  ['sweep.wav', '扫频 200→2000 Hz（测试 WAV）'],
  ['silence', '安静'],
  ['live', '浏览器麦克风（要授权，只玩不进验收）'],
];
let micSource = 'sine1k.wav';
const wavCache = new Map<string, ArrayBuffer>();
const micWav = async (name: string) => {
  if (!wavCache.has(name)) wavCache.set(name, await fetchBuf(`./audio/${name}`));
  return wavCache.get(name)!;
};
const mic = new MicInput();
let micStatus: HTMLElement | null = null;
async function setMicSource(src: string) {
  micSource = src;
  mic.stop();
  if (src === 'live') {
    const err = await mic.start((rate, data) => send({ type: 'micPush', rate, data }, [data.buffer]));
    if (err) {
      // 没有权限 / 设备：换回测试声音
      const sel = document.querySelector<HTMLSelectElement>('#micSource');
      if (sel) sel.value = 'sine1k.wav';
      await setMicSource('sine1k.wav');
      if (micStatus) micStatus.textContent = `${err}，已换回 1 kHz 测试声音`;
      return;
    }
    send({ type: 'mic', source: 'live' });
  } else if (src === 'silence') send({ type: 'mic', source: 'silence' });
  else send({ type: 'mic', source: 'wav', wav: await micWav(src) });
  if (micStatus) micStatus.textContent = '';
}
/** 喇叭 / 麦克风面板：声源选择 + 读数（模拟器侧：喇叭收到的 PCM；网页侧：Web Audio 输出端） */
function audioControls() {
  const hasSpk = scene.parts.some((p) => p.type === 'max98357a');
  const hasMic = scene.parts.some((p) => p.type === 'inmp441');
  if (!hasSpk && !hasMic) return;
  const box = document.createElement('div');
  box.className = 'env audio';
  if (hasMic) {
    const row = document.createElement('label');
    row.innerHTML = `<span>麦克风声源</span><select id="micSource">${MIC_SOURCES.map(([v, t]) => `<option value="${v}" ${v === micSource ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    row.querySelector('select')!.onchange = (e) => void setMicSource((e.target as HTMLSelectElement).value);
    box.appendChild(row);
    micStatus = document.createElement('div');
    micStatus.className = 'muted';
    micStatus.id = 'micStatus';
    box.appendChild(micStatus);
  }
  const out = document.createElement('div');
  out.className = 'muted';
  out.id = 'audioReadout';
  out.style.whiteSpace = 'pre-line';
  out.textContent = hasSpk ? '喇叭：等固件放音…（声音默认关，点工具栏「声音」）' : '麦克风：等固件开始录音…';
  box.appendChild(out);
  $('controls').appendChild(box);
}
function updateAudioReadout(f: import('./worker').AudioFrame | undefined) {
  const el = document.getElementById('audioReadout');
  if (!el || !f) return;
  const parts: string[] = [];
  if (scene.parts.some((p) => p.type === 'max98357a') && f.frames > 0) {
    parts.push(`喇叭（模拟）：${f.rate.toFixed(0)} Hz 采样 · 主频 ${f.freq.toFixed(1)} Hz · RMS ${f.rms.toFixed(3)}`);
    const pc = audio.state.pcm;
    if (pc && !audio.state.muted) parts.push(`网页输出：主频 ${pc.hz.toFixed(1)} Hz · RMS ${pc.rms.toFixed(3)}`);
  }
  if (scene.parts.some((p) => p.type === 'inmp441')) {
    const src = MIC_SOURCES.find((s) => s[0] === micSource)?.[1] ?? micSource;
    parts.push(`麦克风：${src} · 已送出 ${f.micFrames} 帧${mic.state.on ? ` · 输入电平 ${mic.state.level.toFixed(3)}` : ''}`);
  }
  if (parts.length) el.textContent = parts.join('\n');
}
// 验收脚本要直接调 ScenePickApi；只在 ?debug=1 时暴露，正式页面不挂全局
if (new URLSearchParams(location.search).get('debug') === '1') {
  (window as unknown as { __bench: typeof bench }).__bench = bench;
}
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
  const kind: Record<string, string> = { oled: 'ssd1306', bme280: 'bme280', mpu6050: 'mpu6050', qmi8658: 'qmi8658', cst816s: 'cst816s' };
  return scene.parts.flatMap((p) => ('addr' in p && kind[p.type] ? [{ kind: kind[p.type], addr: p.addr }] : []));
}

// ---------------------------------------------------------------- 姿态（P2-03）与触摸（P2-02）
let pose: Pose = { pitch: 0, roll: 0, yaw: 0 };
const poseRate = new PoseRate();
let poseIdle = 0;
const hasImu = () => scene.parts.some((p) => p.type === 'mpu6050' || p.type === 'qmi8658');
/** 改姿态：带拖动速率施加，停下 150 ms 补一次速率 0；台面跟着倾斜 */
function setPose(p: Pose, from3d = false) {
  pose = { pitch: p.pitch, roll: p.roll, yaw: p.yaw };
  const rates = poseRate.push(pose, performance.now());
  send({ type: 'input', act: { kind: 'imu', ...pose, rates } });
  if (!from3d) bench.setPose(pose);
  document.querySelectorAll<HTMLInputElement>('input[data-pose]').forEach((inp) => {
    if (inp === document.activeElement) return;
    const k = inp.dataset.pose as keyof Pose;
    inp.value = String(Math.round(pose[k]));
    inp.parentElement!.querySelector('output')!.textContent = `${Math.round(pose[k])}°`;
  });
  clearTimeout(poseIdle);
  if (rates.some((v) => v !== 0))
    poseIdle = window.setTimeout(() => {
      poseRate.reset();
      send({ type: 'input', act: { kind: 'imu', ...pose, rates: [0, 0, 0] } });
    }, 150);
}
bench.onPose((p) => setPose(p, true));
bench.onTouch((x, y, down) => send({ type: 'input', act: { kind: 'touch', x, y, down } }));
const touchInt = () => scene.parts.flatMap((p) => (p.type === 'cst816s' ? [p.int] : []))[0];

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
  audio.reset();
  // 舵机接进供电网络（只有 USB：app.html 的实验台才有 USB ↔ 外接 5 V 切换）
  const servo = scene.parts.find((p) => p.type === 'servo');
  // 编码器 / 超声波（P2-01 / P2-04）：上电时接上；超声波初始距离取场景里的
  const enc = scene.parts.find((p) => p.type === 'encoder');
  const son = scene.parts.find((p) => p.type === 'hcsr04');
  if (son && son.type === 'hcsr04') distance = son.cm ?? 25;
  const i2s = i2sDevices();
  const wavName = i2s.includes('inmp441') && micSource.endsWith('.wav') ? micSource : undefined;
  const wav = wavName ? await micWav(wavName) : undefined;
  send({ type: 'boot', wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), i2c: i2cDevices(), env: sensedEnv(), lcd: scene.parts.some((p) => p.type === 'gc9a01'), servo: servo && 'pin' in servo ? servo.pin : undefined, power: 'usb', encoder: enc && enc.type === 'encoder' ? { a: enc.a, b: enc.b, sw: enc.sw } : undefined, sonar: son && son.type === 'hcsr04' ? { trig: son.trig, echo: son.echo, cm: distance } : undefined, touchInt: touchInt(), i2s, micWav: wav?.slice(0), micName: wavName });
}

// 3D 里拖 / 滚编码器、拖障碍物
let distance = 25;
let lastPings = 0;
bench.onEncoder((steps) => send({ type: 'enc', steps }));
bench.onEncoderPress((down) => send({ type: 'encsw', down }));
bench.onDistance((cm) => {
  distance = cm;
  send({ type: 'dist', cm });
});

const usbPanel = createUsbPanel(document.querySelector('.panel.info')!, (text) => send({ type: 'usbcdc', text }));
let pendingAutorun = false;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'booted':
      bootPin = m.bootPin;
      syncBuzzers();
      // 浏览器麦克风的声源不跨上电：上电后重新接上
      if (micSource === 'live' && scene.parts.some((p) => p.type === 'inmp441')) void setMicSource('live');
      for (const [pin, a] of analog) send({ type: 'analog', pin, mv: a.mv });
      // 姿态不是上电参数：作为第一个输入施加（板子还歪着）
      if (hasImu() && (pose.pitch || pose.roll || pose.yaw)) send({ type: 'input', act: { kind: 'imu', ...pose } });
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
      if (m.strips) {
        frame.strips = { ...frame.strips, ...m.strips };
        for (const [pin, leds] of Object.entries(m.strips)) bench.setStrip(Number(pin), leds);
      }
      asm?.update(frame, env.temp);
      audio.push(m.pwmEvents, m.simSeconds);
      if (m.pins?.encPos != null) bench.setEncoder(m.pins.encPos);
      if (m.pins?.pings != null && m.pins.pings !== lastPings) {
        lastPings = m.pins.pings;
        bench.pingSonar();
      }
      if (m.audio) {
        audio.setSim(m.audio);
        const micLv = mic.state.on ? mic.state.level : micSource.endsWith('.wav') && m.audio.micFrames > 0 ? 0.35 : 0;
        bench.setAudio(m.audio.frames > 0 ? m.audio.rms : 0, micLv);
        updateAudioReadout(m.audio);
      }
      $('simtime').textContent = `${m.simSeconds.toFixed(3)} s`;
      if (m.running) {
        const r = $('ratio');
        r.textContent = `${m.ratio.toFixed(2)}× 实时`;
        r.classList.toggle('slow', m.ratio < 0.9);
      }
      break;
    case 'pcm':
      audio.pushPcm(m.blocks);
      break;
    case 'oled':
      bench.setOled(m.pixels);
      frame.oled = m.pixels;
      asm?.update(frame, env.temp);
      break;
    case 'lcd':
      bench.setLcd(m.pixels);
      frame.lcd = m.pixels;
      asm?.update(frame, env.temp);
      break;
    case 'usb': {
      const v: UsbView | null = m.json ? JSON.parse(m.json) : null;
      usbPanel.update(v);
      bench.setUsb(v);
      break;
    }
    case 'inputlog':
      for (const r of logWaiters.splice(0)) r({ ...m.log, firmware: currentFirmware });
      break;
    case 'stopped':
      setRunning(false);
      log(`\n[试板] 停止：${m.reason}\n`, 'err');
      break;
  }
};

// ---------------------------------------------------------------- 输入日志（P0-19）
// worker 按模拟时间记下本次上电以来的每次输入；导出成 `tryboard run --inputs` 能吃的脚本，命令行逐周期重放
const logWaiters: ((l: InputLog) => void)[] = [];
let currentFirmware = '';
function inputLog(): Promise<InputLog> {
  return new Promise((r) => {
    logWaiters.push(r);
    send({ type: 'getInputLog' });
  });
}
const exportBtn = document.createElement('button');
exportBtn.type = 'button';
exportBtn.textContent = '导出输入';
exportBtn.title = '下载本次上电以来的输入日志（模拟时间），用 tryboard run <固件> --inputs <文件> 重放';
exportBtn.onclick = async () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toScript(await inputLog())], { type: 'text/plain' }));
  a.download = `${currentFirmware || 'tryboard'}-inputs.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('run').parentElement!.insertBefore(exportBtn, $('upload').parentElement);
// 给自动化测试（tools/webtest/replay.mjs）：取日志；在网页的验收 worker 里按同一份日志重放
Object.assign(globalThis, {
  __tbInputLog: inputLog,
  __tbButtonPos: (name: 'BOOT' | 'RST') => bench.buttonScreenPos(name),
  __tbReplay: async (log: InputLog, seconds: number, pwmPin?: number) => {
    const { replayLog } = await import('./verify');
    return replayLog(flash!, log, seconds, pwmPin);
  },
});

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
  currentFirmware = f.name.replace(/\.bin$/, '');
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
  currentFirmware = id;
  setupAssembly(ex.assembly ? (typeof ex.assembly === 'string' ? ex.assembly : 'weather') : null);
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
function setupAssembly(template: string | null) {
  const on = !!template;
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
    { servoPin: 4, template: template! },
  );
  asm.update(frame, env.temp);
}

let exampleControls: (string | AnalogControl)[] = [];

/** 面板上的滑块由场景决定：有 BME280 就给环境滑块，每个电位器一个旋钮滑块（示例可给初值） */
function syncControls() {
  $('controls').innerHTML = '';
  analog.clear();
  if (scene.parts.some((p) => p.type === 'bme280')) envControls();
  if (hasImu()) imuControls();
  else {
    pose = { pitch: 0, roll: 0, yaw: 0 };
    bench.setPose(null);
  }
  for (const p of scene.parts) {
    if (p.type !== 'pot') continue;
    const preset = exampleControls.find((c): c is AnalogControl => typeof c === 'object' && c.type === 'analog' && c.pin === p.pin);
    analogControl(preset ?? { type: 'analog', pin: p.pin, label: `电位器（GPIO${p.pin}）`, max_mv: 3300, value: 1650 });
  }
  audioControls();
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
    syncBuzzers();
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

/** 倾斜滑块：改的是台面姿态（整块面包板倾斜），IMU 读到的重力分量随之变化；也可以在 3D 里拖模块 */
function imuControls() {
  const box = document.createElement('div');
  box.className = 'env';
  const hint = document.createElement('div');
  hint.className = 'muted';
  hint.textContent = '倾斜台面：拖滑块，或在 3D 里按住 IMU 模块拖动';
  box.appendChild(hint);
  for (const [k, name, lim] of [['pitch', '俯仰', 90], ['roll', '横滚', 180], ['yaw', '航向', 180]] as [keyof Pose, string, number][]) {
    const row = document.createElement('label');
    row.innerHTML = `<span>${name}</span><input type="range" min="${-lim}" max="${lim}" step="1" value="${Math.round(pose[k])}" data-pose="${k}" /><output>${Math.round(pose[k])}°</output>`;
    const input = row.querySelector('input')!;
    input.oninput = () => {
      row.querySelector('output')!.textContent = `${input.value}°`;
      setPose({ ...pose, [k]: Number(input.value) });
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
