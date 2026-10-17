// 元件库：采购页、规则引擎、"买完摆上实验台"共用的纯数据。
// 原则（docs/PLAN.md P0-06、docs/RESEARCH_PROCURE.md §1）：
// - 电气数值来自数据手册；拿不准的写 null，并把字段名写进 todo（schema 测试强制）
// - 估算值 currentMa.est = true，并在 currentMa.source 写依据
// - 价格是人工参考区间，不抓取网站；price.verified = false 表示还没人逐条核过
// - 外链只用搜索页（淘宝 / 立创商城），不放店铺、不放联盟链接（docs/LICENSING.md）

export type ChipId = 'esp32c3' | 'esp32s3';

export type Kind =
  | 'board'
  | 'sensor'
  | 'display'
  | 'actuator'
  | 'input'
  | 'audio'
  | 'power'
  | 'cable'
  | 'passive'
  | 'module'
  | 'proto'
  | 'enclosure';

export type PinType =
  | 'power'
  | 'gnd'
  | 'io'
  | 'rst'
  | 'en'
  | 'i2c-sda'
  | 'i2c-scl'
  | 'spi-sclk'
  | 'spi-mosi'
  | 'spi-miso'
  | 'spi-cs'
  | 'spi-dc'
  | 'backlight'
  | 'pwm'
  | 'analog'
  | 'onewire'
  | 'ws2812-din'
  | 'ws2812-dout'
  | 'i2s-bclk'
  | 'i2s-ws'
  | 'i2s-data'
  | 'digital-in'
  | 'digital-out'
  | 'addr'
  | 'passive'
  | 'nc';

export interface Pin {
  /** 丝印 / 线色 */
  label: string;
  type: PinType;
  /** 这根线上的电平（V）：数字 = 固定；'vcc' = 跟随模块供电；null = 不适用或由外部决定 */
  v: number | 'vcc' | null;
  /** 开发板引脚对应的 GPIO */
  gpio?: number;
  /** 从模块角度看的方向：out = 模块往外输出（会把电平送进 GPIO） */
  dir?: 'in' | 'out' | 'bi';
  /** 模块在这根线上自带的上 / 下拉，或上电时主动输出的电平（strapping 规则 R05–R08 用） */
  boot?: 'pull-up' | 'pull-down' | 'drive-low' | 'drive-high';
  /** 直接接 GPIO 时要从引脚拉的电流（mA），R22 用 */
  loadMa?: number;
  note?: string;
}

export type OnboardKind = 'rgb' | 'led' | 'boot' | 'button' | 'lcd' | 'imu' | 'touch' | 'ir' | 'adc' | 'other';
export type BusRole = 'spi-sclk' | 'spi-mosi' | 'spi-miso' | 'i2c-sda' | 'i2c-scl';

export interface Onboard {
  gpio: number;
  what: string;
  kind: OnboardKind;
  /** 这根线是可以共用的总线（外接件同一角色的引脚接上来只算提醒；其它用法判阻断） */
  share?: BusRole;
}

/** 屏的控制线（R32 比较板子与固件） */
export interface LcdPins {
  sclk: number;
  mosi: number;
  cs: number;
  dc: number;
  rst: number;
  bl: number;
}

export interface BoardInfo {
  chip: ChipId;
  /** 同一型号的硬件版本（DevKitC-1 v1.0 / v1.1 彩灯脚不同，R23） */
  family?: string;
  version?: string;
  flashMB: number | null;
  psramMB: number | null;
  /** 八线 PSRAM 占 GPIO33–37（R03）；null = 待核 */
  psram: 'none' | 'quad' | 'octal' | null;
  /** 板载占用：kind=boot 的 BOOT 键交给 strapping 规则，其它交给 R24（lcd / imu / touch 的独占线判阻断） */
  onboard: Onboard[];
  /** 板上已经焊了、和元件库某个件等价的器件（R29：再外接一份是重复购买 / 抢引脚） */
  builtin?: { partId: string; what: string }[];
  /** 板载屏的引脚（R32：同一款板不同版本屏脚不同，固件按另一版写会黑屏） */
  lcd?: LcdPins;
  /** 资料来源 URL（官方用户指南 / wiki / 原理图优先） */
  urls: string[];
  /** 板载 WS2812 所在 GPIO；没有为 null */
  rgbGpio: number | null;
  /** 板载 3.3 V 稳压器（R21） */
  ldo: { model: string | null; maxMa: number | null };
  /** USB 口：native = 只有芯片原生 USB；uart = 只有 USB 转串口；both = 两个口 */
  usb: 'native' | 'uart' | 'both' | null;
  /** 板上有锂电充电（R27） */
  charger: boolean;
}

export interface Price {
  lo: number;
  hi: number;
  currency: 'CNY';
  /** 核价年月 YYYY-MM */
  checkedAt: string;
  source: string;
  /** 是否已由人逐条核过（代理估计的区间为 false） */
  verified: boolean;
}

export type SimLevel = 'verified' | 'estimated' | 'none';

export interface Part {
  id: string;
  name: string;
  kind: Kind;
  model: string;
  /** 适配芯片（模块对两颗芯片都能用就两个都写） */
  chips: ChipId[];
  pins: Pin[] | null;
  voltage: { supply: [number, number] | null; logic: number | null };
  currentMa: { typ: number | null; peak: number | null; est: boolean; source: string };
  i2cAddr: { default: number; alt: number[]; how?: string } | null;
  /** 模块板载 I2C 上拉（kΩ）；null = 待核 / 不适用（R16 按 4.7 kΩ 估） */
  i2cPullupK?: number | null;
  /** 长 × 宽 × 高（mm），高未知为 null */
  sizeMm: [number, number, number | null] | null;
  /** 模拟程度：verified = 有验收固件跑过的模型；estimated = 行为近似 / 只进估算；none = 没有模型 */
  sim: { level: SimLevel; model: string | null };
  price: Price;
  /** 外链搜索关键词（规格要点） */
  keywords: string;
  searchUrl: { taobao: string; szlcsc: string };
  /** 没给接线时默认接哪路电 */
  supplyNet?: '3V3' | '5V' | 'EXT5V' | 'BAT';
  /** 这个件对外提供一路电（外接电源、稳压模块） */
  provides?: { net: 'EXT5V' | 'EXT3V3'; maxMa: number };
  /** 必须同时买的配件（R27） */
  requires?: { partId: string; why: string }[];
  /** 金属件 / 电池，放天线旁会挡信号（R26） */
  rfBlocker?: boolean;
  board?: BoardInfo;
  sources: string[];
  /** 待核字段（字段名 + 说明）；值为 null 的字段必须出现在这里或 na 里 */
  todo: string[];
  /** 不适用的字段（如线材没有供电电压）：值为 null 是因为没有意义，不是缺数据 */
  na?: string[];
  note: string;
}

export const CHECKED_AT = '2026-10';
const PRICE_SRC = '按淘宝常见售价估计，未逐条核价，不含运费';

export const searchUrls = (kw: string) => ({
  taobao: 'https://s.taobao.com/search?q=' + encodeURIComponent(kw),
  szlcsc: 'https://so.szlcsc.com/global.html?k=' + encodeURIComponent(kw),
});

type Draft = Omit<Part, 'price' | 'searchUrl' | 'todo' | 'sources' | 'chips' | 'i2cAddr' | 'sim'> & {
  price: [number, number];
  chips?: ChipId[];
  i2cAddr?: Part['i2cAddr'];
  sim?: Part['sim'];
  todo?: string[];
  sources?: string[];
};

const BOTH: ChipId[] = ['esp32c3', 'esp32s3'];

function P(d: Draft): Part {
  return {
    ...d,
    chips: d.chips ?? BOTH,
    i2cAddr: d.i2cAddr ?? null,
    sim: d.sim ?? { level: 'none', model: null },
    price: { lo: d.price[0], hi: d.price[1], currency: 'CNY', checkedAt: CHECKED_AT, source: PRICE_SRC, verified: false },
    searchUrl: searchUrls(d.keywords),
    sources: d.sources ?? [],
    todo: d.todo ?? [],
  };
}

const pin = (label: string, type: PinType, v: Pin['v'], extra: Partial<Pin> = {}): Pin => ({ label, type, v, ...extra });
const VCC = (label = 'VCC') => pin(label, 'power', 'vcc');
const GND = (label = 'GND') => pin(label, 'gnd', 0);

/** 开发板排针：数字 = GPIO，其余是电源 / 地 / 复位丝印 */
function header(list: (number | string)[], names: Record<number, string> = {}): Pin[] {
  return list.map((x) => {
    if (typeof x === 'number') return pin(names[x] ?? `GPIO${x}`, 'io', 3.3, { gpio: x, dir: 'bi' });
    if (x === 'GND' || x === 'G') return GND('GND');
    if (x === '3V3') return pin('3V3', 'power', 3.3);
    if (x === '5V' || x === 'VBUS' || x === 'VSYS') return pin(x, 'power', 5);
    if (x === 'RST' || x === 'EN') return pin(x, 'rst', 3.3);
    return pin(x, 'nc', null);
  });
}

// ESP32-S3-DevKitC-1 用户指南 v1.0 / v1.1 的 J1 / J3 排针（两版排针相同，差在板载彩灯）
const S3_DEVKITC_PINS = header(
  ['3V3', '3V3', 'RST', 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11, 12, 13, 14, '5V', 'G',
   'G', 43, 44, 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0, 45, 48, 47, 21, 20, 19, 'G', 'G'],
  { 43: 'TX(GPIO43)', 44: 'RX(GPIO44)' },
);
// ESP32-C3-DevKitM-1 用户指南 J1 / J3
const C3_DEVKITM_PINS = header(
  ['G', '3V3', '3V3', 2, 3, 'G', 'RST', 'G', 0, 1, 10, 'G', '5V', '5V', 'G',
   'G', 21, 20, 'G', 9, 8, 'G', 7, 6, 5, 4, 'G', 18, 19, 'G'],
  { 21: 'TX(GPIO21)', 20: 'RX(GPIO20)' },
);
// Seeed XIAO：D0–D10 + 5V / GND / 3V3（Seeed Wiki 引脚表；与 arduino-esp32 variants 一致）
const xiaoPins = (gpios: number[]) => [
  ...gpios.map((g, i) => pin(`D${i}(GPIO${g})`, 'io', 3.3, { gpio: g, dir: 'bi' })),
  pin('5V', 'power', 5),
  GND(),
  pin('3V3', 'power', 3.3),
];

const BOARD_CURRENT_NOTE = '整板电流在规则里按芯片数据手册估算，这里不单列';

export const PARTS: Part[] = [
  // ───────── 开发板 ─────────
  // 每块板的来源 URL 在 board.urls；查不到或几处资料互相矛盾的字段写进 todo（P1-12）
  P({
    id: 's3-devkitc1-v10',
    name: 'ESP32-S3-DevKitC-1 v1.0（N16R8）',
    kind: 'board',
    model: 'ESP32-S3-DevKitC-1-N16R8 v1.0（模组 ESP32-S3-WROOM-1-N16R8）',
    chips: ['esp32s3'],
    pins: S3_DEVKITC_PINS,
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: null,
    sim: { level: 'verified', model: 's3-devkitc' },
    price: [35, 70],
    keywords: 'ESP32-S3-DevKitC-1 N16R8 开发板',
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'devkitc1', version: 'v1.0', flashMB: 16, psramMB: 8, psram: 'octal',
      onboard: [{ gpio: 48, what: '板载 WS2812 彩灯', kind: 'rgb' }, { gpio: 0, what: 'BOOT 键', kind: 'boot' }],
      rgbGpio: 48, ldo: { model: null, maxMa: null }, usb: 'both', charger: false,
      urls: ['https://docs.espressif.com/projects/esp-dev-kits/zh_CN/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.0.html'],
    },
    sources: ['乐鑫 ESP32-S3-DevKitC-1 用户指南（v1.0 / v1.1 引脚表、彩灯 GPIO）', 'ESP32-S3-WROOM-1 数据手册（N16R8 = 16 MB flash + 8 MB 八线 PSRAM）'],
    todo: ['sizeMm：advisor/data.ts 写 26×63 mm，未见出处', 'board.ldo：稳压器型号与额定电流按原理图录入', 'currentMa：整板静态电流未测', 'model：内存配置以实物丝印为准（市售多为 N16R8，乐鑫官方订购表待核）'],
    note: '彩灯在 GPIO48（v1.1 改到 GPIO38，看板背丝印）。八线 PSRAM 占 GPIO33–37。两个 Type-C：UART 口和原生 USB 口。',
  }),
  P({
    id: 's3-devkitc1-v11',
    name: 'ESP32-S3-DevKitC-1 v1.1（N16R8）',
    kind: 'board',
    model: 'ESP32-S3-DevKitC-1-N16R8 v1.1（模组 ESP32-S3-WROOM-1-N16R8）',
    chips: ['esp32s3'],
    pins: S3_DEVKITC_PINS,
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: null,
    sim: { level: 'estimated', model: 's3-devkitc' },
    price: [35, 70],
    keywords: 'ESP32-S3-DevKitC-1 v1.1 N16R8',
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'devkitc1', version: 'v1.1', flashMB: 16, psramMB: 8, psram: 'octal',
      onboard: [{ gpio: 38, what: '板载 WS2812 彩灯', kind: 'rgb' }, { gpio: 0, what: 'BOOT 键', kind: 'boot' }],
      rgbGpio: 38, ldo: { model: null, maxMa: null }, usb: 'both', charger: false,
      urls: ['https://docs.espressif.com/projects/esp-dev-kits/zh_CN/latest/esp32s3/esp32-s3-devkitc-1/user_guide.html'],
    },
    sources: ['乐鑫 ESP32-S3-DevKitC-1 用户指南 v1.1（彩灯改为 GPIO38）'],
    todo: ['sizeMm：同 v1.0', 'board.ldo：稳压器型号与额定电流按原理图录入', 'currentMa：整板静态电流未测'],
    note: '与 v1.0 只差彩灯引脚：v1.1 在 GPIO38。模拟器的 3D 板和验收固件按 v1.0（GPIO48），所以这块板只算行为模拟。',
  }),
  P({
    id: 'luat-s3',
    name: '合宙 ESP32-S3 核心板',
    kind: 'board',
    model: '合宙 ESP32S3-Luatos-Core（内存配置待核）',
    chips: ['esp32s3'],
    pins: null,
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: null,
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [25, 45],
    keywords: '合宙 ESP32S3 核心板',
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'luat-core', flashMB: 8, psramMB: null, psram: null,
      onboard: [
        { gpio: 10, what: '板载 LED A（高电平亮）', kind: 'led' },
        { gpio: 11, what: '板载 LED B（高电平亮）', kind: 'led' },
        { gpio: 0, what: 'BOOT 键', kind: 'boot' },
      ],
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: null, charger: false,
      urls: [
        'https://wiki.luatos.com/chips/esp32s3/board.html',
        'https://github.com/zephyrproject-rtos/zephyr/tree/main/boards/luatos/esp32s3_luatos_core',
        'https://docs.zephyrproject.org/latest/boards/luatos/esp32s3_luatos_core/doc/index.html',
      ],
    },
    sources: [
      'Zephyr esp32s3_luatos_core.dtsi（Apache-2.0）：LED GPIO10 / GPIO11 高电平亮、BOOT GPIO0、flash 8 MB',
      '合宙 wiki（wiki.luatos.com，2026-10 抓取失败，未取得原理图授权，只录事实）',
    ],
    todo: [
      'pins：排针表未录入（合宙 wiki 本次打不开，Zephyr 只有引脚图片）',
      'board.flashMB：Zephyr 写 8 MB，Zephyr 页面另一版本与卖家常见 16 MB 说法不一致，以丝印为准',
      'board.psramMB：Zephyr 页面称 8 MB PSRAM，未见合宙原文',
      'board.psram：是否八线 PSRAM 待核（规则检查按「待核」给提醒）',
      'board.onboard：Zephyr 文档另提到「可寻址彩灯 GPIO38」，与 dtsi 只有两颗普通 LED 矛盾，待原理图核',
      'board.usb：USB 口类型（原生 / CH343 转串口）未核',
      'board.ldo',
      'sizeMm',
      'currentMa',
    ],
    note: '便宜、玩家多。板载两颗 LED 在 GPIO10 / 11（接外设会跟着亮）。不同批次内存配置不同，买前看清 flash / PSRAM 字样；若是 R8（八线 PSRAM）同样不能用 GPIO33–37。',
  }),
  P({
    id: 'xiao-s3',
    name: 'Seeed XIAO ESP32S3',
    kind: 'board',
    model: 'XIAO ESP32S3（8 MB flash，8 MB 八线 PSRAM）',
    chips: ['esp32s3'],
    pins: xiaoPins([1, 2, 3, 4, 5, 6, 43, 44, 7, 8, 9]),
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: [21, 17.8, null],
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [50, 75],
    keywords: 'Seeed XIAO ESP32S3',
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'xiao', flashMB: 8, psramMB: 8, psram: 'octal',
      onboard: [{ gpio: 21, what: '用户 LED（低电平亮）', kind: 'led' }, { gpio: 0, what: 'BOOT 键', kind: 'boot' }],
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'native', charger: true,
      urls: ['https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/', 'https://github.com/platformio/platform-espressif32/blob/develop/boards/seeed_xiao_esp32s3.json'],
    },
    sources: ['Seeed Wiki XIAO ESP32S3 引脚表（只录事实，Wiki 源码 GPL-3.0 不搬）', 'PlatformIO seeed_xiao_esp32s3.json：memory_type qio_opi（八线 PSRAM）'],
    todo: ['board.ldo：稳压器额定电流未核', 'currentMa', 'sizeMm[2]：板厚（含元件）未核', 'board.psram：Seeed Wiki 只写 8 MB，八线来自 PlatformIO qio_opi'],
    note: '只引出 11 个 GPIO，D0–D10 对应 GPIO1–9、43、44；GPIO21 接了板载用户 LED；D2（GPIO3）是 strapping 脚，默认 eFuse 下不影响启动；D6 / D7 是 UART0；背面有锂电焊盘和充电电路。',
  }),
  P({
    id: 'c3-devkitm1',
    name: 'ESP32-C3-DevKitM-1',
    kind: 'board',
    model: 'ESP32-C3-DevKitM-1（模组 ESP32-C3-MINI-1，4 MB 内置 flash）',
    chips: ['esp32c3'],
    pins: C3_DEVKITM_PINS,
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: null,
    sim: { level: 'verified', model: 'c3-devkitm' },
    price: [40, 60],
    keywords: 'ESP32-C3-DevKitM-1 开发板',
    supplyNet: '5V',
    board: {
      chip: 'esp32c3', family: 'devkitm1', flashMB: 4, psramMB: 0, psram: 'none',
      onboard: [{ gpio: 8, what: '板载 WS2812 彩灯', kind: 'rgb' }, { gpio: 9, what: 'BOOT 键', kind: 'boot' }],
      rgbGpio: 8, ldo: { model: null, maxMa: null }, usb: 'uart', charger: false,
      urls: ['https://docs.espressif.com/projects/esp-dev-kits/zh_CN/latest/esp32c3/esp32-c3-devkitm-1/user_guide.html'],
    },
    sources: ['乐鑫 ESP32-C3-DevKitM-1 用户指南（J1 / J3 引脚表、彩灯 GPIO8、BOOT GPIO9）'],
    todo: ['pins：排针顺序按用户指南手录，待脚本对 arduino-esp32 variants 核对', 'board.usb：USB 口是否只有 USB-UART 待核', 'board.ldo', 'sizeMm', 'currentMa'],
    note: 'GPIO8 接彩灯、GPIO9 是 BOOT，两个都是 strapping 脚，外设尽量别接。',
  }),
  P({
    id: 'xiao-c3',
    name: 'Seeed XIAO ESP32C3',
    kind: 'board',
    model: 'XIAO ESP32C3（4 MB flash，无 PSRAM）',
    chips: ['esp32c3'],
    pins: xiaoPins([2, 3, 4, 5, 6, 7, 21, 20, 8, 9, 10]),
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: [21, 17.8, null],
    sim: { level: 'estimated', model: 'esp32c3' },
    price: [35, 50],
    keywords: 'Seeed XIAO ESP32C3',
    supplyNet: '5V',
    board: {
      chip: 'esp32c3', family: 'xiao', flashMB: 4, psramMB: 0, psram: 'none',
      onboard: [{ gpio: 9, what: 'BOOT 键', kind: 'boot' }],
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'native', charger: true,
      urls: ['https://wiki.seeedstudio.com/XIAO_ESP32C3_Getting_Started/'],
    },
    sources: ['Seeed Wiki XIAO ESP32C3 引脚表（D0 / D8 / D9 = GPIO2 / 8 / 9 标为 strapping；无 LED_BUILTIN）', 'arduino-esp32 variants/XIAO_ESP32C3（读来核对，不复制）'],
    todo: ['board.ldo：Seeed Wiki 电源脚一节写 3V3 可取 700 mA、规格表写 500 mA，互相矛盾', 'currentMa', 'sizeMm[2]：板厚（含元件）未核'],
    note: 'D0、D8、D9 对应 GPIO2、8、9，全是 strapping 脚，是典型的坑；D9 同时是 BOOT 键。D6 / D7 是 UART0。没有 PSRAM、没有用户 LED。',
  }),
  P({
    id: 'm5-atoms3',
    name: 'M5Stack AtomS3',
    kind: 'board',
    model: 'M5Stack AtomS3（ESP32-S3FN8：8 MB 片内 flash，无 PSRAM；0.85″ 128×128 屏）',
    chips: ['esp32s3'],
    // 底部排针 G5 / G6 / G7 / G8 / G38 / G39 + HY2.0-4P（Grove）口 G1 / G2
    pins: [...header(['5V', 'G', '3V3', 5, 6, 7, 8, 38, 39]), pin('Grove 白(G1)', 'io', 3.3, { gpio: 1, dir: 'bi' }), pin('Grove 黄(G2)', 'io', 3.3, { gpio: 2, dir: 'bi' })],
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: [24, 24, 13],
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [85, 120],
    keywords: 'M5Stack AtomS3 ESP32-S3 带屏',
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'm5-atoms3', flashMB: 8, psramMB: 0, psram: 'none',
      onboard: [
        { gpio: 21, what: '板载屏 MOSI', kind: 'lcd', share: 'spi-mosi' },
        { gpio: 17, what: '板载屏 SCK', kind: 'lcd', share: 'spi-sclk' },
        { gpio: 15, what: '板载屏 CS', kind: 'lcd' },
        { gpio: 33, what: '板载屏 DC(RS)', kind: 'lcd' },
        { gpio: 34, what: '板载屏 RST', kind: 'lcd' },
        { gpio: 16, what: '板载屏背光', kind: 'lcd' },
        { gpio: 38, what: '板载 IMU MPU6886 的 SDA（0x68，与底部排针共用总线）', kind: 'imu', share: 'i2c-sda' },
        { gpio: 39, what: '板载 IMU MPU6886 的 SCL', kind: 'imu', share: 'i2c-scl' },
        { gpio: 41, what: '屏下按键（低电平按下）', kind: 'button' },
        { gpio: 4, what: '红外发射管', kind: 'ir' },
      ],
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'native', charger: false,
      urls: ['https://docs.m5stack.com/zh_CN/core/AtomS3', 'https://github.com/m5stack/M5Unified'],
    },
    sources: ['M5Stack 文档 AtomS3（屏 GC9107 引脚、IMU MPU6886 0x68 on G38/G39、排针 G5–G8 / G38 / G39、Grove G1 / G2）', 'M5Unified（MIT）：按键 GPIO41 低电平按下', 'ESP32-S3 数据手册订购信息：S3FN8 = 8 MB 片内 flash、无 PSRAM'],
    todo: [
      'board.onboard：红外发射 GPIO4 来自 AtomS3 Lite 资料，完整版 AtomS3 原理图待核',
      'board.usb：M5 文档只写「Type-C 供电与下载」，未写是否原生 USB（Arduino 配置 USB_CDC_ON_BOOT=1 倾向原生），待原理图核',
      'board.ldo',
      'currentMa',
      'sizeMm：M5 官网 24×24×13 mm，未逐项核实',
    ],
    note: '自带外壳和 0.85″ 屏，但对外只有 8 个 GPIO（排针 6 个 + Grove 2 个），其中 G38 / G39 还和板载 IMU 共用 I2C。接多个模块很快就不够用。',
  }),
  P({
    id: 'ws-s3-lcd128',
    name: '微雪 ESP32-S3-LCD-1.28 圆屏板（无触摸）',
    kind: 'board',
    model: 'Waveshare ESP32-S3-LCD-1.28（ESP32-S3R2：2 MB 四线 PSRAM + 16 MB 外置 flash；板载 1.28″ GC9A01 圆屏、QMI8658 IMU）',
    chips: ['esp32s3'],
    // 两排 1.27 mm 排针 H1 / H2：按 NuttX 板级文档 GPIO 表（标明"以原理图为准"）
    pins: header(['VSYS', 'G', '3V3', 'RST', 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46]),
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: null,
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [70, 110],
    keywords: '微雪 ESP32-S3-LCD-1.28 圆屏',
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'ws-lcd128', version: '无触摸', flashMB: 16, psramMB: 2, psram: 'quad',
      onboard: [
        { gpio: 10, what: '板载圆屏 SCLK', kind: 'lcd', share: 'spi-sclk' },
        { gpio: 11, what: '板载圆屏 MOSI', kind: 'lcd', share: 'spi-mosi' },
        { gpio: 9, what: '板载圆屏 CS', kind: 'lcd' },
        { gpio: 8, what: '板载圆屏 DC', kind: 'lcd' },
        { gpio: 12, what: '板载圆屏 RST', kind: 'lcd' },
        { gpio: 40, what: '板载圆屏背光', kind: 'lcd' },
        { gpio: 6, what: '板载 IMU QMI8658 的 SDA', kind: 'imu', share: 'i2c-sda' },
        { gpio: 7, what: '板载 IMU QMI8658 的 SCL', kind: 'imu', share: 'i2c-scl' },
        { gpio: 47, what: '板载 IMU INT1', kind: 'imu' },
        { gpio: 48, what: '板载 IMU INT2', kind: 'imu' },
        { gpio: 1, what: '电池电压检测（200 k / 100 k 分压）', kind: 'adc' },
        { gpio: 0, what: 'BOOT 键', kind: 'boot' },
      ],
      builtin: [{ partId: 'gc9a01', what: '板载 1.28″ GC9A01 圆屏' }],
      lcd: { sclk: 10, mosi: 11, cs: 9, dc: 8, rst: 12, bl: 40 },
      rgbGpio: null, ldo: { model: 'ME6217C33M5G', maxMa: 800 }, usb: 'uart', charger: true,
      urls: [
        'https://www.waveshare.com/wiki/ESP32-S3-LCD-1.28',
        'https://nuttx.apache.org/docs/latest/platforms/xtensa/esp32s3/boards/esp32s3-ws-lcd128/index.html',
      ],
    },
    sources: ['微雪 wiki ESP32-S3-LCD-1.28（引脚表、ME6217C33M5G 800 mA、ETA6096 充电、CH343P 转串口、S3R2 + 16 MB flash）', 'NuttX esp32s3-ws-lcd128 板级文档（H1 / H2 排针与 GPIO 对应）'],
    todo: [
      'pins：排针按 NuttX 文档 GPIO 表录入，GPIO19 / 20 / 43 / 44 是否引出待对原理图',
      'board.onboard：微雪 wiki 引脚表同时列了 TP_INT GPIO5（无触摸版不该有），以原理图为准',
      'sizeMm',
      'currentMa',
    ],
    note: '「一板到位」：圆屏、IMU、锂电充电都在板上，不用再买 GC9A01。屏已占 GPIO8–12 与 GPIO40（触摸版屏复位改 GPIO14、背光改 GPIO2，两版固件不通用）。USB 是 CH343P 转串口。',
  }),
  P({
    id: 'ws-s3-touch-lcd128',
    name: '微雪 ESP32-S3-Touch-LCD-1.28 圆屏板（触摸）',
    kind: 'board',
    model: 'Waveshare ESP32-S3-Touch-LCD-1.28（ESP32-S3R2；GC9A01 圆屏、CST816S 触摸、QMI8658 IMU）',
    chips: ['esp32s3'],
    // 只有一个 SH1.0 接口 P2 引出 GPIO15–18 / 21 / 33
    pins: header(['VSYS', 'G', 'RST', 0, 15, 16, 17, 18, 21, 33]),
    voltage: { supply: [5, 5], logic: 3.3 },
    currentMa: { typ: null, peak: null, est: true, source: BOARD_CURRENT_NOTE },
    sizeMm: null,
    sim: { level: 'estimated', model: 'esp32s3' },
    price: [80, 120],
    keywords: '微雪 ESP32-S3-Touch-LCD-1.28 触摸圆屏',
    supplyNet: '5V',
    board: {
      chip: 'esp32s3', family: 'ws-lcd128', version: '触摸', flashMB: 16, psramMB: 2, psram: 'quad',
      onboard: [
        { gpio: 10, what: '板载圆屏 SCLK', kind: 'lcd', share: 'spi-sclk' },
        { gpio: 11, what: '板载圆屏 MOSI', kind: 'lcd', share: 'spi-mosi' },
        { gpio: 12, what: '板载圆屏 MISO', kind: 'lcd', share: 'spi-miso' },
        { gpio: 9, what: '板载圆屏 CS', kind: 'lcd' },
        { gpio: 8, what: '板载圆屏 DC', kind: 'lcd' },
        { gpio: 14, what: '板载圆屏 RST', kind: 'lcd' },
        { gpio: 2, what: '板载圆屏背光', kind: 'lcd' },
        { gpio: 6, what: '板载触摸 CST816S / IMU 的 SDA', kind: 'touch', share: 'i2c-sda' },
        { gpio: 7, what: '板载触摸 CST816S / IMU 的 SCL', kind: 'touch', share: 'i2c-scl' },
        { gpio: 5, what: '触摸中断 TP_INT', kind: 'touch' },
        { gpio: 13, what: '触摸复位 TP_RST', kind: 'touch' },
        { gpio: 4, what: 'IMU INT1', kind: 'imu' },
        { gpio: 3, what: 'IMU INT2', kind: 'imu' },
        { gpio: 1, what: '电池电压检测（200 k / 100 k 分压）', kind: 'adc' },
        { gpio: 0, what: 'BOOT 键', kind: 'boot' },
      ],
      builtin: [{ partId: 'gc9a01', what: '板载 1.28″ GC9A01 圆屏（带触摸）' }],
      lcd: { sclk: 10, mosi: 11, cs: 9, dc: 8, rst: 14, bl: 2 },
      rgbGpio: null, ldo: { model: null, maxMa: null }, usb: 'uart', charger: true,
      urls: [
        'https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-1.28',
        'https://nuttx.apache.org/docs/latest/platforms/xtensa/esp32s3/boards/esp32s3-ws-lcd128/index.html',
      ],
    },
    sources: ['微雪 wiki ESP32-S3-Touch-LCD-1.28（引脚表：屏 RST GPIO14、背光 GPIO2、TP_RST GPIO13、IMU INT 4 / 3）', 'NuttX esp32s3-ws-lcd128 板级文档（触摸版 P2 接口 GPIO15–18 / 21 / 33）'],
    todo: [
      'board.onboard：微雪 wiki 表另把 GPIO4 / 5 标成 MOSFET1_CS / MOSFET2_CS，与 IMU INT1 / TP_INT 重叠，待原理图核',
      'board.ldo：稳压器型号未在触摸版 wiki 找到（无触摸版是 ME6217C33M5G 800 mA）',
      'sizeMm',
      'currentMa',
    ],
    note: '和无触摸版同一款外形，但屏复位在 GPIO14、背光在 GPIO2（无触摸版是 GPIO12 / 40），固件要按版本改引脚。对外只有 SH1.0 接口上的 6 个 GPIO。',
  }),

  // ───────── 传感器 ─────────
  P({
    id: 'bme280',
    name: 'BME280 温湿度气压模块（3.3 V 版）',
    kind: 'sensor',
    model: 'Bosch BME280（GY-BME280 类模块）',
    pins: [VCC('VCC'), GND(), pin('SCL', 'i2c-scl', 'vcc', { dir: 'bi' }), pin('SDA', 'i2c-sda', 'vcc', { dir: 'bi' }), pin('CSB', 'spi-cs', 'vcc'), pin('SDO', 'addr', 'vcc', { note: '接地 0x76，接 VCC 0x77' })],
    voltage: { supply: [1.71, 3.6], logic: 3.3 },
    currentMa: { typ: 0.0036, peak: 0.714, est: false, source: 'BME280 数据手册：1 Hz 温湿压 3.6 µA；气压测量期间 714 µA' },
    i2cAddr: { default: 0x76, alt: [0x77], how: 'SDO 接 VCC 改 0x77' },
    i2cPullupK: null,
    sizeMm: null,
    sim: { level: 'verified', model: 'bme280' },
    price: [10, 25],
    keywords: 'BME280 模块 3.3V I2C 温湿度气压',
    supplyNet: '3V3',
    sources: ['Bosch BME280 数据手册（电气特性、I2C 地址）'],
    todo: ['i2cPullupK：模块板载上拉阻值随批次', 'sizeMm：模块外形随卖家'],
    note: '注意别买成 BMP280（没有湿度，芯片 ID 0x58 而不是 0x60）。5 V 版模块带稳压，3.3 V 版直接接芯片，只能接 3V3。',
  }),
  P({
    id: 'aht20',
    name: 'AHT20 温湿度模块',
    kind: 'sensor',
    model: 'Aosong AHT20',
    pins: [VCC(), GND(), pin('SCL', 'i2c-scl', 'vcc', { dir: 'bi' }), pin('SDA', 'i2c-sda', 'vcc', { dir: 'bi' })],
    voltage: { supply: [2.0, 5.5], logic: null },
    currentMa: { typ: null, peak: 0.98, est: true, source: '估算：AHT20 数据手册测量电流约 980 µA 量级（待逐字核对）' },
    i2cAddr: { default: 0x38, alt: [] },
    i2cPullupK: null,
    sizeMm: null,
    price: [3, 8],
    keywords: 'AHT20 温湿度传感器模块 I2C',
    supplyNet: '3V3',
    sources: ['Aosong AHT20 数据手册'],
    todo: ['currentMa：测量电流待核对原文，typ（平均）未列', 'voltage.logic：上拉接 VCC，电平随供电', 'i2cPullupK', 'sizeMm'],
    note: '地址固定 0x38 不能改。模块上拉接 VCC：接 5 V 供电时 SDA / SCL 是 5 V，要接 3V3。常见 AHT20 和 BMP280 的二合一板。',
  }),
  P({
    id: 'dht22',
    name: 'DHT22 温湿度模块（三针，带上拉）',
    kind: 'sensor',
    model: 'Aosong AM2302 / DHT22',
    pins: [VCC('+'), pin('OUT', 'onewire', 'vcc', { dir: 'bi', boot: 'pull-up' }), GND('-')],
    voltage: { supply: [3.3, 6], logic: null },
    currentMa: { typ: 1, peak: 1.5, est: false, source: 'AM2302 数据手册：测量 1–1.5 mA，待机 40–50 µA' },
    sizeMm: null,
    price: [12, 25],
    keywords: 'DHT22 AM2302 温湿度模块',
    supplyNet: '3V3',
    sources: ['Aosong AM2302 数据手册'],
    todo: ['voltage.logic：数据线上拉到 VCC，电平随供电', 'sizeMm'],
    note: '单总线私有协议，两次读之间至少 2 s。数据线上拉到模块 VCC：用 5 V 供电时数据线是 5 V。',
  }),
  P({
    id: 'ds18b20',
    name: 'DS18B20 防水温度探头（1 m）',
    kind: 'sensor',
    model: 'Maxim/ADI DS18B20',
    pins: [pin('红 VDD', 'power', 'vcc'), GND('黑 GND'), pin('黄 DQ', 'onewire', null, { dir: 'bi', note: '开漏，电平由外接 4.7 kΩ 上拉决定' })],
    voltage: { supply: [3.0, 5.5], logic: null },
    currentMa: { typ: 1, peak: 1.5, est: false, source: 'DS18B20 数据手册：转换时 1 mA（典型）/ 1.5 mA（最大），待机 750 nA' },
    sizeMm: null,
    price: [3, 10],
    keywords: 'DS18B20 防水探头 不锈钢',
    supplyNet: '3V3',
    requires: [{ partId: 'resistor-kit', why: 'DQ 要一颗 4.7 kΩ 上拉到 3V3，不接读不到' }],
    sources: ['DS18B20 数据手册'],
    todo: ['voltage.logic：开漏，由外接上拉决定', 'sizeMm：探头长度随卖家'],
    note: '上拉电阻接 3V3（不要接 5 V）。一条线可以挂多个，靠 64 位 ROM 码区分。',
  }),
  P({
    id: 'hc-sr04',
    name: 'HC-SR04 超声波测距（5 V）',
    kind: 'sensor',
    model: 'HC-SR04',
    pins: [pin('VCC', 'power', 5), pin('Trig', 'digital-in', null, { dir: 'in', note: '10 µs 高脉冲触发；3.3 V 通常能触发（TTL 门限），未经真机标定' }), pin('Echo', 'digital-out', 5, { dir: 'out', boot: 'drive-low' }), GND()],
    voltage: { supply: [5, 5], logic: 5 },
    currentMa: { typ: 15, peak: 15, est: false, source: 'HC-SR04 模块规格书：工作电流 15 mA' },
    sizeMm: [45, 20, 15],
    sim: { level: 'verified', model: 'hcsr04' },
    price: [3, 8],
    keywords: 'HC-SR04 超声波测距模块',
    supplyNet: '5V',
    requires: [{ partId: 'resistor-kit', why: 'Echo 是 5 V，要 1 kΩ / 2 kΩ 分压到约 3.3 V' }],
    sources: ['HC-SR04 模块规格书（Elecfreaks 版）'],
    note: 'Echo 输出 5 V，ESP32 引脚不耐 5 V。想省分压电阻可以买 3.3 V 版（HC-SR04P / RCWL-1601）。',
  }),
  P({
    id: 'mpu6050',
    name: 'MPU6050 六轴模块（GY-521）',
    kind: 'sensor',
    model: 'TDK InvenSense MPU-6050',
    pins: [VCC(), GND(), pin('SCL', 'i2c-scl', 3.3, { dir: 'bi' }), pin('SDA', 'i2c-sda', 3.3, { dir: 'bi' }), pin('XDA', 'nc', null), pin('XCL', 'nc', null), pin('AD0', 'addr', null, { note: '低 0x68，高 0x69' }), pin('INT', 'digital-out', 3.3, { dir: 'out' })],
    voltage: { supply: [3, 5], logic: 3.3 },
    currentMa: { typ: 3.9, peak: 3.9, est: true, source: '估算：MPU-6000/6050 数据手册陀螺 3.6 mA + 加速度计 500 µA 相加（未计 DMP）' },
    i2cAddr: { default: 0x68, alt: [0x69], how: 'AD0 拉高改 0x69' },
    i2cPullupK: null,
    sizeMm: null,
    sim: { level: 'verified', model: 'mpu6050' },
    price: [6, 15],
    keywords: 'MPU6050 GY-521 模块',
    supplyNet: '3V3',
    sources: ['MPU-6000/MPU-6050 Product Specification'],
    todo: ['voltage.logic：上拉接板载 3.3 V 稳压输出（GY-521 常见做法），待按原理图核', 'i2cPullupK', 'sizeMm'],
    note: '芯片已停产，市面多为兼容片。0x68 和 DS3231 撞地址。模拟器：寄存器、量程、采样率、DATA_RDY 按数据手册，读数由台面姿态算出；FIFO 和 DMP 暂未模拟。',
  }),
  P({
    id: 'qmi8658',
    name: 'QMI8658 六轴模块',
    kind: 'sensor',
    model: 'QST QMI8658C 六轴 IMU 小板',
    pins: [VCC('VIN'), GND(), pin('SCL', 'i2c-scl', 3.3, { dir: 'bi' }), pin('SDA', 'i2c-sda', 3.3, { dir: 'bi' }), pin('SA0', 'addr', null, { note: '高 0x6B，低 0x6A' }), pin('INT', 'digital-out', 3.3, { dir: 'out' })],
    voltage: { supply: [1.71, 3.6], logic: 3.3 },
    currentMa: { typ: 1.7, peak: 1.7, est: true, source: '估算：QMI8658C 数据手册六轴高性能模式约 1.7 mA 量级（待逐字核对）' },
    i2cAddr: { default: 0x6b, alt: [0x6a], how: 'SA0 接地改 0x6A' },
    i2cPullupK: null,
    sizeMm: null,
    sim: { level: 'verified', model: 'qmi8658' },
    price: [8, 20],
    keywords: 'QMI8658 六轴 模块',
    supplyNet: '3V3',
    sources: ['QST QMI8658C Datasheet（寄存器表、量程、I2C 地址）'],
    todo: ['i2cPullupK', 'sizeMm：小板外形随卖家'],
    note: '微雪 ESP32-S3 圆屏板上板载的就是它。CTRL1 不开地址自增时，连续读会一直读同一个寄存器，模拟器也是这样。数据按小端处理（未经真机标定）。',
  }),
  P({
    id: 'ds3231',
    name: 'DS3231 时钟模块（ZS-042）',
    kind: 'module',
    model: 'Maxim/ADI DS3231 + AT24C32',
    pins: [pin('32K', 'digital-out', 'vcc', { dir: 'out' }), pin('SQW', 'digital-out', 'vcc', { dir: 'out' }), pin('SCL', 'i2c-scl', 'vcc', { dir: 'bi' }), pin('SDA', 'i2c-sda', 'vcc', { dir: 'bi' }), VCC(), GND()],
    voltage: { supply: [2.3, 5.5], logic: null },
    currentMa: { typ: 0.2, peak: 0.575, est: false, source: 'DS3231 数据手册：工作 200 µA，温度转换 575 µA（3.63 V）' },
    i2cAddr: { default: 0x68, alt: [], how: '固定；板上 EEPROM AT24C32 另占 0x57' },
    i2cPullupK: 4.7,
    sizeMm: null,
    price: [8, 15],
    keywords: 'DS3231 时钟模块 AT24C32',
    supplyNet: '3V3',
    sources: ['DS3231 数据手册'],
    todo: ['voltage.logic：上拉接 VCC，电平随供电', 'sizeMm'],
    note: 'ZS-042 板上有给电池的充电电路，装不可充的 CR2032 时常见做法是拆掉那颗二极管或电阻（未经真机标定）。',
  }),
  P({
    id: 'ina219',
    name: 'INA219 电流电压监测模块',
    kind: 'sensor',
    model: 'TI INA219',
    pins: [VCC(), GND(), pin('SCL', 'i2c-scl', 'vcc', { dir: 'bi' }), pin('SDA', 'i2c-sda', 'vcc', { dir: 'bi' }), pin('Vin+', 'passive', null), pin('Vin-', 'passive', null)],
    voltage: { supply: [3, 5.5], logic: null },
    currentMa: { typ: 0.7, peak: 1, est: false, source: 'INA219 数据手册：静态电流 0.7 mA 典型 / 1 mA 最大' },
    i2cAddr: { default: 0x40, alt: [0x41, 0x44, 0x45], how: 'A0 / A1 焊盘改地址' },
    i2cPullupK: null,
    sizeMm: null,
    price: [5, 12],
    keywords: 'INA219 模块 I2C 电流',
    supplyNet: '3V3',
    sources: ['TI INA219 数据手册'],
    todo: ['voltage.logic：上拉随 VCC', 'i2cPullupK', 'sizeMm'],
    note: '默认 0x40，和 PCA9685、HTU21D 撞地址。分流电阻常见 0.1 Ω，量程约 ±3.2 A。',
  }),
  P({
    id: 'inmp441',
    name: 'INMP441 数字麦克风（I2S）',
    kind: 'audio',
    model: 'TDK InvenSense INMP441',
    pins: [pin('SCK', 'i2s-bclk', 3.3, { dir: 'in' }), pin('WS', 'i2s-ws', 3.3, { dir: 'in' }), pin('SD', 'i2s-data', 3.3, { dir: 'out' }), pin('L/R', 'addr', null, { note: '接地 = 左声道' }), pin('VDD', 'power', 3.3), GND()],
    voltage: { supply: [1.62, 3.63], logic: 3.3 },
    currentMa: { typ: 1.4, peak: 1.4, est: false, source: 'INMP441 数据手册：工作电流 1.4 mA' },
    sizeMm: null,
    price: [8, 15],
    keywords: 'INMP441 I2S 麦克风模块',
    supplyNet: '3V3',
    sources: ['INMP441 数据手册'],
    todo: ['sizeMm'],
    note: '只能 3.3 V 供电。模拟器暂不支持 I2S 麦克风。',
  }),

  // ───────── 输入 ─────────
  P({
    id: 'button',
    name: '6×6 mm 轻触按键',
    kind: 'input',
    model: '6×6×5 mm 四脚轻触开关',
    pins: [pin('A', 'passive', null), pin('B', 'passive', null)],
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: false, source: '无源器件' },
    sizeMm: [6, 6, 5],
    sim: { level: 'verified', model: 'button' },
    price: [0.1, 0.5],
    keywords: '轻触按键 6x6x5 直插',
    sources: [],
    na: ['voltage：无源开关，没有供电 / 逻辑电平'],
    note: '一端接 GPIO（开内部上拉），一端接 GND。别接在 C3 GPIO9 / S3 GPIO0 上又在上电时按着。',
  }),
  P({
    id: 'pot',
    name: '10 kΩ 旋转电位器',
    kind: 'input',
    model: 'B10K 单联电位器',
    pins: [pin('1', 'power', 'vcc'), pin('2', 'analog', 'vcc', { dir: 'out', note: '滑动端，电压在 0 和 VCC 之间' }), GND('3')],
    voltage: { supply: [0, 5], logic: null },
    currentMa: { typ: 0.33, peak: 0.33, est: true, source: '估算：按 3.3 V / 10 kΩ 计算' },
    sizeMm: null,
    sim: { level: 'verified', model: 'pot' },
    price: [0.5, 2],
    keywords: 'B10K 电位器 单联',
    supplyNet: '3V3',
    sources: [],
    todo: ['voltage.logic：滑动端电压随两端所接电源', 'sizeMm', 'voltage.supply：额定电压按具体型号（这里只按 5 V 以内使用）'],
    note: '两端接 3V3 和 GND（不要接 5 V），滑动端接 ADC 引脚。',
  }),
  P({
    id: 'encoder',
    name: 'EC11 旋转编码器模块（KY-040 类）',
    kind: 'input',
    model: 'EC11 编码器和上拉电阻',
    pins: [pin('CLK', 'digital-out', 'vcc', { dir: 'out', boot: 'pull-up' }), pin('DT', 'digital-out', 'vcc', { dir: 'out', boot: 'pull-up' }), pin('SW', 'digital-out', null, { dir: 'out' }), pin('+', 'power', 'vcc'), GND()],
    voltage: { supply: [3.3, 5], logic: null },
    currentMa: { typ: 0.66, peak: 0.66, est: true, source: '估算：两颗 10 kΩ 上拉在 3.3 V 下' },
    sizeMm: null,
    sim: { level: 'verified', model: 'encoder' },
    price: [2, 6],
    keywords: 'EC11 旋转编码器模块 带按键',
    supplyNet: '3V3',
    sources: [],
    todo: ['voltage.logic：上拉接 +，电平随供电', 'sizeMm', 'voltage.supply：卖家常见标称 3.3–5 V，未见数据手册'],
    note: 'CLK、DT 上拉到「+」：「+」接 5 V 时信号就是 5 V。机械触点要软件消抖或用 PCNT。',
  }),

  // ───────── 显示 ─────────
  P({
    id: 'ssd1306',
    name: '0.96″ OLED（SSD1306，I2C，128×64）',
    kind: 'display',
    model: 'SSD1306 0.96″ 四针 I2C 模块',
    pins: [GND(), VCC(), pin('SCL', 'i2c-scl', null, { dir: 'bi' }), pin('SDA', 'i2c-sda', null, { dir: 'bi' })],
    voltage: { supply: [3.3, 5], logic: 3.3 },
    currentMa: { typ: 10, peak: 20, est: true, source: '估算：随点亮像素数变化，全亮约 20 mA 量级' },
    i2cAddr: { default: 0x3c, alt: [0x3d], how: '背面电阻换位改 0x3D' },
    i2cPullupK: null,
    sizeMm: null,
    sim: { level: 'verified', model: 'ssd1306' },
    price: [8, 15],
    keywords: '0.96寸 OLED SSD1306 I2C 4针',
    supplyNet: '3V3',
    sources: ['Solomon Systech SSD1306 数据手册（命令集、地址）'],
    todo: ['pins[SCL/SDA].v：板载上拉接 VCC 还是稳压后 3.3 V 随批次', 'i2cPullupK', 'sizeMm'],
    note: '有的批次 VCC 和 GND 的引脚顺序是对调的，按丝印接，别按图接。',
  }),
  P({
    id: 'sh1106',
    name: '1.3″ OLED（SH1106，I2C，128×64）',
    kind: 'display',
    model: 'SH1106 1.3″ 四针 I2C 模块',
    pins: [VCC(), GND(), pin('SCL', 'i2c-scl', null, { dir: 'bi' }), pin('SDA', 'i2c-sda', null, { dir: 'bi' })],
    voltage: { supply: [3.3, 5], logic: 3.3 },
    currentMa: { typ: 12, peak: 25, est: true, source: '估算：与 SSD1306 同量级，屏更大' },
    i2cAddr: { default: 0x3c, alt: [0x3d] },
    i2cPullupK: null,
    sizeMm: null,
    price: [12, 22],
    keywords: '1.3寸 OLED SH1106 I2C',
    supplyNet: '3V3',
    sources: ['Sino Wealth SH1106 数据手册（132×64 显存）'],
    todo: ['pins[SCL/SDA].v', 'i2cPullupK', 'sizeMm'],
    note: '外观和 SSD1306 很像但驱动不同：显存 132 列、没有水平寻址模式，用 SSD1306 驱动会花屏或偏 2 列。模拟器还没有这块屏的模型。',
  }),
  P({
    id: 'gc9a01',
    name: '1.28″ 圆屏（GC9A01，SPI，240×240）',
    kind: 'display',
    model: 'GC9A01 1.28″ IPS 圆形 LCD 模块（8 针）',
    pins: [VCC(), GND(), pin('SCL', 'spi-sclk', 3.3, { dir: 'in' }), pin('SDA', 'spi-mosi', 3.3, { dir: 'in' }), pin('RES', 'rst', 3.3, { dir: 'in' }), pin('DC', 'spi-dc', 3.3, { dir: 'in' }), pin('CS', 'spi-cs', 3.3, { dir: 'in' }), pin('BLK', 'backlight', 3.3, { dir: 'in' })],
    voltage: { supply: [3.3, 3.3], logic: 3.3 },
    currentMa: { typ: 25, peak: 40, est: true, source: '估算：主要是背光，随卖家' },
    sizeMm: null,
    sim: { level: 'verified', model: 'gc9a01' },
    price: [12, 25],
    keywords: '1.28寸 圆形 IPS GC9A01 SPI',
    supplyNet: '3V3',
    sources: ['GalaxyCore GC9A01 数据手册（命令集）'],
    todo: ['voltage.supply：部分模块带稳压可接 5 V，按卖家', 'currentMa', 'sizeMm'],
    note: '丝印「SDA / SCL」其实是 SPI 的 MOSI / SCLK，不是 I2C。只写不读，没有 MISO。',
  }),
  P({
    id: 'gc9a01-touch',
    name: '1.28″ 触摸圆屏（GC9A01 + CST816S）',
    kind: 'display',
    model: '1.28″ 圆形 IPS LCD 和 CST816S 电容触摸（微雪 1.28inch Touch LCD 一类，12 针）',
    pins: [
      VCC(), GND(), pin('SCL', 'spi-sclk', 3.3, { dir: 'in' }), pin('SDA', 'spi-mosi', 3.3, { dir: 'in' }), pin('RES', 'rst', 3.3, { dir: 'in' }), pin('DC', 'spi-dc', 3.3, { dir: 'in' }), pin('CS', 'spi-cs', 3.3, { dir: 'in' }), pin('BLK', 'backlight', 3.3, { dir: 'in' }),
      pin('TP_SDA', 'i2c-sda', 3.3, { dir: 'bi' }), pin('TP_SCL', 'i2c-scl', 3.3, { dir: 'bi' }), pin('TP_INT', 'digital-out', 3.3, { dir: 'out', note: '按着拉低' }), pin('TP_RST', 'rst', 3.3, { dir: 'in' }),
    ],
    voltage: { supply: [3.3, 3.3], logic: 3.3 },
    currentMa: { typ: 27.5, peak: 43, est: true, source: '估算：背光约 25 mA（同 gc9a01）+ CST816S 扫描 mA 量级' },
    i2cAddr: { default: 0x15, alt: [] },
    i2cPullupK: null,
    sizeMm: null,
    sim: { level: 'verified', model: 'gc9a01+cst816s' },
    price: [25, 45],
    keywords: '1.28寸 圆形 触摸屏 GC9A01 CST816S',
    supplyNet: '3V3',
    sources: ['GalaxyCore GC9A01 数据手册（命令集）', '海栎创 CST816S 寄存器说明（0x01 手势、0x02 手指数、0x03–0x06 坐标、0xA7 芯片 ID 0xB5）'],
    todo: ['voltage.supply：部分模块带稳压可接 5 V，按卖家', 'i2cPullupK', 'sizeMm', 'pins：各家排针顺序不同，按卖家丝印'],
    note: '触摸芯片无触摸几秒后自动睡眠、I2C 不应答，驱动要么先拉 TP_RST，要么等 INT 再读；模拟器没有模拟自动睡眠，这一点必须上真机确认。',
  }),
  P({
    id: 'st7789',
    name: '1.54″ 彩屏（ST7789，SPI，240×240）',
    kind: 'display',
    model: 'ST7789 1.54″ IPS LCD 模块',
    pins: [GND(), VCC(), pin('SCL', 'spi-sclk', 3.3, { dir: 'in' }), pin('SDA', 'spi-mosi', 3.3, { dir: 'in' }), pin('RES', 'rst', 3.3, { dir: 'in' }), pin('DC', 'spi-dc', 3.3, { dir: 'in' }), pin('CS', 'spi-cs', 3.3, { dir: 'in' }), pin('BLK', 'backlight', 3.3, { dir: 'in' })],
    voltage: { supply: [3.3, 3.3], logic: 3.3 },
    currentMa: { typ: 25, peak: 50, est: true, source: '估算：主要是背光' },
    sizeMm: null,
    price: [12, 28],
    keywords: '1.54寸 IPS ST7789 SPI 240x240',
    supplyNet: '3V3',
    sources: ['Sitronix ST7789V 数据手册'],
    todo: ['voltage.supply：部分模块带稳压', 'currentMa', 'sizeMm'],
    note: '有的 1.3″ 七针版没有 CS 脚，要用 SPI 模式 3。模拟器还没有 ST7789 模型。',
  }),

  // ───────── 执行器 / 灯 / 声音 ─────────
  P({
    id: 'sg90',
    name: 'SG90 舵机（180°，塑料齿）',
    kind: 'actuator',
    model: 'TowerPro SG90 及兼容品',
    pins: [GND('棕 GND'), pin('红 VCC', 'power', 'vcc'), pin('橙 PWM', 'pwm', null, { dir: 'in', note: '3.3 V 信号一般能驱动（未经真机标定）' })],
    voltage: { supply: [4.8, 6], logic: null },
    currentMa: { typ: 150, peak: 700, est: true, source: '估算：规格书不给电流；运动时百 mA 量级、堵转数百 mA（各家实测差异大）' },
    sizeMm: [22.2, 11.8, 31],
    sim: { level: 'verified', model: 'servo' },
    price: [4, 10],
    keywords: 'SG90 舵机 180度',
    supplyNet: 'EXT5V',
    sources: ['TowerPro SG90 规格书（4.8 V、50 Hz、0.5–2.4 ms 量级、尺寸 22.2×11.8×31 mm）'],
    todo: ['currentMa：按具体型号录入实测堵转电流', 'voltage.logic：信号输入门限规格书未给，3.3 V 一般能驱动（未经真机标定）'],
    note: '要 4.8–6 V 供电，不能接 3V3。启动瞬间电流大，从电脑 USB 取电容易让板子复位。',
  }),
  P({
    id: 'mg90s',
    name: 'MG90S 舵机（金属齿）',
    kind: 'actuator',
    model: 'TowerPro MG90S 及兼容品',
    pins: [GND('棕 GND'), pin('红 VCC', 'power', 'vcc'), pin('橙 PWM', 'pwm', null, { dir: 'in' })],
    voltage: { supply: [4.8, 6], logic: null },
    currentMa: { typ: 200, peak: 800, est: true, source: '估算：比 SG90 扭矩大，堵转电流更高（数据手册不给）' },
    sizeMm: [22.8, 12.2, 28.5],
    sim: { level: 'estimated', model: 'servo' },
    price: [8, 18],
    keywords: 'MG90S 金属齿舵机',
    supplyNet: 'EXT5V',
    sources: ['TowerPro MG90S 规格书（尺寸、电压）'],
    todo: ['currentMa：按具体型号录入', 'voltage.logic：信号输入门限规格书未给'],
    note: '和 SG90 同尺寸同接口，齿轮耐用。模拟器用同一个舵机模型（不区分扭矩）。',
  }),
  P({
    id: 'ws2812-strip',
    name: 'WS2812B 灯带 1 m（60 灯，5 V）',
    kind: 'actuator',
    model: 'WS2812B-5050 灯带',
    pins: [pin('5V', 'power', 'vcc'), pin('DIN', 'ws2812-din', null, { dir: 'in', note: 'VIH = 0.7 × VDD' }), GND()],
    voltage: { supply: [3.5, 5.3], logic: null },
    currentMa: { typ: null, peak: 3600, est: true, source: '估算：每颗满白约 60 mA × 60 颗（常用经验值，数据手册按通道给）' },
    sizeMm: [1000, 10, null],
    sim: { level: 'verified', model: 'ws2812' },
    price: [12, 30],
    keywords: 'WS2812B 灯带 60灯 5V 1米',
    supplyNet: 'EXT5V',
    requires: [{ partId: 'psu-5v2a', why: '灯带不能从开发板 USB 取电' }],
    sources: ['WS2812B 数据手册（VDD 3.5–5.3 V、VIH 0.7 VDD）'],
    todo: ['currentMa.typ：随亮度与颜色', 'sizeMm[2]：厚度随卖家（带防水套更厚）'],
    na: ['voltage.logic：数据门限随供电（VIH = 0.7 × VDD），不是固定值'],
    note: '满白 3.6 A，5 V 2 A 电源只够约一半亮度，要在固件里限亮度。电源端并一颗 1000 µF 电容。',
  }),
  P({
    id: 'ws2812-stick8',
    name: 'WS2812 8 灯灯带',
    kind: 'actuator',
    model: 'WS2812B-5050 × 8 灯板',
    pins: [pin('5V', 'power', 'vcc'), pin('DIN', 'ws2812-din', null, { dir: 'in' }), GND(), pin('DOUT', 'ws2812-dout', null, { dir: 'out' })],
    voltage: { supply: [3.5, 5.3], logic: null },
    currentMa: { typ: null, peak: 480, est: true, source: '估算：60 mA × 8' },
    sizeMm: null,
    sim: { level: 'verified', model: 'ws2812' },
    price: [3, 8],
    keywords: 'WS2812 8位 灯条 RGB',
    supplyNet: '5V',
    sources: ['WS2812B 数据手册'],
    todo: ['currentMa.typ', 'sizeMm'],
    na: ['voltage.logic：数据门限随供电（VIH = 0.7 × VDD），不是固定值'],
    note: '少量灯可以从板子 5V 取电，但满白 480 mA 已接近 USB 上限。',
  }),
  P({
    id: 'buzzer-active',
    name: '有源蜂鸣器 12 mm（裸件）',
    kind: 'actuator',
    model: 'TMB12A05 类有源电磁蜂鸣器',
    pins: [pin('+', 'io', null, { dir: 'in', loadMa: 30 }), GND('-')],
    voltage: { supply: [3.5, 5.5], logic: null },
    currentMa: { typ: 30, peak: 30, est: true, source: '估算：常见规格书"≤ 30 mA"' },
    sizeMm: [12, 12, 9.5],
    price: [0.5, 2],
    keywords: '有源蜂鸣器 12095 5V',
    supplyNet: '5V',
    sources: [],
    todo: ['voltage.supply：3 V / 5 V 两种，按型号'],
    na: ['voltage.logic：两端器件，没有逻辑接口'],
    note: '通电就响、只有一个音调。电流超过 GPIO 推荐值，要三极管驱动；或者买带三极管的三针模块。',
  }),
  P({
    id: 'buzzer-passive',
    name: '无源蜂鸣器 12 mm（裸件，电磁式）',
    kind: 'actuator',
    model: '12085 类无源电磁蜂鸣器（线圈约 16 Ω）',
    pins: [pin('+', 'pwm', null, { dir: 'in', loadMa: 100 }), GND('-')],
    voltage: { supply: [3, 5], logic: null },
    currentMa: { typ: null, peak: 100, est: true, source: '估算：线圈十几欧，直接接 GPIO 远超引脚能力' },
    sizeMm: [12, 12, 8.5],
    price: [0.5, 2],
    keywords: '无源蜂鸣器 12085 16欧',
    supplyNet: '5V',
    sources: [],
    todo: ['currentMa：按线圈电阻核', 'voltage.supply'],
    na: ['voltage.logic：两端器件，没有逻辑接口'],
    note: '要 PWM 方波才响（谐振约 2.7 kHz 量级），能放旋律。必须三极管驱动。',
  }),
  P({
    id: 'buzzer-module',
    name: '无源蜂鸣器模块（三针，带三极管）',
    kind: 'actuator',
    model: '无源蜂鸣器和 S8050 驱动模块',
    pins: [VCC(), pin('I/O', 'pwm', null, { dir: 'in', note: '模块上三极管基极，经电阻' }), GND()],
    voltage: { supply: [3.3, 5], logic: null },
    currentMa: { typ: 30, peak: 60, est: true, source: '估算：随驱动电压与占空比' },
    sizeMm: null,
    price: [1, 4],
    keywords: '无源蜂鸣器模块 低电平触发 三线',
    supplyNet: '3V3',
    sources: [],
    todo: ['currentMa', 'sizeMm', 'voltage.logic：有的模块低电平响', 'voltage.supply：卖家常见标称 3.3–5 V，未见数据手册'],
    note: '气象站的报警用这个。I/O 直接接 GPIO 即可。',
  }),
  P({
    id: 'max98357a',
    name: 'MAX98357A I2S 功放模块',
    kind: 'audio',
    model: 'ADI/Maxim MAX98357A',
    pins: [pin('LRC', 'i2s-ws', 3.3, { dir: 'in' }), pin('BCLK', 'i2s-bclk', 3.3, { dir: 'in' }), pin('DIN', 'i2s-data', 3.3, { dir: 'in' }), pin('GAIN', 'addr', null), pin('SD', 'en', null), GND(), pin('Vin', 'power', 'vcc')],
    voltage: { supply: [2.5, 5.5], logic: 3.3 },
    currentMa: { typ: 2.4, peak: 800, est: true, source: '数据手册静态 2.4 mA；峰值为估算（5 V、4 Ω、约 3 W 输出）' },
    sizeMm: null,
    price: [8, 18],
    keywords: 'MAX98357A I2S 功放模块',
    supplyNet: '5V',
    sources: ['MAX98357A 数据手册（2.5–5.5 V、3.2 W @ 5 V 4 Ω）'],
    todo: ['sizeMm'],
    note: '从 5 V 供电音量最大；峰值电流大，和 Wi-Fi 叠加时 USB 可能掉压。模拟器暂无 I2S 模型。',
  }),
  P({
    id: 'speaker-3w',
    name: '4 Ω 3 W 小喇叭（40 mm）',
    kind: 'audio',
    model: '40 mm 4 Ω 3 W 扬声器',
    pins: [pin('+', 'passive', null), pin('-', 'passive', null)],
    voltage: { supply: null, logic: null },
    currentMa: { typ: null, peak: null, est: true, source: '由功放决定' },
    sizeMm: [40, 40, null],
    price: [2, 6],
    keywords: '4欧3W 喇叭 40mm',
    sources: [],
    todo: ['currentMa：由功放决定，不单列', 'voltage.supply：无源件，额定功率 3 W', 'sizeMm[2]：厚度随型号'],
    na: ['voltage：无源件，按额定功率 3 W 用'],
    note: '接 MAX98357A 的 +/− 输出，不要接地。',
  }),

  // ───────── 电源 / 线材 ─────────
  P({
    id: 'psu-5v2a',
    name: '5 V 2 A 电源适配器（DC 5.5×2.1）',
    kind: 'power',
    model: '5 V 2 A 开关电源，DC 5.5×2.1 mm 内正外负',
    pins: [pin('+', 'power', 5), GND('-')],
    voltage: { supply: [100, 240], logic: null },
    currentMa: { typ: null, peak: null, est: true, source: '对外供电，不消耗' },
    sizeMm: null,
    price: [8, 20],
    keywords: '5V2A 电源适配器 DC5.5x2.1',
    provides: { net: 'EXT5V', maxMa: 2000 },
    requires: [{ partId: 'dc-jack', why: '插头要经 DC 母座转成面包板能接的两根线' }],
    sources: [],
    todo: ['currentMa：电源件不消耗电流', 'sizeMm', 'voltage.supply：AC 100–240 V 为常见标称，以所买型号铭牌为准'],
    na: ['voltage.logic：电源件'],
    note: '给舵机或灯带单独供电，地线要和开发板 GND 接在一起。买 3C 认证的。',
  }),
  P({
    id: 'dc-jack',
    name: 'DC 5.5×2.1 母座转接线端子',
    kind: 'power',
    model: 'DC-005 母座转螺丝端子',
    pins: [pin('+', 'power', 'vcc'), GND('-')],
    voltage: { supply: [0, 24], logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '无源接插件' },
    sizeMm: null,
    price: [0.5, 3],
    keywords: 'DC5.5x2.1 母座 接线端子 免焊',
    sources: [],
    todo: ['voltage.supply：额定电压 / 电流按型号', 'sizeMm'],
    na: ['voltage.logic：接插件'],
    note: '螺丝端子接两根杜邦线到面包板电源轨。',
  }),
  P({
    id: 'ams1117',
    name: 'AMS1117-3.3 降压模块',
    kind: 'power',
    model: 'AMS1117-3.3 LDO 模块',
    pins: [pin('VIN', 'power', 'vcc'), GND(), pin('3.3V', 'power', 3.3)],
    voltage: { supply: [4.75, 12], logic: null },
    currentMa: { typ: 5, peak: 5, est: false, source: 'AMS1117 数据手册：静态电流约 5 mA' },
    sizeMm: null,
    price: [0.5, 3],
    keywords: 'AMS1117-3.3 降压模块',
    provides: { net: 'EXT3V3', maxMa: 800 },
    sources: ['AMS1117 数据手册（压差约 1.1–1.3 V，最大输入 15 V，输出 1 A 级）'],
    todo: ['provides.maxMa：按 800 mA 保守值，受散热限制', 'sizeMm', 'voltage.supply：上限 12 V 为保守取值（数据手册最大输入 15 V），下限 = 3.3 V + 压差'],
    na: ['voltage.logic：电源件'],
    note: '把 5 V 降到 3.3 V，压差约 1.1 V；电流越大发热越多，发热功率约等于 1.7 V 乘以电流。',
  }),
  P({
    id: 'usb-c-cable',
    name: 'Type-C 数据线（能传数据）',
    kind: 'cable',
    model: 'USB-A / USB-C 转 Type-C，USB 2.0 数据线',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '线材' },
    sizeMm: null,
    price: [5, 15],
    keywords: 'Type-C 数据线 USB2.0 可传数据',
    sources: [],
    todo: ['sizeMm'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '很多充电线只有电源没有数据线芯，插上电脑认不到板子。',
  }),
  P({
    id: 'lipo-1000',
    name: '3.7 V 锂聚合物电池 1000 mAh（带保护板）',
    kind: 'power',
    model: '103040 类 1000 mAh 锂聚合物电池',
    pins: [pin('红 +', 'power', 3.7), GND('黑 -')],
    voltage: { supply: [3.0, 4.2], logic: null },
    currentMa: { typ: null, peak: null, est: true, source: '对外供电' },
    sizeMm: null,
    price: [10, 20],
    keywords: '3.7V 锂电池 1000mAh 带保护板 PH2.0',
    supplyNet: 'BAT',
    rfBlocker: true,
    requires: [{ partId: 'tp4056', why: '锂电要充电管理（板子自带充电的不用）' }],
    sources: ['锂聚合物电芯通用规格（标称 3.7 V、满充 4.2 V，放电截止约 3.0 V 随保护板）'],
    todo: ['currentMa：按放电倍率', 'sizeMm：随型号', 'voltage.supply：放电截止电压随保护板型号'],
    na: ['voltage.logic：电源件'],
    note: '注意插头线序（PH2.0 红黑可能反）。不要放在天线正上方。',
  }),
  P({
    id: 'tp4056',
    name: 'TP4056 Type-C 锂电充电模块（带保护）',
    kind: 'power',
    model: 'TP4056 + DW01A + FS8205A',
    pins: [pin('IN+', 'power', 5), GND('IN-'), pin('B+', 'power', 'vcc'), GND('B-'), pin('OUT+', 'power', 'vcc'), GND('OUT-')],
    voltage: { supply: [4.5, 5.5], logic: null },
    currentMa: { typ: 1000, peak: 1000, est: false, source: 'TP4056 数据手册：充电电流由 RPROG 设，模块默认 1.2 kΩ ≈ 1 A' },
    sizeMm: null,
    price: [1, 4],
    keywords: 'TP4056 Type-C 充电模块 带保护',
    sources: ['TP4056 数据手册'],
    todo: ['sizeMm', 'voltage.supply：按 USB 5 V 输入取 4.5–5.5 V，待与数据手册输入范围原文核对'],
    na: ['voltage.logic：电源件'],
    note: '1000 mAh 电池用 1 A 充电偏快，可换 RPROG 降到 0.5 A。',
  }),

  // ───────── 面包板 / 线 / 阻容 ─────────
  P({
    id: 'breadboard-830',
    name: '面包板 830 孔',
    kind: 'proto',
    model: 'MB-102 830 孔面包板',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '无源' },
    sizeMm: [165, 55, null],
    sim: { level: 'verified', model: 'breadboard' },
    price: [5, 12],
    keywords: '830孔 面包板 MB-102',
    requires: [{ partId: 'dupont-mm', why: '面包板上要用公对公杜邦线连接' }],
    sources: ['卖家常见标注 16.5×5.5 cm'],
    todo: ['sizeMm[2]：厚度'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: 'DevKitC-1 宽 25 mm 左右，插上 830 孔面包板只剩一侧一排孔可用；两块并排是常见做法。',
  }),
  P({
    id: 'breadboard-400',
    name: '面包板 400 孔',
    kind: 'proto',
    model: '400 孔半尺寸面包板',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '无源' },
    sizeMm: [83, 55, null],
    price: [3, 8],
    keywords: '400孔 面包板',
    requires: [{ partId: 'dupont-mm', why: '面包板上要用公对公杜邦线连接' }],
    sources: ['卖家常见标注 8.3×5.5 cm'],
    todo: ['sizeMm[2]：厚度'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '放模块用；开发板太宽，插不下两侧都留孔。',
  }),
  P({
    id: 'dupont-mm',
    name: '杜邦线 公对公 20 cm（40 根）',
    kind: 'cable',
    model: '2.54 mm 杜邦线 公-公',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '线材' },
    sizeMm: null,
    price: [3, 8],
    keywords: '杜邦线 公对公 20cm 40P',
    sources: [],
    todo: ['sizeMm：线材只标长度 20 cm'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '细线承载舵机或灯带的大电流会掉压，电源线尽量短。',
  }),
  P({
    id: 'dupont-mf',
    name: '杜邦线 公对母 20 cm（40 根）',
    kind: 'cable',
    model: '2.54 mm 杜邦线 公-母',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '线材' },
    sizeMm: null,
    price: [3, 8],
    keywords: '杜邦线 公对母 20cm 40P',
    sources: [],
    todo: ['sizeMm：线材只标长度 20 cm'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '模块排针（公头）插进面包板孔。',
  }),
  P({
    id: 'dupont-ff',
    name: '杜邦线 母对母 20 cm（40 根）',
    kind: 'cable',
    model: '2.54 mm 杜邦线 母-母',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '线材' },
    sizeMm: null,
    price: [3, 8],
    keywords: '杜邦线 母对母 20cm 40P',
    sources: [],
    todo: ['sizeMm：线材只标长度 20 cm'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '开发板排针直接连模块排针，不经面包板（装进外壳时用）。',
  }),
  P({
    id: 'resistor-kit',
    name: '常用电阻套装（含 220 Ω、1 k、2 k、4.7 k、10 k）',
    kind: 'passive',
    model: '1/4 W 金属膜电阻 30 种阻值套装',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '无源' },
    sizeMm: null,
    price: [5, 12],
    keywords: '电阻包 1/4W 金属膜 套装 30种',
    sources: [],
    todo: ['sizeMm'],
    na: ['pins：套装，按单颗电阻两端接', 'voltage：不适用（1/4 W 额定功率）'],
    note: 'LED 限流（220 Ω）、5 V 信号分压（1 k / 2 k）、单总线上拉（4.7 k）都从这里拿。',
  }),
  P({
    id: 'led-kit',
    name: '5 mm LED 套装（红黄绿蓝白）',
    kind: 'passive',
    model: '5 mm 直插 LED',
    pins: [pin('长脚 +', 'io', null, { dir: 'in', loadMa: 6 }), GND('短脚 -')],
    voltage: { supply: [1.8, 3.4], logic: null },
    currentMa: { typ: 6, peak: 20, est: true, source: '估算：3.3 V 经 220 Ω、红光 Vf≈2 V 时约 6 mA；额定 20 mA' },
    sizeMm: [5, 5, 8.6],
    sim: { level: 'verified', model: 'led' },
    price: [2, 6],
    keywords: '5mm LED 发光二极管 套装',
    requires: [{ partId: 'resistor-kit', why: 'LED 必须串限流电阻' }],
    sources: [],
    todo: ['voltage.supply：Vf 随颜色'],
    na: ['voltage.logic：两端器件'],
    note: '长脚正极。必须串电阻（220 Ω 起），不然会烧灯或伤引脚。',
  }),
  P({
    id: 'level-ahct125',
    name: '74AHCT125 电平转换（DIP-14）',
    kind: 'passive',
    model: '74AHCT125 四路缓冲器（TTL 输入门限）',
    pins: [pin('VCC', 'power', 5), GND(), pin('1A', 'digital-in', null, { dir: 'in' }), pin('1Y', 'digital-out', 5, { dir: 'out' }), pin('1OE', 'en', null)],
    voltage: { supply: [4.5, 5.5], logic: 5 },
    currentMa: { typ: 0.04, peak: 0.04, est: false, source: '74AHCT125 数据手册：ICC 最大 40 µA（静态）' },
    sizeMm: null,
    price: [1, 4],
    keywords: '74AHCT125 DIP14',
    sources: ['TI SN74AHCT125 数据手册（VIH 2.0 V，5 V 供电）'],
    todo: ['sizeMm'],
    note: '把 3.3 V 数据升到 5 V，给 WS2812 灯带用，单向。OE 接地使能。',
  }),
  P({
    id: 'level-bss138',
    name: '4 路双向电平转换模块（BSS138）',
    kind: 'passive',
    model: 'BSS138 MOSFET 双向电平转换',
    pins: [pin('LV', 'power', 3.3), pin('HV', 'power', 5), GND(), pin('LV1', 'io', 3.3, { dir: 'bi' }), pin('HV1', 'io', 5, { dir: 'bi' })],
    voltage: { supply: [1.8, 5], logic: 3.3 },
    currentMa: { typ: 0, peak: 0, est: true, source: '无源（只有上拉电流）' },
    sizeMm: null,
    price: [1, 4],
    keywords: '4路 电平转换模块 BSS138 双向',
    sources: [],
    todo: ['sizeMm', 'voltage.supply：LV 侧 1.8 V 下限按卖家标称，待对模块原理图核'],
    note: '适合 I2C 和慢速信号；速度不够驱动 WS2812。',
  }),
  P({
    id: 'npn-s8050',
    name: 'S8050 NPN 三极管（TO-92，配 1 kΩ 基极电阻）',
    kind: 'passive',
    model: 'S8050',
    pins: [pin('E', 'gnd', 0), pin('B', 'digital-in', null, { dir: 'in', loadMa: 2.6 }), pin('C', 'passive', null)],
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '开关件' },
    sizeMm: null,
    price: [0.05, 0.3],
    keywords: 'S8050 三极管 TO-92',
    sources: [],
    todo: ['Ic：额定随厂家（500 mA–1.5 A 不等），按具体数据手册', 'sizeMm'],
    na: ['voltage：分立三极管，看 Vceo / Ic 额定（见 todo Ic）'],
    note: '低边开关：GPIO 经 1 kΩ 接 B，E 接地，负载接在 C 和 5 V 之间；感性负载（继电器、电机）加续流二极管。',
  }),
  P({
    id: 'cap-1000uf',
    name: '1000 µF 10 V 电解电容',
    kind: 'passive',
    model: '1000 µF / 10 V 铝电解',
    pins: [pin('+', 'passive', null), pin('-', 'gnd', 0)],
    voltage: { supply: [0, 10], logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '无源' },
    sizeMm: null,
    price: [0.3, 1.5],
    keywords: '1000uF 10V 电解电容',
    sources: ['元件标称耐压 10 V（型号即规格）'],
    todo: ['sizeMm'],
    na: ['voltage.logic：无源件'],
    note: '并在灯带或舵机电源两端，吸收启动尖峰。',
  }),
  P({
    id: 'header-pins',
    name: '2.54 mm 排针（40P，单排）',
    kind: 'proto',
    model: '2.54 mm 单排直针',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '无源' },
    sizeMm: null,
    price: [0.5, 2],
    keywords: '2.54mm 单排排针 40P',
    sources: [],
    todo: ['sizeMm'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '很多模块排针没焊、要自己焊——看卖家图有没有焊好。',
  }),

  // ───────── 外壳（按作品） ─────────
  P({
    id: 'enclosure-weather',
    name: '气象站外壳（3D 打印 PLA）',
    kind: 'enclosure',
    model: '试板气象站外壳（参数化，前面板和后壳）',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '结构件' },
    sizeMm: [70, 50, 32],
    sim: { level: 'estimated', model: 'assembly:weather' },
    price: [15, 40],
    keywords: '3D打印 PLA 定制',
    sources: ['web/src/views/templates.ts（外壳 70×50×32 mm，估算）'],
    todo: ['price：打印服务按体积报价'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '下载 STL 去打印服务上传询价（外链）；装配位置会改变 BME280 读数。',
  }),
  P({
    id: 'enclosure-spin',
    name: '小黄身体和转台底座（3D 打印）',
    kind: 'enclosure',
    model: '试板小黄外壳（底座 Ø60、身高 110 mm）',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '结构件' },
    sizeMm: [60, 60, 110],
    sim: { level: 'estimated', model: 'assembly:spin' },
    price: [20, 50],
    keywords: '3D打印 PLA 定制',
    sources: ['web/src/views/templates.ts（底座 Ø60 mm，身高 110 mm，估算）'],
    todo: ['price：打印服务按体积报价'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '舵机仓在底座里，圆屏排线穿转轴中心孔。',
  }),
  P({
    id: 'enclosure-lens',
    name: '透镜小人底座和屏幕外框（3D 打印）',
    kind: 'enclosure',
    model: '试板透镜小人外壳（底座 Ø50 mm，外框两档卡槽）',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '结构件' },
    sizeMm: [50, 50, 62],
    sim: { level: 'estimated', model: 'assembly:lens' },
    price: [12, 35],
    keywords: '3D打印 PLA 定制',
    sources: ['web/src/views/templates.ts（底座 Ø50 mm，总高 62 mm，估算）'],
    todo: ['price：打印服务按体积报价'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '外框高档离屏 8 mm 时透镜放大约 1.35×（估算）。',
  }),
  P({
    id: 'enclosure-lamp',
    name: '旋钮台灯灯座和灯罩（3D 打印）',
    kind: 'enclosure',
    model: '试板旋钮台灯外壳（灯座 80×60×36 mm，乳白灯罩 Ø70 mm）',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '结构件' },
    sizeMm: [80, 60, 110],
    sim: { level: 'estimated', model: 'assembly:lamp' },
    price: [18, 45],
    keywords: '3D打印 PLA 定制 乳白 灯罩',
    sources: ['web/src/views/templates.ts（灯座 80×60×36 mm，灯罩 Ø70 mm，估算）'],
    todo: ['price：打印服务按体积报价'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '灯罩用乳白 PLA 打印才能把灯珠的光打散；灯带贴在导光柱上，离灯罩壁远一点才不会有亮点。',
  }),
  P({
    id: 'enclosure-ruler',
    name: '超声波尺子外壳（3D 打印）',
    kind: 'enclosure',
    model: '试板超声波尺子外壳（手持 90×48×30 mm，前面两个探头孔）',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '结构件' },
    sizeMm: [90, 48, 30],
    sim: { level: 'estimated', model: 'assembly:ruler' },
    price: [12, 35],
    keywords: '3D打印 PLA 定制',
    sources: ['web/src/views/templates.ts（外壳 90×48×30 mm，探头孔 Ø17 mm，估算）'],
    todo: ['price：打印服务按体积报价'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '两个探头要从前面板的孔里探出来；缩在孔后面，声波先打到孔壁，读数会变成几厘米。',
  }),
  P({
    id: 'enclosure-tilt',
    name: '体感小人圆盘外壳（3D 打印）',
    kind: 'enclosure',
    model: '试板体感小人外壳（圆盘 Ø56 × 26 mm，圆屏在顶面）',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '结构件' },
    sizeMm: [56, 56, 26],
    sim: { level: 'estimated', model: 'assembly:tilt' },
    price: [12, 32],
    keywords: '3D打印 PLA 定制',
    sources: ['web/src/views/templates.ts（圆盘 Ø56 × 26 mm，估算）'],
    todo: ['price：打印服务按体积报价'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '六轴模块要平贴底板、箭头朝前；装反了小人会往高处爬。',
  }),
  P({
    id: 'enclosure-usbkey',
    name: 'USB 小键盘外壳和键帽（3D 打印）',
    kind: 'enclosure',
    model: '试板 USB 小键盘外壳（底壳、定位板和 4 个键帽）',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '结构件' },
    sizeMm: [80, 40, 22],
    sim: { level: 'estimated', model: 'assembly:usbkey' },
    price: [12, 35],
    keywords: '3D打印 PLA 定制 键帽',
    sources: ['web/src/app/enclosure.ts（底壳 80×40 mm，估算）'],
    todo: ['price：打印服务按体积报价'],
    na: ['pins：线材 / 结构件，没有电气引脚', 'voltage：不适用'],
    note: '开发板的原生 USB 口要对准背面开孔；别用金属定位板盖住 WROOM 天线，否则 Wi-Fi 信号会变差（估算）。',
  }),
  P({
    id: 'lens-dome',
    name: 'Ø40 mm 亚克力凸透镜',
    kind: 'enclosure',
    model: 'Ø40 mm 平凸 / 双凸亚克力透镜',
    pins: null,
    voltage: { supply: null, logic: null },
    currentMa: { typ: 0, peak: 0, est: true, source: '光学件' },
    sizeMm: [40, 40, null],
    sim: { level: 'estimated', model: 'assembly:lens' },
    price: [3, 12],
    keywords: '40mm 亚克力凸透镜 放大镜片',
    sources: [],
    todo: ['sizeMm[2]：厚度与焦距随卖家（焦距决定放大倍数）'],
    na: ['pins：光学件', 'voltage：不适用'],
    note: '焦距要和外框高度配：按离屏 8 mm 算，放大约 1.35×（估算）。',
  }),
];

export const PART_BY_ID: Record<string, Part> = Object.fromEntries(PARTS.map((p) => [p.id, p]));

export function getPart(id: string): Part {
  const p = PART_BY_ID[id];
  if (!p) throw new Error(`元件库没有 ${id}`);
  return p;
}

export const BOARDS = PARTS.filter((p) => p.kind === 'board');
