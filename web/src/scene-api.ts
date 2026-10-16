// 3D 台面与工作台外壳之间的约定。board3d.ts 实现，src/app/ 使用。
// 两边并行开发，先把接口定死；实现缺失时外壳要能降级（不报错，只是点不到针脚）。

/** 可被点中的东西。id 约定：
 *  零件：'board' | 'oled' | 'bme280' | 'servo' | 'gc9a01' | 'pot' | 'led:<pin>' | 'power'（舵机外接电源模块）
 *  针脚：开发板丝印名，如 'GPIO4' | 'GPIO48' | '3V3' | '5V' | 'GND'；模块针脚用 '<零件>:<丝印>'，如 'bme280:SDA'
 *  导线：'wire:<一端针脚>~<另一端针脚>'，如 'wire:GPIO8~bme280:SDA'
 *  按键：'BOOT' | 'RST' */
export type PickKind = 'part' | 'pin' | 'wire' | 'button';
export interface PickTarget { kind: PickKind; id: string }

export interface ScreenPoint { x: number; y: number }

export interface PinInfo {
  id: string;
  /** 丝印文字 */
  label: string;
  /** 这根针接了什么，例如 'SG90 信号'；没接为空 */
  role?: string;
}

export interface ScenePickApi {
  /** 点中（或点空白处时 null）；screen 是相对台面容器左上角的 CSS 像素 */
  onPick(cb: (t: PickTarget | null, screen: ScreenPoint) => void): void;
  /** 高亮一个目标：零件描边、针脚蓝圈 + 标签、导线加粗；null 取消 */
  highlight(t: PickTarget | null): void;
  /** 目标在台面容器里的屏幕坐标（给快捷卡片定位）；看不见时 null */
  project(t: PickTarget): ScreenPoint | null;
  /** 开发板上所有针脚（含未接的） */
  listPins(): PinInfo[];
  /** 接线规则检查结果：把导线标红并带一句说明；msg 为 null 取消 */
  setWireFault(wireId: string, msg: string | null): void;
  /** 热源靠近某个零件（只影响画面上的热晕，读数由环境值决定） */
  setHeat(partId: string | null): void;
  /** 两个目标之间画尺子标注（毫米）；null 取消 */
  measure(a: PickTarget | null, b?: PickTarget): number | null;
  /** 浅色（工作台默认）/ 深色主题 */
  setTheme(theme: 'light' | 'dark'): void;
}
