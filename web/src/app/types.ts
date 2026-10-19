// 工作台外壳的公共类型。四个步骤（采购 / 实验台 / 组装 / 成品）共用一个 selection、一个 store。
import type { CustomPlan } from './custom';
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
import type { ElecFrame, FromWorker, Harness, PinDevFrame, Snapshot } from '../worker';
import type { UsbView } from '../usb3d';
import type { WireMods } from './wiring';
import type { BenchHistory } from './benchhist';
import type { IoStore } from './iotrace';
import type { TaskStore } from './tasktrace';
import type { CaseParams } from './enclosure';
import type { ReactNode } from 'react';

export type StepId = 'shop' | 'bench' | 'assemble' | 'product';
export type NextState = 'go' | 'hot' | 'lock' | 'end';

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'shop', label: '采购' },
  { id: 'bench', label: '实验台' },
  { id: 'assemble', label: '组装' },
  { id: 'product', label: '成品' },
];

export type WorkId = 'weather' | 'spin' | 'lens' | 'usbkey' | 'lamp' | 'ruler' | 'tilt' | 'knob' | 'sonar' | 'blank' | 'imu' | 'touch' | 'custom';

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
  /** text 与命令行逐字一致；say / tag 是人话层（DESIGN_V2 §9） */
  rows: { ok: boolean | null; text: string; say?: string; tag?: string; dev?: string }[];
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
  /** 台面姿态（P2-03，倾斜滑块 / 拖 IMU / 成品转动），度 */
  pose: { pitch: number; roll: number; yaw: number };
  /** 固件串口最近一行 IMU 读数（s3-imu / s3-qmi8658 的 `IMU pitch= roll= … gyro=(…)`） */
  imu: { pitch: number; roll: number; gyro: [number, number, number] | null } | null;
  /** 触摸（P2-02）：最近一次手指位置；down = 还按着 */
  touch: { x: number; y: number; down: boolean } | null;
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
  /** 本机存档键（缺省 = id）；空白里开示例时是 blank:<示例>，不同示例的清单 / 台面互不覆盖 */
  key?: string;
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
  applyScene(scene: SceneSpec, power: { ext5v: boolean }, label?: string): void;
  /** 最近一次 applyScene 带的时间线说明（台面直接放零件时是「放 LED，接 GPIO5」；按清单摆时为空） */
  sceneLabel?: string;
  fwName: string;
  fwSize: number;
  chip: 'esp32c3' | 'esp32s3';
  levels: Level[];
  /** 最近一帧：PWM 占空比、彩灯、OLED */
  frame: { pwm: number[]; pwmFreq: number[]; gpio: number; enable: number; gpioHi: number; enableHi: number; rgb: number[] | null; strips: Record<number, number[][]>; oled: Uint8Array | null; lcd: Uint8Array | null; elec: ElecFrame | null; pins: PinDevFrame | null };
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
  /** 重新上电（顶栏运行组的「重启」） */
  reboot(): void;
  /** 换固件在台面上跑（用户拖进来的 .bin） */
  loadFirmware(buf: ArrayBuffer, name: string): void;
  pressBoot(down: boolean): void;
  /** 外接按键（面包板上的 key、成品小键盘）：按下接地 */
  pressPin(pin: number, down: boolean): void;
  /** 编码器（P2-01）：转 steps 格（正 = 顺时针）、按键；都进输入日志 */
  turnEncoder(steps: number): void;
  pressEncoder(down: boolean): void;
  /** 超声波（P2-04）：探头到障碍物的距离（cm，负数 = 拿走障碍物）；台面上的障碍物跟着挪 */
  setDistance(cm: number): void;
  /** 当前设的距离（cm） */
  distance: number;
  setEnv(e: Partial<Env>): void;
  /** 麦克风（INMP441）声源：测试 WAV 文件名 / 'silence' / 'live'（浏览器麦克风）；返回提示（失败时说明换回了什么） */
  micSource: string;
  setMicSource(src: string): Promise<string>;
  /** 电位器（示例的模拟输入滑块）：pin → mV；每次上电后重新施加 */
  analog: Map<number, number>;
  setAnalog(pin: number, mv: number): void;
  /** 台面上有没有 IMU（有才显示倾斜滑块、才能拖动） */
  hasImu(): boolean;
  /** 改姿态（P2-03）：施加到模拟器（拖动中带角速率，停下 150 ms 后补一次速率 0）、台面跟着倾斜 */
  setPose(p: { pitch: number; roll: number; yaw: number }): void;
  /** 触摸圆屏（P2-02）：x, y 屏幕像素 */
  touch(x: number, y: number, down: boolean): void;
  consoleText(): string;
  /** 逻辑分析仪事件（本次上电 / 回退重放以来），P1-05 */
  io: IoStore;
  /** FreeRTOS 任务时间线（本次上电 / 回退重放以来），C-04 */
  tasks: TaskStore;
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

/** 外壳里一块由步骤整块换内容的区域（构建树、属性面板、步骤层）。render 每次都重建（同原来整段 innerHTML 重画）；
 *  el 是容器节点，给命令式的 querySelector / 滚动用 */
export interface Panel {
  render(node: ReactNode): void;
  readonly el: HTMLElement;
}

export interface Shell {
  tree: Panel;
  props: Panel;
  /** 叠在台面上的步骤层（占位卡、采购平铺、组装 / 成品画面） */
  layer: Panel;
  toolbar: Toolbar;
  timeline: Timeline;
  card: Card;
  /** 右上结论按钮的文字与状态 */
  setVerdict(text: string, state: 'ok' | 'bad' | 'warn' | 'idle'): void;
  /** 点结论按钮做什么（每个步骤挂载时自己设） */
  onVerdict(fn: (() => void) | null): void;
  /** 右上"下一步"按钮：to 为 null 时置灰（锁着）；给了 onGo 就由它负责跳转。
   *  state：go = 随时能去（描边）、hot = 刚解锁该往前走了（实心）、lock = 锁着（灰 + 锁，label 写差什么）、end = 最后一步。缺省按 to 定 go / lock */
  setNext(label: string, to: StepId | null, why?: string, onGo?: () => void, state?: NextState): void;
  /** 只留台面中间的卡（左右两栏、运行组收起）；换步骤时自动复位 */
  setBare(on: boolean): void;
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
  /** work=custom：选板结果和按零件生成的检查点（含 manual 条目，U-17） */
  custom?: { plan: CustomPlan; levels: Level[] };
}

export interface StepImpl {
  /** 构建树 / 属性面板 / 步骤层都通过 ctx.shell 拿 */
  mount(ctx: StepCtx): void;
  unmount(): void;
}

export type { ScreenPoint };
