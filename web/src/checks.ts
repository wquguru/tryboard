// 关卡判定与运行指纹。规则与 tools/check.py 逐条对应：同一个固件在命令行和网页里应得到同样的结论和指纹。

export interface Level {
  id: string;
  title: string;
  goal: string;
  pass: string;
  buy: string;
  learn: string;
  brief: string;
  ref: string | null;
  seconds?: number;
  args?: string[];
  script?: string;
  expect?: string[];
  gpio_toggles?: { pin: number; min: number; max?: number };
  pwm?: { pin: number; freq: number; min: number; max: number; tol?: number };
  ws2812?: { pin: number; min_frames?: number; frames?: string[][]; dominant?: 'r' | 'g' | 'b' };
  numeric?: { name: string; regex: string; value: number; tol: number }[];
  oled_min_pixels?: number;
  assembly?: boolean;
}

export interface CheckResult {
  ok: boolean;
  text: string;
}

/** 从 args 里取出 --i2c / --env（网页没有命令行，参数要翻译成启动选项） */
export function bootOptions(l: Level) {
  const a = l.args ?? [];
  const val = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const i2c = (val('--i2c') ?? '')
    .split(',')
    .filter(Boolean)
    .map((s) => {
      const [kind, addr] = s.split('@');
      return { kind, addr: parseInt(addr, 16) };
    });
  const e = val('--env')?.split(',').map(Number);
  const env = e ? { temp: e[0], humidity: e[1], pressure: e[2] } : undefined;
  return { i2c, env };
}

/** 与命令行一致的定时输入脚本：时间（模拟秒）:动作 */
export function parseScript(s: string | undefined) {
  return (s ?? '')
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e.includes(':'))
    .map((e) => {
      const i = e.indexOf(':');
      return { t: Number(e.slice(0, i).trim()), act: e.slice(i + 1).trim() };
    })
    .filter((e) => !Number.isNaN(e.t))
    .sort((a, b) => a.t - b.t);
}

function fnv1a(s: string) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function fingerprint(stdout: string, report: string) {
  const h = fnv1a(stdout + '\n#report\n' + report).toString(16).padStart(8, '0');
  return `${h.slice(0, 4)}·${h.slice(4)}`;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function evaluate(l: Level, out: string, report: string): CheckResult[] {
  const res: CheckResult[] = [];
  for (const e of l.expect ?? []) res.push({ ok: out.includes(e), text: `串口出现 “${e}”` });
  if (/Guru Meditation|abort\(\)|panic/.test(out)) res.push({ ok: false, text: '固件崩溃' });
  const g = l.gpio_toggles;
  if (g) {
    const m = report.match(new RegExp(`GPIO${g.pin} 翻转 (\\d+) 次`));
    const n = m ? Number(m[1]) : 0;
    const ok = n >= g.min && (g.max === undefined || n <= g.max);
    const want = g.max === g.min ? `${g.min}` : `≥ ${g.min}` + (g.max !== undefined ? ` 且 ≤ ${g.max}` : '');
    res.push({ ok, text: `GPIO${g.pin} 翻转 ${n} 次（要 ${want}）` });
  }
  const pw = l.pwm;
  if (pw) {
    const m = report.match(new RegExp(`PWM GPIO${pw.pin}: (\\d+) 次变化，占空比 ([\\d.]+)\\.\\.([\\d.]+)，频率 ([\\d.]+)Hz`));
    if (!m) res.push({ ok: false, text: `GPIO${pw.pin} 没有 PWM 输出` });
    else {
      const lo = Number(m[2]), hi = Number(m[3]), f = Number(m[4]);
      const tol = pw.tol ?? 0.01;
      const ok = Math.abs(f - pw.freq) <= pw.freq * 0.01 && Math.abs(lo - pw.min) <= tol && Math.abs(hi - pw.max) <= tol;
      res.push({ ok, text: `GPIO${pw.pin} PWM ${f.toFixed(0)} Hz，脉宽 ${((lo * 1000) / f).toFixed(3)}–${((hi * 1000) / f).toFixed(3)} ms` });
    }
  }
  const w = l.ws2812;
  if (w) {
    const sec = report.match(new RegExp(`WS2812 GPIO${w.pin} 共 (\\d+) 帧\\n((?:    .*\\n?)*)`));
    const nf = sec ? Number(sec[1]) : 0;
    const frames = sec ? sec[2].split('\n').filter(Boolean).map((x) => x.trim().split(/\s+/).slice(1)) : [];
    let ok = nf >= (w.min_frames ?? 1);
    (w.frames ?? []).forEach((want, i) => {
      ok = ok && i < frames.length && frames[i].join(' ') === want.join(' ');
    });
    let text = `WS2812 GPIO${w.pin} ${nf} 帧`;
    if (w.dominant) {
      const last = frames.length && frames[frames.length - 1].length ? frames[frames.length - 1][0] : '#000000';
      const rgb = [0, 1, 2].map((k) => parseInt(last.slice(1 + 2 * k, 3 + 2 * k), 16));
      const k = 'rgb'.indexOf(w.dominant);
      ok = ok && rgb[k] > 0 && rgb[k] === Math.max(...rgb) && rgb.filter((x) => x === rgb[k]).length === 1;
      text += `，最后一帧 ${last}（要${{ r: '红', g: '绿', b: '蓝' }[w.dominant]}色）`;
    }
    res.push({ ok, text });
  }
  for (const n of l.numeric ?? []) {
    const vals = [...out.matchAll(new RegExp(n.regex, 'g'))].map((m) => Number(m[1]));
    const worst = vals.length ? Math.max(...vals.map((v) => Math.abs(v - n.value))) : null;
    const ok = worst !== null && worst <= n.tol;
    res.push({ ok, text: `${n.name} ${vals.length} 次读数，最大偏差 ${worst === null ? '—' : fmtG(worst)}（容差 ${n.tol}）` });
  }
  if (l.oled_min_pixels !== undefined) {
    const m = report.match(/OLED 点亮像素 (\d+)/);
    const n = m ? Number(m[1]) : 0;
    res.push({ ok: n >= l.oled_min_pixels, text: `OLED 点亮 ${n} 像素（要 ≥ ${l.oled_min_pixels}）` });
  }
  return res;
}

/** Python 的 {:g}：6 位有效数字、去掉尾随 0 */
function fmtG(x: number) {
  if (x === 0) return '0';
  const s = x.toPrecision(6);
  return s.includes('e') ? s : s.replace(/\.?0+$/, '');
}

/** 网页命令行提示：与 tools/check.py 的用法一致 */
export const checkCommand = (l: Level) => `tools/check.py my.bin --level ${l.id}`;
export { esc };
