// FreeRTOS task timeline data (C-04): decode 16-byte switch records, slice runs, CPU usage, Chrome Trace JSON, ELF symbols.
// Pure functions so node --test covers them; must match core/crates/esp32c3/src/tasktrace.rs report (tools/webtest/tasks.mjs).

export const CPU_HZ = 160_000_000;
export const NO_TASK = 0xffff;
export const EVENT_BYTES = 16;

/** State of the task switched out (same as Rust state::*). */
export const ST = { NONE: 0, READY: 1, WAIT: 2, BLOCKED: 3, GONE: 4 } as const;
export const stateName = (s: number) => (['-', 'ready', 'wait', 'blocked', 'gone'][s] ?? '-');

export interface TaskEvent {
  /** CPU cycles */
  t: number;
  core: number;
  /** State of the outgoing task at this moment */
  prev: number;
  /** Incoming task (table index); NO_TASK = core idle (reset) */
  task: number;
  /** Where the incoming task resumes */
  pc: number;
}

export interface TaskRow {
  name: string;
  prio: number;
  /** Pinned core; -1 = unpinned or single core */
  core: number;
  tcb: number;
}

export interface Slice {
  core: number;
  task: number;
  t0: number;
  t1: number;
  /** Task state when the slice ended (still running = NONE) */
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

/** Events -> per-core run slices; end = now, closing still-open slices. */
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

/** Cycles run per core per task within [from, to); key = `${core}:${task}`. */
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

/** Chrome Trace JSON: pid 1 has a track per core, pid 2 a track per task (run / wait); byte-identical to Rust chrome_json.
 *  func maps the resume PC to a function name (undefined without an ELF). */
export function chromeJson(tasks: readonly TaskRow[], sl: readonly Slice[], chip: string, cores: number, hz: number, func: (a: number) => string | undefined = () => undefined): string {
  // Cycles -> µs with 3 decimals in integer math, round half up: toFixed rounds .5 differently from Rust {:.3}.
  const H = BigInt(hz);
  const us = (c: number) => {
    const ns = (BigInt(c) * 2_000_000_000n + H) / (2n * H);
    return `${ns / 1000n}.${(ns % 1000n).toString().padStart(3, '0')}`;
  };
  const v: string[] = [];
  v.push(`{"ph":"M","pid":1,"name":"process_name","args":{"name":"${esc(chip)} CPU"}}`);
  v.push(`{"ph":"M","pid":2,"name":"process_name","args":{"name":"任务"}}`); // lint: allow-cjk
  for (let c = 0; c < cores; c++) v.push(`{"ph":"M","pid":1,"tid":${c},"name":"thread_name","args":{"name":"核 ${c}"}}`); // lint: allow-cjk
  tasks.forEach((tk, i) => v.push(`{"ph":"M","pid":2,"tid":${i + 10},"name":"thread_name","args":{"name":"${esc(tk.name)}"}}`));
  const lastOut = new Map<number, [number, number]>();
  for (const s of sl) {
    const n = esc(tasks[s.task]?.name ?? '?');
    const f = func(s.pc);
    const fs = f !== undefined ? `,"resume":"${esc(f)}"` : '';
    v.push(`{"ph":"X","pid":1,"tid":${s.core},"name":"${n}","cat":"task","ts":${us(s.t0)},"dur":${us(s.t1 - s.t0)},"args":{"prio":${tasks[s.task]?.prio ?? 0},"pc":"0x${hex8(s.pc)}"${fs},"out":"${stateName(s.end)}"}}`);
    const lo = lastOut.get(s.task);
    if (lo && lo[1] === ST.WAIT && s.t0 > lo[0]) v.push(`{"ph":"X","pid":2,"tid":${s.task + 10},"name":"等待","cat":"wait","ts":${us(lo[0])},"dur":${us(s.t0 - lo[0])}}`); // lint: allow-cjk
    v.push(`{"ph":"X","pid":2,"tid":${s.task + 10},"name":"核 ${s.core}","cat":"run","ts":${us(s.t0)},"dur":${us(s.t1 - s.t0)}}`); // lint: allow-cjk
    lastOut.set(s.task, [s.t1, s.end]);
  }
  return `{"displayTimeUnit":"ms","traceEvents":[\n${v.join(',\n')}\n]}\n`;
}

/** app.elf function symbols (STT_FUNC in .symtab) sorted by address; null if not a 32-bit LE ELF or no symtab. */
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
/** Function containing an address (zero-size symbols only cover 4 KB after their start). */
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

/** Page-wide timeline store: reset on each power-on / rewind; append-only, dropping the oldest half when too big. */
export class TaskStore {
  static MAX = 400_000;
  events: TaskEvent[] = [];
  tasks: TaskRow[] = [];
  cores = 1;
  chip = 'esp32c3';
  /** Events dropped by the full core buffer (cumulative), plus the oldest ones the page trims for memory */
  coreDropped = 0;
  trimmed = 0;
  /** Latest simulated time (cycles) */
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
  /** Worker tasks message: reset = fresh power-on; table = task table JSON (tb_tasks_json). */
  onMsg(m: { reset: boolean; data: Uint8Array; table: string; chip?: string }) {
    if (m.reset) this.reset();
    if (m.chip) this.chip = m.chip;
    try {
      const j = JSON.parse(m.table) as { cores: number; dropped: number; tasks: TaskRow[] };
      this.cores = j.cores;
      this.coreDropped = j.dropped;
      this.tasks = j.tasks;
    } catch {
      /* Older wasm has no task table: keep the previous one. */
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
  /** For cross-checking: one "core task start end state" line per slice. */
  text(): string {
    return this.slices()
      .map((s) => `${s.core} ${this.tasks[s.task]?.name ?? '?'} ${s.t0} ${s.t1} ${stateName(s.end)}`)
      .join('\n');
  }
}

export const taskStore = new TaskStore();
