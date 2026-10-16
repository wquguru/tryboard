// 页面共用的资源加载：wasm 内核、各芯片 ROM、固件镜像。
import type { ChipId } from './board3d';

export const ROM_FILE: Record<ChipId, string> = { esp32c3: 'esp32c3_rev3_rom.elf', esp32s3: 'esp32s3_rev0_rom.elf' };

/** 发布到不托管二进制的环境时（页面带 <meta name="tryboard-pack" content="b64">），固件与 ROM 以 base64 文本存放 */
const PACKED = document.querySelector('meta[name="tryboard-pack"]')?.getAttribute('content') === 'b64';

export async function fetchBuf(url: string) {
  const packed = PACKED && /\.(bin|elf)$/.test(url);
  const r = await fetch(packed ? url + '.b64.txt' : url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (!packed) return r.arrayBuffer();
  const bin = atob((await r.text()).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** 镜像是哪颗芯片：先找分区表（0x8000）里的 app，再读 ESP 镜像头的芯片 ID（5 = C3，9 = S3） */
export function imageChip(buf: ArrayBuffer): ChipId {
  const b = new Uint8Array(buf);
  const u32 = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  let app = 0;
  if (b[0x8000] === 0xaa && b[0x8001] === 0x50) {
    for (let i = 0; i < 95; i++) {
      const o = 0x8000 + i * 32;
      if (b[o] !== 0xaa || b[o + 1] !== 0x50) break;
      if (b[o + 2] === 0 && (b[o + 3] === 0 || b[o + 3] === 0x10)) {
        app = u32(o + 4) >>> 0;
        break;
      }
    }
  }
  return b[app] === 0xe9 && (b[app + 12] | (b[app + 13] << 8)) === 9 ? 'esp32s3' : 'esp32c3';
}

let wasmP: Promise<ArrayBuffer> | null = null;
const romP: Partial<Record<ChipId, Promise<ArrayBuffer>>> = {};
export const loadWasm = () => (wasmP ??= fetchBuf('./wasm/tryboard.wasm'));
export const loadRom = (chip: ChipId) => (romP[chip] ??= fetchBuf(`./rom/${ROM_FILE[chip]}`));
