// Bench logic analyzer (P1-05). Data are cycle-stamped core events (session.io), not samples: SCL / SDA are rebuilt from
// I2C transactions and bit timing, PWM from duty / frequency (envelope below 3 px per period). Follow pins the right edge to sim time.
import type { PartSpec } from '../board3d';
import { t } from '../i18n/index.ts';
import type { StepCtx } from './types';
import { BOOT_GPIO, RGB_GPIO, type SimChip } from '../chips';
import { currentTheme, onTheme } from '../theme';
import { CPU_HZ, firstTxnEndingAfter, fmtTime, hex, lastLE, pwmLabel, txnNote, txnText, type I2cTxn } from './iotrace';
import { dhtBitAt, dhtBits, dhtFrame, parseVcd, pulseAt, type DhtBit, type FineWave } from './vcdview';
import type { TimingReport, VcdState } from '../worker';
import { bc, setDock } from './chrome';

export type Channel =
  | { id: string; kind: 'i2c'; port: number; sda: number; scl: number; label: string }
  | { id: string; kind: 'pin'; pin: number; label: string; role: string }
  | { id: string; kind: 'ws'; pin: number; label: string }
  /** Fine capture row (D-04): every edge of one pin from the core's VCD capture */
  | { id: 'FINE'; kind: 'fine'; pin: number; label: string; role: string };

/** Fine capture settings: pin, window length (s), start = next edge from now (trigger) or an absolute time (s) */
export interface FineOpts {
  pin: number;
  len: number;
  at?: number;
}

export interface Analyzer {
  readonly isOpen: boolean;
  /** Open; with a pin ('GPIO4' / 'I2C0') ensure that channel exists, scroll to it and flash it */
  open(focus?: string): void;
  close(): void;
  toggle(): void;
  /** View (for tests / ⌘K): window [end - span, end] in seconds */
  view(): { end: number; span: number; follow: boolean };
  setView(v: { end?: number; span?: number; follow?: boolean }): void;
  /** Fit the window to the i-th I2C transaction (negative counts from the end), padded by pad × width */
  zoomToTxn(i: number, pad?: number, filter?: (x: I2cTxn) => boolean): I2cTxn | null;
  channels(): Channel[];
  /** Visible I2C bubble texts (read by tests) */
  visibleBubbles(): string[];
  /** Cursor A / B (seconds); null clears */
  setCursor(which: 'a' | 'b', t: number | null): void;
  /** Fine capture (D-04): start one, read its state / decoded wave, the cursor-A pulse readout, export the VCD */
  fineStart(o: FineOpts): boolean;
  fine(): { opts: FineOpts | null; state: VcdState | null; wave: FineWave | null; bits: number[]; frame: ReturnType<typeof dhtFrame> };
  pulseText(): string;
  exportVcd(download?: boolean): Promise<string>;
}

const LABEL_W = 96;
const RULER_H = 20;
const ROW_H = { scl: 22, sda: 22, dec: 46, pin: 34, ws: 22, fine: 56 } as const;
/** Default fine window: a DHT11 read is a 20 ms start pulse plus about 5 ms of answer */
const FINE_LEN = 0.03;
const css = (n: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
// canvas can't use color-mix, so translucent overlays get a per-theme palette; values come from lab.css
const PAL = {
  light: { bg: '#FFFFFF', nodata: '#F4F4F4C0', future: '#FAFAFAD0', tag: '#FFFFFFE0', wsTag: '#FFFFFFD8', onAccent: '#FFFFFF', hover: '#00000022', env: '#0D99FF33', envMid: '#0D99FF99', txn: '#0D99FF40', abg: '#E5F4FF', okBg: '#E8F7EE', badBg: '#FEF2F2', bubbleFg: '#1E1E1E', wsOff: '#222222' },
  dark: { bg: '#1E2024', nodata: '#2A2C31C0', future: '#17181BD0', tag: '#1E2024E0', wsTag: '#1E2024D8', onAccent: '#08141F', hover: '#FFFFFF33', env: '#3AA8FF33', envMid: '#3AA8FF99', txn: '#3AA8FF40', abg: '#10304A', okBg: '#163826', badBg: '#3B1E19', bubbleFg: '#E8EAED', wsOff: '#0E0F11' },
};

let single: Analyzer | null = null;
/** One analyzer per page (created on bench mount, also used by ⌘K) */
export function getAnalyzer(ctx: StepCtx): Analyzer {
  single ??= createAnalyzer(ctx);
  return single;
}

function defaultChannels(parts: PartSpec[], chip: string): Channel[] {
  const ch: Channel[] = [];
  const bus = parts.find((p): p is Extract<PartSpec, { sda: number }> => 'sda' in p);
  if (bus) {
    const NAME: Record<string, string> = { bme280: 'BME280', oled: 'OLED', mpu6050: 'MPU6050', qmi8658: 'QMI8658', cst816s: 'CST816S' };
    const devs = parts.filter((p) => 'sda' in p).map((p) => `${NAME[p.type] ?? p.type} ${hex((p as { addr: number }).addr)}`);
    ch.push({ id: 'I2C0', kind: 'i2c', port: 0, sda: bus.sda, scl: bus.scl, label: devs.join(' · ') });
  }
  for (const p of parts) {
    if (p.type === 'servo') ch.push({ id: `GPIO${p.pin}`, kind: 'pin', pin: p.pin, label: `GPIO${p.pin}`, role: t('Servo') });
    if (p.type === 'buzzer') ch.push({ id: `GPIO${p.pin}`, kind: 'pin', pin: p.pin, label: `GPIO${p.pin}`, role: t('Buzzer') });
    if (p.type === 'led') ch.push({ id: `GPIO${p.pin}`, kind: 'pin', pin: p.pin, label: `GPIO${p.pin}`, role: 'LED' });
    // Encoder A / B phases and button (P2-01), ultrasonic Trig / Echo (P2-04)
    if (p.type === 'encoder') {
      ch.push({ id: `GPIO${p.a}`, kind: 'pin', pin: p.a, label: `GPIO${p.a}`, role: t('Encoder A') });
      ch.push({ id: `GPIO${p.b}`, kind: 'pin', pin: p.b, label: `GPIO${p.b}`, role: t('Encoder B') });
      if (p.sw !== undefined) ch.push({ id: `GPIO${p.sw}`, kind: 'pin', pin: p.sw, label: `GPIO${p.sw}`, role: t('Encoder button') });
    }
    if (p.type === 'ws2812') ch.push({ id: `RGB${p.pin}`, kind: 'ws', pin: p.pin, label: `GPIO${p.pin}` });
    if (p.type === 'dht11') ch.push({ id: `GPIO${p.pin}`, kind: 'pin', pin: p.pin, label: `GPIO${p.pin}`, role: t('DHT11 data') });
    if (p.type === 'hcsr04') {
      ch.push({ id: `GPIO${p.trig}`, kind: 'pin', pin: p.trig, label: `GPIO${p.trig}`, role: 'Trig' });
      ch.push({ id: `GPIO${p.echo}`, kind: 'pin', pin: p.echo, label: `GPIO${p.echo}`, role: 'Echo' });
    }
  }
  const boot = BOOT_GPIO[chip as SimChip] ?? 9;
  ch.push({ id: `GPIO${boot}`, kind: 'pin', pin: boot, label: `GPIO${boot}`, role: t('BOOT button') });
  const rgb = RGB_GPIO[chip as SimChip] === undefined ? 8 : RGB_GPIO[chip as SimChip];
  if (rgb !== null) ch.push({ id: `RGB${rgb}`, kind: 'ws', pin: rgb, label: `GPIO${rgb}` });
  return ch;
}

/** Build an element from attributes and children (text or nodes) */
function h(tag: string, attrs: Record<string, string>, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

const rowsOf = (c: Channel) => (c.kind === 'i2c' ? ROW_H.scl + ROW_H.sda + ROW_H.dec : c.kind === 'pin' ? ROW_H.pin : c.kind === 'fine' ? ROW_H.fine : ROW_H.ws);

export function createAnalyzer(ctx: StepCtx): Analyzer {
  const { session, store, shell } = ctx;
  const el = document.createElement('section');
  el.className = 'pnl analyzer';
  el.id = 'analyzer';
  el.hidden = true;
  el.setAttribute('aria-label', t('Logic analyzer'));
  // Imperative component (canvas redrawn per frame): build the skeleton via DOM APIs, not HTML strings
  const btn = (act: string, title: string, text: string, extra: Record<string, string> = {}) => h('button', { type: 'button', class: 'ana-b', 'data-act': act, title, ...extra }, text);
  el.append(
    h(
      'header',
      { class: 'ana-h' },
      h('span', { class: 'ana-t' }, t('Logic analyzer')),
      h('span', { class: 'ana-src mono muted', 'data-a': 'src' }),
      h('span', { class: 'ana-read mono', 'data-a': 'read' }),
      h('span', { class: 'ana-sp' }),
      btn('prev', t('Previous I2C transaction'), '◂ I2C'),
      btn('next', t('Next I2C transaction'), 'I2C ▸'),
      h('span', { class: 'ana-sep' }),
      btn('fine', t('Fine sampling: every edge of one pin, stamped by CPU cycle'), t('Fine sampling'), { 'aria-pressed': 'false' }),
      h('span', { class: 'ana-sep' }),
      btn('out', t('Zoom out (wheel)'), '−'),
      h('span', { class: 'ana-span mono', 'data-a': 'span' }),
      btn('in', t('Zoom in (wheel)'), '+'),
      btn('follow', t('Follow the latest time'), t('Follow'), { 'aria-pressed': 'true' }),
      btn('close', t('Close'), '×', { 'aria-label': t('Close logic analyzer') }),
    ),
    h(
      'div',
      { class: 'ana-fine', 'data-a': 'fine', hidden: '' },
      h('span', { class: 'ana-chip mono', 'data-a': 'fchip' }),
      h('span', { class: 'ana-fstat mono muted', 'data-a': 'fstat' }),
      h('span', { class: 'ana-sp' }),
      btn('fwin', t('Change the pin or the window'), t('Change window'), { 'aria-expanded': 'false' }),
      btn('fagain', t('Capture the next window'), t('Capture again')),
      btn('fvcd', t('Download the capture as a VCD file (same bytes as tryboard run --vcd)'), t('Export VCD')),
      btn('foff', t('Close fine sampling'), '×', { 'aria-label': t('Close fine sampling') }),
    ),
    h(
      'form',
      { class: 'ana-fform', 'data-a': 'fform', hidden: '' },
      h('label', {}, t('Pin'), ' ', h('select', { name: 'pin' })),
      h('label', {}, t('Window (ms)'), ' ', h('input', { name: 'ms', type: 'number', min: '0.1', max: '2000', step: 'any', inputmode: 'decimal' })),
      h('label', {}, t('Start'), ' ', h('select', { name: 'mode' }, h('option', { value: 'edge' }, t('Next edge from now')), h('option', { value: 'at' }, t('At sim time (s)')))),
      h('input', { name: 'at', type: 'number', min: '0', step: 'any', inputmode: 'decimal', 'aria-label': t('Start time (s)') }),
      h('button', { type: 'submit', class: 'ana-b ana-go' }, t('Start capture')),
    ),
    h('div', { class: 'ana-body' }, h('canvas', { class: 'ana-cv', 'aria-label': t('Logic analyzer waveforms') })),
    h(
      'div',
      { class: 'ana-note', 'data-a': 'note', hidden: '' },
      h('div', { class: 'ana-note-t' }, h('b', { 'data-a': 'ntitle' }), h('span', { class: 'ana-badge' }, t('Confirm on real hardware'))),
      h('div', { class: 'muted', 'data-a': 'nbody' }),
    ),
    h('footer', { class: 'ana-f' }, h('span', { class: 'mono', 'data-a': 'cur' }), h('span', { class: 'muted', 'data-a': 'hint' }, matchMedia('(pointer: coarse)').matches ? t('Tap to place cursors A and B in turn; drag to pan, − / + to zoom') : t('Click to place cursor A, Shift+click for B; wheel to zoom, drag to pan'))),
  );
  document.body.appendChild(el);
  const cv = el.querySelector<HTMLCanvasElement>('canvas')!;
  const $ = (k: string) => el.querySelector<HTMLElement>(`[data-a="${k}"]`)!;

  let open = false;
  let chans: Channel[] = defaultChannels(session.scene.parts, session.chip);
  let follow = true;
  let span = 1; // seconds
  let end = 0;
  let now = 0;
  let cursA: number | null = null;
  let cursB: number | null = null;
  let hover: { x: number; y: number } | null = null;
  let flash: { id: string; until: number } | null = null;
  let dirty = true;
  let raf = 0;
  let K = PAL[currentTheme()];
  let okCol = '#14AE5C';
  onTheme(() => {
    dirty = true;
  });
  let bubbles: string[] = [];
  let txnHit: { x0: number; x1: number; y0: number; y1: number; x: I2cTxn }[] = [];
  let lastScene = session.scene;
  // Fine capture: settings, core state, parsed wave (fetched as VCD text while the window fills)
  let fineOpts: FineOpts | null = null;
  let fineState: VcdState | null = null;
  let fineWave: FineWave | null = null;
  let fineBits: DhtBit[] = [];
  let fineFetched = '';
  let fineBusy = false;
  let fineLast = 0;
  let fineFitted = false;

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
    const extra = (['fine', 'fform', 'note'] as const).reduce((a, k) => a + (el.querySelector<HTMLElement>(`[data-a="${k}"]`)!.hidden ? 0 : el.querySelector<HTMLElement>(`[data-a="${k}"]`)!.offsetHeight || 36), 0);
    document.body.style.setProperty('--ana-h', `${h + 66 + extra}px`);
  }

  function setOpen(v: boolean) {
    open = v;
    el.hidden = !v;
    document.body.classList.toggle('ana-open', v);
    if (v) {
      if (session.scene !== lastScene) {
        // Bench changed (applied from list / rewound): replace default channels, keep manually added ones
        const keep = chans.filter((c) => (c.kind === 'pin' && !defaultChannels(lastScene.parts, session.chip).some((d) => d.id === c.id)) || c.kind === 'fine');
        chans = defaultChannels(session.scene.parts, session.chip);
        for (const k of keep) if (!chans.some((c) => c.id === k.id)) (k.kind === 'fine' ? chans.unshift(k) : chans.push(k));
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
      // When stopped (paused / rewind point) leave a margin on the right so the marker line is visible
      const st = store.get();
      const e = Math.max(now, span) + (st.running && !st.hist.seeked ? 0 : span * 0.06);
      if (e !== end) {
        end = e;
        dirty = true;
      }
    }
    // Skip drawing when off the bench step (hidden by CSS); redraw on return
    if (dirty && document.body.dataset.step === 'bench') {
      dirty = false;
      draw();
    }
    raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- Input
  session.onTick((m) => {
    now = m.simSeconds;
    if (open && follow) dirty = true;
  });
  session.onIo(() => {
    if (open) dirty = true;
  });
  session.onVcd((st) => {
    fineState = st;
    if (!st) {
      // New power-up / rewind: the core capture is gone, keep the last wave on screen until the next capture
      fineFetched = '';
    }
    fineUi();
    fineFetch();
  });
  session.onTiming(() => noteUi());
  session.onTick(() => fineFetch());
  store.subscribe((s) => {
    // A seek parks the sim at that moment; simSeconds comes from the snapshot
    if (s.hist.seeked || !s.running) now = s.simSeconds;
    dirty = true;
  }, ['simSeconds', 'hist', 'running']);

  const xOf = (t: number, W: number) => LABEL_W + ((t - (end - span)) / span) * (W - LABEL_W);
  const tOf = (x: number, W: number) => end - span + ((x - LABEL_W) / (W - LABEL_W)) * span;
  const clampSpan = (s: number) => Math.min(120, Math.max(2e-6, s));

  function zoomAt(f: number, x?: number) {
    const W = cv.clientWidth;
    if (x === undefined || follow) {
      // While following, anchor on the right edge
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
  let tapB = false;
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
    // Touch has no Shift: taps alternate between A and B
    if (e.shiftKey || (e.pointerType === 'touch' && tapB)) cursB = t;
    else cursA = t;
    if (e.pointerType === 'touch') tapB = !tapB;
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
    else if (act === 'fine') {
      if (fineOpts) fineOff();
      else formOpen(true);
    }
  });
  el.querySelector('[data-a="fine"]')!.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]')?.dataset.act;
    if (act === 'fwin') formOpen(form.hidden);
    else if (act === 'fagain' && fineOpts) fineStart({ pin: fineOpts.pin, len: fineOpts.len });
    else if (act === 'fvcd') void exportVcd(true);
    else if (act === 'foff') fineOff();
  });
  const form = el.querySelector<HTMLFormElement>('[data-a="fform"]')!;
  const fld = <T extends HTMLElement>(n: string) => form.querySelector<T>(`[name="${n}"]`)!;
  fld<HTMLSelectElement>('mode').addEventListener('change', () => {
    fld<HTMLInputElement>('at').hidden = fld<HTMLSelectElement>('mode').value !== 'at';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = Number(fld<HTMLSelectElement>('pin').value);
    const ms = Number(fld<HTMLInputElement>('ms').value);
    const at = fld<HTMLSelectElement>('mode').value === 'at' ? Number(fld<HTMLInputElement>('at').value) : undefined;
    if (!(ms > 0)) return shell.toast(t('Enter a window length in milliseconds'));
    if (fineStart({ pin, len: Math.min(ms, 2000) / 1e3, at })) formOpen(false);
  });

  /** Pins offered for fine capture: the bench's pin channels, the DHT11 first */
  function finePins(): number[] {
    const out: number[] = [];
    const dht = session.scene.parts.find((p) => p.type === 'dht11');
    if (dht && dht.type === 'dht11') out.push(dht.pin);
    for (const c of chans) if (c.kind === 'pin' && !out.includes(c.pin)) out.push(c.pin);
    return out;
  }
  function formOpen(v: boolean) {
    form.hidden = !v;
    el.querySelector('[data-act="fwin"]')!.setAttribute('aria-expanded', String(v));
    if (v) {
      const pins = finePins();
      const cur = fineOpts?.pin ?? pins[0];
      fld<HTMLSelectElement>('pin').replaceChildren(...pins.map((p) => h('option', p === cur ? { value: String(p), selected: '' } : { value: String(p) }, `GPIO${p}`)));
      fld<HTMLInputElement>('ms').value = String(+((fineOpts?.len ?? FINE_LEN) * 1e3).toFixed(3));
      fld<HTMLSelectElement>('mode').value = fineOpts?.at !== undefined ? 'at' : 'edge';
      fld<HTMLInputElement>('at').value = (fineOpts?.at ?? Math.ceil(now + 1)).toString();
      fld<HTMLInputElement>('at').hidden = fineOpts?.at === undefined;
      el.querySelector('[data-a="fine"]')!.removeAttribute('hidden');
    }
    layout();
    fineUi();
  }
  function fineStart(o: FineOpts): boolean {
    if (o.at !== undefined && o.at < now) {
      shell.toast(t('That time has already passed: pick a start later than {time}', { time: fmtTime(now) }));
      return false;
    }
    fineOpts = o;
    fineWave = null;
    fineBits = [];
    fineFetched = '';
    fineFitted = false;
    fineState = null;
    session.vcdStart([o.pin], o.at ?? now, o.len, o.at === undefined);
    chans = chans.filter((c) => c.kind !== 'fine');
    const role = session.scene.parts.some((p) => p.type === 'dht11' && p.pin === o.pin) ? t('DHT11 data') : (chans.find((c) => c.kind === 'pin' && c.pin === o.pin) as { role?: string } | undefined)?.role ?? '';
    chans.unshift({ id: 'FINE', kind: 'fine', pin: o.pin, label: `GPIO${o.pin}`, role });
    // The fine bar and the busy-wait note leave no room for rows in a short dock: grow it (never shrink)
    const want = Math.round(Math.min(window.innerHeight * 0.6, 400));
    if (bc.get().dock.h < want) setDock({ h: want, collapsed: false });
    el.querySelector('[data-a="fine"]')!.removeAttribute('hidden');
    el.querySelector('[data-act="fine"]')!.setAttribute('aria-pressed', 'true');
    layout();
    fineUi();
    dirty = true;
    return true;
  }
  function fineOff() {
    fineOpts = null;
    fineWave = null;
    fineBits = [];
    chans = chans.filter((c) => c.kind !== 'fine');
    el.querySelector('[data-a="fine"]')!.setAttribute('hidden', '');
    form.hidden = true;
    el.querySelector('[data-act="fine"]')!.setAttribute('aria-pressed', 'false');
    layout();
    dirty = true;
  }
  /** Pull the VCD text while the window fills (at most 4 times a second) and once when it closes */
  function fineFetch() {
    const st = fineState;
    if (!fineOpts || !st || fineBusy || st.t0 === null || st.t1 === null) return;
    const closed = now * CPU_HZ >= st.t1;
    const key = `${st.edges}/${st.t0}/${closed}`;
    if (key === fineFetched) return;
    if (!closed && performance.now() - fineLast < 250) return;
    fineBusy = true;
    fineLast = performance.now();
    void session.vcdText().then((r) => {
      fineBusy = false;
      fineFetched = key;
      if (!fineOpts) return;
      fineWave = parseVcd(r.text, fineOpts.pin);
      fineBits = fineWave ? dhtBits(fineWave) : [];
      if (closed && fineWave && !fineFitted) {
        // Show the whole window once it is complete
        fineFitted = true;
        setFollow(false);
        const w = (fineWave.t1 - fineWave.t0) / CPU_HZ;
        span = clampSpan(w * 1.04);
        end = fineWave.t1 / CPU_HZ + w * 0.02;
      }
      fineUi();
      dirty = true;
    });
  }
  async function exportVcd(download: boolean): Promise<string> {
    const r = await session.vcdText();
    if (!r.text) {
      shell.toast(t('No fine capture yet'));
      return '';
    }
    if (download) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.text], { type: 'text/plain' }));
      a.download = `tryboard-GPIO${fineOpts?.pin ?? ''}-${r.state?.t0 ?? 0}.vcd`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    return r.text;
  }
  function fineUi() {
    if (!fineOpts) return;
    const ms = +(fineOpts.len * 1e3).toFixed(3);
    $('fchip').textContent = t('Fine sampling: GPIO{pin} · {ms} ms window · per cycle', { pin: fineOpts.pin, ms });
    const st = fineState;
    const parts: string[] = [];
    if (!st || st.t0 === null || st.t1 === null) parts.push(fineOpts.at !== undefined ? t('Waiting for {time}', { time: fmtTime(fineOpts.at) }) : t('Waiting for the next edge on GPIO{pin}', { pin: fineOpts.pin }));
    else {
      const a = st.t0 / CPU_HZ, b = st.t1 / CPU_HZ;
      parts.push(`${a.toFixed(6)} – ${b.toFixed(6)} s`);
      if (now * CPU_HZ < st.t1) parts.push(t('Capturing'));
      parts.push(t('{n} edges', { n: st.edges }));
      if (st.dropped) parts.push(t('Dropped {n} (capture buffer full)', { n: st.dropped }));
    }
    const fr = dhtFrame(fineBits);
    if (fr) parts.push(t('DHT11: {h} %RH {t} °C, checksum {ok}', { h: fr.humidity, t: fr.temp.toFixed(1), ok: fr.ok ? t('OK') : t('wrong') }));
    $('fstat').textContent = parts.join(' · ');
    $('fstat').classList.toggle('bad', !!st?.dropped);
    (el.querySelector('[data-act="fvcd"]') as HTMLButtonElement).disabled = !st;
  }
  function noteUi() {
    const r: TimingReport | null = session.timing;
    const box = $('note');
    box.hidden = !r;
    if (!r) return layout();
    const reads = r.items.some((i) => i.kind === 'poll');
    $('ntitle').textContent = reads ? t('The sensor sends these pulses and their widths are exact, but the firmware measures them with busy-wait loops') : t('The firmware makes these pulses itself with busy-wait loops');
    const KIND: Record<string, string> = { delay: t('busy-wait delays'), spin: t('cycle-counter spins'), toggle: t('fast pin toggles'), poll: t('fast pin reads') };
    const items = r.items.map((i) => `GPIO${i.pin} ${KIND[i.kind]} ×${i.n}`).join(' · ');
    $('nbody').textContent = `${t('In the simulator every instruction takes 1 cycle; on a real chip caches, flash wait states and interrupts can shift the count by a few microseconds. The logic works here; check the margin on real hardware.')} (${items})`;
    layout();
  }

  function allTxns(): I2cTxn[] {
    return session.io.i2c.get(0) ?? [];
  }
  /** Find the previous / next transaction from the window centre */
  function stepTxn(dir: number) {
    const xs = allTxns();
    if (!xs.length) return shell.toast(t('No I2C transactions yet'));
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

  // ---------------------------------------------------------------- Drawing
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
    K = PAL[currentTheme()];
    okCol = C.ok;
    g.fillStyle = K.bg;
    g.fillRect(0, 0, W, H);
    const t0 = end - span;
    const c0 = t0 * CPU_HZ;
    const c1 = end * CPU_HZ;
    const pxPerCyc = (W - LABEL_W) / (span * CPU_HZ);
    const X = (c: number) => LABEL_W + (c - c0) * pxPerCyc;
    g.font = '10px "JetBrains Mono", ui-monospace, monospace';
    g.textBaseline = 'middle';

    // Time ruler
    // 8 ticks on the desktop dock; a phone (≈ 300px plot) gets one per 80px so labels don't collide
    const step = niceStep(span / Math.max(2, Math.min(8, Math.floor((W - LABEL_W) / 80))));
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
      // Label column
      g.fillStyle = C.fg;
      g.textAlign = 'left';
      if (ch.kind === 'i2c') {
        g.fillText(`SCL GPIO${ch.scl}`, 8, y + ROW_H.scl / 2);
        g.fillText(`SDA GPIO${ch.sda}`, 8, y + ROW_H.scl + ROW_H.sda / 2);
        g.fillStyle = C.muted;
        g.fillText(t('I2C{port} decode', { port: ch.port }), 8, y + ROW_H.scl + ROW_H.sda + ROW_H.dec / 2);
        drawI2c(g, ch, y, W, c0, c1, X, pxPerCyc, nowC, C);
      } else if (ch.kind === 'fine') {
        g.fillText(ch.label, 8, y + 12);
        g.fillStyle = C.muted;
        g.fillText(ch.role, 8, y + 26);
        g.fillStyle = C.accent;
        g.fillText(t('Every edge'), 8, y + 40);
        drawFine(g, y, h, c0, c1, X, pxPerCyc, C);
      } else if (ch.kind === 'pin') {
        g.fillText(ch.label, 8, y + h / 2 - 6);
        g.fillStyle = C.muted;
        g.fillText(ch.role, 8, y + h / 2 + 7);
        drawPin(g, ch, y, h, W, c0, c1, X, pxPerCyc, nowC, C);
      } else {
        g.fillText(ch.label, 8, y + h / 2 - 5);
        g.fillStyle = C.muted;
        g.fillText(t('Onboard RGB LED'), 8, y + h / 2 + 6);
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

    // Grey out spans with no data (before power-on / dropped)
    const since = Math.max(session.io.since, 0);
    if (since > c0) {
      g.fillStyle = K.nodata;
      g.fillRect(LABEL_W + 1, RULER_H + 1, Math.min(X(since), W) - LABEL_W - 1, H - RULER_H);
    }
    // After the current sim time: hasn't happened yet
    if (nowC < c1) {
      const x = Math.max(LABEL_W + 1, X(nowC));
      g.fillStyle = K.future;
      g.fillRect(x, RULER_H + 1, W - x, H - RULER_H);
      g.strokeStyle = C.accent;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, RULER_H);
      g.lineTo(Math.round(x) + 0.5, H);
      g.stroke();
      g.setLineDash([]);
      const s = store.get();
      const lbl = s.hist.seeked ? t('Rewind point {time}', { time: fmtTime(now) }) : s.running ? t('Now') : t('Paused {time}', { time: fmtTime(now) });
      // Background behind the label so it doesn't overlap ruler text
      const right = x > W - 120;
      const lw = g.measureText(lbl).width;
      const lx = right ? x - 6 - lw : x + 4;
      g.fillStyle = K.bg;
      g.fillRect(lx - 3, 2, lw + 6, RULER_H - 4);
      g.fillStyle = C.accent;
      g.fillText(lbl, lx, RULER_H / 2);
    }
    // Cursors
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
      g.fillStyle = K.onAccent;
      g.textAlign = 'center';
      g.fillText(name, Math.round(x), RULER_H / 2);
      g.textAlign = 'left';
    }
    // Hover line
    if (hover && hover.x > LABEL_W) {
      g.strokeStyle = K.hover;
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
    const src = [t('Run #{n}', { n: s.runNo || s.run })];
    if (s.hist.seeked) src.push(t('rewound'));
    src.push(t('Events: {n}', { n: io.raw.length }));
    if (drop) src.push(t('Dropped: {n}', { n: drop }));
    $('src').textContent = src.join(' · ');
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
    const pt = pulseText();
    if (pt) cur.push(pt);
    $('cur').textContent = cur.join('  ');
  }

  /** Cursor A on the fine wave: level and width of the pulse under it, plus the DHT11 bit when it is one */
  function pulseText(): string {
    if (!fineWave || cursA === null) return '';
    const c = cursA * CPU_HZ;
    const p = pulseAt(fineWave, c);
    if (!p) return '';
    const w = fmtTime((p.b - p.a) / CPU_HZ);
    const bit = p.level ? dhtBitAt(fineBits, c) : null;
    const s = p.level ? t('High {w}', { w }) : t('Low {w}', { w });
    return bit === null ? s : `${s} → ${bit}`;
  }

  function drawFine(g: CanvasRenderingContext2D, y: number, h: number, c0: number, c1: number, X: (c: number) => number, ppc: number, C: Colors) {
    const w = fineWave;
    const hi = y + 16, lo = y + h - 8;
    if (!w) {
      g.fillStyle = C.muted;
      g.fillText(fineState && fineState.t0 !== null ? t('Capturing…') : t('Waiting for the trigger…'), LABEL_W + 10, y + h / 2);
      return;
    }
    // Shade outside the capture window: no data there
    g.fillStyle = K.nodata;
    if (w.t0 > c0) g.fillRect(LABEL_W + 1, y + 1, Math.min(X(w.t0), X(c1)) - LABEL_W - 1, h - 2);
    if (w.t1 < c1) g.fillRect(Math.max(X(w.t1), LABEL_W + 1), y + 1, X(c1) - Math.max(X(w.t1), LABEL_W + 1), h - 2);
    const a = Math.max(c0, w.t0), b = Math.min(c1, w.t1);
    if (b <= a) return;
    drawLevels(g, { t: w.t, v: w.v }, a, b, X, hi, lo, w.pin, C, w.init);
    // DHT11 bit labels above each data-bit high pulse that is wide enough to read
    g.textAlign = 'center';
    for (const x of fineBits) {
      if (x.b < c0 || x.a > c1) continue;
      const xa = X(x.a), xb = X(x.b);
      if (xb - xa < 7) continue;
      g.fillStyle = x.bit ? C.accent : C.muted;
      g.fillText(String(x.bit), (xa + xb) / 2, y + 7);
    }
    // Pulse widths once each pulse is wide enough for a label
    if (ppc * CPU_HZ * 20e-6 > 30) {
      g.fillStyle = C.fg;
      for (let i = 0; i + 1 < w.t.length; i++) {
        if (w.t[i + 1] < c0 || w.t[i] > c1) continue;
        const xa = X(w.t[i]), xb = X(w.t[i + 1]);
        const lbl = `${((w.t[i + 1] - w.t[i]) / (CPU_HZ / 1e6)).toFixed(1)}µs`;
        if (xb - xa < g.measureText(lbl).width + 6) continue;
        g.fillText(lbl, (xa + xb) / 2, (w.v[i] ? hi : lo) + (w.v[i] ? 9 : -7));
      }
    }
    g.textAlign = 'left';
  }

  type Colors = Record<'fg' | 'muted' | 'line' | 'soft' | 'accent' | 'abg' | 'bad' | 'ok' | 'field', string>;

  function drawPin(g: CanvasRenderingContext2D, ch: Extract<Channel, { kind: 'pin' }>, y: number, h: number, W: number, c0: number, c1: number, X: (c: number) => number, ppc: number, nowC: number, C: Colors) {
    const hi = y + 7, lo = y + h - 7;
    const endC = Math.min(c1, nowC);
    if (endC <= c0) return;
    const pwm = session.io.pwm.get(ch.pin);
    const gpio = session.io.gpio.get(ch.pin);
    // Split by PWM first; segments without PWM (freq 0) are drawn from GPIO levels
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
        // Duty 0 / 100% is a flat line (the buzzer's 200 ms pause is duty 0)
        const yv = sg.duty > 0.5 ? hi : lo;
        g.beginPath();
        g.moveTo(xa, yv);
        g.lineTo(xb, yv);
        g.stroke();
      } else if (sg.freq > 0) {
        const P = CPU_HZ / sg.freq;
        const ppx = P * ppc;
        if (ppx >= 3) {
          // Per-period square wave, phase counted from when this PWM segment started
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
          // Zoomed out (< 3 px per period): draw the envelope and the average level line
          g.fillStyle = K.env;
          g.fillRect(xa, hi, xb - xa, lo - hi);
          g.beginPath();
          g.moveTo(xa, hi);
          g.lineTo(xb, hi);
          g.moveTo(xa, lo);
          g.lineTo(xb, lo);
          g.stroke();
          const ym = lo - sg.duty * (lo - hi);
          g.strokeStyle = K.envMid;
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
          g.fillStyle = K.tag;
          g.fillRect(lx - 2, y + h / 2 - 7, tw, 14);
          g.fillStyle = C.fg;
          g.fillText(lbl, lx + 2, y + h / 2);
        }
      } else {
        drawLevels(g, gpio, sg.a, sg.b, X, hi, lo, ch.pin, C);
      }
    }
  }

  function drawLevels(g: CanvasRenderingContext2D, s: { t: number[]; v: number[] } | undefined, a: number, b: number, X: (c: number) => number, hi: number, lo: number, pin: number, C: Colors, init?: number) {
    // Level at window start = previous event; with no events use the current level (never changed)
    const f = session.frame;
    const cur = init ?? (pin < 32 ? (f.gpio >>> pin) & 1 : (f.gpioHi >>> (pin - 32)) & 1);
    let i = s ? lastLE(s.t, a) : -1;
    let lv = s ? (i >= 0 ? s.v[i] : init !== undefined ? init : s.v.length ? 1 - s.v[0] : cur) : cur;
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
        // Several toggles within one pixel: draw a full vertical line
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
      // Normalise LED colour to full brightness (a dim 0x002000 still reads as green); the raw value is labelled
      const rgb = s.rgb[i];
      const [r, gg, bb] = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
      const k = 255 / Math.max(1, r, gg, bb);
      g.fillStyle = rgb ? `rgb(${Math.round(r * k)},${Math.round(gg * k)},${Math.round(bb * k)})` : K.wsOff;
      g.fillRect(X(a), y + 5, Math.max(1, X(b) - X(a)), h - 10);
      g.strokeStyle = C.line;
      g.strokeRect(X(a) + 0.5, y + 5.5, Math.max(1, X(b) - X(a)) - 1, h - 11);
      // Frame boundary
      if (s.t[i] >= c0) {
        g.fillStyle = C.fg;
        g.fillRect(X(s.t[i]), y + 3, 1, h - 6);
      }
      const lbl = `#${rgb.toString(16).padStart(6, '0')}${s.n[i] > 1 ? ` ×${s.n[i]}` : ''}`;
      if (X(b) - X(a) > g.measureText(lbl).width + 12) {
        g.fillStyle = K.wsTag;
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
    // Idle: both lines high (pull-ups)
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
    // Zoomed out, transactions < 24 px apart merge: one gets the full text + note, many get "n transactions · 0x76 ×2 · 0x3C ×3"
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
        // Bubbles start their own path: stroke the lines so far first
        g.stroke();
        drawItemBubbles(g, x, X, decY, C, x.items.some((it) => it.kind === 'addr' && it.nack));
        g.strokeStyle = C.accent;
        g.lineWidth = 1.4;
        g.beginPath();
        continue;
      }
      // Zoomed out: draw the transaction as an activity block
      g.stroke();
      g.fillStyle = K.txn;
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
        const tt = txnText(gr.xs[0]);
        const n = txnNote(gr.xs[0]);
        text = n ? `${tt} — ${n}` : tt;
        short = tt;
        const a = gr.xs[0].items.find((it) => it.kind === 'addr');
        const nr = gr.xs[0].items.filter((it) => it.kind === 'data' && it.read).length;
        const nw = gr.xs[0].items.filter((it) => it.kind === 'data' && !it.read).length;
        tiny = a ? (a.nack ? `${hex(a.byte)} NACK` : nr ? t('{addr} read {n} B', { addr: hex(a.byte), n: nr }) : t('{addr} write {n} B', { addr: hex(a.byte), n: nw })) : '';
      } else {
        const tally = new Map<string, number>();
        for (const x of gr.xs) {
          const a = x.items.find((it) => it.kind === 'addr');
          const key = a ? hex(a.byte) + (a.nack ? ' NACK' : '') : '?';
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
        text = t('{n} transactions · {tally}', { n: gr.xs.length, tally: [...tally].map(([a, c]) => `${a} ×${c}`).join(' · ') });
        short = t('{n} transactions', { n: gr.xs.length });
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

  /** SCL / SDA of one transaction, rebuilt from bit timing: start 1 bit, 8 bits + ACK per byte, stop 1 bit */
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

  /** Bit-level zoom: one small bubble per start / byte / stop */
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
    // Second line: transaction text + register note from its start (clamped to the label column)
    const note = txnNote(x);
    const full = `${txnText(x)}${note ? ' — ' + note : ''}`;
    const x0 = Math.max(X(x.t0), LABEL_W + 4);
    g.fillStyle = bad ? C.bad : C.fg;
    g.fillText(full, x0, decY + 34);
    bubbles.push(full);
  }


  function bubble(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, col: string, bad: boolean) {
    g.fillStyle = bad ? K.badBg : col === okCol ? K.okBg : K.abg;
    g.strokeStyle = col;
    g.lineWidth = 1;
    roundRect(g, x, y, w, h, Math.min(6, h / 2));
    g.fill();
    g.stroke();
    if (text) {
      g.fillStyle = bad ? col : K.bubbleFg;
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
        if (!chans.some((c) => c.id === id) && m) chans.push({ id, kind: 'pin', pin: Number(m[1]), label: id, role: t('Added manually') });
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
    fineStart,
    fine: () => ({ opts: fineOpts, state: fineState, wave: fineWave, bits: fineBits.map((b) => b.bit), frame: dhtFrame(fineBits) }),
    pulseText,
    exportVcd,
  };
  noteUi();
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
  // With tiny steps the absolute time gets long: show milliseconds
  const ms = t * 1e3;
  return `${ms.toFixed(Math.max(0, Math.ceil(-Math.log10(step * 1e3))))} ms`;
}

function fmtHz(f: number) {
  if (f >= 1e6) return `${(f / 1e6).toFixed(3)} MHz`;
  if (f >= 1e3) return `${(f / 1e3).toFixed(3)} kHz`;
  return `${f.toFixed(2)} Hz`;
}
