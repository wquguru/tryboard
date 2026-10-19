// 关卡判定与运行指纹。规则与 tools/check.py 逐条对应：同一个固件在命令行和网页里应得到同样的结论和指纹。

import { chipAt, pwmDevice, servoDeg, want as wantN } from './ui/say.ts';

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
  pwm?: { pin: number; freq: number; min: number; max: number; tol?: number; from?: number; steps?: number[]; beeps?: { from: number; to: number; min: number; max: number }[] };
  /** last：最后一帧逐颗看（灯数、亮几颗、亮的颜色 ±tol） */
  ws2812?: { pin: number; min_frames?: number; frames?: string[][]; dominant?: 'r' | 'g' | 'b'; last?: { count: number; lit?: number; rgb: string; tol?: number } };
  numeric?: { name: string; regex: string; value: number; tol: number }[];
  oled_min_pixels?: number;
  lcd_min_pixels?: number;
  /** 串口里某段文字至少出现几次（如眨眼 BLINK） */
  serial_count?: { text: string; min: number }[];
  /** 圆屏最后一帧里某种颜色（±tol，按通道最大差）的像素数，可选水平重心范围（判"画了什么、画在哪"） */
  lcd_colors?: { name: string; rgb: string; min: number; max?: number; tol?: number; cx?: [number, number]; cy?: [number, number] }[];
  /** USB 虚拟主机看到的（关卡带 --usb-log）：设备状态、键盘打出的字（P2-12） */
  usb?: { state?: string; typed?: string };
  /** 这一关属于哪个作品的专属检查点（spin-1 这类）；没有就是气象站 / 第 07 关的通用关卡 */
  work?: string;
  /** true 等同 'weather'；字符串是装配模板名 */
  assembly?: boolean | string;
  /** 有多个成品可选（第 07 关）：每个都是一套完整的条件 */
  variants?: (Omit<Level, 'id'> & { key: string })[];
  key?: string;
  /** 开机：seconds 内没崩溃、串口至少一行（生成检查点 U-17） */
  boots?: boolean;
  /** 每个 I2C 地址至少应答几次（关卡带 --i2c-log；地址是 7 位） */
  i2c_ack?: { addr: number; min: number }[];
  /** 网页证明不了、必须上真机的条目：只列出，不判、不计入进度 */
  manual?: boolean;
}

/** 展开子关（07-spin、07-lens），与 tools/check.py 的 expand 一致 */
export function expandLevels(levels: Level[]): Level[] {
  return levels.flatMap((l) => [l, ...(l.variants ?? []).map((v) => ({ ...v, id: `${l.id}-${v.key}`, title: `${l.title} · ${v.title}` }))]);
}

export interface CheckResult {
  ok: boolean;
  /** 与 tools/check.py 逐字一致的结论行（界面上收进「原始数据」） */
  text: string;
  /** 人话一行（DESIGN_V2 §9）：主语是器件，0 说「没」 */
  say?: string;
  /** 小字：引脚 / 地址 / 串口 */
  tag?: string;
}

/** 从 args 里取出 --i2c / --env / --spi / --servo / --power / --encoder / --sonar / --touch-int（网页没有命令行，参数要翻译成启动选项） */
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
  const sv = val('--servo');
  const servo = sv === undefined ? undefined : Number(sv);
  const power = val('--power') === 'ext' ? ('ext' as const) : ('usb' as const);
  // --encoder A,B[,SW] / --sonar TRIG,ECHO [--dist 厘米]
  const en = val('--encoder')?.split(',').map(Number);
  const encoder = en && en.length >= 2 ? { a: en[0], b: en[1], ...(en.length > 2 ? { sw: en[2] } : {}) } : undefined;
  const so = val('--sonar')?.split(',').map(Number);
  const dist = val('--dist');
  const sonar = so && so.length === 2 ? { trig: so[0], echo: so[1], ...(dist !== undefined ? { cm: Number(dist) } : {}) } : undefined;
  const ti = val('--touch-int');
  const touchInt = ti === undefined ? undefined : Number(ti);
  // 线束（P2-11，估算）：I2C 排线总长、天线遮挡
  const wv = val('--i2c-wire');
  const i2cWire = wv === undefined ? undefined : Number(wv);
  const av = val('--antenna-loss');
  const antenna = av === undefined ? undefined : Number(av);
  return { i2c, env, lcd, servo, power, encoder, sonar, touchInt, usb: a.includes('--usb-log'), i2cLog: a.includes('--i2c-log'), i2cWire, antenna };
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
  for (const e of l.expect ?? []) {
    const ok = out.includes(e);
    res.push({ ok, text: `串口出现 “${e}”`, say: ok ? `串口打印了「${e}」` : `串口没打印「${e}」`, tag: '串口' });
  }
  if (/Guru Meditation|abort\(\)|panic/.test(out)) res.push({ ok: false, text: '固件崩溃', say: '固件崩溃了，芯片在反复重启', tag: '串口' });
  if (l.boots) {
    // 非空行：去掉空格、制表、回车后还剩东西（与 check.py 同一判法）
    const n = out.split('\n').filter((x) => x.replace(/[ \t\r]/g, '') !== '').length;
    const crashed = /Guru Meditation|abort\(\)|panic/.test(out);
    const ok = n >= 1 && !crashed;
    res.push({ ok, text: `开机 ${l.seconds ?? 2} s 内串口输出 ${n} 行`, say: ok ? '开机正常，串口有输出' : crashed ? '一开机就崩溃了' : `开机 ${l.seconds ?? 2} 秒内串口没有输出`, tag: '串口' });
  }
  for (const c of l.i2c_ack ?? []) {
    const a = c.addr.toString(16).padStart(2, '0');
    const m = report.match(new RegExp(`I2C 0x${a} 应答 (\\d+) 次`));
    const n = m ? Number(m[1]) : 0;
    const who = chipAt(c.addr);
    res.push({ ok: n >= c.min, text: `I2C 0x${a} 应答 ${n} 次（要 ≥ ${c.min}）`, say: n >= c.min ? `${who} 有回应` : n ? `${who} 只回应了 ${n} 次，至少要 ${c.min} 次` : `${who} 没有回应`, tag: `I2C 0x${a}` });
  }
  const g = l.gpio_toggles;
  if (g) {
    const m = report.match(new RegExp(`GPIO${g.pin} 翻转 (\\d+) 次`));
    const n = m ? Number(m[1]) : 0;
    const ok = n >= g.min && (g.max === undefined || n <= g.max);
    const want = g.max === g.min ? `${g.min}` : `≥ ${g.min}` + (g.max !== undefined ? ` 且 ≤ ${g.max}` : '');
    const times = wantN(g.min, g.max);
    res.push({ ok, text: `GPIO${g.pin} 翻转 ${n} 次（要 ${want}）`, say: ok ? `LED 闪了 ${n} 次` : n ? `LED 闪了 ${n} 次，应为 ${times} 次` : `LED 没闪，应闪 ${times} 次`, tag: `GPIO${g.pin}` });
  }
  const pw = l.pwm;
  if (pw) {
    const m = report.match(new RegExp(`PWM GPIO${pw.pin}: (\\d+) 次变化，占空比 ([\\d.]+)\\.\\.([\\d.]+)，频率 ([\\d.]+)Hz`));
    const dev = pwmDevice(pw.freq, !!pw.beeps);
    const name = { servo: '舵机', buzzer: '蜂鸣器', other: 'PWM 输出' }[dev];
    if (!m || Number(m[4]) === 0) res.push({ ok: false, text: `GPIO${pw.pin} 没有 PWM 输出`, say: `${name}没有收到信号`, tag: `GPIO${pw.pin}` });
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
      // 先写脉宽（舵机看这个），没过时直接写出要多少，不让人自己拿占空比去算差了多少
      const span = (a: string, b: string) => (a === b ? a : `${a}–${b}`);
      const ms = (d: number, hz: number) => ((d * 1000) / hz).toFixed(2);
      const fBad = Math.abs(f - pw.freq) > pw.freq * 0.01;
      const want = ok ? '' : `；要 ${span(ms(pw.min, pw.freq), ms(pw.max, pw.freq))} ms${fBad ? `、${pw.freq} Hz` : ''}`;
      res.push({ ok, text: `GPIO${pw.pin} PWM ${f.toFixed(0)} Hz${when}，脉宽 ${span(ms(lo, f), ms(hi, f))} ms（占空比 ${span(lo.toFixed(3), hi.toFixed(3))}）${want}`, say: pwmSay(dev, ok, fBad, pw, lo, hi, f), tag: `GPIO${pw.pin}` });
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
        res.push({ ok: !miss.length, text: `脉宽依次出现 ${pw.steps.map(ms).join(' → ')} ms` + (miss.length ? `：缺 ${miss.map(ms).join('、')} ms` : ''), say: miss.length ? `${name}少走了 ${miss.length} 个位置（共 ${pw.steps.length} 个）` : `${name}依次走到了 ${pw.steps.length} 个位置`, tag: `GPIO${pw.pin}` });
      }
      for (const b of pw.beeps ?? []) {
        // 响了几声：时间窗里占空比从 0（或没有输出）变成 > 0 的次数（蜂鸣器节奏，"越近越急"）
        let n = 0;
        let prev = 0;
        for (const [d, at] of ch) {
          if (d > 0 && prev === 0 && b.from <= at && at <= b.to) n++;
          prev = d;
        }
        const want = b.min === b.max ? `${b.min}` : `${b.min}–${b.max}`;
        const ok = b.min <= n && n <= b.max;
        const win = `${b.from}–${b.to} 秒`;
        const say = b.max === 0 ? (ok ? `${win}蜂鸣器安静` : `${win}蜂鸣器应该安静，却响了 ${n} 声`) : ok ? `${win}蜂鸣器响了 ${n} 声` : n ? `${win}蜂鸣器响了 ${n} 声，应为 ${want} 声` : `${win}蜂鸣器没响，应响 ${want} 声`;
        res.push({ ok, text: `GPIO${pw.pin} ${b.from}–${b.to} s 响 ${n} 声（要 ${want}）`, say, tag: `GPIO${pw.pin}` });
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
    let say = nf ? `彩灯收到了 ${nf} 帧数据` : '彩灯没收到数据';
    if (w.dominant) {
      const last = frames.length && frames[frames.length - 1].length ? frames[frames.length - 1][0] : '#000000';
      const rgb = [0, 1, 2].map((k) => parseInt(last.slice(1 + 2 * k, 3 + 2 * k), 16));
      const k = 'rgb'.indexOf(w.dominant);
      ok = ok && rgb[k] > 0 && rgb[k] === Math.max(...rgb) && rgb.filter((x) => x === rgb[k]).length === 1;
      const hue = { r: '红', g: '绿', b: '蓝' }[w.dominant];
      text += `，最后一帧 ${last}（要${hue}色）`;
      if (nf) say = ok ? `彩灯是${hue}色` : `彩灯不是${hue}色`;
    }
    if (w.last) {
      // 最后一帧逐颗看：灯数、亮了几颗、亮的颜色（每通道 ±tol）
      const L = w.last;
      const last = frames.length ? frames[frames.length - 1] : [];
      const want = parseInt(L.rgb.slice(1), 16);
      const tol = L.tol ?? 0;
      const litWant = L.lit ?? L.count;
      const lit = last.filter((c) => c !== '#000000');
      const near = (c: string) => Math.max(...[16, 8, 0].map((sh) => Math.abs(((parseInt(c.slice(1), 16) >> sh) & 255) - ((want >> sh) & 255)))) <= tol;
      const good = last.length === L.count && lit.length === litWant && lit.every(near);
      ok = ok && good;
      text += `，最后一帧 ${last.length} 颗、亮 ${lit.length} 颗（要 ${L.count} 颗、亮 ${litWant} 颗 ${L.rgb} ±${tol}）`;
      if (!good) text += `：${last.join(' ') || '（没有帧）'}`;
      if (nf) say = good ? `灯带 ${L.count} 颗灯都对` : last.length !== L.count ? `灯带收到 ${last.length} 颗，应为 ${L.count} 颗` : lit.length !== litWant ? `灯带亮了 ${lit.length} 颗，应亮 ${litWant} 颗` : '灯带颜色不对';
    }
    if (nf && !ok && !w.dominant && !w.last) say = '彩灯的数据不对';
    res.push({ ok, text, say, tag: `GPIO${w.pin}` });
  }
  for (const n of l.numeric ?? []) {
    const vals = [...out.matchAll(new RegExp(n.regex, 'g'))].map((m) => Number(m[1]));
    const worst = vals.length ? Math.max(...vals.map((v) => Math.abs(v - n.value))) : null;
    const ok = worst !== null && worst <= n.tol;
    res.push({ ok, text: `${n.name} ${vals.length} 次读数，最大偏差 ${worst === null ? '—' : fmtG(worst)}（容差 ${n.tol}）`, say: worst === null ? `串口没打印${n.name}` : ok ? `${n.name}读数准确` : `${n.name}读数差了 ${fmtG(worst)}，应在 ±${n.tol} 以内`, tag: '串口' });
  }
  if (l.oled_min_pixels !== undefined) {
    const m = report.match(/OLED 点亮像素 (\d+)/);
    const n = m ? Number(m[1]) : 0;
    res.push({ ok: n >= l.oled_min_pixels, text: `OLED 点亮 ${n} 像素（要 ≥ ${l.oled_min_pixels}）`, say: n >= l.oled_min_pixels ? '屏幕亮了' : n ? `屏幕上的内容太少：亮了 ${n} 个像素，至少要 ${l.oled_min_pixels} 个` : '屏幕没亮', tag: 'OLED' });
  }
  if (l.lcd_min_pixels !== undefined) {
    const m = report.match(/LCD GC9A01 非黑像素 (\d+)/);
    const n = m ? Number(m[1]) : 0;
    res.push({ ok: n >= l.lcd_min_pixels, text: `圆屏点亮 ${n} 像素（要 ≥ ${l.lcd_min_pixels}）`, say: n >= l.lcd_min_pixels ? '圆屏亮了' : n ? `圆屏上的内容太少：亮了 ${n} 个像素，至少要 ${l.lcd_min_pixels} 个` : '圆屏没亮', tag: '圆屏' });
  }
  for (const c of l.serial_count ?? []) {
    const n = out.split(c.text).length - 1;
    res.push({ ok: n >= c.min, text: `串口 “${c.text}” 出现 ${n} 次（要 ≥ ${c.min}）`, say: n >= c.min ? `串口打印了 ${n} 次「${c.text}」` : n ? `串口只打印了 ${n} 次「${c.text}」，至少要 ${c.min} 次` : `串口没打印「${c.text}」`, tag: '串口' });
  }
  if (l.usb) {
    const m = report.match(/USB 主机：(\S+)/);
    const st = m ? m[1] : '没有 USB 设备';
    if (l.usb.state !== undefined) res.push({ ok: st === l.usb.state, text: `电脑看到的 USB 设备：${st}（要${l.usb.state}）`, say: st === l.usb.state ? `电脑认出了${st}` : `电脑看到的是${st}，应为${l.usb.state}`, tag: 'USB' });
    if (l.usb.typed !== undefined) {
      const t = report.match(/^\[tryboard\] USB 键盘输入: (".*")$/m);
      const got: string = t ? JSON.parse(t[1]) : '';
      const shown = (x: string) => x.replaceAll('\n', '↵');
      res.push({ ok: got === l.usb.typed, text: `电脑上打出 “${shown(got)}”（要 “${shown(l.usb.typed)}”）`, say: got === l.usb.typed ? `电脑上打出了「${shown(got)}」` : got ? `电脑上打出的是「${shown(got)}」，应为「${shown(l.usb.typed)}」` : '电脑上什么也没打出来', tag: 'USB' });
    }
  }
  if (l.lcd_colors?.length) {
    const seen = [...report.matchAll(/LCD 颜色 #([0-9a-f]{6}) (\d+) 像素，重心 ([\d.]+),([\d.]+)/g)].map((m) => ({ k: m[1], n: Number(m[2]), x: Number(m[3]), y: Number(m[4]) }));
    const top = seen.slice(0, 4).map((e) => `#${e.k} ${e.n}`).join('、') || '（全黑）';
    for (const c of l.lcd_colors) {
      const want = parseInt(c.rgb.slice(1), 16);
      const tol = c.tol ?? 24;
      const near = (k: string) => Math.max(...[16, 8, 0].map((sh) => Math.abs(((parseInt(k, 16) >> sh) & 255) - ((want >> sh) & 255)))) <= tol;
      const hit = seen.filter((e) => near(e.k));
      const n = hit.reduce((a, e) => a + e.n, 0);
      const enough = n >= c.min && (c.max === undefined || n <= c.max);
      let ok = enough;
      let text = `圆屏${c.name}（${c.rgb} ±${tol}）${n} 像素（要 ≥ ${c.min}${c.max !== undefined ? ` 且 ≤ ${c.max}` : ''}）`;
      if (c.cx) {
        const cx = n ? hit.reduce((a, e) => a + e.n * e.x, 0) / n : -1;
        ok = ok && c.cx[0] <= cx && cx <= c.cx[1];
        text += `，水平重心 ${n ? cx.toFixed(1) : '—'}（要 ${c.cx[0]}–${c.cx[1]}）`;
      }
      if (c.cy) {
        const cy = n ? hit.reduce((a, e) => a + e.n * e.y, 0) / n : -1;
        ok = ok && c.cy[0] <= cy && cy <= c.cy[1];
        text += `，竖直重心 ${n ? cy.toFixed(1) : '—'}（要 ${c.cy[0]}–${c.cy[1]}）`;
      }
      if (!ok) text += `；画面主色 ${top}`;
      const say = ok ? `圆屏上的${c.name}对` : !n ? `圆屏上没有${c.name}` : !enough ? (n < c.min ? `圆屏上的${c.name}太少` : `圆屏上的${c.name}太多`) : `圆屏上的${c.name}位置不对`;
      res.push({ ok, text, say, tag: '圆屏' });
    }
  }
  return res;
}

/** PWM 那一行的人话：舵机说偏了几度，蜂鸣器说音调 */
function pwmSay(dev: 'servo' | 'buzzer' | 'other', ok: boolean, fBad: boolean, pw: NonNullable<Level['pwm']>, lo: number, hi: number, f: number) {
  const ms = (d: number, hz: number) => (d * 1000) / hz;
  if (dev === 'servo') {
    if (ok) return pw.min === pw.max ? '舵机转到了该到的位置' : '舵机来回摆动的范围对';
    if (fBad) return `舵机信号频率不对，应为 ${pw.freq} Hz`;
    if (pw.min === pw.max && lo === hi) {
      const d = ms(lo, f) - ms(pw.min, pw.freq);
      return `舵机${d > 0 ? '多' : '少'}转了约 ${servoDeg(d)}°`;
    }
    return '舵机摆动的范围不对';
  }
  if (dev === 'buzzer') return ok ? '蜂鸣器音调对' : fBad ? `蜂鸣器音调不对，应为 ${pw.freq} Hz` : '蜂鸣器的信号不对';
  return ok ? 'PWM 输出对' : 'PWM 输出不对';
}

/** Python 的 {:g}：6 位有效数字、去掉尾随 0 */
function fmtG(x: number) {
  if (x === 0) return '0';
  const s = x.toPrecision(6);
  return s.includes('e') ? s : s.replace(/\.?0+$/, '');
}

/** 给用户和 AI 的验收命令：本地 npm 包 packages/tryboard（与 tools/check.py 同规则、同指纹；本地包，尚未发布） */
// 选板生成的检查点不在 levels.json 里：命令行读「导出检查点」下载的 JSON（U-17）
export const checkCommand = (l: Level) => (l.work === 'custom' ? `npx tryboard check app.bin --level-json checkpoints.json --level ${l.id}` : `npx tryboard check app.bin --level ${l.id}`);
/** 仓库开发者用的同一条验收（原生内核） */
export const devCheckCommand = (l: Level) => `tools/check.py app.bin --level ${l.id}`;
/** 命令提示下面那行说明（HTML） */
export const checkCommandNote = (_l: Level) => `<p class="note">命令行跑出的结论和运行编号与网页相同；退出码 0 表示通过。</p>`;
export { esc };
