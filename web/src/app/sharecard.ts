// Share card (F-02): 1080×1350 card = bench frame + work title + chip + QR of the share link; 6 s video (MP4 when the
// browser records it, else webm) plus a PNG still. No muxer, no GIF, QR self-written (RS-4 §3).
import { t } from '../i18n/index.ts';
import { CHIP_LABEL, type SimChip } from '../chips';
import { PAGE_SANS } from '../scene-api';
import { recordCanvas, renderStill, videoExt, type Capturable } from './capture';
import { encodeQr, QR_MAX_BYTES, type QrCode } from './qr';
import type { StepCtx } from './types';

export const CARD_W = 1080;
export const CARD_H = 1350;
export const CARD_SECONDS = 6;
/** Above this many URL characters the QR drops the run record (the brief: links over 2k carry the bench only). */
export const QR_LINK_MAX = 2000;
const FRAME_H = 810;
const PAD = 48;
const QR_TILE = 420;
const C = { bg: '#FFFFFF', fg: '#1E1E1E', muted: '#5F6670', accent: '#0B76C8', line: '#E3E6EA', frameBg: '#ECEFF3' };
const font = (w: number, px: number) => `${w} ${px}px ${PAGE_SANS}`;

/** QR placement on the card: top-left of module (0,0) in card pixels, module pitch, modules per side. */
export interface QrBox {
  x: number;
  y: number;
  module: number;
  size: number;
}

export function qrBox(q: QrCode): QrBox {
  // Integer module pitch with a 4-module quiet zone inside the white tile, centred.
  const module = Math.max(2, Math.floor(QR_TILE / (q.size + 8)));
  const px = module * q.size;
  const tx = CARD_W - PAD - QR_TILE, ty = FRAME_H + 40;
  return { x: tx + Math.floor((QR_TILE - px) / 2), y: ty + Math.floor((QR_TILE - px) / 2), module, size: q.size };
}

export interface CardInfo {
  title: string;
  chip: string;
  url: string;
  /** The link replays the sharer's actions (not just the bench). */
  run: boolean;
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  // CJK has no spaces: break per character when a word is wider than the line.
  const units = /\s/.test(text) ? text.split(/(\s+)/) : [...text];
  const lines: string[] = [];
  let cur = '';
  for (const u of units) {
    const next = cur + u;
    if (g.measureText(next).width <= maxW || !cur) cur = next;
    else {
      lines.push(cur.trim());
      cur = u.trimStart();
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && g.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

/** Shown link: host + path + start of the state, ellipsised to fit; the QR carries the full link. */
function linkText(g: CanvasRenderingContext2D, url: string, maxW: number): string {
  const u = new URL(url);
  let s = `${u.host}${u.pathname}${u.search}`;
  if (g.measureText(s).width <= maxW) return s;
  while (s.length > 8 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

/** Static part of the card (everything except the 3D frame). */
export function drawCardBase(info: CardInfo, q: QrCode): { canvas: HTMLCanvasElement; box: QrBox } {
  const cv = document.createElement('canvas');
  cv.width = CARD_W;
  cv.height = CARD_H;
  const g = cv.getContext('2d')!;
  g.fillStyle = C.frameBg;
  g.fillRect(0, 0, CARD_W, FRAME_H);
  g.fillStyle = C.bg;
  g.fillRect(0, FRAME_H, CARD_W, CARD_H - FRAME_H);
  g.fillStyle = C.line;
  g.fillRect(0, FRAME_H, CARD_W, 2);
  // QR tile: always black on white, whatever the page theme, so phones scan it.
  const tx = CARD_W - PAD - QR_TILE, ty = FRAME_H + 40;
  g.fillStyle = '#FFFFFF';
  g.fillRect(tx, ty, QR_TILE, QR_TILE);
  g.strokeStyle = C.line;
  g.lineWidth = 2;
  g.strokeRect(tx + 1, ty + 1, QR_TILE - 2, QR_TILE - 2);
  const box = qrBox(q);
  g.fillStyle = '#000000';
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y * q.size + x]) g.fillRect(box.x + x * box.module, box.y + y * box.module, box.module, box.module);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'center';
  g.fillStyle = C.muted;
  g.font = font(500, 24);
  g.fillText(t('Scan to open'), tx + QR_TILE / 2, ty + QR_TILE + 40);
  g.textAlign = 'left';
  const textW = tx - PAD - 40;
  let y = FRAME_H + 76;
  g.fillStyle = C.accent;
  g.font = font(700, 30);
  g.fillText('TryBoard', PAD, y);
  g.font = font(600, 46);
  g.fillStyle = C.fg;
  for (const l of wrap(g, info.title, textW, 2)) {
    y += 60;
    g.fillText(l, PAD, y);
  }
  g.font = font(500, 27);
  g.fillStyle = C.muted;
  for (const l of wrap(g, t('{chip} · runs in your browser, no board needed', { chip: info.chip }), textW, 2)) {
    y += 40;
    g.fillText(l, PAD, y);
  }
  y += 56;
  g.font = font(400, 26);
  g.fillStyle = C.fg;
  for (const l of wrap(g, info.run ? t('Opens this bench and replays the run') : t('Opens this bench with its parts and wiring'), textW, 2)) {
    y += 38;
    g.fillText(l, PAD, y);
  }
  g.font = font(500, 24);
  g.fillStyle = C.accent;
  g.fillText(linkText(g, info.url, textW), PAD, CARD_H - 92);
  g.font = font(400, 19);
  g.fillStyle = C.muted;
  g.fillText(wrap(g, t('TryBoard · {caption} · Illustrative look, not an official Espressif model', { caption: info.chip }), CARD_W - 2 * PAD, 1)[0], PAD, CARD_H - 40);
  return { canvas: cv, box };
}

/** Cover-crop `src` into the frame area. */
function drawFrame(g: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }) {
  const sw = src.width, sh = src.height;
  if (!sw || !sh) return;
  const s = Math.max(CARD_W / sw, FRAME_H / sh);
  const w = CARD_W / s, h = FRAME_H / s;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, (sw - w) / 2, (sh - h) / 2, w, h, 0, 0, CARD_W, FRAME_H);
}

export interface CardResult {
  url: string;
  /** Run record dropped to keep the QR scannable. */
  truncated: boolean;
  run: boolean;
  notes: string[];
  qr: QrBox & { version: number };
  png: Blob;
  pngName: string;
  slug: string;
}

/** Link + QR + PNG card. Throws when even the bench-only link is too long for a QR code. */
export async function makeCard(ctx: StepCtx): Promise<CardResult & { base: HTMLCanvasElement }> {
  const { makeShare } = await import('./shareopen');
  const overhead = (location.origin + location.pathname).length + '?s=#bench'.length;
  const link = await makeShare(ctx, QR_LINK_MAX - overhead);
  if (new TextEncoder().encode(link.url).length > QR_MAX_BYTES) throw new Error(t('The share link is too long for a QR code'));
  const q = encodeQr(link.url);
  const chip = CHIP_LABEL[ctx.session.chip as SimChip] ?? ctx.session.chip;
  const info: CardInfo = { title: t(ctx.work.title), chip, url: link.url, run: link.run };
  // Font slices load only once rendered text needs them (R-17); canvas text never triggers that.
  await Promise.all([font(700, 30), font(600, 46), font(500, 27), font(400, 26)].map((f) => document.fonts?.load(f, info.title + chip + 'TryBoard').catch(() => {})));
  const { canvas: base, box } = drawCardBase(info, q);
  const still = renderStill(ctx.session.bench.capture(), '');
  const out = document.createElement('canvas');
  out.width = CARD_W;
  out.height = CARD_H;
  const g = out.getContext('2d')!;
  g.drawImage(base, 0, 0);
  drawFrame(g, still.canvas);
  const png = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
  if (!png) throw new Error(t("The browser couldn't create the PNG"));
  const slug = `${ctx.work.example ?? ctx.work.id}-card`;
  const notes = link.truncated ? [t('Your actions are too long for a QR code, so the card links to the bench only')] : link.notes;
  return { url: link.url, truncated: link.truncated, run: link.run, notes, qr: { ...box, version: q.version }, png, pngName: `tryboard-${slug}.png`, slug, base };
}

export interface CardVideo {
  blob: Blob;
  name: string;
  mime: string;
  seconds: number;
}

/** Record the card live for `seconds`: each frame renders the bench and copies it in the same task (no preserved buffer). */
export function recordCard(cap: Capturable, base: HTMLCanvasElement, slug: string, seconds = CARD_SECONDS, onTick?: (s: number) => void): { done: Promise<CardVideo>; stop(): void } {
  const cv = document.createElement('canvas');
  cv.width = CARD_W;
  cv.height = CARD_H;
  const g = cv.getContext('2d')!;
  const frame = () => {
    g.drawImage(base, 0, 0);
    cap.render();
    drawFrame(g, cap.renderer.domElement);
  };
  frame();
  let blob: Blob | null = null;
  const rec = recordCanvas(cv, slug, null, seconds, { prefer: 'mp4', bitrate: 4_000_000, onBlob: (b) => (blob = b) });
  let raf = 0;
  const loop = () => {
    frame();
    onTick?.(rec.elapsed());
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  const done = rec.done
    .then((v) => {
      if (!blob) throw new Error(t('Recording failed'));
      return { blob, name: `tryboard-${slug}.${videoExt(v.mime)}`, mime: v.mime, seconds: v.seconds };
    })
    .finally(() => cancelAnimationFrame(raf));
  return { done, stop: () => rec.stop() };
}
