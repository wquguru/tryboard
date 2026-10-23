// Devices of an all-in-one board (E-03) or of a core board preset (M5-09b). No three.js here: session.ts imports it on the main path.
import type { Battery, LcdKind } from '../simmsg';

/** Boards run through a core preset (= CLI --board <id>, see core/crates/machine/src/boards.rs): the M5Stack line plus the CYD (G-10) */
export type M5Id = 'm5dial' | 'm5atoms3' | 'm5atoms3lite' | 'm5atoms3r' | 'm5cores3' | 'm5cores3se' | 'm5cardputer' | 'm5cardputeradv' | 'm5stickcplus2' | 'm5core2' | 'm5core2v11' | 'm5atomlite' | 'cyd';
export type BoardId = 'ws-amoled216' | M5Id;

export interface BoardDevs {
  /** Product name (proper noun, not translated) */
  name: string;
  /** Core board preset id (= CLI --board): the core attaches the on-board devices, so the device fields stay empty */
  preset?: M5Id;
  /** The preset wires a Cardputer keyboard: lab key presses go to tb_board_key */
  keyboard?: boolean;
  /** Preset without a Grove Port A (boards.rs grove_a = None): no Grove picker, --grove would be rejected */
  noGrove?: boolean;
  lcd?: LcdKind;
  i2c: { kind: string; addr: number }[];
  touchInt?: number;
  /** AXP2101 state at power-up (the panel slider changes it afterwards) */
  battery?: Battery;
  /** Preset items boards.rs notes as inferred / assumed (G-08): conclusions that use them need a real board, even when verified */
  check?: string[];
  /** boards.rs verified: false: pins and addresses come from docs, no firmware has run the preset yet */
  unverified?: true;
}

const m5 = (preset: M5Id, name: string, keyboard?: boolean): BoardDevs => ({ name, preset, i2c: [], ...(keyboard ? { keyboard } : {}) });

/** ws-amoled216: same set and order as the s3-amoled-i2c case in firmware/accept.json (= CLI flags) */
export const BOARD_DEVS: Record<BoardId, BoardDevs> = {
  'ws-amoled216': {
    name: 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
    lcd: 'co5300',
    i2c: [
      { kind: 'cst9220', addr: 0x5a },
      { kind: 'axp2101', addr: 0x34 },
      { kind: 'pcf85063', addr: 0x51 },
      { kind: 'es8311', addr: 0x18 },
      { kind: 'es7210', addr: 0x40 },
    ],
    touchInt: 11,
    battery: { pct: 98, usb: true },
  },
  m5dial: { ...m5('m5dial', 'M5Stack Dial'), check: ['Dial ring direction (encoder A/B order is inferred)'] },
  m5atoms3: m5('m5atoms3', 'M5Stack AtomS3'),
  m5atoms3lite: { ...m5('m5atoms3lite', 'M5Stack AtomS3 Lite'), check: ['Board detection level on G4 (from the M5Unified heuristic, not the schematic)'] },
  m5atoms3r: m5('m5atoms3r', 'M5Stack AtomS3R'),
  m5cores3: { ...m5('m5cores3', 'M5Stack CoreS3'), unverified: true },
  m5cores3se: { ...m5('m5cores3se', 'M5Stack CoreS3 SE'), unverified: true },
  m5cardputer: { ...m5('m5cardputer', 'M5Stack Cardputer', true), check: ['Key legend map (from the M5Cardputer scan convention, unchecked)'] },
  m5cardputeradv: { ...m5('m5cardputeradv', 'M5Stack Cardputer-Adv', true), check: ['IMU address (BMI270 assumed at 0x68)', 'Key map (TCA8418 map assumed)'] },
  m5stickcplus2: m5('m5stickcplus2', 'M5StickC Plus2'),
  m5core2: m5('m5core2', 'M5Stack Core2'),
  m5core2v11: m5('m5core2v11', 'M5Stack Core2 v1.1'),
  m5atomlite: m5('m5atomlite', 'M5Stack Atom Lite'),
  cyd: { ...m5('cyd', 'Cheap Yellow Display ESP32-2432S028'), noGrove: true, check: ['Touch coordinates (XPT2046 raw span is estimated)'] },
};

export const boardDevs = (id: string | undefined): BoardDevs | undefined => (id && id in BOARD_DEVS ? BOARD_DEVS[id as BoardId] : undefined);
/** Board with the AXP2101 panel (E-03); M5 preset boards get their enclosure from m5shell.ts (M5-09c) */
export const modelBoard = (id: string | undefined) => {
  const b = boardDevs(id);
  return b && !b.preset ? b : undefined;
};
/** M5 preset boards in menu order */
export const PRESET_BOARDS = (Object.keys(BOARD_DEVS) as BoardId[]).filter((id) => BOARD_DEVS[id].preset);

/** Lab KeyboardEvent.code -> Cardputer key name (script-safe aliases of core keyboard.rs); null = not on the keyboard */
export function cardputerKey(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
  if (m) return (m[1] ?? m[2]).toLowerCase();
  const map: Record<string, string> = {
    Backquote: 'grave', Minus: 'minus', Equal: 'equal', BracketLeft: 'lbracket', BracketRight: 'rbracket', Backslash: 'backslash',
    Semicolon: 'semicolon', Quote: 'quote', Comma: 'comma', Period: 'period', Slash: 'slash', Backspace: 'bksp', Tab: 'tab',
    Enter: 'enter', Space: 'space', ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'ctrl', ControlRight: 'ctrl',
    AltLeft: 'alt', AltRight: 'alt', MetaLeft: 'opt', MetaRight: 'opt',
  };
  return map[code] ?? null;
}
