// Data for the dock's Network tab (C-02 / C-03): sent by the worker only on version change, merged and throttled to <= 10 Hz here.
// One per page: the session pushes, the dock tab reads (same approach as usbFeed).

/** What the virtual phone sees (the core's phone.rs json()) */
export interface PhonePage {
  method: string;
  url: string;
  status: number;
  location: string;
  title: string;
  text: string;
  action: string;
  form_method: string;
  fields: string[];
  len: number;
  error: string;
}
export interface PhoneView {
  /** off / scan / auth / assoc / eapol / up */
  link: string;
  ssid: string;
  ip: string | null;
  gw: string;
  /** null = not probed yet; false = no sign-in needed; string = sign-in needed, the portal page address */
  captive: null | false | string;
  seen: { ssid: string; bssid: string; ch: number; wpa2: boolean }[];
  pages: PhonePage[];
  log: [number, string][];
  busy: boolean;
}
/** One Network tab row: [time ms, method, destination, address, status, duration ms | null, note (C-03: why the real network failed etc.; old cores have none)] */
export type NetRow = [number, string, string, string, string, number | null, string?];

export interface NetView {
  /** The firmware sent Wi-Fi frames: the Network tab shows up in the dock */
  used: boolean;
  /** null = the virtual phone has not been picked up yet */
  phone: PhoneView | null;
  rows: NetRow[];
  total: number;
  /** Address the chip got from the virtual router (null = not yet) */
  lease: string | null;
  /** Whether the core's "real network" is on (C-03) */
  realnet: boolean;
  /** Count / bytes of real-network replies recorded this power-on (netreply in the input log) */
  replies: number;
  replyBytes: number;
  /** Network conditions summary (D-01); null while preset is normal and no fault was scheduled */
  cond: NetCond | null;
}
/** The core's network-conditions summary (tb_net_json cond, same numbers as the CLI's "[tryboard] network" line) */
export interface NetCond {
  preset: string;
  seed: number;
  faults: number;
  disconnects: number;
  /** Outage length of the latest reconnect (ms); null = not reconnected (yet) */
  reconnect_ms: number | null;
  /** Currently disconnected by an injected condition */
  lost: boolean;
  ok: number;
  failed: number;
  lost_frames: number;
}

function createNetFeed() {
  const empty = (): NetView => ({ used: false, phone: null, rows: [], total: 0, lease: null, realnet: false, replies: 0, replyBytes: 0, cond: null });
  let view: NetView = empty();
  let timer = 0;
  let last = 0;
  const subs = new Set<() => void>();
  const notify = () => {
    timer = 0;
    last = performance.now();
    for (const f of subs) f();
  };
  const schedule = () => {
    if (timer) return;
    const wait = 100 - (performance.now() - last);
    if (wait <= 0) notify();
    else timer = window.setTimeout(notify, wait);
  };
  return {
    get: () => view,
    update(m: { used: boolean; phone?: string; rows?: string; replies?: number; replyBytes?: number }) {
      const v: NetView = { ...view, used: m.used };
      if (m.phone !== undefined) v.phone = m.phone ? (JSON.parse(m.phone) as PhoneView) : null;
      if (m.rows !== undefined) {
        const r = m.rows ? (JSON.parse(m.rows) as { total: number; lease: string | null; realnet?: boolean; cond?: NetCond | null; rows: NetRow[] }) : { total: 0, lease: null, rows: [] };
        v.rows = r.rows;
        v.total = r.total;
        v.lease = r.lease;
        v.realnet = !!r.realnet;
        v.cond = r.cond ?? null;
        v.replies = m.replies ?? 0;
        v.replyBytes = m.replyBytes ?? 0;
      }
      view = v;
      schedule();
    },
    reset() {
      clearTimeout(timer);
      view = empty();
      notify();
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
export type NetFeed = ReturnType<typeof createNetFeed>;
export const netFeed = createNetFeed();

/** "Real network" switch (C-03): one per page, off by default, not stored (every page load starts virtual).
 * When on, the worker relays live runs and checkpoints use it too (verdict "needs internet", no run ID). */
function createRealnetSwitch() {
  let on = false;
  const subs = new Set<() => void>();
  return {
    get: () => on,
    set(v: boolean) {
      if (v === on) return;
      on = v;
      for (const f of subs) f();
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
export const realnetSwitch = createRealnetSwitch();

/** Network preset (D-01): one per page, normal by default, survives power-ons (logged as net=… at time 0), not stored */
export type NetPresetName = 'normal' | 'weak' | 'flaky' | 'offline';
function createNetPreset() {
  let v: NetPresetName = 'normal';
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(n: NetPresetName) {
      if (n === v) return;
      v = n;
      for (const f of subs) f();
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
export const netPreset = createNetPreset();
