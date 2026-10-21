// Chip ids from the ESP image header / tb_chip(); dependency-free so the worker and the npm CLI can import it.
// Must match `tryboard chips --json` (checked by test/chips.test.ts).
export type SimChip = 'esp32' | 'esp32c3' | 'esp32s3';

export const CHIP_ID: Record<SimChip, number> = { esp32: 0, esp32c3: 5, esp32s3: 9 };
/** GPIO count (pads 0..n-1) per chip. */
export const NPINS: Record<SimChip, number> = { esp32: 40, esp32c3: 22, esp32s3: 49 };

/** GPIO wired to the BOOT button. */
/** Official MicroPython download pages (F-07b: users upload the bin themselves); S3 only boots the SPIRAM_OCT build here. */
export const MPY_DOWNLOAD: Partial<Record<SimChip, { url: string; octOnly?: boolean }>> = {
  esp32c3: { url: 'https://micropython.org/download/ESP32_GENERIC_C3/' },
  esp32s3: { url: 'https://micropython.org/download/ESP32_GENERIC_S3/', octOnly: true },
};
export const BOOT_GPIO: Record<SimChip, number> = { esp32: 0, esp32c3: 9, esp32s3: 0 };
/** GPIO of the on-board WS2812; DevKitC V4 has none (null). */
export const RGB_GPIO: Record<SimChip, number | null> = { esp32: null, esp32c3: 8, esp32s3: 48 };
/** Default RC522 chip-select GPIO (machine/src/parts.rs rc522_default_cs). */
export const RC522_CS: Record<SimChip, number> = { esp32: 10, esp32c3: 7, esp32s3: 10 };
/** ROM ELF per chip, from esp-rom-elfs. */
export const ROM_FILE: Record<SimChip, string> = { esp32: 'esp32_rev300_rom.elf', esp32c3: 'esp32c3_rev3_rom.elf', esp32s3: 'esp32s3_rev0_rom.elf' };

/** Chip soldered on each all-in-one board (E-03), keyed by SceneSpec.board. */
export const AIO_CHIP: Record<string, SimChip> = {
  'ws-amoled216': 'esp32s3',
  // M5Stack presets (M5-09b): same chips as core/crates/machine/src/boards.rs
  m5dial: 'esp32s3',
  m5atoms3: 'esp32s3',
  m5atoms3lite: 'esp32s3',
  m5atoms3r: 'esp32s3',
  m5cores3: 'esp32s3',
  m5cores3se: 'esp32s3',
  m5cardputer: 'esp32s3',
  m5cardputeradv: 'esp32s3',
  m5stickcplus2: 'esp32',
  m5core2: 'esp32',
  m5core2v11: 'esp32',
  m5atomlite: 'esp32',
};

/** Chip for a header / tb_chip() id; null when TryBoard does not simulate it. */
export function chipFromId(id: number): SimChip | null {
  for (const c of Object.keys(CHIP_ID) as SimChip[]) if (CHIP_ID[c] === id) return c;
  return null;
}

/** Fixed SPI2 LCD wiring per chip (GC9A01 and the F-04a2 TFTs; the core models exactly this wiring, see lcd_pin in core) */
export const LCD_WIRING: Record<SimChip, { sclk: number; mosi: number; cs: number; dc: number; rst: number; bl: number }> = {
  esp32s3: { sclk: 12, mosi: 11, cs: 10, dc: 14, rst: 13, bl: 15 },
  esp32c3: { sclk: 6, mosi: 7, cs: 10, dc: 5, rst: 4, bl: 3 },
  // The core has no round LCD on ESP32 yet (C-05 covers I2C / LEDC only): common VSPI wiring as a placeholder, unused by examples
  esp32: { sclk: 18, mosi: 23, cs: 5, dc: 16, rst: 17, bl: 4 },
};
