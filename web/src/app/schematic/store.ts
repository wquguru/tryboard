// H-17 bench view state, kept out of lessonUi: which view the stage shows, what the schematic has picked, and the flow state.
import { createStore } from '../store';

export type BenchView = '3d' | 'schematic';
export type FlowView = 'on' | 'off' | 'assumed' | null;

export interface SchUi {
  view: BenchView;
  /** Picked symbol ref (R1 and D1 share the LED part, so the ref tells them apart) */
  sel: string | null;
  /** Picked net flag name */
  net: string | null;
  /** Mirrors bench/flow.tsx (null = switch off) */
  flow: FlowView;
}

export const schUi = createStore<SchUi>({ view: '3d', sel: null, net: null, flow: null });
