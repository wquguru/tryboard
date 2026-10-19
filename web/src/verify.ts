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
  /** 开着真实网络跑的（C-03）：结论依赖外网，不记运行编号；replies 是这次拿到的回复 */
  realnet?: { replies: string[] };
}

/** 验收没跑完（Worker 出错、或太久没有进度）：与"跑完但不通过"区分开，界面提示重试 */
export class VerifyStalled extends Error {}

/** 多久没有进度算卡住：最慢的关（06，6 s 模拟）每 0.1 s 模拟回报一次，实测间隔远小于 1 s；调试时可用 __tbVerifyStall 改小 */
const stallMs = () => (globalThis as { __tbVerifyStall?: number }).__tbVerifyStall ?? 20_000;

/**
 * 起 Worker 跑一份 job，等 done。Worker 崩溃（onerror / onmessageerror）或连续 stallMs 没有任何消息就 reject，
 * 否则调用方的 verifying 状态会永远停在这一关（2026-10-18 走查实测卡过一次）。看门狗从 postMessage 起算，
 * 加载 wasm / ROM 的时间不算在内。
 */
function runJob(job: VerifyJob, onProgress?: (sim: number) => void) {
  const w = new Worker(new URL('./verify-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Extract<VerifyMsg, { type: 'done' }>>((resolve, reject) => {
    let timer = 0;
    const fail = (why: string) => {
      clearTimeout(timer);
      w.terminate();
      reject(new VerifyStalled(why));
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(`模拟器 ${stallMs() >= 1000 ? `${Math.round(stallMs() / 1000)} 秒` : `${stallMs()} ms`}没有进度，已停止`), stallMs()) as unknown as number;
    };
    w.onmessage = (ev: MessageEvent<VerifyMsg>) => {
      if (ev.data.type === 'progress') {
        arm();
        onProgress?.(ev.data.sim);
      } else {
        clearTimeout(timer);
        w.terminate();
        resolve(ev.data);
      }
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      fail(`模拟器出错：${ev.message || '后台线程崩溃'}`);
    };
    w.onmessageerror = () => fail('模拟器消息无法解析');
    arm();
    w.postMessage(job, [job.wasm, job.rom, job.flash]);
    onProgress?.(0);
  });
}

export async function verifyLevel(l: Level, flash: ArrayBuffer, onProgress?: (sim: number) => void, envOverride?: { temp: number; humidity: number; pressure: number }, harness?: { i2cWire?: number; antenna?: number }, realnet?: boolean): Promise<VerifyOutcome> {
  const [wasm, rom] = await Promise.all([loadWasm(), loadRom(imageChip(flash))]);
  const { i2c, env, lcd, servo, power, encoder, sonar, touchInt, usb, i2cLog, i2cWire, antenna } = bootOptions(l);
  const job: VerifyJob = { wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), seconds: l.seconds ?? 2, i2c, env: envOverride ?? env, script: l.script, pwmPin: l.pwm?.pin, lcd, servo, power, encoder, sonar, touchInt, usb, i2cLog, i2cWire: harness?.i2cWire ?? i2cWire, antenna: harness?.antenna ?? antenna, ...(realnet ? { realnet: true } : {}) };
  const msg = await runJob(job, onProgress);
  // 给自动化测试对照命令行用：最近一次验收的原始输出
  (globalThis as { __tbLastVerify?: unknown }).__tbLastVerify = { stdout: msg.stdout, report: msg.report };
  const results = evaluate(l, msg.stdout, msg.report);
  if (msg.error) results.push({ ok: false, text: `模拟器停止：${msg.error}` });
  return { ok: results.every((r) => r.ok), results, fingerprint: fingerprint(msg.stdout, msg.report), stdout: msg.stdout, sim: msg.sim, error: msg.error, ...(realnet ? { realnet: { replies: msg.replies ?? [] } } : {}) };
}

/**
 * 按网页导出的输入日志重放（P0-19）：与 `tryboard run <fw> --inputs <日志> --seconds S [--pwm-log P] --gpio-log --ws2812-log` 相同，
 * 始终 1ms 一片、输入在同一个时间片开头施加，所以串口输出和观察记录（指纹）与命令行逐字节相同。
 */
export async function replayLog(flash: ArrayBuffer, log: InputLog, seconds: number, pwmPin?: number) {
  const [wasm, rom] = await Promise.all([loadWasm(), loadRom(imageChip(flash))]);
  const job: VerifyJob = { wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), seconds, i2c: log.i2c, script: toScriptInline(log), pwmPin, lcd: log.lcd, servo: log.servo, power: log.power, encoder: log.encoder, sonar: log.sonar, touchInt: log.touchInt, fixedSlice: true };
  const msg = await runJob(job);
  return { stdout: msg.stdout, report: msg.report, fingerprint: fingerprint(msg.stdout, msg.report), sim: msg.sim, error: msg.error };
}
