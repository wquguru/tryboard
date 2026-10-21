import type { LiveSim, SeekJob } from '../live';
import type { InputEvent } from '../inputlog';
import type { AppState, Session } from './types';
import type { Store } from './store';
import { scenFeed } from './scenariofeed';

// Paced replay (F-03b) and the environment scenario (F-11): the worker applies the events; the page only mirrors
// what the user would have seen (keys, room temperature, pose, distance, light / PIR / network values)
export function pacedMirror(bench: Session['bench'], store: Store<AppState>, hasImu: () => boolean) {
  let ui: { evs: InputEvent[]; i: number } | null = null;
  // Second cursor: a rewind or paced start must not drop the scenario's mirror
  let sc: { evs: InputEvent[]; i: number } | null = null;
  const show = (sim: LiveSim, x: InputEvent) => {
    if (x.kind === 'gpio') bench.showPress(x.pin, x.level === 0, sim.bootPin);
    else if (x.kind === 'env') {
      sim.env = { temp: x.temp, humidity: x.humidity, pressure: x.pressure };
      store.set({ env: { ...sim.env } });
    } else if (x.kind === 'imu') {
      sim.pose = { pitch: x.pitch, roll: x.roll, yaw: x.yaw };
      store.set({ pose: { ...sim.pose } });
      bench.setPose(hasImu() ? sim.pose : null);
    } else if (x.kind === 'dist') bench.setDistance(x.cm);
    else if (x.kind === 'lux') scenFeed.set((f) => ({ shown: { ...f.shown, lux: x.lux } }));
    else if (x.kind === 'pir') scenFeed.set((f) => ({ shown: { ...f.shown, pir: x.on } }));
    else if (x.kind === 'net') scenFeed.set((f) => ({ shown: { ...f.shown, net: x.preset } }));
  };
  const walk = (p: { evs: InputEvent[]; i: number }, sim: LiveSim, ms: number) => {
    while (p.i < p.evs.length && p.evs[p.i].tMs <= ms) show(sim, p.evs[p.i++]);
    return p.i < p.evs.length ? p : null;
  };
  return {
    start(job: SeekJob, sim: LiveSim) {
      ui = job.paced ? { evs: job.events, i: 0 } : null;
      // Keys shown held by an earlier paced replay end up as the log leaves them at the stop point
      const held = new Map<number, boolean>();
      for (const x of job.events) if (x.kind === 'gpio') held.set(x.pin, !job.paced && x.tMs < job.untilMs ? x.level === 0 : (held.get(x.pin) ?? false));
      for (const [pin, down] of held) bench.showPress(pin, down, sim.bootPin);
    },
    stop() {
      ui = null;
    },
    /** Scenario events to mirror from fromMs on (the network value is not pushed into the preset picker: that would log a second net= line) */
    script(evs: InputEvent[] | null, fromMs: number) {
      sc = evs ? { evs, i: evs.findIndex((x) => x.tMs >= fromMs) } : null;
      if (sc && sc.i < 0) sc = null;
      if (fromMs === 0) scenFeed.set({ shown: {} });
    },
    tick(sim: LiveSim | null | undefined, simSeconds: number) {
      if (!sim) return;
      if (ui) ui = walk(ui, sim, simSeconds * 1000);
      if (sc) sc = walk(sc, sim, simSeconds * 1000);
    },
  };
}
