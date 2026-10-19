// BLE（C-01）：内核 tb_ble_json 的结构（core soc/src/ble 的 Ble::json / Phone::json / log_json），与解析。
// 虚拟控制器 + 虚拟手机都在内核里按模拟时间跑；网页只显示、只发命令（ble=<命令>，与命令行脚本同一种文本）。

export interface BleDevice {
  addr: string;
  name: string;
  rssi: number;
  connectable: boolean;
  uuids: string[];
}
export interface BleChar {
  uuid: string;
  name: string;
  handle: number;
  props: ('read' | 'write-nr' | 'write' | 'notify' | 'indicate')[];
  cccd: number | null;
  /** 最近一次读到 / 通知来的值（十六进制，空格分隔） */
  value: string;
  /** 认得的特征给出人话（"87%"、"72 bpm"） */
  text: string;
  notify: boolean;
  notes: number;
  /** 通知值的历史：[模拟毫秒, 数值] */
  hist: [number, number][];
}
export interface BleService {
  uuid: string;
  name: string;
  start: number;
  end: number;
  chars: BleChar[];
}
export interface PhoneView {
  state: 'idle' | 'scanning' | 'connecting' | 'connected';
  ready: boolean;
  busy: boolean;
  mtu: number;
  rssi: number;
  auto: boolean;
  target: string | null;
  devices: BleDevice[];
  services: BleService[];
}
export interface BleView {
  active: boolean;
  advertising: boolean;
  adv_name: string;
  connected: boolean;
  addr: string;
  log_seq: number;
  phone: PhoneView;
}
/** 空中日志一条：n 序号、t 模拟微秒、k 类别（adv / conn / att / phone / hci）、s 文字 */
export interface BleLine {
  n: number;
  t: number;
  k: string;
  s: string;
}

/** worker 发来的一次 BLE 更新（解析后） */
export interface BleUpdate {
  /** 0 = 固件没用 BLE，1 = 在跑，2 = 没认出 VHCI 边界 */
  state: number;
  view?: BleView;
  log: BleLine[];
  error?: string;
  reset?: boolean;
  cmdError?: string;
}

export function parseBle(state: number, json: string, reset?: boolean, cmdError?: string): BleUpdate {
  const u: BleUpdate = { state, log: [], reset, cmdError };
  if (!json) return u;
  const j = JSON.parse(json) as { view?: BleView; log?: BleLine[]; error?: string };
  u.view = j.view;
  u.log = j.log ?? [];
  u.error = j.error;
  return u;
}

/** 日志一行的方向（设计稿的三种：板子 → 广播 / 手机 → 板子 / 板子 → 手机，另有手机自己的动作） */
export function lineDir(l: BleLine): string {
  if (l.k === 'adv') return '板子 → 广播';
  if (l.s.startsWith('手机 →')) return '手机 → 板子';
  if (l.s.startsWith('固件 →')) return '板子 → 手机';
  if (l.k === 'conn') return l.s.startsWith('CONNECT_IND') ? '手机 → 板子' : '连接';
  if (l.k === 'hci') return '固件 ↔ 控制器';
  return '手机';
}

/** 去掉方向前缀，剩下要说的事 */
export function lineText(l: BleLine): string {
  return l.s.replace(/^(手机|固件) → /, '').replace(/^手机：/, '');
}

/** 16 位 UUID 的写法：0x180D；128 位原样 */
export const uuidLabel = (u: string) => (u.length === 4 ? `0x${u}` : u);
