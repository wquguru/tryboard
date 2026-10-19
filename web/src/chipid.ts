// Chip ids from the ESP image header / tb_chip(); dependency-free so the worker and the npm CLI can import it.
// Must match `tryboard chips --json` (checked by test/chips.test.ts).
export type SimChip = 'esp32' | 'esp32c3' | 'esp32s3';

export const CHIP_ID: Record<SimChip, number> = { esp32: 0, esp32c3: 5, esp32s3: 9 };
/** GPIO count (pads 0..n-1) per chip. */
export const NPINS: Record<SimChip, number> = { esp32: 40, esp32c3: 22, esp32s3: 49 };

/** GPIO wired to the BOOT button. */
export const BOOT_GPIO: Record<SimChip, number> = { esp32: 0, esp32c3: 9, esp32s3: 0 };
/** GPIO of the on-board WS2812; DevKitC V4 has none (null). */
export const RGB_GPIO: Record<SimChip, number | null> = { esp32: null, esp32c3: 8, esp32s3: 48 };
/** ROM ELF per chip, from esp-rom-elfs. */
export const ROM_FILE: Record<SimChip, string> = { esp32: 'esp32_rev300_rom.elf', esp32c3: 'esp32c3_rev3_rom.elf', esp32s3: 'esp32s3_rev0_rom.elf' };

/** Chip for a header / tb_chip() id; null when TryBoard does not simulate it. */
export function chipFromId(id: number): SimChip | null {
  for (const c of Object.keys(CHIP_ID) as SimChip[]) if (CHIP_ID[c] === id) return c;
  return null;
}
