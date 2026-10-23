// Data side of the part editor (UI in app/steps/bench.tsx): pin table, part descriptions, conflict checks.
// Matters most for uploaded firmware: examples carry their wiring, custom firmware wiring is known only to the user.
import { BOARDS, I2S_WIRING, LCD_WIRING, isI2cMod, type ChipId, type PartSpec, type SceneSpec } from './board3d';
import { TFT_PX } from './lcdspec.ts';
import { t } from './i18n';

/** ADC1 pins and pin hints per chip (strapping, on-board use, USB, UART, PSRAM); hints are English keys translated in pinLabel. */
const CHIP_PINS: Record<ChipId, { adc: number[]; hint: Record<number, string>; avoid: number[] }> = {
  esp32: {
    adc: [32, 33, 34, 35, 36, 39],
    hint: { 0: 'strapping · BOOT button', 2: 'strapping', 5: 'strapping', 12: 'strapping · high at power-up makes flash 1.8 V', 15: 'strapping', 34: 'input only', 35: 'input only', 36: 'input only', 39: 'input only' },
    avoid: [],
  },
  esp32c3: {
    adc: [0, 1, 2, 3, 4],
    hint: { 2: 'strapping', 8: 'strapping · on-board RGB', 9: 'strapping · BOOT button', 18: 'USB D-', 19: 'USB D+', 20: 'UART0 RX', 21: 'UART0 TX' },
    avoid: [],
  },
  esp32s3: {
    adc: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    hint: { 0: 'strapping · BOOT button', 3: 'strapping', 45: 'strapping', 46: 'strapping', 19: 'USB D-', 20: 'USB D+', 48: 'on-board RGB' },
    // N16R8: GPIO35–37 drive the octal PSRAM; they are on the header but unusable.
    avoid: [35, 36, 37],
  },
};
/** GPIOs broken out on the current board's headers (silkscreen order, unusable ones removed). */
export const pinsOf = (c: ChipId) => {
  const b = BOARDS[c];
  return [...b.left, ...b.right]
    .filter((n) => /^IO\d+$/.test(n))
    .map((n) => Number(n.slice(2)))
    .filter((p) => !CHIP_PINS[c].avoid.includes(p))
    .sort((a, b) => a - b);
};
export const adcPins = (c: ChipId) => CHIP_PINS[c].adc;
/** Pin dropdown text: IO number plus usage hint. */
export const pinLabel = (c: ChipId, p: number) => `IO${p}${CHIP_PINS[c].hint[p] ? ` (${t(CHIP_PINS[c].hint[p])})` : ''}`;

export type Kind = PartSpec['type'];
export const KINDS: { kind: Kind; name: string; desc: string }[] = [
  { kind: 'led', name: 'LED + 220Ω', desc: t('Digital output / PWM dimming') },
  { kind: 'servo', name: t('SG90 servo'), desc: t('50 Hz PWM, 0.5–2.5 ms') },
  { kind: 'pot', name: t('Potentiometer'), desc: t('Analog input (ADC1)') },
  { kind: 'oled', name: 'SSD1306 OLED', desc: 'I2C 128×64' },
  { kind: 'bme280', name: t('BME280 temperature / humidity / pressure'), desc: t('I2C environment sensor') },
];

export function describe(p: PartSpec, chip: ChipId = 'esp32c3'): string {
  switch (p.type) {
    case 'led':
      return `LED · IO${p.pin}`;
    case 'servo':
      return t('Servo · signal IO{pin}', { pin: p.pin });
    case 'pot':
      return t('Potentiometer · wiper IO{pin}', { pin: p.pin });
    case 'buzzer':
      return t('Passive buzzer · IO{pin}', { pin: p.pin });
    case 'key':
      return t('Button {cap} · IO{pin} (pressed = GND)', { cap: p.cap ?? '', pin: p.pin });
    case 'encoder':
      return `${t('Encoder')} · CLK IO${p.a} / DT IO${p.b}${p.sw !== undefined ? ` / SW IO${p.sw}` : ''}`;
    case 'hcsr04':
      return `HC-SR04 · Trig IO${p.trig} / Echo IO${p.echo}`;
    case 'dht11':
      return `DHT11 · DATA IO${p.pin}`;
    case 'ds18b20':
      return `DS18B20${(p.n ?? 1) > 1 ? ` × ${p.n}` : ''} · DQ IO${p.pin}`;
    case 'pir':
      return `PIR · OUT IO${p.pin}`;
    case 'relay':
      return `${t('Relay')} · IN IO${p.pin}`;
    case 'ldr':
      return `${t('Light sensor')} · AO IO${p.pin}`;
    case 'rc522':
      return `RC522 · SDA IO${p.cs ?? '-'}`;
    case 'irrx':
      return `${t('IR receiver')} · OUT IO${p.pin}`;
    case 'irled':
      return `${t('IR LED')} · S IO${p.pin}`;
    case 'ws2812':
      return `${t('WS2812 strip')} × ${p.n ?? 8} · DIN IO${p.pin}`;
    case 'oled':
      return `OLED · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'aht20':
    case 'ina219':
    case 'ds3231':
      return `${p.type.toUpperCase()} · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'bme280':
      return `BME280 · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'mpu6050':
    case 'qmi8658':
      return `${p.type === 'mpu6050' ? 'MPU6050' : 'QMI8658'} · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'cst816s':
      return `${t('CST816S touch')} · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl} / INT IO${p.int}`;
    case 'tft':
      return `${p.panel === 'ili9341' ? 'ILI9341' : 'ST7789'} ${TFT_PX[p.panel].join('×')} · SPI2 · SCLK IO${p.sclk} / MOSI IO${p.mosi} / CS IO${p.cs} / DC IO${p.dc} / RST IO${p.rst} / BL IO${p.bl}`;
    case 'gc9a01':
    {
      const w = LCD_WIRING[chip];
      return `${t('GC9A01 round LCD')} · SPI2 · SCLK IO${w.sclk} / MOSI IO${w.mosi} / CS IO${w.cs} / DC IO${w.dc} / RST IO${w.rst} / BL IO${w.bl}`;
    }
    case 'max98357a': {
      const w = I2S_WIRING[chip].spk;
      return `${t('MAX98357A amp + speaker')} · I2S · BCLK IO${w.bclk} / LRC IO${w.lrc} / DIN IO${w.din}`;
    }
    case 'inmp441': {
      const w = I2S_WIRING[chip].mic;
      return `${t('INMP441 microphone')} · I2S · SCK IO${w.sck} / WS IO${w.ws} / SD IO${w.sd}`;
    }
  }
}

/** Changing I2C devices / encoder / ultrasonic needs a power cycle (devices attach at power-up). */
export const needsReboot = (a: SceneSpec, b: SceneSpec) => {
  const i2c = (s: SceneSpec) =>
    JSON.stringify(s.parts.filter((p) => p.type === 'oled' || p.type === 'bme280' || p.type === 'gc9a01' || p.type === 'tft' || p.type === 'encoder' || p.type === 'hcsr04' || p.type === 'mpu6050' || p.type === 'qmi8658' || p.type === 'cst816s' || p.type === 'max98357a' || p.type === 'inmp441' || isI2cMod(p)).map((p) => (p.type === 'hcsr04' ? { ...p, cm: undefined } : p)));
  return i2c(a) !== i2c(b);
};

/** Pin conflicts: one pin taken by two non-I2C parts, or an I2C line colliding with a plain part. */
export function conflicts(s: SceneSpec, chip: ChipId = 'esp32c3'): string[] {
  const used = new Map<number, string>();
  const out: string[] = [];
  const claim = (pin: number, who: string, shareable = false) => {
    const prev = used.get(pin);
    if (prev && !(shareable && prev.startsWith('I2C'))) out.push(t('IO{pin} is wired to both "{a}" and "{b}"', { pin, a: prev, b: who }));
    else used.set(pin, who);
  };
  for (const p of s.parts) {
    if (p.type === 'oled' || p.type === 'bme280' || p.type === 'mpu6050' || p.type === 'qmi8658' || p.type === 'cst816s' || isI2cMod(p)) {
      claim(p.sda, 'I2C SDA', true);
      claim(p.scl, 'I2C SCL', true);
      if (p.type === 'cst816s') claim(p.int, t('Touch INT'));
    } else if (p.type === 'gc9a01') {
      for (const pin of [12, 11, 10, 14, 13, 15]) claim(pin, t('GC9A01 round LCD'));
    } else if (p.type === 'encoder') {
      for (const pin of [p.a, p.b, ...(p.sw !== undefined ? [p.sw] : [])]) claim(pin, describe(p, chip));
    } else if (p.type === 'hcsr04') {
      claim(p.trig, describe(p, chip));
      claim(p.echo, describe(p, chip));
    } else if (p.type === 'max98357a') {
      const w = I2S_WIRING[chip].spk;
      for (const pin of [w.bclk, w.lrc, w.din]) claim(pin, t('MAX98357A speaker'));
    } else if (p.type === 'inmp441') {
      // On C3 the speaker and mic share BCK / WS (full duplex), so that is no conflict.
      const w = I2S_WIRING[chip].mic;
      const spk = I2S_WIRING[chip].spk;
      for (const pin of [w.sck, w.ws, w.sd]) if (!(s.parts.some((q) => q.type === 'max98357a') && (pin === spk.bclk || pin === spk.lrc))) claim(pin, t('INMP441 microphone'));
    } else if (p.type === 'rc522') {
      for (const pin of [p.cs, p.sck, p.mosi, p.miso, p.rst]) if (pin !== undefined) claim(pin, describe(p, chip));
    } else if (p.type === 'tft') {
      for (const pin of [p.sclk, p.mosi, p.cs, p.dc, p.rst, p.bl]) claim(pin, describe(p, chip));
    } else claim(p.pin, describe(p, chip));
  }
  const addrs = s.parts.flatMap((p) => ('addr' in p ? [p.addr] : []));
  if (new Set(addrs).size !== addrs.length) out.push(t('Two I2C devices share an address and will clash on the bus'));
  return out;
}
