// Devices soldered onto an all-in-one board (E-03). No three.js here: session.ts imports it on the main path.
import type { Battery, LcdKind } from '../simmsg';

export type BoardId = 'ws-amoled216';

export interface BoardDevs {
  /** Product name (proper noun, not translated) */
  name: string;
  lcd: LcdKind;
  i2c: { kind: string; addr: number }[];
  touchInt: number;
  /** AXP2101 state at power-up (the panel slider changes it afterwards) */
  battery: Battery;
}

/** Same set and order as the s3-amoled-i2c case in firmware/accept.json (= CLI flags) */
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
};

export const boardDevs = (id: string | undefined): BoardDevs | undefined => (id && id in BOARD_DEVS ? BOARD_DEVS[id as BoardId] : undefined);
