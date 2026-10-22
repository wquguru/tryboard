// G-04b IR remote night light: flat product (SVG) = the knob lamp's shade + strip, a 21-key NEC remote, state parsed from s3-irlamp serial.
// Strip colours come from the simulator frame; on / colour / level / current estimate come from serial lines.
import { t } from '../i18n';
import { IR_KEYS, irCode } from '../app/irfeed';
import { holdButton, mount, type LiveFrame } from './common';
import { BG, css, tint, type WorkEffects } from './workproducts';

/** Light state rebuilt from serial: on, colour 1–9, level 1–8, strip current estimate (mA), last remote code */
export interface IrlampState {
  on: boolean;
  color: number;
  level: number;
  mA: number;
  code: string;
  keys: number;
}
export const irlampIdle = (): IrlampState => ({ on: false, color: 0, level: 0, mA: 0, code: '', keys: 0 });

/** NEC commands the firmware acts on (address 0x00): CH- toggles power, VOL+ / VOL- step brightness, digits 1–9 pick a colour */
export const IRLAMP_CMD = { power: 0x45, up: 0x15, down: 0x07, digits: [0x0c, 0x18, 0x5e, 0x08, 0x1c, 0x5a, 0x42, 0x52, 0x4a] };
/** Firmware COLORS[] as CSS, for swatches next to the colour number */
export const IRLAMP_RGB = ['#FF2020', '#20FF40', '#2040FF', '#FFC000', '#00E0FF', '#C040FF', '#FF60A0', '#FF9933', '#FFFFFF'];
/** Real-time gap between repeat codes while a key is held (NEC repeats every 108 ms) */
export const REPEAT_MS = 110;

type LampEvent = [icon: string, text: string, tone?: 'ok' | 'bad'];
/** One s3-irlamp serial line -> new state + timeline event (null = no event) */
export function parseIrlampLine(l: string, s: IrlampState): LampEvent | null {
  let m: RegExpMatchArray | null;
  if (l.startsWith('红外小夜灯 接收')) Object.assign(s, irlampIdle()); // lint: allow-cjk
  else if ((m = /^开灯 颜色 (\d) \S+ 亮度 (\d)\/8/.exec(l))) Object.assign(s, { on: true, color: Number(m[1]), level: Number(m[2]) }); // lint: allow-cjk
  else if (l === '开灯' || l === '关灯') { // lint: allow-cjk
    s.on = l === '开灯'; // lint: allow-cjk
    return ['○', s.on ? t('Remote: light on') : t('Remote: light off'), s.on ? 'ok' : undefined];
  } else if (l.startsWith('关灯中 忽略')) return ['!', t('Light is off: key ignored (press power first)'), 'bad']; // lint: allow-cjk
  else if ((m = /^亮度 (\d)\/8/.exec(l))) { // lint: allow-cjk
    s.level = Number(m[1]);
    return ['☀', t('Brightness {level}/8', { level: m[1] })];
  } else if ((m = /^颜色 (\d)/.exec(l))) { // lint: allow-cjk
    s.color = Number(m[1]);
    return ['●', t('Colour {n} picked', { n: m[1] }), 'ok'];
  } else if ((m = /^收到 地址=(\w+) 命令=(\w+)( 不是本灯遥控器)?/.exec(l))) { // lint: allow-cjk
    s.code = `${m[1]},${m[2]}`;
    s.keys++;
    if (m[3]) return ['!', t('Code from another remote (address {a}) ignored', { a: m[1] }), 'bad'];
  } else if (l.startsWith('收到 重复码')) { // lint: allow-cjk
    s.code = 'repeat';
    s.keys++;
  } else if ((m = /^电流估算 (\d+) mA/.exec(l))) s.mA = Number(m[1]); // lint: allow-cjk
  return null;
}

/** The product page's / home card's light state (one at a time); reset on every power-up banner */
export const irlampNow: IrlampState = irlampIdle();

/** Send a key, then repeat codes while it stays down (VOL+ / VOL- keep ramping); returns release */
export function holdKey(send: (code: string) => void, cmd: number): () => void {
  send(irCode(cmd));
  let iv = 0;
  const to = window.setTimeout(() => (iv = window.setInterval(() => send('repeat'), REPEAT_MS)), REPEAT_MS);
  return () => {
    clearTimeout(to);
    clearInterval(iv);
  };
}

const LABEL: Record<number, string> = { [IRLAMP_CMD.power]: 'PWR' };

export function createIrlampProduct(el: HTMLElement, opts: { pin?: number; send?: (code: string) => void; get?: () => IrlampState } = {}) {
  const pin = opts.pin ?? 5;
  const get = opts.get ?? (() => irlampNow);
  const leds = Array.from({ length: 8 }, (_, i) => `<circle data-k="led${i}" cx="${430 + i * 20}" cy="300" r="7" fill="#2A2A28"/>`).join('');
  const keys = IR_KEYS.map(([label, cmd], i) => {
    const x = 660 + (i % 3) * 68;
    const y = 96 + Math.floor(i / 3) * 58;
    const pw = cmd === IRLAMP_CMD.power;
    const fill = pw ? '#C23A3A' : IRLAMP_CMD.digits.includes(cmd) || cmd === IRLAMP_CMD.up || cmd === IRLAMP_CMD.down ? '#3A3D44' : '#2E3036';
    return `<g data-ir="${irCode(cmd)}" data-cmd="${cmd}" role="button" tabindex="0" aria-label="${label}" style="cursor:${opts.send ? 'pointer' : 'default'}">
<rect data-key="${cmd}" x="${x}" y="${y}" width="56" height="44" rx="12" fill="${fill}"/><text x="${x + 28}" y="${y + 28}" fill="#F2F2F2" class="tb-mono" font-size="${label.length > 3 ? 12 : 16}" font-weight="700" text-anchor="middle" pointer-events="none">${LABEL[cmd] ?? label}</text></g>`;
  }).join('');
  const q = mount(
    el,
    `<div class="tb-view sc-root lp-root"><svg viewBox="0 0 1000 560" role="img" aria-label="${t('Product: night light with 8 WS2812 LEDs under a milky shade, an IR receiver on its base and a 21-key remote')}">
${BG}
<g transform="translate(-160 0)">
<ellipse cx="500" cy="472" rx="220" ry="34" fill="url(#wp-floor)"/>
<ellipse data-k="halo" cx="500" cy="250" rx="230" ry="190" fill="url(#wp-glow)" opacity="0"/>
<rect x="380" y="380" width="240" height="84" rx="16" fill="#3A3936"/><rect x="380" y="380" width="240" height="18" rx="8" fill="#4A4946"/>
<rect x="566" y="414" width="30" height="26" rx="5" fill="#1B1D21"/><circle data-k="eye" cx="581" cy="427" r="8" fill="#2A2C31"/>
<rect x="490" y="232" width="20" height="150" fill="#E8E5DE"/>${leds}
<path data-k="shade" d="M410 380 C390 300 400 170 500 150 C600 170 610 300 590 380 Z" fill="#F4F1EA" fill-opacity="0.82" stroke="#BDB9B0" stroke-width="2"/>
<g data-k="spots" opacity="0">${Array.from({ length: 8 }, (_, i) => `<circle data-k="spot${i}" cx="${424 + i * 22}" cy="300" r="9" fill="#FFF"/>`).join('')}</g>
</g>
<path data-k="beam" d="M738 60 Q 600 250 430 420" fill="none" stroke="#E5484D" stroke-width="3" stroke-dasharray="8 8" opacity="0"/>
<rect x="640" y="40" width="244" height="490" rx="28" fill="#1E2024"/><circle cx="762" cy="66" r="6" fill="#3A1A1A" data-k="tx"/>
${keys}
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">${t('IR night light · product · VS1838B + WS2812 × 8 + NEC remote')}</text>
<text data-k="state" x="24" y="58" fill="#3A3936" class="tb-mono" font-size="14" font-weight="700"></text>
<text data-k="code" x="24" y="80" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700"></text>
<text data-k="note" x="24" y="102" fill="#C23A00" class="tb-mono" font-size="12" font-weight="700"></text>
</svg></div>`,
  );
  const root = el.querySelector('svg')!;
  let flashT = 0;
  const flash = () => {
    q('beam').setAttribute('opacity', '0.8');
    q('tx').setAttribute('fill', '#E5484D');
    clearTimeout(flashT);
    flashT = window.setTimeout(() => {
      q('beam').setAttribute('opacity', '0');
      q('tx').setAttribute('fill', '#3A1A1A');
    }, 160);
  };
  const send = (code: string) => {
    flash();
    opts.send?.(code);
  };
  if (opts.send)
    root.querySelectorAll<SVGGElement>('[data-ir]').forEach((g) => {
      let release = () => {};
      holdButton(g, () => (release = holdKey(send, Number(g.dataset.cmd))), () => release());
    });
  return {
    /** Key flash for presses that don't come from this picture (phone keys, desktop buttons) */
    flash,
    update(f: LiveFrame, _room?: number, fx: WorkEffects = {}) {
      const strip = f.strips?.[pin] ?? [];
      let peak = 0;
      strip.forEach((c, i) => {
        q(`led${i}`)?.setAttribute('fill', css(c));
        q(`spot${i}`)?.setAttribute('fill', css(c, 0.4));
        peak = Math.max(peak, ...c);
      });
      const avg = strip.length ? [0, 1, 2].map((k) => strip.reduce((s, c) => s + c[k], 0) / strip.length) : null;
      q('shade').setAttribute('fill', avg && peak ? tint(avg, 0.25 + 0.4 * Math.min(1, peak / 128)) : '#F4F1EA');
      q('halo').setAttribute('opacity', String(Math.min(0.9, peak / 140)));
      q('spots').setAttribute('opacity', fx.glare && peak ? '1' : '0');
      const s = get();
      q('state').textContent = !s.color ? '' : s.on ? t('On · colour {n} · brightness {level}/8 · about {mA} mA (estimate)', { n: s.color, level: s.level, mA: s.mA }) : t('Off · about {mA} mA (estimate)', { mA: s.mA });
      q('code').textContent = s.code ? t('Last remote code: {code}', { code: s.code === 'repeat' ? t('repeat (key held)') : s.code }) : '';
      q('note').textContent = fx.glare ? t('Strip touches the shade: a row of harsh hot spots (estimate)') : '';
    },
  };
}
