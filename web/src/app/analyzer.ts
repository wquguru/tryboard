// 实验台底部的逻辑分析仪（P1-05）：多通道时间轴（I2C 的 SCL / SDA + 解码泡泡、PWM、GPIO、板载彩灯），
// 滚轮缩放、拖动平移、点击放光标读时间差。数据是内核按 CPU 周期盖戳的事件（session.io），不是采样：
// I2C 来自主机模型的事务层，SCL / SDA 波形按事务和位时序画出来（位级以下标"按事务重建"）；PWM 按占空比 / 频率画，
// 缩小到一个周期不到 3 像素时画包络和"50 Hz · 1.675 ms"。只画可视窗口（二分查找起点），canvas 2D。
// 跟随：右边缘贴着当前模拟时刻；时间线回退后模拟停在回退点、事件按重放重建，分析仪跟着停在那一刻。
import type { PartSpec } from '../board3d';
import type { StepCtx } from './types';
import { CPU_HZ, firstTxnEndingAfter, fmtTime, hex, lastLE, pwmLabel, txnNote, txnText, type I2cTxn } from './iotrace';

export type Channel =
  | { id: string; kind: 'i2c'; port: number; sda: number; scl: number; label: string }
  | { id: string; kind: 'pin'; pin: number; label: string; role: string }
  | { id: string; kind: 'ws'; pin: number; label: string };

export interface Analyzer {
  readonly isOpen: boolean;
  /** 打开；给了针脚（'GPIO4' / 'I2C0'）就确保有这个通道并滚到它、闪一下 */
  open(focus?: string): void;
  close(): void;
  toggle(): void;
  /** 视图（测试 / ⌘K 用）：窗口 [end - span, end]，秒 */
  view(): { end: number; span: number; follow: boolean };
  setView(v: { end?: number; span?: number; follow?: boolean }): void;
  /** 把窗口对到第 i 个（负数从后数）I2C 事务，按 pad 倍宽度留边 */
  zoomToTxn(i: number, pad?: number, filter?: (x: I2cTxn) => boolean): I2cTxn | null;
  channels(): Channel[];
  /** 画面上看得到的 I2C 泡泡文字（测试读） */
  visibleBubbles(): string[];
  /** 光标 A / B（秒）；null 清掉 */
  setCursor(which: 'a' | 'b', t: number | null): void;
}

const LABEL_W = 96;
const RULER_H = 20;
const ROW_H = { scl: 22, sda: 22, dec: 46, pin: 34, ws: 22 } as const;
const css = (n: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;

let single: Analyzer | null = null;
/** 整页一个分析仪（实验台挂载时建，⌘K 也用它） */
export function getAnalyzer(ctx: StepCtx): Analyzer {
  single ??= createAnalyzer(ctx);
  return single;
}

function defaultChannels(parts: PartSpec[], chip: string): Channel[] {
  const ch: Channel[] = [];
  const bus = parts.find((p): p is Extract<PartSpec, { sda: number }> => 'sda' in p);
  if (bus) {
    const devs = parts.filter((p) => 'sda' in p).map((p) => `${p.type === 'bme280' ? 'BME280' : 'OLED'} ${hex((p as { addr: number }).addr)}`);
    ch.push({ id: 'I2C0', kind: 'i2c', port: 0, sda: bus.sda, scl: bus.scl, label: devs.join(' · ') });
  }
  for (const p of parts) {
    if (p.type === 'servo') ch.push({ id: `GPIO${p.pin}`, kind: 'pin', pin: p.pin, label: `GPIO${p.pin}`, role: '舵机' });
    if (p.type === 'buzzer') ch.push({ id: `GPIO${p.pin}`, kind: 'pin', pin: p.pin, label: `GPIO${p.pin}`, role: '蜂鸣器' });
    if (p.type === 'led') ch.push({ id: `GPIO${p.pin}`, kind: 'pin', pin: p.pin, label: `GPIO${p.pin}`, role: 'LED' });
  }
  const boot = chip === 'esp32s3' ? 0 : 9;
  ch.push({ id: `GPIO${boot}`, kind: 'pin', pin: boot, label: `GPIO${boot}`, role: 'BOOT 键' });
  const rgb = chip === 'esp32s3' ? 48 : 8;
  ch.push({ id: `RGB${rgb}`, kind: 'ws', pin: rgb, label: `GPIO${rgb}` });
  return ch;
}

const rowsOf = (c: Channel) => (c.kind === 'i2c' ? ROW_H.scl + ROW_H.sda + ROW_H.dec : c.kind === 'pin' ? ROW_H.pin : ROW_H.ws);

export function createAnalyzer(ctx: StepCtx): Analyzer {
  const { session, store, shell } = ctx;
  const el = document.createElement('section');
  el.className = 'pnl analyzer';
  el.id = 'analyzer';
  el.hidden = true;
  el.setAttribute('aria-label', '逻辑分析仪');
  el.innerHTML = `<header class="ana-h">
<span class="ana-t">逻辑分析仪</span>
<span class="ana-src mono muted" data-a="src"></span>
<span class="ana-read mono" data-a="read"></span>
<span class="ana-sp"></span>
<button type="button" class="ana-b" data-act="prev" title="上一个 I2C 事务">◂ I2C</button><button type="button" class="ana-b" data-act="next" title="下一个 I2C 事务">I2C ▸</button>
<span class="ana-sep"></span>
<button type="button" class="ana-b" data-act="out" title="缩小（滚轮）">−</button><span class="ana-span mono" data-a="span"></span><button type="button" class="ana-b" data-act="in" title="放大（滚轮）">+</button>
<button type="button" class="ana-b" data-act="follow" aria-pressed="true" title="右边缘跟着当前模拟时刻">跟随</button>
<button type="button" class="ana-b" data-act="close" title="关闭" aria-label="关闭逻辑分析仪">×</button>
</header>
<div class="ana-body"><canvas class="ana-cv" aria-label="逻辑分析仪波形"></canvas></div>
<footer class="ana-f"><span class="mono" data-a="cur"></span><span class="muted" data-a="hint">点击放光标 A，Shift+点击放 B；滚轮缩放，拖动平移</span></footer>`;
  document.body.appendChild(el);
  const cv = el.querySelector<HTMLCanvasElement>('canvas')!;
  const $ = (k: string) => el.querySelector<HTMLElement>(`[data-a="${k}"]`)!;

  let open = false;
  let chans: Channel[] = defaultChannels(session.scene.parts, session.chip);
  let follow = true;
  let span = 1; // 秒
  let end = 0;
  let now = 0;
  let cursA: number | null = null;
  let cursB: number | null = null;
  let hover: { x: number; y: number } | null = null;
  let flash: { id: string; until: number } | null = null;
  let dirty = true;
  let raf = 0;
  let bubbles: string[] = [];
  let txnHit: { x0: number; x1: number; y0: number; y1: number; x: I2cTxn }[] = [];
  let lastScene = session.scene;

  const watchChannels = () => {
    const pins = new Set(session.ioPins());
    for (const c of chans) {
      if (c.kind === 'pin') pins.add(c.pin);
      if (c.kind === 'i2c') {
        pins.add(c.sda);
        pins.add(c.scl);
      }
    }
    const cur = session.ioPins();
    if (cur.length !== pins.size || cur.some((p) => !pins.has(p))) session.watchIo([...pins]);
  };

  function layout() {
    const h = RULER_H + chans.reduce((a, c) => a + rowsOf(c), 0);
    el.style.setProperty('--ana-cv-h', `${h}px`);
    document.body.style.setProperty('--ana-h', `${h + 66}px`);
  }

  function setOpen(v: boolean) {
    open = v;
    el.hidden = !v;
    document.body.classList.toggle('ana-open', v);
    if (v) {
      if (session.scene !== lastScene) {
        // 台面换过（按清单摆上 / 回退）：默认通道跟着换，手动加的保留
        const keep = chans.filter((c) => c.kind === 'pin' && !defaultChannels(lastScene.parts, session.chip).some((d) => d.id === c.id));
        chans = defaultChannels(session.scene.parts, session.chip);
        for (const k of keep) if (!chans.some((c) => c.id === k.id)) chans.push(k);
        lastScene = session.scene;
      }
      watchChannels();
      layout();
      dirty = true;
      loop();
    } else cancelAnimationFrame(raf);
  }

  function loop() {
    cancelAnimationFrame(raf);
    if (!open) return;
    if (follow) {
      // 停住（暂停 / 回退点）时右边留一点空，看得见"回退点"那条线
      const st = store.get();
      const e = Math.max(now, span) + (st.running && !st.hist.seeked ? 0 : span * 0.06);
      if (e !== end) {
        end = e;
        dirty = true;
      }
    }
    // 不在实验台（CSS 藏起来了）就不画，回来时再画
    if (dirty && document.body.dataset.step === 'bench') {
      dirty = false;
      draw();
    }
    raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- 输入
  session.onTick((m) => {
    now = m.simSeconds;
    if (open && follow) dirty = true;
  });
  session.onIo(() => {
    if (open) dirty = true;
  });
  store.subscribe((s) => {
    // 回退（seek）把模拟停在那一刻：simSeconds 由快照给出
    if (s.hist.seeked || !s.running) now = s.simSeconds;
    dirty = true;
  }, ['simSeconds', 'hist', 'running']);

  const xOf = (t: number, W: number) => LABEL_W + ((t - (end - span)) / span) * (W - LABEL_W);
  const tOf = (x: number, W: number) => end - span + ((x - LABEL_W) / (W - LABEL_W)) * span;
  const clampSpan = (s: number) => Math.min(120, Math.max(2e-6, s));

  function zoomAt(f: number, x?: number) {
    const W = cv.clientWidth;
    if (x === undefined || follow) {
      // 跟随时以右边缘为锚
      const ns = clampSpan(span * f);
      if (!follow) end = end - span / 2 + ns / 2;
      span = ns;
    } else {
      const t = tOf(x, W);
      const ns = clampSpan(span * f);
      const r = (end - t) / span;
      end = t + r * ns;
      span = ns;
    }
    dirty = true;
  }
  function setFollow(v: boolean) {
    follow = v;
    el.querySelector('[data-act="follow"]')!.setAttribute('aria-pressed', String(v));
    dirty = true;
  }

  cv.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX - r.left);
    },
    { passive: false },
  );
  let drag: { x: number; end: number; moved: boolean } | null = null;
  cv.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, end, moved: false };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect();
    hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) {
        if (follow) setFollow(false);
        end = drag.end - (dx / (cv.clientWidth - LABEL_W)) * span;
      }
    }
    dirty = true;
  });
  cv.addEventListener('pointerleave', () => {
    hover = null;
    dirty = true;
  });
  cv.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d || d.moved) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x < LABEL_W) return;
    const t = tOf(x, cv.clientWidth);
    if (e.shiftKey) cursB = t;
    else cursA = t;
    dirty = true;
  });
  el.querySelector('.ana-h')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') setOpen(false);
    else if (act === 'in') zoomAt(0.5);
    else if (act === 'out') zoomAt(2);
    else if (act === 'follow') setFollow(!follow);
    else if (act === 'prev' || act === 'next') stepTxn(act === 'next' ? 1 : -1);
  });

  function allTxns(): I2cTxn[] {
    return session.io.i2c.get(0) ?? [];
  }
  /** 从当前窗口中心找上一个 / 下一个事务 */
  function stepTxn(dir: number) {
    const xs = allTxns();
    if (!xs.length) return shell.toast('还没有 I2C 事务');
    const mid = (end - span / 2) * CPU_HZ;
    let i = dir > 0 ? xs.findIndex((x) => (x.t0 + x.t1) / 2 > mid + 1) : findLastIndex(xs, (x) => (x.t0 + x.t1) / 2 < mid - 1);
    if (i < 0) i = dir > 0 ? xs.length - 1 : 0;
    centerTxn(xs[i], 1.6);
  }
  function centerTxn(x: I2cTxn, pad: number) {
    const w = (x.t1 - x.t0) / CPU_HZ;
    setFollow(false);
    span = clampSpan(w * pad);
    end = (x.t0 + x.t1) / 2 / CPU_HZ + span / 2;
    dirty = true;
  }

  // ---------------------------------------------------------------- 画
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 800;
    const H = cv.clientHeight || 200;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const C = { fg: css('--fg', '#1E1E1E'), muted: css('--muted', '#8C8C8C'), line: css('--line', '#E6E6E6'), soft: css('--line-soft', '#F0F0F0'), accent: css('--accent', '#0D99FF'), abg: css('--accent-bg', '#E5F4FF'), bad: css('--bad', '#F24822'), ok: css('--ok', '#14AE5C'), field: css('--field', '#F7F7F7') };
    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, W, H);
    const t0 = end - span;
    const c0 = t0 * CPU_HZ;
    const c1 = end * CPU_HZ;
    const pxPerCyc = (W - LABEL_W) / (span * CPU_HZ);
    const X = (c: number) => LABEL_W + (c - c0) * pxPerCyc;
    g.font = '10px "JetBrains Mono", ui-monospace, monospace';
    g.textBaseline = 'middle';

    // 时间刻度
    const step = niceStep(span / 8);
    g.strokeStyle = C.soft;
    g.fillStyle = C.muted;
    g.lineWidth = 1;
    for (let t = Math.ceil(t0 / step) * step; t <= end; t += step) {
      const x = Math.round(xOf(t, W)) + 0.5;
      g.beginPath();
      g.moveTo(x, RULER_H - 4);
      g.lineTo(x, H);
      g.stroke();
      const lbl = fmtTick(t, step);
      g.fillText(lbl, x + 3, RULER_H / 2);
    }
    g.strokeStyle = C.line;
    g.beginPath();
    g.moveTo(0, RULER_H + 0.5);
    g.lineTo(W, RULER_H + 0.5);
    g.stroke();

    bubbles = [];
    txnHit = [];
    let y = RULER_H;
    const nowC = now * CPU_HZ;
    for (const ch of chans) {
      const h = rowsOf(ch);
      const flashing = flash && flash.id === ch.id && performance.now() < flash.until;
      if (flashing) {
        g.fillStyle = C.abg;
        g.fillRect(0, y, W, h);
        dirty = true;
      }
      // 标签列
      g.fillStyle = C.fg;
      g.textAlign = 'left';
      if (ch.kind === 'i2c') {
        g.fillText(`SCL GPIO${ch.scl}`, 8, y + ROW_H.scl / 2);
        g.fillText(`SDA GPIO${ch.sda}`, 8, y + ROW_H.scl + ROW_H.sda / 2);
        g.fillStyle = C.muted;
        g.fillText(`I2C${ch.port} 解码`, 8, y + ROW_H.scl + ROW_H.sda + ROW_H.dec / 2);
        drawI2c(g, ch, y, W, c0, c1, X, pxPerCyc, nowC, C);
      } else if (ch.kind === 'pin') {
        g.fillText(ch.label, 8, y + h / 2 - 6);
        g.fillStyle = C.muted;
        g.fillText(ch.role, 8, y + h / 2 + 7);
        drawPin(g, ch, y, h, W, c0, c1, X, pxPerCyc, nowC, C);
      } else {
        g.fillText(ch.label, 8, y + h / 2 - 5);
        g.fillStyle = C.muted;
        g.fillText('板载彩灯', 8, y + h / 2 + 6);
        drawWs(g, ch, y, h, c0, c1, X, nowC, C);
      }
      g.strokeStyle = C.soft;
      g.beginPath();
      g.moveTo(0, y + h + 0.5);
      g.lineTo(W, y + h + 0.5);
      g.stroke();
      y += h;
    }
    g.strokeStyle = C.line;
    g.beginPath();
    g.moveTo(LABEL_W + 0.5, RULER_H);
    g.lineTo(LABEL_W + 0.5, H);
    g.stroke();

    // 没有数据的那段（上电前 / 被丢掉的）画浅灰
    const since = Math.max(session.io.since, 0);
    if (since > c0) {
      g.fillStyle = '#F4F4F4C0';
      g.fillRect(LABEL_W + 1, RULER_H + 1, Math.min(X(since), W) - LABEL_W - 1, H - RULER_H);
    }
    // 当前模拟时刻之后：还没发生
    if (nowC < c1) {
      const x = Math.max(LABEL_W + 1, X(nowC));
      g.fillStyle = '#FAFAFAD0';
      g.fillRect(x, RULER_H + 1, W - x, H - RULER_H);
      g.strokeStyle = C.accent;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, RULER_H);
      g.lineTo(Math.round(x) + 0.5, H);
      g.stroke();
      g.setLineDash([]);
      const s = store.get();
      const lbl = s.hist.seeked ? `回退点 ${fmtTime(now)}` : s.running ? '现在' : `暂停 ${fmtTime(now)}`;
      // 标签垫白底，免得和刻度字叠在一起
      const right = x > W - 120;
      const lw = g.measureText(lbl).width;
      const lx = right ? x - 6 - lw : x + 4;
      g.fillStyle = '#FFFFFF';
      g.fillRect(lx - 3, 2, lw + 6, RULER_H - 4);
      g.fillStyle = C.accent;
      g.fillText(lbl, lx, RULER_H / 2);
    }
    // 光标
    for (const [t, col, name] of [
      [cursA, C.accent, 'A'],
      [cursB, C.bad, 'B'],
    ] as const) {
      if (t === null) continue;
      const x = xOf(t, W);
      if (x < LABEL_W || x > W) continue;
      g.strokeStyle = col;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, RULER_H);
      g.lineTo(Math.round(x) + 0.5, H);
      g.stroke();
      g.fillStyle = col;
      g.fillRect(Math.round(x) - 7, 2, 14, RULER_H - 4);
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.fillText(name, Math.round(x), RULER_H / 2);
      g.textAlign = 'left';
    }
    // 悬停竖线
    if (hover && hover.x > LABEL_W) {
      g.strokeStyle = '#00000022';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(hover.x) + 0.5, RULER_H);
      g.lineTo(Math.round(hover.x) + 0.5, H);
      g.stroke();
    }
    readouts(W);
  }

  function readouts(W: number) {
    $('span').textContent = fmtTime(span);
    const s = store.get();
    const io = session.io;
    const drop = io.dropped + io.coreDropped;
    $('src').textContent = `运行 #${s.runNo || s.run}${s.hist.seeked ? ' · 回退' : ''} · ${io.raw.length} 个事件${drop ? ` · 丢 ${drop}` : ''}`;
    let read = '';
    if (hover) {
      const h = txnHit.find((r) => hover!.x >= r.x0 && hover!.x <= r.x1 && hover!.y >= r.y0 && hover!.y <= r.y1);
      if (h) {
        const bytes = h.x.items
          .filter((i) => i.kind === 'data')
          .map((i) => i.byte.toString(16).padStart(2, '0'))
          .join(' ');
        read = `${txnText(h.x)}${txnNote(h.x) ? ' — ' + txnNote(h.x) : ''}${bytes ? ` [${bytes.length > 60 ? bytes.slice(0, 60) + '…' : bytes}]` : ''}`;
      } else if (hover.x > LABEL_W) read = fmtTime(tOf(hover.x, W));
    }
    $('read').textContent = read;
    const cur: string[] = [];
    if (cursA !== null) cur.push(`A ${fmtTime(cursA)}`);
    if (cursB !== null) cur.push(`B ${fmtTime(cursB)}`);
    if (cursA !== null && cursB !== null) {
      const d = Math.abs(cursB - cursA);
      cur.push(`Δ ${fmtTime(d)}${d > 0 ? ` · ${fmtHz(1 / d)}` : ''}`);
    }
    $('cur').textContent = cur.join('　');
  }

  type Colors = Record<'fg' | 'muted' | 'line' | 'soft' | 'accent' | 'abg' | 'bad' | 'ok' | 'field', string>;

  function drawPin(g: CanvasRenderingContext2D, ch: Extract<Channel, { kind: 'pin' }>, y: number, h: number, W: number, c0: number, c1: number, X: (c: number) => number, ppc: number, nowC: number, C: Colors) {
    const hi = y + 7, lo = y + h - 7;
    const endC = Math.min(c1, nowC);
    if (endC <= c0) return;
    const pwm = session.io.pwm.get(ch.pin);
    const gpio = session.io.gpio.get(ch.pin);
    // 先按 PWM 分段：没有 PWM（频率 0）的段落按 GPIO 电平画
    const segs: { a: number; b: number; duty: number; freq: number; from: number }[] = [];
    if (pwm) {
      let i = Math.max(0, lastLE(pwm.t, c0));
      if (pwm.t[i] > c0 && i === 0) segs.push({ a: c0, b: Math.min(pwm.t[0], endC), duty: 0, freq: 0, from: c0 });
      for (; i < pwm.t.length && pwm.t[i] < endC; i++) {
        const a = Math.max(pwm.t[i], c0);
        const b = Math.min(i + 1 < pwm.t.length ? pwm.t[i + 1] : Infinity, endC);
        if (b > a) segs.push({ a, b, duty: pwm.duty[i], freq: pwm.freq[i], from: pwm.t[i] });
      }
    } else segs.push({ a: c0, b: endC, duty: 0, freq: 0, from: c0 });
    g.strokeStyle = C.accent;
    g.lineWidth = 1.4;
    g.textAlign = 'left';
    for (const sg of segs) {
      const xa = X(sg.a), xb = X(sg.b);
      if (sg.freq > 0 && (sg.duty < 1e-4 || sg.duty > 1 - 1e-4)) {
        // 占空比 0 / 100%：线上就是一条直线（蜂鸣器"停"的那 200 ms 就是 duty 0）
        const yv = sg.duty > 0.5 ? hi : lo;
        g.beginPath();
        g.moveTo(xa, yv);
        g.lineTo(xb, yv);
        g.stroke();
      } else if (sg.freq > 0) {
        const P = CPU_HZ / sg.freq;
        const ppx = P * ppc;
        if (ppx >= 3) {
          // 逐周期方波：从这段 PWM 生效的时刻起算相位
          g.beginPath();
          let n = Math.floor((sg.a - sg.from) / P);
          let started = false;
          for (; ; n++) {
            const rise = sg.from + n * P;
            const fall = rise + sg.duty * P;
            if (rise >= sg.b) break;
            const r = Math.max(rise, sg.a), f = Math.min(Math.max(fall, sg.a), sg.b);
            const nxt = Math.min(rise + P, sg.b);
            if (!started) {
              g.moveTo(X(r), r < fall ? hi : lo);
              started = true;
            }
            if (r < f) {
              g.lineTo(X(r), hi);
              g.lineTo(X(f), hi);
            }
            g.lineTo(X(f), lo);
            g.lineTo(X(nxt), lo);
          }
          g.stroke();
        } else {
          // 缩小：一个周期不到 3 像素，画包络（高低之间填满）和平均电平线
          g.fillStyle = '#0D99FF33';
          g.fillRect(xa, hi, xb - xa, lo - hi);
          g.beginPath();
          g.moveTo(xa, hi);
          g.lineTo(xb, hi);
          g.moveTo(xa, lo);
          g.lineTo(xb, lo);
          g.stroke();
          const ym = lo - sg.duty * (lo - hi);
          g.strokeStyle = '#0D99FF99';
          g.setLineDash([2, 2]);
          g.beginPath();
          g.moveTo(xa, ym);
          g.lineTo(xb, ym);
          g.stroke();
          g.setLineDash([]);
          g.strokeStyle = C.accent;
        }
        const lbl = pwmLabel(sg.duty, sg.freq);
        const tw = g.measureText(lbl).width + 8;
        if (xb - xa > tw + 4) {
          const lx = Math.max(xa, LABEL_W) + 4;
          g.fillStyle = '#FFFFFFE0';
          g.fillRect(lx - 2, y + h / 2 - 7, tw, 14);
          g.fillStyle = C.fg;
          g.fillText(lbl, lx + 2, y + h / 2);
        }
      } else {
        drawLevels(g, gpio, sg.a, sg.b, X, hi, lo, ch.pin, C);
      }
    }
  }

  function drawLevels(g: CanvasRenderingContext2D, s: { t: number[]; v: number[] } | undefined, a: number, b: number, X: (c: number) => number, hi: number, lo: number, pin: number, C: Colors) {
    // 窗口起点的电平：前一个事件；没有事件就用此刻的电平（还没变过）
    const f = session.frame;
    const cur = pin < 32 ? (f.gpio >>> pin) & 1 : (f.gpioHi >>> (pin - 32)) & 1;
    let i = s ? lastLE(s.t, a) : -1;
    let lv = s ? (i >= 0 ? s.v[i] : s.v.length ? 1 - s.v[0] : cur) : cur;
    g.strokeStyle = C.accent;
    g.lineWidth = 1.4;
    g.beginPath();
    let x = X(a);
    g.moveTo(x, lv ? hi : lo);
    i++;
    let lastX = -1;
    while (s && i < s.t.length && s.t[i] < b) {
      const nx = X(s.t[i]);
      if (Math.floor(nx) === lastX) {
        // 一个像素里好几次翻转：竖线占满
        g.lineTo(nx, hi);
        g.lineTo(nx, lo);
      } else {
        g.lineTo(nx, lv ? hi : lo);
        g.lineTo(nx, s.v[i] ? hi : lo);
      }
      lastX = Math.floor(nx);
      lv = s.v[i];
      x = nx;
      i++;
    }
    g.lineTo(X(b), lv ? hi : lo);
    g.stroke();
  }

  function drawWs(g: CanvasRenderingContext2D, ch: Extract<Channel, { kind: 'ws' }>, y: number, h: number, c0: number, c1: number, X: (c: number) => number, nowC: number, C: Colors) {
    const s = session.io.ws.get(ch.pin);
    if (!s) return;
    const endC = Math.min(c1, nowC);
    let i = Math.max(0, lastLE(s.t, c0));
    for (; i < s.t.length && s.t[i] < endC; i++) {
      const a = Math.max(s.t[i], c0);
      const b = Math.min(i + 1 < s.t.length ? s.t[i + 1] : endC, endC);
      if (b <= a) continue;
      // 灯珠颜色按亮度拉满再画（真机上 0x002000 这种暗绿肉眼也看得出是绿），原值写在色块里
      const rgb = s.rgb[i];
      const [r, gg, bb] = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
      const k = 255 / Math.max(1, r, gg, bb);
      g.fillStyle = rgb ? `rgb(${Math.round(r * k)},${Math.round(gg * k)},${Math.round(bb * k)})` : '#222';
      g.fillRect(X(a), y + 5, Math.max(1, X(b) - X(a)), h - 10);
      g.strokeStyle = C.line;
      g.strokeRect(X(a) + 0.5, y + 5.5, Math.max(1, X(b) - X(a)) - 1, h - 11);
      // 帧边界
      if (s.t[i] >= c0) {
        g.fillStyle = C.fg;
        g.fillRect(X(s.t[i]), y + 3, 1, h - 6);
      }
      const lbl = `#${rgb.toString(16).padStart(6, '0')}${s.n[i] > 1 ? ` ×${s.n[i]}` : ''}`;
      if (X(b) - X(a) > g.measureText(lbl).width + 12) {
        g.fillStyle = '#FFFFFFD8';
        g.fillRect(X(a) + 4, y + h / 2 - 6, g.measureText(lbl).width + 6, 12);
        g.fillStyle = C.fg;
        g.fillText(lbl, X(a) + 7, y + h / 2);
      }
    }
  }

  function drawI2c(g: CanvasRenderingContext2D, ch: Extract<Channel, { kind: 'i2c' }>, y: number, W: number, c0: number, c1: number, X: (c: number) => number, ppc: number, nowC: number, C: Colors) {
    const xs = session.io.i2c.get(ch.port) ?? [];
    const sclY = [y + 5, y + ROW_H.scl - 5];
    const sdaY = [y + ROW_H.scl + 5, y + ROW_H.scl + ROW_H.sda - 5];
    const decY = y + ROW_H.scl + ROW_H.sda;
    const endC = Math.min(c1, nowC);
    let i = firstTxnEndingAfter(xs, c0);
    const bitPx = (xs[i]?.bit ?? 400) * ppc;
    const fine = bitPx >= 1.2;
    // 空闲时两根线都是高（上拉）
    const idle = (from: number, to: number) => {
      if (to <= from) return;
      g.moveTo(X(from), sclY[0]);
      g.lineTo(X(to), sclY[0]);
      g.moveTo(X(from), sdaY[0]);
      g.lineTo(X(to), sdaY[0]);
    };
    g.strokeStyle = C.accent;
    g.lineWidth = 1.4;
    g.beginPath();
    let cur = c0;
    // 缩小时挨得近（< 24 px）的事务并成一组：一组一个事务就写整句 + 注释，多个写"n 个事务 · 0x76 ×2 · 0x3C ×3"
    const groups: { x0: number; x1: number; xs: I2cTxn[] }[] = [];
    for (; i < xs.length && xs[i].t0 < endC; i++) {
      const x = xs[i];
      idle(cur, Math.min(x.t0, endC));
      cur = Math.max(cur, x.t1);
      const xa = X(x.t0),
        xb = Math.max(X(Math.min(x.t1, endC)), xa + 1);
      const bx0 = Math.max(xa, LABEL_W + 1);
      txnHit.push({ x0: bx0 - 2, x1: Math.max(xb, bx0 + 4) + 2, y0: y, y1: decY + ROW_H.dec, x });
      if (fine) {
        drawBits(g, x, X, sclY, sdaY, c0, endC);
        // 泡泡会另起路径：先把到这里的线画掉
        g.stroke();
        drawItemBubbles(g, x, X, decY, C, x.items.some((it) => it.kind === 'addr' && it.nack));
        g.strokeStyle = C.accent;
        g.lineWidth = 1.4;
        g.beginPath();
        continue;
      }
      // 缩小：事务画成一块活动区
      g.stroke();
      g.fillStyle = '#0D99FF40';
      g.fillRect(xa, sclY[0], xb - xa, sclY[1] - sclY[0]);
      g.fillRect(xa, sdaY[0], xb - xa, sdaY[1] - sdaY[0]);
      g.beginPath();
      const last = groups[groups.length - 1];
      if (last && bx0 - last.x1 < 24) {
        last.x1 = Math.max(last.x1, xb);
        last.xs.push(x);
      } else groups.push({ x0: bx0, x1: Math.max(xb, bx0 + 2), xs: [x] });
    }
    idle(cur, endC);
    g.stroke();
    const bh = 20;
    const by = decY + (ROW_H.dec - bh) / 2;
    groups.forEach((gr, k) => {
      const bad = gr.xs.every((x) => x.items.some((it) => it.kind === 'addr' && it.nack));
      const col = bad ? C.bad : C.accent;
      const limit = (groups[k + 1]?.x0 ?? W) - 6;
      let text: string;
      let short = '';
      let tiny = '';
      if (gr.xs.length === 1) {
        const t = txnText(gr.xs[0]);
        const n = txnNote(gr.xs[0]);
        text = n ? `${t} — ${n}` : t;
        short = t;
        const a = gr.xs[0].items.find((it) => it.kind === 'addr');
        const nr = gr.xs[0].items.filter((it) => it.kind === 'data' && it.read).length;
        const nw = gr.xs[0].items.filter((it) => it.kind === 'data' && !it.read).length;
        tiny = a ? `${hex(a.byte)}${a.nack ? ' NACK' : nr ? ` 读 ${nr} B` : ` 写 ${nw} B`}` : '';
      } else {
        const tally = new Map<string, number>();
        for (const x of gr.xs) {
          const a = x.items.find((it) => it.kind === 'addr');
          const key = a ? hex(a.byte) + (a.nack ? ' NACK' : '') : '?';
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
        text = `${gr.xs.length} 个事务 · ${[...tally].map(([a, c]) => `${a} ×${c}`).join(' · ')}`;
        short = `${gr.xs.length} 个事务`;
      }
      const w = gr.x1 - gr.x0;
      const tw = g.measureText(text).width + 12;
      if (w >= tw) {
        bubble(g, gr.x0, by, w, bh, text, col, bad);
        bubbles.push(text);
        return;
      }
      g.fillStyle = col;
      g.fillRect(gr.x0, by + 3, Math.max(2, w), bh - 6);
      const lx = gr.x1 + 4;
      const room = limit - lx;
      if (room >= tw) {
        bubble(g, lx, by, tw, bh, text, col, bad);
        bubbles.push(text);
      } else if (short && room >= g.measureText(short).width + 12) {
        bubble(g, lx, by, g.measureText(short).width + 12, bh, short, col, bad);
        bubbles.push(short);
      } else if (tiny && room >= g.measureText(tiny).width + 12) {
        bubble(g, lx, by, g.measureText(tiny).width + 12, bh, tiny, col, bad);
        bubbles.push(tiny);
      } else if (room >= 36) bubble(g, lx, by, room, bh, tiny || text, col, bad);
    });
  }

  /** 一个事务的 SCL / SDA（按事务和位时序重建：起始 1 位、每字节 8 位 + 应答位、停止 1 位） */
  function drawBits(g: CanvasRenderingContext2D, x: I2cTxn, X: (c: number) => number, sclY: number[], sdaY: number[], c0: number, c1: number) {
    const bit = x.bit;
    let scl: [number, number][] = [];
    let sda: [number, number][] = [];
    const H = 1, L = 0;
    const put = (arr: [number, number][], t: number, v: number) => arr.push([t, v]);
    for (const it of x.items) {
      const t = it.t;
      if (t > c1 + 20 * bit) break;
      if (it.kind === 'start' || it.kind === 'restart') {
        if (it.kind === 'restart') {
          put(scl, t, L);
          put(sda, t, H);
          put(scl, t + bit * 0.25, H);
        } else {
          put(scl, t, H);
          put(sda, t, H);
        }
        put(sda, t + bit * 0.5, L);
        put(scl, t + bit * 0.9, L);
      } else if (it.kind === 'stop') {
        put(scl, t, L);
        put(sda, t, L);
        put(scl, t + bit * 0.4, H);
        put(sda, t + bit * 0.75, H);
      } else {
        const byte = it.kind === 'addr' ? (it.byte << 1) | (it.read ? 1 : 0) : it.byte;
        for (let k = 0; k < 9; k++) {
          const v = k < 8 ? (byte >> (7 - k)) & 1 : it.nack ? 1 : 0;
          const tb = t + k * bit;
          put(scl, tb, L);
          put(sda, tb + bit * 0.15, v);
          put(scl, tb + bit * 0.5, H);
        }
        put(scl, t + 9 * bit - bit * 0.02, L);
      }
    }
    const trace = (pts: [number, number][], ys: number[]) => {
      if (!pts.length) return;
      let v = 1;
      g.moveTo(X(Math.max(pts[0][0], c0)), ys[0]);
      for (const [t, nv] of pts) {
        if (t < c0) {
          v = nv;
          g.moveTo(X(c0), v ? ys[0] : ys[1]);
          continue;
        }
        if (t > c1) break;
        g.lineTo(X(t), v ? ys[0] : ys[1]);
        g.lineTo(X(t), nv ? ys[0] : ys[1]);
        v = nv;
      }
      g.lineTo(X(Math.min(x.t1, c1)), v ? ys[0] : ys[1]);
    };
    trace(scl, sclY);
    trace(sda, sdaY);
    scl = [];
    sda = [];
  }

  /** 放大到位级：每个起始 / 字节 / 停止一个小泡泡 */
  function drawItemBubbles(g: CanvasRenderingContext2D, x: I2cTxn, X: (c: number) => number, decY: number, C: Colors, bad: boolean) {
    for (const it of x.items) {
      const len = it.kind === 'addr' || it.kind === 'data' ? 9 : 1;
      const xa = X(it.t),
        xb = X(it.t + len * x.bit);
      const txt = it.kind === 'start' ? 'S' : it.kind === 'restart' ? 'Sr' : it.kind === 'stop' ? 'P' : it.kind === 'addr' ? `${hex(it.byte)} ${it.read ? 'R' : 'W'}${it.nack ? ' NACK' : ''}` : `${hex(it.byte)}${it.nack ? ' NACK' : ''}`;
      const w = xb - xa;
      if (w < 6) continue;
      const col = it.nack && it.kind !== 'data' ? C.bad : it.kind === 'data' && it.read ? C.ok : C.accent;
      bubble(g, xa + 1, decY + 3, w - 2, 20, g.measureText(txt).width + 6 <= w - 2 ? txt : '', col, bad && it.kind === 'addr');
    }
    // 第二行：整个事务的一句话 + 寄存器注释，从事务起点写起（被左边裁掉时贴着标签列）
    const note = txnNote(x);
    const full = `${txnText(x)}${note ? ' — ' + note : ''}`;
    const x0 = Math.max(X(x.t0), LABEL_W + 4);
    g.fillStyle = bad ? C.bad : C.fg;
    g.fillText(full, x0, decY + 34);
    bubbles.push(full);
  }


  function bubble(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, col: string, bad: boolean) {
    g.fillStyle = bad ? '#FEF2F2' : col === '#14ae5c' || col === '#14AE5C' ? '#E8F7EE' : '#E5F4FF';
    g.strokeStyle = col;
    g.lineWidth = 1;
    roundRect(g, x, y, w, h, Math.min(6, h / 2));
    g.fill();
    g.stroke();
    if (text) {
      g.fillStyle = bad ? col : '#1E1E1E';
      g.save();
      g.beginPath();
      g.rect(x + 2, y, w - 4, h);
      g.clip();
      g.fillText(text, x + 6, y + h / 2 + 0.5);
      g.restore();
    }
  }

  const api: Analyzer = {
    get isOpen() {
      return open;
    },
    open(focus) {
      if (focus) {
        let id = focus;
        const i2c = chans.find((c) => c.kind === 'i2c' && (`GPIO${c.sda}` === focus || `GPIO${c.scl}` === focus));
        if (i2c) id = i2c.id;
        const m = /^GPIO(\d+)$/.exec(id);
        if (!chans.some((c) => c.id === id) && m) chans.push({ id, kind: 'pin', pin: Number(m[1]), label: id, role: '手动加的' });
        flash = { id, until: performance.now() + 1200 };
      }
      setOpen(true);
    },
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    view: () => ({ end, span, follow }),
    setView(v) {
      if (v.follow !== undefined) setFollow(v.follow);
      if (v.span !== undefined) span = clampSpan(v.span);
      if (v.end !== undefined) end = v.end;
      dirty = true;
    },
    zoomToTxn(i, pad = 1.6, filter) {
      const xs = filter ? allTxns().filter(filter) : allTxns();
      const x = xs[i < 0 ? xs.length + i : i];
      if (x) centerTxn(x, pad);
      return x ?? null;
    },
    channels: () => chans.slice(),
    visibleBubbles() {
      draw();
      return bubbles.slice();
    },
    setCursor(which, t) {
      if (which === 'a') cursA = t;
      else cursB = t;
      dirty = true;
    },
  };
  return api;
}

function findLastIndex<T>(a: T[], f: (x: T) => boolean) {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i;
  return -1;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function fmtTick(t: number, step: number) {
  if (step >= 1) return `${t.toFixed(0)} s`;
  if (step >= 1e-3) return `${t.toFixed(Math.max(0, Math.ceil(-Math.log10(step))))} s`;
  // 步长很小时绝对时刻太长：写成 毫秒
  const ms = t * 1e3;
  return `${ms.toFixed(Math.max(0, Math.ceil(-Math.log10(step * 1e3))))} ms`;
}

function fmtHz(f: number) {
  if (f >= 1e6) return `${(f / 1e6).toFixed(3)} MHz`;
  if (f >= 1e3) return `${(f / 1e3).toFixed(3)} kHz`;
  return `${f.toFixed(2)} Hz`;
}
