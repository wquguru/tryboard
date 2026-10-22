// Advisor parts / boards to shop catalog (catalog/parts.ts), per DECISIONS 2026-10-18 advisor v3 contract 2.
// The advisor speaks in functions, shop and bench need models; parts without a model go in the list but not on the bench.
import { t } from '../i18n/index.ts';

export interface CatalogItem {
  partId: string;
  qty?: number;
  /** Bought along with it (servo needs a 5 V adapter, battery a charger board, amplifier a speaker) */
  with?: string[];
}

/** null = no model: listed by advisor name only, not on the bench, confidence real board only */
export const PART_MAP: Record<string, CatalogItem | null> = {
  bme280: { partId: 'bme280' },
  oled: { partId: 'ssd1306' },
  ws2812: { partId: 'ws2812-strip' },
  servo: { partId: 'sg90', with: ['psu-5v2a'] },
  button: { partId: 'button' },
  pot: { partId: 'pot' },
  led: { partId: 'led-kit' },
  battery: { partId: 'lipo-1000', with: ['tp4056'] },
  amp: { partId: 'max98357a', with: ['speaker-3w'] },
  mic: { partId: 'inmp441' },
  tft: { partId: 'st7789' },
  buzzer: { partId: 'buzzer-module' },
  dht11: { partId: 'dht11' },
  aht20: { partId: 'aht20' },
  relay: null,
  rc522: null,
  irrx: null,
  irled: null,
  pir: null,
  camera: null,
};

/** Always added: breadboard and jumper wires (often ticked as "I have it") */
export const ALWAYS = ['breadboard-400', 'dupont-ff'];

/** Advisor board to bench board; sub = not the same board, it runs as a stand-in */
export const BOARD_MAP: Record<string, { boardId: string; sub?: string }> = {
  'xiao-c3': { boardId: 'xiao-c3' },
  'c3-devkitm': { boardId: 'c3-devkitm1' },
  'c3-supermini': { boardId: 'xiao-c3', sub: 'Also an ESP32-C3; runs on a XIAO ESP32C3 instead' },
  's3-devkitc-n16r8': { boardId: 's3-devkitc1-v11' },
  'xiao-s3-sense': { boardId: 'xiao-s3', sub: 'The camera part needs a real board' },
  'c6-devkitc': { boardId: 'xiao-c3', sub: 'C6 cannot be simulated yet; runs on an ESP32-C3 instead' },
  'xiao-c6': { boardId: 'xiao-c3', sub: 'C6 cannot be simulated yet; runs on an ESP32-C3 instead' },
  'esp32-devkitc': { boardId: 'esp32-devkitc-v4' },
};

// sub is display text, so translate it once here for every caller
export const boardFor = (advisorBoard: string) => {
  const m = BOARD_MAP[advisorBoard] ?? { boardId: 'xiao-c3', sub: 'This board cannot be simulated yet; runs on an ESP32-C3 instead' };
  return m.sub ? { ...m, sub: t(m.sub) } : m;
};
