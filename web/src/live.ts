// 首页 / 关卡页用的实时模拟：起一个 worker.ts，跑一份固件，把每帧状态交给视图。
import { fetchBuf, imageChip, loadRom, loadWasm } from './assets';
import type { EncoderSpec, Env, FromWorker, Harness, PcmBlock, PowerMode, PwmEvent, Snapshot, SonarSpec, ToWorker } from './worker';
import type { UsbView } from './usb3d';
import type { InputEvent, InputLog } from './inputlog';

/** IMU 姿态：欧拉角（度）+ 变化率（°/s），见 core devices/imu.rs */
export interface ImuPose {
  pitch: number;
  roll: number;
  yaw: number;
  rates?: [number, number, number];
}
import { emptyFrame, type LiveFrame } from './views/common';

export interface LiveOptions {
  /** 固件 URL，或已经读进来的镜像（用户上传的） */
  fw: string | ArrayBuffer;
  i2c: { kind: string; addr: number }[];
  env: Env;
  lcd?: boolean;
  /** 舵机信号脚（接上才有舵机电流、欠压复位） */
  servo?: number;
  /** 上电时的供电方式（默认 usb） */
  power?: PowerMode;
  /** 上电时的线束（P2-11，估算）：I2C 排线总长、天线遮挡 */
  harness?: Harness;
  /** 原生 USB 虚拟主机看到的（S3 固件用了 USB 才有；null = 没有 USB 设备） */
  onUsb?(v: UsbView | null): void;
  /** 线束结论文字（与命令行同样的行），变了才回调 */
  onHarness?(text: string): void;
  /** 旋转编码器 / HC-SR04（接在 GPIO 上，波形由内核按时刻排出） */
  encoder?: EncoderSpec;
  sonar?: SonarSpec;
  /** 触摸控制器 INT 接的 GPIO（P2-02） */
  touchInt?: number;
  /** I2S 音频器件（max98357a / inmp441）；麦克风上电时听的 WAV 与文件名 */
  i2s?: string[];
  micWav?: ArrayBuffer;
  micName?: string;
  /** 喇叭放出的声音（带模拟时刻），接 audio.ts 的 BuzzerAudio.pushPcm */
  onPcm?(blocks: PcmBlock[]): void;
  onConsole?(text: string): void;
  onFrame?(f: LiveFrame, simSeconds: number): void;
  /** 原始 tick（引脚电平、PWM），给要驱动 3D 台面的页面用 */
  onTick?(m: Extract<FromWorker, { type: 'tick' }>): void;
  /** 固件已加载、开始运行（每次 start / reset / load 一次） */
  onBoot?(chip: 'esp32' | 'esp32c3' | 'esp32s3'): void;
  /** watchPwm 引脚上的 PWM 变化（带模拟时刻），接 audio.ts 的 BuzzerAudio.push */
  onPwm?(events: PwmEvent[] | undefined, simSeconds: number): void;
  /** 上一次上电就要结束（重新上电 / 换固件 / 回退之前）：这次运行从上电到此刻的完整记录 */
  onRunEnd?(snap: Snapshot): void;
  /** 回退快进的进度（模拟秒） */
  onSeekProgress?(simSeconds: number): void;
  /** 逻辑分析仪事件（原始记录）；reset = 新上电 / 回退重放开始，之前的作废 */
  onIo?(m: Extract<FromWorker, { type: 'io' }>): void;
}

/** 回退到某次运行的某个时刻（P0-03）：用那次运行的固件、器件、环境和输入日志 */
export interface SeekJob {
  flash: ArrayBuffer;
  i2c: { kind: string; addr: number }[];
  lcd: boolean;
  servo?: number;
  power?: PowerMode;
  encoder?: EncoderSpec;
  /** 只要引脚；初始距离是日志里 0 时刻的 dist 事件 */
  sonar?: { trig: number; echo: number };
  touchInt?: number;
  i2s?: string[];
  micWav?: ArrayBuffer;
  micName?: string;
  /** 上电时的环境（日志第一条 env） */
  env: Env;
  events: InputEvent[];
  untilMs: number;
}

export class LiveSim {
  private w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private flash: ArrayBuffer | null = null;
  readonly frame: LiveFrame = emptyFrame();
  bootPin = 0;
  env: Env;
  /** 当前姿态（台面倾斜 / 成品转动）：重新上电后照样施加，像板子还歪着 */
  pose: ImuPose = { pitch: 0, roll: 0, yaw: 0 };
  /** 传感器读数相对室温的偏移（装配时传感器贴着芯片会偏高） */
  sensorOffset = 0;
  constructor(private o: LiveOptions) {
    this.env = { ...o.env };
    this.w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'booted') {
        this.bootPin = m.bootPin;
        // 姿态不是上电参数：作为第一个输入施加（记进日志，重放一致）；平放就不发
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
      } else if (m.type === 'pcm') {
        o.onPcm?.(m.blocks);
      } else if (m.type === 'seekProgress') {
        o.onSeekProgress?.(m.simSeconds);
      } else if (m.type === 'mark') {
        this.markWaiters.get(m.id)?.(m.tMs);
        this.markWaiters.delete(m.id);
      } else if (m.type === 'lcd') {
        this.frame.lcd = m.pixels;
        o.onFrame?.(this.frame, NaN);
      } else if (m.type === 'usb') {
        o.onUsb?.(m.json ? (JSON.parse(m.json) as UsbView) : null);
      } else if (m.type === 'harness') {
        o.onHarness?.(m.text);
      } else if (m.type === 'oled') {
        this.frame.oled = m.pixels;
        o.onFrame?.(this.frame, NaN);
      } else if (m.type === 'error' || m.type === 'stopped') {
        o.onConsole?.(`\n[试板] ${m.type === 'error' ? '启动失败' : '停止'}：${'message' in m ? m.message : m.reason}\n`);
      }
    };
  }
  private send(m: ToWorker, t: Transferable[] = []) {
    this.w.postMessage(m, t);
  }
  /** 有一次上电正在进行（start 过、还没被回退停住）：再上电之前先把它收尾 */
  private live = false;
  private async closeRun() {
    if (!this.live) return;
    this.live = false;
    const snap = await this.snapshot();
    this.o.onRunEnd?.(snap);
  }
  async start() {
    await this.closeRun();
    this.live = true;
    const fw = this.o.fw;
    this.flash ??= typeof fw === 'string' ? await fetchBuf(fw) : fw;
    const [wasm, flash] = [await loadWasm(), this.flash];
    const rom = await loadRom(imageChip(flash));
    Object.assign(this.frame, emptyFrame());
    this.send({ type: 'boot', wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), i2c: this.o.i2c, env: this.sensed(), lcd: this.o.lcd, servo: this.o.servo, power: this.o.power, encoder: this.o.encoder, sonar: this.o.sonar, touchInt: this.o.touchInt, i2s: this.o.i2s, micWav: this.o.micWav?.slice(0), micName: this.o.micName, harness: this.o.harness });
  }
  reset() {
    return this.start();
  }
  /** 换一份固件（关卡页上传自己的 .bin） */
  load(fw: string | ArrayBuffer) {
    this.o.fw = fw;
    this.flash = null;
    return this.start();
  }
  /** 换外接器件（按清单重摆台面）：下次 start / reset 生效 */
  configure(p: { i2c: LiveOptions['i2c']; lcd?: boolean; servo?: number; encoder?: EncoderSpec; sonar?: SonarSpec; touchInt?: number; i2s?: string[] }) {
    this.o.i2c = p.i2c;
    this.o.lcd = p.lcd;
    this.o.servo = p.servo;
    this.o.encoder = p.encoder;
    this.o.sonar = p.sonar;
    this.o.touchInt = p.touchInt;
    this.o.i2s = p.i2s;
  }
  /** 编码器转 steps 格（正 = 顺时针），进输入日志 */
  turnEncoder(steps: number) {
    if (steps) this.send({ type: 'enc', steps });
  }
  pressEncoder(down: boolean) {
    this.send({ type: 'encsw', down });
  }
  /** 超声波距离（cm，负数 = 前方没有东西）；也作为下次上电的初始距离 */
  setDistance(cm: number) {
    if (this.o.sonar) this.o.sonar = { ...this.o.sonar, cm };
    this.send({ type: 'dist', cm });
  }
  /** 姿态（P2-03）：倾斜滑块、拖动台面 / 成品；rates 是拖动时的角速率（°/s），停下时给 0 */
  setImu(p: ImuPose) {
    this.pose = { pitch: p.pitch, roll: p.roll, yaw: p.yaw };
    this.send({ type: 'input', act: { kind: 'imu', pitch: p.pitch, roll: p.roll, yaw: p.yaw, ...(p.rates ? { rates: p.rates } : {}) } });
  }
  /** 触摸（P2-02）：按下 / 移动到 (x, y)，down=false 抬起 */
  touch(x: number, y: number, down: boolean) {
    this.send({ type: 'input', act: { kind: 'touch', x, y, down } });
  }
  /** 麦克风声源：WAV（同时作为下次上电的声源）/ 安静 / 实时（之后 micPush 推浏览器麦克风） */
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
  /** USB ↔ 外接 5 V：在线生效（进输入日志），也作为下次上电的初始供电 */
  setPower(mode: PowerMode) {
    this.o.power = mode;
    this.send({ type: 'power', mode });
  }
  harness(): Harness {
    return { ...this.o.harness };
  }
  /** 改线束：在线生效（进输入日志），也作为下次上电的初始值 */
  setHarness(h: Harness) {
    this.o.harness = { ...this.o.harness, ...h };
    this.send({ type: 'harness', ...h });
  }
  press(down: boolean) {
    this.send({ type: 'gpio', pin: this.bootPin, level: down ? 0 : -1 });
  }
  /** 外部按键：按下把引脚拉到地，松开高阻（进输入日志 gpioN=0|z） */
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
  /** 改环境（湿度 / 气压也能改；温度同 setTemp 夹在 -10..45） */
  setEnv(e: Partial<Env>) {
    Object.assign(this.env, e);
    if (e.temp !== undefined) this.env.temp = Math.max(-10, Math.min(45, e.temp));
    this.send({ type: 'env', ...this.sensed() });
  }
  /** 虚拟电脑往 USB 串口（CDC-ACM）打字 */
  usbCdc(text: string) {
    this.send({ type: 'usbcdc', text });
  }
  /** 电位器滑片电压（mV）进 ADC 脚（进输入日志） */
  analog(pin: number, mv: number) {
    this.send({ type: 'analog', pin, mv });
  }
  setOffset(d: number) {
    this.sensorOffset = d;
    this.send({ type: 'env', ...this.sensed() });
  }
  dispose() {
    this.w.terminate();
  }
  pause() {
    this.send({ type: 'pause' });
  }
  resume() {
    this.send({ type: 'run' });
  }
  /** 墙钟倍速（只改模拟跑得多快，不改模拟时间里的结果） */
  speed(factor: number) {
    this.send({ type: 'speed', factor });
  }
  /** 往 UART0 RX 打字（进输入日志，可重放） */
  uart(text: string) {
    this.send({ type: 'uart', text });
  }
  private snapWaiters: ((s: Snapshot) => void)[] = [];
  private seekWaiter: ((s: Snapshot) => void) | null = null;
  private markWaiters = new Map<number, (tMs: number) => void>();
  private markId = 0;
  /** 本次上电以来的输入日志 + 串口全文 + 观察记录（不打断运行） */
  snapshot(): Promise<Snapshot> {
    return new Promise((r) => {
      this.snapWaiters.push(r);
      this.send({ type: 'snapshot' });
    });
  }
  /** 此刻的模拟时间（毫秒）；在它之前发出的输入都已施加 */
  mark(): Promise<number> {
    const id = ++this.markId;
    return new Promise((r) => {
      this.markWaiters.set(id, r);
      this.send({ type: 'mark', id });
    });
  }
  /** 回退：收尾当前运行，按 job 重新上电并快进到 untilMs 停住（暂停）。之后 resume() 从那一刻接着实时跑 */
  async seek(job: SeekJob): Promise<Snapshot> {
    await this.closeRun();
    const [wasm, rom] = [await loadWasm(), await loadRom(imageChip(job.flash))];
    this.flash = job.flash;
    this.o.fw = job.flash;
    this.o.i2c = job.i2c;
    this.o.lcd = job.lcd;
    this.o.servo = job.servo;
    this.o.encoder = job.encoder;
    // 回退停住以后的距离 = 日志里最后一次 dist（下次上电的初始距离）
    const dl = [...job.events].reverse().find((e) => e.kind === 'dist' && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    this.o.sonar = job.sonar ? { ...job.sonar, cm: dl && dl.kind === 'dist' ? dl.cm : (this.o.sonar?.cm ?? 100) } : undefined;
    this.o.touchInt = job.touchInt;
    const imu = [...job.events].reverse().find((e) => e.kind === 'imu' && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    this.pose = imu && imu.kind === 'imu' ? { pitch: imu.pitch, roll: imu.roll, yaw: imu.yaw } : { pitch: 0, roll: 0, yaw: 0 };
    // 回退停住以后的供电 = 日志里最后一次切换（没有就是上电时的）
    const sup = [...job.events].reverse().find((e) => e.kind === 'supply' && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    this.o.power = sup && sup.kind === 'supply' ? sup.mode : job.power;
    const last = [...job.events].reverse().find((e) => e.kind === 'env' && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    this.env = last && last.kind === 'env' ? { temp: last.temp, humidity: last.humidity, pressure: last.pressure } : { ...job.env };
    this.sensorOffset = 0;
    // 线束同理：回退停住以后 = 日志里最后一次设置
    const before = (k: 'i2cwire' | 'antenna') => [...job.events].reverse().find((e) => e.kind === k && Math.round(e.tMs * 160000) < Math.round(job.untilMs * 160000));
    const iw = before('i2cwire');
    const an = before('antenna');
    this.o.harness = { i2cWire: iw && iw.kind === 'i2cwire' ? iw.cm : undefined, antenna: an && an.kind === 'antenna' ? an.db : undefined };
    Object.assign(this.frame, emptyFrame());
    return new Promise((r) => {
      this.seekWaiter = r;
      this.send({ type: 'seek', wasm: wasm.slice(0), rom: rom.slice(0), flash: job.flash.slice(0), i2c: job.i2c, env: job.env, lcd: job.lcd, servo: job.servo, power: job.power, encoder: job.encoder, sonar: job.sonar ? { ...job.sonar, cm: NaN } : undefined, touchInt: job.touchInt, i2s: job.i2s, micWav: job.micWav?.slice(0), micName: job.micName, events: job.events, untilMs: job.untilMs });
    });
  }
  /** 回退停住以后从那一刻接着实时跑：这次运行重新算"进行中" */
  continueRun() {
    this.live = true;
    this.resume();
  }
  private logWaiters: ((l: InputLog) => void)[] = [];
  /** 本次上电以来的输入日志（模拟时间戳，见 inputlog.ts；toScript 导出给 CLI --inputs） */
  inputLog(): Promise<InputLog> {
    return new Promise((r) => {
      this.logWaiters.push(r);
      this.send({ type: 'getInputLog' });
    });
  }
  /** 逻辑分析仪观察的 GPIO（位掩码）；PWM / WS2812 / I2C 事件不用观察也会记 */
  watchIo(lo: number, hi: number) {
    this.send({ type: 'ioWatch', lo, hi });
  }
  /** 每个时间片采样这些引脚的 PWM（蜂鸣器），变化经 onPwm 回调 */
  watchPwm(pins: number[]) {
    this.send({ type: 'watchPwm', pins });
  }
}
