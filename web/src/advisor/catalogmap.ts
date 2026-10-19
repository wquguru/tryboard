// 选板零件 / 板子 → 采购目录（catalog/parts.ts）对照（DECISIONS 2026-10-18「选板 v3」接口约定 2）。
// 选板讲的是"要什么功能的东西"，采购和实验台要具体型号；没有模型的零件只进清单、不上实验台。

export interface CatalogItem {
  partId: string;
  qty?: number;
  /** 随它一起要买的（舵机要 5V 适配器、锂电池要充电板、功放要喇叭） */
  with?: string[];
}

/** null = 没有模型：只进清单（按选板名字列），实验台不放，可信度「必须上真机」 */
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
  relay: null,
  pir: null,
  camera: null,
};

/** 总会加的：面包板和杜邦线（「我已有」常勾） */
export const ALWAYS = ['breadboard-400', 'dupont-ff'];

/** 选板板子 → 实验台板子；sub = 不是同一块，是"代替运行" */
export const BOARD_MAP: Record<string, { boardId: string; sub?: string }> = {
  'xiao-c3': { boardId: 'xiao-c3' },
  'c3-devkitm': { boardId: 'c3-devkitm1' },
  'c3-supermini': { boardId: 'xiao-c3', sub: '同为 ESP32-C3，用 XIAO ESP32C3 代替运行' },
  's3-devkitc-n16r8': { boardId: 's3-devkitc1-v11' },
  'xiao-s3-sense': { boardId: 'xiao-s3', sub: '摄像头部分必须上真机' },
  'c6-devkitc': { boardId: 'xiao-c3', sub: 'C6 还不能仿真，用 ESP32-C3 代替运行' },
  'xiao-c6': { boardId: 'xiao-c3', sub: 'C6 还不能仿真，用 ESP32-C3 代替运行' },
  'esp32-devkitc': { boardId: 'xiao-c3', sub: '经典 ESP32 还不能仿真，用 ESP32-C3 代替运行' },
};

export const boardFor = (advisorBoard: string) => BOARD_MAP[advisorBoard] ?? { boardId: 'xiao-c3', sub: '这块板还不能仿真，用 ESP32-C3 代替运行' };
