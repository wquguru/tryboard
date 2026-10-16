// 关卡验收：在独立 Worker 里按模拟时间（不看墙钟）把固件跑完规定秒数，输入脚本在精确的模拟时刻施加。
// 时间片、脚本施加、PWM 采样的规则照搬命令行 `tryboard run`，所以结论和指纹与 tools/check.py 一致。

import { parseScript } from './checks';

const CPU_HZ = 160_000_000;

interface Ex {
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
}

export interface VerifyJob {
  wasm: ArrayBuffer;
  rom: ArrayBuffer;
  flash: ArrayBuffer;
  seconds: number;
  i2c: { kind: string; addr: number }[];
  env?: { temp: number; humidity: number; pressure: number };
  script?: string;
  pwmPin?: number;
  lcd?: boolean;
}

export type VerifyMsg =
  | { type: 'progress'; sim: number }
  | { type: 'done'; stdout: string; report: string; sim: number; error?: string };

const I2C_KIND: Record<string, number> = { ssd1306: 1, bme280: 2 };
const dec = new TextDecoder();
const post = (m: VerifyMsg) => (self as unknown as Worker).postMessage(m);

function bytesIn(e: Ex, b: Uint8Array, f: (p: number, n: number) => void) {
  const p = e.tb_alloc(b.length);
  new Uint8Array(e.memory.buffer, p, b.length).set(b);
  f(p, b.length);
  e.tb_free(p, b.length);
}

self.onmessage = async (ev: MessageEvent<VerifyJob>) => {
  const j = ev.data;
  const { instance } = await WebAssembly.instantiate(j.wasm, {});
  const e = instance.exports as unknown as Ex;
  const rp = e.tb_alloc(j.rom.byteLength);
  new Uint8Array(e.memory.buffer, rp, j.rom.byteLength).set(new Uint8Array(j.rom));
  const fp = e.tb_alloc(j.flash.byteLength);
  new Uint8Array(e.memory.buffer, fp, j.flash.byteLength).set(new Uint8Array(j.flash));
  const r = e.tb_boot(rp, j.rom.byteLength, fp, j.flash.byteLength);
  const errText = () => new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.tb_error_ptr(), e.tb_error_len()));
  if (r !== 0) {
    post({ type: 'done', stdout: '', report: '', sim: 0, error: errText() });
    return;
  }
  for (const d of j.i2c) e.tb_i2c_attach(I2C_KIND[d.kind] ?? 0, d.addr);
  if (j.env) e.tb_env_set(j.env.temp, j.env.humidity, j.env.pressure);
  if (j.lcd) e.tb_lcd_attach?.();

  const script = parseScript(j.script);
  let si = 0;
  const total = Math.floor(j.seconds * CPU_HZ);
  let done = 0;
  let out = '';
  const trace: [number, number, number][] = [];
  const f32 = Math.fround;
  let error: string | undefined;
  let lastPost = 0;
  while (done < total) {
    const now = e.tb_cycles() / CPU_HZ;
    while (si < script.length && script[si].t <= now) {
      const act = script[si++].act;
      let m: RegExpMatchArray | null;
      if ((m = act.match(/^gpio(\d+)=(.*)$/))) e.tb_gpio_drive(Number(m[1]) || 0, m[2] === 'z' ? -1 : m[2] === '1' ? 1 : 0);
      else if ((m = act.match(/^mv(\d+)=(.*)$/))) e.tb_analog_set(Number(m[1]), Number(m[2]));
      else if (act.startsWith('uart=')) bytesIn(e, new TextEncoder().encode(act.slice(5).replaceAll('\\n', '\n')), (p, n) => e.tb_uart_push(p, n));
      else if (act.startsWith('usbcdc=')) bytesIn(e, new TextEncoder().encode(act.slice(7).replaceAll('\\n', '\n')), (p, n) => e.tb_usb_cdc_send(p, n));
    }
    if (j.pwmPin !== undefined) {
      const d = e.tb_pin_pwm(j.pwmPin);
      if (d >= 0) {
        const f = e.tb_pin_pwm_freq(j.pwmPin);
        const l = trace[trace.length - 1];
        if (!l || Math.abs(f32(l[0] - d)) > f32(0.004) || Math.abs(f32(l[1] - f)) > f32(0.5)) trace.push([d, f, now]);
      }
    }
    const slice = si >= script.length && j.pwmPin === undefined ? CPU_HZ / 100 : CPU_HZ / 1000;
    const before = e.tb_cycles();
    const stop = e.tb_run(Math.min(slice, total - done));
    done += e.tb_cycles() - before;
    const n = e.tb_console_len();
    if (n) out += dec.decode(new Uint8Array(e.memory.buffer, e.tb_console_ptr(), n), { stream: true });
    e.tb_console_clear();
    if (stop !== 0) {
      error = errText();
      break;
    }
    if (done - lastPost > CPU_HZ / 10) {
      lastPost = done;
      post({ type: 'progress', sim: e.tb_cycles() / CPU_HZ });
    }
  }
  out += dec.decode();
  const rn = e.tb_report();
  let report = dec.decode(new Uint8Array(e.memory.buffer, e.tb_report_ptr(), rn));
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
  post({ type: 'done', stdout: out, report, sim: e.tb_cycles() / CPU_HZ, error });
};
