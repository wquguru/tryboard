// FreeRTOS 任务时间线的数据层（C-04）：解内核的任务切换记录（tb_tasks_take 的 16 字节）、切成"在跑"切片、
// 算 CPU 占用、导出 Chrome Trace Event JSON（Perfetto 能打开），可选解析 app.elf 的函数符号。
// 纯函数 + 一个只追加的仓库，node --test 直接测。切片和 JSON 与 Rust 侧
// core/crates/esp32c3/src/tasktrace.rs 的 report 模块同一算法、同一格式（tools/webtest/tasks.mjs 对拍）。

export const CPU_HZ = 160_000_000;
export const NO_TASK = 0xffff;
export const EVENT_BYTES = 16;

/** 被切出任务的状态（与 Rust state::* 相同） */
export const ST = { NONE: 0, READY: 1, WAIT: 2, BLOCKED: 3, GONE: 4 } as const;
export const stateName = (s: number) => (['-', 'ready', 'wait', 'blocked', 'gone'][s] ?? '-');

export interface TaskEvent {
  /** CPU 周期 */
  t: number;
  core: number;
  /** 被切出任务此刻的状态 */
  prev: number;
  /** 换上来的任务（任务表下标），NO_TASK = 核上没有任务（复位） */
  task: number;
  /** 换上来的任务从哪里继续 */
  pc: number;
}

export interface TaskRow {
  name: string;
  prio: number;
  /** 绑定的核；-1 = 不绑定或单核 */
  core: number;
  tcb: number;
}

export interface Slice {
  core: number;
  task: number;
  t0: number;
  t1: number;
  /** 这段结束时任务的状态（跑到结尾 = NONE） */
  end: number;
  pc: number;
}

export function decodeTaskEvents(buf: Uint8Array): TaskEvent[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: TaskEvent[] = [];
  for (let o = 0; o + EVENT_BYTES <= buf.byteLength; o += EVENT_BYTES) {
    const t = dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;
    out.push({ t, core: dv.getUint8(o + 8), prev: dv.getUint8(o + 9), task: dv.getUint16(o + 10, true), pc: dv.getUint32(o + 12, true) });
  }
  return out;
}

/** 事件序列 → 每核的在跑切片；end = 此刻（收尾还没结束的切片） */
export function slices(ev: readonly TaskEvent[], end: number): Slice[] {
  const open: (Slice | null)[] = [null, null];
  const out: Slice[] = [];
  for (const e of ev) {
    const c = Math.min(e.core, 1);
    const s = open[c];
    if (s) {
      s.t1 = e.t;
      s.end = e.prev;
      out.push(s);
      open[c] = null;
    }
    if (e.task !== NO_TASK) open[c] = { core: e.core, task: e.task, t0: e.t, t1: e.t, end: ST.NONE, pc: e.pc };
  }
  for (const s of open) if (s) out.push({ ...s, t1: Math.max(end, s.t0) });
  out.sort((a, b) => a.t0 - b.t0 || a.core - b.core);
  return out;
}

/** [from, to) 内每核每任务跑了多少周期：key = `${核}:${任务}` */
export function usage(sl: readonly Slice[], from = 0, to = Infinity): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sl) {
    const a = Math.max(s.t0, from);
    const b = Math.min(s.t1, to);
    if (b <= a) continue;
    const k = `${s.core}:${s.task}`;
    m.set(k, (m.get(k) ?? 0) + b - a);
  }
  return m;
}

const esc = (s: string) => s.replace(/["\\\u0000-\u001f]/g, (c) => (c === '"' ? '\\"' : c === '\\' ? '\\\\' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
const hex8 = (v: number) => (v >>> 0).toString(16).padStart(8, '0');

/** Chrome Trace Event JSON：进程 1「CPU」每核一条轨道（切片名 = 任务名），进程 2「任务」每任务一条轨道（在跑 / 等待）。
 *  与 Rust report::chrome_json 逐字相同；func 把恢复处 PC 翻成函数名（没有 ELF 返回 undefined） */
export function chromeJson(tasks: readonly TaskRow[], sl: readonly Slice[], chip: string, cores: number, hz: number, func: (a: number) => string | undefined = () => undefined): string {
  // 周期 → 微秒 3 位小数：整数算、半数进位，与 Rust 逐字相同（toFixed 与 Rust {:.3} 在 .5 上舍入不同）
  const H = BigInt(hz);
  const us = (c: number) => {
    const ns = (BigInt(c) * 2_000_000_000n + H) / (2n * H);
    return `${ns / 1000n}.${(ns % 1000n).toString().padStart(3, '0')}`;
  };
  const v: string[] = [];
  v.push(`{"ph":"M","pid":1,"name":"process_name","args":{"name":"${esc(chip)} CPU"}}`);
  v.push(`{"ph":"M","pid":2,"name":"process_name","args":{"name":"任务"}}`);
  for (let c = 0; c < cores; c++) v.push(`{"ph":"M","pid":1,"tid":${c},"name":"thread_name","args":{"name":"核 ${c}"}}`);
  tasks.forEach((t, i) => v.push(`{"ph":"M","pid":2,"tid":${i + 10},"name":"thread_name","args":{"name":"${esc(t.name)}"}}`));
  const lastOut = new Map<number, [number, number]>();
  for (const s of sl) {
    const n = esc(tasks[s.task]?.name ?? '?');
    const f = func(s.pc);
    const fs = f !== undefined ? `,"resume":"${esc(f)}"` : '';
    v.push(`{"ph":"X","pid":1,"tid":${s.core},"name":"${n}","cat":"task","ts":${us(s.t0)},"dur":${us(s.t1 - s.t0)},"args":{"prio":${tasks[s.task]?.prio ?? 0},"pc":"0x${hex8(s.pc)}"${fs},"out":"${stateName(s.end)}"}}`);
    const lo = lastOut.get(s.task);
    if (lo && lo[1] === ST.WAIT && s.t0 > lo[0]) v.push(`{"ph":"X","pid":2,"tid":${s.task + 10},"name":"等待","cat":"wait","ts":${us(lo[0])},"dur":${us(s.t0 - lo[0])}}`);
    v.push(`{"ph":"X","pid":2,"tid":${s.task + 10},"name":"核 ${s.core}","cat":"run","ts":${us(s.t0)},"dur":${us(s.t1 - s.t0)}}`);
    lastOut.set(s.task, [s.t1, s.end]);
  }
  return `{"displayTimeUnit":"ms","traceEvents":[\n${v.join(',\n')}\n]}\n`;
}

/** app.elf 的函数符号（.symtab 里 STT_FUNC），按地址排好；不是 32 位小端 ELF 或没有符号表返回 null */
export interface Sym {
  a: number;
  size: number;
  name: string;
}
export function elfFuncs(buf: ArrayBuffer): Sym[] | null {
  const b = new Uint8Array(buf);
  if (b.length < 52 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46 || b[4] !== 1 || b[5] !== 1) return null;
  const dv = new DataView(buf);
  const shoff = dv.getUint32(0x20, true);
  const shentsize = dv.getUint16(0x2e, true);
  const shnum = dv.getUint16(0x30, true);
  const sh = (i: number) => {
    const o = shoff + i * shentsize;
    return { type: dv.getUint32(o + 4, true), off: dv.getUint32(o + 16, true), size: dv.getUint32(o + 20, true), link: dv.getUint32(o + 24, true), entsize: dv.getUint32(o + 36, true) };
  };
  if (shoff + shnum * shentsize > b.length) return null;
  const dec = new TextDecoder();
  for (let i = 0; i < shnum; i++) {
    const s = sh(i);
    if (s.type !== 2) continue;
    const str = sh(s.link);
    const out: Sym[] = [];
    const es = s.entsize || 16;
    for (let o = s.off; o + 16 <= s.off + s.size && o + 16 <= b.length; o += es) {
      if ((dv.getUint8(o + 12) & 0xf) !== 2) continue;
      const no = str.off + dv.getUint32(o, true);
      let e = no;
      while (e < b.length && b[e] !== 0) e++;
      out.push({ a: dv.getUint32(o + 4, true), size: dv.getUint32(o + 8, true), name: dec.decode(b.subarray(no, e)) });
    }
    out.sort((x, y) => x.a - y.a);
    return out;
  }
  return null;
}
/** 地址所在函数（大小为 0 的符号只认起点之后 4KB 内） */
export function funcAt(syms: readonly Sym[], a: number): string | undefined {
  let lo = 0;
  let hi = syms.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (syms[m].a <= a) lo = m + 1;
    else hi = m;
  }
  const s = syms[lo - 1];
  if (!s) return undefined;
  return a < s.a + (s.size || 4096) ? s.name : undefined;
}

/** 整页一份的任务时间线仓库：跟着每次上电 / 回退重放 reset；事件只追加（太多时丢最早的一半） */
export class TaskStore {
  static MAX = 400_000;
  events: TaskEvent[] = [];
  tasks: TaskRow[] = [];
  cores = 1;
  chip = 'esp32c3';
  /** 内核缓冲满丢的（累计）+ 网页为控制内存丢的最早事件 */
  coreDropped = 0;
  trimmed = 0;
  /** 最新的模拟时刻（周期） */
  now = 0;
  syms: Sym[] | null = null;
  symsName = '';
  version = 0;
  private subs = new Set<() => void>();
  private cache: { v: number; now: number; sl: Slice[] } | null = null;

  subscribe(cb: () => void) {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }
  notify() {
    this.version++;
    for (const cb of [...this.subs]) cb();
  }
  reset() {
    this.events = [];
    this.tasks = [];
    this.trimmed = 0;
    this.coreDropped = 0;
    this.now = 0;
    this.cache = null;
  }
  /** worker 的 tasks 消息：reset = 新上电；table = 任务表 JSON（tb_tasks_json） */
  onMsg(m: { reset: boolean; data: Uint8Array; table: string; chip?: string }) {
    if (m.reset) this.reset();
    if (m.chip) this.chip = m.chip;
    try {
      const j = JSON.parse(m.table) as { cores: number; dropped: number; tasks: TaskRow[] };
      this.cores = j.cores;
      this.coreDropped = j.dropped;
      this.tasks = j.tasks;
    } catch {
      /* 旧 wasm 没有任务表：保持原样 */
    }
    if (m.data.byteLength) {
      const ev = decodeTaskEvents(m.data);
      for (const e of ev) this.events.push(e);
      if (ev.length) this.now = Math.max(this.now, ev[ev.length - 1].t);
      if (this.events.length > TaskStore.MAX) {
        const cut = this.events.length >> 1;
        this.trimmed += cut;
        this.events = this.events.slice(cut);
      }
    }
    this.notify();
  }
  setNow(t: number) {
    if (t > this.now) this.now = t;
  }
  slices(): Slice[] {
    if (this.cache && this.cache.v === this.version && this.cache.now === this.now) return this.cache.sl;
    const sl = slices(this.events, this.now);
    this.cache = { v: this.version, now: this.now, sl };
    return sl;
  }
  func = (a: number) => (this.syms ? funcAt(this.syms, a) : undefined);
  exportJson(): string {
    return chromeJson(this.tasks, this.slices(), this.chip, this.cores, CPU_HZ, this.func);
  }
  /** 对拍用：每段 "核 任务名 起点周期 终点周期 状态" */
  text(): string {
    return this.slices()
      .map((s) => `${s.core} ${this.tasks[s.task]?.name ?? '?'} ${s.t0} ${s.t1} ${stateName(s.end)}`)
      .join('\n');
  }
}

export const taskStore = new TaskStore();
