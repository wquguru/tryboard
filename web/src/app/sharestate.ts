// Bench state v1 for share links (F-01a): versioned JSON -> deflate-raw -> base64url in ?s= (format: docs/ARCH.md "Share state v1").
// Pure module (no DOM, no i18n) so node tests, F-01b files, F-02 cards and F-03 embeds can all use it.
import type { SceneSpec } from '../bench3d/spec';
import type { WireMods } from './wiring';
import type { CaseHarness } from './harness';
import { fromScript, toScriptBody, type InputEvent, type InputLog } from '../inputlog.ts';
import { CHIP_ID, type SimChip } from '../chipid.ts';

export type ShareChip = SimChip;
export interface ShareEnv {
  temp: number;
  humidity: number;
  pressure: number;
}

/** State v1. Optional fields are left out when at the default; adding optional fields does not bump v */
export interface ShareStateV1 {
  v: 1;
  /** Work id ('weather', 'lamp'…), 'blank:<example>' or 'custom' (then sel holds the advisor query) */
  w: string;
  /** Advisor query (advisor/state.ts encode(s, false), no `have`), only for w = 'custom' */
  sel?: string;
  /** Preselected checkpoint */
  cp?: string;
  /** Built-in firmware: example id + sha256[:10] of its flash.bin (same as tools/asset_hashes.py). Absent: none / user's own bin */
  fw?: { ex: string; h: string };
  chip?: ShareChip;
  /** Bench scene, only when it differs from the work default */
  scene?: SceneSpec;
  /** External 5 V supply (default USB) */
  ext5v?: boolean;
  /** Rewires (WireMods), only when non-empty */
  mods?: WireMods;
  /** Enclosure harness choice (assembly step), only when not the default */
  harness?: CaseHarness;
  /** Room environment when there is no run (with a run, the script's first env line is the power-up one) */
  env?: ShareEnv;
  /** Heat source part id near the BME280 */
  heat?: string;
  /** Sharer's UI language (en / zh / ja / ko); the viewer keeps their own (DECISIONS 2026-10-20) */
  loc?: string;
  /** Input log since the last power-up: script body (toScriptBody) and the simulated end time (ms, full precision) */
  run?: { endMs: number; s: string };
  /** What redaction removed before sharing: wifi = Wi-Fi credentials in provisioning posts, net = real-network replies */
  cut?: ('wifi' | 'net')[];
  /** .tryboard only (F-01b): the user's own firmware appended after the JSON line; h = full sha256 hex, size in bytes */
  bin?: { name: string; h: string; size: number };
  /** MicroPython main.py in the editor (F-07b), only while a MicroPython image is on the bench */
  mpy?: string;
}
export type ShareState = ShareStateV1;

/** Highest version this page decodes */
export const SHARE_VERSION = 1;
/** Above this many characters the link drops `run` (the .tryboard file of F-01b carries it) */
export const SHARE_LINK_MAX = 8000;

export class ShareDecodeError extends Error {
  /** corrupt = not base64url / deflate / JSON / schema; newer = made by a newer TryBoard */
  reason: 'corrupt' | 'newer';
  constructor(reason: 'corrupt' | 'newer', message: string) {
    super(message);
    this.reason = reason;
  }
}

const b64url = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const unb64url = (s: string) => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new ShareDecodeError('corrupt', 'not base64url');
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** State -> `?s=` value */
export async function encodeState(state: ShareState): Promise<string> {
  return b64url(await pipe(new TextEncoder().encode(JSON.stringify(state)), new CompressionStream('deflate-raw')));
}

/** `?s=` value -> state (migrated to the current version); throws ShareDecodeError */
export async function decodeState(str: string): Promise<ShareState> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await pipe(unb64url(str.trim()), new DecompressionStream('deflate-raw'))));
  } catch (e) {
    throw e instanceof ShareDecodeError ? e : new ShareDecodeError('corrupt', String(e));
  }
  return migrate(raw);
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Version check and migration. Old decoders are never deleted: links live on in group chats */
export function migrate(raw: unknown): ShareState {
  if (!isObj(raw) || typeof raw.v !== 'number') throw new ShareDecodeError('corrupt', 'no version');
  if (raw.v > SHARE_VERSION) throw new ShareDecodeError('newer', `v${raw.v}`);
  if (raw.v !== 1) throw new ShareDecodeError('corrupt', `v${raw.v}`);
  return validV1(raw);
}

function validV1(r: Record<string, unknown>): ShareStateV1 {
  const bad = (what: string) => {
    throw new ShareDecodeError('corrupt', what);
  };
  if (typeof r.w !== 'string' || !/^[\w:.-]{1,80}$/.test(r.w)) bad('w');
  if (r.sel !== undefined && typeof r.sel !== 'string') bad('sel');
  if (r.cp !== undefined && typeof r.cp !== 'string') bad('cp');
  if (r.fw !== undefined && (!isObj(r.fw) || typeof r.fw.ex !== 'string' || !/^[\w.-]+$/.test(r.fw.ex) || typeof r.fw.h !== 'string')) bad('fw');
  if (r.chip !== undefined && !Object.hasOwn(CHIP_ID, r.chip as string)) bad('chip');
  if (r.scene !== undefined && (!isObj(r.scene) || !Array.isArray(r.scene.parts))) bad('scene');
  if (r.ext5v !== undefined && typeof r.ext5v !== 'boolean') bad('ext5v');
  if (r.mods !== undefined && !isObj(r.mods)) bad('mods');
  if (r.harness !== undefined && (!isObj(r.harness) || typeof r.harness.i2cCm !== 'number' || typeof r.harness.distMm !== 'number' || !['none', 'battery', 'metal'].includes(r.harness.obstacle as string))) bad('harness');
  if (r.env !== undefined && (!isObj(r.env) || !['temp', 'humidity', 'pressure'].every((k) => typeof (r.env as Record<string, unknown>)[k] === 'number'))) bad('env');
  if (r.heat !== undefined && typeof r.heat !== 'string') bad('heat');
  if (r.loc !== undefined && typeof r.loc !== 'string') bad('loc');
  if (r.run !== undefined) {
    if (!isObj(r.run) || typeof r.run.endMs !== 'number' || !(r.run.endMs >= 0) || typeof r.run.s !== 'string') bad('run');
    try {
      fromScript((r.run as { s: string }).s);
    } catch (e) {
      bad(`run.s: ${e}`);
    }
  }
  if (r.bin !== undefined && (!isObj(r.bin) || typeof r.bin.name !== 'string' || !/^[^/\\]{1,200}$/.test(r.bin.name) || typeof r.bin.h !== 'string' || !/^[0-9a-f]{64}$/.test(r.bin.h) || typeof r.bin.size !== 'number' || !(r.bin.size > 0))) bad('bin');
  if (r.mpy !== undefined && (typeof r.mpy !== 'string' || r.mpy.length > 65536)) bad('mpy');
  if (r.cut !== undefined && (!Array.isArray(r.cut) || !r.cut.every((c) => c === 'wifi' || c === 'net'))) bad('cut');
  return r as unknown as ShareStateV1;
}

/** Public demo values of the virtual router / wrong-password demo (netpane.tsx): not secrets, kept so replays still match */
const DEMO_CREDS = new Set(['MyHome', '12345678', 'wrongpass']);
const CRED_KEY = /^(ssid|pass|password|passwd|pwd|psk|key)$/i;
export const REDACTED = '***';

/** Strip what must not leave the device (RS-6 A4): Wi-Fi credentials in provisioning posts, real-network switch and replies */
export function redact(events: InputEvent[]): { events: InputEvent[]; cut: ('wifi' | 'net')[] } {
  const cut = new Set<'wifi' | 'net'>();
  const out: InputEvent[] = [];
  for (const e of events) {
    if (e.kind === 'netreply' || e.kind === 'realnet') {
      if (e.kind === 'netreply' || e.on) cut.add('net');
      continue;
    }
    if (e.kind === 'phone' && e.cmd.startsWith('post,')) {
      const i = e.cmd.indexOf(',', 5);
      const head = e.cmd.slice(0, i + 1);
      const body = e.cmd.slice(i + 1);
      const fields = body.split('&').map((kv) => {
        const j = kv.indexOf('=');
        if (j < 0 || !CRED_KEY.test(kv.slice(0, j))) return kv;
        const val = decodeURIComponentSafe(kv.slice(j + 1));
        if (DEMO_CREDS.has(val)) return kv;
        cut.add('wifi');
        return `${kv.slice(0, j)}=${REDACTED}`;
      });
      out.push({ ...e, cmd: head + fields.join('&') });
      continue;
    }
    out.push(e);
  }
  return { events: out, cut: [...cut] };
}
const decodeURIComponentSafe = (s: string) => {
  try {
    return decodeURIComponent(s.replaceAll('+', ' '));
  } catch {
    return s;
  }
};

/** What the page knows at share time (main.tsx fills it from session / store) */
export interface CaptureInput {
  /** Work id, its example (blank works) and whether it is a board-picker work */
  workId: string;
  example?: string;
  /** Advisor query for custom works */
  sel?: string;
  cp?: string | null;
  /** session.fwName ('<id>/flash.bin' for built-in firmware) and its bytes */
  fwName: string;
  fwBuf: ArrayBuffer | null;
  chip?: ShareChip;
  scene: SceneSpec;
  /** The work's default scene (examples.json); null = always write the scene */
  defaultScene: SceneSpec | null;
  ext5v: boolean;
  mods: WireMods;
  harness: CaseHarness | null;
  defaultHarness: CaseHarness;
  env: ShareEnv;
  heat: string | null;
  loc: string;
  log: InputLog | null;
  /** Keep the run for the user's own firmware too (the .tryboard file carries the bin, F-01b) */
  ownRun?: boolean;
  /** MicroPython main.py (F-07b) */
  mpy?: string;
}

/** Built-in firmware name -> example id; anything else (dropped .bin) is the user's own */
export const builtinFw = (fwName: string) => /^([\w.-]+)\/flash\.bin$/.exec(fwName)?.[1] ?? null;

/** Full sha256 hex (the .tryboard bin check) */
export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256[:10] hex, the same content hash tools/asset_hashes.py writes for fw/<id>/flash.bin */
export async function fwHash(buf: ArrayBuffer): Promise<string> {
  return (await sha256Hex(buf)).slice(0, 10);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const nonEmpty = (m: WireMods) => Object.values(m).some((v) => (Array.isArray(v) ? v.length : v && Object.keys(v).length));

/** Collect the bench into a v1 state. ownFw = the running firmware is the user's own (not shareable until F-01b) */
export async function captureState(c: CaptureInput): Promise<{ state: ShareState; ownFw: boolean }> {
  const ex = builtinFw(c.fwName);
  const w = c.workId === 'blank' && c.example ? `blank:${c.example}` : c.workId;
  const state: ShareState = { v: 1, w };
  if (c.workId === 'custom' && c.sel) state.sel = c.sel;
  if (c.cp) state.cp = c.cp;
  if (ex && c.fwBuf) state.fw = { ex, h: await fwHash(c.fwBuf) };
  if (c.chip) state.chip = c.chip;
  // External 5 V rides on the placement, so it needs the scene too
  if (!c.defaultScene || c.ext5v || !same(c.scene, c.defaultScene)) state.scene = c.scene;
  if (c.ext5v) state.ext5v = true;
  if (nonEmpty(c.mods)) state.mods = c.mods;
  if (c.harness && !same(c.harness, c.defaultHarness)) state.harness = c.harness;
  if (c.heat) state.heat = c.heat;
  state.loc = c.loc;
  if (c.mpy) state.mpy = c.mpy;
  // The input log only replays on the firmware it was recorded with
  if (c.log && (state.fw || (c.ownRun && c.fwBuf)) && c.log.endMs !== undefined) {
    const r = redact(c.log.events);
    state.run = { endMs: c.log.endMs, s: toScriptBody(r.events) };
    if (r.cut.length) state.cut = r.cut;
  } else state.env = { temp: c.env.temp, humidity: c.env.humidity, pressure: c.env.pressure };
  return { state, ownFw: !!c.fwBuf && !ex };
}

/** Link for a state: drops `run` above `max` characters of `s` (truncated = true; the share card's QR passes a lower max) */
export async function shareLink(base: string, state: ShareState, max = SHARE_LINK_MAX): Promise<{ url: string; s: string; truncated: boolean }> {
  let s = await encodeState(state);
  let truncated = false;
  if (s.length > max && state.run) {
    const { run, cut: _cut, ...rest } = state;
    s = await encodeState({ ...rest, env: firstEnv(run.s) ?? undefined });
    truncated = true;
  }
  const u = new URL(base);
  u.search = `s=${s}`;
  u.hash = 'bench';
  return { url: u.toString(), s, truncated };
}

/** Power-up environment of a run script (its first env line), else null */
export function firstEnv(script: string): ShareEnv | null {
  const e = fromScript(script).find((x) => x.kind === 'env');
  return e && e.kind === 'env' ? { temp: e.temp, humidity: e.humidity, pressure: e.pressure } : null;
}

/** Local-copy key of a shared state: `share:<fnv(s)>` (like custom:<fnv>), so the user's own work of the same name is untouched */
export function shareKey(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `share:${h.toString(16).padStart(8, '0')}`;
}

/** First line of a .tryboard file (F-01b); the number is the file format version, independent of the state's `v` */
export const TRYFILE_MAGIC = 'TRYBOARD';
export const TRYFILE_VERSION = 1;

/** .tryboard bytes: `TRYBOARD 1\n` + state JSON + `\n` + raw bin (uncompressed). The bin's name comes from state.bin.name */
export async function packTryfile(state: ShareState, bin: ArrayBuffer | null, binName = 'firmware.bin'): Promise<Uint8Array> {
  const st: ShareState = { ...state };
  if (bin && bin.byteLength) st.bin = { name: binName.replace(/[/\\]/g, '-').slice(0, 200), h: await sha256Hex(bin), size: bin.byteLength };
  else delete st.bin;
  const head = new TextEncoder().encode(`${TRYFILE_MAGIC} ${TRYFILE_VERSION}\n${JSON.stringify(st)}\n`);
  const out = new Uint8Array(head.length + (st.bin ? bin!.byteLength : 0));
  out.set(head);
  if (st.bin) out.set(new Uint8Array(bin!), head.length);
  return out;
}

/** Parse and check a .tryboard file: magic, version, state schema, bin size and sha256. Throws ShareDecodeError */
export async function unpackTryfile(bytes: Uint8Array): Promise<{ state: ShareState; bin: ArrayBuffer | null }> {
  // Split on bytes: only the two header lines are text, the bin is not UTF-8
  const nl1 = bytes.indexOf(0x0a);
  const nl2 = nl1 < 0 ? -1 : bytes.indexOf(0x0a, nl1 + 1);
  if (nl2 < 0) throw new ShareDecodeError('corrupt', 'no header');
  const m = /^TRYBOARD (\d+)$/.exec(new TextDecoder().decode(bytes.subarray(0, nl1)));
  if (!m) throw new ShareDecodeError('corrupt', 'not a .tryboard file');
  if (+m[1] > TRYFILE_VERSION) throw new ShareDecodeError('newer', `file v${m[1]}`);
  if (+m[1] !== TRYFILE_VERSION) throw new ShareDecodeError('corrupt', `file v${m[1]}`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(nl1 + 1, nl2)));
  } catch (e) {
    throw new ShareDecodeError('corrupt', String(e));
  }
  const state = migrate(raw);
  const rest = bytes.slice(nl2 + 1);
  if (!state.bin) {
    if (rest.length) throw new ShareDecodeError('corrupt', 'unexpected bytes after the state');
    return { state, bin: null };
  }
  if (rest.length !== state.bin.size) throw new ShareDecodeError('corrupt', `bin size ${rest.length} != ${state.bin.size}`);
  if ((await sha256Hex(rest)) !== state.bin.h) throw new ShareDecodeError('corrupt', 'bin sha256 mismatch');
  return { state, bin: rest.buffer };
}
