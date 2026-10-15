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
  tb_gpio_drive(pin: number, level: number): void;
  tb_uart_push(p: number, len: number): void;
  tb_i2c_attach(kind: number, addr: number): number;
  tb_env_set(temp: number, humidity: number, pressure: number): void;
  tb_oled_version(): number;
  tb_oled_ptr(): number;
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
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'speed'; factor: number }
  | { type: 'gpio'; pin: number; level: number }
  | { type: 'uart'; text: string };

export type FromWorker =
  | { type: 'booted' }
  | { type: 'error'; message: string }
  | { type: 'tick'; console: string; gpio: number; enable: number; simSeconds: number; ratio: number; running: boolean }
  | { type: 'oled'; pixels: Uint8Array }
  | { type: 'stopped'; reason: string };

let ex: Exports | null = null;
let running = false;
let speed = 1;
let simAnchor = 0; // 开始计时时的模拟周期
let wallAnchor = 0;
const decoder = new TextDecoder();
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

function errorText(e: Exports) {
  return decoder.decode(new Uint8Array(e.memory.buffer, e.tb_error_ptr(), e.tb_error_len()));
}

function copyIn(e: Exports, data: ArrayBuffer) {
  const p = e.tb_alloc(data.byteLength);
  new Uint8Array(e.memory.buffer, p, data.byteLength).set(new Uint8Array(data));
  return p;
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
    gpio: e.tb_gpio_level(),
    enable: e.tb_gpio_enable(),
    simSeconds: e.tb_cycles() / CPU_HZ,
    ratio: lastRatio,
    running,
  });
  postOled(e);
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
      oledVersion = 0;
      post({ type: 'booted' });
      break;
    }
    case 'env':
      ex?.tb_env_set(m.temp, m.humidity, m.pressure);
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
      if (ex) post({ type: 'tick', console: '', gpio: ex.tb_gpio_level(), enable: ex.tb_gpio_enable(), simSeconds: ex.tb_cycles() / CPU_HZ, ratio: 0, running });
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
