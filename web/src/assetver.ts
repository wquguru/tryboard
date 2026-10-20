// R-19: large fixed-name files (wasm, ROM, firmware, sources, audio) get ?v=<content hash> so hosts can cache them as immutable.
// The map is inlined into each HTML page at build time (vite.config.ts); dev, tests and the npm CLI see none and use plain URLs.

declare global {
  var __TB_ASSETS__: Record<string, string> | undefined;
}

/** Packed (base64) pages are served by a host with its own caching; their file names must stay exactly as packed. */
const packed = () => globalThis.document?.querySelector('meta[name="tryboard-pack"]')?.getAttribute('content') === 'b64';

/**
 * Versioned URL for a site file: `./fw/weather/flash.bin` -> `./fw/weather/flash.bin?v=1a2b3c4d5e`.
 * `key` names the file whose hash to use (a `.gz` sidecar shares the plain file's); unknown files are returned unchanged.
 */
export function assetUrl(url: string, key = url): string {
  const h = globalThis.__TB_ASSETS__?.[key.split(/[?#]/)[0].replace(/^\.?\//, '')];
  return h && !packed() && !url.includes('?') ? `${url}?v=${h}` : url;
}
