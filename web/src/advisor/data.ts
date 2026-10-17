// 选型数据：芯片、开发板、外设模块、项目模板。
// 事实来源：乐鑫各芯片数据手册 / 技术参考手册、开发板厂商的公开资料。价格是 2026 年常见电商区间，仅供参考。
// 发布前需要人工逐条核对（见 docs/ADVISOR.md）。

export type Cap =
  | 'wifi'
  | 'wifi6'
  | 'ble'
  | 'bt_classic'
  | 'thread'
  | 'zigbee'
  | 'usb_otg'
  | 'usb_serial'
  | 'camera'
  | 'audio_in'
  | 'audio_out'
  | 'display_spi'
  | 'display_rgb'
  | 'psram'
  | 'ai_accel'
  | 'touch'
  | 'dac'
  | 'ethernet'
  | 'low_power'
  | 'many_gpio';

export interface Chip {
  id: string;
  name: string;
  core: string;
  mhz: number;
  sramKB: number;
  caps: Cap[];
  gpio: number;
  /** 不建议用的引脚：flash / PSRAM 占用、USB、strapping */
  pins: { flash: number[]; strapping: number[]; usb: number[]; uart0: [number, number]; adc1: number[]; inputOnly?: number[]; psramOctal?: number[] };
  /** 典型电流（mA），数据手册典型值，3.3V，室温 */
  power: { txPeak: number; rx: number; modemSleep: number; lightSleepUA: number; deepSleepUA: number };
  notes: string[];
  simulated: 'full' | 'partial' | 'none';
}

export const CHIPS: Chip[] = [
  {
    id: 'esp32c3',
    name: 'ESP32-C3',
    core: '单核 RISC-V',
    mhz: 160,
    sramKB: 400,
    caps: ['wifi', 'ble', 'usb_serial', 'display_spi', 'low_power'],
    gpio: 22,
    pins: { flash: [12, 13, 14, 15, 16, 17], strapping: [2, 8, 9], usb: [18, 19], uart0: [21, 20], adc1: [0, 1, 2, 3, 4] },
    power: { txPeak: 335, rx: 82, modemSleep: 20, lightSleepUA: 130, deepSleepUA: 5 },
    notes: ['USB 口只能当串口或 JTAG 调试，不能冒充键盘、U 盘', 'C3 的 ADC2（GPIO5）有硬件勘误，ESP-IDF 已经不支持，和 Wi-Fi 无关。模拟量改用 ADC1（GPIO0–4）', '没有经典蓝牙，不能做蓝牙音箱'],
    simulated: 'full',
  },
  {
    id: 'esp32s3',
    name: 'ESP32-S3',
    core: '双核 Xtensa LX7',
    mhz: 240,
    sramKB: 512,
    caps: ['wifi', 'ble', 'usb_otg', 'usb_serial', 'camera', 'audio_in', 'audio_out', 'display_spi', 'display_rgb', 'psram', 'ai_accel', 'touch', 'many_gpio', 'low_power'],
    gpio: 45,
    pins: {
      flash: [26, 27, 28, 29, 30, 31, 32],
      strapping: [0, 3, 45, 46],
      usb: [19, 20],
      uart0: [43, 44],
      adc1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      psramOctal: [33, 34, 35, 36, 37],
    },
    power: { txPeak: 340, rx: 95, modemSleep: 30, lightSleepUA: 240, deepSleepUA: 8 },
    notes: ['N16R8 这类带 8MB 八线 PSRAM 的模组，GPIO33–37 被 PSRAM 占用', 'ADC2（GPIO11–20）与 Wi-Fi 共用，开 Wi-Fi 时读数可能超时失败；模拟量优先放 ADC1（GPIO1–10）', '原生 USB OTG：可以冒充键盘、网卡、U 盘，也能当主机读 U 盘', '向量指令加速 AI 推理，跑离线唤醒词、小模型'],
    simulated: 'partial',
  },
  {
    id: 'esp32c6',
    name: 'ESP32-C6',
    core: '单核 RISC-V，另带低功耗核',
    mhz: 160,
    sramKB: 512,
    caps: ['wifi', 'wifi6', 'ble', 'thread', 'zigbee', 'usb_serial', 'display_spi', 'low_power'],
    gpio: 31,
    pins: { flash: [24, 25, 26, 27, 28, 29, 30], strapping: [8, 9, 15], usb: [12, 13], uart0: [16, 17], adc1: [0, 1, 2, 3, 4, 5, 6] },
    power: { txPeak: 354, rx: 78, modemSleep: 25, lightSleepUA: 180, deepSleepUA: 7 },
    notes: ['Wi-Fi 6 和 Thread / Zigbee 都有，做 Matter 智能家居设备首选', 'USB 口和 C3 一样，只能当串口或 JTAG 调试'],
    simulated: 'none',
  },
  {
    id: 'esp32',
    name: 'ESP32（经典款）',
    core: '双核 Xtensa LX6',
    mhz: 240,
    sramKB: 520,
    caps: ['wifi', 'ble', 'bt_classic', 'dac', 'touch', 'ethernet', 'display_spi', 'audio_in', 'audio_out', 'many_gpio', 'camera', 'psram'],
    gpio: 34,
    pins: {
      flash: [6, 7, 8, 9, 10, 11],
      strapping: [0, 2, 5, 12, 15],
      usb: [],
      uart0: [1, 3],
      adc1: [32, 33, 34, 35, 36, 39],
      inputOnly: [34, 35, 36, 39],
    },
    power: { txPeak: 240, rx: 100, modemSleep: 30, lightSleepUA: 800, deepSleepUA: 10 },
    notes: ['唯一支持经典蓝牙（A2DP 音箱、SPP 串口）的型号', '没有原生 USB，板上靠 CH340 / CP2102 转串口', '教程最多，但新项目一般优先 S3 / C3 / C6'],
    simulated: 'none',
  },
  {
    id: 'esp32p4',
    name: 'ESP32-P4',
    core: '双核 RISC-V',
    mhz: 400,
    sramKB: 768,
    caps: ['usb_otg', 'camera', 'display_rgb', 'audio_in', 'audio_out', 'psram', 'ai_accel', 'ethernet', 'many_gpio'],
    gpio: 55,
    pins: { flash: [], strapping: [34, 35, 36, 37, 38], usb: [24, 25], uart0: [37, 38], adc1: [16, 17, 18, 19, 20, 21, 22, 23] },
    power: { txPeak: 0, rx: 0, modemSleep: 80, lightSleepUA: 0, deepSleepUA: 0 },
    notes: ['没有 Wi-Fi 和蓝牙，开发板一般搭一颗 C6 负责无线', '有 MIPI 摄像头和屏幕接口、H.264 编码，适合带屏的多媒体设备'],
    simulated: 'none',
  },
];

export interface Board {
  id: string;
  name: string;
  chip: string;
  maker: string;
  priceCNY: [number, number];
  flashMB: number;
  psramMB: number;
  size: string;
  extras: string[];
  /** 板上占用的引脚：说明 */
  usedPins: Record<number, string>;
  /** 小板只引出部分引脚（按板上丝印 D0、D1… 的顺序）；不写表示芯片可用引脚基本都引出 */
  exposed?: number[];
  /** 板子丝印上标注的默认 I2C 引脚 [SDA, SCL]（教程和扩展板都按这个接） */
  i2cPins?: [number, number];
  /** 丝印名，如 { 6: 'D4' } */
  labels?: Record<number, string>;
  /** 深睡时整板电流（µA）：LDO 静态电流、电源灯、USB 转串口芯片都会让它远大于芯片本身 */
  boardSleepUA: number;
  battery: boolean;
  caveats: string[];
  simExample?: string;
}

export const BOARDS: Board[] = [
  {
    id: 'c3-devkitm',
    name: 'ESP32-C3-DevKitM-1',
    chip: 'esp32c3',
    maker: '乐鑫官方',
    priceCNY: [40, 60],
    flashMB: 4,
    psramMB: 0,
    size: '25 × 49mm',
    extras: ['WS2812 RGB 灯（GPIO8）', 'BOOT / RST 键', 'USB-UART 芯片'],
    usedPins: { 8: '板载 RGB 灯', 9: 'BOOT 键' },
    boardSleepUA: 1000,
    battery: false,
    caveats: ['电源灯和 USB 转串口芯片常亮，深睡时整板仍有约 1mA，不适合电池供电'],
    simExample: 'rgb',
  },
  {
    id: 'c3-supermini',
    name: 'ESP32-C3 SuperMini',
    chip: 'esp32c3',
    maker: '多家第三方',
    priceCNY: [10, 18],
    flashMB: 4,
    psramMB: 0,
    size: '18 × 23mm',
    extras: ['板载蓝色 LED（GPIO8，低电平亮）', 'Type-C 直连芯片 USB'],
    exposed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21],
    usedPins: { 8: '板载 LED（低电平点亮）', 9: 'BOOT 键' },
    boardSleepUA: 300,
    battery: false,
    caveats: ['陶瓷小天线，信号比 PCB 天线弱，隔墙要留余量', '做工差异大，个别批次 Wi-Fi 发射功率需要调低才稳定'],
  },
  {
    id: 'xiao-c3',
    name: 'Seeed XIAO ESP32C3',
    chip: 'esp32c3',
    maker: 'Seeed Studio',
    priceCNY: [35, 50],
    flashMB: 4,
    psramMB: 0,
    size: '21 × 17.8mm',
    extras: ['锂电池充电管理', '外接天线座'],
    i2cPins: [6, 7],
    exposed: [2, 3, 4, 5, 6, 7, 21, 20, 8, 9, 10],
    labels: { 2: 'D0', 3: 'D1', 4: 'D2', 5: 'D3', 6: 'D4', 7: 'D5', 21: 'D6', 20: 'D7', 8: 'D8', 9: 'D9', 10: 'D10' },
    usedPins: {},
    boardSleepUA: 45,
    battery: true,
    caveats: ['只引出 11 个 GPIO'],
  },
  {
    id: 's3-devkitc-n16r8',
    name: 'ESP32-S3-DevKitC-1（N16R8）',
    chip: 'esp32s3',
    maker: '乐鑫官方 / 兼容板',
    priceCNY: [35, 70],
    flashMB: 16,
    psramMB: 8,
    size: '26 × 63mm',
    extras: ['WS2812 RGB 灯（GPIO48，兼容板常见 GPIO38）', '两个 Type-C：一个接 USB-UART，一个接原生 USB'],
    usedPins: { 0: 'BOOT 键', 48: '板载 RGB 灯（v1.0 为 GPIO48，v1.1 为 GPIO38）' },
    boardSleepUA: 1000,
    battery: false,
    caveats: ['GPIO33–37 被八线 PSRAM 占用，排针上有但不能用', '买的时候确认板上有标「USB」或「OTG」的原生 USB 口：插手机、冒充键盘要用它'],
  },
  {
    id: 'xiao-s3-sense',
    name: 'Seeed XIAO ESP32S3 Sense',
    chip: 'esp32s3',
    maker: 'Seeed Studio',
    priceCNY: [100, 140],
    flashMB: 8,
    psramMB: 8,
    size: '21 × 17.8 × 15mm',
    extras: ['OV2640 / OV3660 摄像头（可拆）', 'PDM 数字麦克风', 'microSD 卡槽', '锂电池充电'],
    i2cPins: [5, 6],
    exposed: [1, 2, 3, 4, 5, 6, 43, 44, 7, 8, 9],
    labels: { 1: 'D0', 2: 'D1', 3: 'D2', 4: 'D3', 5: 'D4', 6: 'D5', 43: 'D6', 44: 'D7', 7: 'D8', 8: 'D9', 9: 'D10' },
    usedPins: { 42: '麦克风 PDM 时钟', 41: '麦克风 PDM 数据', 21: 'SD 卡片选' },
    boardSleepUA: 60,
    battery: true,
    caveats: ['摄像头长时间工作发热明显，需要散热', '扩展板占用多数引脚，剩余 GPIO 很少'],
  },
  {
    id: 'c6-devkitc',
    name: 'ESP32-C6-DevKitC-1',
    chip: 'esp32c6',
    maker: '乐鑫官方',
    priceCNY: [45, 70],
    flashMB: 8,
    psramMB: 0,
    size: '26 × 51mm',
    extras: ['WS2812 RGB 灯（GPIO8）'],
    usedPins: { 8: '板载 RGB 灯', 9: 'BOOT 键' },
    boardSleepUA: 1000,
    battery: false,
    caveats: ['开发板供电电路没做低功耗，量功耗请用模组或 XIAO 类小板'],
  },
  {
    id: 'xiao-c6',
    name: 'Seeed XIAO ESP32C6',
    chip: 'esp32c6',
    maker: 'Seeed Studio',
    priceCNY: [40, 55],
    flashMB: 4,
    psramMB: 0,
    size: '21 × 17.8mm',
    extras: ['锂电池充电管理', '板载和外接天线可切换'],
    i2cPins: [22, 23],
    exposed: [0, 1, 2, 21, 22, 23, 16, 17, 19, 20, 18],
    labels: { 0: 'D0', 1: 'D1', 2: 'D2', 21: 'D3', 22: 'D4', 23: 'D5', 16: 'D6', 17: 'D7', 19: 'D8', 20: 'D9', 18: 'D10' },
    usedPins: {},
    boardSleepUA: 15,
    battery: true,
    caveats: [],
  },
  {
    id: 'esp32-devkitc',
    name: 'ESP32-DevKitC（WROOM-32）',
    chip: 'esp32',
    maker: '乐鑫官方 / 兼容板',
    priceCNY: [20, 45],
    flashMB: 4,
    psramMB: 0,
    size: '28 × 55mm',
    extras: ['USB-UART（CP2102 / CH340）'],
    usedPins: { 0: 'BOOT 键' },
    boardSleepUA: 6000,
    battery: false,
    caveats: ['micro-USB 口的老款板子很多，买 Type-C 版本', '深睡整板电流可达数毫安'],
  },
];

export interface Part {
  id: string;
  name: string;
  /** 卡片 / 按钮上的短名（选型助手 v2 的模板卡副标题） */
  short: string;
  priceCNY: [number, number];
  /** 需要的接口：引脚需求 */
  needs: { kind: 'gpio' | 'adc' | 'pwm' | 'i2c' | 'spi' | 'i2s' | 'rmt' | 'uart' | 'usb' | 'camera'; count?: number; label: string }[];
  caps?: Cap[];
  /** 额外功耗（mA），工作时 */
  activeMA?: number;
  simulated: 'full' | 'partial' | 'none';
}

export const PARTS: Record<string, Part> = {
  led: { id: 'led', short: 'LED', name: '5mm LED 和 220Ω 电阻', priceCNY: [0.1, 0.5], needs: [{ kind: 'pwm', label: 'LED' }], simulated: 'full' },
  button: { id: 'button', short: '按键', name: '轻触按键', priceCNY: [0.1, 0.5], needs: [{ kind: 'gpio', label: '按键' }], simulated: 'full' },
  pot: { id: 'pot', short: '电位器', name: '10kΩ 电位器', priceCNY: [0.5, 2], needs: [{ kind: 'adc', label: '电位器' }], simulated: 'full' },
  servo: { id: 'servo', short: '舵机', name: 'SG90 舵机', priceCNY: [4, 10], needs: [{ kind: 'pwm', label: '舵机信号' }], activeMA: 150, simulated: 'full' },
  ws2812: { id: 'ws2812', short: 'WS2812B', name: 'WS2812B 灯带（每米 60 灯）', priceCNY: [12, 30], needs: [{ kind: 'rmt', label: '灯带数据' }], activeMA: 1200, simulated: 'full' },
  oled: { id: 'oled', short: 'OLED', name: '0.96 寸 OLED（SSD1306，I2C）', priceCNY: [8, 15], needs: [{ kind: 'i2c', label: 'OLED' }], activeMA: 15, simulated: 'partial' },
  bme280: { id: 'bme280', short: 'BME280', name: 'BME280 温湿度气压模块', priceCNY: [10, 25], needs: [{ kind: 'i2c', label: 'BME280' }], activeMA: 1, simulated: 'partial' },
  tft: { id: 'tft', short: '彩屏', name: '1.69–2.4 寸 SPI 彩屏（ST7789 / ILI9341）', priceCNY: [15, 40], needs: [{ kind: 'spi', label: '屏幕' }, { kind: 'gpio', count: 3, label: '屏幕 DC / RST / 背光' }], activeMA: 40, caps: ['display_spi'], simulated: 'none' },
  mic: { id: 'mic', short: '麦克风', name: 'INMP441 数字麦克风（I2S）', priceCNY: [8, 15], needs: [{ kind: 'i2s', label: '麦克风' }], caps: ['audio_in'], simulated: 'none' },
  amp: { id: 'amp', short: '功放', name: 'MAX98357A 功放和 3W 小喇叭', priceCNY: [10, 20], needs: [{ kind: 'i2s', label: '功放' }], activeMA: 300, caps: ['audio_out'], simulated: 'none' },
  relay: { id: 'relay', short: '继电器', name: '5V 继电器模块（光耦隔离）', priceCNY: [3, 8], needs: [{ kind: 'gpio', label: '继电器' }], activeMA: 70, simulated: 'full' },
  pir: { id: 'pir', short: '人体红外', name: 'HC-SR501 人体红外', priceCNY: [3, 8], needs: [{ kind: 'gpio', label: '人体感应' }], simulated: 'full' },
  battery: { id: 'battery', short: '锂电池', name: '3.7V 锂电池 1000mAh', priceCNY: [10, 20], needs: [], simulated: 'none' },
  camera: { id: 'camera', short: 'OV2640', name: 'OV2640 摄像头', priceCNY: [15, 30], needs: [{ kind: 'camera', label: '摄像头 DVP' }], caps: ['camera', 'psram'], activeMA: 120, simulated: 'none' },
};

export interface Template {
  id: string;
  title: string;
  /** 手机底部按钮上的短名（"看推荐 · 温湿度计 + 2 个要求"） */
  short: string;
  emoji: string;
  blurb: string;
  needCaps: Cap[];
  niceCaps?: Cap[];
  parts: string[];
  /** 工作模式，用于功耗估算：每小时唤醒次数、每次工作秒数、是否联网 */
  duty?: { wakePerHour: number; activeSec: number; wifi: boolean };
  /** 能在试板里跑的示例固件（web/public/fw/examples.json 的 id，C3 和 S3 的都列；界面按推荐芯片挑） */
  examples: string[];
  /** 对应的完整作品（app/works.ts 的 id）：从选型结果直接进它的采购页 */
  work?: string;
  risks: string[];
}

export const TEMPLATES: Template[] = [
  {
    id: 'blink',
    short: '点灯入门',
    title: '第一次玩：点灯、按键、串口',
    emoji: '💡',
    blurb: '学单片机的起点，几乎任何板子都行，挑便宜、教程多的。',
    needCaps: [],
    parts: ['led', 'button', 'pot'],
    examples: ['blink', 'button', 'fade', 'pot', 's3-blink', 's3-pot'],
    risks: [],
  },
  {
    id: 'weather',
    short: '温湿度计',
    title: '电池供电的温湿度计',
    emoji: '🌡️',
    blurb: '每 10 分钟醒来测一次、上报一次，其余时间深睡。关键是整板深睡电流。',
    needCaps: ['wifi', 'low_power'],
    parts: ['bme280', 'oled', 'battery'],
    duty: { wakePerHour: 6, activeSec: 3, wifi: true },
    examples: ['bme280', 'oled', 'weather', 's3-oled'],
    work: 'weather',
    risks: ['开发板的电源灯、LDO、USB 转串口芯片会吃掉大部分电量。选专为电池设计的小板，或自己画板', 'Wi-Fi 连接耗时决定功耗：用静态 IP、记住信道能把每次唤醒从 3 秒压到 1 秒内'],
  },
  {
    id: 'lights',
    short: '氛围灯',
    title: '氛围灯、灯带控制器',
    emoji: '🌈',
    blurb: 'WS2812 灯带，用手机网页控制，WLED 一类固件直接能用。',
    needCaps: ['wifi'],
    parts: ['ws2812', 'button'],
    examples: ['rgb', 's3-rgb', 'lamp'],
    work: 'lamp',
    risks: ['60 灯 / 米全白约 3.6A / 米，电源要单独供，不能靠开发板的 USB', '3.3V 数据线驱动 5V 灯带偶尔不稳，必要时加电平转换'],
  },
  {
    id: 'smarthome',
    short: '智能家居',
    title: 'Matter / Home Assistant 智能家居',
    emoji: '🏠',
    blurb: '接入米家以外的生态（Apple Home / Google / HA）。要 Thread 或 Zigbee 就只能选 C6 / H2。',
    needCaps: ['wifi'],
    niceCaps: ['thread', 'zigbee', 'wifi6'],
    parts: ['relay', 'pir', 'button'],
    examples: ['button', 'wifi-http', 's3-wifi-http'],
    risks: ['继电器控制 220V 要用带光耦隔离的模块，断电后再接线；强电部分模拟器验证不了'],
  },
  {
    id: 'usbkey',
    short: 'USB 宏键盘',
    title: 'USB 宏键盘、插手机的小设备',
    emoji: '⌨️',
    blurb: '让板子冒充键盘、鼠标或网卡。只有带原生 USB OTG 的型号能做。',
    needCaps: ['usb_otg'],
    parts: ['button'],
    examples: ['usbkey', 's3-usb-keyboard'],
    work: 'usbkey',
    risks: ['确认插的是芯片原生 USB 口，而不是 USB 转串口那个口', 'iPhone 等设备对 USB 设备供电有限，复杂外设需要外部供电'],
  },
  {
    id: 'voice',
    short: '语音助手',
    title: 'AI 语音助手（小智类）',
    emoji: '🗣️',
    blurb: '麦克风收音、联网调大模型、喇叭播放，带个圆屏当表情。主流方案都是 S3 + 8MB PSRAM。',
    needCaps: ['wifi', 'audio_in', 'audio_out', 'psram'],
    niceCaps: ['display_spi', 'ai_accel'],
    parts: ['mic', 'amp', 'tft', 'battery'],
    examples: ['s3-i2s-mic', 's3-i2s-tone'],
    risks: ['大模型 API 要联网和账号；离线唤醒词才在板上跑', '功放和 Wi-Fi 同时工作时峰值电流大，锂电池要能放 1A 以上'],
  },
  {
    id: 'camera',
    short: '摄像头',
    title: '摄像头监控、看宠物',
    emoji: '📷',
    blurb: 'OV2640 拍照或推流，需要 PSRAM 存帧。XIAO S3 Sense 开箱即用。',
    needCaps: ['wifi', 'camera', 'psram'],
    parts: ['camera'],
    examples: [],
    risks: ['持续推流发热和耗电都大，不适合电池长期供电', '画质只到 200 万像素，别期待监控摄像头的效果'],
  },
  {
    id: 'btaudio',
    short: '蓝牙音箱',
    title: '蓝牙音箱、经典蓝牙串口',
    emoji: '🔊',
    blurb: 'A2DP 音频要经典蓝牙，只有经典款 ESP32 有。',
    needCaps: ['bt_classic', 'audio_out'],
    parts: ['amp'],
    examples: [],
    risks: [],
  },
];
