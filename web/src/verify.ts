// 在浏览器里验收一关：起一个独立 Worker 按模拟时间跑完，判定并算指纹。
import { bootOptions, evaluate, fingerprint, type CheckResult, type Level } from './checks';
import { imageChip, loadRom, loadWasm } from './assets';
import type { VerifyJob, VerifyMsg } from './verify-worker';
import { toScriptInline, type InputLog } from './inputlog';

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
  const { i2c, env, lcd, servo, power, encoder, sonar } = bootOptions(l);
  const job: VerifyJob = { wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), seconds: l.seconds ?? 2, i2c, env: envOverride ?? env, script: l.script, pwmPin: l.pwm?.pin, lcd, servo, power, encoder, sonar };
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

/**
 * 按网页导出的输入日志重放（P0-19）：与 `tryboard run <fw> --inputs <日志> --seconds S [--pwm-log P] --gpio-log --ws2812-log` 相同，
 * 始终 1ms 一片、输入在同一个时间片开头施加，所以串口输出和观察记录（指纹）与命令行逐字节相同。
 */
export async function replayLog(flash: ArrayBuffer, log: InputLog, seconds: number, pwmPin?: number) {
  const [wasm, rom] = await Promise.all([loadWasm(), loadRom(imageChip(flash))]);
  const job: VerifyJob = { wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), seconds, i2c: log.i2c, script: toScriptInline(log), pwmPin, lcd: log.lcd, servo: log.servo, power: log.power, encoder: log.encoder, sonar: log.sonar, fixedSlice: true };
  const w = new Worker(new URL('./verify-worker.ts', import.meta.url), { type: 'module' });
  const msg = await new Promise<Extract<VerifyMsg, { type: 'done' }>>((resolve) => {
    w.onmessage = (ev: MessageEvent<VerifyMsg>) => {
      if (ev.data.type === 'done') resolve(ev.data);
    };
    w.postMessage(job, [job.wasm, job.rom, job.flash]);
  });
  w.terminate();
  return { stdout: msg.stdout, report: msg.report, fingerprint: fingerprint(msg.stdout, msg.report), sim: msg.sim, error: msg.error };
}
