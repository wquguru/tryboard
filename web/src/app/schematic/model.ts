// H-17 schematic: a 2D layout model built from the bench parts (after sceneView) and their wiresOf rows.
// Pure and tested by node --test; coordinates are SVG px on a 20 px grid (the dot paper), see DECISIONS 2026-10-26.
import type { PartSpec } from '../../bench3d/spec.ts';
import type { PickTarget } from '../../scene-api.ts';
import { LED_OHM_DEFAULT, LED_VF, ledAmps, ledColor, ohmText, type LedColor } from '../../bench3d/ledparams.ts';
import { partId, partInfo, partLabel, type BenchWire } from '../wiring.ts';

export interface SchPin {
  name: string;
  x: number;
  y: number;
  /** Where the pin name sits relative to (x, y) */
  anchor: 'start' | 'end' | 'middle';
}

export interface SchSym {
  /** Reference designator: U1 board, R1 / D1 per LED, U2… other parts */
  ref: string;
  kind: 'mcu' | 'res' | 'led' | 'box';
  part: string;
  pick: PickTarget;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  /** Resistor / LED orientation: h = left to right, v = top to bottom */
  dir?: 'h' | 'v';
  color?: LedColor;
  ohm?: number;
  pins: SchPin[];
  /** Caption position (resistor / LED) */
  tx?: number;
  ty?: number;
}

export interface SchLine {
  pts: number[];
  /** Bench wire this line stands for (3D highlight) */
  wire?: string;
  missing?: boolean;
}

/** Net flag: parts on the same net share a name instead of a long wire (I2C, power). */
export interface SchFlag {
  net: string;
  x: number;
  y: number;
  w: number;
  wire: string;
  end: 'board' | 'part';
}

export interface SchFlow {
  part: string;
  ref: string;
  pts: number[];
  mA: number;
  x: number;
  y: number;
}

export interface Schematic {
  w: number;
  h: number;
  syms: SchSym[];
  lines: SchLine[];
  flags: SchFlag[];
  gnds: { x: number; y: number }[];
  flows: SchFlow[];
  /** Net name → bench wire ids on it (a flag click lights every end) */
  nets: Record<string, string[]>;
}

export interface SchOpts {
  vertical?: boolean;
  board?: string;
}

const order = (n: string) =>
  n === '3V3' ? 0 : n === '5V' ? 1 : n === 'EXT5V' ? 2 : n === 'GND' ? 1000 : n.startsWith('GPIO') ? 10 + Number(n.slice(4)) : 500;
/** Flag width for a name (12 px mono ≈ 7.5 px per glyph plus padding) */
const flagW = (s: string) => Math.ceil(s.length * 7.5 + 16);

/** Net name per board end: power / GND keep their own, a GPIO used as an I2C line takes the bus pin name (SDA / SCL). */
function netNames(wires: BenchWire[]) {
  const out: Record<string, string> = {};
  for (const w of wires) {
    if (out[w.a]) continue;
    if (!w.a.startsWith('GPIO')) out[w.a] = w.a;
    else {
      const bus = wires.find((x) => x.a === w.a && x.pinRole === 'bus' && /^(TP_)?(SDA|SCL)$/.test(x.pin));
      out[w.a] = bus ? bus.pin.replace(/^TP_/, '') : w.a;
    }
  }
  // Two buses on different GPIOs must not share a name
  const seen: Record<string, string> = {};
  for (const [a, n] of Object.entries(out)) {
    if (seen[n] && seen[n] !== a) out[a] = a;
    else seen[n] = a;
  }
  return out;
}

const info = (p: PartSpec) => {
  try {
    return partInfo(p) ?? null;
  } catch {
    return null;
  }
};

/** Lay the bench out as a schematic: the board box, an inline loop per LED, every other part as a box with net flags. */
export function schematicOf(parts: PartSpec[], wires: BenchWire[], opts: SchOpts = {}): Schematic {
  const ids = new Set(parts.map(partId));
  const ws = wires.filter((w) => ids.has(w.part));
  const names = netNames(ws);
  const leds = parts.filter((p): p is Extract<PartSpec, { type: 'led' }> => p.type === 'led');
  const others = parts.filter((p) => p.type !== 'led');
  const ledRow = (p: PartSpec) => ws.find((w) => w.part === partId(p) && w.pin !== 'GND');
  const ledGnd = (p: PartSpec) => ws.find((w) => w.part === partId(p) && w.pin === 'GND');
  // Board pins: one per LED (its loop owns the row) plus one per net the other parts use
  type Row = { a: string; led?: PartSpec };
  const rows: Row[] = [];
  for (const p of leds) {
    const w = ledRow(p);
    rows.push({ a: w?.a ?? `GPIO${p.pin}`, led: p });
  }
  const flagNets = [...new Set(ws.filter((w) => !w.part.startsWith('led:')).map((w) => w.a))];
  for (const a of flagNets) rows.push({ a });
  const labelled = flagNets.length > 0;
  if (leds.length && !rows.some((r) => r.a === 'GND' && !r.led)) rows.push({ a: 'GND' });
  rows.sort((x, y) => order(x.a) - order(y.a) || (x.led ? 0 : 1) - (y.led ? 0 : 1));

  const sch: Schematic = { w: 0, h: 0, syms: [], lines: [], flags: [], gnds: [], flows: [], nets: {} };
  const net = (n: string, wire: string) => {
    const l = (sch.nets[n] ??= []);
    if (!l.includes(wire)) l.push(wire);
  };
  const flag = (n: string, x: number, y: number, wire: string, end: SchFlag['end'], alignRight = false) => {
    const w = flagW(n);
    sch.flags.push({ net: n, x: alignRight ? x - w : x, y, w, wire, end });
    net(n, wire);
  };
  const board: SchSym = {
    ref: 'U1',
    kind: 'mcu',
    part: 'board',
    pick: { kind: 'part', id: 'board' },
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    title: 'U1',
    sub: opts.board,
    pins: [],
  };
  sch.syms.push(board);
  let ledN = 0;
  let boxN = 1;
  const ledSyms = (p: Extract<PartSpec, { type: 'led' }>) => {
    ledN++;
    const id = partId(p);
    const w = ledRow(p);
    const ohm = w?.ohm ?? p.ohm ?? LED_OHM_DEFAULT;
    const color = ledColor(p.color);
    const pick: PickTarget = { kind: 'part', id };
    return {
      id,
      w,
      g: ledGnd(p),
      ohm,
      color,
      mA: ledAmps(ohm, LED_VF[color]) * 1000,
      r: { ref: `R${ledN}`, kind: 'res', part: id, pick: { ...pick, anchor: 'res' }, title: `R${ledN}`, sub: `${ohmText(ohm)} Ω`, ohm, pins: [] } as Omit<SchSym, 'x' | 'y' | 'w' | 'h'>,
      d: { ref: `D${ledN}`, kind: 'led', part: id, pick: { ...pick, anchor: 'led' }, title: `D${ledN}`, color, pins: [] } as Omit<SchSym, 'x' | 'y' | 'w' | 'h'>,
    };
  };
  const boxOf = (p: PartSpec) => {
    const id = partId(p);
    const pw = ws.filter((w) => w.part === id);
    const i = info(p);
    const addr = 'addr' in p && typeof p.addr === 'number' ? `0x${p.addr.toString(16).toUpperCase()}` : undefined;
    return { id, pw, title: `U${++boxN}`, sub: [i?.name ?? partLabel(p.type), addr].filter(Boolean).join(' · ') };
  };

  if (!opts.vertical) {
    // Desktop: board on the left, LED loops run right from their pin, other parts stack in a right column
    const BX = 60, BY = 40, BW = 200, R = BX + BW;
    let y = BY + 90;
    for (const row of rows) {
      const n = names[row.a] ?? row.a;
      board.pins.push({ name: row.a, x: R - 12, y, anchor: 'end' });
      if (row.led) {
        const L = ledSyms(row.led as Extract<PartSpec, { type: 'led' }>);
        const wire = L.w?.id;
        if (L.ohm > 0) {
          sch.lines.push({ pts: [R, y, 360, y], wire, missing: L.w?.missing });
          sch.syms.push({ ...L.r, x: 360, y: y - 16, w: 100, h: 32, dir: 'h', tx: 410, ty: y - 26 });
          sch.lines.push({ pts: [460, y, 520, y] });
        } else sch.lines.push({ pts: [R, y, 520, y], wire, missing: L.w?.missing });
        sch.syms.push({ ...L.d, x: 520, y: y - 28, w: 80, h: 56, dir: 'h', tx: 560, ty: y - 38 });
        sch.lines.push({ pts: [600, y, 660, y, 660, y + 40], wire: L.g?.id, missing: L.g?.missing });
        sch.gnds.push({ x: 660, y: y + 40 });
        if (wire) net(row.a, wire);
        if (L.g) net('GND', L.g.id);
        sch.flows.push({ part: L.id, ref: L.d.ref, pts: [R + 10, y + 18, 650, y + 18], mA: L.mA, x: R + 30, y: y + 30 });
        y += 110;
        continue;
      }
      const wire = ws.find((w) => w.a === row.a && !w.part.startsWith('led:'))?.id;
      if (row.a === 'GND' && !labelled) {
        sch.lines.push({ pts: [R, y, 320, y, 320, y + 20] });
        sch.gnds.push({ x: 320, y: y + 20 });
        y += 70;
        continue;
      }
      sch.lines.push({ pts: [R, y, R + 40, y], wire });
      if (wire) flag(n, R + 44, y, wire, 'board');
      else sch.flags.push({ net: n, x: R + 44, y, w: flagW(n), wire: '', end: 'board' });
      y += 40;
    }
    board.x = BX;
    board.y = BY;
    board.w = BW;
    board.h = Math.max(200, y - 40 + 30 - BY);
    let by = BY;
    const X = 800;
    for (const p of others) {
      const b = boxOf(p);
      const h = 70 + Math.max(1, b.pw.length) * 40;
      const pins: SchPin[] = [];
      b.pw.forEach((w, k) => {
        const py = by + 70 + k * 40;
        pins.push({ name: w.pin, x: X + 12, y: py, anchor: 'start' });
        sch.lines.push({ pts: [X - 40, py, X, py], wire: w.id, missing: w.missing });
        flag(names[w.a] ?? w.a, X - 44, py, w.id, 'part', true);
      });
      sch.syms.push({ ref: b.title, kind: 'box', part: b.id, pick: { kind: 'part', id: b.id }, x: X, y: by, w: 200, h, title: b.title, sub: b.sub, pins });
      by += h + 30;
    }
    sch.w = others.length ? X + 240 : leds.length ? 720 : R + 160;
    sch.h = Math.max(board.y + board.h, by - 30) + 40;
    return sch;
  }

  // Phone: board on top with pins along its bottom edge, LED loops hang straight down, other parts stack below
  const PITCH = 76;
  const W = Math.max(350, 40 + rows.length * PITCH);
  const BX = 20, BY = 20, BH = 96;
  const PY = BY + BH;
  let low = PY + 60;
  rows.forEach((row, i) => {
    const x = BX + PITCH / 2 + 4 + i * PITCH;
    const n = names[row.a] ?? row.a;
    board.pins.push({ name: row.a, x, y: PY - 10, anchor: 'middle' });
    if (row.led) {
      const L = ledSyms(row.led as Extract<PartSpec, { type: 'led' }>);
      const wire = L.w?.id;
      let y = PY;
      if (L.ohm > 0) {
        sch.lines.push({ pts: [x, y, x, y + 30], wire, missing: L.w?.missing });
        sch.syms.push({ ...L.r, x: x - 14, y: y + 30, w: 28, h: 80, dir: 'v', tx: x + 16, ty: y + 64 });
        y += 110;
        sch.lines.push({ pts: [x, y, x, y + 20] });
      } else sch.lines.push({ pts: [x, y, x, y + 20], wire, missing: L.w?.missing });
      y += 20;
      sch.syms.push({ ...L.d, x: x - 26, y, w: 52, h: 56, dir: 'v', tx: x + 16, ty: y + 20 });
      y += 56;
      sch.lines.push({ pts: [x, y, x, y + 24], wire: L.g?.id, missing: L.g?.missing });
      sch.gnds.push({ x, y: y + 24 });
      if (wire) net(row.a, wire);
      if (L.g) net('GND', L.g.id);
      sch.flows.push({ part: L.id, ref: L.d.ref, pts: [x + 10, PY + 6, x + 10, y + 16], mA: L.mA, x: BX, y: 0 });
      low = Math.max(low, y + 50);
      return;
    }
    const wire = ws.find((w) => w.a === row.a && !w.part.startsWith('led:'))?.id;
    if (row.a === 'GND' && !labelled) {
      sch.lines.push({ pts: [x, PY, x, PY + 30] });
      sch.gnds.push({ x, y: PY + 30 });
      return;
    }
    sch.lines.push({ pts: [x, PY, x, PY + 26], wire });
    const fw = flagW(n);
    if (wire) flag(n, x - fw / 2, PY + 38, wire, 'board');
    else sch.flags.push({ net: n, x: x - fw / 2, y: PY + 38, w: fw, wire: '', end: 'board' });
  });
  board.x = BX;
  board.y = BY;
  board.w = W - 40;
  board.h = BH;
  // Current captions go in a list under the loops: columns are too narrow for the text
  sch.flows.forEach((f, k) => {
    f.y = low + k * 26;
  });
  let by = low + sch.flows.length * 26 + 60;
  let w = W;
  for (const p of others) {
    const b = boxOf(p);
    const pitch = 76;
    w = Math.max(w, 40 + b.pw.length * pitch);
    const pins: SchPin[] = [];
    b.pw.forEach((wr, k) => {
      const x = BX + pitch / 2 + 4 + k * pitch;
      pins.push({ name: wr.pin, x, y: by + 22, anchor: 'middle' });
      sch.lines.push({ pts: [x, by - 26, x, by], wire: wr.id, missing: wr.missing });
      const n = names[wr.a] ?? wr.a;
      const fw = flagW(n);
      flag(n, x - fw / 2, by - 38, wr.id, 'part');
    });
    const bw = Math.max(W, 40 + b.pw.length * pitch) - 40;
    sch.syms.push({ ref: b.title, kind: 'box', part: b.id, pick: { kind: 'part', id: b.id }, x: BX, y: by, w: bw, h: 80, title: b.title, sub: b.sub, pins });
    by += 80 + 70;
  }
  sch.w = w;
  sch.h = others.length ? by - 70 + 20 : low + sch.flows.length * 26 + 20;
  return sch;
}
