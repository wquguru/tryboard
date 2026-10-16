// 在浏览器里验收一关：起一个独立 Worker 按模拟时间跑完，判定并算指纹。
import { bootOptions, evaluate, fingerprint, type CheckResult, type Level } from './checks';
import { imageChip, loadRom, loadWasm } from './assets';
import type { VerifyJob, VerifyMsg } from './verify-worker';

export interface VerifyOutcome {
  ok: boolean;
  results: CheckResult[];
  fingerprint: string;
  stdout: string;
  sim: number;
  error?: string;
}

export async function verifyLevel(l: Level, flash: ArrayBuffer, onProgress?: (sim: number) => void, envOverride?: { temp: number; humidity: number; pressure: number }): Promise<VerifyOutcome> {
  const [wasm, rom] = await Promise.all([loadWasm(), loadRom(imageChip(flash))]);
  const { i2c, env } = bootOptions(l);
  const job: VerifyJob = { wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), seconds: l.seconds ?? 2, i2c, env: envOverride ?? env, script: l.script, pwmPin: l.pwm?.pin };
  const w = new Worker(new URL('./verify-worker.ts', import.meta.url), { type: 'module' });
  const msg = await new Promise<Extract<VerifyMsg, { type: 'done' }>>((resolve) => {
    w.onmessage = (ev: MessageEvent<VerifyMsg>) => {
      if (ev.data.type === 'progress') onProgress?.(ev.data.sim);
      else resolve(ev.data);
    };
    w.postMessage(job, [job.wasm, job.rom, job.flash]);
  });
  w.terminate();
  // 给自动化测试对照命令行用：最近一次验收的原始输出
  (globalThis as { __tbLastVerify?: unknown }).__tbLastVerify = { stdout: msg.stdout, report: msg.report };
  const results = evaluate(l, msg.stdout, msg.report);
  if (msg.error) results.push({ ok: false, text: `模拟器停止：${msg.error}` });
  return { ok: results.every((r) => r.ok), results, fingerprint: fingerprint(msg.stdout, msg.report), stdout: msg.stdout, sim: msg.sim, error: msg.error };
}
