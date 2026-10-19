// Rule ids, titles and sources plus net voltages, apart from the engine: the bench wiring check needs only these (R-12).
// Titles are English keys translated by the caller; sources are citations and stay English.

export type Confidence = '数据手册' | '估算' | '必须上真机' | '经验规则'; // lint: allow-cjk

export interface RuleMeta {
  id: string;
  /** Default level when fired (some rules pick another, e.g. R03 drops to warn when the PSRAM type is unknown) */
  level: 'block' | 'warn';
  title: string;
  source: string;
  confidence: Confidence;
}

export const RULES: RuleMeta[] = [
  { id: 'R01', level: 'block', title: 'C3 GPIO12–17 are wired to flash', source: 'ESP32-C3 datasheet §2 pins; ESPHome gpio_esp32_c3.py (MIT)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R02', level: 'block', title: 'S3 GPIO26–32 are the flash / PSRAM SPI pins', source: 'ESP32-S3 datasheet §2 pins; ESPHome gpio_esp32_s3.py (MIT)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R03', level: 'block', title: 'Octal PSRAM takes GPIO33–37', source: 'ESP32-S3-WROOM-1 datasheet (R8 variants); ESPHome gpio_esp32_s3.py; PlatformIO boards memory_type qio_opi', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R04', level: 'block', title: 'The chip has no such GPIO, or this board does not break it out', source: 'ESP32-S3 / C3 datasheet IO MUX table; dev board user guide pin tables', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R05', level: 'warn', title: 'BOOT pin (C3 GPIO9 / S3 GPIO0) pulled low at power-up enters download mode', source: 'ESP32-C3 / S3 datasheet strapping pin table; ESPHome check_strapping_pin', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R06', level: 'warn', title: 'C3 GPIO8 / GPIO2 should stay high at power-up', source: 'ESP32-C3 datasheet strapping pin table', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R07', level: 'block', title: 'S3 GPIO45 pulled high at power-up switches flash to 1.8 V', source: 'ESP32-S3 datasheet strapping (VDD_SPI voltage); Espressif esp-techpedia S3 hardware guide', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R08', level: 'warn', title: 'S3 GPIO46 pulled high at power-up can form an illegal boot mode', source: 'ESP32-S3 datasheet strapping pin table', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R09', level: 'warn', title: 'USB D− / D+ are in use', source: 'ESP32-C3 / S3 datasheet USB Serial/JTAG; ESPHome check_usb_jtag_pin', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R10', level: 'warn', title: 'UART0 (flashing and log serial) is in use', source: 'Espressif dev board user guides (UART0 to the USB-UART)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R11', level: 'block', title: 'C3 analog inputs must be on ADC1 (GPIO0–4)', source: 'ESP-IDF v5.5 ADC Oneshot docs (ESP32-C3: ADC2 dropped due to an erratum); ESP32-C3 errata', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R12', level: 'warn', title: 'S3 ADC2 reads may time out with Wi-Fi on', source: 'ESP-IDF v5.5 ADC Oneshot docs (ESP32-S3: ADC2 shared with Wi-Fi, may return ESP_ERR_TIMEOUT)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R13', level: 'warn', title: 'C3 GPIO11 is the VDD_SPI power pin by default', source: 'ESP32-C3 technical reference manual eFuse (VDD_SPI_AS_GPIO)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R14', level: 'block', title: 'More peripherals than on-chip resources (RMT / LEDC / I2C)', source: 'ESP-IDF v5.5.1 soc_caps.h (C3: RMT TX 2, LEDC 6, I2C 1; S3: RMT TX 4, LEDC 8, I2C 2)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R15', level: 'block', title: 'Address conflict on one I2C bus', source: 'Device datasheets, I2C addresses', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R16', level: 'warn', title: 'Too many I2C modules, parallel pull-ups too strong', source: 'NXP UM10204 I2C spec (3 mA sink); module pull-ups assumed 4.7 kΩ', confidence: '估算' }, // lint: allow-cjk
  { id: 'R17', level: 'block', title: '5 V signal straight into a GPIO', source: 'ESP32-C3 / S3 datasheet electrical characteristics (input limit around VDD+0.3 V)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R18', level: 'warn', title: '5 V WS2812 driven by a 3.3 V data line', source: 'WS2812B datasheet (VIH = 0.7 × VDD ≈ 3.5 V)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R19', level: 'block', title: 'Supply voltage out of range (e.g. servo on 3V3, 3.3 V module on 5 V)', source: 'Device datasheets / specs supply ranges (SG90 4.8–6 V etc.)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R20', level: 'warn', title: 'USB power only, peak current above 500 mA', source: 'USB 2.0 spec 500 mA; SG90 stall and WS2812 full-white currents are estimates', confidence: '估算' }, // lint: allow-cjk
  { id: 'R21', level: 'warn', title: '3.3 V regulator overloaded', source: 'ESP32-C3 / S3 datasheet RF TX peak current; on-board LDO rating (entered per board, 500 mA if missing)', confidence: '估算' }, // lint: allow-cjk
  { id: 'R22', level: 'warn', title: 'GPIO directly driving a high-current load', source: 'ESP32-C3 / S3 datasheet GPIO drive strength (default drive level)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R23', level: 'warn', title: 'On-board RGB LED pin does not match the firmware (DevKitC-1 v1.0 GPIO48 / v1.1 GPIO38)', source: 'ESP32-S3-DevKitC-1 user guide v1.1 (RGB moved to GPIO38)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R24', level: 'warn', title: 'Pin conflicts with an on-board device', source: 'Dev board user guides / Seeed Wiki / M5Stack docs / Waveshare wiki (entered per board)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R25', level: 'block', title: 'The chip lacks a capability the project needs (USB OTG, camera, Classic Bluetooth)', source: 'ESP-IDF v5.5.1 soc_caps.h (SOC_USB_OTG_SUPPORTED etc.)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R26', level: 'warn', title: 'Metal or a battery near the antenna degrades Wi-Fi', source: 'Espressif module hardware design guidelines (antenna keep-out area)', confidence: '必须上真机' }, // lint: allow-cjk
  { id: 'R27', level: 'block', title: 'Missing required parts (template required, servo supply, charging, Dupont wires, data cable, companions)', source: 'TryBoard shopping rules', confidence: '经验规则' }, // lint: allow-cjk
  { id: 'R28', level: 'warn', title: 'A header pin that looks ordinary is really a strapping pin (XIAO C3 D0 / D8 / D9 etc.)', source: 'Seeed Wiki XIAO ESP32C3 pin table (D0 / D8 / D9 = GPIO2 / 8 / 9 are strapping); ESP32-C3 / S3 datasheet strapping pin table', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R29', level: 'warn', title: 'The board already has this device and another one is added (e.g. a GC9A01 on the Waveshare round-display board)', source: 'Waveshare wiki ESP32-S3-LCD-1.28 / Touch-LCD-1.28 (on-board GC9A01)', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R30', level: 'block', title: 'Firmware needs PSRAM but the board has none (XIAO C3, AtomS3 etc.)', source: 'ESP32-C3 datasheet (no PSRAM interface); ESP32-S3 ordering info (only R variants have PSRAM); Seeed Wiki / M5Stack docs', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R31', level: 'block', title: 'Not enough free GPIOs on the board (AtomS3 has only 8)', source: 'Dev board pin tables (M5Stack AtomS3: header G5–G8 / G38 / G39 + Grove G1 / G2); on-board use entered per board', confidence: '数据手册' }, // lint: allow-cjk
  { id: 'R32', level: 'warn', title: 'On-board display pins do not match the firmware (Waveshare round display touch and no-touch differ)', source: 'Waveshare wiki: no-touch display RST GPIO12, backlight GPIO40; touch RST GPIO14, backlight GPIO2', confidence: '数据手册' }, // lint: allow-cjk
];
export const RULE_BY_ID: Record<string, RuleMeta> = Object.fromEntries(RULES.map((r) => [r.id, r]));

export const netVolt = (net: string | null): number | null => {
  if (net === null) return null;
  if (net === '3V3' || net === 'EXT3V3' || /^GPIO\d+$/.test(net)) return 3.3;
  if (net === '5V' || net === 'VBUS' || net === 'EXT5V') return 5;
  if (net === 'BAT') return 4.2;
  if (net === 'GND') return 0;
  return null;
};
