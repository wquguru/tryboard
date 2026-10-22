// Environment scenario state (F-11) shared by the session, the dock pane and share links; kept out of the lazy pane chunk.
// Saved per work in localStorage like the bench placement; the share link carries it as `tl`.
import { createStore } from './store';
import { parseScenario, type ScenarioEdit, type ScenarioV1, type TrackKind } from './scenario.ts';
import { noteSaved } from './saved';

export interface ScenFeed {
  sc: ScenarioV1 | null;
  /** Tracks the bench offers now (benchTracks) */
  offered: { k: TrackKind; pin?: number }[];
  /** Compiled line count of the current scenario */
  lines: number;
  /** A keyframe before the playhead changed: takes effect after a restart */
  stale: boolean;
  /** Last values the scenario applied that have no other UI (lux / PIR / network), for panels to show */
  shown: { lux?: number; pir?: boolean; net?: string };
  /** Simulated ms for the playhead, updated in 50 ms steps so the pane does not render every frame */
  now: number;
  /** Room at the last power-up: the export compiles against it so the file matches what the worker applied */
  room: { temp: number; humidity: number; pressure: number } | null;
  /** A shared run is replaying at its original speed (F-03b): edits make the result differ from the sharer's */
  replay: boolean;
  /** Track the pane should select when it opens (a slider's "Controlled by the scenario" link); rev re-triggers the same key */
  focus: { key: string; rev: number } | null;
}
export const scenFeed = createStore<ScenFeed>({ sc: null, offered: [], lines: 0, stale: false, shown: {}, now: 0, room: null, replay: false, focus: null });

/** Bench timeline hook (F-11c): set by benchhist so the lazy pane records undo steps without the lab context */
interface ScenHist {
  op(op: ScenarioEdit): { op: { k: string } };
  render(): void;
}
let hist: ScenHist | null = null;
let gesture: ScenarioEdit | null = null;
export const attachScenarioHistory = (h: ScenHist) => void (hist = h);

/** A user edit: one timeline step each, except a drag (drag: true) which updates its step until endScenarioGesture */
export function editScenario(sc: ScenarioV1 | null, label: string, opts: { stale?: boolean; drag?: boolean } = {}) {
  const prev = scenFeed.get().sc;
  if (prev === sc) return;
  setScenario(sc, { stale: opts.stale });
  if (!hist) return;
  if (opts.drag && gesture) {
    gesture.sc = sc;
    gesture.stale = scenFeed.get().stale;
    hist.render();
    return;
  }
  const st = hist.op({ k: 'scenario', sc, prev, label, stale: scenFeed.get().stale });
  gesture = opts.drag && st.op.k === 'scenario' ? (st.op as ScenarioEdit) : null;
}
export const endScenarioGesture = () => void (gesture = null);

let key = '';
export function initScenario(workKey: string) {
  key = `tryboard-scenario:${workKey}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) scenFeed.set({ sc: parseScenario(JSON.parse(raw)) });
  } catch {
    /* private mode or an old / corrupt entry: start without a scenario */
  }
}

/** Replace the scenario; save = remember it for this work (a shared link's scenario is saved under the local copy's key) */
export function setScenario(sc: ScenarioV1 | null, opts: { save?: boolean; stale?: boolean } = {}) {
  scenFeed.set({ sc, stale: opts.stale ?? scenFeed.get().stale });
  if (opts.save === false || !key) return;
  try {
    if (sc) localStorage.setItem(key, JSON.stringify(sc));
    else localStorage.removeItem(key);
    noteSaved();
  } catch {
    /* private mode: kept for this page only */
  }
}
