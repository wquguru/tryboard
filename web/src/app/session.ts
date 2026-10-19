// The page's single live sim + 3D stage. Step switches never touch it, so sim time stays continuous.
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
import { taskStore } from './tasktrace';
import type { UsbView } from '../usb3d';
import { bleFeed } from './blepane';
import { netFeed, netPreset, realnetSwitch } from './netfeed';
import { PoseRate } from '../imupose';
import { MicInput } from '../micinput';
import { chipOf, loadExamples } from './examples';

export { WORKS } from './works';
import { wkey } from './works';
import { BOOT_GPIO, type SimChip } from '../chips';
import { t } from '../i18n';

/** weather firmware reading line (format set by level 06); accept single or double spaces (bme280 example). */
const READING = /T=(-?[\d.]+) C\s+H=([\d.]+) %\s+P=([\d.]+) hPa/g;
/** s3-imu / s3-qmi8658 reading line. */
const IMU_LINE = /(?:IMU|POSE) pitch=(-?[\d.]+) roll=(-?[\d.]+)(?:[^\n]*?gyro=\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\))?/g;

export interface SessionHooks {
  /** New serial text (the shell appends it to the serial view). */
  onConsole(text: string): void;
  /** After a rewind, serial is replaced by the full text up to that moment. */
  onConsoleReset?(text: string): void;
}

export interface SessionOpts {
  /** Scene saved by Shop's "place on bench"; otherwise the work's default (examples.json). */
  placed?: { scene: SceneSpec; ext5v: boolean } | null;
  /** Works without an example (custom) take the chip from the advisor; an example's chip wins. */
  chip?: 'esp32' | 'esp32c3' | 'esp32s3';
  /** Per-part checkpoints (custom-<n>, U-17), appended after levels.json. */
  levels?: Level[];
}

export async function createSession(stage: HTMLElement, work: WorkDef, store: Store<AppState>, hooks: SessionHooks, opts: SessionOpts = {}): Promise<Session> {
  const bench = createBench(stage);
  // board3d implements picking separately; missing methods are skipped (no picking, no error).
  const pick = bench as unknown as Partial<ScenePickApi>;
  // 3D stage follows the page theme (DESIGN §2 dark).
  pick.setTheme?.(currentTheme());
  onTheme((th) => pick.setTheme?.(th));
  const levels = [...expandLevels(levelsJson as Level[]), ...(opts.levels ?? [])];
  let consoleBuf = '';
  let lastOled: Uint8Array | null = null;
  let lastLcd: Uint8Array | null = null;
  let tail = '';
  const consoleSubs = new Set<(text: string) => void>();
  // One buzzer audio per page (muted by default), shared by bench and product.
  const audio = new BuzzerAudio();

  const examples = await loadExamples();
  const ex = work.example ? examples.find((e) => e.id === work.example) : undefined;
  // A placed list supplies the parts; camera stays at the work default.
  const scene: SceneSpec = opts.placed ? { ...ex?.scene, ...opts.placed.scene } : (ex?.scene ?? { parts: [] });
  // Examples default to C3; a truly blank work gets an S3 devkit.
  const chip = ex ? chipOf(ex) : (opts.chip ?? 'esp32s3');
  bench.setBoard(chip);
  bench.setScene(scene);
  const buzzerPins = scene.parts.flatMap((p) => (p.type === 'buzzer' ? [p.pin] : []));
  audio.setPins(buzzerPins);
  audio.setSpeaker(scene.parts.some((p) => p.type === 'max98357a'));
  /** I2S audio parts (pins fixed per chip): speaker shares the sound toggle; mic hears a 1 kHz test WAV. */
  const i2sOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'max98357a' || p.type === 'inmp441' ? [p.type] : []));

  const i2cOf = (parts: PartSpec[]) => {
    const kind: Record<string, string> = { oled: 'ssd1306', bme280: 'bme280', mpu6050: 'mpu6050', qmi8658: 'qmi8658', cst816s: 'cst816s' };
    return parts.flatMap((p) => ('addr' in p && kind[p.type] ? [{ kind: kind[p.type], addr: p.addr }] : []));
  };
  /** GPIO wired to touch INT (CST816S on the bench). */
  const touchIntOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'cst816s' ? [p.int] : []))[0];
  const poseRate = new PoseRate();
  let poseIdle = 0;

  /** First encoder / ultrasonic on the bench, attached to the core at power-on. */
  const encoderOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'encoder' ? [{ a: p.a, b: p.b, ...(p.sw !== undefined ? { sw: p.sw } : {}) }] : []))[0];
  const sonarOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'hcsr04' ? [{ trig: p.trig, echo: p.echo, cm: s.distance }] : []))[0];
  /** Signal pin of the first servo; the power network's servo load hangs on it. */
  const servoOf = (parts: PartSpec[]) => parts.flatMap((p) => (p.type === 'servo' ? [p.pin] : []))[0];
  const powerMode = () => (s.power?.ext5v ? 'ext' : 'usb') as 'usb' | 'ext';
  const brownSubs = new Set<(tSec: number) => void>();
  const tickSubs = new Set<(m: Extract<FromWorker, { type: 'tick' }>) => void>();
  const bootSubs = new Set<() => void>();
  const endSubs = new Set<(snap: Snapshot) => void>();
  // Logic analyzer: one event store per page (reset on each boot / replay); the analyzer picks watched GPIOs.
  const io = new IoStore();
  const ioSubs = new Set<() => void>();
  const harnessSubs = new Set<(text: string) => void>();
  const mic = new MicInput();
  const usbSubs = new Set<(v: UsbView | null) => void>();
  let ioMask = [0, 0];
  const defaultIoPins = (sc: SceneSpec, c: string) => {
    const pins = new Set<number>([BOOT_GPIO[c as SimChip] ?? 9]);
    for (const p of sc.parts) {
      if ('pin' in p && p.type !== 'pot') pins.add(p.pin);
      // Analyzer defaults: encoder A / B / switch, ultrasonic Trig / Echo.
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
      // Live power switch (input log power=usb|ext, replayed at the original time on rewind).
      if (had !== ext5v) s.sim?.setPower(ext5v ? 'ext' : 'usb');
      // The list follows: external 5 V adds adapter + DC jack; back to USB removes them.
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
      // Power (last switch in the log) and harness at the rewind moment.
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
    // Example preset knob position (analog.value in examples.json controls).
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
        // No permission / device: fall back to the test tone.
        await s.setMicSource('sine1k.wav');
        return t('{err}; switched back to the 1 kHz test tone', { err });
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
      // Drag/slider speed -> gyro rate; 150 ms after stopping, log a zero rate so the gyro settles.
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
    tasks: taskStore,
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
  // Real-network switch (C-03): while running, tell the worker directly (input log); a new power-on picks it up via makeSim realnet()
  realnetSwitch.subscribe(() => s.sim?.realnet(realnetSwitch.get()));
  // Network preset (D-01): same pattern; faults go straight to the running sim (netFault)
  netPreset.subscribe(() => s.sim?.netPreset(netPreset.get()));

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
      onBle: (u) => bleFeed.update(u),
      onUsb(v) {
        s.usb = v;
        bench.setUsb(v);
        for (const cb of [...usbSubs]) cb(v);
      },
      onNet: (m) => netFeed.update(m),
      realnet: () => realnetSwitch.get(),
      netPreset: () => netPreset.get(),
      onHarness(text) {
        s.harnessText = text;
        for (const cb of [...harnessSubs]) cb(text);
      },
      onConsole(text) {
        consoleBuf += text;
        if (consoleBuf.length > 200_000) consoleBuf = consoleBuf.slice(-150_000);
        hooks.onConsole(text);
        for (const cb of [...consoleSubs]) cb(text);
        // A reading line may span two ticks: prepend the previous tail.
        const buf = tail + text;
        let m: RegExpExecArray | null = null;
        for (const x of buf.matchAll(READING)) m = x;
        tail = buf.slice(-80);
        if (m) store.set({ reading: { t: Number(m[1]), h: Number(m[2]), p: Number(m[3]) } });
        // IMU lines may span ticks too: update only on a complete line.
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
        // The browser mic does not survive a boot: reattach after power-on.
        if (s.micSource === 'live' && s.scene.parts.some((p) => p.type === 'inmp441')) void s.setMicSource('live');
        // Pot position is not a boot parameter: apply it as the first input after boot.
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
      onTasks(m) {
        taskStore.onMsg(m);
      },
      onSeekProgress(t) {
        store.set({ simSeconds: t });
      },
      onTick(m) {
        taskStore.setNow(Math.round(m.simSeconds * 160_000_000));
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
          // Servo angle uses second-order dynamics (visual only; firmware cannot read it).
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
    // Send watch settings before boot (worker is ordered) so cycle 0 uses the mask, matching CLI --trace-pins.
    sim.watchIo(ioMask[0], ioMask[1]);
    if (s.scene.parts.some((p) => p.type === 'inmp441')) {
      // Attach the test tone before boot (browser mic waits until onBoot).
      const wav = s.micSource.endsWith('.wav') ? s.micSource : 'sine1k.wav';
      void fetchBuf(`./audio/${wav}`)
        .then((b) => (s.micSource === 'silence' ? sim.setMic('silence') : sim.setMic('wav', b, wav)))
        .catch(() => {});
    }
    return sim;
  }

  bench.onKey((pin, down) => s.pressPin(pin, down));
  // Dragging/scrolling the encoder or moving the obstacle feeds the sim (input log).
  bench.onEncoder((steps) => s.turnEncoder(steps));
  bench.onEncoderPress((down) => s.pressEncoder(down));
  bench.onDistance((cm) => {
    if (cm === s.distance) return;
    s.distance = cm;
    s.sim?.setDistance(cm);
  });
  // Dragging the IMU = tilting the breadboard (P2-03); tapping the touch display = a finger (P2-02).
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
