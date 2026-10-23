// G-17b AMOLED desk clock: flat product (SVG) = the Waveshare 2.16" board on a desk stand, its 480×480 screen from the frame.
// Tapping / dragging the screen is the finger (touch=), the side PWR key is pwrkey=; page / time / battery come from amoclock serial.
import { t } from '../i18n';
import { lcdImage, mount, type LiveFrame } from './common';
import { BG } from './workproducts';

/** Clock state rebuilt from serial: page 1–3, screen lit, HH:MM shown, battery line, chip temperature, BLE link, last sync */
export interface AmoclockState {
  page: number;
  on: boolean;
  time: string;
  date: string;
  bat: string;
  temp: string;
  ble: '' | 'adv' | 'conn';
  sync: string;
}
export const amoclockIdle = (): AmoclockState => ({ page: 1, on: true, time: '', date: '', bat: '', temp: '', ble: '', sync: '' });
/** The product page's / home card's clock state (one at a time); reset on the first-frame line (it precedes the RTC / battery lines) */
export const amoclockNow: AmoclockState = amoclockIdle();

/** Screen size of the CO5300 panel (touch coordinates use the same pixels) */
export const AMO_PX = 480;
/** Swipe path the levels use (amoclock-2): five touches 70 px apart along y = 240, then release */
export const swipePath = (dir: 'left' | 'right') => [400, 330, 260, 190, 120].map((x) => (dir === 'left' ? x : AMO_PX - x));

type ClockEvent = [icon: string, text: string, tone?: 'ok' | 'bad'];
const PAGE = () => [t('Time'), t('Temperature'), t('Battery')];
/** One amoclock serial line -> new state + timeline event (null = no event) */
export function parseAmoclockLine(l: string, s: AmoclockState): ClockEvent | null {
  let m: RegExpMatchArray | null;
  if (l.startsWith('首屏 已显示')) Object.assign(s, amoclockIdle()); // lint: allow-cjk
  else if ((m = /^表盘 显示 (\S+)\s+\S+ (\d\d:\d\d):\d\d/.exec(l))) Object.assign(s, { date: m[1], time: m[2] }); // lint: allow-cjk
  else if ((m = /^整分 (\d\d:\d\d)/.exec(l))) s.time = m[1]; // lint: allow-cjk
  else if ((m = /^滑动 \S+ dx=-?\d+ → 页 (\d)\/3/.exec(l))) { // lint: allow-cjk
    s.page = Number(m[1]);
    return ['↔', t('Swiped to page {n}/3 · {name}', { n: s.page, name: PAGE()[s.page - 1] })];
  } else if (l.startsWith('滑动 ')) return ['↔', t('Already at the end: no more pages that way')]; // lint: allow-cjk
  else if (l.startsWith('息屏中 忽略滑动')) return ['!', t('Screen is off: swipe ignored (press PWR first)'), 'bad']; // lint: allow-cjk
  else if ((m = /^电源键 短按 → (\S+)（/.exec(l))) { // lint: allow-cjk
    s.on = m[1] === '亮屏'; // lint: allow-cjk
    return ['○', s.on ? t('PWR: screen on') : t('PWR: screen off (brightness 0x51 = 0)'), s.on ? 'ok' : undefined];
  } else if ((m = /^电量 (\d+)% USB (\S+) (\S+) VBAT (\d+) mV/.exec(l))) // lint: allow-cjk
    s.bat = `${m[1]} % · ${m[2] === '已插' ? t('USB in') : t('USB out')} · ${m[4]} mV`; // lint: allow-cjk
  else if ((m = /^温度 芯片 (-?[\d.]+)/.exec(l))) s.temp = `${m[1]} ℃`; // lint: allow-cjk
  else if (l.startsWith('BLE 广播')) s.ble = 'adv'; // lint: allow-cjk
  else if (l.startsWith('连接 成功')) { // lint: allow-cjk
    s.ble = 'conn';
    return ['≈', t('Phone connected over BLE'), 'ok'];
  } else if (l.startsWith('断开')) s.ble = 'adv'; // lint: allow-cjk
  else if ((m = /^RTC 已写入 (\S+ \d\d:\d\d:\d\d)/.exec(l))) { // lint: allow-cjk
    s.sync = m[1];
    return ['⏱', t('Time set from the phone: {time}', { time: m[1] }), 'ok'];
  } else if (l.startsWith('对时 长度错误')) return ['!', t('Phone wrote the wrong length (needs 4 bytes)'), 'bad']; // lint: allow-cjk
  return null;
}

/** Phone's wall clock as the 4 little-endian bytes FF11 takes: local time as epoch seconds (the firmware has no time zone) */
export function syncBytes(now = new Date()) {
  const e = Math.floor(now.getTime() / 1000) - now.getTimezoneOffset() * 60;
  return [0, 8, 16, 24].map((s) => ((e >>> s) & 0xff).toString(16).padStart(2, '0')).join('');
}

export interface AmoclockHandlers {
  touch?(x: number, y: number, down: boolean): void;
  pwrkey?(long: boolean): void;
  sync?(): void;
}

const X0 = 330;
const Y0 = 70;
const S = 340;

export function createAmoclockProduct(el: HTMLElement, h: AmoclockHandlers = {}, get: () => AmoclockState = () => amoclockNow) {
  const q = mount(
    el,
    `<div class="tb-view sc-root"><svg viewBox="0 0 1000 560" role="img" aria-label="${t('Product: a 2.16-inch AMOLED clock board on a desk stand, the phone next to it sets the time over Bluetooth')}">
${BG}
<ellipse cx="500" cy="486" rx="250" ry="30" fill="url(#wp-floor)"/>
<path d="M410 470 L440 404 L560 404 L590 470 Z" fill="#3A3936"/>
<rect x="${X0 - 22}" y="${Y0 - 22}" width="${S + 44}" height="${S + 60}" rx="26" fill="#1B1D21"/>
<rect x="${X0 - 8}" y="${Y0 - 8}" width="${S + 16}" height="${S + 16}" rx="14" fill="#050506"/>
<image data-k="lcd" x="${X0}" y="${Y0}" width="${S}" height="${S}" preserveAspectRatio="none" style="cursor:${h.touch ? 'crosshair' : 'default'};touch-action:none"/>
<rect data-k="off" x="${X0}" y="${Y0}" width="${S}" height="${S}" fill="#000" opacity="0" pointer-events="none"/>
<g data-k="pwr" role="button" tabindex="0" aria-label="PWR" style="cursor:${h.pwrkey ? 'pointer' : 'default'}"><rect x="${X0 + S + 22}" y="${Y0 + 90}" width="14" height="54" rx="5" fill="#C23A3A"/>
<text x="${X0 + S + 46}" y="${Y0 + 122}" fill="#3A3936" class="tb-mono" font-size="12" font-weight="700">PWR</text></g>
<g data-k="phone" role="button" tabindex="0" aria-label="${t('Set time from phone')}" style="cursor:${h.sync ? 'pointer' : 'default'}">
<rect x="800" y="260" width="120" height="220" rx="18" fill="#2E3036"/><rect x="810" y="282" width="100" height="170" rx="6" fill="#16181C"/>
<text x="860" y="352" fill="#9AD0FF" class="tb-mono" font-size="20" font-weight="700" text-anchor="middle">BLE</text>
<text data-k="ptx" x="860" y="384" fill="#F2F2F2" class="tb-mono" font-size="12" font-weight="700" text-anchor="middle"></text></g>
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">${t('AMOLED desk clock · product · CO5300 480×480 + CST9220 touch + AXP2101 + PCF85063')}</text>
<text data-k="state" x="24" y="58" fill="#3A3936" class="tb-mono" font-size="14" font-weight="700"></text>
<text data-k="bat" x="24" y="80" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700"></text>
<text data-k="sync" x="24" y="102" fill="#1F7A3A" class="tb-mono" font-size="12" font-weight="700"></text>
</svg></div>`,
  );
  const lcd = q<SVGImageElement>('lcd');
  if (h.touch) {
    // Page position -> panel pixel; while the finger is down every move is a touch= action, lifting is release
    const px = (e: PointerEvent): [number, number] => {
      const r = lcd.getBoundingClientRect();
      const k = (v: number) => Math.max(0, Math.min(AMO_PX - 1, Math.round(v * AMO_PX)));
      return [k((e.clientX - r.left) / r.width), k((e.clientY - r.top) / r.height)];
    };
    let down = false;
    lcd.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      lcd.setPointerCapture?.(e.pointerId);
      down = true;
      h.touch!(...px(e), true);
    });
    lcd.addEventListener('pointermove', (e) => down && h.touch!(...px(e), true));
    const up = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      h.touch!(...px(e), false);
    };
    lcd.addEventListener('pointerup', up);
    lcd.addEventListener('pointercancel', up);
  }
  q('pwr').addEventListener('click', () => h.pwrkey?.(false));
  q('phone').addEventListener('click', () => h.sync?.());
  let last: Uint8Array | null = null;
  return {
    update(f: LiveFrame) {
      if (f.lcd && f.lcd !== last) {
        last = f.lcd;
        lcd.setAttribute('href', lcdImage(f.lcd, f.lcdW ?? AMO_PX, f.lcdH ?? AMO_PX));
      }
      const s = get();
      q('off').setAttribute('opacity', s.on ? '0' : '1');
      q('state').textContent = !s.time ? '' : s.on ? t('{time} · page {n}/3 · {name}', { time: s.time, n: s.page, name: PAGE()[s.page - 1] }) : t('{time} · screen off', { time: s.time });
      q('bat').textContent = s.bat ? t('Battery {bat}', { bat: s.bat }) : '';
      q('sync').textContent = s.sync ? t('Last set from the phone: {time}', { time: s.sync }) : '';
      q('ptx').textContent = s.ble === 'conn' ? t('Connected') : s.ble === 'adv' ? t('Set time') : '';
    },
  };
}
