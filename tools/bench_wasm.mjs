// Real-time ratio benchmark of the wasm core in Node / V8 (same engine as Chrome), 1 ms slices like the web worker.
// Usage: node tools/bench_wasm.mjs <flash.bin> [seconds=10] [--lcd]  (needs a wasm32 release build of tryboard-wasm)
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
  console.error('Usage: node tools/bench_wasm.mjs <flash.bin> [seconds] [--lcd]');
  process.exit(2);
}
// TB_WASM selects another wasm (compare before / after an optimization)
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
  console.error('boot failed');
  process.exit(1);
}
if (lcd) e.tb_lcd_attach();
const dec = new TextDecoder();
let out = '';
const slice = CPU_HZ / 1000;
const t0 = performance.now();
for (let i = 0; i < seconds * 1000; i++) {
  if (e.tb_run(slice) !== 0) {
    console.error('stopped at', i, 'ms');
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
console.log(`\n[bench_wasm] simulated ${sim.toFixed(3)}s / wall ${wall.toFixed(3)}s, real-time ratio ${(sim / wall).toFixed(2)}×`);
