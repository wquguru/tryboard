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

interface Example {
  id: string;
  chip?: 'esp32c3' | 'esp32s3';
  scene?: SceneSpec;
}

export const WORKS: Record<string, WorkDef> = {
  weather: { id: 'weather', title: '桌面气象站', example: 'weather', checkpoints: ['01', '02', '03', '04', '05', '06'] },
  spin: { id: 'spin', title: '会转身的小黄', example: 'spin', checkpoints: ['01', '02', '05', '07-spin'] },
  lens: { id: 'lens', title: '透镜里的小人', example: 'lens', checkpoints: ['01', '02', '07-lens'] },
  blank: { id: 'blank', title: '空白实验台', example: null, checkpoints: [] },
};

/** 串口里 weather 固件的读数行（格式由第 06 关任务书规定） */
const READING = /T=(-?[\d.]+) C H=([\d.]+) % P=([\d.]+) hPa/g;

export interface SessionHooks {
  /** 串口新文本（外壳把它追加到左栏串口） */
  onConsole(text: string): void;
  /** 回退以后串口换成那一刻为止的全文 */
  onConsoleReset?(text: string): void;
}

export interface SessionOpts {
  /** 上次在采购页"摆上实验台"存下的场景；没有就用作品默认台面（examples.json） */
  placed?: { scene: SceneSpec; ext5v: boolean } | null;
}

export async function createSession(stage: HTMLElement, work: WorkDef, store: Store<AppState>, hooks: SessionHooks, opts: SessionOpts = {}): Promise<Session> {
  const bench = createBench(stage);
  // 拾取接口由 board3d 另行实现；没实现的方法就不调（点不到台面，但不报错）
  const pick = bench as unknown as Partial<ScenePickApi>;
  // 3D 台面跟随页面主题（DESIGN §2 暗色）
  pick.setTheme?.(currentTheme());
  onTheme((t) => pick.setTheme?.(t));
  const levels = expandLevels(levelsJson as Level[]);
  let consoleBuf = '';
  let lastOled: Uint8Array | null = null;
  let lastLcd: Uint8Array | null = null;
  let tail = '';
  const consoleSubs = new Set<(text: string) => void>();
  // 蜂鸣器声音整页一份（默认静音）：实验台、成品共用，声音开关在成品页
  const audio = new BuzzerAudio();

  const examples: Example[] = await fetch('./fw/examples.json')
    .then((r) => r.json())
    .catch(() => []);
  const ex = work.example ? examples.find((e) => e.id === work.example) : undefined;
  // 摆过清单就用清单的零件，机位仍用作品默认
  const scene: SceneSpec = opts.placed ? { ...ex?.scene, ...opts.placed.scene } : (ex?.scene ?? { parts: [] });
  const chip = ex?.chip ?? 'esp32s3';
  bench.setBoard(chip);
  bench.setScene(scene);
  const buzzerPins = scene.parts.flatMap((p) => (p.type === 'buzzer' ? [p.pin] : []));
  audio.setPins(buzzerPins);

  const i2cOf = (parts: PartSpec[]) => {
    const kind: Record<string, string> = { oled: 'ssd1306', bme280: 'bme280' };
    return parts.flatMap((p) => ('addr' in p && kind[p.type] ? [{ kind: kind[p.type], addr: p.addr }] : []));
  };

  const tickSubs = new Set<(m: Extract<FromWorker, { type: 'tick' }>) => void>();
  const bootSubs = new Set<() => void>();
  const endSubs = new Set<(snap: Snapshot) => void>();
  const bumpEdit = () => store.set((st) => ({ editRev: st.editRev + 1 }));
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
      // 清单跟着改：外接 5 V = 加电源适配器 + DC 母座；切回 USB = 去掉（只改清单和显示，欠压模拟属于 P1）
      if (had !== ext5v) {
        let h = store.get().bom;
        for (const partId of ['psu-5v2a', 'dc-jack']) h = pushBom(h, ext5v ? { t: 'add', partId } : { t: 'remove', partId });
        if (h !== store.get().bom) {
          saveBom(work.id, h);
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
      audio.setPins(next.parts.flatMap((p) => (p.type === 'buzzer' ? [p.pin] : [])));
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
    snapshot: () => s.sim?.snapshot() ?? Promise.resolve(null),
    mark: () => s.sim?.mark() ?? Promise.resolve(0),
    async seek(job: SeekJob) {
      const sim = s.sim!;
      const snap = await sim.seek(job);
      consoleBuf = snap.stdout.length > 200_000 ? snap.stdout.slice(-150_000) : snap.stdout;
      tail = consoleBuf.slice(-80);
      hooks.onConsoleReset?.(consoleBuf);
      s.fwBuf = job.flash;
      s.fwSize = job.flash.byteLength;
      s.chip = snap.log.chip ?? s.chip;
      audio.reset();
      bench.setPowered(true);
      store.set({ running: false, reading: lastReading(snap.stdout), simSeconds: snap.simSeconds, env: { ...sim.env } });
      return snap;
    },
    continueRun() {
      s.sim?.continueRun();
    },
    applyScene(next, power) {
      const devs = (sc: SceneSpec) => JSON.stringify([i2cOf(sc.parts), sc.parts.some((p) => p.type === 'gc9a01')]);
      const rebootNeeded = devs(next) !== devs(s.scene);
      const same = JSON.stringify(next) === JSON.stringify(s.scene);
      s.scene = next;
      s.power = power;
      if (!same) bench.setScene(next);
      if (s.sim && rebootNeeded) {
        s.sim.configure({ i2c: i2cOf(next.parts), lcd: next.parts.some((p) => p.type === 'gc9a01') });
        s.reboot();
      }
      store.set((st) => ({ sceneRev: st.sceneRev + 1 }));
    },
    fwName: ex ? `${ex.id}/flash.bin` : '',
    fwSize: 0,
    chip,
    levels,
    frame: { pwm: [], pwmFreq: [], gpio: 0, enable: 0, gpioHi: 0, enableHi: 0, rgb: null, oled: null, lcd: null },
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
    setEnv(e: Partial<Env>) {
      s.sim?.setEnv(e);
      store.set((st) => ({ env: { ...st.env, ...e, ...(s.sim ? { temp: s.sim.env.temp } : {}) } }));
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
  };

  function makeSim(fw: string | ArrayBuffer) {
    const sim = new LiveSim({
      fw,
      i2c: i2cOf(s.scene.parts),
      lcd: s.scene.parts.some((p) => p.type === 'gc9a01'),
      env: store.get().env,
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
      },
      onBoot(c) {
        s.chip = c;
        tail = '';
        audio.reset();
        if (buzzerPins.length) sim.watchPwm(buzzerPins);
        s.bootCount++;
        store.set((st) => ({ run: st.run + 1, running: true, reading: null }));
        for (const cb of [...bootSubs]) cb();
      },
      onRunEnd(snap) {
        for (const cb of [...endSubs]) cb(snap);
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
    return sim;
  }

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
