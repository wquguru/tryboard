// 输入日志：网页上对模拟世界的每一次操作（按键、环境滑块、电位器、串口……），按**模拟时间**记下来，
// 可以导出成命令行 `tryboard run --inputs <文件>` 能吃的脚本，逐周期重放出同样的结果。
// 时间戳在 worker 里盖（施加那一刻的 CPU 周期 ÷ 160MHz），不是墙钟：墙钟和模拟时间的比例随机器快慢变化。
// 格式与 CLI 语法见 docs/DECISIONS.md（2026-10-16 输入日志）。

export type InputEvent =
  /** 外部驱动引脚：0 / 1，-1 = 松开（高阻） */
  | { tMs: number; kind: 'gpio'; pin: number; level: number }
  /** 环境（BME280 等读到的值；装配时传感器贴芯片的偏移已经算进 temp） */
  | { tMs: number; kind: 'env'; temp: number; humidity: number; pressure: number }
  /** 电位器 / 模拟输入：引脚上的电压（毫伏） */
  | { tMs: number; kind: 'pot'; pin: number; mv: number }
  /** 上电：每份日志从一次上电开始（复位 = 新的一份日志），重放时不需要额外动作 */
  | { tMs: number; kind: 'power'; on: boolean }
  /** 串口 / USB 虚拟串口输入 */
  | { tMs: number; kind: 'uart' | 'usbcdc'; text: string }
  /** 供电切换（P1-02）：usb = 舵机吃 USB 的 5V；ext = 舵机由外接 5 V 供电。脚本动作 power=usb|ext */
  | { tMs: number; kind: 'supply'; mode: 'usb' | 'ext' }
  /** 线束（P2-11，估算）：I2C 排线总长（cm，负数 = 理想总线）、天线遮挡（dB）。脚本动作 i2cwire=cm / antenna=dB */
  | { tMs: number; kind: 'i2cwire'; cm: number }
  | { tMs: number; kind: 'antenna'; db: number };

/** 还没盖时间戳的事件（worker 施加时补上 tMs） */
export type InputAction = InputEvent extends infer E ? (E extends unknown ? Omit<E, 'tMs'> : never) : never;

export interface InputLog {
  version: 1;
  /** 示例 / 固件名（主线程填，worker 不知道） */
  firmware?: string;
  chip?: 'esp32c3' | 'esp32s3';
  /** 上电时挂的器件：重放时变成 --i2c / --spi */
  i2c: { kind: string; addr: number }[];
  lcd: boolean;
  /** 上电时接的舵机（GPIO）与供电方式：重放时变成 --servo / --power */
  servo?: number;
  power?: 'usb' | 'ext';
  events: InputEvent[];
  /** 取日志那一刻的模拟时间（毫秒）：重放跑到这里（--seconds）就与网页上看到的一致 */
  endMs?: number;
}

const CPU_HZ = 160_000_000;

/** 周期数 → 毫秒（保留全部精度，导出时再取整） */
export const cyclesToMs = (cycles: number) => (cycles * 1000) / CPU_HZ;

/**
 * 时间写成秒、向下取整到微秒：保证 ≤ 施加那一刻的模拟时间、又远大于上一个 1ms 时间片的起点，
 * CLI 在同一个时间片开头施加（见 cli main.rs 的 --inputs）。
 */
const sec = (ms: number) => (Math.floor(ms * 1000) / 1e6).toFixed(6);
const esc = (t: string) => t.replaceAll('\n', '\\n');

/** 一条事件 → 脚本动作（`gpio0=0`、`env=35,45,101325`、`mv1=1650`……）；power 没有动作 */
export function action(e: InputEvent): string | null {
  switch (e.kind) {
    case 'gpio':
      return `gpio${e.pin}=${e.level < 0 ? 'z' : e.level ? 1 : 0}`;
    case 'env':
      return `env=${e.temp},${e.humidity},${e.pressure}`;
    case 'pot':
      return `mv${e.pin}=${e.mv}`;
    case 'uart':
      return `uart=${esc(e.text)}`;
    case 'usbcdc':
      return `usbcdc=${esc(e.text)}`;
    case 'supply':
      return `power=${e.mode}`;
    case 'i2cwire':
      return `i2cwire=${e.cm}`;
    case 'antenna':
      return `antenna=${e.db}`;
    case 'power':
      return null;
  }
}

/** 导出成 `--inputs` 文件：一行一条 `秒:动作`，# 开头是注释（含建议的命令行） */
export function toScript(log: InputLog): string {
  const lines = [`# 试板输入日志 v${log.version}${log.firmware ? ' · ' + log.firmware : ''}（时间 = 模拟秒）`, `# 重放：${cliArgs(log, '<flash.bin>', '<本文件>', log.endMs === undefined ? undefined : Math.floor(log.endMs) / 1000).join(' ')}`];
  for (const e of log.events) {
    const a = action(e);
    if (a !== null) lines.push(`${sec(e.tMs)}:${a}`);
  }
  return lines.join('\n') + '\n';
}

/** 同一份脚本的单行形式（`--script` / levels.json 的 script 字段 / verify-worker） */
export function toScriptInline(log: InputLog): string {
  return log.events.flatMap((e) => (action(e) === null ? [] : [`${sec(e.tMs)}:${action(e)}`])).join('; ');
}

/** 重放用的命令行参数 */
export function cliArgs(log: InputLog, fw: string, inputsFile: string, seconds?: number): string[] {
  const a = ['tryboard', 'run', fw];
  if (seconds !== undefined) a.push('--seconds', String(seconds));
  if (log.i2c.length) a.push('--i2c', log.i2c.map((d) => `${d.kind}@0x${d.addr.toString(16)}`).join(','));
  if (log.lcd) a.push('--spi', 'gc9a01');
  if (log.servo !== undefined) a.push('--servo', String(log.servo), '--power', log.power ?? 'usb');
  a.push('--inputs', inputsFile);
  return a;
}
