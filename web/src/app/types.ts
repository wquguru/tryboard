// 工作台外壳的公共类型。四个步骤（采购 / 实验台 / 组装 / 成品）共用一个 selection、一个 store。
import type { Bench, SceneSpec } from '../board3d';
import type { ScenePickApi, ScreenPoint } from '../scene-api';
import type { LiveSim } from '../live';
import type { BuzzerAudio } from '../audio';
import type { Effects } from '../views/templates';
import type { Level } from '../checks';
import type { Store } from './store';
import type { Timeline } from './timeline';
import type { Toolbar } from './toolbar';
import type { Card } from './card';
import type { BomHistory } from './bom';
import type { SeekJob } from '../live';
import type { ElecFrame, FromWorker, Harness, Snapshot } from '../worker';
import type { UsbView } from '../usb3d';
import type { WireMods } from './wiring';
import type { BenchHistory } from './benchhist';
import type { IoStore } from './iotrace';
import type { CaseParams } from './enclosure';

export type StepId = 'shop' | 'bench' | 'assemble' | 'product';
export const STEPS: { id: StepId; label: string }[] = [
  { id: 'shop', label: '采购' },
  { id: 'bench', label: '实验台' },
  { id: 'assemble', label: '组装' },
  { id: 'product', label: '成品' },
];

export type WorkId = 'weather' | 'spin' | 'lens' | 'usbkey' | 'blank';

/** 选中的对象。kind 与构建树的分组一一对应；pin / wire / button 来自台面拾取 */
export type SelKind = 'part' | 'wire' | 'power' | 'env' | 'firmware' | 'checkpoint' | 'pin' | 'button' | 'run' | 'tool';
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
  /** 实验台编辑状态（供电、热源、改接线、回退恢复的场景）变了就 +1，面板据此重画 */
  editRev: number;
  /** 时间线上的运行编号（回退后再跑会复用编号；run 是整页上电次数，只增不减） */
  runNo: number;
  /** 时间线：步数、当前停在第几步、是否停在回退点、正在回退 */
  hist: { n: number; cur: number; seeked: boolean; busy: boolean; runs: number };
  /** 组装步骤的结果（成品步骤读它）：null = 还没开始装 */
  assembly: AssemblyState | null;
  /** 参数化外壳（P1-08）：高度、壁厚、圆角；采购页外壳详情改，组装步骤按它生成外壳。存 localStorage 'tryboard-app-case:<work>' */
  caseParams: CaseParams;
}

export interface AssemblyState {
  placed: string[];
  choice: Record<string, string>;
  total: number;
  /** 装完且没有警告 */
  clean: boolean;
  effects: Effects;
  /** 最近一次开机复测：null = 还没测 */
  retest: boolean | null;
}

export interface WorkDef {
  id: WorkId;
  title: string;
  /** 示例 id（firmware/examples.json），blank 为空 */
  example: string | null;
  /** 检查点：levels.json 的关卡 id（含 07-spin 这样的子关） */
  checkpoints: string[];
  /** 首页作品卡（没有就不上首页，比如空白实验台） */
  card?: { chip: string; blurb: string };
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
  frame: { pwm: number[]; pwmFreq: number[]; gpio: number; enable: number; gpioHi: number; enableHi: number; rgb: number[] | null; oled: Uint8Array | null; lcd: Uint8Array | null; elec: ElecFrame | null };
  /** 热源靠近的零件（只是显示；读数由环境温度决定） */
  heat: string | null;
  setHeat(part: string | null): void;
  /** USB ↔ 外接 5 V：改清单、供电显示，并在线切换供电网络（进输入日志） */
  setPower(ext5v: boolean): void;
  /** 欠压复位（模拟时刻，秒） */
  onBrownout(cb: (tSec: number) => void): () => void;
  /** 改接线（给接线规则检查造错误接线） */
  wireMods: WireMods;
  setWireMods(m: WireMods): void;
  /** 回退用：直接换场景显示，不重新上电（模拟器状态由 seek 负责） */
  restoreScene(scene: SceneSpec, power: { ext5v: boolean } | null): void;
  onTick(cb: (m: Extract<FromWorker, { type: 'tick' }>) => void): () => void;
  onBoot(cb: () => void): () => void;
  onRunEnd(cb: (snap: Snapshot) => void): () => void;
  /** 整页上电过几次 */
  bootCount: number;
  snapshot(): Promise<Snapshot | null>;
  mark(): Promise<number>;
  seek(job: SeekJob): Promise<Snapshot>;
  continueRun(): void;
  /** 台面上正在跑的固件镜像（参考固件或用户拖进来的） */
  fwBuf: ArrayBuffer | null;
  /** 蜂鸣器出声（默认静音），接在实时模拟的 PWM 事件上 */
  audio: BuzzerAudio;
  /** 装法带来的传感器偏移（℃），只在成品步骤里生效 */
  sensorOffset: number;
  setSensorOffset(d: number): void;
  /** 订阅串口新文本，返回取消函数 */
  onConsole(cb: (text: string) => void): () => void;
  /** 重新上电（"再跑一次"） */
  reboot(): void;
  /** 换固件在台面上跑（用户拖进来的 .bin） */
  loadFirmware(buf: ArrayBuffer, name: string): void;
  pressBoot(down: boolean): void;
  /** 外接按键（面包板上的 key、成品小键盘）：按下接地 */
  pressPin(pin: number, down: boolean): void;
  setEnv(e: Partial<Env>): void;
  consoleText(): string;
  /** 逻辑分析仪事件（本次上电 / 回退重放以来），P1-05 */
  io: IoStore;
  /** 事件仓库有新事件或被 reset */
  onIo(cb: () => void): () => void;
  /** 正在观察的 GPIO（PWM / WS2812 / I2C 不受它限制） */
  ioPins(): number[];
  /** 改观察的 GPIO：立刻生效（之前没观察的引脚从此刻起才有记录），之后每次上电沿用 */
  watchIo(pins: number[]): void;
  /** 线束（P2-11，估算）：I2C 排线总长、天线遮挡；在线生效并进输入日志，之后每次上电沿用 */
  harness: Harness;
  setHarness(h: Harness): void;
  /** 线束结论（模拟器给的文字：上升时间 / RSSI），没设就是空 */
  harnessText: string;
  onHarness(cb: (text: string) => void): () => void;
  /** 原生 USB 虚拟主机看到的（P2-12）；null = 没有 USB 设备 */
  usb: UsbView | null;
  onUsb(cb: (v: UsbView | null) => void): () => void;
}

export interface Shell {
  tree: HTMLElement;
  props: HTMLElement;
  toolbar: Toolbar;
  timeline: Timeline;
  card: Card;
  /** 右上结论按钮的文字与状态 */
  setVerdict(text: string, state: 'ok' | 'bad' | 'warn' | 'idle'): void;
  /** 点结论按钮做什么（每个步骤挂载时自己设） */
  onVerdict(fn: (() => void) | null): void;
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
  /** 实验台时间线（P0-03）；只有实验台用 */
  hist?: BenchHistory;
}

export interface StepImpl {
  /** el 是叠在台面上的步骤层（占位面板放这里）；构建树 / 属性面板通过 ctx.shell 拿 */
  mount(el: HTMLElement, ctx: StepCtx): void;
  unmount(): void;
}

export type { ScreenPoint };
