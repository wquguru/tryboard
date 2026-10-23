// tryboard CLI (local npm package): wasm core + Espressif ROM + levels.json, so `npx tryboard check app.bin --level 04` needs no Rust / Python.
// Judging (checks.ts) and running (simrun.ts) reuse the web sources; output, fingerprints and exit codes match tools/check.py.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bootOptions, evaluate, expandLevels, fingerprint, type CheckResult, type Level } from '../../../web/src/checks';
import { runSim, imageChip, type SimJob } from '../../../web/src/simrun';
import { toScriptInline, type InputLog } from '../../../web/src/inputlog';
import { mergeArgs } from '../../../web/src/faults';

declare const process: { argv: string[]; exit(c: number): never; stdout: { write(s: string): void }; stderr: { write(s: string): void } };

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROM_FILE = { esp32: 'esp32_rev300_rom.elf', esp32c3: 'esp32c3_rev3_rom.elf', esp32s3: 'esp32s3_rev0_rom.elf' } as const;

const USAGE = `tryboard local command line · local package, not published

Usage:
  tryboard check <app.bin|flash.bin> --level <id>   check against this checkpoint in levels.json (checkpoint 07 uses 07-spin / 07-lens)
  tryboard check <flash.bin> --all                   check one firmware against every checkpoint
  tryboard check <flash.bin> --level-json cp.json    check against JSON from the web's "Export checkpoint" (board-picker checkpoints)
  tryboard check <flash.bin> --level 06 --inputs log.txt
                                                     use an input log exported by the web (script text or InputLog JSON) instead of the checkpoint's inputs
  tryboard check <flash.bin> --level 05 --servo 4 --power usb
                                                     put an SG90 on the supply network (same as check.py; ext = external 5 V 2 A)
  tryboard check <flash.bin> --level fault-wire --i2c-wire 20
                                                     fault checkpoint (F-05): bench as found plus your switches (--i2c-wire / --antenna-loss / --power / --servo / --i2c-bus)
  tryboard run <flash.bin> [--seconds 5] [--i2c ssd1306@0x3c,bme280@0x76] [--env 23.5,45,101325]
               [--spi gc9a01] [--inputs log.txt] [--script "0.5:gpio0=0"] [--pwm-log 4] [--servo 4] [--power usb|ext]
                                                     run firmware, serial to stdout, report to stderr
Exit code: check is 0 when everything passes, else 1; run is 1 when the simulator stops (boot failure / CPU exception).
Same rules, output and fingerprints as tools/check.py in the repository.`;

const die = (msg: string): never => {
  process.stderr.write(msg + '\n');
  process.exit(1);
};

function opt(a: string[], k: string) {
  const i = a.indexOf(k);
  return i >= 0 ? a[i + 1] : undefined;
}

/** Positional args: drop --x flags and the values after valued flags */
function positional(a: string[], valued: string[]) {
  const skip = new Set(valued.filter((k) => a.includes(k)).map((k) => a.indexOf(k) + 1));
  return a.filter((x, i) => !x.startsWith('--') && !skip.has(i));
}

/** --inputs: CLI script text as is; web InputLog JSON converted per inputlog.ts (same as inputs_file in check.py) */
function inputsScript(path: string) {
  const text = readFileSync(path, 'utf8');
  if (!text.trimStart().startsWith('{')) return text;
  return toScriptInline(JSON.parse(text) as InputLog);
}

function assets(flash: Uint8Array) {
  const chip = imageChip(flash);
  return { wasm: readFileSync(join(PKG, 'wasm/tryboard.wasm')), rom: readFileSync(join(PKG, 'rom', ROM_FILE[chip])) };
}

const readBin = (p: string) => new Uint8Array(readFileSync(p));

/** --servo / --power (P1-02): layered on top of the level's options, like check.py */
function supply(a: string[]) {
  const sv = opt(a, '--servo');
  const pw = opt(a, '--power');
  return { servo: sv === undefined ? undefined : Number(sv), power: pw === undefined ? undefined : pw === 'ext' ? ('ext' as const) : ('usb' as const) };
}

/** Bench switches given on the command line, as flag/value pairs (same set as KNOB_FLAGS in check.py) */
const KNOB_FLAGS = ['--i2c-wire', '--antenna-loss', '--power', '--servo', '--i2c-bus'];
function knobArgs(a: string[]) {
  return KNOB_FLAGS.flatMap((f) => (opt(a, f) === undefined ? [] : [f, opt(a, f)!]));
}

/** A fault checkpoint runs the bench as found plus the switches; other levels just get the switches layered on */
function withKnobs(l: Level, a: string[]): Level {
  const base = l.fault ? mergeArgs(l.args ?? [], l.fault.args ?? []) : l.args ?? [];
  return { ...l, args: mergeArgs(base, knobArgs(a)) };
}

async function check(a: string[]) {
  // --level-json: Level JSON (array or single) from the web's Export checkpoint, same as check.py --level-json
  const lj = opt(a, '--level-json');
  const custom = lj ? ([] as Level[]).concat(JSON.parse(readFileSync(lj, 'utf8'))) : null;
  const levels = custom ?? expandLevels(JSON.parse(readFileSync(join(PKG, 'levels.json'), 'utf8')) as Level[]).filter((l) => l.ref);
  if (a.includes('--ref')) die('the npm package has no reference firmware: use tools/check.py --ref in the repository');
  let pick: Level[];
  if (a.includes('--all') || (custom && !a.includes('--level'))) pick = levels;
  else {
    const lv = opt(a, '--level');
    if (!lv) die(USAGE);
    const id = /^\d+$/.test(lv!) ? lv!.padStart(2, '0') : lv!;
    pick = levels.filter((l) => l.id === id);
    if (!pick.length) die(`no checkpoint ${lv} (or it has no command-line check)`);
  }
  const inputs = opt(a, '--inputs');
  const fw = positional(a, ['--level', '--level-json', '--inputs', ...KNOB_FLAGS])[0];
  const sup = supply(a);
  if (!fw) die(USAGE);
  let bad = 0;
  for (const l0 of pick) {
    const l = withKnobs(l0, a);
    if (l.manual) {
      console.log(`Checkpoint ${l.id} ${l.title}: needs real hardware, not judged`);
      continue;
    }
    if (!existsSync(fw)) {
      console.log(`Checkpoint ${l.id} ${l.title}: ${fw} not found`);
      bad++;
      continue;
    }
    const flash = readBin(fw);
    const { i2c, env, lcd, servo, power, encoder, sonar, dht11, parts, touchInt, board, grove, usb, i2cLog, i2cWire, antenna } = bootOptions(l);
    const job: SimJob = { ...assets(flash), flash, seconds: l.seconds ?? 2, board, grove, i2c, env, lcd, touchInt, servo: sup.servo ?? servo, power: sup.power ?? power, encoder, sonar, dht11, parts, pwmPin: l.pwm?.pin, script: inputs ? inputsScript(inputs) : l.script, fixedSlice: !!inputs, usb, i2cLog, i2cWire, antenna };
    const r = await runSim(job);
    const res: CheckResult[] = evaluate(l, r.stdout, r.report + (r.audio ?? ''));
    // A simulator that never started is not the firmware's fault (like check.py, listed first)
    if (r.bootError) res.unshift({ ok: false, text: `simulator did not start: ${`boot failed: ${r.bootError}`.slice(0, 120)}` });
    else if (r.error) res.push({ ok: false, text: `simulator stopped: ${r.error}` });
    const ok = res.every((x) => x.ok);
    bad += ok ? 0 : 1;
    console.log(`Checkpoint ${l.id} ${l.title}: ${ok ? 'PASS' : 'FAIL'}  fingerprint ${fingerprint(r.stdout, r.report)}`);
    for (const x of res) console.log(`  ${x.ok ? '✓' : '✗'} ${x.text}`);
    if (l.assembly) console.log('  · assembly check (geometric estimate) runs only on the web');
  }
  process.exit(bad ? 1 : 0);
}

async function run(a: string[]) {
  const valued = ['--seconds', '--i2c', '--env', '--spi', '--inputs', '--script', '--pwm-log', '--servo', '--power', '--touch-int'];
  const fw = positional(a, valued)[0];
  if (!fw) die(USAGE);
  if (!existsSync(fw)) die(`${fw} not found`);
  const args = ['--i2c', '--env', '--spi', '--touch-int'].flatMap((k) => (opt(a, k) ? [k, opt(a, k)!] : []));
  const { i2c, env, lcd, touchInt } = bootOptions({ args } as Level);
  const inputs = opt(a, '--inputs');
  const pwm = opt(a, '--pwm-log');
  const flash = readBin(fw);
  const r = await runSim(
    { ...assets(flash), flash, seconds: Number(opt(a, '--seconds') ?? 5), i2c, env, lcd, touchInt, ...supply(a), pwmPin: pwm === undefined ? undefined : Number(pwm), script: inputs ? inputsScript(inputs) : opt(a, '--script'), fixedSlice: !!inputs },
    { onConsole: (t) => process.stdout.write(t), onReset: (n, stopped) => process.stderr.write(stopped ? `[tryboard] software reset ${n} times, no more power-ups\n` : `[tryboard] reset, power-up #${n}\n`) },
  );
  if (r.bootError) die(`[tryboard] boot failed: ${r.bootError}`);
  process.stderr.write(r.report);
  process.stderr.write(`[tryboard] simulated ${r.sim.toFixed(3)}s · fingerprint ${fingerprint(r.stdout, r.report)}\n`);
  if (r.error) die(`[tryboard] simulator stopped: ${r.error}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'check') await check(rest);
else if (cmd === 'run') await run(rest);
else {
  console.log(USAGE);
  process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0);
}
