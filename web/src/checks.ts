// Level checks and run fingerprint. Rules mirror tools/check.py one by one: one firmware gets the same verdict and fingerprint on CLI and web.
// `text` is the raw line, byte-identical to the CLI, so it stays English; `say` / `dev` / `tag` are UI words and go through t().

import { t } from './i18n/index.ts';
import { chipAt, pwmDevice, servoDeg, want as wantN } from './ui/say.ts';
import type { ConfLevel } from './ui/conf.tsx';
import type { Fault } from './faults.ts';

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
  /** last: the last frame LED by LED (count, how many lit, lit color ±tol) */
  ws2812?: { pin: number; min_frames?: number; frames?: string[][]; dominant?: 'r' | 'g' | 'b'; last?: { count: number; lit?: number; rgb: string; tol?: number } };
  numeric?: { name: string; regex: string; value: number; tol: number }[];
  oled_min_pixels?: number;
  lcd_min_pixels?: number;
  /** Minimum occurrences of a serial text (e.g. the BLINK of a blink) */
  serial_count?: { text: string; min: number }[];
  /** Pixels of a color (±tol, max channel difference) in the round LCD's last frame, optional centroid ranges: what is drawn and where */
  lcd_colors?: { name: string; rgb: string; min: number; max?: number; tol?: number; cx?: [number, number]; cy?: [number, number] }[];
  /** What the USB virtual host saw (level runs with --usb-log): device state, typed text (P2-12) */
  usb?: { state?: string; typed?: string };
  /** The product this checkpoint belongs to (spin-1 etc.); absent for the weather station / level 07 */
  work?: string;
  /** true means 'weather'; a string names the assembly template */
  assembly?: boolean | string;
  /** Several products to choose from (level 07): each is a full set of criteria */
  variants?: (Omit<Level, 'id'> & { key: string })[];
  key?: string;
  /** Boot: no crash within `seconds` and at least one serial line (generated checkpoints, U-17) */
  boots?: boolean;
  /** Minimum acks per I2C address (level runs with --i2c-log; 7-bit addresses) */
  i2c_ack?: { addr: number; min: number }[];
  /** Items the web cannot prove and real hardware must: listed, not judged, not counted */
  manual?: boolean;
  /** Fault checkpoint (F-05): bench as found + switches the player may change; run through faultLevel() in faults.ts */
  fault?: Fault;
}

/** Expand sub-levels (07-spin, 07-lens), same as expand in tools/check.py */
export function expandLevels(levels: Level[]): Level[] {
  return levels.flatMap((l) => [l, ...(l.variants ?? []).map((v) => ({ ...v, id: `${l.id}-${v.key}`, title: `${l.title} · ${v.title}` }))]);
}

export interface CheckResult {
  ok: boolean;
  /** Verdict line identical to tools/check.py (shown under "Raw data") */
  text: string;
  /** Plain-language line (DESIGN_V2 §9): the device is the subject, zero says "not" */
  say?: string;
  /** Device name (servo / buzzer / BME280 ...): result cards group by it + tag (DESIGN_V2 §9.5) */
  dev?: string;
  /** Small print: pin / address / serial */
  tag?: string;
  /** Trust level of this one row (D-05); UI only, never part of the raw line or the fingerprint */
  conf?: ConfLevel;
  /** Why the row needs real hardware (timing-sensitive code, D-03) */
  note?: string;
}

/** Turn --i2c / --env / --spi / --servo / --power / --encoder / --sonar / --touch-int args into boot options (the web has no command line) */
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
  // --encoder A,B[,SW] / --sonar TRIG,ECHO [--dist cm]
  const en = val('--encoder')?.split(',').map(Number);
  const encoder = en && en.length >= 2 ? { a: en[0], b: en[1], ...(en.length > 2 ? { sw: en[2] } : {}) } : undefined;
  const so = val('--sonar')?.split(',').map(Number);
  const dist = val('--dist');
  const sonar = so && so.length === 2 ? { trig: so[0], echo: so[1], ...(dist !== undefined ? { cm: Number(dist) } : {}) } : undefined;
  const dh = val('--dht11');
  const dht11 = dh === undefined ? undefined : Number(dh);
  const board = val('--board');
  const ti = val('--touch-int');
  const touchInt = ti === undefined ? undefined : Number(ti);
  // Harness (P2-11, estimate): total I2C wire length, antenna blockage
  const wv = val('--i2c-wire');
  const i2cWire = wv === undefined ? undefined : Number(wv);
  const av = val('--antenna-loss');
  const antenna = av === undefined ? undefined : Number(av);
  return { i2c, env, lcd, servo, power, encoder, sonar, dht11, touchInt, board, usb: a.includes('--usb-log'), i2cLog: a.includes('--i2c-log'), i2cWire, antenna };
}

/** Timed input script like the CLI's parse_script: time (simulated s):action, split by `;` or newline, `#` starts a comment */
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

// Transition: the USB host state names come from esp32s3 usb/host.rs (core agent); old names map to the English ones

export function evaluate(l: Level, out: string, report: string): CheckResult[] {
  const res: CheckResult[] = [];
  const serial = t('Serial');
  for (const e of l.expect ?? []) {
    const ok = out.includes(e);
    res.push({ ok, text: `serial shows "${e}"`, say: ok ? t('Serial printed "{e}"', { e }) : t('Serial did not print "{e}"', { e }), tag: serial, dev: serial });
  }
  if (/Guru Meditation|abort\(\)|panic/.test(out)) res.push({ ok: false, text: 'firmware crashed', say: t('Firmware crashed; the chip keeps rebooting'), tag: serial, dev: serial });
  if (l.boots) {
    // Non-empty line: something left after stripping spaces, tabs and CRs (same test as check.py)
    const n = out.split('\n').filter((x) => x.replace(/[ \t\r]/g, '') !== '').length;
    const crashed = /Guru Meditation|abort\(\)|panic/.test(out);
    const ok = n >= 1 && !crashed;
    const s = l.seconds ?? 2;
    res.push({ ok, text: `boot: ${n} serial lines within ${s} s`, say: ok ? t('Boots fine, serial has output') : crashed ? t('Crashes right at boot') : t('No serial output within {s} s of boot', { s }), tag: serial, dev: serial });
  }
  for (const c of l.i2c_ack ?? []) {
    const a = c.addr.toString(16).padStart(2, '0');
    const m = report.match(new RegExp(`I2C 0x${a} acked (\\d+) times`));
    const n = m ? Number(m[1]) : 0;
    const who = chipAt(c.addr);
    const say = n >= c.min ? t('{who} responds', { who }) : n ? t('{who} responded only {n} times, needs at least {min}', { who, n, min: c.min }) : t('{who} does not respond', { who });
    res.push({ ok: n >= c.min, text: `I2C 0x${a} acked ${n} times (need ≥ ${c.min})`, say, tag: `I2C 0x${a}`, dev: who });
  }
  const g = l.gpio_toggles;
  if (g) {
    const m = report.match(new RegExp(`GPIO${g.pin} toggled (\\d+) times`));
    const n = m ? Number(m[1]) : 0;
    const ok = n >= g.min && (g.max === undefined || n <= g.max);
    const want = g.max === g.min ? `${g.min}` : `≥ ${g.min}` + (g.max !== undefined ? ` and ≤ ${g.max}` : '');
    const times = wantN(g.min, g.max);
    const say = ok ? t('LED blinked {n} times', { n }) : n ? t('LED blinked {n} times, should be {times}', { n, times }) : t('LED did not blink, should blink {times} times', { times });
    res.push({ ok, text: `GPIO${g.pin} toggled ${n} times (need ${want})`, say, tag: `GPIO${g.pin}`, dev: 'LED' });
  }
  const pw = l.pwm;
  if (pw) {
    const m = report.match(new RegExp(`PWM GPIO${pw.pin}: (\\d+) changes, duty ([\\d.]+)\\.\\.([\\d.]+), freq ([\\d.]+)Hz`));
    const dev = pwmDevice(pw.freq, !!pw.beeps);
    const name = { servo: t('Servo'), buzzer: t('Buzzer'), other: t('PWM output') }[dev];
    if (!m || Number(m[4]) === 0) res.push({ ok: false, text: `GPIO${pw.pin} has no PWM output`, say: t('{name} gets no signal', { name }), tag: `GPIO${pw.pin}`, dev: name });
    else {
      let lo = Number(m[2]),
        hi = Number(m[3]);
      const f = Number(m[4]);
      const sm = report.match(new RegExp(`PWM GPIO${pw.pin} steps (.*)`));
      const ch = sm ? [...sm[1].matchAll(/([\d.]+)@([\d.]+)/g)].map((x) => [Number(x[1]), Number(x[2])]) : [];
      if (pw.from !== undefined && ch.length) {
        // Settled part only: the value being output at `from` plus later changes
        const before = ch.filter(([, t]) => t <= pw.from!).map(([d]) => d);
        const win = [...before.slice(-1), ...ch.filter(([, t]) => t > pw.from!).map(([d]) => d)];
        lo = Math.min(...win);
        hi = Math.max(...win);
      }
      const tol = pw.tol ?? 0.01;
      const ok = Math.abs(f - pw.freq) <= pw.freq * 0.01 && Math.abs(lo - pw.min) <= tol && Math.abs(hi - pw.max) <= tol;
      const when = pw.from !== undefined ? `, after ${pw.from} s` : '';
      // Pulse width first (what a servo cares about); on failure state the target so nobody has to convert duty by hand
      const span = (a: string, b: string) => (a === b ? a : `${a}–${b}`);
      const ms = (d: number, hz: number) => ((d * 1000) / hz).toFixed(2);
      const fBad = Math.abs(f - pw.freq) > pw.freq * 0.01;
      const want = ok ? '' : `; need ${span(ms(pw.min, pw.freq), ms(pw.max, pw.freq))} ms${fBad ? `, ${pw.freq} Hz` : ''}`;
      res.push({ ok, text: `GPIO${pw.pin} PWM ${f.toFixed(0)} Hz${when}, pulse ${span(ms(lo, f), ms(hi, f))} ms (duty ${span(lo.toFixed(3), hi.toFixed(3))})${want}`, say: pwmSay(dev, ok, fBad, pw, lo, hi, f), tag: `GPIO${pw.pin}`, dev: name });
      if (pw.steps) {
        const seq = ch.map(([d]) => d);
        let i = 0;
        const miss: number[] = [];
        for (const want of pw.steps) {
          let j = i;
          while (j < seq.length && Math.abs(seq[j] - want) > 0.002) j++;
          if (j === seq.length) miss.push(want); // not found: keep the cursor so later steps can still match
          else i = j + 1;
        }
        const ms = (d: number) => ((d * 1000) / pw.freq).toFixed(1);
        const total = pw.steps.length;
        const say = miss.length ? t('{name} missed {n} of {total} positions', { name, n: miss.length, total }) : t('{name} reached all {total} positions in order', { name, total });
        res.push({ ok: !miss.length, text: `pulse widths in order ${pw.steps.map(ms).join(' → ')} ms` + (miss.length ? `: missing ${miss.map(ms).join(', ')} ms` : ''), say, tag: `GPIO${pw.pin}`, dev: name });
      }
      for (const b of pw.beeps ?? []) {
        // Beeps: times duty goes from 0 (or no output) to > 0 inside the window (buzzer rhythm, "faster when closer")
        let n = 0;
        let prev = 0;
        for (const [d, at] of ch) {
          if (d > 0 && prev === 0 && b.from <= at && at <= b.to) n++;
          prev = d;
        }
        const want = b.min === b.max ? `${b.min}` : `${b.min}–${b.max}`;
        const ok = b.min <= n && n <= b.max;
        const win = t('{from}–{to} s', { from: b.from, to: b.to });
        const say =
          b.max === 0
            ? ok
              ? t('{win}: buzzer quiet', { win })
              : t('{win}: buzzer should be quiet but beeped {n} times', { win, n })
            : ok
              ? t('{win}: buzzer beeped {n} times', { win, n })
              : n
                ? t('{win}: buzzer beeped {n} times, should be {want}', { win, n, want })
                : t('{win}: buzzer silent, should beep {want} times', { win, want });
        res.push({ ok, text: `GPIO${pw.pin} ${b.from}–${b.to} s beeped ${n} times (need ${want})`, say, tag: `GPIO${pw.pin}`, dev: name });
      }
    }
  }
  const w = l.ws2812;
  if (w) {
    const sec = report.match(new RegExp(`WS2812 GPIO${w.pin} (\\d+) frames\\n((?:    .*\\n?)*)`));
    const nf = sec ? Number(sec[1]) : 0;
    const frames = sec ? sec[2].split('\n').filter(Boolean).map((x) => x.trim().split(/\s+/).slice(1)) : [];
    let ok = nf >= (w.min_frames ?? 1);
    (w.frames ?? []).forEach((want, i) => {
      ok = ok && i < frames.length && frames[i].join(' ') === want.join(' ');
    });
    let text = `WS2812 GPIO${w.pin} ${nf} frames`;
    let say = nf ? t('RGB LED got {n} frames of data', { n: nf }) : t('RGB LED got no data');
    if (w.dominant) {
      const last = frames.length && frames[frames.length - 1].length ? frames[frames.length - 1][0] : '#000000';
      const rgb = [0, 1, 2].map((k) => parseInt(last.slice(1 + 2 * k, 3 + 2 * k), 16));
      const k = 'rgb'.indexOf(w.dominant);
      ok = ok && rgb[k] > 0 && rgb[k] === Math.max(...rgb) && rgb.filter((x) => x === rgb[k]).length === 1;
      const hue = { r: 'red', g: 'green', b: 'blue' }[w.dominant];
      text += `, last frame ${last} (need ${hue})`;
      const is = { r: t('RGB LED is red'), g: t('RGB LED is green'), b: t('RGB LED is blue') }[w.dominant];
      const isNot = { r: t('RGB LED is not red'), g: t('RGB LED is not green'), b: t('RGB LED is not blue') }[w.dominant];
      if (nf) say = ok ? is : isNot;
    }
    if (w.last) {
      // Last frame LED by LED: count, how many lit, lit color (±tol per channel)
      const L = w.last;
      const last = frames.length ? frames[frames.length - 1] : [];
      const want = parseInt(L.rgb.slice(1), 16);
      const tol = L.tol ?? 0;
      const litWant = L.lit ?? L.count;
      const lit = last.filter((c) => c !== '#000000');
      const near = (c: string) => Math.max(...[16, 8, 0].map((sh) => Math.abs(((parseInt(c.slice(1), 16) >> sh) & 255) - ((want >> sh) & 255)))) <= tol;
      const good = last.length === L.count && lit.length === litWant && lit.every(near);
      ok = ok && good;
      text += `, last frame ${last.length} LEDs, ${lit.length} lit (need ${L.count} LEDs, ${litWant} lit ${L.rgb} ±${tol})`;
      if (!good) text += `: ${last.join(' ') || '(no frames)'}`;
      if (nf)
        say = good
          ? t('All {count} LEDs on the strip are right', { count: L.count })
          : last.length !== L.count
            ? t('Strip got {n} LEDs, should be {count}', { n: last.length, count: L.count })
            : lit.length !== litWant
              ? t('Strip lit {n} LEDs, should light {want}', { n: lit.length, want: litWant })
              : t('Strip color is wrong');
    }
    if (nf && !ok && !w.dominant && !w.last) say = t('RGB LED data is wrong');
    res.push({ ok, text, say, tag: `GPIO${w.pin}`, dev: w.last ? t('LED strip') : t('RGB LED') });
  }
  for (const n of l.numeric ?? []) {
    const vals = [...out.matchAll(new RegExp(n.regex, 'g'))].map((m) => Number(m[1]));
    const worst = vals.length ? Math.max(...vals.map((v) => Math.abs(v - n.value))) : null;
    const ok = worst !== null && worst <= n.tol;
    const name = t(n.name);
    const say = worst === null ? t('Serial did not print {name}', { name }) : ok ? t('{name} reading is accurate', { name }) : t('{name} reading is off by {d}, should be within ±{tol}', { name, d: fmtG(worst), tol: n.tol });
    res.push({ ok, text: `${n.name} ${vals.length} readings, max deviation ${worst === null ? '—' : fmtG(worst)} (tolerance ${n.tol})`, say, tag: serial, dev: serial });
  }
  if (l.oled_min_pixels !== undefined) {
    const m = report.match(/OLED lit pixels (\d+)/);
    const n = m ? Number(m[1]) : 0;
    const min = l.oled_min_pixels;
    const say = n >= min ? t('Screen is on') : n ? t('Too little on the screen: {n} pixels lit, needs at least {min}', { n, min }) : t('Screen is not lit');
    res.push({ ok: n >= min, text: `OLED lit ${n} pixels (need ≥ ${min})`, say, tag: 'OLED', dev: t('Screen') });
  }
  if (l.lcd_min_pixels !== undefined) {
    const m = report.match(/LCD GC9A01 non-black pixels (\d+)/);
    const n = m ? Number(m[1]) : 0;
    const min = l.lcd_min_pixels;
    const lcd = t('Round LCD');
    const say = n >= min ? t('Round LCD is on') : n ? t('Too little on the round LCD: {n} pixels lit, needs at least {min}', { n, min }) : t('Round LCD is not lit');
    res.push({ ok: n >= min, text: `round LCD lit ${n} pixels (need ≥ ${min})`, say, tag: lcd, dev: lcd });
  }
  for (const c of l.serial_count ?? []) {
    const n = out.split(c.text).length - 1;
    const v = { text: c.text, n, min: c.min };
    const say = n >= c.min ? t('Serial printed "{text}" {n} times', v) : n ? t('Serial printed "{text}" only {n} times, needs at least {min}', v) : t('Serial did not print "{text}"', v);
    res.push({ ok: n >= c.min, text: `serial "${c.text}" appeared ${n} times (need ≥ ${c.min})`, say, tag: serial, dev: serial });
  }
  if (l.usb) {
    const m = report.match(/USB host: (.+)$/m);
    const st = m ? m[1] : 'no USB device';
    if (l.usb.state !== undefined) {
      const need = l.usb.state;
      const say = st === need ? t('The PC recognized the device: {st}', { st: t(st) }) : t('The PC sees {st}, should be {need}', { st: t(st), need: t(need) });
      res.push({ ok: st === need, text: `USB device seen by the PC: ${st} (need ${need})`, say, tag: 'USB', dev: 'USB' });
    }
    if (l.usb.typed !== undefined) {
      const tm = report.match(/^\[tryboard\] USB keyboard typed: (".*")$/m);
      const got: string = tm ? JSON.parse(tm[1]) : '';
      const shown = (x: string) => x.replaceAll('\n', '↵');
      const v = { got: shown(got), want: shown(l.usb.typed) };
      const say = got === l.usb.typed ? t('The PC typed "{got}"', v) : got ? t('The PC typed "{got}", should be "{want}"', v) : t('Nothing was typed on the PC');
      res.push({ ok: got === l.usb.typed, text: `typed on the PC "${v.got}" (need "${v.want}")`, say, tag: 'USB', dev: 'USB' });
    }
  }
  if (l.lcd_colors?.length) {
    const colorRe = /LCD color #([0-9a-f]{6}) (\d+) px, centroid ([\d.]+),([\d.]+)/g;
    const seen = [...report.matchAll(colorRe)].map((m) => ({ k: m[1], n: Number(m[2]), x: Number(m[3]), y: Number(m[4]) }));
    const top = seen.slice(0, 4).map((e) => `#${e.k} ${e.n}`).join(', ') || '(all black)';
    const lcd = t('Round LCD');
    for (const c of l.lcd_colors) {
      const want = parseInt(c.rgb.slice(1), 16);
      const tol = c.tol ?? 24;
      const near = (k: string) => Math.max(...[16, 8, 0].map((sh) => Math.abs(((parseInt(k, 16) >> sh) & 255) - ((want >> sh) & 255)))) <= tol;
      const hit = seen.filter((e) => near(e.k));
      const n = hit.reduce((a, e) => a + e.n, 0);
      const enough = n >= c.min && (c.max === undefined || n <= c.max);
      let ok = enough;
      let text = `round LCD ${c.name} (${c.rgb} ±${tol}) ${n} px (need ≥ ${c.min}${c.max !== undefined ? ` and ≤ ${c.max}` : ''})`;
      if (c.cx) {
        const cx = n ? hit.reduce((a, e) => a + e.n * e.x, 0) / n : -1;
        ok = ok && c.cx[0] <= cx && cx <= c.cx[1];
        text += `, horizontal centroid ${n ? cx.toFixed(1) : '—'} (need ${c.cx[0]}–${c.cx[1]})`;
      }
      if (c.cy) {
        const cy = n ? hit.reduce((a, e) => a + e.n * e.y, 0) / n : -1;
        ok = ok && c.cy[0] <= cy && cy <= c.cy[1];
        text += `, vertical centroid ${n ? cy.toFixed(1) : '—'} (need ${c.cy[0]}–${c.cy[1]})`;
      }
      if (!ok) text += `; main colors ${top}`;
      const name = t(c.name);
      const say = ok
        ? t('The {name} on the round LCD is right', { name })
        : !n
          ? t('No {name} on the round LCD', { name })
          : !enough
            ? n < c.min
              ? t('Too little {name} on the round LCD', { name })
              : t('Too much {name} on the round LCD', { name })
            : t('The {name} on the round LCD is in the wrong place', { name });
      res.push({ ok, text, say, tag: lcd, dev: lcd });
    }
  }
  return withConf(res, out, report);
}

/** Pins the core flagged as timing-sensitive: `[tryboard] timing-sensitive: GPIO5 busy-wait esp_rom_delay_us ×N, ...` */
export function timingPins(report: string): { pins: number[]; line: string } | null {
  const m = report.match(/\[tryboard\] timing-sensitive: (.*)/);
  if (!m) return null;
  const pins = [...new Set([...m[1].matchAll(/GPIO(\d+)/g)].map((x) => Number(x[1])))];
  return { pins, line: m[1].trim() };
}

/** Per-row trust level (D-05): instruction-level CPU and bus models are "simulated"; virtual sensors, screens, the USB host
 *  and the virtual network are behaviour models; rows on timing-sensitive pins need real hardware. */
function withConf(res: CheckResult[], out: string, report: string): CheckResult[] {
  const SIM: ConfLevel = '仿真验证'; // lint: allow-cjk
  const BEH: ConfLevel = '行为模拟'; // lint: allow-cjk
  const HW: ConfLevel = '必须上真机'; // lint: allow-cjk
  const net = /\bwifi:/.test(out);
  for (const r of res) {
    const x = r.text;
    if (/ readings, max deviation|OLED lit|round LCD |USB device|typed on the PC/.test(x)) r.conf = BEH;
    else if (/^serial |^boot:|^firmware crashed/.test(x)) r.conf = net ? BEH : SIM;
    else r.conf = SIM;
  }
  const timing = timingPins(report);
  if (timing) {
    const note = t('The firmware times this pin with busy-wait loops; the simulated CPU speed is not the real one, so this only shows the logic is right.');
    let hit = res.filter((r) => timing.pins.some((p) => r.tag === `GPIO${p}`));
    // A single-wire sensor's result is usually a serial reading, not a pin row: flag the readings instead
    if (!hit.length) hit = res.filter((r) => / readings, max deviation/.test(r.text));
    if (!hit.length) hit = res.filter((r) => r.ok && /^serial /.test(r.text)).slice(-1);
    for (const r of hit) {
      r.conf = HW;
      r.note = note;
    }
  }
  return res;
}

/** Plain words for the PWM row: servos say how many degrees off, buzzers talk about pitch */
function pwmSay(dev: 'servo' | 'buzzer' | 'other', ok: boolean, fBad: boolean, pw: NonNullable<Level['pwm']>, lo: number, hi: number, f: number) {
  const ms = (d: number, hz: number) => (d * 1000) / hz;
  if (dev === 'servo') {
    if (ok) return pw.min === pw.max ? t('Servo reached its position') : t('Servo sweep range is right');
    if (fBad) return t('Servo signal frequency is wrong, should be {freq} Hz', { freq: pw.freq });
    if (pw.min === pw.max && lo === hi) {
      const d = ms(lo, f) - ms(pw.min, pw.freq);
      const deg = servoDeg(d);
      return d > 0 ? t('Servo turned about {deg}° too far', { deg }) : t('Servo turned about {deg}° too little', { deg });
    }
    return t('Servo sweep range is wrong');
  }
  if (dev === 'buzzer') return ok ? t('Buzzer pitch is right') : fBad ? t('Buzzer pitch is wrong, should be {freq} Hz', { freq: pw.freq }) : t('Buzzer signal is wrong');
  return ok ? t('PWM output is right') : t('PWM output is wrong');
}

/** Python's {:g}: 6 significant digits, trailing zeros dropped */
function fmtG(x: number) {
  if (x === 0) return '0';
  const s = x.toPrecision(6);
  return s.includes('e') ? s : s.replace(/\.?0+$/, '');
}

/** Check command for users and AI: local npm package packages/tryboard (same rules and fingerprint as tools/check.py; not yet published) */
// Board-generated checkpoints are not in levels.json: the CLI reads the JSON from "Export checkpoints" (U-17)
export const checkCommand = (l: Level) => (l.work === 'custom' ? `npx tryboard check app.bin --level-json checkpoints.json --level ${l.id}` : `npx tryboard check app.bin --level ${l.id}`);
/** The same check for repo developers (native core) */
export const devCheckCommand = (l: Level) => `tools/check.py app.bin --level ${l.id}`;
/** The note under the command hint (HTML) */
export const checkCommandNote = (_l: Level) => `<p class="note">${t('The command line gives the same verdict and run ID as the web; exit code 0 means pass.')}</p>`;
export { esc };
