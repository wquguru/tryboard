// 关卡验收：在独立 Worker 里按模拟时间跑完规定秒数。运行规则在 simrun.ts（与 npm 命令行共用），
// 时间片、脚本施加、PWM 采样照搬命令行 `tryboard run`，所以结论和指纹与 tools/check.py 一致。

import { runSim, type SimJob } from './simrun';

export type VerifyJob = SimJob & { wasm: ArrayBuffer; rom: ArrayBuffer; flash: ArrayBuffer };

export type VerifyMsg =
  | { type: 'progress'; sim: number }
  | { type: 'done'; stdout: string; report: string; sim: number; error?: string };

const post = (m: VerifyMsg) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<VerifyJob>) => {
  const r = await runSim(ev.data, { onProgress: (sim) => post({ type: 'progress', sim }) });
  post({ type: 'done', stdout: r.stdout, report: r.report, sim: r.sim, error: r.error });
};
