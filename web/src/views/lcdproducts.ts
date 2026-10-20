// Round-LCD products: turning Little Yellow (servo turntable + LCD face) and the lens buddy (LCD + lens dome). Pixels come from the simulated GC9A01.
import { t } from '../i18n';
import { holdButton, lcdImage, mount, servoAngle, type LiveFrame } from './common';
import type { ProductHandlers } from './product';

export interface LcdEffects {
  /** Degrees the horn is off (not centred during assembly) */
  hornOffset?: number;
  /** Lens magnification (set by the spacer height) */
  lensScale?: number;
}

const floor = `<defs>
<radialGradient id="lp-floor" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#141414" stop-opacity="0.28"/><stop offset="1" stop-color="#141414" stop-opacity="0"/></radialGradient>
<radialGradient id="lp-dome" cx="0.38" cy="0.3" r="0.75"><stop offset="0" stop-color="#FFF" stop-opacity="0.55"/><stop offset="0.35" stop-color="#FFF" stop-opacity="0.08"/><stop offset="0.85" stop-color="#9FB4C8" stop-opacity="0.18"/><stop offset="1" stop-color="#5E738A" stop-opacity="0.55"/></radialGradient>
<clipPath id="lp-face"><circle cx="0" cy="210" r="56"/></clipPath>
<clipPath id="lp-round"><circle cx="500" cy="236" r="118"/></clipPath>
</defs>
<rect width="1000" height="560" fill="#DCD8D0"/><rect y="390" width="1000" height="170" fill="#CFCAC0"/>`;

const bootBtn = (label: string) => `<button type="button" class="as-b as-hot lp-boot" data-k="boot">${label}</button>`;

export function createSpinProduct(el: HTMLElement, h: ProductHandlers, opts: { servoPin: number }) {
  const q = mount(
    el,
    `<div class="tb-view sc-root lp-root">
<svg viewBox="0 0 1000 560" role="img" aria-label="${t('Product: Little Yellow on a servo turntable, with a round LCD for a face')}">
${floor}
<ellipse cx="500" cy="470" rx="230" ry="40" fill="url(#lp-floor)"/>
<ellipse cx="500" cy="462" rx="150" ry="30" fill="#2A2A28"/><rect x="350" y="436" width="300" height="26" fill="#2A2A28"/><ellipse cx="500" cy="436" rx="150" ry="30" fill="#3A3936"/>
<path data-k="dial" fill="none" stroke="#6E6A63" stroke-width="2"/>
<g data-k="body" transform="translate(500 30)">
<path d="M-2 92 C-12 72 0 54 18 58 C32 62 30 80 16 78" fill="none" stroke="#141414" stroke-width="5" stroke-linecap="round"/>
<rect x="-96" y="92" width="192" height="330" rx="92" fill="#FFC933"/><rect x="-96" y="330" width="192" height="18" fill="#2F2A57"/><rect x="-96" y="348" width="192" height="74" fill="#F2B31F"/>
<rect x="-96" y="92" width="192" height="330" rx="92" fill="none" stroke="#141414" stroke-width="3"/>
<g data-k="face"><circle cx="0" cy="210" r="62" fill="#141414"/><image data-k="lcd" x="-56" y="154" width="112" height="112" clip-path="url(#lp-face)"/>
<circle cx="0" cy="210" r="62" fill="none" stroke="#3A3936" stroke-width="3"/></g>
</g>
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">${t('Little Yellow · product · SG90 turntable + 1.28″ round LCD GC9A01')}</text>
<text data-k="note" x="24" y="56" fill="#C23A00" class="tb-mono" font-size="12" font-weight="700"></text>
<text data-k="angle" x="976" y="96" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700" text-anchor="end"></text>
</svg>
${bootBtn(t('Press BOOT: face front'))}
</div>`,
  );
  let dial = '';
  for (let d = -60; d <= 60; d += 20) {
    const r = (d * Math.PI) / 180;
    const x = 500 + 150 * Math.sin(r), y = 436 + 30 * Math.cos(r);
    dial += `M${x.toFixed(1)} ${(y - 5).toFixed(1)} L${x.toFixed(1)} ${(y + 5).toFixed(1)} `;
  }
  q('dial').setAttribute('d', dial);
  holdButton(q('boot'), () => h.boot(true), () => h.boot(false));
  let last: Uint8Array | null = null;
  return {
    update(f: LiveFrame, _room: number, fx: LcdEffects) {
      const a = servoAngle(f.pwm, opts.servoPin);
      const turn = (a === null ? 0 : a - 90) + (fx.hornOffset ?? 0);
      const r = (turn * Math.PI) / 180;
      q('body').setAttribute('transform', `translate(500 30) scale(${(0.72 + 0.28 * Math.cos(r)).toFixed(3)} 1)`);
      q('face').setAttribute('transform', `translate(${(44 * Math.sin(r)).toFixed(1)} 0)`);
      q('angle').textContent = a === null ? t('No servo output') : t('Turntable {deg}°', { deg: `${turn >= 0 ? '+' : ''}${turn.toFixed(0)}` });
      q('note').textContent = fx.hornOffset ? t('Horn off by {n}°: the firmware says “front”, but it is actually turned', { n: fx.hornOffset.toFixed(1) }) : '';
      if (f.lcd !== last) {
        last = f.lcd;
        if (f.lcd) q('lcd').setAttribute('href', lcdImage(f.lcd, f.lcdW, f.lcdH));
      }
    },
  };
}

export function createLensProduct(el: HTMLElement, h: ProductHandlers) {
  const q = mount(
    el,
    `<div class="tb-view sc-root lp-root">
<svg viewBox="0 0 1000 560" role="img" aria-label="${t('Product: a face on a round LCD magnified by a lens dome, like a little figure inside')}">
${floor}
<ellipse cx="500" cy="470" rx="230" ry="36" fill="url(#lp-floor)"/>
<rect x="350" y="388" width="300" height="70" rx="28" fill="#EDEAE2" stroke="#BDB9B0" stroke-width="2"/><rect x="390" y="376" width="220" height="24" rx="10" fill="#D6D1C6"/>
<circle cx="500" cy="236" r="150" fill="#1A1A19"/><circle cx="500" cy="236" r="120" fill="#06070A"/>
<g clip-path="url(#lp-round)"><image data-k="lcd" x="380" y="116" width="240" height="240"/></g>
<circle cx="500" cy="236" r="150" fill="url(#lp-dome)"/>
<path d="M395 172 A130 130 0 0 1 478 104" fill="none" stroke="#FFF" opacity="0.75" stroke-width="8" stroke-linecap="round"/>
<circle cx="500" cy="236" r="150" fill="none" stroke="#8A9BAD" stroke-width="2"/>
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">${t('Lens buddy · product · 1.28″ round LCD GC9A01 + lens dome')}</text>
<text data-k="note" x="24" y="56" fill="#C23A00" class="tb-mono" font-size="12" font-weight="700"></text>
<text data-k="mag" x="976" y="96" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700" text-anchor="end"></text>
</svg>
${bootBtn(t('Press BOOT: change face'))}
</div>`,
  );
  holdButton(q('boot'), () => h.boot(true), () => h.boot(false));
  let last: Uint8Array | null = null;
  return {
    update(f: LiveFrame, _room: number, fx: LcdEffects) {
      const k = fx.lensScale ?? 1.35;
      q('lcd').setAttribute('transform', `translate(500 236) scale(${k}) translate(-500 -236)`);
      q('mag').textContent = t('About {k}× magnification (estimate)', { k: k.toFixed(2) });
      q('note').textContent = k < 1.2 ? t('Lens sits on the screen: barely any magnification, it looks flat') : '';
      if (f.lcd !== last) {
        last = f.lcd;
        if (f.lcd) q('lcd').setAttribute('href', lcdImage(f.lcd, f.lcdW, f.lcdH));
      }
    },
  };
}
