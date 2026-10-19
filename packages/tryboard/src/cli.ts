// tryboard 命令行（npm 包，本地用，不发布）：wasm 内核 + 乐鑫 ROM + levels.json 打在一个包里，
// `npx tryboard check app.bin --level 04` 不用装 Rust / Python 就能验收。
// 判定（checks.ts）与运行（simrun.ts）都直接用网页那一份源码，输出格式、指纹、退出码与 tools/check.py 一致。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bootOptions, evaluate, expandLevels, fingerprint, type CheckResult, type Level } from '../../../web/src/checks';
import { runSim, imageChip, type SimJob } from '../../../web/src/simrun';
import { toScriptInline, type InputLog } from '../../../web/src/inputlog';

declare const process: { argv: string[]; exit(c: number): never; stdout: { write(s: string): void }; stderr: { write(s: string): void } };

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROM_FILE = { esp32c3: 'esp32c3_rev3_rom.elf', esp32s3: 'esp32s3_rev0_rom.elf' } as const;

const USAGE = `tryboard（试板）本地命令行 · 本地包，尚未发布

用法：
  tryboard check <app.bin|flash.bin> --level <id>   按 levels.json 这个检查点的条件验收（检查点 07 用 07-spin / 07-lens）
  tryboard check <flash.bin> --all                   对所有检查点验收同一个固件
  tryboard check <flash.bin> --level-json cp.json    按网页「导出检查点」的 JSON 验收（选板生成的检查点）
  tryboard check <flash.bin> --level 06 --inputs log.txt
                                                     用网页导出的输入日志（脚本文本或 InputLog JSON）代替检查点自带输入
  tryboard check <flash.bin> --level 05 --servo 4 --power usb
                                                     接一个 SG90 进供电网络（同 check.py；ext = 外接 5 V 2 A）
  tryboard run <flash.bin> [--seconds 5] [--i2c ssd1306@0x3c,bme280@0x76] [--env 23.5,45,101325]
               [--spi gc9a01] [--inputs log.txt] [--script "0.5:gpio0=0"] [--pwm-log 4] [--servo 4] [--power usb|ext]
                                                     跑固件，串口打印到 stdout，观察记录打印到 stderr
退出码：check 全部通过 0，否则 1；run 模拟器停止（启动失败 / CPU 异常）时 1。
与仓库里 tools/check.py 同一套规则、同样的输出与指纹。`;

const die = (msg: string): never => {
  process.stderr.write(msg + '\n');
  process.exit(1);
};

function opt(a: string[], k: string) {
  const i = a.indexOf(k);
  return i >= 0 ? a[i + 1] : undefined;
}

/** 位置参数：去掉 --x 和跟在取值型开关后的值 */
function positional(a: string[], valued: string[]) {
  const skip = new Set(valued.filter((k) => a.includes(k)).map((k) => a.indexOf(k) + 1));
  return a.filter((x, i) => !x.startsWith('--') && !skip.has(i));
}

/** --inputs：CLI 脚本文本原样用；网页的 InputLog JSON 按 inputlog.ts 的规则转成脚本（与 check.py 的 inputs_file 一致） */
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

/** --servo / --power（P1-02）：与 check.py 一样原样叠加在关卡参数之上 */
function supply(a: string[]) {
  const sv = opt(a, '--servo');
  const pw = opt(a, '--power');
  return { servo: sv === undefined ? undefined : Number(sv), power: pw === undefined ? undefined : pw === 'ext' ? ('ext' as const) : ('usb' as const) };
}

async function check(a: string[]) {
  // --level-json：网页「导出检查点」下载的 Level JSON（数组或单个），与 check.py --level-json 一致
  const lj = opt(a, '--level-json');
  const custom = lj ? ([] as Level[]).concat(JSON.parse(readFileSync(lj, 'utf8'))) : null;
  const levels = custom ?? expandLevels(JSON.parse(readFileSync(join(PKG, 'levels.json'), 'utf8')) as Level[]).filter((l) => l.ref);
  if (a.includes('--ref')) die('npm 包不带参考固件：--ref 请在仓库里用 tools/check.py --ref');
  let pick: Level[];
  if (a.includes('--all') || (custom && !a.includes('--level'))) pick = levels;
  else {
    const lv = opt(a, '--level');
    if (!lv) die(USAGE);
    const id = /^\d+$/.test(lv!) ? lv!.padStart(2, '0') : lv!;
    pick = levels.filter((l) => l.id === id);
    if (!pick.length) die(`没有检查点 ${lv}（或它没有命令行验收）`);
  }
  const inputs = opt(a, '--inputs');
  const fw = positional(a, ['--level', '--level-json', '--inputs', '--servo', '--power'])[0];
  const sup = supply(a);
  if (!fw) die(USAGE);
  let bad = 0;
  for (const l of pick) {
    if (l.manual) {
      console.log(`检查点 ${l.id} ${l.title}：必须上真机，不判`);
      continue;
    }
    if (!existsSync(fw)) {
      console.log(`检查点 ${l.id} ${l.title}：找不到 ${fw}`);
      bad++;
      continue;
    }
    const flash = readBin(fw);
    const { i2c, env, lcd, servo, power, encoder, sonar, touchInt, usb, i2cLog, i2cWire, antenna } = bootOptions(l);
    const job: SimJob = { ...assets(flash), flash, seconds: l.seconds ?? 2, i2c, env, lcd, touchInt, servo: sup.servo ?? servo, power: sup.power ?? power, encoder, sonar, pwmPin: l.pwm?.pin, script: inputs ? inputsScript(inputs) : l.script, fixedSlice: !!inputs, usb, i2cLog, i2cWire, antenna };
    const r = await runSim(job);
    const res: CheckResult[] = evaluate(l, r.stdout, r.report);
    // 模拟器自己没跑起来不能算成固件的错（与 check.py 一致，放第一条）
    if (r.bootError) res.unshift({ ok: false, text: `模拟器没跑起来：${`启动失败：${r.bootError}`.slice(0, 120)}` });
    else if (r.error) res.push({ ok: false, text: `模拟器停止：${r.error}` });
    const ok = res.every((x) => x.ok);
    bad += ok ? 0 : 1;
    console.log(`检查点 ${l.id} ${l.title}：${ok ? '通过' : '未通过'}  指纹 ${fingerprint(r.stdout, r.report)}`);
    for (const x of res) console.log(`  ${x.ok ? '✓' : '✗'} ${x.text}`);
    if (l.assembly) console.log('  · 装配检查（几何估算）只在网页上检查');
  }
  process.exit(bad ? 1 : 0);
}

async function run(a: string[]) {
  const valued = ['--seconds', '--i2c', '--env', '--spi', '--inputs', '--script', '--pwm-log', '--servo', '--power', '--touch-int'];
  const fw = positional(a, valued)[0];
  if (!fw) die(USAGE);
  if (!existsSync(fw)) die(`找不到 ${fw}`);
  const args = ['--i2c', '--env', '--spi', '--touch-int'].flatMap((k) => (opt(a, k) ? [k, opt(a, k)!] : []));
  const { i2c, env, lcd, touchInt } = bootOptions({ args } as Level);
  const inputs = opt(a, '--inputs');
  const pwm = opt(a, '--pwm-log');
  const flash = readBin(fw);
  const r = await runSim(
    { ...assets(flash), flash, seconds: Number(opt(a, '--seconds') ?? 5), i2c, env, lcd, touchInt, ...supply(a), pwmPin: pwm === undefined ? undefined : Number(pwm), script: inputs ? inputsScript(inputs) : opt(a, '--script'), fixedSlice: !!inputs },
    { onConsole: (t) => process.stdout.write(t), onReset: (n, stopped) => process.stderr.write(stopped ? `[tryboard] 软件复位，已 ${n} 次，不再重新上电\n` : `[tryboard] 复位，第 ${n} 次重新上电\n`) },
  );
  if (r.bootError) die(`[tryboard] 启动失败：${r.bootError}`);
  process.stderr.write(r.report);
  process.stderr.write(`[tryboard] 模拟 ${r.sim.toFixed(3)}s · 指纹 ${fingerprint(r.stdout, r.report)}\n`);
  if (r.error) die(`[tryboard] 模拟器停止：${r.error}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'check') await check(rest);
else if (cmd === 'run') await run(rest);
else {
  console.log(USAGE);
  process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0);
}
