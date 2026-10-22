// Runs firmware for N simulated seconds (no wall clock), applies inputs at exact simulated times, samples PWM like the CLI.
// Shared by web checks (verify-worker.ts) and the npm CLI without DOM / Worker, so both match native `tryboard run` / check.py.

import { chipFromId, type SimChip } from './chipid';
import { parseScript } from './checks';
import { realFetch, type RealReq } from './realfetch';
import type { WasmExports } from './wasm.gen';
import { attachI2s, attachLcdSpec, attachParts, partAction, partsTimed, type PartsDevs } from './partsdev.ts';
import { isTftPanel } from './lcdspec.ts';
import type { LcdKind } from './simmsg';

export const CPU_HZ = 160_000_000;

export type Ex = WasmExports;

export interface SimJob {
  /** Bytes (npm CLI, tests) or an already compiled Module (web, R-23: no recompile per run) */
  wasm: ArrayBuffer | Uint8Array | WebAssembly.Module;
  rom: ArrayBuffer | Uint8Array;
  flash: ArrayBuffer | Uint8Array;
  seconds: number;
  i2c: { kind: string; addr: number }[];
  env?: { temp: number; humidity: number; pressure: number };
  script?: string;
  pwmPin?: number;
  lcd?: boolean | LcdKind;
  /** AXP2101 battery at power-up (= CLI --battery) */
  battery?: { pct: number; usb: boolean };
  /** Servo signal pin and supply (= CLI --servo / --power); with a servo, always 1 ms slices like the CLI */
  servo?: number;
  power?: 'usb' | 'ext';
  /** Touch INT pin (= CLI --touch-int) */
  touchInt?: number;
  /** Core board preset (= CLI --board, M5-09b), applied before every other device */
  board?: string;
  /** Grove unit on Port A (= CLI --grove, M5-09d), right after the preset */
  grove?: string;
  /** Always 1 ms slices (= CLI --inputs): used when replaying an input log exported from a live web run */
  fixedSlice?: boolean;
  /** = CLI --usb-log: the report includes the USB virtual host state and typed keys (P2-12) */
  usb?: boolean;
  /** = CLI --i2c-log: the report includes acks per I2C address (generated checkpoint i2c_ack, U-17) */
  i2cLog?: boolean;
  /** = CLI --i2c-wire / --antenna-loss (P2-11, estimate) */
  i2cWire?: number;
  antenna?: number;
  /** Rotary encoder / HC-SR04 (= CLI --encoder A,B[,SW] / --sonar TRIG,ECHO --dist cm); attached means 1 ms slices too */
  encoder?: { a: number; b: number; sw?: number };
  sonar?: { trig: number; echo: number; cm?: number };
  /** DHT11 data GPIO (= CLI --dht11); attached means 1 ms slices too */
  dht11?: number;
  /** F-04a parts (= CLI --ds18b20 / --pir / --relay / --ldr / --spi rc522); DS18B20, PIR or relay means 1 ms slices too */
  parts?: PartsDevs;
  /** Run with the "real network" on (C-03, for checkpoints): the chip's HTTP to the internet is fetched on the spot and the replies are applied and kept in the result; the verdict needs internet and records no run ID */
  realnet?: boolean;
  /** I2S audio parts (= CLI --i2s, entries `kind[@bclk:ws:data]`) and the WAV the mic loops (= CLI --mic) */
  i2s?: string[];
  micWav?: ArrayBuffer | Uint8Array;
}

export interface SimResult {
  stdout: string;
  report: string;
  /** `[tryboard] timing-sensitive: …` line (D-03) or ''; not part of report */
  timing?: string;
  sim: number;
  /** Stopped mid-run (CPU exception etc.) */
  error?: string;
  /** Never started (broken image, missing ROM) */
  bootError?: string;
  /** Replies obtained in realnet mode (the part after netreply=, in the order applied) */
  replies?: string[];
}

export interface SimHooks {
  onProgress?: (sim: number) => void;
  /** Serial text new in each slice (lets `tryboard run` print as it goes) */
  onConsole?: (text: string) => void;
  /** Software reset number n; stopped = past 50, no more power-ups */
  onReset?: (n: number, stopped: boolean) => void;
}

const I2C_KIND: Record<string, number> = { ssd1306: 1, bme280: 2, mpu6050: 3, qmi8658: 4, cst816s: 5, ft6236: 6, cst9220: 7, axp2101: 8, pcf85063: 9, es8311: 10, es7210: 11, sh1106: 12 };

/** Which chip an image targets: find the app in the partition table (0x8000), read the ESP header chip ID; throws for chips TryBoard does not simulate */
export function imageChip(buf: ArrayBuffer | Uint8Array): SimChip {
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
  const id = b[app] === 0xe9 ? b[app + 12] | (b[app + 13] << 8) : -1;
  const chip = chipFromId(id);
  if (!chip) throw new Error(id < 0 ? 'not an ESP-IDF image (no 0xE9 header)' : `unsupported chip id ${id} in image header`);
  return chip;
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
  const instance = j.wasm instanceof WebAssembly.Module ? await WebAssembly.instantiate(j.wasm, {}) : (await WebAssembly.instantiate(u8(j.wasm), {})).instance;
  const e = instance.exports as unknown as Ex;
  const rom = u8(j.rom), flash = u8(j.flash);
  const rp = e.tb_alloc(rom.byteLength);
  new Uint8Array(e.memory.buffer, rp, rom.byteLength).set(rom);
  const fp = e.tb_alloc(flash.byteLength);
  new Uint8Array(e.memory.buffer, fp, flash.byteLength).set(flash);
  const r = e.tb_boot(rp, rom.byteLength, fp, flash.byteLength);
  const errText = () => new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.tb_error_ptr(), e.tb_error_len()));
  if (r !== 0) return { stdout: '', report: '', sim: 0, error: errText(), bootError: errText() };
  if (j.board) {
    let ok = 1;
    bytesIn(e, new TextEncoder().encode(j.board), (p, n) => void (ok = e.tb_board_preset(p, n)));
    if (ok !== 0) return { stdout: '', report: '', sim: 0, error: `--board ${j.board}: rejected`, bootError: `--board ${j.board}: rejected` };
  }
  if (j.grove) {
    let ok = 1;
    bytesIn(e, new TextEncoder().encode(j.grove), (p, n) => void (ok = e.tb_grove(p, n)));
    if (ok !== 0) return { stdout: '', report: '', sim: 0, error: `--grove ${j.grove}: rejected`, bootError: `--grove ${j.grove}: rejected` };
  }
  for (const d of j.i2c) e.tb_i2c_attach(I2C_KIND[d.kind] ?? 0, d.addr);
  // DHT11 before env so it takes the readings (CLI parses --dht11 before --env)
  if (j.dht11 !== undefined) e.tb_dht11_attach?.(j.dht11);
  const partsErr = attachParts(e, j.parts, chipFromId(e.tb_chip()) ?? undefined);
  if (partsErr) return { stdout: '', report: '', sim: 0, error: partsErr, bootError: partsErr };
  if (j.env) e.tb_env_set(j.env.temp, j.env.humidity, j.env.pressure);
  if (j.battery) e.tb_battery?.(j.battery.pct, j.battery.usb ? 1 : 0);
  if (j.lcd === 'co5300') e.tb_lcd_attach_kind?.(1);
  else if (isTftPanel(j.lcd)) {
    const err = attachLcdSpec(e, j.lcd);
    if (err) return { stdout: '', report: '', sim: 0, error: err, bootError: err };
  } else if (j.lcd) e.tb_lcd_attach?.();
  // Same order as the CLI: screen, then --i2s, then --mic
  attachI2s(e, j.i2s);
  if (j.micWav && e.tb_mic_wav) {
    const cb = e.tb_mic_wav;
    bytesIn(e, u8(j.micWav), (p, n) => void cb(p, n));
  }
  // Like the native CLI: at most 50 crash / brownout resets, the 51st stops before resetting (no reboot loop; both sides stop on the same cycle)
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
  const replies: string[] = [];
  if (j.realnet) e.tb_realnet_set?.(1);

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
      else if (act.startsWith('adc=')) e.tb_adc_mode?.(act.slice(4).trim() === 'ideal' ? 1 : 0);
      else if (act.startsWith('seed=')) e.tb_seed?.(Number(act.slice(5)) >>> 0);
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
      } else if (act.startsWith('realnet=')) e.tb_realnet_set?.(act.slice(8).trim() === '1' ? 1 : 0);
      else if (/^(net|netfault)=/.test(act)) bytesIn(e, new TextEncoder().encode(act.trim()), (p, n) => void e.tb_net_action?.(p, n));
      else if (act.startsWith('netreply=')) bytesIn(e, new TextEncoder().encode(act.slice(9).trim()), (p, n) => void e.tb_net_reply?.(p, n));
      else if (act.startsWith('phone=')) bytesIn(e, new TextEncoder().encode(act.slice(6).replaceAll('\\n', '\n')), (p, n) => void e.tb_phone_cmd?.(p, n));
      else if (act.startsWith('usbcdc=')) bytesIn(e, new TextEncoder().encode(act.slice(7).replaceAll('\\n', '\n')), (p, n) => e.tb_usb_cdc_send(p, n));
      else if (act.startsWith('imu=')) {
        // Same as CLI parse_imu: 3 numbers (attitude) or 6 (plus rates)
        const v = act.slice(4).split(',').map(Number);
        if ((v.length === 3 || v.length === 6) && v.every((x) => !Number.isNaN(x))) e.tb_imu_set?.(v[0], v[1], v[2], v[3] ?? 0, v[4] ?? 0, v[5] ?? 0);
      } else if (act.startsWith('touch=')) {
        const v = act.slice(6).split(',').map(Number);
        if (v.length === 2 && v.every((x) => !Number.isNaN(x))) e.tb_touch?.(v[0], v[1], 1);
      } else if (act === 'release') e.tb_touch?.(0, 0, 0);
      else if (act.startsWith('bat=')) {
        // Same as CLI parse_battery: pct[,usb]
        const [p, u] = act.slice(4).split(',');
        if (!Number.isNaN(Number(p)) && (u === undefined || u.trim() === 'usb')) e.tb_battery?.(Number(p), u ? 1 : 0);
      } else if (act.startsWith('pwrkey=')) e.tb_pwrkey?.(act.slice(7).trim() === 'long' ? 1 : 0);
      else if (/^(pir|lux|card|ir)=/.test(act)) partAction(e, act.trim());
      else if (act.startsWith('key=')) {
        // Same as CLI board_action: key=<name>[,1|0]
        const v = act.slice(4), c = v.lastIndexOf(','), lv = c > 0 ? v.slice(c + 1).trim() : '';
        const [name, down] = lv === '1' || lv === '0' ? [v.slice(0, c), lv === '1'] : [v, true];
        bytesIn(e, new TextEncoder().encode(name.trim()), (p, n) => void e.tb_board_key(p, n, down ? 1 : 0));
      }
      else if (act.startsWith('xz=') && e.tb_xz_cmd) {
        const cb = e.tb_xz_cmd;
        bytesIn(e, new TextEncoder().encode(act.slice(3)), (p, n) => void cb(p, n));
      }
      else if ((act.startsWith('ble=') || act.startsWith('pc=')) && e.tb_ble_cmd) {
        // pc=… goes to the same phone channel whole, like CLI main.rs
        const cb = e.tb_ble_cmd;
        bytesIn(e, new TextEncoder().encode(act.startsWith('pc=') ? act : act.slice(4)), (p, n) => void cb(p, n));
      }
    }
    if (j.pwmPin !== undefined) {
      const d = e.tb_pin_pwm(j.pwmPin);
      if (d >= 0) {
        const f = e.tb_pin_pwm_freq(j.pwmPin);
        const l = trace[trace.length - 1];
        if (!l || Math.abs(f32(l[0] - d)) > f32(0.004) || Math.abs(f32(l[1] - f)) > f32(0.5)) trace.push([d, f, now]);
      }
    }
    // Real network: requests the chip sent in the previous slice are fetched on the spot (simulated time waits at the slice boundary), and the run continues only after the replies are applied
    if (j.realnet && e.tb_net_outbox && e.tb_phone_json_ptr) {
      const n = e.tb_net_outbox();
      if (n) {
        const reqs = JSON.parse(new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.tb_phone_json_ptr(), n))) as RealReq[];
        for (const r of reqs) {
          const reply = (await realFetch(r)).action.slice('netreply='.length);
          bytesIn(e, new TextEncoder().encode(reply), (p, m) => void e.tb_net_reply?.(p, m));
          replies.push(reply);
        }
      }
    }
    const slice = si >= script.length && j.pwmPin === undefined && !j.fixedSlice && !j.realnet && j.servo === undefined && !j.encoder && !j.sonar && j.dht11 === undefined && !partsTimed(j.parts) ? CPU_HZ / 100 : CPU_HZ / 1000;
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
    // Not hooks.onReset?.(++resets): without a callback the optional call skips evaluating its argument and this loops forever
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
  // Same order as canonical_report in tools/check.py: GPIO -> WS2812 -> OLED -> LCD -> USB -> I2C acks -> PWM
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
    report += `[tryboard] PWM GPIO${j.pwmPin}: ${trace.length} changes, duty ${mn.toFixed(3)}..${mx.toFixed(3)}, freq ${freq.toFixed(1)}Hz\n`;
    const steps: string[] = [];
    let last = '';
    for (const [d, , t] of trace) {
      const k = d.toFixed(3);
      if (k !== last) steps.push(`${k}@${t.toFixed(3)}`);
      last = k;
    }
    report += `[tryboard] PWM GPIO${j.pwmPin} steps ${steps.join(' ')}\n`;
  }
  // The timing line (D-03) only feeds per-row trust (D-05): kept out of report so fingerprints match check.py
  let timing = '';
  if (e.tb_timing_report) {
    const tn = e.tb_timing_report();
    try {
      timing = (JSON.parse(dec.decode(new Uint8Array(e.memory.buffer, e.tb_report_ptr(), tn))) as { line?: string }).line ?? '';
    } catch {
      timing = '';
    }
  }
  return { stdout: out, report, timing, sim: e.tb_cycles() / CPU_HZ, error, ...(j.realnet ? { replies } : {}) };
}
