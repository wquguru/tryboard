// Display names and on-board pins of the three simulated chips; pure data without three.js so node --test modules can use it.
// Boards match board3d.ts BOARDS: ESP32-DevKitC V4, ESP32-C3-DevKitM-1, ESP32-S3-DevKitC-1 v1.0.
import { t } from './i18n/index.ts';

import type { SimChip } from './chipid.ts';

export { BOOT_GPIO, CHIP_ID, NPINS, RGB_GPIO, ROM_FILE, chipFromId, type SimChip } from './chipid.ts';

export const CHIP_LABEL: Record<SimChip, string> = { esp32: 'ESP32', esp32c3: 'ESP32-C3', esp32s3: 'ESP32-S3' };
export const CHIP_SHORT: Record<SimChip, string> = { esp32: 'ESP32', esp32c3: 'C3', esp32s3: 'S3' };
export const BOARD_NAME: Record<SimChip, string> = { esp32: 'ESP32-DevKitC V4', esp32c3: 'ESP32-C3-DevKitM-1', esp32s3: 'ESP32-S3-DevKitC-1' };
/** The electrical solver models the S3 board's GPIO drive separately from the others. */
export const isS3 = (c: string) => c === 'esp32s3';
export const CHIP_DESC: Record<SimChip, string> = { esp32: t('ESP32 · dual-core 160 MHz'), esp32c3: 'ESP32-C3 · 160 MHz', esp32s3: t('ESP32-S3 · dual-core 160 MHz') };
