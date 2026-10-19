// 按模拟时间（不看墙钟）把固件跑完规定秒数、在精确的模拟时刻施加输入脚本、按 CLI 的规则采样 PWM。
// 网页验收（verify-worker.ts）和 npm 命令行（packages/tryboard）共用这一份，不碰 DOM / Worker，
// 所以两边与原生 `tryboard run` / tools/check.py 得到同一份串口输出、观察记录和指纹。

import { parseScript } from './checks';

export const CPU_HZ = 160_000_000;

export interface Ex {
  memory: WebAssembly.Memory;
  tb_alloc(n: number): number;
  tb_free(p: number, n: number): void;
  tb_boot(r: number, rl: number, f: number, fl: number): number;
  tb_error_ptr(): number;
  tb_error_len(): number;
  tb_run(c: number): number;
  tb_cycles(): number;
  tb_console_ptr(): number;
  tb_console_len(): number;
  tb_console_clear(): void;
  tb_gpio_drive(pin: number, level: number): void;
  tb_analog_set(pin: number, mv: number): void;
  tb_uart_push(p: number, n: number): void;
  tb_usb_cdc_send(p: number, n: number): void;
  tb_pin_pwm(pin: number): number;
  tb_pin_pwm_freq(pin: number): number;
  tb_i2c_attach(kind: number, addr: number): number;
  tb_env_set(t: number, h: number, p: number): void;
  tb_report(): number;
  tb_report_ptr(): number;
  tb_lcd_attach?(): number;
  tb_reset_limit?(n: number): void;
  tb_reset_count?(): number;
  tb_power_set?(mode: number): void;
  tb_servo_attach?(pin: number): void;
  tb_usb_report?(): number;
  tb_i2c_report?(): number;
  tb_i2c_wire?(cm: number): void;
  tb_antenna_loss?(db: number): void;
  tb_encoder_attach?(a: number, b: number, sw: number): void;
  tb_encoder_turn?(steps: number): void;
  tb_encoder_press?(down: number): void;
  tb_sonar_attach?(trig: number, echo: number): void;
  tb_sonar_distance?(cm: number): void;
  tb_imu_set?(pitch: number, roll: number, yaw: number, dp: number, dr: number, dy: number): void;
  tb_touch?(x: number, y: number, down: number): void;
  tb_touch_int?(pin: number): void;
}

export interface SimJob {
  wasm: ArrayBuffer | Uint8Array;
  rom: ArrayBuffer | Uint8Array;
  flash: ArrayBuffer | Uint8Array;
  seconds: number;
  i2c: { kind: string; addr: number }[];
  env?: { temp: number; humidity: number; pressure: number };
  script?: string;
  pwmPin?: number;
  lcd?: boolean;
  /** 舵机信号脚与供电（= CLI --servo / --power）；接了舵机时与 CLI 一样始终 1ms 一片 */
  servo?: number;
  power?: 'usb' | 'ext';
  /** 触摸 INT 脚（= CLI --touch-int） */
  touchInt?: number;
  /** 始终 1ms 一片（= CLI 的 --inputs）：重放网页实时运行导出的输入日志时用 */
  fixedSlice?: boolean;
  /** = CLI --usb-log：观察记录里带上 USB 虚拟主机的状态与键盘输入（P2-12） */
  usb?: boolean;
  /** = CLI --i2c-log：观察记录里带上每个 I2C 地址的应答次数（生成检查点 i2c_ack，U-17） */
  i2cLog?: boolean;
  /** = CLI --i2c-wire / --antenna-loss（P2-11，估算） */
  i2cWire?: number;
  antenna?: number;
  /** 旋转编码器 / HC-SR04（= CLI --encoder A,B[,SW] / --sonar TRIG,ECHO --dist 厘米）；接了也始终 1ms 一片 */
  encoder?: { a: number; b: number; sw?: number };
  sonar?: { trig: number; echo: number; cm?: number };
}

export interface SimResult {
  stdout: string;
  report: string;
  sim: number;
  /** 运行中停下（CPU 异常等） */
  error?: string;
  /** 根本没启动起来（镜像坏了、缺 ROM） */
  bootError?: string;
}

export interface SimHooks {
  onProgress?: (sim: number) => void;
  /** 每个时间片新到的串口文本（`tryboard run` 边跑边打印用） */
  onConsole?: (text: string) => void;
  /** 软件复位：第 n 次；stopped = 超过 50 次、不再重新上电 */
  onReset?: (n: number, stopped: boolean) => void;
}

const I2C_KIND: Record<string, number> = { ssd1306: 1, bme280: 2, mpu6050: 3, qmi8658: 4, cst816s: 5 };

/** 镜像是哪颗芯片：先找分区表（0x8000）里的 app，再读 ESP 镜像头的芯片 ID（5 = C3，9 = S3） */
export function imageChip(buf: ArrayBuffer | Uint8Array): 'esp32c3' | 'esp32s3' {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const u32 = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  let app = 0;
  if (b[0x8000] === 0xaa && b[0x8001] === 0x50) {
    for (let i = 0; i < 95; i++) {
      const o = 0x8000 + i * 32;
      if (b[o] !== 0xaa || b[o + 1] !== 0x50) break;
      if (b[o + 2] === 0 && (b[o + 3] === 0 || b[o + 3] === 0x10)) {
        app = u32(o + 4) >>> 0;
        break;
      }
    }
  }
  return b[app] === 0xe9 && (b[app + 12] | (b[app + 13] << 8)) === 9 ? 'esp32s3' : 'esp32c3';
}

const u8 = (b: ArrayBuffer | Uint8Array) => (b instanceof Uint8Array ? b : new Uint8Array(b));

function bytesIn(e: Ex, b: Uint8Array, f: (p: number, n: number) => void) {
  const p = e.tb_alloc(b.length);
  new Uint8Array(e.memory.buffer, p, b.length).set(b);
  f(p, b.length);
  e.tb_free(p, b.length);
}

export async function runSim(j: SimJob, hooks: SimHooks = {}): Promise<SimResult> {
  const dec = new TextDecoder();
  const { instance } = await WebAssembly.instantiate(u8(j.wasm), {});
  const e = instance.exports as unknown as Ex;
  const rom = u8(j.rom), flash = u8(j.flash);
  const rp = e.tb_alloc(rom.byteLength);
  new Uint8Array(e.memory.buffer, rp, rom.byteLength).set(rom);
  const fp = e.tb_alloc(flash.byteLength);
  new Uint8Array(e.memory.buffer, fp, flash.byteLength).set(flash);
  const r = e.tb_boot(rp, rom.byteLength, fp, flash.byteLength);
  const errText = () => new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.tb_error_ptr(), e.tb_error_len()));
  if (r !== 0) return { stdout: '', report: '', sim: 0, error: errText(), bootError: errText() };
  for (const d of j.i2c) e.tb_i2c_attach(I2C_KIND[d.kind] ?? 0, d.addr);
  if (j.env) e.tb_env_set(j.env.temp, j.env.humidity, j.env.pressure);
  if (j.lcd) e.tb_lcd_attach?.();
  // 与原生 CLI 相同：崩溃重启 / 欠压复位最多 50 次，第 51 次复位就停在复位前（防止重启死循环把时间跑满，也让两边停在同一周期）
  e.tb_reset_limit?.(50);
  if (j.servo !== undefined) e.tb_servo_attach?.(j.servo);
  if (j.power) e.tb_power_set?.(j.power === 'ext' ? 1 : 0);
  if (j.i2cWire !== undefined) e.tb_i2c_wire?.(j.i2cWire);
  if (j.antenna !== undefined) e.tb_antenna_loss?.(j.antenna);
  if (j.encoder) e.tb_encoder_attach?.(j.encoder.a, j.encoder.b, j.encoder.sw ?? -1);
  if (j.sonar) {
    e.tb_sonar_attach?.(j.sonar.trig, j.sonar.echo);
    if (j.sonar.cm !== undefined) e.tb_sonar_distance?.(j.sonar.cm);
  }
  if (j.touchInt !== undefined) e.tb_touch_int?.(j.touchInt);

  const script = parseScript(j.script);
  let si = 0;
  const total = Math.floor(j.seconds * CPU_HZ);
  let done = 0;
  let out = '';
  const trace: [number, number, number][] = [];
  const f32 = Math.fround;
  let error: string | undefined;
  let lastPost = 0;
  let resets = 0;
  while (done < total) {
    const now = e.tb_cycles() / CPU_HZ;
    while (si < script.length && script[si].t <= now) {
      const act = script[si++].act;
      let m: RegExpMatchArray | null;
      if ((m = act.match(/^gpio(\d+)=(.*)$/))) e.tb_gpio_drive(Number(m[1]) || 0, m[2] === 'z' ? -1 : m[2] === '1' ? 1 : 0);
      else if ((m = act.match(/^mv(\d+)=(.*)$/))) e.tb_analog_set(Number(m[1]), Number(m[2]));
      else if (act.startsWith('env=')) {
        const v = act.slice(4).split(',').map(Number);
        if (v.length === 3 && v.every((x) => !Number.isNaN(x))) e.tb_env_set(v[0], v[1], v[2]);
      } else if (act.startsWith('uart=')) bytesIn(e, new TextEncoder().encode(act.slice(5).replaceAll('\\n', '\n')), (p, n) => e.tb_uart_push(p, n));
      else if (act.startsWith('power=')) e.tb_power_set?.(act.slice(6).trim() === 'ext' ? 1 : 0);
      else if (act.startsWith('i2cwire=')) e.tb_i2c_wire?.(Number(act.slice(8)));
      else if (act.startsWith('antenna=')) e.tb_antenna_loss?.(Number(act.slice(8)) | 0);
      else if ((m = act.match(/^enc=\+?(-?\d+)$/))) e.tb_encoder_turn?.(Number(m[1]));
      else if (act.startsWith('encsw=')) e.tb_encoder_press?.(act.slice(6).trim() === '1' ? 1 : 0);
      else if (act.startsWith('dist=')) {
        const d = Number(act.slice(5));
        if (!Number.isNaN(d)) e.tb_sonar_distance?.(d);
      } else if (act.startsWith('usbcdc=')) bytesIn(e, new TextEncoder().encode(act.slice(7).replaceAll('\\n', '\n')), (p, n) => e.tb_usb_cdc_send(p, n));
      else if (act.startsWith('imu=')) {
        // 与 CLI parse_imu 相同：3 个数（姿态）或 6 个数（再加变化率）
        const v = act.slice(4).split(',').map(Number);
        if ((v.length === 3 || v.length === 6) && v.every((x) => !Number.isNaN(x))) e.tb_imu_set?.(v[0], v[1], v[2], v[3] ?? 0, v[4] ?? 0, v[5] ?? 0);
      } else if (act.startsWith('touch=')) {
        const v = act.slice(6).split(',').map(Number);
        if (v.length === 2 && v.every((x) => !Number.isNaN(x))) e.tb_touch?.(v[0], v[1], 1);
      } else if (act === 'release') e.tb_touch?.(0, 0, 0);
    }
    if (j.pwmPin !== undefined) {
      const d = e.tb_pin_pwm(j.pwmPin);
      if (d >= 0) {
        const f = e.tb_pin_pwm_freq(j.pwmPin);
        const l = trace[trace.length - 1];
        if (!l || Math.abs(f32(l[0] - d)) > f32(0.004) || Math.abs(f32(l[1] - f)) > f32(0.5)) trace.push([d, f, now]);
      }
    }
    const slice = si >= script.length && j.pwmPin === undefined && !j.fixedSlice && j.servo === undefined && !j.encoder && !j.sonar ? CPU_HZ / 100 : CPU_HZ / 1000;
    const before = e.tb_cycles();
    const stop = e.tb_run(Math.min(slice, total - done));
    done += e.tb_cycles() - before;
    const n = e.tb_console_len();
    if (n) {
      const t = dec.decode(new Uint8Array(e.memory.buffer, e.tb_console_ptr(), n), { stream: true });
      out += t;
      if (t) hooks.onConsole?.(t);
    }
    e.tb_console_clear();
    if (stop === 3) {
      hooks.onReset?.(resets + 1, true);
      break;
    }
    if (stop !== 0) {
      error = errText();
      break;
    }
    const rc = e.tb_reset_count?.() ?? 0;
    // 注意：不能写成 hooks.onReset?.(++resets)——没有回调时可选调用连参数都不求值，计数不涨就死循环
    while (resets < rc) {
      resets++;
      hooks.onReset?.(resets, false);
    }
    if (done - lastPost > CPU_HZ / 10) {
      lastPost = done;
      hooks.onProgress?.(e.tb_cycles() / CPU_HZ);
    }
  }
  const tail = dec.decode();
  out += tail;
  if (tail) hooks.onConsole?.(tail);
  const rn = e.tb_report();
  let report = dec.decode(new Uint8Array(e.memory.buffer, e.tb_report_ptr(), rn));
  // 顺序与 tools/check.py 的 canonical_report 一致：GPIO → WS2812 → OLED → LCD → USB → I2C 应答 → PWM
  if (j.usb && e.tb_usb_report) {
    const un = e.tb_usb_report();
    report += dec.decode(new Uint8Array(e.memory.buffer, e.tb_report_ptr(), un));
  }
  if (j.i2cLog && e.tb_i2c_report) {
    const n = e.tb_i2c_report();
    report += dec.decode(new Uint8Array(e.memory.buffer, e.tb_report_ptr(), n));
  }
  if (j.pwmPin !== undefined) {
    let mn = 1, mx = 0;
    for (const [d] of trace) {
      mn = Math.min(mn, d);
      mx = Math.max(mx, d);
    }
    const freq = trace.length ? trace[trace.length - 1][1] : 0;
    report += `[tryboard] PWM GPIO${j.pwmPin}: ${trace.length} 次变化，占空比 ${mn.toFixed(3)}..${mx.toFixed(3)}，频率 ${freq.toFixed(1)}Hz\n`;
    const steps: string[] = [];
    let last = '';
    for (const [d, , t] of trace) {
      const k = d.toFixed(3);
      if (k !== last) steps.push(`${k}@${t.toFixed(3)}`);
      last = k;
    }
    report += `[tryboard] PWM GPIO${j.pwmPin} 变化 ${steps.join(' ')}\n`;
  }
  return { stdout: out, report, sim: e.tb_cycles() / CPU_HZ, error };
}
