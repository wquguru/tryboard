// 模拟器跑在 Worker 里：按真实时间节奏推进，定期把控制台输出与 GPIO 状态发给主线程。
// 时间片固定 1ms（与 CLI `--inputs` 重放相同），外部输入只在时间片之间施加并按模拟时间记进输入日志（inputlog.ts），
// 所以网页上的一串操作导出后，命令行能逐周期重放。
import { cyclesToMs, type InputAction, type InputEvent, type InputLog } from './inputlog';

const CPU_HZ = 160_000_000;

interface Exports {
  memory: WebAssembly.Memory;
  tb_alloc(len: number): number;
  tb_free(p: number, len: number): void;
  tb_boot(rom: number, romLen: number, flash: number, flashLen: number): number;
  tb_error_ptr(): number;
  tb_error_len(): number;
  tb_run(cycles: number): number;
  tb_console_ptr(): number;
  tb_console_len(): number;
  tb_console_clear(): void;
  tb_cycles(): number;
  tb_gpio_level(): number;
  tb_gpio_enable(): number;
  tb_gpio_level_hi(): number;
  tb_gpio_enable_hi(): number;
  tb_chip(): number;
  tb_boot_pin(): number;
  tb_gpio_drive(pin: number, level: number): void;
  tb_uart_push(p: number, len: number): void;
  tb_pin_pwm(pin: number): number;
  tb_pin_pwm_freq(pin: number): number;
  tb_analog_set(pin: number, mv: number): void;
  tb_ws2812_fetch(pin: number): number;
  tb_ws2812_ptr(): number;
  tb_ws2812_frames(pin: number): number;
  tb_i2c_attach(kind: number, addr: number): number;
  tb_env_set(temp: number, humidity: number, pressure: number): void;
  tb_oled_version(): number;
  tb_oled_ptr(): number;
  tb_lcd_attach(): number;
  tb_lcd_version(): number;
  tb_lcd_ptr(): number;
  tb_usb_version(): number;
  tb_usb_json(): number;
  tb_usb_json_ptr(): number;
  tb_usb_cdc_send(p: number, len: number): void;
  tb_report(): number;
  tb_report_ptr(): number;
}

export interface Env {
  temp: number;
  humidity: number;
  pressure: number;
}

export type ToWorker =
  | {
      type: 'boot';
      wasm: ArrayBuffer;
      rom: ArrayBuffer;
      flash: ArrayBuffer;
      i2c?: { kind: string; addr: number }[];
      env?: Env;
      /** 挂 GC9A01 圆屏（SPI2） */
      lcd?: boolean;
    }
  | ({ type: 'env' } & Env)
  | { type: 'analog'; pin: number; mv: number }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'speed'; factor: number }
  | { type: 'gpio'; pin: number; level: number }
  | { type: 'uart'; text: string }
  | { type: 'usbcdc'; text: string }
  /** 每个时间片采样这些引脚的 PWM，有变化就带模拟时刻放进 tick 的 pwmEvents（蜂鸣器出声用） */
  | { type: 'watchPwm'; pins: number[] }
  /** 要本次上电以来的输入日志，回 inputlog 消息 */
  | { type: 'getInputLog' }
  /** 本次上电以来的输入日志 + 串口全文 + 观察记录（算运行指纹用），回 snapshot 消息；不打断运行 */
  | { type: 'snapshot' }
  /** 时间线回退（P0-03）：重新上电，按输入日志在原来的模拟时刻施加，快进到 untilMs 后停住（不按墙钟），回 seeked */
  | {
      type: 'seek';
      wasm: ArrayBuffer;
      rom: ArrayBuffer;
      flash: ArrayBuffer;
      i2c?: { kind: string; addr: number }[];
      env?: Env;
      lcd?: boolean;
      /** 上电以后施加的输入（不含上电和上电时的环境），时间 = 原来施加时的模拟时刻 */
      events: InputEvent[];
      untilMs: number;
    }
  /** 记一个时间点：回 mark 消息（时间线上"这一步发生在模拟第几毫秒"） */
  | { type: 'mark'; id: number };

/** 引脚 PWM 的一次变化（模拟时刻 t 秒；duty < 0 表示不再输出 PWM） */
export interface PwmEvent {
  pin: number;
  t: number;
  duty: number;
  freq: number;
}

export type FromWorker =
  | { type: 'booted'; chip: 'esp32c3' | 'esp32s3'; bootPin: number }
  | { type: 'error'; message: string }
  | {
      type: 'tick';
      console: string;
      gpio: number;
      enable: number;
      /** GPIO32 以上（S3）的电平 / 使能 */
      gpioHi: number;
      enableHi: number;
      pwm: number[];
      /** 各引脚 PWM 频率（Hz，没有 PWM 为 0） */
      pwmFreq: number[];
      /** watchPwm 引脚上自上一个 tick 以来的变化（按时间先后） */
      pwmEvents?: PwmEvent[];
      simSeconds: number;
      ratio: number;
      running: boolean;
      leds?: number[][];
    }
  | { type: 'oled'; pixels: Uint8Array }
  /** GC9A01：240×240 RGBA，画面变了才发 */
  | { type: 'lcd'; pixels: Uint8Array }
  /** 原生 USB 虚拟主机的状态（JSON，结构见 usb3d.ts 的 UsbView），有变化才发 */
  | { type: 'usb'; json: string }
  | { type: 'inputlog'; log: InputLog }
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'seekProgress'; simSeconds: number }
  | { type: 'seeked'; snap: Snapshot; bootPin: number }
  | { type: 'mark'; id: number; tMs: number }
  | { type: 'stopped'; reason: string };

/** 一次上电到此刻的完整记录：指纹 = fingerprint(stdout, report)，与验收 worker / 命令行同一算法 */
export interface Snapshot {
  log: InputLog;
  stdout: string;
  report: string;
  simSeconds: number;
  /** 串口太长没存全（指纹不可用） */
  truncated: boolean;
}

let ex: Exports | null = null;
// 本次上电以来的串口全文（算运行指纹要从上电开始的全部字节）；超过 4MB 不再存，指纹标"太长"
const STDOUT_CAP = 4 << 20;
let bootStdout = '';
let stdoutTruncated = false;
function keepStdout(text: string) {
  if (stdoutTruncated || !text) return;
  if (bootStdout.length + text.length > STDOUT_CAP) stdoutTruncated = true;
  else bootStdout += text;
}
function snapshot(e: Exports): Snapshot {
  const n = e.tb_report();
  const report = decoder.decode(new Uint8Array(e.memory.buffer, e.tb_report_ptr(), n));
  return { log: { ...structuredClone(inputLog), endMs: cyclesToMs(e.tb_cycles()) }, stdout: bootStdout, report, simSeconds: e.tb_cycles() / CPU_HZ, truncated: stdoutTruncated };
}
let running = false;
let speed = 1;
let simAnchor = 0; // 开始计时时的模拟周期
let wallAnchor = 0;
const decoder = new TextDecoder();
/** 板载 WS2812 所在引脚（C3 GPIO8，S3 GPIO48）与引脚数，按芯片在启动后设置 */
let LED_PIN = 8;
let NPINS = 22;
let lastFrames = -1;

/** 板载灯带有新帧时返回各灯 [r,g,b]，否则 undefined（省掉无变化时的消息体积） */
function leds(e: Exports): number[][] | undefined {
  const f = e.tb_ws2812_frames(LED_PIN);
  if (f === lastFrames) return undefined;
  lastFrames = f;
  const n = e.tb_ws2812_fetch(LED_PIN);
  const b = new Uint8Array(e.memory.buffer, e.tb_ws2812_ptr(), n * 3);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) out.push([b[i * 3], b[i * 3 + 1], b[i * 3 + 2]]);
  return out;
}
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

function errorText(e: Exports) {
  return decoder.decode(new Uint8Array(e.memory.buffer, e.tb_error_ptr(), e.tb_error_len()));
}

function copyIn(e: Exports, data: ArrayBuffer) {
  const p = e.tb_alloc(data.byteLength);
  new Uint8Array(e.memory.buffer, p, data.byteLength).set(new Uint8Array(data));
  return p;
}

/** 每个引脚的 PWM 占空比（-1 表示没有 PWM） */
function pwmAll(e: Exports) {
  const out: number[] = [];
  for (let p = 0; p < NPINS; p++) out.push(e.tb_pin_pwm(p));
  return out;
}
function pwmFreqAll(e: Exports) {
  const out: number[] = [];
  for (let p = 0; p < NPINS; p++) out.push(e.tb_pin_pwm_freq(p));
  return out;
}

// ---- 输入日志：本次上电以来施加过的外部输入，时间戳 = 施加时的模拟时间
let inputLog: InputLog = { version: 1, i2c: [], lcd: false, events: [] };
function record(e: Exports, ev: InputAction) {
  inputLog.events.push({ tMs: cyclesToMs(e.tb_cycles()), ...ev } as InputEvent);
}

// ---- PWM 变化采样（蜂鸣器）：每个时间片之间看一次，1ms 分辨率
let watchPins: number[] = [];
let pwmLast = new Map<number, [number, number]>();
let pwmEvents: PwmEvent[] = [];
function samplePwm(e: Exports) {
  for (const pin of watchPins) {
    const d = e.tb_pin_pwm(pin);
    const f = d >= 0 ? e.tb_pin_pwm_freq(pin) : 0;
    const l = pwmLast.get(pin);
    if (l && l[0] === d && l[1] === f) continue;
    pwmLast.set(pin, [d, f]);
    pwmEvents.push({ pin, t: e.tb_cycles() / CPU_HZ, duty: d, freq: f });
  }
}
function takePwmEvents() {
  if (!pwmEvents.length) return undefined;
  const v = pwmEvents;
  pwmEvents = [];
  return v;
}

let ratioWall = 0;
let ratioSim = 0;
let lastRatio = 1;

function loop() {
  if (!ex || !running) return;
  const e = ex;
  const now = performance.now();
  // 目标：模拟时间追上（墙钟 × 速度）；每轮最多算 20ms 墙钟，避免卡住消息处理
  const targetCycles = simAnchor + ((now - wallAnchor) / 1000) * CPU_HZ * speed;
  let behind = targetCycles - e.tb_cycles();
  const t0 = performance.now();
  const startCycles = e.tb_cycles();
  let stop = 0;
  while (behind > 0 && performance.now() - t0 < 20) {
    // 固定 1ms 一片（不按"还差多少"切）：S3 双核的交替点取决于每片的起点，和 CLI 一样切才能逐周期重放
    stop = e.tb_run(CPU_HZ / 1000);
    if (watchPins.length) samplePwm(e);
    if (stop !== 0) break;
    behind = targetCycles - e.tb_cycles();
  }
  // 跟不上真实时间时，重设锚点（不去追欠下的时间）并报告实际倍速
  if (behind > CPU_HZ * 0.1) {
    simAnchor = e.tb_cycles();
    wallAnchor = performance.now();
  }
  // 倍速 = 一段墙钟时间内推进的模拟时间 / 这段墙钟时间
  if (ratioWall === 0) {
    ratioWall = now;
    ratioSim = startCycles;
  } else if (now - ratioWall > 500) {
    lastRatio = ((e.tb_cycles() - ratioSim) / CPU_HZ) * 1000 / (now - ratioWall);
    ratioWall = now;
    ratioSim = e.tb_cycles();
  }
  const len = e.tb_console_len();
  const text = len ? decoder.decode(new Uint8Array(e.memory.buffer, e.tb_console_ptr(), len)) : '';
  e.tb_console_clear();
  keepStdout(text);
  post({
    type: 'tick',
    console: text,
    leds: leds(e),
    gpio: e.tb_gpio_level(),
    enable: e.tb_gpio_enable(),
    gpioHi: e.tb_gpio_level_hi(),
    enableHi: e.tb_gpio_enable_hi(),
    pwm: pwmAll(e),
    pwmFreq: pwmFreqAll(e),
    pwmEvents: takePwmEvents(),
    simSeconds: e.tb_cycles() / CPU_HZ,
    ratio: lastRatio,
    running,
  });
  postOled(e);
  postLcd(e);
  postUsb(e);
  if (stop !== 0) {
    running = false;
    post({ type: 'stopped', reason: errorText(e) });
    return;
  }
  setTimeout(loop, 4);
}

let oledVersion = 0;
/** OLED 画面变了才传（128×64 字节，转移所有权不拷贝两次） */
function postOled(e: Exports) {
  const v = e.tb_oled_version();
  if (v === 0 || v === oledVersion) return;
  const p = e.tb_oled_ptr();
  if (!p) return;
  oledVersion = v;
  const px = new Uint8Array(new Uint8Array(e.memory.buffer, p, 128 * 64));
  (self as unknown as Worker).postMessage({ type: 'oled', pixels: px } satisfies FromWorker, [px.buffer]);
}

let lcdVersion = 0;
let lcdLast = 0;
/** 圆屏 240×240×4 = 230KB：画面变了才传，并且最多 30 帧/秒 */
function postLcd(e: Exports, force = false) {
  if (!e.tb_lcd_version) return;
  const v = e.tb_lcd_version();
  const now = performance.now();
  if (v === 0 || v === lcdVersion || (!force && now - lcdLast < 33)) return;
  const p = e.tb_lcd_ptr();
  if (!p) return;
  lcdVersion = v;
  lcdLast = now;
  const px = new Uint8Array(new Uint8Array(e.memory.buffer, p, 240 * 240 * 4));
  (self as unknown as Worker).postMessage({ type: 'lcd', pixels: px } satisfies FromWorker, [px.buffer]);
}

let usbVersion = 0;
function postUsb(e: Exports) {
  const v = e.tb_usb_version();
  if (v === usbVersion) return;
  usbVersion = v;
  if (v === 0) {
    post({ type: 'usb', json: '' });
    return;
  }
  const n = e.tb_usb_json();
  post({ type: 'usb', json: decoder.decode(new Uint8Array(e.memory.buffer, e.tb_usb_json_ptr(), n)) });
}

const I2C_KIND: Record<string, number> = { ssd1306: 1, bme280: 2 };

function postPaused(e: Exports) {
  post({ type: 'tick', console: '', leds: leds(e), gpio: e.tb_gpio_level(), enable: e.tb_gpio_enable(), gpioHi: e.tb_gpio_level_hi(), enableHi: e.tb_gpio_enable_hi(), pwm: pwmAll(e), pwmFreq: pwmFreqAll(e), pwmEvents: takePwmEvents(), simSeconds: e.tb_cycles() / CPU_HZ, ratio: 0, running });
}

type BootMsg = { wasm: ArrayBuffer; rom: ArrayBuffer; flash: ArrayBuffer; i2c?: { kind: string; addr: number }[]; env?: Env; lcd?: boolean };
/** 上电：建 wasm 实例、挂器件、设环境、开一份新的输入日志 */
async function bootWasm(m: BootMsg): Promise<Exports | null> {
  const { instance } = await WebAssembly.instantiate(m.wasm, {});
  const e = instance.exports as unknown as Exports;
  const rp = copyIn(e, m.rom);
  const fp = copyIn(e, m.flash);
  const r = e.tb_boot(rp, m.rom.byteLength, fp, m.flash.byteLength);
  e.tb_free(rp, m.rom.byteLength);
  e.tb_free(fp, m.flash.byteLength);
  if (r !== 0) {
    post({ type: 'error', message: errorText(e) });
    return null;
  }
  for (const d of m.i2c ?? []) e.tb_i2c_attach(I2C_KIND[d.kind] ?? 0, d.addr);
  if (m.env) e.tb_env_set(m.env.temp, m.env.humidity, m.env.pressure);
  if (m.lcd && e.tb_lcd_attach) e.tb_lcd_attach();
  inputLog = { version: 1, chip: e.tb_chip() === 9 ? 'esp32s3' : 'esp32c3', i2c: [...(m.i2c ?? [])], lcd: !!m.lcd, events: [] };
  record(e, { kind: 'power', on: true });
  if (m.env) record(e, { kind: 'env', temp: m.env.temp, humidity: m.env.humidity, pressure: m.env.pressure });
  pwmLast = new Map();
  pwmEvents = [];
  bootStdout = '';
  stdoutTruncated = false;
  ex = e;
  const s3 = e.tb_chip() === 9;
  LED_PIN = s3 ? 48 : 8;
  NPINS = s3 ? 49 : 22;
  lastFrames = -1;
  oledVersion = 0;
  lcdVersion = 0;
  usbVersion = -1;
  return e;
}

/** 施加一条输入（实时运行收到的消息和回退重放走同一个函数，记进日志的时刻就是施加时的模拟时刻） */
function apply(e: Exports, ev: InputAction) {
  switch (ev.kind) {
    case 'env':
      e.tb_env_set(ev.temp, ev.humidity, ev.pressure);
      break;
    case 'pot':
      e.tb_analog_set(ev.pin, ev.mv);
      break;
    case 'gpio':
      e.tb_gpio_drive(ev.pin, ev.level);
      break;
    case 'uart':
    case 'usbcdc': {
      const b = new TextEncoder().encode(ev.text);
      const p = e.tb_alloc(b.length);
      new Uint8Array(e.memory.buffer, p, b.length).set(b);
      if (ev.kind === 'uart') e.tb_uart_push(p, b.length);
      else e.tb_usb_cdc_send(p, b.length);
      e.tb_free(p, b.length);
      break;
    }
    case 'power':
      return;
  }
  record(e, ev);
}

/**
 * 回退重放：与实时运行同样 1ms 一片、输入在时间片之间施加。原来的事件发生在某个时间片边界（施加时的周期数），
 * 这里在同一个边界施加，所以逐周期重现；跑到 untilMs 所在的边界停住，那一刻的事件不施加（属于下一步）。
 */
function seekTo(e: Exports, events: InputEvent[], untilMs: number) {
  const until = Math.round(untilMs * (CPU_HZ / 1000));
  const evs = events.filter((x) => x.kind !== 'power').map((x) => ({ at: Math.round(x.tMs * (CPU_HZ / 1000)), x }));
  let i = 0;
  let lastPost = performance.now();
  while (e.tb_cycles() < until) {
    while (i < evs.length && evs[i].at <= e.tb_cycles()) {
      const { tMs: _t, ...act } = evs[i++].x;
      apply(e, act as InputAction);
    }
    if (watchPins.length) samplePwm(e);
    const stop = e.tb_run(CPU_HZ / 1000);
    const len = e.tb_console_len();
    if (len) keepStdout(decoder.decode(new Uint8Array(e.memory.buffer, e.tb_console_ptr(), len)));
    e.tb_console_clear();
    if (stop !== 0) break;
    const now = performance.now();
    if (now - lastPost > 100) {
      lastPost = now;
      post({ type: 'seekProgress', simSeconds: e.tb_cycles() / CPU_HZ });
    }
  }
  // 停住时刻之前的串口输出已经在快照里；主线程用快照的 stdout 重建串口面板
  pwmEvents = [];
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'boot': {
      running = false;
      const e = await bootWasm(m);
      if (!e) return;
      post({ type: 'booted', chip: e.tb_chip() === 9 ? 'esp32s3' : 'esp32c3', bootPin: e.tb_boot_pin() });
      break;
    }
    case 'seek': {
      running = false;
      const e = await bootWasm(m);
      if (!e) return;
      seekTo(e, m.events, m.untilMs);
      post({ type: 'seeked', snap: snapshot(e), bootPin: e.tb_boot_pin() });
      postPaused(e);
      postOled(e);
      postLcd(e, true);
      break;
    }
    case 'snapshot':
      if (ex) post({ type: 'snapshot', snap: snapshot(ex) });
      break;
    case 'mark':
      post({ type: 'mark', id: m.id, tMs: ex ? cyclesToMs(ex.tb_cycles()) : 0 });
      break;
    case 'env':
      if (!ex) return;
      apply(ex, { kind: 'env', temp: m.temp, humidity: m.humidity, pressure: m.pressure });
      break;
    case 'analog':
      if (!ex) return;
      apply(ex, { kind: 'pot', pin: m.pin, mv: m.mv });
      break;
    case 'watchPwm':
      watchPins = [...m.pins];
      pwmLast = new Map();
      break;
    case 'getInputLog':
      post({ type: 'inputlog', log: { ...structuredClone(inputLog), endMs: ex ? cyclesToMs(ex.tb_cycles()) : 0 } });
      break;
    case 'run':
      if (!ex || running) return;
      running = true;
      ratioWall = 0;
      simAnchor = ex.tb_cycles();
      wallAnchor = performance.now();
      loop();
      break;
    case 'pause':
      running = false;
      if (ex) postPaused(ex);
      break;
    case 'speed':
      speed = m.factor;
      if (ex) {
        simAnchor = ex.tb_cycles();
        wallAnchor = performance.now();
      }
      break;
    case 'gpio':
      if (!ex) return;
      apply(ex, { kind: 'gpio', pin: m.pin, level: m.level });
      break;
    case 'usbcdc':
    case 'uart':
      if (!ex) return;
      apply(ex, { kind: m.type, text: m.text });
      break;
  }
};
