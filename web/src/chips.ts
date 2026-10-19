// Display names and on-board pins of the three simulated chips; pure data without three.js so node --test modules can use it.
// Boards match board3d.ts BOARDS: ESP32-DevKitC V4, ESP32-C3-DevKitM-1, ESP32-S3-DevKitC-1 v1.0.
import { t } from './i18n/index.ts';

export type SimChip = 'esp32' | 'esp32c3' | 'esp32s3';

export const CHIP_LABEL: Record<SimChip, string> = { esp32: 'ESP32', esp32c3: 'ESP32-C3', esp32s3: 'ESP32-S3' };
export const CHIP_SHORT: Record<SimChip, string> = { esp32: 'ESP32', esp32c3: 'C3', esp32s3: 'S3' };
export const BOARD_NAME: Record<SimChip, string> = { esp32: 'ESP32-DevKitC V4', esp32c3: 'ESP32-C3-DevKitM-1', esp32s3: 'ESP32-S3-DevKitC-1' };
export const CHIP_DESC: Record<SimChip, string> = { esp32: t('ESP32 · dual-core 160 MHz'), esp32c3: 'ESP32-C3 · 160 MHz', esp32s3: t('ESP32-S3 · dual-core 160 MHz') };
/** GPIO wired to the BOOT button. */
export const BOOT_GPIO: Record<SimChip, number> = { esp32: 0, esp32c3: 9, esp32s3: 0 };
/** GPIO of the on-board WS2812; DevKitC V4 has none (null). */
export const RGB_GPIO: Record<SimChip, number | null> = { esp32: null, esp32c3: 8, esp32s3: 48 };
