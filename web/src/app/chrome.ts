// 实验台 v2 外壳（顶栏 / 底部坞 / 台面浮层）的共享状态与动作（U-04）。
// 外壳只管画；数据由 main.tsx（会话、时间线）和各步骤填进来，动作由它们注册——外壳本身不认识 Session，
// 这样采购 / 组装 / 成品挂载时外壳照常画，只是对应的按钮灰掉。
import type { ReactNode } from 'react';
import { commit } from './react';
import { createStore } from './store';
import type { StepId } from './types';

export type DockTab = 'serial' | 'code' | 'analyzer' | 'runs' | 'checks' | 'issues';
export type RunState = 'loading' | 'run' | 'pause' | 'seek' | 'busy' | 'idle';

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
  state: 'ok' | 'bad' | 'todo' | 'run';
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
  issues: Issue[];
  /** 加载内核时的进度（state 2）；null = 已就绪 */
  boot: { text: string; steps: { label: string; done: boolean }[]; loaded: number; total: number } | null;
  /** 台面上的浮层（连线横幅、万用表卡、校验卡、接错线卡、欠压横幅、检查点通过提示…） */
  overlays: Record<string, ReactNode>;
  /** 台面左上的「桌面 · 室温」标签（实验台场景的环境温度）；null = 不显示 */
  room: number | null;
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
  issues: [],
  boot: { text: '正在加载模拟器内核', steps: [], loaded: 0, total: 0 },
  overlays: {},
  room: null,
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
  document.body.style.setProperty('--dock-h', `${d.collapsed ? 38 : d.h}px`);
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
  redo?: () => void;
  pause?: () => void;
  resume?: () => void;
  reboot?: () => void;
  speed?: (f: number) => void;
  pickFirmware?: (f: File) => void;
  exportInputs?: () => void;
  brief?: () => void;
  uart?: (text: string) => void;
  selectCheckpoint?: (id: string) => void;
  analyzer?: (open: boolean) => void;
  /** 台面视角：顶 / 前 / 拉近 / 拉远 / 对准选中 */
  view?: (k: 'top' | 'front' | 'in' | 'out' | 'fit') => void;
} = {};
