// 元件编辑器的数据部分（界面在 app/steps/bench.tsx）：引脚表、元件描述、冲突检查。
// 上传自己的固件时最有用：示例自带接线，自定义固件的接线只有用户知道。
import { BOARDS, I2S_WIRING, LCD_WIRING, type ChipId, type PartSpec, type SceneSpec } from './board3d';

/** 各芯片的 ADC1 引脚与引脚提示（strapping、板载占用、USB、串口、PSRAM） */
const CHIP_PINS: Record<ChipId, { adc: number[]; hint: Record<number, string>; avoid: number[] }> = {
  esp32c3: {
    adc: [0, 1, 2, 3, 4],
    hint: { 2: 'strapping', 8: 'strapping · 板载 RGB', 9: 'strapping · BOOT 键', 18: 'USB D-', 19: 'USB D+', 20: 'UART0 RX', 21: 'UART0 TX' },
    avoid: [],
  },
  esp32s3: {
    adc: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    hint: { 0: 'strapping · BOOT 键', 3: 'strapping', 45: 'strapping', 46: 'strapping', 19: 'USB D-', 20: 'USB D+', 48: '板载 RGB' },
    // N16R8：GPIO35–37 接八线 PSRAM，排针上有但不能用
    avoid: [35, 36, 37],
  },
};
/** 当前开发板排针上引出的 GPIO（按丝印顺序，去掉不能用的） */
export const pinsOf = (c: ChipId) => {
  const b = BOARDS[c];
  return [...b.left, ...b.right]
    .filter((n) => /^IO\d+$/.test(n))
    .map((n) => Number(n.slice(2)))
    .filter((p) => !CHIP_PINS[c].avoid.includes(p))
    .sort((a, b) => a - b);
};
export const adcPins = (c: ChipId) => CHIP_PINS[c].adc;
/** 引脚下拉项的文字：IO 号 + 用途提示 */
export const pinLabel = (c: ChipId, p: number) => `IO${p}${CHIP_PINS[c].hint[p] ? `（${CHIP_PINS[c].hint[p]}）` : ''}`;

export type Kind = PartSpec['type'];
export const KINDS: { kind: Kind; name: string; desc: string }[] = [
  { kind: 'led', name: 'LED + 220Ω', desc: '数字输出 / PWM 调光' },
  { kind: 'servo', name: 'SG90 舵机', desc: '50Hz PWM，0.5–2.5ms' },
  { kind: 'pot', name: '电位器', desc: '模拟输入（ADC1）' },
  { kind: 'oled', name: 'SSD1306 OLED', desc: 'I2C 128×64' },
  { kind: 'bme280', name: 'BME280 温湿度气压', desc: 'I2C 环境传感器' },
];

export function describe(p: PartSpec, chip: ChipId = 'esp32c3'): string {
  switch (p.type) {
    case 'led':
      return `LED · IO${p.pin}`;
    case 'servo':
      return `舵机 · 信号 IO${p.pin}`;
    case 'pot':
      return `电位器 · 滑片 IO${p.pin}`;
    case 'buzzer':
      return `无源蜂鸣器 · IO${p.pin}`;
    case 'key':
      return `按键 ${p.cap ?? ''} · IO${p.pin}（按下接地）`;
    case 'encoder':
      return `编码器 · CLK IO${p.a} / DT IO${p.b}${p.sw !== undefined ? ` / SW IO${p.sw}` : ''}`;
    case 'hcsr04':
      return `HC-SR04 · Trig IO${p.trig} / Echo IO${p.echo}`;
    case 'ws2812':
      return `WS2812 灯条 × ${p.n ?? 8} · DIN IO${p.pin}`;
    case 'oled':
      return `OLED · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'bme280':
      return `BME280 · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'mpu6050':
    case 'qmi8658':
      return `${p.type === 'mpu6050' ? 'MPU6050' : 'QMI8658'} · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'cst816s':
      return `CST816S 触摸 · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl} / INT IO${p.int}`;
    case 'gc9a01':
    {
      const w = LCD_WIRING[chip];
      return `GC9A01 圆屏 · SPI2 · SCLK IO${w.sclk} / MOSI IO${w.mosi} / CS IO${w.cs} / DC IO${w.dc} / RST IO${w.rst} / BL IO${w.bl}`;
    }
    case 'max98357a': {
      const w = I2S_WIRING[chip].spk;
      return `MAX98357A 功放 + 喇叭 · I2S · BCLK IO${w.bclk} / LRC IO${w.lrc} / DIN IO${w.din}`;
    }
    case 'inmp441': {
      const w = I2S_WIRING[chip].mic;
      return `INMP441 麦克风 · I2S · SCK IO${w.sck} / WS IO${w.ws} / SD IO${w.sd}`;
    }
  }
}

/** I2C 器件 / 编码器 / 超声波变了要重新上电（器件在上电时挂上） */
export const needsReboot = (a: SceneSpec, b: SceneSpec) => {
  const i2c = (s: SceneSpec) =>
    JSON.stringify(s.parts.filter((p) => p.type === 'oled' || p.type === 'bme280' || p.type === 'gc9a01' || p.type === 'encoder' || p.type === 'hcsr04' || p.type === 'mpu6050' || p.type === 'qmi8658' || p.type === 'cst816s' || p.type === 'max98357a' || p.type === 'inmp441').map((p) => (p.type === 'hcsr04' ? { ...p, cm: undefined } : p)));
  return i2c(a) !== i2c(b);
};

/** 检查引脚冲突：同一引脚被两个非 I2C 元件占用，或 I2C 线与普通元件撞脚 */
export function conflicts(s: SceneSpec, chip: ChipId = 'esp32c3'): string[] {
  const used = new Map<number, string>();
  const out: string[] = [];
  const claim = (pin: number, who: string, shareable = false) => {
    const prev = used.get(pin);
    if (prev && !(shareable && prev.startsWith('I2C'))) out.push(`IO${pin} 同时接了「${prev}」和「${who}」`);
    else used.set(pin, who);
  };
  for (const p of s.parts) {
    if (p.type === 'oled' || p.type === 'bme280' || p.type === 'mpu6050' || p.type === 'qmi8658' || p.type === 'cst816s') {
      claim(p.sda, 'I2C SDA', true);
      claim(p.scl, 'I2C SCL', true);
      if (p.type === 'cst816s') claim(p.int, '触摸 INT');
    } else if (p.type === 'gc9a01') {
      for (const pin of [12, 11, 10, 14, 13, 15]) claim(pin, 'GC9A01 圆屏');
    } else if (p.type === 'encoder') {
      for (const pin of [p.a, p.b, ...(p.sw !== undefined ? [p.sw] : [])]) claim(pin, describe(p, chip));
    } else if (p.type === 'hcsr04') {
      claim(p.trig, describe(p, chip));
      claim(p.echo, describe(p, chip));
    } else if (p.type === 'max98357a') {
      const w = I2S_WIRING[chip].spk;
      for (const pin of [w.bclk, w.lrc, w.din]) claim(pin, 'MAX98357A 喇叭');
    } else if (p.type === 'inmp441') {
      // C3 上喇叭和麦克风共用 BCK / WS（全双工），不算冲突
      const w = I2S_WIRING[chip].mic;
      const spk = I2S_WIRING[chip].spk;
      for (const pin of [w.sck, w.ws, w.sd]) if (!(s.parts.some((q) => q.type === 'max98357a') && (pin === spk.bclk || pin === spk.lrc))) claim(pin, 'INMP441 麦克风');
    } else claim(p.pin, describe(p, chip));
  }
  const addrs = s.parts.flatMap((p) => ('addr' in p ? [p.addr] : []));
  if (new Set(addrs).size !== addrs.length) out.push('两个 I2C 器件地址相同，总线上会冲突');
  return out;
}
