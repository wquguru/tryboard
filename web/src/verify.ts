// Check a level in the browser: a separate Worker runs it on simulated time, then we judge and fingerprint here.
import { bootOptions, evaluate, fingerprint, type CheckResult, type Level } from './checks';
import { imageChip, loadRom, loadWasm } from './assets';
import type { VerifyJob, VerifyMsg } from './verify-worker';
import { toScriptInline, type InputLog } from './inputlog';
import { t } from './i18n/index.ts';

export interface VerifyOutcome {
  ok: boolean;
  results: CheckResult[];
  fingerprint: string;
  stdout: string;
  sim: number;
  error?: string;
  /** Ran with the real network on (C-03): the verdict needs internet and records no run ID; replies are the ones obtained this time */
  realnet?: { replies: string[] };
}

/** The check did not finish (Worker error or no progress for too long): distinct from "ran but failed", the UI offers a retry */
export class VerifyStalled extends Error {}

/** No progress for this long counts as stuck: the slowest level (06, 6 s simulated) reports every 0.1 s simulated, far under 1 s wall */
const stallMs = () => (globalThis as { __tbVerifyStall?: number }).__tbVerifyStall ?? 20_000;

// Run one job in a Worker; reject on a crash or stallMs of silence, else the caller hangs in verifying (seen 2026-10-18).
// The watchdog starts at postMessage, so loading wasm / ROM does not count.
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
      const time = stallMs() >= 1000 ? t('{n} s', { n: Math.round(stallMs() / 1000) }) : `${stallMs()} ms`;
      timer = setTimeout(() => fail(t('Simulator made no progress for {time}, stopped', { time })), stallMs()) as unknown as number;
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
      fail(t('Simulator error: {e}', { e: ev.message || t('background thread crashed') }));
    };
    w.onmessageerror = () => fail(t('Simulator message could not be parsed'));
    arm();
    w.postMessage(job, [job.wasm, job.rom, job.flash]);
    onProgress?.(0);
  });
}

export async function verifyLevel(l: Level, flash: ArrayBuffer, onProgress?: (sim: number) => void, envOverride?: { temp: number; humidity: number; pressure: number }, harness?: { i2cWire?: number; antenna?: number }, realnet?: boolean): Promise<VerifyOutcome> {
  const [wasm, rom] = await Promise.all([loadWasm(), loadRom(imageChip(flash))]);
  const { i2c, env, lcd, servo, power, encoder, sonar, dht11, touchInt, usb, i2cLog, i2cWire, antenna } = bootOptions(l);
  const job: VerifyJob = { wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), seconds: l.seconds ?? 2, i2c, env: envOverride ?? env, script: l.script, pwmPin: l.pwm?.pin, lcd, servo, power, encoder, sonar, dht11, touchInt, usb, i2cLog, i2cWire: harness?.i2cWire ?? i2cWire, antenna: harness?.antenna ?? antenna, ...(realnet ? { realnet: true } : {}) };
  const msg = await runJob(job, onProgress);
  // For automated tests comparing against the CLI: raw output of the latest check
  (globalThis as { __tbLastVerify?: unknown }).__tbLastVerify = { stdout: msg.stdout, report: msg.report };
  const results = evaluate(l, msg.stdout, msg.report);
  if (msg.error) results.push({ ok: false, text: `simulator stopped: ${msg.error}`, say: t('Simulator stopped: {e}', { e: msg.error }) });
  return { ok: results.every((r) => r.ok), results, fingerprint: fingerprint(msg.stdout, msg.report), stdout: msg.stdout, sim: msg.sim, error: msg.error, ...(realnet ? { realnet: { replies: msg.replies ?? [] } } : {}) };
}

// Replay a web input log (P0-19) like `tryboard run <fw> --inputs <log> --seconds S [--pwm-log P] --gpio-log --ws2812-log`:
// 1 ms slices, inputs at slice start, so serial output and report (fingerprint) match the CLI byte for byte.
export async function replayLog(flash: ArrayBuffer, log: InputLog, seconds: number, pwmPin?: number) {
  const [wasm, rom] = await Promise.all([loadWasm(), loadRom(imageChip(flash))]);
  const job: VerifyJob = { wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0), seconds, i2c: log.i2c, script: toScriptInline(log), pwmPin, lcd: log.lcd, servo: log.servo, power: log.power, encoder: log.encoder, sonar: log.sonar, dht11: log.dht11, touchInt: log.touchInt, fixedSlice: true };
  const msg = await runJob(job);
  return { stdout: msg.stdout, report: msg.report, fingerprint: fingerprint(msg.stdout, msg.report), sim: msg.sim, error: msg.error };
}
