// 整页唯一的实时模拟 + 3D 台面。步骤切换只换面板，不碰这里，所以模拟时间是连续的。
import { createBench, type PartSpec, type SceneSpec } from '../board3d';
import type { ScenePickApi } from '../scene-api';
import { LiveSim } from '../live';
import { BuzzerAudio } from '../audio';
import { fetchBuf, imageChip } from '../assets';
import { expandLevels, type Level } from '../checks';
import levelsJson from '../../../firmware/levels.json';
import type { AppState, Env, Session, WorkDef } from './types';
import type { Store } from './store';

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
}

export async function createSession(stage: HTMLElement, work: WorkDef, store: Store<AppState>, hooks: SessionHooks): Promise<Session> {
  const bench = createBench(stage);
  // 拾取接口由 board3d 另行实现；没实现的方法就不调（点不到台面，但不报错）
  const pick = bench as unknown as Partial<ScenePickApi>;
  pick.setTheme?.('light');
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
  const scene: SceneSpec = ex?.scene ?? { parts: [] };
  const chip = ex?.chip ?? 'esp32s3';
  bench.setBoard(chip);
  bench.setScene(scene);
  const buzzerPins = scene.parts.flatMap((p) => (p.type === 'buzzer' ? [p.pin] : []));
  audio.setPins(buzzerPins);

  const i2cOf = (parts: PartSpec[]) => {
    const kind: Record<string, string> = { oled: 'ssd1306', bme280: 'bme280' };
    return parts.flatMap((p) => ('addr' in p && kind[p.type] ? [{ kind: kind[p.type], addr: p.addr }] : []));
  };

  const s: Session = {
    bench,
    pick,
    sim: null,
    scene,
    fwName: ex ? `${ex.id}/flash.bin` : '',
    fwSize: 0,
    chip,
    levels,
    frame: { pwm: [], rgb: null, oled: null, lcd: null },
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
      bench.setScene(scene);
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
      i2c: i2cOf(scene.parts),
      lcd: scene.parts.some((p) => p.type === 'gc9a01'),
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
        store.set((st) => ({ run: st.run + 1, running: true, reading: null }));
      },
      onTick(m) {
        bench.setGpio(m.gpio, m.enable, m.pwm, m.gpioHi, m.enableHi);
        if (m.leds) bench.setRgb(m.leds[0] ?? [0, 0, 0]);
        s.frame.pwm = m.pwm;
        if (m.leds) s.frame.rgb = m.leds[0] ?? null;
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
