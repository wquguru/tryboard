// wasm 内核实时倍率基准（Node / V8，与 Chrome 同一个引擎）：按网页 worker 的节奏 1ms 一片跑固件，
// 打印模拟时间 / 墙钟时间之比和串口输出。用法：
//   node tools/bench_wasm.mjs <flash.bin> [秒数=10] [--lcd]
// wasm 取 core/target/wasm32-unknown-unknown/release/tryboard_wasm.wasm（先 tools/build_web.sh 或 cargo build --target wasm32-unknown-unknown -p tryboard-wasm）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CPU_HZ = 160_000_000;
const args = process.argv.slice(2);
const fwPath = args[0];
const seconds = Number(args[1] ?? 10);
const lcd = args.includes('--lcd');
if (!fwPath) {
  console.error('用法：node tools/bench_wasm.mjs <flash.bin> [秒数] [--lcd]');
  process.exit(2);
}
// TB_WASM 可指定别的 wasm（对比优化前后）
const wasm = fs.readFileSync(process.env.TB_WASM ?? path.join(ROOT, 'core/target/wasm32-unknown-unknown/release/tryboard_wasm.wasm'));
const flash = fs.readFileSync(fwPath);
const { instance } = await WebAssembly.instantiate(wasm, {});
const e = instance.exports;
const put = (buf) => {
  const p = e.tb_alloc(buf.byteLength);
  new Uint8Array(e.memory.buffer, p, buf.byteLength).set(buf);
  return p;
};
const fp = put(flash);
const chip = e.tb_image_chip(fp, flash.byteLength);
const rom = fs.readFileSync(path.join(ROOT, 'third_party/esp-rom-elfs', chip === 9 ? 'esp32s3_rev0_rom.elf' : chip === 0 ? 'esp32_rev300_rom.elf' : 'esp32c3_rev3_rom.elf'));
const rp = put(rom);
if (e.tb_boot(rp, rom.byteLength, fp, flash.byteLength) !== 0) {
  console.error('启动失败');
  process.exit(1);
}
if (lcd) e.tb_lcd_attach();
const dec = new TextDecoder();
let out = '';
const slice = CPU_HZ / 1000;
const t0 = performance.now();
for (let i = 0; i < seconds * 1000; i++) {
  if (e.tb_run(slice) !== 0) {
    console.error('停止于', i, 'ms');
    break;
  }
  const n = e.tb_console_len();
  if (n) {
    out += dec.decode(new Uint8Array(e.memory.buffer, e.tb_console_ptr(), n));
    e.tb_console_clear();
  }
}
const wall = (performance.now() - t0) / 1000;
const sim = e.tb_cycles() / CPU_HZ;
process.stdout.write(out);
console.log(`\n[bench_wasm] 模拟 ${sim.toFixed(3)}s / 墙钟 ${wall.toFixed(3)}s，实时倍率 ${(sim / wall).toFixed(2)}×`);
