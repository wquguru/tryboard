// 逻辑分析仪的数据层（P1-05）：解内核事件缓冲（tb_io_take 的 16 字节记录）、按通道整理、I2C 事务解码与人话注释。
// 纯函数 + 一个只追加的仓库，node --test 直接测。事件格式与文本行和 Rust 侧 core/crates/esp32c3/src/iotrace.rs 逐字相同，
// tools/webtest/traceio.mjs 用 eventLine 拼出的文本和 CLI `--trace-io` 的文件对拍。

export const CPU_HZ = 160_000_000;

export const K = { GPIO: 1, PWM: 2, WS2812: 3, I2C_START: 10, I2C_ADDR: 11, I2C_DATA: 12, I2C_STOP: 13 } as const;
export const B_READ = 1;
export const B_NACK = 2;
export const B_RESTART = 4;
export const B_PORT1 = 1 << 15;
export const EVENT_BYTES = 16;

export interface IoEvent {
  /** CPU 周期（160 MHz） */
  t: number;
  kind: number;
  a: number;
  b: number;
  v: number;
}

/** 解一段 tb_io_take 拷出来的字节（n 条 × 16 字节，小端） */
export function decodeEvents(buf: Uint8Array): IoEvent[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: IoEvent[] = [];
  for (let o = 0; o + EVENT_BYTES <= buf.byteLength; o += EVENT_BYTES) {
    const t = dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;
    out.push({ t, kind: dv.getUint8(o + 8), a: dv.getUint8(o + 9), b: dv.getUint16(o + 10, true), v: dv.getUint32(o + 12, true) });
  }
  return out;
}

const h2 = (n: number) => n.toString(16).padStart(2, '0');

/** 一行文本，与 Rust IoEvent::line 逐字相同 */
export function eventLine(e: IoEvent): string {
  const port = e.b & B_PORT1 ? 'I2C1' : 'I2C0';
  const dir = e.b & B_READ ? 'R' : 'W';
  const ack = e.b & B_NACK ? 'NACK' : 'ACK';
  switch (e.kind) {
    case K.GPIO:
      return `${e.t} GPIO ${e.a} ${e.b}`;
    case K.PWM:
      return `${e.t} PWM ${e.a} ${e.b} ${e.v}`;
    case K.WS2812:
      return `${e.t} WS2812 ${e.a} ${e.b} ${e.v.toString(16).padStart(6, '0')}`;
    case K.I2C_START:
      return `${e.t} ${port} ${e.b & B_RESTART ? 'RESTART' : 'START'} ${e.v}`;
    case K.I2C_ADDR:
      return `${e.t} ${port} ADDR ${h2(e.a)} ${dir} ${ack}`;
    case K.I2C_DATA:
      return `${e.t} ${port} DATA ${h2(e.a)} ${dir} ${ack}`;
    case K.I2C_STOP:
      return `${e.t} ${port} STOP`;
    default:
      return `${e.t} ? ${e.kind} ${e.a} ${e.b} ${e.v}`;
  }
}

// ------------------------------------------------------------ I2C 事务

export interface I2cItem {
  kind: 'start' | 'restart' | 'addr' | 'data' | 'stop';
  t: number;
  byte: number;
  read: boolean;
  nack: boolean;
}

export interface I2cTxn {
  port: number;
  t0: number;
  /** 停止位之后（还没停止时 = 最后一项 + 9 位） */
  t1: number;
  /** 一个 SCL 位多少周期 */
  bit: number;
  items: I2cItem[];
  done: boolean;
}

export const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

/** 泡泡上的一句：START 0x76 W · 0xF7 · RESTART 0x76 R · 8 B · STOP */
export function txnText(x: I2cTxn): string {
  const parts: string[] = [];
  let run: I2cItem[] = [];
  const flush = () => {
    if (!run.length) return;
    const read = run[0].read;
    // 写的少量字节逐个写出来（寄存器地址、命令），读或写一长串就只写字节数
    if (!read && run.length <= 3) parts.push(...run.map((d) => hex(d.byte) + (d.nack ? ' NACK' : '')));
    else parts.push(`${run.length} B`);
    run = [];
  };
  for (const it of x.items) {
    if (it.kind === 'data') {
      if (run.length && run[0].read !== it.read) flush();
      run.push(it);
      continue;
    }
    flush();
    if (it.kind === 'start') parts.push('START');
    else if (it.kind === 'restart') parts.push('RESTART');
    else if (it.kind === 'stop') parts.push('STOP');
    else {
      const last = parts.pop();
      parts.push(`${last ? last + ' ' : ''}${hex(it.byte)} ${it.read ? 'R' : 'W'}${it.nack ? ' NACK' : ''}`);
    }
  }
  flush();
  return parts.join(' · ');
}

const BME_REG: [number, number, string][] = [
  [0xd0, 0xd0, '读芯片 ID（BME280 应为 0x60）'],
  [0xe0, 0xe0, '软复位'],
  [0x88, 0xa1, '读温度 / 气压校准参数'],
  [0xe1, 0xe7, '读湿度校准参数'],
  [0xf2, 0xf2, '设湿度过采样'],
  [0xf3, 0xf3, '查状态（是否在测量）'],
  [0xf4, 0xf4, '设温度 / 气压过采样和工作模式'],
  [0xf5, 0xf5, '设待机时间和滤波'],
  [0xf7, 0xf9, '读气压原始值'],
  [0xfa, 0xfc, '读温度原始值'],
  [0xfd, 0xfe, '读湿度原始值'],
];

const OLED_CMD: Record<number, string> = {
  0xae: '关显示',
  0xaf: '开显示',
  0x8d: '电荷泵',
  0x20: '寻址模式',
  0x21: '列地址范围',
  0x22: '页地址范围',
  0x81: '对比度',
  0xa8: '复用比',
  0xd3: '显示偏移',
  0xa1: '列重映射',
  0xa0: '列不重映射',
  0xc8: '行扫描反向',
  0xc0: '行扫描正向',
  0xda: 'COM 引脚配置',
  0xd5: '时钟分频',
  0xd9: '预充电周期',
  0xdb: 'VCOMH 电平',
  0xa4: '按显存显示',
  0xa5: '全亮测试',
  0xa6: '正常（不反色）',
  0xa7: '反色',
};

/** 已知器件寄存器的一句人话（BME280 0x76 / 0x77、SSD1306 0x3C / 0x3D）；认不出返回 '' */
export function txnNote(x: I2cTxn): string {
  const addr = x.items.find((i) => i.kind === 'addr');
  if (!addr) return '';
  if (addr.nack) return '没有器件应答（地址扫描或接线问题）';
  const a = addr.byte;
  const w = x.items.filter((i) => i.kind === 'data' && !i.read);
  const r = x.items.filter((i) => i.kind === 'data' && i.read);
  if (a === 0x76 || a === 0x77) {
    const reg = w[0]?.byte;
    if (reg === undefined) return '';
    if (r.length) {
      if (reg === 0xf7 && r.length >= 8) return '读气压、温度、湿度原始值（一次读 8 字节）';
      if (reg === 0xf7 && r.length >= 6) return '读气压、温度原始值';
      const hit = BME_REG.find(([lo, hi]) => reg >= lo && reg <= hi);
      if (!hit) return `读寄存器 ${hex(reg)}`;
      return hit[2].startsWith('设') ? `读回${hit[2].slice(1)}` : hit[2];
    }
    const hit = BME_REG.find(([lo, hi]) => reg >= lo && reg <= hi);
    if (reg === 0xe0 && w[1]?.byte === 0xb6) return '软复位';
    if (reg === 0xf4 && w[1]) return `设过采样和工作模式（${['睡眠', '单次', '单次', '连续'][w[1].byte & 3]}）`;
    if (w.length === 1) return `选寄存器 ${hex(reg)}`;
    return hit ? hit[2] : `写寄存器 ${hex(reg)}`;
  }
  if (a === 0x3c || a === 0x3d) {
    const ctl = w[0]?.byte;
    if (ctl === undefined) return '';
    const body = w.slice(1);
    if (ctl === 0x40) return `写显存 ${body.length} 字节`;
    if (ctl === 0x00 || ctl === 0x80) {
      const c = body[0]?.byte;
      if (c === undefined) return 'OLED 命令';
      if (c >= 0xb0 && c <= 0xb7) return `OLED 命令：选第 ${c - 0xb0} 页`;
      if (c >= 0x40 && c <= 0x7f && body.length === 1) return 'OLED 命令：起始行';
      const name = OLED_CMD[c];
      return body.length > 3 ? `OLED 命令序列（${body.length} 字节${name ? '，' + name + '起' : ''}）` : `OLED 命令：${name ?? hex(c)}`;
    }
  }
  return '';
}

// ------------------------------------------------------------ 按通道整理的仓库

export interface Series {
  t: number[];
}
export interface GpioSeries extends Series {
  v: number[];
}
export interface PwmSeries extends Series {
  duty: number[];
  /** Hz；0 = 不再输出 PWM */
  freq: number[];
}
export interface WsSeries extends Series {
  n: number[];
  rgb: number[];
}

/** 网页这边存多少条（超过就丢最老的一半，按时间整段丢） */
export const STORE_CAP = 400_000;

/** 只追加的事件仓库：worker 每批发来的事件按通道放好；上电 / 回退时 reset */
export class IoStore {
  gpio = new Map<number, GpioSeries>();
  pwm = new Map<number, PwmSeries>();
  ws = new Map<number, WsSeries>();
  i2c = new Map<number, I2cTxn[]>();
  /** 原始事件（对拍、导出用） */
  raw: IoEvent[] = [];
  /** 丢掉了多少条（网页仓库满了 + 内核缓冲溢出） */
  dropped = 0;
  coreDropped = 0;
  /** 最早还留着的时刻（周期）；丢过事件后这之前的波形不可信 */
  since = 0;
  rev = 0;
  private open = new Map<number, I2cTxn>();

  reset() {
    this.gpio.clear();
    this.pwm.clear();
    this.ws.clear();
    this.i2c.clear();
    this.open.clear();
    this.raw = [];
    this.dropped = 0;
    this.coreDropped = 0;
    this.since = 0;
    this.rev++;
  }

  append(evs: IoEvent[]) {
    for (const e of evs) this.add(e);
    if (this.raw.length > STORE_CAP) this.trim();
    if (evs.length) this.rev++;
  }

  private add(e: IoEvent) {
    this.raw.push(e);
    switch (e.kind) {
      case K.GPIO: {
        const s = get(this.gpio, e.a, () => ({ t: [], v: [] }));
        s.t.push(e.t);
        s.v.push(e.b);
        break;
      }
      case K.PWM: {
        const s = get(this.pwm, e.a, () => ({ t: [], duty: [], freq: [] }));
        s.t.push(e.t);
        s.duty.push(e.b / 65535);
        s.freq.push(e.v / 1000);
        break;
      }
      case K.WS2812: {
        const s = get(this.ws, e.a, () => ({ t: [], n: [], rgb: [] }));
        s.t.push(e.t);
        s.n.push(e.b);
        s.rgb.push(e.v);
        break;
      }
      case K.I2C_START:
      case K.I2C_ADDR:
      case K.I2C_DATA:
      case K.I2C_STOP: {
        const port = e.b & B_PORT1 ? 1 : 0;
        let x = this.open.get(port);
        const bit = x?.bit ?? 400;
        if (e.kind === K.I2C_START && !(e.b & B_RESTART)) {
          // 上一个事务没收到 STOP 就开始新的：把它收掉
          if (x) x.done = true;
          x = { port, t0: e.t, t1: e.t + e.v, bit: e.v || 400, items: [], done: false };
          this.open.set(port, x);
          get(this.i2c, port, () => []).push(x);
        }
        if (!x) {
          // 缓冲从事务中间开始（前面被丢了）：从这里起一个
          x = { port, t0: e.t, t1: e.t, bit, items: [], done: false };
          this.open.set(port, x);
          get(this.i2c, port, () => []).push(x);
        }
        if (e.kind === K.I2C_START && e.v) x.bit = e.v;
        const kind = e.kind === K.I2C_START ? (e.b & B_RESTART ? 'restart' : 'start') : e.kind === K.I2C_ADDR ? 'addr' : e.kind === K.I2C_DATA ? 'data' : 'stop';
        x.items.push({ kind, t: e.t, byte: e.a, read: !!(e.b & B_READ), nack: !!(e.b & B_NACK) });
        const len = kind === 'addr' || kind === 'data' ? 9 : 1;
        x.t1 = Math.max(x.t1, e.t + len * x.bit);
        if (kind === 'stop') {
          x.done = true;
          this.open.delete(port);
        }
        break;
      }
    }
  }

  /** 网页仓库满了：丢最老的一半，按剩下的重建各通道 */
  private trim() {
    const keep = this.raw.slice(this.raw.length - Math.floor(STORE_CAP / 2));
    const dropped = this.dropped + this.raw.length - keep.length;
    const core = this.coreDropped;
    this.reset();
    this.dropped = dropped;
    this.coreDropped = core;
    this.since = keep[0]?.t ?? 0;
    for (const e of keep) this.add(e);
  }

  /** 与 CLI --trace-io 文件同格式的文本（不含注释头） */
  text(n = this.raw.length) {
    return this.raw
      .slice(0, n)
      .map((e) => eventLine(e) + '\n')
      .join('');
  }
}

function get<K, V>(m: Map<K, V>, k: K, mk: () => V): V {
  let v = m.get(k);
  if (v === undefined) {
    v = mk();
    m.set(k, v);
  }
  return v;
}

/** 有序数组里最后一个 ≤ x 的下标（没有则 -1） */
export function lastLE(a: number[], x: number): number {
  let lo = 0,
    hi = a.length - 1,
    r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= x) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r;
}

/** 第一个 t1 ≥ x 的事务下标（事务按 t0 排序，t1 也单调） */
export function firstTxnEndingAfter(xs: I2cTxn[], x: number): number {
  let lo = 0,
    hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m].t1 < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** PWM 标签："50 Hz · 1.675 ms" */
export function pwmLabel(duty: number, freq: number): string {
  if (!(freq > 0)) return '无 PWM';
  const f = freq >= 1000 ? `${(freq / 1000).toFixed(freq >= 10000 ? 1 : 2)} kHz` : `${freq.toFixed(freq >= 100 ? 0 : freq >= 10 ? 0 : 1)} Hz`;
  const w = duty / freq;
  const ws = w >= 1e-3 ? `${(w * 1e3).toFixed(3)} ms` : `${(w * 1e6).toFixed(1)} µs`;
  return `${f} · ${ws}`;
}

/** 时间（秒）→ 读数："1.675 ms"、"12.0 µs"、"2.350 s" */
export function fmtTime(s: number): string {
  const a = Math.abs(s);
  if (a >= 1) return `${s.toFixed(3)} s`;
  if (a >= 1e-3) return `${(s * 1e3).toFixed(3)} ms`;
  if (a >= 1e-6) return `${(s * 1e6).toFixed(2)} µs`;
  return `${(s * 1e9).toFixed(0)} ns`;
}
