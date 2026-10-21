// F-04a2: bare rectangular SPI TFT panels (core soc/devices/dcs.rs, CLI --spi <name>); dependency-free for the worker and tools.

/** Panel id = the CLI --spi name and the tb_lcd_attach_spec text */
export type TftPanel = 'ili9341' | 'st7789-240x240' | 'st7789-240x320';

/** Frame size per panel (must equal tb_lcd_w / tb_lcd_h, or the bench texture drops frames) */
export const TFT_PX: Record<TftPanel, [number, number]> = { ili9341: [240, 320], 'st7789-240x240': [240, 240], 'st7789-240x320': [240, 320] };

export const isTftPanel = (s: unknown): s is TftPanel => typeof s === 'string' && s in TFT_PX;

/** Screen named by a CLI --spi list: 'gc9a01' / 'co5300' / a TFT panel; undefined when none */
export function lcdFromSpi(spi: string | undefined): 'gc9a01' | 'co5300' | TftPanel | undefined {
  for (const d of (spi ?? '').split(',')) {
    const n = d.split('@')[0];
    if (n === 'gc9a01' || n === 'co5300' || isTftPanel(n)) return n;
  }
  return undefined;
}

/** Header pin roles; signal roles name the LCD_WIRING field the pin goes to */
export type TftPinRole = 'gnd' | 'vcc' | 'sclk' | 'mosi' | 'rst' | 'dc' | 'cs' | 'bl' | 'miso';
/** Silkscreen order on the module header: ILI9341 red 9-pin module (SDO = MISO, left open) / ST7789 8-pin modules */
export const TFT_HEADER: Record<TftPanel, [string, TftPinRole][]> = {
  ili9341: [['VCC', 'vcc'], ['GND', 'gnd'], ['CS', 'cs'], ['RESET', 'rst'], ['DC', 'dc'], ['SDI', 'mosi'], ['SCK', 'sclk'], ['LED', 'bl'], ['SDO', 'miso']],
  'st7789-240x240': [['GND', 'gnd'], ['VCC', 'vcc'], ['SCL', 'sclk'], ['SDA', 'mosi'], ['RES', 'rst'], ['DC', 'dc'], ['CS', 'cs'], ['BLK', 'bl']],
  'st7789-240x320': [['GND', 'gnd'], ['VCC', 'vcc'], ['SCL', 'sclk'], ['SDA', 'mosi'], ['RES', 'rst'], ['DC', 'dc'], ['CS', 'cs'], ['BLK', 'bl']],
};
