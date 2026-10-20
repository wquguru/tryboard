import type { LiveSim, SeekJob } from '../live';
import type { InputEvent } from '../inputlog';
import type { AppState, Session } from './types';
import type { Store } from './store';

// Paced replay (F-03b): the worker applies the log; the page only mirrors what the user would have seen (keys, room temperature, pose)
export function pacedMirror(bench: Session['bench'], store: Store<AppState>, hasImu: () => boolean) {
  let ui: { evs: InputEvent[]; i: number } | null = null;
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
    tick(sim: LiveSim | null | undefined, simSeconds: number) {
      const p = ui;
      if (!p) return;
      while (sim && p.i < p.evs.length && p.evs[p.i].tMs <= simSeconds * 1000) {
        const x = p.evs[p.i++];
        if (x.kind === 'gpio') bench.showPress(x.pin, x.level === 0, sim.bootPin);
        else if (x.kind === 'env') {
          sim.env = { temp: x.temp, humidity: x.humidity, pressure: x.pressure };
          store.set({ env: { ...sim.env } });
        } else if (x.kind === 'imu') {
          sim.pose = { pitch: x.pitch, roll: x.roll, yaw: x.yaw };
          store.set({ pose: { ...sim.pose } });
          bench.setPose(hasImu() ? sim.pose : null);
        } else if (x.kind === 'dist') bench.setDistance(x.cm);
      }
      if (p.i >= p.evs.length) ui = null;
    },
  };
}
