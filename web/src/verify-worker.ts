// Level check: a dedicated Worker runs the set seconds of simulated time. Run rules live in simrun.ts (shared with the npm CLI);
// slicing, script application and PWM sampling copy `tryboard run`, so verdicts and fingerprints match tools/check.py.

import { runSim, type SimJob } from './simrun';

export type VerifyJob = SimJob & { wasm: ArrayBuffer; rom: ArrayBuffer; flash: ArrayBuffer };

export type VerifyMsg =
  | { type: 'progress'; sim: number }
  | { type: 'done'; stdout: string; report: string; sim: number; error?: string; replies?: string[] };

const post = (m: VerifyMsg) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<VerifyJob>) => {
  const r = await runSim(ev.data, { onProgress: (sim) => post({ type: 'progress', sim }) });
  post({ type: 'done', stdout: r.stdout, report: r.report, sim: r.sim, error: r.error, ...(r.replies ? { replies: r.replies } : {}) });
};
