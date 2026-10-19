// 整页唯一的实时模拟 + 3D 台面。步骤切换只换面板，不碰这里，所以模拟时间是连续的。
import { createBench, type PartSpec, type SceneSpec } from '../board3d';
import type { ScenePickApi } from '../scene-api';
import { LiveSim, type SeekJob } from '../live';
import type { Snapshot } from '../worker';
import type { FromWorker } from '../worker';
import { saveBom } from './steps/shop';
import { push as pushBom } from './bom';
import { BuzzerAudio } from '../audio';
import { fetchBuf, imageChip } from '../assets';
import { expandLevels, type Level } from '../checks';
import levelsJson from '../../../firmware/levels.json';
import type { AppState, Env, Session, WorkDef } from './types';
import type { Store } from './store';
import { currentTheme, onTheme } from '../theme';
import { IoStore, decodeEvents } from './iotrace';
import type { UsbView } from '../usb3d';
import { netFeed } from './netfeed';
import { PoseRate } from '../imupose';
import { MicInput } from '../micinput';
import { chipOf, loadExamples } from './examples';

export { WORKS } from './works';
import { wkey } from './works';

/** 串口里 weather 固件的读数行（格式由第 06 关任务书规定） */
// 气象站固件单空格、bme280 示例两个空格分隔，都要认
const READING = /T=(-?[\d.]+) C\s+H=([\d.]+) %\s+P=([\d.]+) hPa/g;
/** s3-imu / s3-qmi8658 的读数行 */
const IMU_LINE = /(?:IMU|POSE) pitch=(-?[\d.]+) roll=(-?[\d.]+)(?:[^\n]*?gyro=\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\))?/g;

export interface SessionHooks {
  /** 串口新文本（外壳把它追加到左栏串口） */
  onConsole(text: string): void;
  /** 回退以后串口换成那一刻为止的全文 */
  onConsoleReset?(text: string): void;
}

export interface SessionOpts {
  /** 上次在采购页"摆上实验台"存下的场景；没有就用作品默认台面（examples.json） */
  placed?: { scene: SceneSpec; ext5v: boolean } | null;
  /** 没有示例的作品（选板 custom）按选板结果定芯片；有示例时以示例为准 */
  chip?: 'esp32c3' | 'esp32s3';
  /** 按零件生成的检查点（custom-<n>，U-17），接在 levels.json 后面 */
  levels?: Level[];
}

export async function createSession(stage: HTMLElement, work: WorkDef, store: Store<AppState>, hooks: SessionHooks, opts: SessionOpts = {}): Promise<Session> {
  const bench = createBench(stage);
  // 拾取接口由 board3d 另行实现；没实现的方法就不调（点不到台面，但不报错）
  const pick = bench as unknown as Partial<ScenePickApi>;
  // 3D 台面跟随页面主题（DESIGN §2 暗色）
  pick.setTheme?.(currentTheme());
  onTheme((t) => pick.setTheme?.(t));
  const levels = [...expandLevels(levelsJson as Level[]), ...(opts.levels ?? [])];
  let consoleBuf = '';
  let lastOled: Uint8Array | null = null;
  let lastLcd: Uint8Array | null = null;
  let tail = '';
  const consoleSubs = new Set<(text: string) => void>();
  // 蜂鸣器声音整页一份（默认静音）：实验台、成品共用，声音开关在成品页
  const audio = new BuzzerAudio();

  const examples = await loadExamples();
  const ex = work.example ? examples.find((e) => e.id === work.example) : undefined;
  // 摆过清单就用清单的零件，机位仍用作品默认
  const scene: SceneSpec = opts.placed ? { ...ex?.scene, ...opts.placed.scene } : (ex?.scene ?? { parts: [] });
  // 示例清单里缺省芯片是 C3；没有示例（真正的空白）摆 S3 开发板
  const chip = ex ? chipOf(ex) : (opts.chip ?? 'esp32s3');
  bench.setBoard(chip);
  bench.setScene(scene);
  const buzzerPins = scene.parts.flatMap((p) => (p.type === 'buzzer' ? [p.pin] : []));
  audio.setPins(buzzerPins);
  audio.setSpeaker(scene.parts.some((p) => p.type === 'max98357a'));
  /** I2S 音频器件（引脚按芯片固定）：喇叭的声音走同一个声音开关；麦克风听 1 kHz 测试 WAV */
  const i2sOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'max98357a' || p.type === 'inmp441' ? [p.type] : []));

  const i2cOf = (parts: PartSpec[]) => {
    const kind: Record<string, string> = { oled: 'ssd1306', bme280: 'bme280', mpu6050: 'mpu6050', qmi8658: 'qmi8658', cst816s: 'cst816s' };
    return parts.flatMap((p) => ('addr' in p && kind[p.type] ? [{ kind: kind[p.type], addr: p.addr }] : []));
  };
  /** 触摸 INT 接的 GPIO（台面上的 CST816S） */
  const touchIntOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'cst816s' ? [p.int] : []))[0];
  const poseRate = new PoseRate();
  let poseIdle = 0;

  /** 编码器 / 超声波（台面上第一个）：上电时接到内核里 */
  const encoderOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'encoder' ? [{ a: p.a, b: p.b, ...(p.sw !== undefined ? { sw: p.sw } : {}) }] : []))[0];
  const sonarOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'hcsr04' ? [{ trig: p.trig, echo: p.echo, cm: s.distance }] : []))[0];
  /** 舵机信号脚（台面上第一个舵机）：供电网络里的舵机负载接在它上 */
  const servoOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'servo' ? [p.pin] : []))[0];
  const powerMode = () => (s.power?.ext5v ? 'ext' : 'usb') as 'usb' | 'ext';
  const brownSubs = new Set<(tSec: number) => void>();
  const tickSubs = new Set<(m: Extract<FromWorker, { type: 'tick' }>) => void>();
  const bootSubs = new Set<() => void>();
  const endSubs = new Set<(snap: Snapshot) => void>();
  // 逻辑分析仪：事件仓库整页一份（跟着每次上电 / 回退重放 reset），观察哪些 GPIO 由分析仪决定
  const io = new IoStore();
  const ioSubs = new Set<() => void>();
  const harnessSubs = new Set<(text: string) => void>();
  const mic = new MicInput();
  const usbSubs = new Set<(v: UsbView | null) => void>();
  let ioMask = [0, 0];
  const defaultIoPins = (sc: SceneSpec, c: string) => {
    const pins = new Set<number>([c === 'esp32s3' ? 0 : 9]);
    for (const p of sc.parts) {
      if ('pin' in p && p.type !== 'pot') pins.add(p.pin);
      // 逻辑分析仪默认看编码器 A / B / 按键、超声波 Trig / Echo
      if (p.type === 'encoder') [p.a, p.b, ...(p.sw !== undefined ? [p.sw] : [])].forEach((x) => pins.add(x));
      if (p.type === 'hcsr04') [p.trig, p.echo].forEach((x) => pins.add(x));
      if ('sda' in p) {
        pins.add(p.sda);
        pins.add(p.scl);
      }
    }
    return [...pins].sort((a, b) => a - b);
  };
  const bumpEdit = () => store.set((st) => ({ editRev: st.editRev + 1 }));
  const lastImu = (text: string) => {
    let m: RegExpExecArray | null = null;
    for (const x of text.matchAll(IMU_LINE)) m = x;
    return m ? { pitch: Number(m[1]), roll: Number(m[2]), gyro: m[3] !== undefined ? ([Number(m[3]), Number(m[4]), Number(m[5])] as [number, number, number]) : null } : null;
  };
  let imuTail = '';
  const lastReading = (text: string) => {
    let m: RegExpExecArray | null = null;
    for (const x of text.matchAll(READING)) m = x;
    return m ? { t: Number(m[1]), h: Number(m[2]), p: Number(m[3]) } : null;
  };

  const s: Session = {
    bench,
    pick,
    sim: null,
    scene,
    power: opts.placed ? { ext5v: opts.placed.ext5v } : null,
    heat: null,
    wireMods: {},
    bootCount: 0,
    setHeat(part) {
      s.heat = part;
      pick.setHeat?.(part);
      bumpEdit();
    },
    setPower(ext5v) {
      const had = !!s.power?.ext5v;
      s.power = { ext5v };
      // 供电网络在线切换（进输入日志 power=usb|ext，回退时按原来的时刻重放）
      if (had !== ext5v) s.sim?.setPower(ext5v ? 'ext' : 'usb');
      // 清单跟着改：外接 5 V = 加电源适配器 + DC 母座；切回 USB = 去掉
      if (had !== ext5v) {
        let h = store.get().bom;
        for (const partId of ['psu-5v2a', 'dc-jack']) h = pushBom(h, ext5v ? { t: 'add', partId } : { t: 'remove', partId });
        if (h !== store.get().bom) {
          saveBom(wkey(work), h);
          store.set({ bom: h });
        }
      }
      bumpEdit();
    },
    setWireMods(m) {
      s.wireMods = m;
      bumpEdit();
    },
    restoreScene(next, power) {
      if (JSON.stringify(next) !== JSON.stringify(s.scene)) bench.setScene(next);
      s.scene = next;
      s.power = power;
      s.sim?.configure({ i2c: i2cOf(next.parts), lcd: next.parts.some((p) => p.type === 'gc9a01'), servo: servoOf(next.parts), encoder: encoderOf(next.parts), sonar: sonarOf(next.parts), touchInt: touchIntOf(next.parts), i2s: i2sOf(next.parts) });
      audio.setPins(next.parts.flatMap((p) => (p.type === 'buzzer' ? [p.pin] : [])));
      audio.setSpeaker(next.parts.some((p) => p.type === 'max98357a'));
      bumpEdit();
    },
    onTick(cb) {
      tickSubs.add(cb);
      return () => tickSubs.delete(cb);
    },
    onBoot(cb) {
      bootSubs.add(cb);
      return () => bootSubs.delete(cb);
    },
    onRunEnd(cb) {
      endSubs.add(cb);
      return () => endSubs.delete(cb);
    },
    onBrownout(cb) {
      brownSubs.add(cb);
      return () => brownSubs.delete(cb);
    },
    snapshot: () => s.sim?.snapshot() ?? Promise.resolve(null),
    mark: () => s.sim?.mark() ?? Promise.resolve(0),
    async seek(job: SeekJob) {
      const sim = s.sim!;
      const snap = await sim.seek({ ...job, i2s: job.i2s ?? i2sOf(s.scene.parts) });
      consoleBuf = snap.stdout.length > 200_000 ? snap.stdout.slice(-150_000) : snap.stdout;
      tail = consoleBuf.slice(-80);
      hooks.onConsoleReset?.(consoleBuf);
      s.fwBuf = job.flash;
      s.fwSize = job.flash.byteLength;
      s.chip = snap.log.chip ?? s.chip;
      audio.reset();
      bench.setPowered(true);
      store.set({ running: false, reading: lastReading(snap.stdout), imu: lastImu(snap.stdout), simSeconds: snap.simSeconds, env: { ...sim.env }, pose: { ...sim.pose }, touch: null });
      bench.setPose(s.hasImu() ? sim.pose : null);
      // 回退停住那一刻的供电（日志里最后一次切换）、线束
      s.power = { ext5v: sim.powerMode() === 'ext' };
      s.harness = sim.harness();
      return snap;
    },
    continueRun() {
      s.sim?.continueRun();
    },
    applyScene(next, power, label) {
      s.sceneLabel = label;
      const devs = (sc: SceneSpec) => JSON.stringify([i2cOf(sc.parts), sc.parts.some((p) => p.type === 'gc9a01'), servoOf(sc.parts) ?? null, encoderOf(sc.parts) ?? null, sonarOf(sc.parts)?.trig ?? null, sonarOf(sc.parts)?.echo ?? null, touchIntOf(sc.parts) ?? null, i2sOf(sc.parts)]);
      const rebootNeeded = devs(next) !== devs(s.scene);
      const same = JSON.stringify(next) === JSON.stringify(s.scene);
      const extBefore = !!s.power?.ext5v;
      s.scene = next;
      s.power = power;
      if (!same) bench.setScene(next);
      if (!s.hasImu()) bench.setPose(null);
      audio.setPins(next.parts.flatMap((p) => (p.type === 'buzzer' ? [p.pin] : [])));
      const hadExt = extBefore;
      if (s.sim && rebootNeeded) {
        s.sim.configure({ i2c: i2cOf(next.parts), lcd: next.parts.some((p) => p.type === 'gc9a01'), servo: servoOf(next.parts), encoder: encoderOf(next.parts), sonar: sonarOf(next.parts), touchInt: touchIntOf(next.parts), i2s: i2sOf(next.parts) });
        audio.setSpeaker(next.parts.some((p) => p.type === 'max98357a'));
        s.sim.setPower(powerMode());
        s.reboot();
      } else if (s.sim && hadExt !== !!power?.ext5v) s.sim.setPower(powerMode());
      store.set((st) => ({ sceneRev: st.sceneRev + 1 }));
    },
    fwName: ex ? `${ex.id}/flash.bin` : '',
    fwSize: 0,
    chip,
    levels,
    frame: { pwm: [], pwmFreq: [], gpio: 0, enable: 0, gpioHi: 0, enableHi: 0, rgb: null, strips: {}, oled: null, lcd: null, elec: null, pins: null },
    distance: scene.parts.flatMap((p) => (p.type === 'hcsr04' ? [p.cm ?? 25] : []))[0] ?? 25,
    turnEncoder(steps) {
      s.sim?.turnEncoder(steps);
    },
    pressEncoder(down) {
      s.sim?.pressEncoder(down);
    },
    setDistance(cm) {
      const c = cm < 0 ? -1 : Math.round(cm * 10) / 10;
      if (c === s.distance) return;
      s.distance = c;
      bench.setDistance(c);
      s.sim?.setDistance(c);
    },
    fwBuf: null,
    audio,
    sensorOffset: 0,
    reboot() {
      if (!s.sim) return;
      bench.setPowered(true);
      s.sim.reset();
    },
    loadFirmware(buf, name) {
      s.fwBuf = buf;
      s.fwName = name;
      s.fwSize = buf.byteLength;
      s.chip = imageChip(buf);
      bench.setBoard(s.chip);
      bench.setScene(s.scene);
      bench.setPowered(true);
      if (!s.sim) {
        s.sim = makeSim(buf);
        s.sim.start();
      } else s.sim.load(buf);
    },
    pressBoot(down) {
      s.sim?.press(down);
    },
    pressPin(pin, down) {
      s.sim?.pressPin(pin, down);
    },
    // 示例预设的旋钮位置（examples.json controls 里的 analog.value）
    micSource: 'sine1k.wav',
    async setMicSource(src) {
      s.micSource = src;
      mic.stop();
      if (src === 'live') {
        const err = await mic.start((rate, data) => s.sim?.micPush(rate, data));
        if (!err) {
          s.sim?.setMic('live');
          return '';
        }
        // 没有权限 / 设备：换回测试声音
        await s.setMicSource('sine1k.wav');
        return `${err}，已换回 1 kHz 测试声音`;
      }
      if (src === 'silence') s.sim?.setMic('silence');
      else s.sim?.setMic('wav', await fetchBuf(`./audio/${src}`), src);
      return '';
    },
    analog: new Map((ex?.controls ?? []).flatMap((c) => (typeof c === 'object' && c.type === 'analog' ? [[c.pin, c.value] as [number, number]] : []))),
    setAnalog(pin, mv) {
      s.analog.set(pin, mv);
      s.sim?.analog(pin, mv);
    },
    setEnv(e: Partial<Env>) {
      s.sim?.setEnv(e);
      store.set((st) => ({ env: { ...st.env, ...e, ...(s.sim ? { temp: s.sim.env.temp } : {}) } }));
    },
    hasImu: () => s.scene.parts.some((p) => p.type === 'mpu6050' || p.type === 'qmi8658'),
    setPose(p) {
      const pose = { pitch: p.pitch, roll: p.roll, yaw: p.yaw };
      // 拖动 / 滑块的速度 → 陀螺读到的角速率；停下 150 ms 补一次速率 0（陀螺回零），记进输入日志
      const rates = poseRate.push(pose, performance.now());
      s.sim?.setImu({ ...pose, rates });
      bench.setPose(pose);
      store.set({ pose });
      clearTimeout(poseIdle);
      if (rates.some((v) => v !== 0))
        poseIdle = window.setTimeout(() => {
          poseRate.reset();
          s.sim?.setImu({ ...pose, rates: [0, 0, 0] });
        }, 150);
    },
    touch(x, y, down) {
      s.sim?.touch(x, y, down);
      store.set({ touch: { x: Math.round(x), y: Math.round(y), down } });
    },
    setSensorOffset(d) {
      s.sensorOffset = d;
      s.sim?.setOffset(d);
    },
    onConsole(cb) {
      consoleSubs.add(cb);
      return () => consoleSubs.delete(cb);
    },
    consoleText: () => consoleBuf,
    io,
    onIo(cb) {
      ioSubs.add(cb);
      return () => ioSubs.delete(cb);
    },
    ioPins() {
      const out: number[] = [];
      for (let p = 0; p < 64; p++) if ((p < 32 ? ioMask[0] >>> p : ioMask[1] >>> (p - 32)) & 1) out.push(p);
      return out;
    },
    harness: {},
    setHarness(h) {
      s.harness = { ...s.harness, ...h };
      s.sim?.setHarness(h);
      bumpEdit();
    },
    harnessText: '',
    onHarness(cb) {
      harnessSubs.add(cb);
      return () => harnessSubs.delete(cb);
    },
    usb: null,
    onUsb(cb) {
      usbSubs.add(cb);
      return () => usbSubs.delete(cb);
    },
    watchIo(pins) {
      ioMask = [0, 0];
      for (const p of pins) if (p >= 0 && p < 64) ioMask[p < 32 ? 0 : 1] |= 1 << p % 32;
      ioMask = [ioMask[0] >>> 0, ioMask[1] >>> 0];
      s.sim?.watchIo(ioMask[0], ioMask[1]);
    },
  };
  s.watchIo(defaultIoPins(scene, chip));

  function makeSim(fw: string | ArrayBuffer) {
    const sim: LiveSim = new LiveSim({
      fw,
      i2c: i2cOf(s.scene.parts),
      lcd: s.scene.parts.some((p) => p.type === 'gc9a01'),
      servo: servoOf(s.scene.parts),
      encoder: encoderOf(s.scene.parts),
      sonar: sonarOf(s.scene.parts),
      touchInt: touchIntOf(s.scene.parts),
      power: powerMode(),
      harness: s.harness,
      i2s: i2sOf(s.scene.parts),
      onPcm: (b) => audio.pushPcm(b),
      env: store.get().env,
      onUsb(v) {
        s.usb = v;
        bench.setUsb(v);
        for (const cb of [...usbSubs]) cb(v);
      },
      onNet: (m) => netFeed.update(m),
      onHarness(text) {
        s.harnessText = text;
        for (const cb of [...harnessSubs]) cb(text);
      },
      onConsole(text) {
        consoleBuf += text;
        if (consoleBuf.length > 200_000) consoleBuf = consoleBuf.slice(-150_000);
        hooks.onConsole(text);
        for (const cb of [...consoleSubs]) cb(text);
        // 读数行可能跨两次 tick，拼上一段尾巴再找
        const buf = tail + text;
        let m: RegExpExecArray | null = null;
        for (const x of buf.matchAll(READING)) m = x;
        tail = buf.slice(-80);
        if (m) store.set({ reading: { t: Number(m[1]), h: Number(m[2]), p: Number(m[3]) } });
        // IMU 读数行同样可能跨 tick：只在出现完整一行（有换行）时更新
        const ib = imuTail + text;
        const nl = ib.lastIndexOf('\n');
        if (nl >= 0) {
          const r = lastImu(ib.slice(0, nl));
          if (r) store.set({ imu: r });
        }
        imuTail = ib.slice(nl + 1).slice(-200);
      },
      onBoot(c) {
        s.chip = c;
        tail = '';
        audio.reset();
        if (buzzerPins.length) sim.watchPwm(buzzerPins);
        // 浏览器麦克风不跨上电：上电后重新接上
        if (s.micSource === 'live' && s.scene.parts.some((p) => p.type === 'inmp441')) void s.setMicSource('live');
        // 电位器位置不是上电参数：上电后作为第一个输入施加（旋钮还停在原处）
        for (const [pin, mv] of s.analog) sim.analog(pin, mv);
        s.bootCount++;
        imuTail = '';
        store.set((st) => ({ run: st.run + 1, running: true, reading: null, imu: null, touch: null }));
        for (const cb of [...bootSubs]) cb();
      },
      onRunEnd(snap) {
        for (const cb of [...endSubs]) cb(snap);
      },
      onIo(m) {
        if (m.reset) io.reset();
        io.coreDropped = m.dropped;
        if (m.data.byteLength) io.append(decodeEvents(m.data));
        for (const cb of [...ioSubs]) cb();
      },
      onSeekProgress(t) {
        store.set({ simSeconds: t });
      },
      onTick(m) {
        bench.setGpio(m.gpio, m.enable, m.pwm, m.gpioHi, m.enableHi);
        if (m.leds) bench.setRgb(m.leds[0] ?? [0, 0, 0]);
        s.frame.pwm = m.pwm;
        s.frame.pwmFreq = m.pwmFreq;
        s.frame.gpio = m.gpio;
        s.frame.enable = m.enable;
        s.frame.gpioHi = m.gpioHi;
        s.frame.enableHi = m.enableHi;
        if (m.leds) s.frame.rgb = m.leds[0] ?? null;
        if (m.strips) {
          s.frame.strips = { ...s.frame.strips, ...m.strips };
          for (const [pin, leds] of Object.entries(m.strips)) bench.setStrip(Number(pin), leds);
        }
        if (m.elec) {
          s.frame.elec = m.elec;
          // 舵机角度用二阶动力学的结果（有加速、过冲；只影响观感，固件读不到）
          const sp = servoOf(s.scene.parts);
          if (sp !== undefined && m.elec.servoAngle !== null) bench.setServoAngle(sp, m.elec.servoAngle);
        }
        if (m.audio) {
          audio.setSim(m.audio);
          bench.setAudio(m.audio.frames > 0 ? m.audio.rms : 0, m.audio.micFrames > 0 ? 0.35 : 0);
        }
        for (const t of m.brownouts ?? []) for (const cb of [...brownSubs]) cb(t);
        if (m.pins) {
          const prev = s.frame.pins;
          s.frame.pins = m.pins;
          if (m.pins.encPos !== null) bench.setEncoder(m.pins.encPos);
          if (m.pins.pings !== null && m.pins.pings !== (prev?.pings ?? 0)) bench.pingSonar();
        }
        for (const cb of [...tickSubs]) cb(m);
        const st = store.get();
        if (Math.abs(st.simSeconds - m.simSeconds) >= 0.05 || st.running !== m.running) store.set({ simSeconds: m.simSeconds, running: m.running });
      },
      onPwm: (ev, t) => audio.push(ev, t),
      onFrame(f) {
        if (f.oled && f.oled !== lastOled) {
          lastOled = f.oled;
          s.frame.oled = f.oled;
          bench.setOled(f.oled);
        }
        if (f.lcd && f.lcd !== lastLcd) {
          lastLcd = f.lcd;
          s.frame.lcd = f.lcd;
          bench.setLcd(f.lcd);
        }
      },
    });
    // 观察设置在上电之前发出（worker 按顺序处理）：从第 0 个周期就按这份掩码记，命令行 --trace-pins 同一份就能对拍
    sim.watchIo(ioMask[0], ioMask[1]);
    if (s.scene.parts.some((p) => p.type === 'inmp441')) {
      // 上电前先把测试声音挂上（浏览器麦克风要等上电后再接，见 onBoot）
      const wav = s.micSource.endsWith('.wav') ? s.micSource : 'sine1k.wav';
      void fetchBuf(`./audio/${wav}`)
        .then((b) => (s.micSource === 'silence' ? sim.setMic('silence') : sim.setMic('wav', b, wav)))
        .catch(() => {});
    }
    return sim;
  }

  bench.onKey((pin, down) => s.pressPin(pin, down));
  // 3D 台面上拖 / 滚编码器、拖障碍物：进模拟（输入日志）
  bench.onEncoder((steps) => s.turnEncoder(steps));
  bench.onEncoderPress((down) => s.pressEncoder(down));
  bench.onDistance((cm) => {
    if (cm === s.distance) return;
    s.distance = cm;
    s.sim?.setDistance(cm);
  });
  // 拖台面上的 IMU 模块 = 端起面包板转（P2-03）；点触摸圆屏 = 手指（P2-02）
  bench.onPose((p) => s.setPose(p));
  bench.onTouch((x, y, down) => s.touch(x, y, down));
  bench.onButton((name, down) => {
    if (name === 'BOOT') s.pressBoot(down);
    if (name === 'RST' && !down) s.reboot();
  });

  if (ex) {
    const buf = await fetchBuf(`./fw/${ex.id}/flash.bin`);
    s.fwBuf = buf;
    s.fwSize = buf.byteLength;
    s.chip = imageChip(buf);
    bench.setPowered(true);
    s.sim = makeSim(buf);
    s.sim.start();
  } else bench.setPowered(false);
  return s;
}
