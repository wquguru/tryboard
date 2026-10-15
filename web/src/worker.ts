// 模拟器跑在 Worker 里：按真实时间节奏推进，定期把控制台输出与 GPIO 状态发给主线程。

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
  tb_analog_set(pin: number, mv: number): void;
  tb_ws2812_fetch(pin: number): number;
  tb_ws2812_ptr(): number;
  tb_ws2812_frames(pin: number): number;
  tb_i2c_attach(kind: number, addr: number): number;
  tb_env_set(temp: number, humidity: number, pressure: number): void;
  tb_oled_version(): number;
  tb_oled_ptr(): number;
  tb_usb_version(): number;
  tb_usb_json(): number;
  tb_usb_json_ptr(): number;
  tb_usb_cdc_send(p: number, len: number): void;
  tb_chip(): number;
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
    }
  | ({ type: 'env' } & Env)
  | { type: 'analog'; pin: number; mv: number }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'speed'; factor: number }
  | { type: 'gpio'; pin: number; level: number }
  | { type: 'uart'; text: string }
  | { type: 'usbcdc'; text: string };

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
      simSeconds: number;
      ratio: number;
      running: boolean;
      leds?: number[][];
    }
  | { type: 'oled'; pixels: Uint8Array }
  /** 原生 USB 虚拟主机的状态（JSON，结构见 usb3d.ts 的 UsbView），有变化才发 */
  | { type: 'usb'; json: string }
  | { type: 'stopped'; reason: string };

let ex: Exports | null = null;
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
    stop = e.tb_run(Math.min(behind, CPU_HZ / 200));
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
  post({
    type: 'tick',
    console: text,
    leds: leds(e),
    gpio: e.tb_gpio_level(),
    enable: e.tb_gpio_enable(),
    gpioHi: e.tb_gpio_level_hi(),
    enableHi: e.tb_gpio_enable_hi(),
    pwm: pwmAll(e),
    simSeconds: e.tb_cycles() / CPU_HZ,
    ratio: lastRatio,
    running,
  });
  postOled(e);
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

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'boot': {
      running = false;
      const { instance } = await WebAssembly.instantiate(m.wasm, {});
      const e = instance.exports as unknown as Exports;
      const rp = copyIn(e, m.rom);
      const fp = copyIn(e, m.flash);
      const r = e.tb_boot(rp, m.rom.byteLength, fp, m.flash.byteLength);
      e.tb_free(rp, m.rom.byteLength);
      e.tb_free(fp, m.flash.byteLength);
      if (r !== 0) {
        post({ type: 'error', message: errorText(e) });
        return;
      }
      for (const d of m.i2c ?? []) e.tb_i2c_attach(I2C_KIND[d.kind] ?? 0, d.addr);
      if (m.env) e.tb_env_set(m.env.temp, m.env.humidity, m.env.pressure);
      ex = e;
      const s3 = e.tb_chip() === 9;
      LED_PIN = s3 ? 48 : 8;
      NPINS = s3 ? 49 : 22;
      lastFrames = -1;
      oledVersion = 0;
      usbVersion = -1;
      post({ type: "booted", chip: s3 ? "esp32s3" : "esp32c3", bootPin: e.tb_boot_pin() });
      break;
    }
    case 'env':
      ex?.tb_env_set(m.temp, m.humidity, m.pressure);
      break;
    case 'analog':
      ex?.tb_analog_set(m.pin, m.mv);
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
      if (ex) post({ type: 'tick', console: '', gpio: ex.tb_gpio_level(), enable: ex.tb_gpio_enable(), gpioHi: ex.tb_gpio_level_hi(), enableHi: ex.tb_gpio_enable_hi(), pwm: pwmAll(ex), simSeconds: ex.tb_cycles() / CPU_HZ, ratio: 0, running });
      break;
    case 'speed':
      speed = m.factor;
      if (ex) {
        simAnchor = ex.tb_cycles();
        wallAnchor = performance.now();
      }
      break;
    case 'gpio':
      ex?.tb_gpio_drive(m.pin, m.level);
      break;
    case 'usbcdc': {
      if (!ex) return;
      const b = new TextEncoder().encode(m.text);
      const p = ex.tb_alloc(b.length);
      new Uint8Array(ex.memory.buffer, p, b.length).set(b);
      ex.tb_usb_cdc_send(p, b.length);
      ex.tb_free(p, b.length);
      break;
    }
    case 'uart': {
      if (!ex) return;
      const b = new TextEncoder().encode(m.text);
      const p = ex.tb_alloc(b.length);
      new Uint8Array(ex.memory.buffer, p, b.length).set(b);
      ex.tb_uart_push(p, b.length);
      ex.tb_free(p, b.length);
      break;
    }
  }
};
