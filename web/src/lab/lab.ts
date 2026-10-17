// 空白实验台的命令式控制器：3D 台面、worker、wasm、音频、装配视图都在这里；界面状态写进 store，由 React（App.tsx）画。
// 高频的东西（串口流、模拟时间、实时比、滑块被 3D 拖动、音频读数）直接写 DOM，不经 React。
import { createBench, type ChipId, type SceneSpec } from '../board3d';
import { needsReboot } from '../editor';
import type { AudioFrame, Env, FromWorker, ToWorker } from '../worker';
import type { UsbView } from '../usb3d';
import { fetchBuf, imageChip, ROM_FILE } from '../assets';
import { createAssembly } from '../views/assembly';
import { emptyFrame } from '../views/common';
import { BuzzerAudio } from '../audio';
import { MicInput } from '../micinput';
import { toScript, type InputLog } from '../inputlog';
import { currentTheme, onTheme } from '../theme';
import { PoseRate, type Pose } from '../imupose';
import { createStore, createUsbFeed, initialLab, type AnalogControl, type Control, type LabState } from './store';

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

/** React 交给控制器的 DOM 容器（命令式模块往里挂东西 / 直接写字） */
export interface LabDom {
  stage: HTMLElement;
  console: HTMLPreElement;
  simtime: HTMLElement;
  ratio: HTMLElement;
  asmBox: HTMLElement;
  controls: HTMLElement;
}

export const CHIP_LABEL: Record<ChipId, string> = { esp32c3: 'ESP32-C3 · 160MHz', esp32s3: 'ESP32-S3 · 双核 160MHz' };
/** 麦克风声源：测试 WAV（tools/audio/ 生成，随网站发布在 audio/ 下）/ 安静 / 浏览器麦克风 */
export const MIC_SOURCES: [string, string][] = [
  ['sine1k.wav', '1 kHz 正弦（测试 WAV）'],
  ['sweep.wav', '扫频 200→2000 Hz（测试 WAV）'],
  ['silence', '安静'],
  ['live', '浏览器麦克风（要授权，只玩不进验收）'],
];
/** 环境滑块：键、名字、范围、步长、读数格式 */
export const ENV_ROWS: [keyof Env, string, number, number, number, (v: number) => string][] = [
  ['temp', '温度', -20, 50, 0.5, (v) => `${v.toFixed(1)} °C`],
  ['humidity', '湿度', 0, 100, 1, (v) => `${v.toFixed(0)} %`],
  ['pressure', '气压', 90000, 110000, 50, (v) => `${(v / 100).toFixed(1)} hPa`],
];
export const POSE_ROWS: [keyof Pose, string, number][] = [
  ['pitch', '俯仰', 90],
  ['roll', '横滚', 180],
  ['yaw', '航向', 180],
];
const CUSTOM_KEY = 'tryboard-custom-scene';

export function createLab(dom: LabDom) {
  const store = createStore<LabState>(initialLab());
  const usbFeed = createUsbFeed();
  const st = () => store.get();
  const scene = () => st().scene;

  const bench = createBench(dom.stage);
  // 3D 台面背景 / 灯光跟主题走（与工作台 session.ts 同一写法）
  bench.setTheme(currentTheme());
  const offTheme = onTheme((t) => bench.setTheme(t));
  // 蜂鸣器声音（默认静音）：按钮由 App 挂进工具栏，点一下就是浏览器要的用户手势
  const audio = new BuzzerAudio();
  const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

  /** 场景里接了蜂鸣器的引脚 → 让 worker 每个时间片采样这些脚的 PWM */
  function syncBuzzers() {
    const pins = scene().parts.flatMap((p) => (p.type === 'buzzer' ? [p.pin] : []));
    audio.setPins(pins);
    audio.setSpeaker(scene().parts.some((p) => p.type === 'max98357a'));
    send({ type: 'watchPwm', pins });
  }

  // ---------------------------------------------------------------- I2S 音频（P2-06）
  /** 场景里的 I2S 器件 → 上电时挂上的器件（引脚按芯片固定，见 board3d 的 I2S_WIRING） */
  const i2sDevices = () => scene().parts.flatMap((p) => (p.type === 'max98357a' || p.type === 'inmp441' ? [p.type] : []));
  const wavCache = new Map<string, ArrayBuffer>();
  const micWav = async (name: string) => {
    if (!wavCache.has(name)) wavCache.set(name, await fetchBuf(`./audio/${name}`));
    return wavCache.get(name)!;
  };
  const mic = new MicInput();
  async function setMicSource(src: string) {
    store.set({ micSource: src });
    mic.stop();
    if (src === 'live') {
      const err = await mic.start((rate, data) => send({ type: 'micPush', rate, data }, [data.buffer]));
      if (err) {
        // 没有权限 / 设备：换回测试声音
        await setMicSource('sine1k.wav');
        store.set({ micStatus: `${err}，已换回 1 kHz 测试声音` });
        return;
      }
      send({ type: 'mic', source: 'live' });
    } else if (src === 'silence') send({ type: 'mic', source: 'silence' });
    else send({ type: 'mic', source: 'wav', wav: await micWav(src) });
    store.set({ micStatus: '' });
  }
  function updateAudioReadout(f: AudioFrame | undefined) {
    const el = dom.controls.querySelector<HTMLElement>('#audioReadout');
    if (!el || !f) return;
    const parts: string[] = [];
    if (scene().parts.some((p) => p.type === 'max98357a') && f.frames > 0) {
      parts.push(`喇叭（模拟）：${f.rate.toFixed(0)} Hz 采样 · 主频 ${f.freq.toFixed(1)} Hz · RMS ${f.rms.toFixed(3)}`);
      const pc = audio.state.pcm;
      if (pc && !audio.state.muted) parts.push(`网页输出：主频 ${pc.hz.toFixed(1)} Hz · RMS ${pc.rms.toFixed(3)}`);
    }
    if (scene().parts.some((p) => p.type === 'inmp441')) {
      const micSource = st().micSource;
      const src = MIC_SOURCES.find((s) => s[0] === micSource)?.[1] ?? micSource;
      parts.push(`麦克风：${src} · 已送出 ${f.micFrames} 帧${mic.state.on ? ` · 输入电平 ${mic.state.level.toFixed(3)}` : ''}`);
    }
    if (parts.length) el.textContent = parts.join('\n');
  }
  // 验收脚本要直接调 ScenePickApi；只在 ?debug=1 时暴露，正式页面不挂全局
  if (new URLSearchParams(location.search).get('debug') === '1') {
    (window as unknown as { __bench: typeof bench }).__bench = bench;
  }

  let wasm: ArrayBuffer | null = null;
  let flash: ArrayBuffer | null = null;
  /** 各芯片的 ROM（按需下载，esp-rom-elfs，Apache-2.0） */
  const roms: Partial<Record<ChipId, ArrayBuffer>> = {};
  /** 板载 BOOT 键所在引脚（启动后由模拟器告知） */
  let bootPin = 9;
  let examples: Example[] = [];
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
    return scene().parts.flatMap((p) => ('addr' in p && kind[p.type] ? [{ kind: kind[p.type], addr: p.addr }] : []));
  }

  // ---------------------------------------------------------------- 姿态（P2-03）与触摸（P2-02）
  let pose: Pose = { pitch: 0, roll: 0, yaw: 0 };
  const poseRate = new PoseRate();
  let poseIdle = 0;
  const hasImu = () => scene().parts.some((p) => p.type === 'mpu6050' || p.type === 'qmi8658');
  /** 改姿态：带拖动速率施加，停下 150 ms 补一次速率 0；台面跟着倾斜 */
  function setPose(p: Pose, from3d = false) {
    pose = { pitch: p.pitch, roll: p.roll, yaw: p.yaw };
    const rates = poseRate.push(pose, performance.now());
    send({ type: 'input', act: { kind: 'imu', ...pose, rates } });
    if (!from3d) bench.setPose(pose);
    dom.controls.querySelectorAll<HTMLInputElement>('input[data-pose]').forEach((inp) => {
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
  const touchInt = () => scene().parts.flatMap((p) => (p.type === 'cst816s' ? [p.int] : []))[0];

  const consoleEl = dom.console;
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

  const setRunning = (running: boolean) => store.set({ running });

  let pendingAutorun = false;
  async function boot(autorun: boolean) {
    if (!wasm || !flash) return;
    const chip = imageChip(flash);
    bench.setBoard(chip);
    const rom = (roms[chip] ??= await fetchBuf(`./rom/${ROM_FILE[chip]}`));
    consoleEl.textContent = '';
    log(`[试板] 上电（${chip === 'esp32s3' ? 'ESP32-S3' : 'ESP32-C3'}），加载固件…\n`, 'sys');
    // 芯片标签和编辑器的引脚列表跟着当前开发板变
    store.set({ chip });
    bench.setPowered(true);
    bench.setRgb([0, 0, 0]);
    bench.setUsb(null);
    usbFeed.reset();
    pendingAutorun = autorun;
    audio.reset();
    // 舵机接进供电网络（只有 USB：app.html 的实验台才有 USB ↔ 外接 5 V 切换）
    const parts = scene().parts;
    const servo = parts.find((p) => p.type === 'servo');
    // 编码器 / 超声波（P2-01 / P2-04）：上电时接上；超声波初始距离取场景里的
    const enc = parts.find((p) => p.type === 'encoder');
    const son = parts.find((p) => p.type === 'hcsr04');
    if (son && son.type === 'hcsr04') distance = son.cm ?? 25;
    const i2s = i2sDevices();
    const micSource = st().micSource;
    const wavName = i2s.includes('inmp441') && micSource.endsWith('.wav') ? micSource : undefined;
    const wav = wavName ? await micWav(wavName) : undefined;
    send({ type: 'boot', wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), i2c: i2cDevices(), env: sensedEnv(), lcd: parts.some((p) => p.type === 'gc9a01'), servo: servo && 'pin' in servo ? servo.pin : undefined, power: 'usb', encoder: enc && enc.type === 'encoder' ? { a: enc.a, b: enc.b, sw: enc.sw } : undefined, sonar: son && son.type === 'hcsr04' ? { trig: son.trig, echo: son.echo, cm: distance } : undefined, touchInt: touchInt(), i2s, micWav: wav?.slice(0), micName: wavName });
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

  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    switch (m.type) {
      case 'booted':
        bootPin = m.bootPin;
        syncBuzzers();
        // 浏览器麦克风的声源不跨上电：上电后重新接上
        if (st().micSource === 'live' && scene().parts.some((p) => p.type === 'inmp441')) void setMicSource('live');
        for (const [pin, a] of analog) send({ type: 'analog', pin, mv: a.mv });
        // 姿态不是上电参数：作为第一个输入施加（板子还歪着）
        if (hasImu() && (pose.pitch || pose.roll || pose.yaw)) send({ type: 'input', act: { kind: 'imu', ...pose } });
        store.set({ ready: true });
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
          const micLv = mic.state.on ? mic.state.level : st().micSource.endsWith('.wav') && m.audio.micFrames > 0 ? 0.35 : 0;
          bench.setAudio(m.audio.frames > 0 ? m.audio.rms : 0, micLv);
          updateAudioReadout(m.audio);
        }
        dom.simtime.textContent = `${m.simSeconds.toFixed(3)} s`;
        if (m.running) {
          dom.ratio.textContent = `${m.ratio.toFixed(2)}× 实时`;
          dom.ratio.classList.toggle('slow', m.ratio < 0.9);
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
        usbFeed.update(v);
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
  // 给自动化测试（tools/webtest/replay.mjs）：取日志；在网页的验收 worker 里按同一份日志重放
  Object.assign(globalThis, {
    __tbInputLog: inputLog,
    __tbButtonPos: (name: 'BOOT' | 'RST') => bench.buttonScreenPos(name),
    __tbReplay: async (log: InputLog, seconds: number, pwmPin?: number) => {
      const { replayLog } = await import('../verify');
      return replayLog(flash!, log, seconds, pwmPin);
    },
  });

  // 面包板上的轻触按键（usbkey 等示例）：按下接地
  bench.onKey((pin, down) => send({ type: 'gpio', pin, level: down ? 0 : -1 }));
  bench.onButton((name, down) => {
    if (name === 'BOOT') send({ type: 'gpio', pin: bootPin, level: down ? 0 : -1 });
    if (name === 'RST' && !down) void boot(true);
  });

  async function loadExample(id: string, autorun: boolean) {
    customFirmware = false;
    const ex = examples.find((e) => e.id === id)!;
    const chip = ex.chip ?? 'esp32c3';
    const sc = ex.scene ?? { parts: [] };
    exampleControls = ex.controls ?? [];
    store.set({ exampleId: id, about: { kind: 'example', title: ex.title, about: ex.about, chip, tags: ex.tags }, scene: sc });
    bench.setBoard(chip);
    bench.setScene(sc);
    syncControls();
    flash = await fetchBuf(`./fw/${id}/flash.bin`);
    currentFirmware = id;
    setupAssembly(ex.assembly ? (typeof ex.assembly === 'string' ? ex.assembly : 'weather') : null);
    await boot(autorun);
  }

  // ---------------------------------------------------------------- 装配视图（叠在 3D 舞台上）
  const frame = emptyFrame();
  let asm: ReturnType<typeof createAssembly> | null = null;
  let asmOffset = 0;
  let asmProduct = false;
  const setView = (view: '3d' | 'asm') => store.set({ view });
  function setupAssembly(template: string | null) {
    sensorOffset = 0;
    asmOffset = 0;
    asmProduct = false;
    asm = null;
    dom.asmBox.replaceChildren();
    store.set({ asm: !!template, view: '3d' });
    if (!template) return;
    const apply = () => {
      sensorOffset = asmProduct ? asmOffset : 0;
      sendEnv();
    };
    asm = createAssembly(
      dom.asmBox,
      {
        boot: (d) => send({ type: 'gpio', pin: bootPin, level: d ? 0 : -1 }),
        temp: (d) => {
          env.temp = Math.max(-20, Math.min(50, env.temp + d));
          const r = dom.controls.querySelector<HTMLInputElement>('input[data-env="temp"]');
          if (r) {
            r.value = String(env.temp);
            r.parentElement!.querySelector('output')!.textContent = ENV_ROWS[0][5](env.temp);
          }
          sendEnv();
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
      { servoPin: 4, template },
    );
    asm.update(frame, env.temp);
  }

  let exampleControls: (string | AnalogControl)[] = [];
  let customFirmware = false;

  /** 面板上的滑块由场景决定：有 BME280 就给环境滑块，每个电位器一个旋钮滑块（示例可给初值） */
  function syncControls() {
    analog.clear();
    const parts = scene().parts;
    const controls: Control[] = [];
    if (parts.some((p) => p.type === 'bme280')) controls.push({ kind: 'env' });
    if (hasImu()) controls.push({ kind: 'imu' });
    else {
      pose = { pitch: 0, roll: 0, yaw: 0 };
      bench.setPose(null);
    }
    for (const p of parts) {
      if (p.type !== 'pot') continue;
      const preset = exampleControls.find((c): c is AnalogControl => typeof c === 'object' && c.type === 'analog' && c.pin === p.pin);
      const c = preset ?? { type: 'analog', pin: p.pin, label: `电位器（GPIO${p.pin}）`, max_mv: 3300, value: 1650 };
      analog.set(c.pin, { mv: c.value, max: c.max_mv });
      bench.setPot(c.pin, c.value / c.max_mv);
      controls.push({ kind: 'analog', c });
    }
    const spk = parts.some((p) => p.type === 'max98357a');
    const micOn = parts.some((p) => p.type === 'inmp441');
    if (spk || micOn) controls.push({ kind: 'audio', spk, mic: micOn });
    store.set({ controls, controlsKey: st().controlsKey + 1 });
  }

  /** 模拟输入（电位器等）：滑块与 3D 旋钮双向同步 */
  function setAnalog(pin: number, mv: number, from3d: boolean) {
    const a = analog.get(pin);
    if (!a) return;
    analog.set(pin, { mv, max: a.max });
    const input = dom.controls.querySelector<HTMLInputElement>(`input[data-pot="${pin}"]`);
    if (input) {
      input.parentElement!.querySelector('output')!.textContent = `${mv.toFixed(0)} mV`;
      if (from3d) input.value = String(mv);
    }
    if (!from3d) bench.setPot(pin, mv / a.max);
    send({ type: 'analog', pin, mv });
  }
  bench.onPot((pin, v) => {
    const a = analog.get(pin);
    if (a) setAnalog(pin, v * a.max, true);
  });

  function setScene(next: SceneSpec) {
    const reboot = needsReboot(scene(), next);
    store.set({ scene: next });
    bench.setScene(next);
    syncControls();
    syncBuzzers();
    if (customFirmware) {
      try {
        localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
      } catch {
        /* 隐私模式下存不了，不影响使用 */
      }
    }
    if (reboot) {
      log('\n[试板] I2C 器件变了，重新上电\n', 'sys');
      void boot(true);
    }
  }

  async function upload(f: File) {
    flash = await f.arrayBuffer();
    currentFirmware = f.name.replace(/\.bin$/, '');
    customFirmware = true;
    exampleControls = [];
    let sc: SceneSpec;
    try {
      sc = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '') as SceneSpec;
    } catch {
      sc = { parts: [] };
    }
    store.set({ about: { kind: 'custom', name: f.name, kb: f.size / 1024 }, custom: f.name, exampleId: '__custom', scene: sc, editorOpen: true });
    bench.setScene(sc);
    syncControls();
    void boot(true);
  }

  let disposed = false;
  (async () => {
    try {
      wasm = await fetchBuf('./wasm/tryboard.wasm');
      examples = await (await fetch('./fw/examples.json')).json();
      if (disposed) return;
      store.set({ examples: examples.map((e) => ({ id: e.id, label: `${e.chip === 'esp32s3' ? '[S3] ' : ''}${e.title}` })) });
      const q = new URLSearchParams(location.search);
      const want = q.get('example');
      const first = examples.find((e) => e.id === want) ?? examples[0];
      await loadExample(first.id, q.get('autorun') !== '0');
    } catch (err) {
      log(`[试板] 资源加载失败：${err}\n`, 'err');
    }
  })();

  return {
    store,
    usbFeed,
    audio,
    /** 运行 / 暂停 */
    toggleRun() {
      send({ type: st().running ? 'pause' : 'run' });
      setRunning(!st().running);
    },
    reset: () => void boot(true),
    speed: (factor: number) => send({ type: 'speed', factor }),
    clearConsole: () => (consoleEl.textContent = ''),
    uart: (text: string) => send({ type: 'uart', text }),
    usbCdc: (text: string) => send({ type: 'usbcdc', text }),
    selectExample(id: string) {
      if (id !== '__custom') void loadExample(id, true);
    },
    upload: (f: File) => void upload(f),
    setScene,
    setView,
    setMicSource: (src: string) => void setMicSource(src),
    /** 环境滑块：改的是虚拟世界，传感器读到的随之变化 */
    setEnv(k: keyof Env, v: number) {
      env[k] = v;
      sendEnv();
    },
    env: () => ({ ...env }),
    /** 倾斜滑块：改的是台面姿态（整块面包板倾斜），IMU 读到的重力分量随之变化；也可以在 3D 里拖模块 */
    setPoseAxis: (k: keyof Pose, v: number) => setPose({ ...pose, [k]: v }),
    pose: () => ({ ...pose }),
    setAnalog: (pin: number, mv: number) => setAnalog(pin, mv, false),
    async exportInputs() {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([toScript(await inputLog())], { type: 'text/plain' }));
      a.download = `${currentFirmware || 'tryboard'}-inputs.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    dispose() {
      disposed = true;
      clearTimeout(poseIdle);
      offTheme();
      mic.stop();
      worker.terminate();
      bench.dispose();
      dom.stage.querySelectorAll(':scope > canvas').forEach((c) => c.remove());
      dom.asmBox.replaceChildren();
    },
  };
}
export type Lab = ReturnType<typeof createLab>;
