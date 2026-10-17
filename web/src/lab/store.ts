// 实验台的界面状态（低频：选示例、上电、切视图、改接线）。命令式控制器（lab.ts）写，React 读。
// 每秒十次以上的东西（模拟时间、串口流、tick 帧、滑块被 3D 拖动）不进这里，直接写 DOM（ARCH「网页 2D 界面」）。
import { useSyncExternalStore } from 'react';
import type { ChipId, SceneSpec } from '../board3d';
import type { UsbView } from '../usb3d';

export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(f: () => void): () => void;
}

export function createStore<T extends object>(init: T): Store<T> {
  let s = init;
  const subs = new Set<() => void>();
  return {
    get: () => s,
    set(patch) {
      s = { ...s, ...patch };
      for (const f of subs) f();
    },
    subscribe(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

export const useStore = <T,>(st: Store<T>) => useSyncExternalStore(st.subscribe, st.get);

export interface AnalogControl {
  type: 'analog';
  pin: number;
  label: string;
  max_mv: number;
  value: number;
}

/** 面板上的一组滑块（由场景决定，见 lab.ts syncControls） */
export type Control = { kind: 'env' } | { kind: 'imu' } | { kind: 'analog'; c: AnalogControl } | { kind: 'audio'; spk: boolean; mic: boolean };

export type About = { kind: 'example'; title: string; about: string; chip: ChipId; tags: string[] } | { kind: 'custom'; name: string; kb: number };

export interface LabState {
  examples: { id: string; label: string }[];
  exampleId: string;
  /** 上传的固件名（下拉框里多一项"自定义：…"） */
  custom: string | null;
  /** 上电完成，运行 / 复位可点 */
  ready: boolean;
  running: boolean;
  chip: ChipId;
  about: About | null;
  scene: SceneSpec;
  controls: Control[];
  /** 每次重建滑块加一：滑块是非受控的，换 key 才按新初值重建 */
  controlsKey: number;
  /** 这个示例有装配视图 */
  asm: boolean;
  view: '3d' | 'asm';
  editorOpen: boolean;
  micSource: string;
  micStatus: string;
}

export const initialLab = (): LabState => ({
  examples: [],
  exampleId: '',
  custom: null,
  ready: false,
  running: false,
  chip: 'esp32c3',
  about: null,
  scene: { parts: [] },
  controls: [],
  controlsKey: 0,
  asm: false,
  view: '3d',
  editorOpen: false,
  micSource: 'sine1k.wav',
  micStatus: '',
});

/** USB 虚拟电脑面板的数据：设备状态节流到 ≤ 10 Hz 再通知 React；鼠标轨迹每个报告都记（画在 canvas 上） */
export function createUsbFeed() {
  let view: UsbView | null = null;
  const trail: [number, number][] = [];
  let lastReports = -1;
  let timer = 0;
  let last = 0;
  const subs = new Set<() => void>();
  const notify = () => {
    timer = 0;
    last = performance.now();
    for (const f of subs) f();
  };
  return {
    get: () => view,
    trail,
    update(v: UsbView | null) {
      view = v;
      if (v && v.mouse.reports !== lastReports) {
        lastReports = v.mouse.reports;
        trail.push([v.mouse.x, v.mouse.y]);
        if (trail.length > 300) trail.shift();
      }
      if (timer) return;
      const wait = 100 - (performance.now() - last);
      if (wait <= 0) notify();
      else timer = window.setTimeout(notify, wait);
    },
    reset() {
      clearTimeout(timer);
      view = null;
      trail.length = 0;
      lastReports = -1;
      notify();
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
export type UsbFeed = ReturnType<typeof createUsbFeed>;
