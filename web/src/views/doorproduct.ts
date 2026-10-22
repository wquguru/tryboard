// G-03b RFID door lock: flat product (SVG) plus the door state parsed from the c3-door serial log.
// Screen pixels come from the simulator; strike / lockout state comes from serial lines (the relay GPIO isn't in the frame).
import { t } from '../i18n';
import { mount, oledImage, type LiveFrame } from './common';

/** Door state rebuilt from serial: RC522 version, strike open, refusals in a row, lockout seconds left, card on the reader */
export interface DoorState {
  ver: string;
  open: boolean;
  fails: number;
  left: number;
  card: string;
  last: '' | 'ok' | 'deny' | 'ignored';
}
export const doorIdle = (): DoorState => ({ ver: '', open: false, fails: 0, left: 0, card: '', last: '' });

/** Whitelisted card (DE:AD:BE:EF) and a stranger (7-byte UID), same as the bench card panel */
export const DOOR_CARDS = { ok: 'DEADBEEF', bad: '04A1B2C3D4E5F6' };

type DoorEvent = [icon: string, text: string, tone?: 'ok' | 'bad'];
/** One c3-door serial line -> new state + timeline event (null = not a door line or no event) */
export function parseDoorLine(l: string, s: DoorState): DoorEvent | null {
  let m: RegExpMatchArray | null;
  const uid = (/UID ([0-9A-F:]+)/.exec(l) ?? [])[1] ?? '';
  if ((m = /^RC522 版本 0x([0-9A-F]{2})/.exec(l))) { // lint: allow-cjk
    Object.assign(s, doorIdle(), { ver: m[1] });
    return ['◎', t('Card reader awake: RC522 version 0x{v}', { v: m[1] })];
  }
  if (/→ 欢迎/.test(l)) { // lint: allow-cjk
    Object.assign(s, { open: true, fails: 0, card: uid, last: 'ok' });
    return ['✓', t('Whitelisted card {uid}: door unlocked', { uid }), 'ok'];
  }
  if ((m = /→ 拒绝（连续第 (\d+) 次）/.exec(l))) { // lint: allow-cjk
    Object.assign(s, { fails: Number(m[1]), card: uid, last: 'deny' });
    return ['✗', t('Unknown card {uid} refused ({n}/3)', { uid, n: m[1] }), 'bad'];
  }
  if (/→ 锁定中/.test(l)) { // lint: allow-cjk
    Object.assign(s, { card: uid, last: 'ignored' });
    return ['!', t('Card ignored: the reader is locked out'), 'bad'];
  }
  if ((m = /^连续 \d+ 次拒绝，锁定 (\d+) 秒/.exec(l))) { // lint: allow-cjk
    s.left = Number(m[1]);
    return ['!', t('Three refusals in a row: reader locked for {n} s', { n: m[1] }), 'bad'];
  }
  if ((m = /^锁定倒计时 (\d+) 秒/.exec(l))) s.left = Number(m[1]); // lint: allow-cjk
  else if (/^解除锁定/.test(l)) { // lint: allow-cjk
    Object.assign(s, { left: 0, fails: 0 });
    return ['○', t('Lockout over, the reader accepts cards again'), 'ok'];
  } else if ((m = /^已上锁，开锁 ([\d.]+) 秒/.exec(l))) { // lint: allow-cjk
    s.open = false;
    return ['○', t('Door locked again (held open {s} s)', { s: m[1] })];
  } else if (/^卡已移开/.test(l)) s.card = ''; // lint: allow-cjk
  return null;
}

/** The product page's door state (one product page at a time); reset on every power-up */
export const doorNow: DoorState = doorIdle();

export function createDoorProduct(el: HTMLElement, get: () => DoorState = () => doorNow) {
  const q = mount(
    el,
    `<div class="tb-view sc-root lp-root"><svg viewBox="0 0 1000 560" role="img" aria-label="${t('Product: RFID door lock panel next to a door, with a card reader pad, an OLED and a door strike')}">
<rect width="1000" height="560" fill="#DCD8D0"/><rect y="470" width="1000" height="90" fill="#CFCAC0"/>
<rect x="560" y="60" width="300" height="410" fill="#B89B74"/><rect x="580" y="80" width="260" height="170" fill="#C4A880"/><rect x="580" y="270" width="260" height="180" fill="#C4A880"/>
<rect x="552" y="52" width="8" height="418" fill="#8A867E"/><circle cx="610" cy="280" r="10" fill="#6E6A63"/>
<rect x="530" y="230" width="30" height="100" rx="3" fill="#3A3936"/><rect data-k="bolt" x="548" y="268" width="26" height="24" rx="2" fill="#A8ACB2"/>
<rect x="250" y="110" width="220" height="320" rx="18" fill="#2A2C31"/><rect x="250" y="110" width="220" height="24" rx="12" fill="#3A3D44"/>
<rect x="276" y="150" width="168" height="90" rx="4" fill="#0E0F12"/><image data-k="oled" x="282" y="156" width="156" height="78" preserveAspectRatio="none"/>
<text data-k="ph" x="360" y="204" fill="#D7F3FF" class="tb-mono" font-size="22" font-weight="700" text-anchor="middle">LOCKED</text>
<rect x="290" y="270" width="140" height="110" rx="10" fill="#1E2024" stroke="#4A4D55" stroke-width="2"/>
<path d="M340 310 a24 24 0 0 1 0 30 M352 302 a36 36 0 0 1 0 46 M364 294 a48 48 0 0 1 0 62" fill="none" stroke="#5B8DEF" stroke-width="4" stroke-linecap="round"/>
<circle data-k="led" cx="430" cy="404" r="8" fill="#3A1A1A"/><circle cx="290" cy="404" r="8" fill="#141414"/>
<g data-k="card" display="none"><rect x="300" y="250" width="150" height="96" rx="10" fill="#F7F6F3" stroke="#8A867E" stroke-width="2" transform="rotate(-8 375 298)"/>
<text data-k="cardt" x="375" y="304" fill="#3A3936" class="tb-mono" font-size="14" font-weight="700" text-anchor="middle" transform="rotate(-8 375 298)"></text></g>
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">${t('RFID door lock · product · RC522 + SH1106 + relay + door strike')}</text>
<text data-k="state" x="24" y="58" fill="#3A3936" class="tb-mono" font-size="14" font-weight="700"></text>
</svg></div>`,
  );
  let last: Uint8Array | null = null;
  return {
    update(f: LiveFrame) {
      if (f.oled && f.oled !== last) {
        last = f.oled;
        q('oled').setAttribute('href', oledImage(f.oled));
        q('ph').setAttribute('display', 'none');
      }
      const s = get();
      q('bolt').setAttribute('x', s.open ? '532' : '548');
      q('led').setAttribute('fill', s.last === 'deny' || s.left ? '#E5484D' : '#3A1A1A');
      q('card').setAttribute('display', s.card ? '' : 'none');
      q('cardt').textContent = s.card;
      q('cardt').setAttribute('font-size', s.card.length > 12 ? '10' : '14');
      const st = q('state');
      st.textContent = s.left ? t('Locked out · {n} s left', { n: s.left }) : s.open ? t('Strike open (relay on)') : t('Locked (relay off)');
      st.setAttribute('fill', s.left ? '#C23A00' : s.open ? '#1F7A3A' : '#3A3936');
    },
  };
}
