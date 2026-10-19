// Helpers shared by the bench / product / assembly SVG views. Views only draw; all data comes from the simulator (LiveFrame).
import { t } from '../i18n';

/** One simulator frame for the views: OLED pixels, per-pin PWM duty, onboard RGB, running flag */
export interface LiveFrame {
  oled: Uint8Array | null;
  /** GC9A01 round LCD: 240×240 RGBA; null without one */
  lcd: Uint8Array | null;
  pwm: number[];
  rgb: number[] | null;
  /** External WS2812 strips: pin → per-LED [r,g,b] (P2-09 knob lamp) */
  strips?: Record<number, number[][]>;
  running: boolean;
}

export const emptyFrame = (): LiveFrame => ({ oled: null, lcd: null, pwm: [], rgb: null, running: false });

/** Mount SVG/HTML into a container; returns a lookup by data-k */
let uid = 0;
export function mount(el: HTMLElement, html: string) {
  // Several views can share a page: suffix SVG ids so url(#id) never points at another (possibly hidden) instance
  const n = ++uid;
  el.innerHTML = html.replace(/id="([\w-]+)"/g, `id="$1-${n}"`).replace(/url\(#([\w-]+)\)/g, `url(#$1-${n})`);
  return <T extends Element = SVGElement>(k: string) => el.querySelector(`[data-k="${k}"]`) as T;
}

/** Servo angle (°): 0.5–2.5 ms pulses at 50 Hz map to 0–180°; null without PWM */
export function servoAngle(pwm: number[], pin: number): number | null {
  const d = pwm[pin];
  if (d === undefined || d < 0) return null;
  const ms = d * 20;
  return Math.max(0, Math.min(180, ((ms - 0.5) / 2) * 180));
}

/** RGB LED colour: firmware often dims it (e.g. 0x20), so scale the brightest channel up to stay visible */
export function ledCss(rgb: number[] | null): string | null {
  if (!rgb) return null;
  const m = Math.max(...rgb);
  if (m === 0) return null;
  const k = 255 / m;
  return `rgb(${rgb.map((c) => Math.round(c * k)).join(',')})`;
}

const oledCanvas = document.createElement('canvas');
oledCanvas.width = 128;
oledCanvas.height = 64;
/** OLED 128×64 levels → cool-white image (data URL for <image href>) */
export function oledImage(px: Uint8Array): string {
  const g = oledCanvas.getContext('2d')!;
  const img = g.createImageData(128, 64);
  for (let i = 0; i < 128 * 64; i++) {
    const v = px[i] / 255;
    img.data[i * 4] = 5 + v * 210;
    img.data[i * 4 + 1] = 6 + v * 237;
    img.data[i * 4 + 2] = 8 + v * 247;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return oledCanvas.toDataURL();
}

const lcdCanvas = document.createElement('canvas');
lcdCanvas.width = 240;
lcdCanvas.height = 240;
/** GC9A01 240×240 RGBA → data URL */
export function lcdImage(rgba: Uint8Array): string {
  const g = lcdCanvas.getContext('2d')!;
  g.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, 240 * 240 * 4), 240, 240), 0, 0);
  return lcdCanvas.toDataURL();
}

/** Tick path for the 0–40 ℃ half dial */
export function dialTicks(cx: number, cy: number, r1: number, rMajor: number, rMinor: number, step: number, major: number) {
  let d = '';
  for (let t = 0; t <= 40; t += step) {
    const a = ((180 - t * 4.5) * Math.PI) / 180;
    const r2 = t % major === 0 ? rMajor : rMinor;
    d += `M${(cx + r1 * Math.cos(a)).toFixed(1)} ${(cy - r1 * Math.sin(a)).toFixed(1)} L${(cx + r2 * Math.cos(a)).toFixed(1)} ${(cy - r2 * Math.sin(a)).toFixed(1)} `;
  }
  return d;
}

export function dialLabel(cx: number, cy: number, r: number, t: number) {
  const a = ((180 - t * 4.5) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a) + 4];
}

/** Squeeze an SVG text into max user units when a translation runs long; no-op while hidden (length reads 0). */
export function fitText(el: Element, max: number) {
  const tx = el as SVGTextElement;
  tx.removeAttribute('textLength');
  tx.removeAttribute('lengthAdjust');
  if ((tx.getComputedTextLength?.() ?? 0) > max) {
    tx.setAttribute('textLength', String(max));
    tx.setAttribute('lengthAdjust', 'spacingAndGlyphs');
  }
}

/** Wrap text into at most `lines` tspans of max width (breaks at spaces, or anywhere for CJK), squeezing the last line. */
export function wrapText(el: Element, text: string, max: number, lh: number, lines = 2) {
  const tx = el as SVGTextElement;
  const x = tx.getAttribute('x') ?? '0';
  tx.textContent = '';
  const ns = 'http://www.w3.org/2000/svg';
  const line = (first: boolean) => {
    const s = document.createElementNS(ns, 'tspan');
    s.setAttribute('x', x);
    if (!first) s.setAttribute('dy', String(lh));
    tx.appendChild(s);
    return s;
  };
  let cur: SVGTSpanElement = line(true);
  cur.textContent = text;
  if ((cur.getComputedTextLength?.() ?? 0) <= max) return;
  cur.textContent = '';
  const tokens = text.match(/\S+\s*|\s+/g) ?? [];
  let n = 1;
  for (const tok of tokens.flatMap((w) => (w.length > 1 && !/\s/.test(w) && /[^\x00-ɏ]/.test(w) ? [...w] : [w]))) {
    const prev: string = cur.textContent ?? '';
    cur.textContent = prev + tok;
    if (prev && n < lines && cur.getComputedTextLength() > max) {
      cur.textContent = prev.trimEnd();
      cur = line(false);
      cur.textContent = tok.trimStart();
      n++;
    }
  }
  fitText(cur, max);
}

/** Press / release via pointer events; release listens on window so dragging off the button still releases */
export function holdButton(el: Element, onDown: () => void, onUp: () => void) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onDown();
    const up = () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onUp();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  el.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if ((k === 'Enter' || k === ' ') && !(e as KeyboardEvent).repeat) {
      e.preventDefault();
      onDown();
      setTimeout(onUp, 150);
    }
  });
}

/** Environment box (ENV · TEMP) SVG, shared by two views */
export const envBoxSvg = `
<rect x="60" y="420" width="230" height="108" rx="8" fill="#1A1A19" stroke="#3A3936" stroke-width="1.5"/>
<text x="78" y="446" fill="#8A867E" class="tb-mono" font-size="10" font-weight="700">${t('Room temp')}</text>
<rect x="76" y="456" width="120" height="56" rx="4" fill="#0E0E0D"/>
<text data-k="envTemp" x="186" y="498" fill="#FF7A1A" class="tb-mono" font-size="34" font-weight="700" text-anchor="end">23.5</text>`;

/** −/+ beside the environment box (HTML buttons over the SVG, positioned in %) */
export const envButtons = `
<div class="tb-env">
<button type="button" data-k="down" aria-label="${t('Cooler')}">−</button>
<button type="button" data-k="up" aria-label="${t('Warmer')}">+</button>
</div>`;
