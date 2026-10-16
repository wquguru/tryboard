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
  pwm?: { pin: number; freq: number; min: number; max: number; tol?: number; from?: number; steps?: number[] };
  ws2812?: { pin: number; min_frames?: number; frames?: string[][]; dominant?: 'r' | 'g' | 'b' };
  numeric?: { name: string; regex: string; value: number; tol: number }[];
  oled_min_pixels?: number;
  lcd_min_pixels?: number;
  /** true 等同 'weather'；字符串是装配模板名 */
  assembly?: boolean | string;
  /** 有多个成品可选（第 07 关）：每个都是一套完整的条件 */
  variants?: (Omit<Level, 'id'> & { key: string })[];
  key?: string;
}

/** 展开子关（07-spin、07-lens），与 tools/check.py 的 expand 一致 */
export function expandLevels(levels: Level[]): Level[] {
  return levels.flatMap((l) => [l, ...(l.variants ?? []).map((v) => ({ ...v, id: `${l.id}-${v.key}`, title: `${l.title} · ${v.title}` }))]);
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
  const lcd = (val('--spi') ?? '').split(',').includes('gc9a01');
  return { i2c, env, lcd };
}

/** 与命令行一致的定时输入脚本：时间（模拟秒）:动作，`;` 或换行分隔，`#` 开头是注释（CLI 的 parse_script） */
export function parseScript(s: string | undefined) {
  return (s ?? '')
    .split(/[;\n]/)
    .map((e) => e.trim())
    .filter((e) => !e.startsWith('#') && e.includes(':'))
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
    if (!m || Number(m[4]) === 0) res.push({ ok: false, text: `GPIO${pw.pin} 没有 PWM 输出` });
    else {
      let lo = Number(m[2]), hi = Number(m[3]);
      const f = Number(m[4]);
      const sm = report.match(new RegExp(`PWM GPIO${pw.pin} 变化 (.*)`));
      const ch = sm ? [...sm[1].matchAll(/([\d.]+)@([\d.]+)/g)].map((x) => [Number(x[1]), Number(x[2])]) : [];
      if (pw.from !== undefined && ch.length) {
        // 只看稳定以后：from 时刻正在输出的值 + 之后的变化
        const before = ch.filter(([, t]) => t <= pw.from!).map(([d]) => d);
        const win = [...before.slice(-1), ...ch.filter(([, t]) => t > pw.from!).map(([d]) => d)];
        lo = Math.min(...win);
        hi = Math.max(...win);
      }
      const tol = pw.tol ?? 0.01;
      const ok = Math.abs(f - pw.freq) <= pw.freq * 0.01 && Math.abs(lo - pw.min) <= tol && Math.abs(hi - pw.max) <= tol;
      const when = pw.from !== undefined ? `，${pw.from} s 以后` : '';
      res.push({ ok, text: `GPIO${pw.pin} PWM ${f.toFixed(0)} Hz${when}，占空比 ${lo.toFixed(3)}–${hi.toFixed(3)}（约 ${((lo * 1000) / f).toFixed(2)}–${((hi * 1000) / f).toFixed(2)} ms）` });
      if (pw.steps) {
        const seq = ch.map(([d]) => d);
        let i = 0;
        const miss: number[] = [];
        for (const want of pw.steps) {
          let j = i;
          while (j < seq.length && Math.abs(seq[j] - want) > 0.002) j++;
          if (j === seq.length) miss.push(want); // 没找到不移动游标，后面的台阶照样能对上
          else i = j + 1;
        }
        const ms = (d: number) => ((d * 1000) / pw.freq).toFixed(1);
        res.push({ ok: !miss.length, text: `脉宽依次出现 ${pw.steps.map(ms).join(' → ')} ms` + (miss.length ? `：缺 ${miss.map(ms).join('、')} ms` : '') });
      }
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
  if (l.lcd_min_pixels !== undefined) {
    const m = report.match(/LCD GC9A01 非黑像素 (\d+)/);
    const n = m ? Number(m[1]) : 0;
    res.push({ ok: n >= l.lcd_min_pixels, text: `圆屏点亮 ${n} 像素（要 ≥ ${l.lcd_min_pixels}）` });
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
