// 实验台 v2 外壳（顶栏 / 底部坞 / 台面浮层）的共享状态与动作（U-04）。
// 外壳只管画；数据由 main.tsx（会话、时间线）和各步骤填进来，动作由它们注册——外壳本身不认识 Session，
// 这样采购 / 组装 / 成品挂载时外壳照常画，只是对应的按钮灰掉。
import type { ReactNode } from 'react';
import { commit } from './react';
import { createStore } from './store';
import type { StepId } from './types';

export type DockTab = 'serial' | 'code' | 'analyzer' | 'runs' | 'checks' | 'issues' | 'usb';
export type RunState = 'loading' | 'run' | 'pause' | 'seek' | 'busy' | 'idle' | 'nofw';

export interface Issue {
  id: string;
  level: 'block' | 'warn';
  title: string;
  detail: string;
  go?: () => void;
}
export interface CpRow {
  id: string;
  title: string;
  /** ref = 参考固件跑通（◐，也解锁组装 / 成品），ok = 自己的固件通过（✓） */
  state: 'ok' | 'ref' | 'bad' | 'todo' | 'run';
  note: string;
}

export interface BenchChrome {
  /** 最近一次写进本机存储的时刻（ms）；null = 这个作品还没存过 */
  saved: number | null;
  /** 撤销 / 重做是否可用（只有实验台的时间线支持） */
  undo: boolean;
  redo: boolean;
  run: RunState;
  speed: number;
  /** 步骤锁：值是原因（title 显示） */
  locks: Partial<Record<StepId, string>>;
  done: Partial<Record<StepId, boolean>>;
  dock: { tab: DockTab; h: number; collapsed: boolean };
  runs: number;
  checkpoints: CpRow[];
  /** 组装后开机复测：null = 还没测；false = 没过（检查点卡不能还说"全部通过"） */
  retest: boolean | null;
  issues: Issue[];
  /** 加载内核时的进度（state 2）；null = 已就绪 */
  boot: { text: string; steps: { label: string; done: boolean }[]; loaded: number; total: number } | null;
  /** 台面上的浮层（连线横幅、万用表卡、校验卡、接错线卡、欠压横幅、检查点通过提示…） */
  overlays: Record<string, ReactNode>;
  /** 台面上正在跑的固件名（session.fwName：示例是 "<id>/flash.bin"，上传的是文件原名）；代码页签按它找源码 */
  fw: string;
  /** 台面左上的「桌面 · 室温」标签（实验台场景的环境温度）；null = 不显示 */
  room: number | null;
  /** 声音键：has = 台面上有蜂鸣器或喇叭（没有就不显示），on = 已出声（默认静音） */
  sound: { has: boolean; on: boolean };
  /** 固件枚举出了原生 USB 设备：坞里多一个「USB」页签（虚拟电脑） */
  usb: boolean;
  /** 台面上的芯片（换固件菜单默认列这颗芯片的示例） */
  chip: 'esp32c3' | 'esp32s3';
  /** 换固件菜单开着（顶栏按钮、空台面卡、手机 ⋯ 都能打开它） */
  fwMenu: boolean;
}

const DOCK_KEY = 'tryboard-app-dock';
function loadDock(): BenchChrome['dock'] {
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_KEY) ?? 'null');
    if (v && typeof v.h === 'number') return { tab: 'serial', h: Math.min(560, Math.max(120, v.h)), collapsed: !!v.collapsed };
  } catch {
    /* 隐私模式：用默认高度 */
  }
  return { tab: 'serial', h: 200, collapsed: false };
}

export const bc = createStore<BenchChrome>({
  saved: null,
  undo: false,
  redo: false,
  run: 'loading',
  speed: 1,
  locks: {},
  done: {},
  dock: loadDock(),
  runs: 0,
  checkpoints: [],
  retest: null,
  issues: [],
  boot: { text: '正在加载模拟器内核', steps: [], loaded: 0, total: 0 },
  overlays: {},
  fw: '',
  chip: 'esp32c3',
  fwMenu: false,
  room: null,
  sound: { has: false, on: false },
  usb: false,
});
export const setBc = (p: Partial<BenchChrome>) => commit(() => bc.set(p));

export function setDock(p: Partial<BenchChrome['dock']>) {
  const d = { ...bc.get().dock, ...p };
  setBc({ dock: d });
  // 坞高度是个人偏好，不是作品数据：只存高度和收起
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify({ h: d.h, collapsed: d.collapsed }));
  } catch {
    /* 隐私模式 */
  }
  syncDockVar();
}
export function syncDockVar() {
  const d = bc.get().dock;
  document.body.style.setProperty('--dock-desk', `${d.collapsed ? 38 : d.h}px`);
  // 分析仪是命令式节点、不在坞的 React 树里，靠这个类跟着藏
  document.body.classList.toggle('dock-collapsed', d.collapsed);
}

/** 台面浮层：key 相同就替换，node 为 null 就去掉 */
export function overlay(key: string, node: ReactNode | null) {
  const o = { ...bc.get().overlays };
  if (node == null) delete o[key];
  else o[key] = node;
  setBc({ overlays: o });
}

/** 外壳上的按钮做什么：由 main.tsx / 实验台注册，没注册的按钮灰掉 */
export const actions: {
  undo?: () => void;
  /** 采购步骤自己的撤销 / 重做（清单历史，与实验台时间线分开）：d = -1 撤销，+1 重做 */
  shopUndo?: (d: -1 | 1) => void;
  redo?: () => void;
  pause?: () => void;
  resume?: () => void;
  reboot?: () => void;
  speed?: (f: number) => void;
  sound?: () => void;
  /** 往 USB 串口（CDC-ACM）发字（进输入日志） */
  usbCdc?: (text: string) => void;
  pickFirmware?: (f: File) => void;
  /** 实验台在时：拿刚上传的固件验收当前检查点（选中的，或第一个没过的），返回关号；全过了 / 不在实验台返回 null */
  checkUpload?: (buf: ArrayBuffer, name: string) => string | null;
  /** 换回作品自带的参考固件（空白作品没有） */
  loadRef?: () => void;
  exportInputs?: () => void;
  brief?: () => void;
  uart?: (text: string) => void;
  selectCheckpoint?: (id: string) => void;
  /** 用内置固件走完全程：每个还没过的检查点取各自的参考固件验收（选板作品 = 演示固件），记 ◐ */
  runAllRef?: () => void;
  /** 选板作品检查点全过后打开真买卡（手机横幅的主按钮用） */
  openBuy?: () => void;
  analyzer?: (open: boolean) => void;
  /** 台面视角：顶 / 前 / 拉近 / 拉远 / 对准选中 */
  view?: (k: 'top' | 'front' | 'in' | 'out' | 'fit') => void;
} = {};

// 这一页开的是哪种台面（DESIGN_V2 §6.1–6.2）：空白作品只有「采购 / 实验台」两步，组装 / 成品不显示；
// 示例 = 空白作品 + 示例固件，面包屑写「实验台 / 示例 · X」
const PAGE_Q = new URLSearchParams(location.search);
export const BLANK = PAGE_Q.get('work') === 'blank';
export const EXAMPLE_ID = BLANK ? PAGE_Q.get('example') : null;
/** 选板作品（work=custom，U-17）也只有「采购 / 实验台」两步：检查点全过后是真买卡，不进组装 */
export const CUSTOM = PAGE_Q.get('work') === 'custom' && !PAGE_Q.get('example');
export const TWO_STEPS = BLANK || CUSTOM;
export const shownSteps = (): StepId[] => (TWO_STEPS ? ['shop', 'bench'] : ['shop', 'bench', 'assemble', 'product']);
