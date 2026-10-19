// "Real network" (C-03): HTTP the chip sends to hosts other than tryboard.local really goes out via browser fetch; the reply becomes a
// script action netreply=... (into the input log), so replays never go online. Only HTTP is allowed (DECISIONS 2026-10-19 C-03).
import { t } from './i18n';

/** One request in the core's outbox (tb_net_outbox JSON) */
export interface RealReq {
  id: number;
  method: string;
  url: string;
  ctype?: string;
  /** Request body base64 (POST only) */
  body?: string;
}

export interface RealReply {
  /** Script action: netreply=id,status,ms,content type or reason code,base64 body */
  action: string;
  status: number;
  ms: number;
  bytes: number;
  reason?: string;
}

/** Reply body cap: the chip only gets the first 64KB (one input-log line holds it, and the chip's buffer is far smaller) */
export const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 10_000;

function b64(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s: string) {
  const t = atob(s);
  const b = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
  return b;
}

/** Keep only the media type of the content type, dropping commas, semicolons and spaces: scripts separate actions with `; ` and netreply separates fields with commas */
const cleanType = (t: string | null) => (t ?? 'application/octet-stream').split(';')[0].replace(/[\s,;]/g, '') || 'application/octet-stream';

export async function realFetch(r: RealReq): Promise<RealReply> {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const ms = () => Math.round(performance.now() - t0);
  const fail = (reason: string): RealReply => ({ action: `netreply=${r.id},0,${ms()},${reason},`, status: 0, ms: ms(), bytes: 0, reason });
  try {
    const res = await fetch(r.url, {
      method: r.method,
      body: r.body && r.method !== 'GET' && r.method !== 'HEAD' ? unb64(r.body) : undefined,
      // Send only the content type: other headers would trigger a preflight, and browsers mostly forbid pages setting them
      headers: r.ctype ? { 'Content-Type': r.ctype } : undefined,
      credentials: 'omit',
      cache: 'no-store',
      signal: ac.signal,
    });
    const body = new Uint8Array(await res.arrayBuffer()).subarray(0, MAX_BODY);
    return { action: `netreply=${r.id},${res.status},${ms()},${cleanType(res.headers.get('content-type'))},${b64(body)}`, status: res.status, ms: ms(), bytes: body.length };
  } catch {
    if (ac.signal.aborted) return fail('timeout');
    // http request from an https page: the browser blocks it as mixed content, unrelated to CORS
    if (typeof location !== 'undefined' && location.protocol === 'https:' && r.url.startsWith('http:')) return fail('mixed');
    // Tell CORS from unreachable: retry with no-cors; an opaque reply means the host is up but sent no CORS headers.
    // Retry only GET: resending a POST would make the host receive it again
    if (r.method !== 'GET') return fail('blocked');
    try {
      await fetch(r.url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: ac.signal });
      return fail('cors');
    } catch {
      return fail(ac.signal.aborted ? 'timeout' : 'net');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Reason code -> one human sentence (same set as the core's Network tab note) */
export const reasonText = (code: string): string =>
  ({
    cors: t('The site does not allow cross-origin requests (CORS); the browser blocked it'),
    net: t('Cannot connect (no such domain, offline or blocked)'),
    timeout: t('No reply in 10 s'),
    mixed: t('The page is https; the browser does not allow http requests (mixed content)'),
    blocked: t('Blocked by the browser (cross-origin or network error)'),
  })[code] ?? code;
