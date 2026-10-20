// Minimal QR decoder for tests (F-02): clean module matrix in, byte-mode text out. No error correction, but every
// block's RS syndromes must be zero, so a wrong EC codeword fails loudly. Used by qr.test.ts and tools/webtest/sharecard.mjs.
import { blockLayout, dataOrder, functionMask, maskBit } from '../src/app/qr.ts';

// GF(256), polynomial 0x11d, kept separate from the encoder's tables.
const EXP: number[] = [], LOG: number[] = [];
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}
const gmul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

function formatCode(level: number, mask: number): number {
  const d = (level << 3) | mask;
  let r = d << 10;
  for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0x537 << (i - 10);
  return ((d << 10) | r) ^ 0x5412;
}

export interface Decoded {
  text: string;
  version: number;
  mask: number;
  /** Level bits from the format info (0 = M). */
  level: number;
}

/** Decode a square module matrix (row-major, 1 = dark, no quiet zone). */
export function decodeQr(modules: ArrayLike<number>, size: number): Decoded {
  const ver = (size - 17) / 4;
  if (!Number.isInteger(ver) || ver < 1 || ver > 40) throw new Error(`bad size ${size}`);
  const at = (x: number, y: number) => modules[y * size + x] & 1;
  // Format copy next to the top-left finder.
  const pos: [number, number][] = [];
  for (let i = 0; i <= 5; i++) pos.push([8, i]);
  pos.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) pos.push([14 - i, 8]);
  let f = 0;
  pos.forEach(([x, y], i) => (f |= at(x, y) << i));
  let best = { d: 99, level: 0, mask: 0 };
  for (let level = 0; level < 4; level++)
    for (let mask = 0; mask < 8; mask++) {
      let x = formatCode(level, mask) ^ f, d = 0;
      for (; x; x &= x - 1) d++;
      if (d < best.d) best = { d, level, mask };
    }
  if (best.d > 3) throw new Error('format info unreadable');
  const fn = functionMask(ver);
  const order = dataOrder(size, fn);
  const L = blockLayout(ver);
  const cw = new Uint8Array(L.total);
  for (let k = 0; k < L.total * 8; k++) {
    const i = order[k];
    const bit = modules[i] ^ (maskBit(best.mask, i % size, Math.floor(i / size)) ? 1 : 0);
    cw[k >> 3] |= bit << (7 - (k & 7));
  }
  // De-interleave: data columns across blocks (long blocks have one more), then EC columns.
  const blocks: number[][] = [];
  for (let b = 0; b < L.blocks; b++) blocks.push([]);
  let k = 0;
  for (let i = 0; i <= L.shortData; i++) for (let b = 0; b < L.blocks; b++) if (i < L.shortData || b >= L.shortCount) blocks[b].push(cw[k++]);
  for (let i = 0; i < L.ec; i++) for (let b = 0; b < L.blocks; b++) blocks[b].push(cw[k++]);
  const data: number[] = [];
  blocks.forEach((blk, b) => {
    for (let r = 0; r < L.ec; r++) {
      // Horner evaluation at α^r; a valid codeword is divisible by the generator, so all syndromes are 0.
      let s = 0;
      for (const c of blk) s = gmul(s, EXP[r]) ^ c;
      if (s) throw new Error(`block ${b}: syndrome ${r} = ${s}`);
    }
    data.push(...blk.slice(0, blk.length - L.ec));
  });
  let bit = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  const mode = read(4);
  if (mode !== 0b0100) throw new Error(`mode ${mode} is not byte mode`);
  const n = read(ver < 10 ? 8 : 16);
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = read(8);
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), version: ver, mask: best.mask, level: best.level };
}

/** Matrix from hex row strings (fixture format: one hex number per row, MSB = leftmost module). */
export function fromHexRows(rows: string[]): { modules: Uint8Array; size: number } {
  const size = rows.length;
  const modules = new Uint8Array(size * size);
  rows.forEach((r, y) => {
    const bits = BigInt('0x' + r);
    for (let x = 0; x < size; x++) modules[y * size + x] = Number((bits >> BigInt(size - 1 - x)) & 1n);
  });
  return { modules, size };
}
