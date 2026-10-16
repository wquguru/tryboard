// 首页 / 关卡页用的实时模拟：起一个 worker.ts，跑一份固件，把每帧状态交给视图。
import { fetchBuf, imageChip, loadRom, loadWasm } from './assets';
import type { Env, FromWorker, PwmEvent, ToWorker } from './worker';
import type { InputLog } from './inputlog';
import { emptyFrame, type LiveFrame } from './views/common';

export interface LiveOptions {
  /** 固件 URL，或已经读进来的镜像（用户上传的） */
  fw: string | ArrayBuffer;
  i2c: { kind: string; addr: number }[];
  env: Env;
  lcd?: boolean;
  onConsole?(text: string): void;
  onFrame?(f: LiveFrame, simSeconds: number): void;
  /** 原始 tick（引脚电平、PWM），给要驱动 3D 台面的页面用 */
  onTick?(m: Extract<FromWorker, { type: 'tick' }>): void;
  /** 固件已加载、开始运行（每次 start / reset / load 一次） */
  onBoot?(chip: 'esp32c3' | 'esp32s3'): void;
  /** watchPwm 引脚上的 PWM 变化（带模拟时刻），接 audio.ts 的 BuzzerAudio.push */
  onPwm?(events: PwmEvent[] | undefined, simSeconds: number): void;
}

export class LiveSim {
  private w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private flash: ArrayBuffer | null = null;
  readonly frame: LiveFrame = emptyFrame();
  bootPin = 0;
  env: Env;
  /** 传感器读数相对室温的偏移（装配时传感器贴着芯片会偏高） */
  sensorOffset = 0;
  constructor(private o: LiveOptions) {
    this.env = { ...o.env };
    this.w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'booted') {
        this.bootPin = m.bootPin;
        this.send({ type: 'run' });
        o.onBoot?.(m.chip);
      } else if (m.type === 'tick') {
        if (m.console) o.onConsole?.(m.console);
        o.onTick?.(m);
        this.frame.pwm = m.pwm;
        this.frame.running = m.running;
        if (m.leds) this.frame.rgb = m.leds[0] ?? null;
        o.onFrame?.(this.frame, m.simSeconds);
        o.onPwm?.(m.pwmEvents, m.simSeconds);
      } else if (m.type === 'inputlog') {
        for (const r of this.logWaiters.splice(0)) r(m.log);
      } else if (m.type === 'lcd') {
        this.frame.lcd = m.pixels;
        o.onFrame?.(this.frame, NaN);
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
  async start() {
    const fw = this.o.fw;
    this.flash ??= typeof fw === 'string' ? await fetchBuf(fw) : fw;
    const [wasm, flash] = [await loadWasm(), this.flash];
    const rom = await loadRom(imageChip(flash));
    Object.assign(this.frame, emptyFrame());
    this.send({ type: 'boot', wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), i2c: this.o.i2c, env: this.sensed(), lcd: this.o.lcd });
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
  press(down: boolean) {
    this.send({ type: 'gpio', pin: this.bootPin, level: down ? 0 : -1 });
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
  private logWaiters: ((l: InputLog) => void)[] = [];
  /** 本次上电以来的输入日志（模拟时间戳，见 inputlog.ts；toScript 导出给 CLI --inputs） */
  inputLog(): Promise<InputLog> {
    return new Promise((r) => {
      this.logWaiters.push(r);
      this.send({ type: 'getInputLog' });
    });
  }
  /** 每个时间片采样这些引脚的 PWM（蜂鸣器），变化经 onPwm 回调 */
  watchPwm(pins: number[]) {
    this.send({ type: 'watchPwm', pins });
  }
}
