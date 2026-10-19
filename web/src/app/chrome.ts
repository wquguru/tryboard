// Bench v2 shell state and actions (U-04). The shell only draws; steps fill data and register actions, so it never
// knows the Session and still renders under Shop/Assemble/Product with unregistered buttons greyed out.
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { commit } from './react';
import { createStore } from './store';
import type { StepId } from './types';

export type DockTab = 'serial' | 'code' | 'analyzer' | 'runs' | 'checks' | 'issues' | 'usb' | 'tasks' | 'ble' | 'net';
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
  /** ref = passed with reference firmware (◐, still unlocks assembly), ok = own firmware passed (✓). */
  state: 'ok' | 'ref' | 'bad' | 'todo' | 'run';
  note: string;
}

export interface BenchChrome {
  /** Last local save time in ms; null = never saved. */
  saved: number | null;
  /** Undo/redo availability (only the bench timeline supports it). */
  undo: boolean;
  redo: boolean;
  run: RunState;
  speed: number;
  /** Step locks; the value is the reason (shown as title). */
  locks: Partial<Record<StepId, string>>;
  done: Partial<Record<StepId, boolean>>;
  dock: { tab: DockTab; h: number; collapsed: boolean };
  runs: number;
  checkpoints: CpRow[];
  /** Post-assembly retest: null = not run; false = failed (so the card cannot claim all passed). */
  retest: boolean | null;
  issues: Issue[];
  /** Core loading progress (state 2); null = ready. */
  boot: { text: string; steps: { label: string; done: boolean }[]; loaded: number; total: number } | null;
  /** Stage overlays (wiring banner, multimeter, verify card, miswire card, brownout banner, checkpoint toast...). */
  overlays: Record<string, ReactNode>;
  /** Running firmware name (session.fwName: "<id>/flash.bin" or the uploaded file name); the code tab finds sources by it. */
  fw: string;
  /** Top-left "Desk · room" chip temperature; null = hidden. */
  room: number | null;
  /** Sound key: has = a buzzer/speaker is on the bench (else hidden), on = unmuted (muted by default). */
  sound: { has: boolean; on: boolean };
  /** Firmware enumerated a native USB device: the dock gains a USB tab (virtual PC). */
  usb: boolean;
  /** Firmware uses BLE (VHCI boundary found or not): dock gains a Bluetooth tab, build tree a Wireless group (C-01). */
  ble: boolean;
  /** Firmware uses Wi-Fi: the dock gets a Network tab (phone provisioning, request log; C-02 / C-03) */
  net: boolean;
  /** Bench chip (the firmware menu lists this chip's examples first). */
  chip: 'esp32' | 'esp32c3' | 'esp32s3';
  /** Firmware menu open (from the top bar, empty-stage card or phone ⋯). */
  fwMenu: boolean;
}

const DOCK_KEY = 'tryboard-app-dock';
function loadDock(): BenchChrome['dock'] {
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_KEY) ?? 'null');
    if (v && typeof v.h === 'number') return { tab: 'serial', h: Math.min(560, Math.max(120, v.h)), collapsed: !!v.collapsed };
  } catch {
    /* Private mode: default height. */
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
  boot: { text: t('Loading the simulator core'), steps: [], loaded: 0, total: 0 },
  overlays: {},
  fw: '',
  chip: 'esp32c3',
  fwMenu: false,
  room: null,
  sound: { has: false, on: false },
  usb: false,
  ble: false,
  net: false,
});
export const setBc = (p: Partial<BenchChrome>) => commit(() => bc.set(p));

export function setDock(p: Partial<BenchChrome['dock']>) {
  const d = { ...bc.get().dock, ...p };
  setBc({ dock: d });
  // Dock size is a personal preference, not work data: store only height and collapsed.
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify({ h: d.h, collapsed: d.collapsed }));
  } catch {
    /* Private mode. */
  }
  syncDockVar();
}
export function syncDockVar() {
  const d = bc.get().dock;
  document.body.style.setProperty('--dock-desk', `${d.collapsed ? 38 : d.h}px`);
  // The analyzer is an imperative node outside the dock's React tree; this class hides it too.
  document.body.classList.toggle('dock-collapsed', d.collapsed);
}

/** Stage overlay: same key replaces, null removes. */
export function overlay(key: string, node: ReactNode | null) {
  const o = { ...bc.get().overlays };
  if (node == null) delete o[key];
  else o[key] = node;
  setBc({ overlays: o });
}

/** Shell button handlers, registered by main.tsx / bench; unregistered buttons are greyed out. */
export const actions: {
  undo?: () => void;
  /** Shop's own undo/redo (list history, separate from the bench timeline): -1 undo, +1 redo. */
  shopUndo?: (d: -1 | 1) => void;
  redo?: () => void;
  pause?: () => void;
  resume?: () => void;
  reboot?: () => void;
  speed?: (f: number) => void;
  sound?: () => void;
  /** Send text to USB serial (CDC-ACM); goes into the input log. */
  usbCdc?: (text: string) => void;
  /** Virtual phone op (ble=<cmd>); goes into the input log. */
  ble?: (cmd: string) => void;
  /** One step on the virtual phone (phone= action, recorded in the input log) */
  phone?: (cmd: string) => void;
  /** One network fault from now (D-01: reboot / dns / silent, netfault= action in the input log) */
  netFault?: (kind: string) => void;
  pickFirmware?: (f: File) => void;
  /** On the bench: verify the selected (or first failing) checkpoint with the upload; returns its id, or null. */
  checkUpload?: (buf: ArrayBuffer, name: string) => string | null;
  /** Switch back to the work's reference firmware (blank works have none). */
  loadRef?: () => void;
  /** realnet: the Network tab's "save replies, replay offline" (same input log, file name gets -realnet, C-03) */
  exportInputs?: (kind?: 'realnet') => void;
  brief?: () => void;
  uart?: (text: string) => void;
  selectCheckpoint?: (id: string) => void;
  /** Run every unpassed checkpoint with its reference firmware (custom works: demo firmware), marked ◐. */
  runAllRef?: () => void;
  /** Open the buy card once a custom work passes all checkpoints (phone banner primary button). */
  openBuy?: () => void;
  analyzer?: (open: boolean) => void | Promise<void>;
  /** Stage view: top / front / zoom in / zoom out / fit selection. */
  view?: (k: 'top' | 'front' | 'in' | 'out' | 'fit') => void;
} = {};

// Page kind (DESIGN_V2 §6.1–6.2): blank works only have Shop/Bench steps; an example is a blank work + example firmware.
const PAGE_Q = new URLSearchParams(location.search);
export const BLANK = PAGE_Q.get('work') === 'blank';
export const EXAMPLE_ID = BLANK ? PAGE_Q.get('example') : null;
/** Custom works (work=custom, U-17) are also two-step: passing all checkpoints leads to the buy card, not assembly. */
export const CUSTOM = PAGE_Q.get('work') === 'custom' && !PAGE_Q.get('example');
export const TWO_STEPS = BLANK || CUSTOM;
export const shownSteps = (): StepId[] => (TWO_STEPS ? ['shop', 'bench'] : ['shop', 'bench', 'assemble', 'product']);
