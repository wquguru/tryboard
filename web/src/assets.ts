// Shared asset loading: wasm core, chip ROMs, firmware images.
import type { ChipId } from './board3d';
import { imageChip as chipOf } from './simrun';

export const ROM_FILE: Record<ChipId, string> = { esp32: 'esp32_rev300_rom.elf', esp32c3: 'esp32c3_rev3_rom.elf', esp32s3: 'esp32s3_rev0_rom.elf' };

/** Hosts that refuse binaries get firmware and ROMs as base64 text (page has <meta name="tryboard-pack" content="b64">). */
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

/** Which chip an image targets (shared with the npm CLI, see simrun.ts). */
export function imageChip(buf: ArrayBuffer): ChipId {
  return chipOf(buf);
}

let wasmP: Promise<ArrayBuffer> | null = null;
const romP: Partial<Record<ChipId, Promise<ArrayBuffer>>> = {};
export const loadWasm = () => (wasmP ??= fetchBuf('./wasm/tryboard.wasm'));
export const loadRom = (chip: ChipId) => (romP[chip] ??= fetchBuf(`./rom/${ROM_FILE[chip]}`));
