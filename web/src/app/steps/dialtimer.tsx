// G-16b Dial timer in the Product step: phone keys (start / +1 / -1 / cancel), desktop buttons, readings rows, serial -> timeline.
// Kept outside productStep (tools/lint_size.py). Inputs use the bench's paths (gpio42=, enc=, touch=), so they land in the input log.
import type { ReactNode } from 'react';
import type { Tool } from '../toolbar';
import type { Session } from '../types';
import { DIAL_BTN, dialRing, dialtimerNow, mmss, modeText, parseDialtimerLine } from '../../views/dialtimerproduct';
import type { LiveFrame } from '../../views/common';
import { createDial3D, type Dial3D } from '../dial3d';
import { t } from '../../i18n';

(globalThis as unknown as { __tbDialtimer: unknown }).__tbDialtimer = dialtimerNow;

/** Press the Dial (BtnA): down, then up 100 ms later so M5.update() sees both edges */
export function dialPress(s: Session) {
  s.sim?.pressBoardPin(DIAL_BTN, true);
  setTimeout(() => s.sim?.pressBoardPin(DIAL_BTN, false), 100);
}
export function dialTurn(s: Session, n: number) {
  s.turnEncoder(n);
  dialRing.view?.turned(n);
}
/** A short tap in the middle of the screen (the firmware cancels on any touch while running or paused) */
export function dialTap(s: Session) {
  s.touch(120, 120, true);
  setTimeout(() => s.touch(120, 120, false), 150);
}

export const dialtimerActs = (): Tool[] => [
  { id: 'p-dial-start', label: t('Start / pause'), icon: 'play' },
  { id: 'p-dial-plus', label: t('+1 min'), icon: 'plus' },
  { id: 'p-dial-minus', label: t('−1 min'), icon: 'minus' },
  { id: 'p-dial-cancel', label: t('Cancel'), icon: 'x' },
];

/** Toolbar / button action; ids p-dial-start | p-dial-plus | p-dial-minus | p-dial-cancel */
export function dialtimerTool(id: string, s: Session) {
  if (id === 'p-dial-start') dialPress(s);
  else if (id === 'p-dial-plus') dialTurn(s, 1);
  else if (id === 'p-dial-minus') dialTurn(s, -1);
  else if (id === 'p-dial-cancel') dialTap(s);
}

/** Desktop buttons, same verbs as the phone keys */
export function dialtimerButtons(b: (id: string, label: string, f: () => void) => ReactNode, s: Session) {
  return dialtimerActs().map((a) => b(`pDial-${a.id.slice(7)}`, a.id === 'p-dial-cancel' ? t('Cancel (tap screen)') : a.label, () => dialtimerTool(a.id, s)));
}

export const dialtimerRows = (row: (k: string, live: string) => ReactNode) => [row(t('Timer'), 'dmode'), row(t('Set time'), 'dset'), row(t('Buzzer (G3)'), 'dbuzz')];

export function dialtimerLive(set: (k: string, v: string, bad?: boolean) => void, waiting: string) {
  const s = dialtimerNow;
  set('dmode', s.ready ? `${modeText(s)} · ${mmss(s.left)}` : waiting);
  set('dset', s.ready ? t('{n} min', { n: s.minutes }) : waiting);
  set('dbuzz', s.mode === 'ring' ? t('Beeping · {n}/3 at 2 kHz', { n: s.beeps }) : s.starts ? t('Quiet · beeps 3 times at zero') : t('Quiet'));
}

/** Serial line -> timer state + timeline event */
export function dialtimerSerial(l: string, event: (icon: string, text: string, tone?: 'ok' | 'bad') => void) {
  const e = parseDialtimerLine(l, dialtimerNow);
  if (e) event(...e);
}

/** 2D view handlers (no WebGL): same inputs as the 3D Dial */
export const dialHandlers = (s: Session) => ({ boardBtn: (pin: number, d: boolean) => s.sim?.pressBoardPin(pin, d), enc: (n: number) => s.turnEncoder(n), touch: (x: number, y: number, d: boolean) => s.touch(x, y, d) });

/** Mount the 3D Dial in the Product stage; window.__tbProduct gives tests the ring / screen page positions */
export function dialProduct3D(node: HTMLElement, s: Session, frame: () => LiveFrame): Dial3D {
  const d = createDial3D(node, { frame, enc: (n) => s.turnEncoder(n), btn: (down) => s.sim?.pressBoardPin(DIAL_BTN, down), touch: (x, y, down) => s.touch(x, y, down), sounding: () => s.audio.state.sounding });
  dialRing.view = d;
  (window as unknown as { __tbProduct: unknown }).__tbProduct = { ringPos: () => d.ringPos(), screenPos: () => d.screenPos(), azimuth: () => d.azimuth(), detents: () => d.detents(), timer: () => ({ ...dialtimerNow }) };
  return d;
}
