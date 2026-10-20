// The simulator runs in a Worker at real-time pace, posting console output and GPIO state to the main thread.
// Fixed 1 ms slices (same as CLI `--inputs` replay); inputs apply between slices and are logged on sim time, so the CLI replays cycle-exactly.
import { action, cyclesToMs, roundImu, type InputAction, type InputEvent, type InputLog } from './inputlog';
import { chipFromId, NPINS as CHIP_NPINS, RGB_GPIO, type SimChip } from './chipid';
import { realFetch, type RealReq } from './realfetch';
import { useWorkerLocale, type Locale } from './i18n';
import type { WasmExports } from './wasm.gen';
import type { PowerMode, ElecFrame, Env, EncoderSpec, SonarSpec, PinDevFrame, VcdState, ToWorker, AdcSamples, Harness, PwmEvent, PcmBlock, AudioFrame, FromWorker, Snapshot } from './simmsg';

const CPU_HZ = 160_000_000;

type Exports = WasmExports;

let ex: Exports | null = null;
// Full serial since power-up (the fingerprint needs every byte from boot); beyond 4 MB we stop storing and mark it too long.
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
let power: PowerMode = 'usb';
let resetsSeen = 0;

function elecFrame(e: Exports): ElecFrame | undefined {
  if (!e.tb_elec_v) return undefined;
  const a = e.tb_servo_angle();
  return {
    v5: e.tb_elec_v(1),
    v3v3: e.tb_elec_v(2),
    vServo: e.tb_elec_v(3),
    vExt: e.tb_elec_v(4),
    iUsb: e.tb_elec_i(0),
    iExt: e.tb_elec_i(1),
    iServo: e.tb_elec_i(2),
    i3v3: e.tb_elec_i(3),
    iAmp: e.tb_elec_i(5),
    min5: e.tb_elec_stat(0),
    min3v3: e.tb_elec_stat(1),
    peakUsb: e.tb_elec_stat(3),
    peakServo: e.tb_elec_stat(5),
    resets: e.tb_elec_stat(7),
    held: e.tb_elec_stat(8) === 1,
    servoAngle: Number.isNaN(a) ? null : a,
    power,
  };
}
/** Newly seen brown-out reset times. */
function takeBrownouts(e: Exports): number[] | undefined {
  if (!e.tb_elec_stat) return undefined;
  const n = e.tb_elec_stat(7);
  if (n <= resetsSeen) return undefined;
  const out: number[] = [];
  for (let i = resetsSeen; i < n; i++) out.push(e.tb_elec_brownout_t(i));
  resetsSeen = n;
  return out;
}
let hasPinDevs = false;
function pinDevFrame(e: Exports): PinDevFrame | undefined {
  if (!hasPinDevs) return undefined;
  const n = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? null : x);
  return { encPos: n(e.tb_encoder_pos?.()), pcnt: n(e.tb_pcnt_count?.(0)), pings: n(e.tb_sonar_stat?.(0)), echoUs: n(e.tb_sonar_stat?.(2)), dhtReads: n(e.tb_dht11_stat?.(0)), dhtShort: n(e.tb_dht11_stat?.(1)) };
}
let simAnchor = 0; // sim cycle when timing started
let wallAnchor = 0;
const decoder = new TextDecoder();
/** On-board WS2812 pin (C3 GPIO8, S3 GPIO48) and pin count, set per chip after boot. */
let LED_PIN = 8;
let NPINS = 22;
let simChip: SimChip = 'esp32c3';
let lastFrames = -1;

/** [r,g,b] per LED when the on-board strip has a new frame, else undefined (saves message size). */
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
/** External strips: pins other than the on-board LED that saw WS2812 frames, read when the frame count changes (P2-09 lamp). */
let stripFrames = new Map<number, number>();
function strips(e: Exports): Record<number, number[][]> | undefined {
  let out: Record<number, number[][]> | undefined;
  for (let p = 0; p < NPINS; p++) {
    if (p === LED_PIN) continue;
    const f = e.tb_ws2812_frames(p);
    if (!f || f === stripFrames.get(p)) continue;
    stripFrames.set(p, f);
    const n = e.tb_ws2812_fetch(p);
    const b = new Uint8Array(e.memory.buffer, e.tb_ws2812_ptr(), n * 3);
    const leds: number[][] = [];
    for (let i = 0; i < n; i++) leds.push([b[i * 3], b[i * 3 + 1], b[i * 3 + 2]]);
    (out ??= {})[p] = leds;
  }
  return out;
}
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

/** Stop on a core trap and tell the page; the panic hook's message says where in the simulator it broke. */
function crash(err: unknown) {
  running = false;
  loopGen++;
  let msg = '';
  try {
    if (ex?.tb_panic_len?.()) msg = decoder.decode(new Uint8Array(ex.memory.buffer, ex.tb_panic_ptr!(), ex.tb_panic_len()).slice());
  } catch {}
  ex = null;
  post({ type: 'crash', message: msg || String(err) });
}

function errorText(e: Exports) {
  return decoder.decode(new Uint8Array(e.memory.buffer, e.tb_error_ptr(), e.tb_error_len()));
}

function copyIn(e: Exports, data: ArrayBuffer) {
  const p = e.tb_alloc(data.byteLength);
  new Uint8Array(e.memory.buffer, p, data.byteLength).set(new Uint8Array(data));
  return p;
}

/** PWM duty per pin (-1 = no PWM). */
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

// ---- Input log: external inputs applied since power-up, stamped with sim time when applied
let inputLog: InputLog = { version: 1, i2c: [], lcd: false, events: [] };
function record(e: Exports, ev: InputAction) {
  inputLog.events.push({ tMs: cyclesToMs(e.tb_cycles()), ...ev } as InputEvent);
}

// ---- PWM change sampling (buzzer): checked between slices, 1 ms resolution
let watchPins: number[] = [];
let adcPins: number[] = [];

function adcFrame(e: Exports): Record<number, AdcSamples> | undefined {
  if (!e.tb_adc_fetch || !e.tb_adc_ptr || !adcPins.length) return undefined;
  const out: Record<number, AdcSamples> = {};
  for (const pin of adcPins) {
    const n = e.tb_adc_fetch(pin);
    const v = new Int32Array(e.memory.buffer, e.tb_adc_ptr(), n * 2);
    const raw: number[] = [];
    const mv: number[] = [];
    for (let i = 0; i < n; i++) {
      raw.push(v[2 * i]);
      mv.push(v[2 * i + 1]);
    }
    out[pin] = { raw, mv };
  }
  return out;
}
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

// ---- Logic analyser events: taken from the core after each batch, sent with the tick (a reset first on power-up / rewind)
let ioLo = 0;
let ioHi = 0;
let ioChunks: Uint8Array[] = [];
let ioBytes = 0;
// Task switches are taken and sent together with analyser events (1 ms slices, same as CLI --trace-tasks).
let taskChunks: Uint8Array[] = [];
let taskBytes = 0;
function drainTasks(e: Exports) {
  if (!e.tb_tasks_take) return;
  const n = e.tb_tasks_take();
  if (!n) return;
  const b = new Uint8Array(new Uint8Array(e.memory.buffer, e.tb_tasks_ptr!(), n * 16));
  taskChunks.push(b);
  taskBytes += b.byteLength;
}
function flushTasks(e: Exports, reset: boolean) {
  drainTasks(e);
  if (!e.tb_tasks_json || (!reset && !taskBytes)) return;
  const data = new Uint8Array(taskBytes);
  let o = 0;
  for (const c of taskChunks) {
    data.set(c, o);
    o += c.byteLength;
  }
  taskChunks = [];
  taskBytes = 0;
  const n = e.tb_tasks_json();
  const table = decoder.decode(new Uint8Array(e.memory.buffer, e.tb_tasks_json_ptr!(), n));
  (self as unknown as Worker).postMessage({ type: 'tasks', reset, data, table, chip: simChip } satisfies FromWorker, [data.buffer]);
}
function drainIo(e: Exports) {
  drainTasks(e);
  if (!e.tb_io_take) return;
  const n = e.tb_io_take();
  if (!n) return;
  const b = new Uint8Array(new Uint8Array(e.memory.buffer, e.tb_io_ptr!(), n * 16));
  ioChunks.push(b);
  ioBytes += b.byteLength;
}
function flushIo(e: Exports, reset = false) {
  drainIo(e);
  flushTasks(e, reset);
  if (!reset && !ioBytes) return;
  const data = new Uint8Array(ioBytes);
  let o = 0;
  for (const c of ioChunks) {
    data.set(c, o);
    o += c.byteLength;
  }
  ioChunks = [];
  ioBytes = 0;
  (self as unknown as Worker).postMessage({ type: 'io', reset, data, dropped: e.tb_io_dropped?.() ?? 0 } satisfies FromWorker, [data.buffer]);
}

// ---- I2S audio: speaker PCM taken after each batch and sent with the tick; the main thread switches the mic source
let hasAudio = false;
let pcmOut: PcmBlock[] = [];
function drainPcm(e: Exports) {
  if (!hasAudio || !e.tb_audio_take) return;
  const n = e.tb_audio_take();
  if (!n) return;
  const dv = new DataView(e.memory.buffer, e.tb_audio_ptr!(), e.tb_audio_len!());
  let o = 0;
  for (let i = 0; i < n; i++) {
    const t = dv.getFloat64(o, true);
    const rate = dv.getFloat32(o + 8, true);
    const len = dv.getUint32(o + 12, true);
    const data = new Int16Array(len);
    for (let k = 0; k < len; k++) data[k] = dv.getInt16(o + 16 + 2 * k, true);
    o += 16 + 2 * len + (len % 2) * 2;
    pcmOut.push({ t, rate, data });
  }
}
function flushPcm() {
  if (!pcmOut.length) return;
  const blocks = pcmOut;
  pcmOut = [];
  (self as unknown as Worker).postMessage({ type: 'pcm', blocks } satisfies FromWorker, blocks.map((b) => b.data.buffer));
}
function audioFrame(e: Exports): AudioFrame | undefined {
  if (!hasAudio || !e.tb_audio_stat) return undefined;
  const v = (k: number) => {
    const x = e.tb_audio_stat!(k);
    return Number.isNaN(x) ? 0 : x;
  };
  return { rate: v(0), frames: v(1), rms: v(2), freq: v(3), peak: v(4), micFrames: v(5) };
}
function setMic(e: Exports, source: 'wav' | 'silence' | 'live', wav?: ArrayBuffer) {
  if (source === 'wav' && wav && e.tb_mic_wav) {
    const p = copyIn(e, wav);
    e.tb_mic_wav(p, wav.byteLength);
    e.tb_free(p, wav.byteLength);
  } else if (source !== 'live') e.tb_mic_silence?.();
}

let ratioWall = 0;
let ratioSim = 0;
let lastRatio = 1;
// Hidden tab: UI frames fold into one post per HIDDEN_POST_MS; console, PWM events and brownouts accumulate meanwhile
const HIDDEN_POST_MS = 250;
let pageHidden = false;
let uiPosted = 0;
let heldConsole = '';

function loop(gen = loopGen) {
  try {
    loopSlice(gen);
  } catch (err) {
    crash(err);
  }
}

function loopSlice(gen: number) {
  if (!ex || !running || gen !== loopGen) return;
  const e = ex;
  const now = performance.now();
  // Goal: sim time catches up with wall clock × speed; at most 20 ms wall per round so messages are not starved.
  const targetCycles = simAnchor + ((now - wallAnchor) / 1000) * CPU_HZ * speed;
  let behind = targetCycles - e.tb_cycles();
  const t0 = performance.now();
  const startCycles = e.tb_cycles();
  let stop = 0;
  while (behind > 0 && performance.now() - t0 < 20) {
    // Fixed 1 ms slices (not 'whatever is left'): S3 dual-core interleaving depends on slice starts, so slicing like the CLI keeps replay exact.
    stop = e.tb_run(CPU_HZ / 1000);
    if (watchPins.length) samplePwm(e);
    drainIo(e);
    drainPcm(e);
    if (stop !== 0) break;
    behind = targetCycles - e.tb_cycles();
  }
  // Falling behind real time: reset the anchor (do not chase the debt) and report the actual speed.
  if (behind > CPU_HZ * 0.1) {
    simAnchor = e.tb_cycles();
    wallAnchor = performance.now();
  }
  // Speed = sim time advanced over a wall-clock window / that window.
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
  const ui = !pageHidden || stop !== 0 || now - uiPosted >= HIDDEN_POST_MS;
  if (!ui) heldConsole += text;
  else {
    uiPosted = now;
    post({
      type: 'tick',
      console: heldConsole + text,
      leds: leds(e),
      strips: strips(e),
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
      elec: elecFrame(e),
      brownouts: takeBrownouts(e),
      pins: pinDevFrame(e),
      audio: audioFrame(e),
      adc: adcFrame(e),
    });
    heldConsole = '';
  }
  flushPcm();
  flushIo(e);
  if (ui) postOled(e);
  if (ui) postLcd(e);
  postUsb(e);
  postBle(e);
  postNet(e);
  pumpNet(e);
  if (ui) postHarness(e);
  if (ui) postTiming(e);
  if (ui) postVcd(e);
  if (stop !== 0) {
    running = false;
    post({ type: 'stopped', reason: errorText(e) });
    return;
  }
  // Behind schedule: continue at once. setTimeout is clamped to ≥4 ms in workers too, costing ~20% on full-load firmware;
  // MessageChannel messages are not clamped, and input messages still interleave between slices as usual.
  if (behind > 0) yieldPort.postMessage(loopGen);
  else setTimeout(loop, 4, loopGen);
}

/** Bumped so stale schedules (timeouts / messages queued before pause) are void; resuming right away never runs two loops. */
let loopGen = 0;
const yieldChannel = new MessageChannel();
const yieldPort = yieldChannel.port2;
yieldChannel.port1.onmessage = (ev: MessageEvent<number>) => loop(ev.data);

let oledVersion = 0;
/** Send the OLED only on change (128×64 bytes, ownership transferred instead of copied twice). */
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
/** Round LCD 240×240×4 = 230 KB: only on change, at most 30 fps. */
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

let bleState = 0;
let bleSeq = -1;
let bleFrom = 0;
let bleReset = true;
let bleLast = 0;
/** Send when the air log grows or state changes; while connected also every 250 ms (notify curves, RSSI need no new log). */
function postBle(e: Exports, force = false) {
  if (!e.tb_ble_state || !e.tb_ble_json || !e.tb_ble_json_ptr || !e.tb_ble_seq) return;
  const st = e.tb_ble_state();
  const seq = e.tb_ble_seq();
  const now = performance.now();
  if (!force && st === bleState && seq === bleSeq && (st !== 1 || now - bleLast < 250)) return;
  if (st === 0 && bleState === 0 && !bleReset) return;
  bleState = st;
  bleSeq = seq;
  bleLast = now;
  const n = st === 0 ? 0 : e.tb_ble_json(bleFrom);
  const json = n ? decoder.decode(new Uint8Array(e.memory.buffer, e.tb_ble_json_ptr(), n)) : '';
  post({ type: 'ble', state: st, json, ...(bleReset ? { reset: true } : {}) });
  bleReset = false;
  bleFrom = seq;
}

// Network tab: shown only after the firmware sent Wi-Fi frames; the phone / request log are each fetched only when their version changed
// null: nothing sent since the new power-on, so the first one is always sent (the page must hide the tab when the firmware stops using Wi-Fi)
let netUsed: boolean | null = null;
let phoneVersion = 0;
let netVersion = 0;
function postNet(e: Exports) {
  if (!e.tb_wifi_used) return;
  const used = e.tb_wifi_used() !== 0;
  const pv = e.tb_phone_version?.() ?? 0;
  const nv = e.tb_net_version?.() ?? 0;
  if (used === netUsed && pv === phoneVersion && nv === netVersion) return;
  const m: Extract<FromWorker, { type: 'net' }> = { type: 'net', used };
  if (pv !== phoneVersion && e.tb_phone_json && e.tb_phone_json_ptr) {
    const n = e.tb_phone_json();
    m.phone = decoder.decode(new Uint8Array(e.memory.buffer, e.tb_phone_json_ptr(), n));
  }
  if (nv !== netVersion && e.tb_net_json && e.tb_phone_json_ptr) {
    const n = e.tb_net_json();
    m.rows = decoder.decode(new Uint8Array(e.memory.buffer, e.tb_phone_json_ptr(), n));
    // Real-network replies recorded this power-on (the counter next to "Save replies, replay offline")
    let replies = 0;
    let replyBytes = 0;
    for (const x of inputLog.events)
      if (x.kind === 'netreply') {
        replies++;
        replyBytes += x.reply.length;
      }
    m.replies = replies;
    m.replyBytes = replyBytes;
  }
  netUsed = used;
  phoneVersion = pv;
  netVersion = nv;
  post(m);
}

// ---- Real network (C-03): the switch lives on the main thread and survives power-ons; each power-on bumps a generation so late fetch results are not applied to the new run
let realnetOn = false;
let bootGen = 0;
/** Replies from the original log during a rewind replay (by request id): requests not reached mid-replay prefer the recorded reply and never go online */
let replyCache = new Map<number, string>();
function replyId(reply: string) {
  return Number(reply.slice(0, reply.indexOf(',')));
}
/** Take the core outbox: recorded replies are applied directly; only with the real network on is a request really fetched. Ids in done were already answered (rewind replay), skip them */
function pumpNet(e: Exports, done?: Set<number>) {
  if (!e.tb_net_outbox || !e.tb_phone_json_ptr) return;
  const n = e.tb_net_outbox();
  if (!n) return;
  const reqs = JSON.parse(decoder.decode(new Uint8Array(e.memory.buffer, e.tb_phone_json_ptr(), n))) as RealReq[];
  for (const r of reqs) {
    if (done?.has(r.id)) continue;
    const cached = replyCache.get(r.id);
    if (cached !== undefined) {
      apply(e, { kind: 'netreply', reply: cached });
      continue;
    }
    if (!realnetOn) continue;
    const gen = bootGen;
    void realFetch(r).then((res) => {
      if (gen !== bootGen || !ex) return;
      apply(ex, { kind: 'netreply', reply: res.action.slice('netreply='.length) });
      postNet(ex);
    });
  }
}

let harnessText = '';
function postHarness(e: Exports, force = false) {
  if (!e.tb_harness_report) return;
  const n = e.tb_harness_report();
  const t = decoder.decode(new Uint8Array(e.memory.buffer, e.tb_report_ptr(), n));
  if (t === harnessText && !force) return;
  harnessText = t;
  post({ type: 'harness', text: t });
}

let timingText = '';
function postTiming(e: Exports) {
  if (!e.tb_timing_report) return;
  const n = e.tb_timing_report();
  const t = decoder.decode(new Uint8Array(e.memory.buffer, e.tb_report_ptr(), n));
  if (t === timingText) return;
  timingText = t;
  post({ type: 'timing', json: t });
}

let vcdKey = '';
function vcdState(e: Exports): VcdState | null {
  const edges = e.tb_vcd_stat?.(0) ?? NaN;
  if (Number.isNaN(edges)) return null;
  const w = (i: number) => {
    const v = e.tb_vcd_stat!(i);
    return Number.isNaN(v) ? null : v;
  };
  return { t0: w(2), t1: w(3), edges, dropped: e.tb_vcd_stat!(1) };
}
function postVcd(e: Exports) {
  const st = vcdState(e);
  const k = JSON.stringify(st);
  if (k === vcdKey) return;
  vcdKey = k;
  post({ type: 'vcd', state: st });
}

const I2C_KIND: Record<string, number> = { ssd1306: 1, bme280: 2, mpu6050: 3, qmi8658: 4, cst816s: 5 };

function postPaused(e: Exports) {
  post({ type: 'tick', console: '', leds: leds(e), strips: strips(e), gpio: e.tb_gpio_level(), enable: e.tb_gpio_enable(), gpioHi: e.tb_gpio_level_hi(), enableHi: e.tb_gpio_enable_hi(), pwm: pwmAll(e), pwmFreq: pwmFreqAll(e), pwmEvents: takePwmEvents(), simSeconds: e.tb_cycles() / CPU_HZ, ratio: 0, running, elec: elecFrame(e), brownouts: takeBrownouts(e), pins: pinDevFrame(e), adc: adcFrame(e) });
}

/** Boot fields; locale exists so any human text the worker makes follows the page (core errors are English already). */
type BootMsg = { wasm: WebAssembly.Module; rom?: ArrayBuffer; romId: number; flash?: ArrayBuffer; flashId: number; i2c?: { kind: string; addr: number }[]; env?: Env; lcd?: boolean; servo?: number; power?: PowerMode; encoder?: EncoderSpec; sonar?: SonarSpec; dht11?: number; touchInt?: number; i2s?: string[]; micWav?: ArrayBuffer; micName?: string; harness?: Harness; realnet?: boolean; locale?: Locale };
const I2S_KIND: Record<string, number> = { max98357a: 0, inmp441: 1 };
// ROM / firmware bytes by main-thread id (R-23): sent once, then every boot / seek copies them into a fresh instance.
// ROMs are one per chip; firmware keeps only the latest (live.ts resends bytes whenever the id changes).
const roms = new Map<number, ArrayBuffer>();
let fw: { id: number; bytes: ArrayBuffer } | null = null;
function cached(m: BootMsg) {
  if (m.rom) roms.set(m.romId, m.rom);
  if (m.flash) fw = { id: m.flashId, bytes: m.flash };
  const rom = roms.get(m.romId);
  if (!rom || fw?.id !== m.flashId) throw new Error(`worker is missing bytes for rom ${m.romId} / firmware ${m.flashId}`);
  return { rom, flash: fw.bytes };
}
/** Power-up: instantiate wasm, attach devices, set the environment, start a fresh input log. */
async function bootWasm(m: BootMsg): Promise<Exports | null> {
  // A fresh instance every time (seek semantics); only the compiled module and the source bytes are reused
  const instance = await WebAssembly.instantiate(m.wasm, {});
  const e = instance.exports as unknown as Exports;
  const { rom, flash } = cached(m);
  const rp = copyIn(e, rom);
  const fp = copyIn(e, flash);
  const r = e.tb_boot(rp, rom.byteLength, fp, flash.byteLength);
  e.tb_free(rp, rom.byteLength);
  e.tb_free(fp, flash.byteLength);
  if (r !== 0) {
    post({ type: 'error', message: errorText(e) });
    return null;
  }
  const chip = chipFromId(e.tb_chip());
  if (!chip) {
    post({ type: 'error', message: `unsupported chip id ${e.tb_chip()}` });
    return null;
  }
  simChip = chip;
  for (const d of m.i2c ?? []) e.tb_i2c_attach(I2C_KIND[d.kind] ?? 0, d.addr);
  if (m.env) e.tb_env_set(m.env.temp, m.env.humidity, m.env.pressure);
  if (m.lcd && e.tb_lcd_attach) e.tb_lcd_attach();
  if (m.touchInt !== undefined) e.tb_touch_int?.(m.touchInt);
  hasAudio = false;
  pcmOut = [];
  for (const k of m.i2s ?? []) if (e.tb_i2s_attach && I2S_KIND[k] !== undefined && e.tb_i2s_attach(I2S_KIND[k]) === 0) hasAudio = true;
  if (m.micWav) setMic(e, 'wav', m.micWav);
  // Supply network: servo attached, power source (state at power-up; later switches go through power messages and the log)
  power = m.power ?? 'usb';
  if (e.tb_servo_attach && m.servo !== undefined) e.tb_servo_attach(m.servo);
  e.tb_power_set?.(power === 'ext' ? 1 : 0);
  resetsSeen = 0;
  // Pin devices (encoder / ultrasonic) attach at power-up; the initial ultrasonic distance is logged as a dist input.
  if (m.encoder && e.tb_encoder_attach) e.tb_encoder_attach(m.encoder.a, m.encoder.b, m.encoder.sw ?? -1);
  if (m.sonar && e.tb_sonar_attach) e.tb_sonar_attach(m.sonar.trig, m.sonar.echo);
  // DHT11 takes readings from env: set it again once attached (the CLI also parses --dht11 before --env)
  if (m.dht11 !== undefined) e.tb_dht11_attach?.(m.dht11);
  if (m.env && m.dht11 !== undefined) e.tb_env_set(m.env.temp, m.env.humidity, m.env.pressure);
  hasPinDevs = !!(m.encoder || m.sonar || m.dht11 !== undefined);
  timingText = '\u0000';
  vcdKey = '';
  e.tb_io_watch?.(ioLo, ioHi);
  e.tb_tasks_enable?.(1 << 16);
  ioChunks = [];
  ioBytes = 0;
  taskChunks = [];
  taskBytes = 0;
  flushIo(e, true);
  inputLog = { version: 1, chip: simChip, i2c: [...(m.i2c ?? [])], lcd: !!m.lcd, ...(m.servo !== undefined ? { servo: m.servo, power } : {}), ...(m.encoder ? { encoder: { ...m.encoder } } : {}), ...(m.sonar ? { sonar: { trig: m.sonar.trig, echo: m.sonar.echo } } : {}), ...(m.dht11 !== undefined ? { dht11: m.dht11 } : {}), ...(m.touchInt !== undefined ? { touchInt: m.touchInt } : {}), ...(m.i2s?.length ? { i2s: [...m.i2s] } : {}), ...(m.micWav && m.micName ? { mic: m.micName } : {}), events: [] };
  record(e, { kind: 'power', on: true });
  if (m.env) record(e, { kind: 'env', temp: m.env.temp, humidity: m.env.humidity, pressure: m.env.pressure });
  // Harness applies at power-up and is logged (replay / rewind apply it at cycle 0, same as CLI --i2c-wire).
  if (m.harness?.i2cWire !== undefined) apply(e, { kind: 'i2cwire', cm: m.harness.i2cWire });
  if (m.harness?.antenna !== undefined) apply(e, { kind: 'antenna', db: m.harness.antenna });
  harnessText = '\u0000';
  // On rewind replay cm is NaN: the initial distance is the dist entry at time 0, applied by seekTo.
  if (m.sonar && Number.isFinite(m.sonar.cm)) apply(e, { kind: 'dist', cm: m.sonar.cm });
  pwmLast = new Map();
  pwmEvents = [];
  bootStdout = '';
  stdoutTruncated = false;
  ex = e;
  // ESP32-DevKitC has no on-board RGB: pass a nonexistent pin so GPIO2 stays an ordinary pin.
  LED_PIN = RGB_GPIO[chip] ?? -1;
  NPINS = CHIP_NPINS[chip];
  lastFrames = -1;
  stripFrames = new Map();
  oledVersion = 0;
  lcdVersion = 0;
  usbVersion = -1;
  bleState = 0;
  bleSeq = -1;
  bleFrom = 0;
  bleReset = true;
  // New power-on: phone / request log start empty (send an empty one so the page clears the previous run)
  netUsed = null;
  phoneVersion = -1;
  netVersion = -1;
  bootGen++;
  replyCache = new Map();
  return e;
}

/** Apply one input (live messages and rewind replay share this; the logged time is the sim time of application). */
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
    case 'ble': {
      if (!e.tb_ble_cmd) return;
      const b = new TextEncoder().encode(ev.cmd);
      const p = e.tb_alloc(b.length);
      new Uint8Array(e.memory.buffer, p, b.length).set(b);
      const r = e.tb_ble_cmd(p, b.length);
      e.tb_free(p, b.length);
      // Refused commands (connect while not advertising, missing handle...) are not logged: the CLI refuses them too on replay.
      if (r !== 0) {
        post({ type: 'ble', state: e.tb_ble_state?.() ?? 0, json: '', cmdError: errorText(e) });
        return;
      }
      break;
    }
    case 'supply':
      power = ev.mode;
      e.tb_power_set?.(ev.mode === 'ext' ? 1 : 0);
      break;
    case 'i2cwire':
      e.tb_i2c_wire?.(ev.cm);
      break;
    case 'antenna':
      e.tb_antenna_loss?.(ev.db);
      break;
    case 'adc':
      if (!e.tb_adc_mode) return;
      e.tb_adc_mode(ev.ideal ? 1 : 0);
      break;
    case 'seed':
      if (!e.tb_seed) return;
      ev = { kind: 'seed', seed: ev.seed >>> 0 };
      e.tb_seed(ev.seed);
      break;
    case 'realnet':
      if (!e.tb_realnet_set) return;
      e.tb_realnet_set(ev.on ? 1 : 0);
      break;
    case 'net':
    case 'netfault': {
      if (!e.tb_net_action) return;
      const b = new TextEncoder().encode(action({ tMs: 0, ...ev } as InputEvent) ?? '');
      const p = e.tb_alloc(b.length);
      new Uint8Array(e.memory.buffer, p, b.length).set(b);
      const bad = e.tb_net_action(p, b.length);
      e.tb_free(p, b.length);
      // Unknown presets / faults stay out of the log (the CLI refuses them too)
      if (bad) return;
      break;
    }
    case 'netreply': {
      if (!e.tb_net_reply) return;
      const b = new TextEncoder().encode(ev.reply);
      const p = e.tb_alloc(b.length);
      new Uint8Array(e.memory.buffer, p, b.length).set(b);
      const bad = e.tb_net_reply(p, b.length);
      e.tb_free(p, b.length);
      if (bad) return;
      break;
    }
    case 'phone': {
      if (!e.tb_phone_cmd) return;
      const b = new TextEncoder().encode(ev.cmd);
      const p = e.tb_alloc(b.length);
      new Uint8Array(e.memory.buffer, p, b.length).set(b);
      const bad = e.tb_phone_cmd(p, b.length);
      e.tb_free(p, b.length);
      // Actions it does not recognise stay out of the log (the CLI would not recognise them on replay either)
      if (bad) return;
      break;
    }
    case 'enc':
      e.tb_encoder_turn?.(ev.steps);
      break;
    case 'encsw':
      e.tb_encoder_press?.(ev.down ? 1 : 0);
      break;
    case 'dist':
      // Exported scripts keep two decimals: round the applied value to 0.01 cm so replay matches cycle for cycle.
      ev = { kind: 'dist', cm: Math.round(ev.cm * 100) / 100 };
      e.tb_sonar_distance?.(ev.cm);
      break;
    case 'imu': {
      // Round to script precision before applying: web and CLI replay read bit-identical values.
      const r = roundImu(ev);
      const [dp, dr, dy] = r.rates ?? [0, 0, 0];
      e.tb_imu_set?.(r.pitch, r.roll, r.yaw, dp, dr, dy);
      record(e, r);
      return;
    }
    case 'touch': {
      const x = Math.round(Math.min(239, Math.max(0, ev.x)));
      const y = Math.round(Math.min(239, Math.max(0, ev.y)));
      e.tb_touch?.(x, y, ev.down ? 1 : 0);
      record(e, { ...ev, x, y });
      return;
    }
    case 'power':
      return;
  }
  record(e, ev);
}

/** Rewind replay: 1 ms slices with inputs between slices like live runs; events replay at their original slice boundary,
 *  so it is cycle-exact; it stops at the boundary of untilMs and events at that instant are not applied (they belong to the next step). */
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
    drainIo(e);
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
  // Serial output before the stop point is already in the snapshot; the main thread rebuilds the serial panel from its stdout.
  pwmEvents = [];
  // Sound from rewind replay is in the past: do not play it.
  if (hasAudio) e.tb_audio_take?.();
  pcmOut = [];
  // Brown-outs during replay are old events (already on the timeline): not reported again.
  if (e.tb_elec_stat) resetsSeen = e.tb_elec_stat(7);
}

// Handle messages strictly in order: two boots in flight would otherwise race on wasm
// instantiation and the older firmware could win (example still loading when a .bin is dropped).
let inbox: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<ToWorker>) => {
  inbox = inbox.then(() => handle(ev.data)).catch(crash);
};

async function handle(m: ToWorker) {
  switch (m.type) {
    case 'debugPanic':
      ex?.tb_debug_panic?.();
      break;
    case 'boot': {
      running = false;
      if (m.realnet !== undefined) realnetOn = m.realnet;
      if (m.locale) await useWorkerLocale(m.locale);
      const e = await bootWasm(m);
      if (!e) return;
      // Power on with the real network on: the switch goes into the log as an input at time 0 (first line of the replay script: realnet=1)
      if (realnetOn) apply(e, { kind: 'realnet', on: true });
      // Network preset survives power-ons (main-thread state): logged at time 0 like the real-network switch
      if (m.net && m.net !== 'normal') apply(e, { kind: 'net', preset: m.net });
      post({ type: 'booted', chip: simChip, bootPin: e.tb_boot_pin() });
      break;
    }
    case 'seek': {
      running = false;
      const e = await bootWasm(m);
      if (!e) return;
      if (m.realnet !== undefined) realnetOn = m.realnet;
      for (const x of m.events) if (x.kind === 'netreply') replyCache.set(replyId(x.reply), x.reply);
      seekTo(e, m.events, m.untilMs);
      // Requests already answered in the replay are not answered again; the switch state follows the present (add one line if it differs from the last in the log)
      const answered = new Set<number>();
      let wasOn = false;
      for (const x of inputLog.events) {
        if (x.kind === 'netreply') answered.add(replyId(x.reply));
        if (x.kind === 'realnet') wasOn = x.on;
      }
      if (wasOn !== realnetOn) apply(e, { kind: 'realnet', on: realnetOn });
      // Same for the network preset: the present choice wins if it differs from the last logged one
      let preset = 'normal';
      for (const x of inputLog.events) if (x.kind === 'net') preset = x.preset;
      if (m.net && m.net !== preset) apply(e, { kind: 'net', preset: m.net });
      pumpNet(e, answered);
      flushIo(e);
      post({ type: 'seeked', snap: snapshot(e), bootPin: e.tb_boot_pin() });
      postPaused(e);
      postOled(e);
      postLcd(e, true);
      postBle(e, true);
      postNet(e);
      break;
    }
    case 'snapshot':
      // Always answer: a waiter left hanging (no machine yet, or crashed) would stall the next power-up
      if (ex) flushIo(ex);
      post({ type: 'snapshot', snap: ex ? snapshot(ex) : null });
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
    case 'adcMode':
      if (!ex) return;
      apply(ex, { kind: 'adc', ideal: m.ideal });
      break;
    case 'watchAdc':
      adcPins = [...m.pins];
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
      loop(++loopGen);
      break;
    case 'pause':
      running = false;
      if (ex) {
        flushIo(ex);
        postPaused(ex);
      }
      break;
    case 'ioWatch':
      ioLo = m.lo >>> 0;
      ioHi = m.hi >>> 0;
      ex?.tb_io_watch?.(ioLo, ioHi);
      break;
    case 'hidden':
      pageHidden = m.hidden;
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
    case 'ble':
      if (!ex) return;
      apply(ex, { kind: 'ble', cmd: m.cmd });
      postBle(ex, true);
      break;
    case 'phone':
      if (!ex) return;
      apply(ex, { kind: 'phone', cmd: m.cmd });
      postNet(ex);
      break;
    case 'realnet':
      realnetOn = m.on;
      if (!ex) return;
      apply(ex, { kind: 'realnet', on: m.on });
      postNet(ex);
      break;
    case 'netPreset':
      if (!ex) return;
      apply(ex, { kind: 'net', preset: m.preset });
      postNet(ex);
      break;
    case 'netFault':
      if (!ex) return;
      apply(ex, { kind: 'netfault', fault: m.fault, ...(m.dur === undefined ? {} : { dur: m.dur }) });
      postNet(ex);
      break;
    case 'power':
      if (!ex) return;
      apply(ex, { kind: 'supply', mode: m.mode });
      if (!running) postPaused(ex);
      break;
    case 'harness':
      if (!ex) return;
      if (m.i2cWire !== undefined) apply(ex, { kind: 'i2cwire', cm: m.i2cWire });
      if (m.antenna !== undefined) apply(ex, { kind: 'antenna', db: m.antenna });
      postHarness(ex);
      break;
    case 'vcdStart': {
      if (!ex) return;
      let lo = 0;
      let hi = 0;
      for (const p of m.pins) if (p < 32) lo |= 1 << p; else hi |= 1 << (p - 32);
      if (m.trigger) ex.tb_vcd_arm?.(lo >>> 0, hi >>> 0, m.from, m.len);
      else ex.tb_vcd_start?.(lo >>> 0, hi >>> 0, m.from, m.from + m.len);
      postVcd(ex);
      break;
    }
    case 'vcdGet': {
      if (!ex?.tb_vcd_text) return;
      const n = ex.tb_vcd_text();
      post({ type: 'vcdText', text: decoder.decode(new Uint8Array(ex.memory.buffer, ex.tb_report_ptr(), n)), state: vcdState(ex) });
      break;
    }
    case 'enc':
      if (!ex) return;
      apply(ex, { kind: 'enc', steps: m.steps });
      break;
    case 'encsw':
      if (!ex) return;
      apply(ex, { kind: 'encsw', down: m.down });
      break;
    case 'dist':
      if (!ex) return;
      apply(ex, { kind: 'dist', cm: m.cm });
      if (!running) postPaused(ex);
      break;
    case 'input':
      if (!ex) return;
      apply(ex, m.act);
      break;
    case 'mic':
      if (ex) setMic(ex, m.source, m.wav);
      break;
    case 'micPush': {
      const e = ex;
      if (!e?.tb_mic_push || !m.data.length) return;
      // tb_alloc is not 4-byte aligned: copy bytewise (the core decodes little-endian f32).
      const p = e.tb_alloc(m.data.byteLength);
      new Uint8Array(e.memory.buffer, p, m.data.byteLength).set(new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.byteLength));
      e.tb_mic_push(p, m.data.length, m.rate);
      e.tb_free(p, m.data.byteLength);
      break;
    }
  }
}
