// G-16b Dial timer: flat product (SVG) = the M5Stack Dial seen from above, round GC9A01 screen from the simulator frame.
// Ring drag / wheel = encoder detents, a tap on the ring = BtnA (G42), a tap on the glass = touch; state comes from serial.
import { t } from '../i18n';
import { lcdImage, mount, type LiveFrame } from './common';
import { BG } from './workproducts';

export type DialMode = 'set' | 'run' | 'pause' | 'ring';
/** Timer state rebuilt from serial: mode, set minutes, seconds left, beeps of the current alarm, starts so far */
export interface DialtimerState {
  mode: DialMode;
  minutes: number;
  left: number;
  beeps: number;
  starts: number;
  ready: boolean;
}
export const dialtimerIdle = (): DialtimerState => ({ mode: 'set', minutes: 5, left: 300, beeps: 0, starts: 0, ready: false });
/** BtnA is the whole face on the real Dial (G42, active low) */
export const DIAL_BTN = 42;

const secs = (mm: string, ss: string) => Number(mm) * 60 + Number(ss);
export const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

type DialEvent = [icon: string, text: string, tone?: 'ok' | 'bad'];
/** One arduino-m5-dial-timer serial line -> new state + timeline event (null = no event) */
export function parseDialtimerLine(l: string, s: DialtimerState): DialEvent | null {
  let m: RegExpMatchArray | null;
  if (l.startsWith('Dial 计时器 就绪')) Object.assign(s, dialtimerIdle(), { ready: true }); // lint: allow-cjk
  else if ((m = /^(设定|回到设定|取消 回到) (\d\d):(\d\d)$/.exec(l))) { // lint: allow-cjk
    const was = s.mode;
    Object.assign(s, { mode: 'set', minutes: Number(m[2]), left: secs(m[2], m[3]) });
    if (m[1] === '取消 回到') return ['×', t('Cancelled by a tap: back to {t}', { t: `${m[2]}:${m[3]}` })]; // lint: allow-cjk
    if (m[1] === '回到设定') return ['↺', t('Alarm done: back to {t}', { t: `${m[2]}:${m[3]}` }), 'ok']; // lint: allow-cjk
    if (was === 'set') return ['↻', t('Set to {n} min', { n: Number(m[2]) })];
  } else if ((m = /^(开始|继续) (\d\d):(\d\d)$/.exec(l))) { // lint: allow-cjk
    Object.assign(s, { mode: 'run', left: secs(m[2], m[3]) });
    if (m[1] === '开始') s.starts++; // lint: allow-cjk
    return ['▶', m[1] === '开始' ? t('Countdown started: {t}', { t: `${m[2]}:${m[3]}` }) : t('Resumed at {t}', { t: `${m[2]}:${m[3]}` }), 'ok']; // lint: allow-cjk
  } else if ((m = /^暂停 (\d\d):(\d\d)$/.exec(l))) { // lint: allow-cjk
    Object.assign(s, { mode: 'pause', left: secs(m[1], m[2]) });
    return ['Ⅱ', t('Paused at {t}', { t: `${m[1]}:${m[2]}` })];
  } else if ((m = /^剩余 (\d\d):(\d\d)$/.exec(l))) s.left = secs(m[1], m[2]); // lint: allow-cjk
  else if (l === '时间到') { // lint: allow-cjk
    Object.assign(s, { mode: 'ring', left: 0, beeps: 0 });
    return ['!', t("Time's up"), 'ok'];
  } else if ((m = /^嘀 (\d)\/(\d) (\d+) Hz$/.exec(l))) { // lint: allow-cjk
    s.beeps = Number(m[1]);
    return ['♪', t('Beep {n}/{of} · {hz} Hz', { n: m[1], of: m[2], hz: m[3] })];
  }
  return null;
}

/** The product page's / home card's timer state (one at a time); reset on every power-up banner */
export const dialtimerNow: DialtimerState = dialtimerIdle();

export function modeText(s: DialtimerState) {
  return { set: t('Setting'), run: t('Counting down'), pause: t('Paused'), ring: t('Beeping') }[s.mode];
}

/** The mounted product view's ring (3D or 2D), so phone keys and desktop buttons turn it too */
export const dialRing: { view: { turned(n: number): void } | null } = { view: null };

export interface DialHandlers {
  /** Ring detents (+ = clockwise) */
  enc?(steps: number): void;
  /** BtnA (G42) down / up */
  btn?(down: boolean): void;
  /** Finger on the glass, panel pixels 0–239 */
  touch?(x: number, y: number, down: boolean): void;
}

const CX = 500, CY = 268, R_RING = 196, R_GLASS = 150, R_LCD = 130;
/** Ring drag: one detent per 15° of travel around the centre */
const DEG_PER_DETENT = 15;

export function createDialtimerProduct(el: HTMLElement, h: DialHandlers = {}, get: () => DialtimerState = () => dialtimerNow) {
  const live = !!(h.enc || h.btn || h.touch);
  const ribs = Array.from({ length: 48 }, (_, i) => {
    const a = (i / 48) * Math.PI * 2;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    return `<line x1="${(CX + c * (R_RING - 4)).toFixed(1)}" y1="${(CY + s * (R_RING - 4)).toFixed(1)}" x2="${(CX + c * (R_RING - 22)).toFixed(1)}" y2="${(CY + s * (R_RING - 22)).toFixed(1)}" stroke="#B4501C" stroke-width="4" stroke-linecap="round"/>`;
  }).join('');
  const q = mount(
    el,
    `<div class="tb-view sc-root dt-root"><svg viewBox="0 0 1000 560" role="img" aria-label="${t('Product: M5Stack Dial timer seen from above, orange rotary ring around a round touch screen')}">
${BG}
<defs><clipPath id="dt-face"><circle cx="${CX}" cy="${CY}" r="${R_LCD}"/></clipPath></defs>
<ellipse cx="${CX}" cy="${CY + 214}" rx="230" ry="28" fill="url(#wp-floor)"/>
<circle cx="${CX}" cy="${CY + 6}" r="${R_RING + 12}" fill="#2B2C30"/>
<g data-k="ring" style="cursor:${live ? 'grab' : 'default'};touch-action:none" role="slider" tabindex="${live ? 0 : -1}" aria-label="${t('Rotary ring: drag or scroll to set the minutes, tap to start or pause')}">
<circle cx="${CX}" cy="${CY}" r="${R_RING}" fill="#E86A2A"/><g data-k="ribs">${ribs}<circle cx="${CX + R_RING - 13}" cy="${CY}" r="6" fill="#F4F2EE"/></g>
</g>
<g data-k="glass" style="cursor:${live ? 'pointer' : 'default'};touch-action:none">
<circle cx="${CX}" cy="${CY}" r="${R_GLASS}" fill="#060607"/>
<circle cx="${CX}" cy="${CY}" r="${R_LCD}" fill="#000"/>
<image data-k="lcd" x="${CX - R_LCD}" y="${CY - R_LCD}" width="${R_LCD * 2}" height="${R_LCD * 2}" clip-path="url(#dt-face)" preserveAspectRatio="none" style="image-rendering:pixelated"/>
<text data-k="ph" x="${CX}" y="${CY + 16}" fill="#F2F2F2" class="tb-mono" font-size="54" font-weight="700" text-anchor="middle">05:00</text>
<circle data-k="finger" cx="${CX}" cy="${CY}" r="16" fill="none" stroke="#FFF" stroke-width="3" opacity="0"/>
</g>
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">${t('Dial timer · product · M5Stack Dial (ESP32-S3, GC9A01, encoder, buzzer)')}</text>
<text data-k="state" x="24" y="58" fill="#3A3936" class="tb-mono" font-size="14" font-weight="700"></text>
<text data-k="hint" x="24" y="80" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">${live ? t('Drag or scroll the ring · tap the ring = BtnA · tap the screen = cancel') : ''}</text>
</svg></div>`,
  );
  const svg = el.querySelector('svg')!;
  let turned = 0;
  const showRing = () => q('ribs').setAttribute('transform', `rotate(${turned * DEG_PER_DETENT} ${CX} ${CY})`);
  const turn = (n: number) => {
    if (!n) return;
    turned += n;
    showRing();
    h.enc?.(n);
  };
  /** Client point -> SVG user units */
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    return [p.x - CX, p.y - CY];
  };
  if (live) {
    const ring = q('ring');
    ring.addEventListener('wheel', (e) => {
      e.preventDefault();
      turn((e as WheelEvent).deltaY < 0 ? 1 : -1);
    }, { passive: false });
    ring.addEventListener('pointerdown', (e) => {
      const pe = e as PointerEvent;
      pe.preventDefault();
      const [x0, y0] = toSvg(pe);
      let last = Math.atan2(y0, x0);
      let acc = 0, moved = false;
      const t0 = performance.now();
      const move = (ev: PointerEvent) => {
        const [x, y] = toSvg(ev);
        const a = Math.atan2(y, x);
        let d = ((a - last) * 180) / Math.PI;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        last = a;
        acc += d;
        const n = Math.trunc(acc / DEG_PER_DETENT);
        if (n) {
          moved = true;
          acc -= n * DEG_PER_DETENT;
          turn(n);
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        // A tap (no detent, short) presses the Dial: down now, up 100 ms later so M5.update() sees both edges
        if (!moved && performance.now() - t0 < 600 && h.btn) {
          h.btn(true);
          setTimeout(() => h.btn?.(false), 100);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    ring.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'ArrowRight' || k === 'ArrowUp') turn(1);
      else if (k === 'ArrowLeft' || k === 'ArrowDown') turn(-1);
      else if (k === 'Enter' || k === ' ') {
        h.btn?.(true);
        setTimeout(() => h.btn?.(false), 100);
      } else return;
      e.preventDefault();
    });
    const glass = q('glass');
    glass.addEventListener('pointerdown', (e) => {
      const pe = e as PointerEvent;
      pe.preventDefault();
      const [x, y] = toSvg(pe);
      const px = Math.max(0, Math.min(239, 120 + (x / R_LCD) * 120)), py = Math.max(0, Math.min(239, 120 + (y / R_LCD) * 120));
      const f = q('finger');
      f.setAttribute('cx', String(CX + x));
      f.setAttribute('cy', String(CY + y));
      f.setAttribute('opacity', '0.8');
      h.touch?.(px, py, true);
      const up = () => {
        window.removeEventListener('pointerup', up);
        f.setAttribute('opacity', '0');
        h.touch?.(px, py, false);
      };
      window.addEventListener('pointerup', up);
    });
  }
  let lastLcd: Uint8Array | null = null;
  const view = {
    /** Ring turns that don't come from this picture (phone keys, desktop buttons) */
    turned(n: number) {
      turned += n;
      showRing();
    },
    update(f: LiveFrame) {
      if (f.lcd && f.lcd !== lastLcd) {
        lastLcd = f.lcd;
        q('lcd').setAttribute('href', lcdImage(f.lcd, f.lcdW ?? 240, f.lcdH ?? 240));
        q('ph').setAttribute('opacity', '0');
      }
      const s = get();
      q('state').textContent = s.ready ? `${modeText(s)} · ${mmss(s.left)} · ${t('{n} min set', { n: s.minutes })}` : '';
    },
  };
  if (live) dialRing.view = view;
  return view;
}
