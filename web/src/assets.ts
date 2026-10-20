// Shared asset loading: wasm core, chip ROMs, firmware images.
import type { ChipId } from './board3d';
import { imageChip as chipOf } from './simrun';

import { ROM_FILE } from './chipid';

export { ROM_FILE };

/** Hosts that refuse binaries get firmware and ROMs as base64 text (page has <meta name="tryboard-pack" content="b64">). */
const PACKED = document.querySelector('meta[name="tryboard-pack"]')?.getAttribute('content') === 'b64';

/** Decode a prebuilt `.gz` sidecar response; null when unusable (SPA fallback HTML, corrupt data). */
async function gunzip(r: Response): Promise<ArrayBuffer | null> {
  if (!r.ok || /html/.test(r.headers.get('content-type') ?? '')) return null;
  const buf = await r.arrayBuffer();
  const b = new Uint8Array(buf);
  // Hosts that tag .gz with Content-Encoding: gzip (vite preview, some CDNs) hand over already-inflated bytes
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf.byteLength ? buf : null;
  try {
    return await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  } catch {
    return null;
  }
}

export async function fetchBuf(url: string) {
  const packed = PACKED && /\.(bin|elf)$/.test(url);
  // R-18: binaries ship with a gzip -9 sidecar so wire size doesn't depend on host compression; any failure uses the plain file
  if (!PACKED && /\.(bin|elf|wasm)$/.test(url) && typeof DecompressionStream !== 'undefined') {
    try {
      const raw = await gunzip(await fetch(url + '.gz'));
      if (raw) return raw;
    } catch {
      // Network error on the sidecar: fall through to the plain file
    }
  }
  const r =await fetch(packed ? url + '.b64.txt' : url);
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
let modP: Promise<WebAssembly.Module> | null = null;
/** The core compiled once per page (R-23): workers get the Module by structured clone, so nothing recompiles. */
export const loadWasmModule = () => (modP ??= loadWasm().then((b) => WebAssembly.compile(b)));
