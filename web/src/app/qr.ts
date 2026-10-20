// QR code encoder for the share card (F-02): byte mode, error correction level M, versions 1–40, mask by penalty score.
// Written from ISO/IEC 18004 (no dependency, RS-4 §3); checked against qrencode fixtures in web/test/qr.test.ts.

/** EC codewords per block for level M, index = version. */
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
/** Number of EC blocks for level M, index = version. */
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
/** Format-info level bits: M = 00. */
const LEVEL_M = 0;

export interface QrCode {
  version: number;
  /** Modules per side (17 + 4 × version), no quiet zone. */
  size: number;
  mask: number;
  /** Row-major size × size, 1 = dark. */
  modules: Uint8Array;
}

/** Modules left for data + EC after function patterns (spec table 1, in closed form). */
function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

/** Block split of a version: total codewords, EC per block, short / long block counts and data lengths. */
export function blockLayout(ver: number) {
  const total = Math.floor(rawDataModules(ver) / 8);
  const ec = EC_PER_BLOCK[ver], blocks = BLOCKS[ver];
  const shortLen = Math.floor(total / blocks);
  const longCount = total % blocks;
  return { total, ec, blocks, shortCount: blocks - longCount, shortData: shortLen - ec, data: total - ec * blocks };
}

/** Byte-mode capacity of a version at level M. */
export function qrCapacity(ver: number): number {
  const bits = blockLayout(ver).data * 8 - 4 - (ver < 10 ? 8 : 16);
  return Math.floor(bits / 8);
}
export const QR_MAX_BYTES = qrCapacity(40);

/** Alignment pattern centre coordinates of a version. */
export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((size - 13) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let p = size - 7; out.length < n; p -= step) out.splice(1, 0, p);
  return out;
}

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Reed–Solomon EC codewords of `data` (remainder of data·x^deg by the generator ∏(x − α^i)). */
export function rsRemainder(data: ArrayLike<number>, deg: number): Uint8Array {
  // Generator coefficients, highest power first, leading 1 dropped.
  const gen = new Uint8Array(deg);
  gen[deg - 1] = 1;
  for (let i = 0, root = 1; i < deg; i++, root = mul(root, 2)) {
    for (let j = 0; j < deg; j++) {
      gen[j] = mul(gen[j], root);
      if (j + 1 < deg) gen[j] ^= gen[j + 1];
    }
  }
  const rem = new Uint8Array(deg);
  for (let k = 0; k < data.length; k++) {
    const f = data[k] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[deg - 1] = 0;
    for (let j = 0; j < deg; j++) rem[j] ^= mul(gen[j], f);
  }
  return rem;
}

/** 15-bit format info (level M + mask), BCH(15,5) and the 0x5412 mask applied. */
export function formatBits(mask: number): number {
  const d = (LEVEL_M << 3) | mask;
  let r = d;
  for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >> 9) * 0x537);
  return ((d << 10) | r) ^ 0x5412;
}

/** 18-bit version info (versions ≥ 7), BCH(18,6). */
export function versionBits(ver: number): number {
  let r = ver;
  for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >> 11) * 0x1f25);
  return (ver << 12) | r;
}

class Grid {
  readonly size: number;
  readonly m: Uint8Array;
  readonly fn: Uint8Array;
  constructor(readonlySize: number) {
    this.size = readonlySize;
    this.m = new Uint8Array(readonlySize * readonlySize);
    this.fn = new Uint8Array(readonlySize * readonlySize);
  }
  set(x: number, y: number, dark: boolean) {
    const i = y * this.size + x;
    this.m[i] = dark ? 1 : 0;
    this.fn[i] = 1;
  }
}

function drawFunctions(g: Grid, ver: number) {
  const s = g.size;
  for (let i = 0; i < s; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]]) {
    // Finder plus its separator: Chebyshev distance 0–1 and 3 dark, 2 and 4 light.
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
  }
  const al = alignmentPositions(ver);
  for (const ax of al)
    for (const ay of al) {
      // Skip the three corners taken by finders.
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === s - 7) || (ax === s - 7 && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  drawFormat(g, 0);
  if (ver >= 7) {
    const v = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const bit = ((v >> i) & 1) === 1;
      const a = s - 11 + (i % 3), b = Math.floor(i / 3);
      g.set(a, b, bit);
      g.set(b, a, bit);
    }
  }
}

function drawFormat(g: Grid, mask: number) {
  const s = g.size;
  const f = formatBits(mask);
  const bit = (i: number) => ((f >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(s - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, s - 15 + i, bit(i));
  g.set(8, s - 8, true);
}

/** Function-module map of a version (1 = finder / timing / alignment / format / version), for decoders. */
export function functionMask(ver: number): Uint8Array {
  const g = new Grid(ver * 4 + 17);
  drawFunctions(g, ver);
  return g.fn;
}

/** Data-module visiting order: two-column zigzag from the bottom right, skipping the vertical timing column. */
export function dataOrder(size: number, fn: Uint8Array): number[] {
  const out: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const up = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = up ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const i = y * size + right - j;
        if (!fn[i]) out.push(i);
      }
    }
  }
  return out;
}

export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++)
    for (let x = 0; x < g.size; x++) {
      const i = y * g.size + x;
      if (!g.fn[i] && maskBit(mask, x, y)) g.m[i] ^= 1;
    }
}

/** Penalty score (spec 7.8.3: runs, 2×2 blocks, finder-like patterns, dark balance). */
export function penalty(m: Uint8Array, size: number): number {
  let p = 0;
  const at = (x: number, y: number, col: boolean) => (col ? m[x * size + y] : m[y * size + x]);
  for (const col of [false, true])
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && at(x, y, col) === at(x - 1, y, col)) run++;
        else {
          if (run >= 5) p += run - 2;
          run = 1;
        }
      }
      for (let x = 0; x + 10 < size; x++) {
        let a = true, b = true;
        for (let k = 0; k < 11; k++) {
          const v = at(x + k, y, col);
          if (v !== [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0][k]) a = false;
          if (v !== [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1][k]) b = false;
        }
        if (a) p += 40;
        if (b) p += 40;
      }
    }
  let dark = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = m[y * size + x];
      dark += c;
      if (x + 1 < size && y + 1 < size && c === m[y * size + x + 1] && c === m[(y + 1) * size + x] && c === m[(y + 1) * size + x + 1]) p += 3;
    }
  return p + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
}

/** Interleaved data + EC codewords for a version. */
function codewords(bytes: Uint8Array, ver: number): Uint8Array {
  const L = blockLayout(ver);
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = L.data * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = new Uint8Array(L.data);
  for (let i = 0; i < bits.length; i += 8) data[i / 8] = parseInt(bits.slice(i, i + 8).join(''), 2);
  for (let i = bits.length / 8, k = 0; i < L.data; i++, k++) data[i] = k % 2 ? 0x11 : 0xec;
  const blocks: Uint8Array[] = [], ecs: Uint8Array[] = [];
  for (let b = 0, off = 0; b < L.blocks; b++) {
    const n = L.shortData + (b < L.shortCount ? 0 : 1);
    const blk = data.subarray(off, off + n);
    off += n;
    blocks.push(blk);
    ecs.push(rsRemainder(blk, L.ec));
  }
  const out: number[] = [];
  for (let i = 0; i <= L.shortData; i++) for (const blk of blocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < L.ec; i++) for (const e of ecs) out.push(e[i]);
  return Uint8Array.from(out);
}

/** Encode text (UTF-8) or bytes. `version` / `mask` pin the choice (tests); otherwise smallest version, best mask. */
export function encodeQr(input: string | Uint8Array, opt: { version?: number; mask?: number } = {}): QrCode {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let ver = opt.version ?? 1;
  while (ver <= 40 && qrCapacity(ver) < bytes.length) {
    if (opt.version) throw new Error(`QR: ${bytes.length} bytes do not fit version ${ver}`);
    ver++;
  }
  if (ver > 40) throw new Error(`QR: ${bytes.length} bytes exceed ${QR_MAX_BYTES}`);
  const g = new Grid(ver * 4 + 17);
  drawFunctions(g, ver);
  const cw = codewords(bytes, ver);
  const order = dataOrder(g.size, g.fn);
  for (let k = 0; k < order.length; k++) {
    const bi = k >> 3;
    g.m[order[k]] = bi < cw.length ? (cw[bi] >> (7 - (k & 7))) & 1 : 0;
  }
  let best = opt.mask ?? -1;
  if (best < 0) {
    let score = Infinity;
    for (let mk = 0; mk < 8; mk++) {
      applyMask(g, mk);
      drawFormat(g, mk);
      const p = penalty(g.m, g.size);
      if (p < score) [score, best] = [p, mk];
      applyMask(g, mk);
    }
  }
  applyMask(g, best);
  drawFormat(g, best);
  return { version: ver, size: g.size, mask: best, modules: g.m };
}
