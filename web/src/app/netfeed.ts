// 底部坞「网络」页签的数据（C-02 / C-03）：worker 按版本号变了才发，这里合并后节流到 ≤ 10 Hz 再通知 React。
// 整页一份：session 推、坞里的页签读（和 usbFeed 同样的做法）。

/** 虚拟手机看到的（内核 phone.rs 的 json()） */
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
  /** null = 还没探测；false = 不需要登录；字符串 = 需要登录，登录页地址 */
  captive: null | false | string;
  seen: { ssid: string; bssid: string; ch: number; wpa2: boolean }[];
  pages: PhonePage[];
  log: [number, string][];
  busy: boolean;
}
/** 网络页签一行：[时刻 ms, 方法, 去向, 地址, 状态, 耗时 ms | null, 说明（C-03：真实网络失败原因等，老内核没有）] */
export type NetRow = [number, string, string, string, string, number | null, string?];

export interface NetView {
  /** 固件发过 Wi-Fi 帧：坞里出现「网络」页签 */
  used: boolean;
  /** null = 还没拿起虚拟手机 */
  phone: PhoneView | null;
  rows: NetRow[];
  total: number;
  /** 芯片从虚拟路由器拿到的地址（null = 还没拿到） */
  lease: string | null;
  /** 内核里「真实网络」是否开着（C-03） */
  realnet: boolean;
  /** 本次上电记下的真实网络回复条数 / 字节数（输入日志里的 netreply） */
  replies: number;
  replyBytes: number;
}

function createNetFeed() {
  const empty = (): NetView => ({ used: false, phone: null, rows: [], total: 0, lease: null, realnet: false, replies: 0, replyBytes: 0 });
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
        const r = m.rows ? (JSON.parse(m.rows) as { total: number; lease: string | null; realnet?: boolean; rows: NetRow[] }) : { total: 0, lease: null, rows: [] };
        v.rows = r.rows;
        v.total = r.total;
        v.lease = r.lease;
        v.realnet = !!r.realnet;
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

/**
 * 「真实网络」开关（C-03）：整页一份，默认关、不存本机（每次打开页面都从虚拟网络开始）。
 * 开着时实时运行由 worker 代发、检查点验收也带上（结论标「依赖外网」，不记运行编号）。
 */
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
