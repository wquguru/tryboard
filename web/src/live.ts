// Live simulation for the home and lab pages: starts worker.ts, runs one firmware and hands each frame to the view.
import { fetchBuf, imageChip, loadRom, loadWasmModule } from './assets';
import type { Battery, EncoderSpec, Env, FromWorker, Harness, LcdKind, PcmBlock, PowerMode, PwmEvent, Snapshot, SonarSpec, TimingReport, ToWorker, VcdState } from './simmsg';
import type { UsbView } from './usb3d';
import { parseBle, type BleUpdate } from './ble';
import type { InputEvent, InputLog } from './inputlog';
import { locale, t } from './i18n';

/** IMU pose: Euler angles (degrees) + rates (°/s), see core devices/imu.rs. */
export interface ImuPose {
  pitch: number;
  roll: number;
  yaw: number;
  rates?: [number, number, number];
}
import { emptyFrame, type LiveFrame } from './views/common';

export interface LiveOptions {
  /** Firmware URL, or an image already read in (user upload). */
  fw: string | ArrayBuffer;
  i2c: { kind: string; addr: number }[];
  env: Env;
  lcd?: boolean | LcdKind;
  /** AXP2101 battery at power-up (E-03) */
  battery?: Battery;
  /** Servo signal pin (needed for servo current and brown-out resets). */
  servo?: number;
  /** Power source at power-up (default usb). */
  power?: PowerMode;
  /** Harness at power-up (P2-11, estimate): I2C cable length, antenna loss. */
  harness?: Harness;
  /** What the native USB virtual host sees (only when S3 firmware uses USB; null = no USB device). */
  onUsb?(v: UsbView | null): void;
  /** BLE (C-01): air-log increments + virtual phone view; firmware without BLE gets one state 0 at power-up. */
  onBle?(u: BleUpdate): void;
  /** Network tab (C-02): whether firmware uses Wi-Fi, phone JSON, request log JSON (unchanged fields omitted) */
  onNet?(m: { used: boolean; phone?: string; rows?: string; replies?: number; replyBytes?: number }): void;
  /** Current "real network" toggle (C-03), sent to the worker on boot / rewind */
  realnet?(): boolean;
  /** Current network preset (D-01), sent on boot / rewind */
  netPreset?(): string;
  /** Harness verdict text (same lines as the CLI), called on change. */
  onHarness?(text: string): void;
  /** Rotary encoder / HC-SR04 (on GPIOs; the core times the waveforms). */
  encoder?: EncoderSpec;
  sonar?: SonarSpec;
  /** DHT11 data GPIO (D-03, open drain; readings follow env). */
  dht11?: number;
  /** Timing-sensitive code report (D-03), parsed; null = nothing detected. Called on change. */
  onTiming?(r: TimingReport | null): void;
  /** Fine capture state (D-04), called on change; null = no capture. */
  onVcd?(s: VcdState | null): void;
  /** GPIO wired to the touch controller INT (P2-02). */
  touchInt?: number;
  /** I2S audio devices (max98357a / inmp441); the WAV the mic hears at power-up and its file name. */
  i2s?: string[];
  micWav?: ArrayBuffer;
  micName?: string;
  /** Speaker output (with sim time), feed to audio.ts BuzzerAudio.pushPcm. */
  onPcm?(blocks: PcmBlock[]): void;
  onConsole?(text: string): void;
  onFrame?(f: LiveFrame, simSeconds: number): void;
  /** Raw tick (pin levels, PWM) for pages that drive a 3D stage. */
  onTick?(m: Extract<FromWorker, { type: 'tick' }>): void;
  /** Firmware loaded and running (once per start / reset / load). */
  onBoot?(chip: 'esp32' | 'esp32c3' | 'esp32s3'): void;
  /** The core crashed (simulator bug); message from the Rust panic hook */
  onCrash?(message: string): void;
  /** PWM changes on watchPwm pins (with sim time), feed to audio.ts BuzzerAudio.push. */
  onPwm?(events: PwmEvent[] | undefined, simSeconds: number): void;
  /** The previous power-up is about to end (re-power / new firmware / before rewind): its full record so far. */
  onRunEnd?(snap: Snapshot): void;
  /** Rewind fast-forward progress (sim seconds). */
  onSeekProgress?(simSeconds: number): void;
  /** Logic analyser events (raw); reset = new power-up / rewind replay start, earlier ones void. */
  onIo?(m: Extract<FromWorker, { type: 'io' }>): void;
  /** FreeRTOS task switches (raw + task table); reset = new power-up / rewind replay start. */
  onTasks?(m: Extract<FromWorker, { type: 'tasks' }>): void;
}

/** Rewind to a moment of some run (P0-03): uses that run's firmware, devices, environment and input log. */
export interface SeekJob {
  flash: ArrayBuffer;
  i2c: { kind: string; addr: number }[];
  lcd: boolean | LcdKind;
  battery?: Battery;
  servo?: number;
  power?: PowerMode;
  encoder?: EncoderSpec;
  /** Pins only; the initial distance is the dist event at time 0 in the log. */
  sonar?: { trig: number; echo: number };
  dht11?: number;
  touchInt?: number;
  i2s?: string[];
  micWav?: ArrayBuffer;
  micName?: string;
  /** Environment at power-up (first env entry of the log). */
  env: Env;
  events: InputEvent[];
  untilMs: number;
}

// Identity ids for ROM / firmware buffers (treated as immutable everywhere: callers swap buffers, never patch them).
const ids = new WeakMap<ArrayBuffer, number>();
let nextId = 0;
const bufId = (b: ArrayBuffer) => ids.get(b) ?? (ids.set(b, ++nextId), nextId);

export class LiveSim {
  private w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private flash: ArrayBuffer | null = null;
  readonly frame: LiveFrame = emptyFrame();
  bootPin = 0;
  env: Env;
  /** Current pose (stage tilt / product rotation): re-applied after re-power, as if the board is still tilted. */
  pose: ImuPose = { pitch: 0, roll: 0, yaw: 0 };
  /** Sensor offset from room temperature (a sensor hugging the chip reads high after assembly). */
  sensorOffset = 0;
  private onVis = () => this.send({ type: 'hidden', hidden: document.hidden });
  constructor(private o: LiveOptions) {
    this.env = { ...o.env };
    document.addEventListener('visibilitychange', this.onVis);
    this.onVis();
    this.w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'booted') {
        this.bootPin = m.bootPin;
        // Pose is not a boot parameter: apply it as the first input (logged, so replay matches); skip when flat.
        const p = this.pose;
        if (p.pitch || p.roll || p.yaw) this.send({ type: 'input', act: { kind: 'imu', pitch: p.pitch, roll: p.roll, yaw: p.yaw } });
        this.send({ type: 'run' });
        o.onBoot?.(m.chip);
      } else if (m.type === 'tick') {
        if (m.console) o.onConsole?.(m.console);
        o.onTick?.(m);
        this.frame.pwm = m.pwm;
        this.frame.running = m.running;
        if (m.leds) this.frame.rgb = m.leds[0] ?? null;
        if (m.strips) this.frame.strips = { ...this.frame.strips, ...m.strips };
        o.onFrame?.(this.frame, m.simSeconds);
        o.onPwm?.(m.pwmEvents, m.simSeconds);
      } else if (m.type === 'inputlog') {
        for (const r of this.logWaiters.splice(0)) r(m.log);
      } else if (m.type === 'snapshot') {
        for (const r of this.snapWaiters.splice(0)) r(m.snap);
      } else if (m.type === 'seeked') {
        this.bootPin = m.bootPin;
        this.seekWaiter?.(m.snap);
        this.seekWaiter = null;
      } else if (m.type === 'io') {
        o.onIo?.(m);
      } else if (m.type === 'tasks') {
        o.onTasks?.(m);
      } else if (m.type === 'pcm') {
        o.onPcm?.(m.blocks);
      } else if (m.type === 'seekProgress') {
        o.onSeekProgress?.(m.simSeconds);
      } else if (m.type === 'mark') {
        this.markWaiters.get(m.id)?.(m.tMs);
        this.markWaiters.delete(m.id);
      } else if (m.type === 'lcd') {
        this.frame.lcd = m.pixels;
        this.frame.lcdW = m.w;
        this.frame.lcdH = m.h;
        o.onFrame?.(this.frame, NaN);
      } else if (m.type === 'usb') {
        o.onUsb?.(m.json ? (JSON.parse(m.json) as UsbView) : null);
      } else if (m.type === 'ble') {
        o.onBle?.(parseBle(m.state, m.json, m.reset, m.cmdError));
      } else if (m.type === 'net') {
        o.onNet?.(m);
      } else if (m.type === 'harness') {
        o.onHarness?.(m.text);
      } else if (m.type === 'timing') {
        const r = JSON.parse(m.json) as Partial<TimingReport>;
        o.onTiming?.(r.line ? (r as TimingReport) : null);
      } else if (m.type === 'vcd') {
        o.onVcd?.(m.state);
      } else if (m.type === 'vcdText') {
        for (const r of this.vcdWaiters.splice(0)) r({ text: m.text, state: m.state });
      } else if (m.type === 'oled') {
        this.frame.oled = m.pixels;
        o.onFrame?.(this.frame, NaN);
      } else if (m.type === 'crash') {
        o.onCrash?.(m.message);
        o.onConsole?.(`\n${t('[TryBoard] Simulator internal error: {msg}', { msg: m.message })}\n`);
      } else if (m.type === 'error' || m.type === 'stopped') {
        o.onConsole?.(`\n${m.type === 'error' ? t('[TryBoard] Failed to start: {msg}', { msg: m.message }) : t('[TryBoard] Stopped: {msg}', { msg: m.reason })}\n`);
      }
    };
  }
  // Bytes this worker already holds (R-23): ROM ids per chip, and the one firmware it keeps
  private sentRoms = new Set<number>();
  private sentFlash = -1;
  /** rom / flash fields for boot / seek: bytes (structured-cloned, not transferred) only on first send, else just the ids. */
  private blobs(rom: ArrayBuffer, flash: ArrayBuffer) {
    const romId = bufId(rom), flashId = bufId(flash);
    const r = { romId, flashId, rom: this.sentRoms.has(romId) ? undefined : rom, flash: this.sentFlash === flashId ? undefined : flash };
    this.sentRoms.add(romId);
    this.sentFlash = flashId;
    return r;
  }
  private send(m: ToWorker, t: Transferable[] = []) {
    this.w.postMessage(m, t);
  }
  /** A power-up is in progress (started and not stopped by a rewind): wrap it up before powering again. */
  private live = false;
  private async closeRun() {
    if (!this.live) return;
    this.live = false;
    const snap = await this.snapshot();
    if (snap) this.o.onRunEnd?.(snap);
  }
  private startGen = 0;
  async start() {
    // A newer start (firmware swapped mid power-up) wins even if this one's awaits finish later
    const gen = ++this.startGen;
    await this.closeRun();
    this.live = true;
    const fw = this.o.fw;
    const flash = (this.flash ??= typeof fw === 'string' ? await fetchBuf(fw) : fw);
    const wasm = await loadWasmModule();
    const rom = await loadRom(imageChip(flash));
    if (gen !== this.startGen) return;
    Object.assign(this.frame, emptyFrame());
    this.send({ type: 'boot', wasm, ...this.blobs(rom, flash), i2c: this.o.i2c, env: this.sensed(), lcd: this.o.lcd, battery: this.o.battery, servo: this.o.servo, power: this.o.power, encoder: this.o.encoder, sonar: this.o.sonar, touchInt: this.o.touchInt, i2s: this.o.i2s, micWav: this.o.micWav?.slice(0), micName: this.o.micName, harness: this.o.harness, dht11: this.o.dht11, realnet: this.o.realnet?.() ?? false, net: this.o.netPreset?.(), locale });
  }
  reset() {
    return this.start();
  }
  /** Swap the firmware (user uploads their own .bin). */
  load(fw: string | ArrayBuffer) {
    this.o.fw = fw;
    this.flash = null;
    return this.start();
  }
  /** Swap attached devices (rearranged per list): takes effect on the next start / reset. */
  configure(p: { i2c: LiveOptions['i2c']; lcd?: boolean | LcdKind; battery?: Battery; servo?: number; encoder?: EncoderSpec; sonar?: SonarSpec; dht11?: number; touchInt?: number; i2s?: string[] }) {
    this.o.i2c = p.i2c;
    this.o.lcd = p.lcd;
    this.o.battery = p.battery;
    this.o.servo = p.servo;
    this.o.encoder = p.encoder;
    this.o.sonar = p.sonar;
    this.o.dht11 = p.dht11;
    this.o.touchInt = p.touchInt;
    this.o.i2s = p.i2s;
  }
  private vcdWaiters: ((r: { text: string; state: VcdState | null }) => void)[] = [];
  /** Fine capture (D-04): window [from, from + len] s of sim time, or armed (the next edge at or after `from` opens it). Not logged: observation only. */
  vcdStart(pins: number[], from: number, len: number, trigger: boolean) {
    this.send({ type: 'vcdStart', pins, from, len, trigger });
  }
  /** VCD text of the fine capture (byte-identical to CLI --vcd for the same run and window). */
  vcdText(): Promise<{ text: string; state: VcdState | null }> {
    return new Promise((r) => {
      this.vcdWaiters.push(r);
      this.send({ type: 'vcdGet' });
    });
  }
  /** Turn the encoder by steps (positive = clockwise), logged. */
  turnEncoder(steps: number) {
    if (steps) this.send({ type: 'enc', steps });
  }
  pressEncoder(down: boolean) {
    this.send({ type: 'encsw', down });
  }
  /** Ultrasonic distance (cm, negative = nothing ahead); also the initial distance for the next power-up. */
  setDistance(cm: number) {
    if (this.o.sonar) this.o.sonar = { ...this.o.sonar, cm };
    this.send({ type: 'dist', cm });
  }
  /** Pose (P2-03): tilt sliders, dragging the stage / product; rates are drag angular rates (°/s), 0 when stopped. */
  setImu(p: ImuPose) {
    this.pose = { pitch: p.pitch, roll: p.roll, yaw: p.yaw };
    this.send({ type: 'input', act: { kind: 'imu', pitch: p.pitch, roll: p.roll, yaw: p.yaw, ...(p.rates ? { rates: p.rates } : {}) } });
  }
  /** Touch (P2-02): press / move to (x, y), down=false lifts. */
  touch(x: number, y: number, down: boolean) {
    this.send({ type: 'input', act: { kind: 'touch', x, y, down } });
  }
  /** AXP2101 battery percent / USB plug (E-03, logged bat=); also the state for the next power-up. */
  battery(pct: number, usb: boolean) {
    this.o.battery = { pct: Math.round(Math.min(100, Math.max(0, pct))), usb };
    this.send({ type: 'input', act: { kind: 'bat', ...this.o.battery } });
  }
  /** PWR key on the AXP2101 PWRON pin (E-03, logged pwrkey=). */
  pwrkey(long: boolean) {
    this.send({ type: 'input', act: { kind: 'pwrkey', long } });
  }
  /** Mic source: WAV (also the source for the next power-up) / silent / live (then micPush streams the browser mic). */
  setMic(source: 'wav' | 'silence' | 'live', wav?: ArrayBuffer, name?: string) {
    if (source === 'wav') {
      this.o.micWav = wav;
      this.o.micName = name;
    }
    this.send({ type: 'mic', source, wav: wav?.slice(0) });
  }
  micPush(rate: number, data: Float32Array) {
    this.send({ type: 'micPush', rate, data }, [data.buffer]);
  }
  powerMode(): PowerMode {
    return this.o.power ?? 'usb';
  }
  /** USB <-> external 5 V: applied live (logged) and used as the next power-up's initial supply. */
  setPower(mode: PowerMode) {
    this.o.power = mode;
    this.send({ type: 'power', mode });
  }
  harness(): Harness {
    return { ...this.o.harness };
  }
  /** Change the harness: applied live (logged) and used as the next power-up's initial value. */
  setHarness(h: Harness) {
    this.o.harness = { ...this.o.harness, ...h };
    this.send({ type: 'harness', ...h });
  }
  press(down: boolean) {
    this.send({ type: 'gpio', pin: this.bootPin, level: down ? 0 : -1 });
  }
  /** External button: press pulls the pin to GND, release floats it (logged gpioN=0|z). */
  pressPin(pin: number, down: boolean) {
    this.send({ type: 'gpio', pin, level: down ? 0 : -1 });
  }
  private sensed(): Env {
    return { ...this.env, temp: this.env.temp + this.sensorOffset };
  }
  setTemp(t: number) {
    this.env.temp = Math.max(-10, Math.min(45, t));
    this.send({ type: 'env', ...this.sensed() });
  }
  /** Change the environment (humidity / pressure too; temperature clamped to -10..45 like setTemp). */
  setEnv(e: Partial<Env>) {
    Object.assign(this.env, e);
    if (e.temp !== undefined) this.env.temp = Math.max(-10, Math.min(45, e.temp));
    this.send({ type: 'env', ...this.sensed() });
  }
  /** The virtual PC types into the USB serial port (CDC-ACM). */
  usbCdc(text: string) {
    this.send({ type: 'usbcdc', text });
  }
  /** Virtual phone action (ble=<cmd>, logged). */
  ble(cmd: string) {
    this.send({ type: 'ble', cmd });
  }
  /** One step on the virtual phone (logged as phone=…) */
  phone(cmd: string) {
    this.send({ type: 'phone', cmd });
  }
  /** "Real network" toggle (C-03, logged as realnet=1/0) */
  realnet(on: boolean) {
    this.send({ type: 'realnet', on });
  }
  /** Network preset (D-01, logged as net=…) */
  netPreset(preset: string) {
    this.send({ type: 'netPreset', preset });
  }
  /** One network fault from now (D-01, logged as netfault=kind[,s]) */
  netFault(fault: string, dur?: number) {
    this.send({ type: 'netFault', fault, dur });
  }
  /** ADC model (D-02): ideal = linear and exact, real = calibration curve + bends + noise (logged: adc=). */
  adcMode(ideal: boolean) {
    this.send({ type: 'adcMode', ideal });
  }
  /** Pins whose recent ADC conversions come back in tick.adc */
  watchAdc(pins: number[]) {
    this.send({ type: 'watchAdc', pins });
  }
  /** Potentiometer wiper voltage (mV) into an ADC pin (logged). */
  analog(pin: number, mv: number) {
    this.send({ type: 'analog', pin, mv });
  }
  setOffset(d: number) {
    this.sensorOffset = d;
    this.send({ type: 'env', ...this.sensed() });
  }
  dispose() {
    document.removeEventListener('visibilitychange', this.onVis);
    this.w.terminate();
  }
  pause() {
    this.send({ type: 'pause' });
  }
  /** Test hook (R-04): make the core panic. */
  debugPanic() {
    this.send({ type: 'debugPanic' });
  }
  resume() {
    this.send({ type: 'run' });
  }
  /** Wall-clock speed (only how fast the sim runs, never the results in sim time). */
  speed(factor: number) {
    this.send({ type: 'speed', factor });
  }
  /** Type into UART0 RX (logged, replayable). */
  uart(text: string) {
    this.send({ type: 'uart', text });
  }
  private snapWaiters: ((s: Snapshot | null) => void)[] = [];
  private seekWaiter: ((s: Snapshot) => void) | null = null;
  private markWaiters = new Map<number, (tMs: number) => void>();
  private markId = 0;
  /** Input log + full serial + observations since power-up (does not interrupt the run). */
  snapshot(): Promise<Snapshot | null> {
    return new Promise((r) => {
      this.snapWaiters.push(r);
      this.send({ type: 'snapshot' });
    });
  }
  /** Current sim time (ms); inputs sent before it have been applied. */
  mark(): Promise<number> {
    const id = ++this.markId;
    return new Promise((r) => {
      this.markWaiters.set(id, r);
      this.send({ type: 'mark', id });
    });
  }
  /** Rewind: wrap up the current run, re-power per job and fast-forward to untilMs, then pause; resume() continues live from there. */
  async seek(job: SeekJob): Promise<Snapshot> {
    await this.closeRun();
    const [wasm, rom] = [await loadWasmModule(), await loadRom(imageChip(job.flash))];
    this.flash = job.flash;
    this.o.fw = job.flash;
    this.o.i2c = job.i2c;
    this.o.lcd = job.lcd;
    this.o.battery = job.battery;
    this.o.servo = job.servo;
    this.o.encoder = job.encoder;
    this.o.dht11 = job.dht11;
    // Distance after a rewind stop = last dist in the log (initial distance of the next power-up).
    const dl = [...job.events].reverse().find((e) => e.kind === 'dist' && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    this.o.sonar = job.sonar ? { ...job.sonar, cm: dl && dl.kind === 'dist' ? dl.cm : (this.o.sonar?.cm ?? 100) } : undefined;
    this.o.touchInt = job.touchInt;
    const imu = [...job.events].reverse().find((e) => e.kind === 'imu' && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    this.pose = imu && imu.kind === 'imu' ? { pitch: imu.pitch, roll: imu.roll, yaw: imu.yaw } : { pitch: 0, roll: 0, yaw: 0 };
    // Supply after a rewind stop = last switch in the log (else the power-up one).
    const sup = [...job.events].reverse().find((e) => e.kind === 'supply' && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    this.o.power = sup && sup.kind === 'supply' ? sup.mode : job.power;
    const last = [...job.events].reverse().find((e) => e.kind === 'env' && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    this.env = last && last.kind === 'env' ? { temp: last.temp, humidity: last.humidity, pressure: last.pressure } : { ...job.env };
    this.sensorOffset = 0;
    // Harness likewise: last setting in the log after a rewind stop.
    const before = (k: 'i2cwire' | 'antenna') => [...job.events].reverse().find((e) => e.kind === k && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    const iw = before('i2cwire');
    const an = before('antenna');
    this.o.harness = { i2cWire: iw && iw.kind === 'i2cwire' ? iw.cm : undefined, antenna: an && an.kind === 'antenna' ? an.db : undefined };
    Object.assign(this.frame, emptyFrame());
    return new Promise((r) => {
      this.seekWaiter = r;
      this.send({ type: 'seek', wasm, ...this.blobs(rom, job.flash), i2c: job.i2c, env: job.env, lcd: job.lcd, battery: job.battery, servo: job.servo, power: job.power, encoder: job.encoder, sonar: job.sonar ? { ...job.sonar, cm: NaN } : undefined, touchInt: job.touchInt, i2s: job.i2s, micWav: job.micWav?.slice(0), micName: job.micName, events: job.events, untilMs: job.untilMs, dht11: job.dht11, realnet: this.o.realnet?.() ?? false, net: this.o.netPreset?.() });
    });
  }
  /** Continue live after a rewind stop: this run counts as in progress again. */
  continueRun() {
    this.live = true;
    this.resume();
  }
  private logWaiters: ((l: InputLog) => void)[] = [];
  /** Input log since power-up (sim timestamps, see inputlog.ts; toScript exports for CLI --inputs). */
  inputLog(): Promise<InputLog> {
    return new Promise((r) => {
      this.logWaiters.push(r);
      this.send({ type: 'getInputLog' });
    });
  }
  /** GPIOs the logic analyser watches (bitmask); PWM / WS2812 / I2C events are logged without watching. */
  watchIo(lo: number, hi: number) {
    this.send({ type: 'ioWatch', lo, hi });
  }
  /** Sample these pins' PWM (buzzer) every slice; changes go to onPwm. */
  watchPwm(pins: number[]) {
    this.send({ type: 'watchPwm', pins });
  }
}
