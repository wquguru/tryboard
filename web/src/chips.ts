// 三颗可模拟芯片的显示名与板载引脚（纯数据，不拉 three.js；node --test 的纯函数模块也能用）。
// 板子与 board3d.ts 的 BOARDS 一一对应：ESP32-DevKitC V4、ESP32-C3-DevKitM-1、ESP32-S3-DevKitC-1 v1.0
export type SimChip = 'esp32' | 'esp32c3' | 'esp32s3';

export const CHIP_LABEL: Record<SimChip, string> = { esp32: 'ESP32', esp32c3: 'ESP32-C3', esp32s3: 'ESP32-S3' };
export const CHIP_SHORT: Record<SimChip, string> = { esp32: 'ESP32', esp32c3: 'C3', esp32s3: 'S3' };
export const BOARD_NAME: Record<SimChip, string> = { esp32: 'ESP32-DevKitC V4', esp32c3: 'ESP32-C3-DevKitM-1', esp32s3: 'ESP32-S3-DevKitC-1' };
export const CHIP_DESC: Record<SimChip, string> = { esp32: 'ESP32 · 双核 160 MHz', esp32c3: 'ESP32-C3 · 160 MHz', esp32s3: 'ESP32-S3 · 双核 160 MHz' };
/** BOOT 键接的 GPIO */
export const BOOT_GPIO: Record<SimChip, number> = { esp32: 0, esp32c3: 9, esp32s3: 0 };
/** 板载 WS2812 的 GPIO；DevKitC V4 没有，为 null */
export const RGB_GPIO: Record<SimChip, number | null> = { esp32: null, esp32c3: 8, esp32s3: 48 };
