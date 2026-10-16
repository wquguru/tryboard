// 工作台外壳的公共类型。四个步骤（采购 / 实验台 / 组装 / 成品）共用一个 selection、一个 store。
import type { Bench, SceneSpec } from '../board3d';
import type { ScenePickApi, ScreenPoint } from '../scene-api';
import type { LiveSim } from '../live';
import type { Level } from '../checks';
import type { Store } from './store';
import type { Timeline } from './timeline';
import type { Toolbar } from './toolbar';
import type { Card } from './card';
import type { BomHistory } from './bom';

export type StepId = 'shop' | 'bench' | 'assemble' | 'product';
export const STEPS: { id: StepId; label: string }[] = [
  { id: 'shop', label: '采购' },
  { id: 'bench', label: '实验台' },
  { id: 'assemble', label: '组装' },
  { id: 'product', label: '成品' },
];

export type WorkId = 'weather' | 'spin' | 'lens' | 'blank';

/** 选中的对象。kind 与构建树的分组一一对应；pin / wire / button 来自台面拾取 */
export type SelKind = 'part' | 'wire' | 'power' | 'env' | 'firmware' | 'checkpoint' | 'pin' | 'button';
export interface Selection {
  kind: SelKind;
  id: string;
}

export interface Env {
  temp: number;
  humidity: number;
  pressure: number;
}

/** 一次验收的结果（检查点属性面板、结论按钮、时间线共用） */
export interface CheckOutcome {
  ok: boolean;
  who: string;
  /** 是否用户自己的固件（只有自己的固件通过才算进度） */
  own: boolean;
  rows: { ok: boolean | null; text: string }[];
  fingerprint: string;
  sim: number;
}

export interface AppState {
  work: WorkId;
  step: StepId;
  selection: Selection | null;
  env: Env;
  /** 实时模拟：第几次运行（每次上电 +1）、模拟时间、是否在跑 */
  run: number;
  simSeconds: number;
  running: boolean;
  /** 最近一次串口读数（BME280 那行 T= H= P=） */
  reading: { t: number; h: number; p: number } | null;
  /** 检查点验收：key 是关卡 id */
  checks: Record<string, CheckOutcome>;
  /** 正在验收的检查点（同一时间只跑一个） */
  verifying: string | null;
  verifyProgress: number;
  /** 采购清单的操作日志（清单由它重放，见 bom.ts）；存 localStorage 'tryboard-app-shop:<work>' */
  bom: BomHistory;
  /** 实验台场景换过几次（"摆上实验台"每次 +1，时间线据此记一步） */
  sceneRev: number;
}

export interface WorkDef {
  id: WorkId;
  title: string;
  /** 示例 id（firmware/examples.json），blank 为空 */
  example: string | null;
  /** 检查点：levels.json 的关卡 id（含 07-spin 这样的子关） */
  checkpoints: string[];
}

/** 实时模拟与 3D 台面：整页只有一份，切步骤不重建 */
export interface Session {
  bench: Bench;
  pick: Partial<ScenePickApi>;
  sim: LiveSim | null;
  scene: SceneSpec;
  /** 供电：null = 作品默认台面（只显示 USB 5 V）；从清单摆上来时记下有没有外接 5 V */
  power: { ext5v: boolean } | null;
  /** 按清单换台面（P0-09）：重建外接元件；I2C / 圆屏变了就带着当前固件重新上电 */
  applyScene(scene: SceneSpec, power: { ext5v: boolean }): void;
  fwName: string;
  fwSize: number;
  chip: 'esp32c3' | 'esp32s3';
  levels: Level[];
  /** 最近一帧：PWM 占空比、彩灯、OLED */
  frame: { pwm: number[]; rgb: number[] | null; oled: Uint8Array | null };
  /** 重新上电（"再跑一次"） */
  reboot(): void;
  /** 换固件在台面上跑（用户拖进来的 .bin） */
  loadFirmware(buf: ArrayBuffer, name: string): void;
  pressBoot(down: boolean): void;
  setEnv(e: Partial<Env>): void;
  consoleText(): string;
}

export interface Shell {
  tree: HTMLElement;
  props: HTMLElement;
  toolbar: Toolbar;
  timeline: Timeline;
  card: Card;
  /** 右上结论按钮的文字与状态 */
  setVerdict(text: string, state: 'ok' | 'bad' | 'warn' | 'idle'): void;
  /** 右上"下一步"按钮：to 为 null 时置灰；给了 onGo 就由它负责跳转 */
  setNext(label: string, to: StepId | null, why?: string, onGo?: () => void): void;
  /** 底部一行提示（几秒后消失） */
  toast(text: string): void;
  /** 台面容器（快捷卡片坐标相对它） */
  stage: HTMLElement;
}

export interface StepCtx {
  work: WorkDef;
  store: Store<AppState>;
  session: Session;
  shell: Shell;
}

export interface StepImpl {
  /** el 是叠在台面上的步骤层（占位面板放这里）；构建树 / 属性面板通过 ctx.shell 拿 */
  mount(el: HTMLElement, ctx: StepCtx): void;
  unmount(): void;
}

export type { ScreenPoint };
