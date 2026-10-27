// H-33 symbols for parts the v3 design sheets do not draw (BME280, pot, WS2812, HC-SR04), in the H-25 style:
// 2-unit strokes in currentColor, var(--surface) fills, 12 px mono notation. view.tsx imports this file, never the reverse.
import type { SchSym } from "./model";

/** IEC-style zigzag resistor along +x over `len` units (60-unit body, leads on both sides) */
export function zig(len: number) {
  const lead = (len - 60) / 2;
  return `M0 0h${lead}l5-9 10 18 10-18 10 18 10-18 10 18 5-9h${lead}`;
}

const S = { stroke: "currentColor", strokeWidth: 2, fill: "none" } as const;
const lead = (s: SchSym, y: number, x2: number) => <path key={`l${y}`} d={`M${s.x} ${y}H${x2}`} {...S} />;
const pin = (s: SchSym, re: RegExp) => s.pins.find((p) => re.test(p.name));
/** Desktop with every listed pin wired, top to bottom in this order: the symbol bridges them with leads */
const ordered = (vertical: boolean, ...ps: ({ y: number } | undefined)[]) => !vertical && ps.every((p, k) => p && (k === 0 || p.y > ps[k - 1]!.y));
/** Free-standing picture on the right of the box (phone, or a desktop box missing a wire); on a wide phone sheet it
 *  moves clear of the last pin's column */
const spot = (s: SchSym, vertical: boolean, w: number) => {
  const free = vertical ? Math.max(228, Math.max(0, ...s.pins.map((p) => p.x)) + 36 - s.x) : 228;
  return { x: s.x + Math.min(s.w - w - 12, free), y: vertical ? s.y + 40 : s.y + s.h / 2 - 10 };
};

/** Potentiometer: zigzag between the two ends, the wiper arrow pointing at its middle */
function Pot({ s, vertical }: { s: SchSym; vertical: boolean }) {
  const [a, w, b] = [pin(s, /^(VCC|3V3|VIN)$/), pin(s, /^(OUT|SIG|W|AO)$/), pin(s, /^GND$/)];
  if (ordered(vertical, a, w, b) && w!.y - a!.y === b!.y - w!.y) {
    const cx = s.x + 140;
    return (
      <g data-glyph="pot">
        {lead(s, a!.y, cx)}
        {lead(s, b!.y, cx)}
        {lead(s, w!.y, cx - 22)}
        <path d={zig(b!.y - a!.y)} transform={`translate(${cx} ${a!.y}) rotate(90)`} {...S} strokeLinejoin="round" />
        <path d={`M${cx - 12} ${w!.y}l-10-5v10z`} fill="currentColor" />
      </g>
    );
  }
  const { x, y } = spot(s, vertical, 72);
  // Horizontal body with the wiper arrow coming up from below
  return (
    <g data-glyph="pot">
      <path d={zig(72)} transform={`translate(${x} ${y + 10})`} {...S} strokeLinejoin="round" />
      <path d={`M${x + 36} ${y + 34}v-10`} {...S} />
      <path d={`M${x + 36} ${y + 21}l-5 8h10z`} fill="currentColor" />
    </g>
  );
}

/** Addressable RGB LED: a package square with the diode and three light arrows inside, data in on the left */
function Led({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <>
      <rect x={cx - r} y={cy - r} width={2 * r} height={2 * r} rx={3} fill="var(--surface)" {...{ stroke: "currentColor", strokeWidth: 2 }} />
      <path d={`M${cx - 10} ${cy - 7}v14l12-7z`} fill="#FF9933" fillOpacity={0.2} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <path d={`M${cx + 2} ${cy - 8}v16`} stroke="currentColor" strokeWidth={2.4} />
      {["#E5484D", "#30A46C", "#3E63DD"].map((c, k) => (
        <path key={c} d={`M${cx + 4 + k * 4} ${cy - 6 + k * 3}l5-6`} stroke={c} strokeWidth={1.8} strokeLinecap="round" />
      ))}
    </>
  );
}

function Strip({ s, vertical }: { s: SchSym; vertical: boolean }) {
  const [v, d, g] = [pin(s, /^(5V|VCC|VDD)$/), pin(s, /^DIN$/), pin(s, /^GND$/)];
  if (ordered(vertical, v, d, g)) {
    const [cx, cy, r] = [s.x + 130, d!.y, 18];
    // DOUT chains to the next LED of the strip, so it leaves the square unconnected
    return (
      <g data-glyph="ws2812">
        <path d={`M${s.x} ${v!.y}H${cx}V${cy - r}M${s.x} ${g!.y}H${cx}V${cy + r}`} {...S} />
        {lead(s, cy, cx - r)}
        <Led cx={cx} cy={cy} r={r} />
        <path d={`M${cx + r} ${cy}h22`} {...S} strokeDasharray="4 3" />
        <text x={cx + r + 4} y={cy - 6} className="fill-muted font-mono text-[12px]">
          DOUT
        </text>
      </g>
    );
  }
  const { x, y } = spot(s, vertical, 76);
  return (
    <g data-glyph="ws2812">
      <path d={`M${x} ${y + 16}h20`} {...S} />
      <path d={`M${x + 56} ${y + 16}h20`} {...S} strokeDasharray="4 3" />
      <Led cx={x + 38} cy={y + 16} r={18} />
    </g>
  );
}

/** Thermometer, humidity drop and pressure dial inside a small IC outline with pin ticks */
function Bme({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const cy = y + h / 2;
  const [t, d, p] = [x + w * 0.2, x + w * 0.46, x + w * 0.76];
  const ticks = [0.3, 0.7].map((f) => `M${x - 5} ${y + h * f}h5M${x + w} ${y + h * f}h5`).join("");
  return (
    <>
      <path d={ticks} {...S} strokeWidth={1.5} />
      <rect x={x} y={y} width={w} height={h} rx={3} fill="var(--surface)" stroke="currentColor" strokeWidth={2} />
      <path d={`M${t - 3} ${cy + 5}V${cy - 12}a3 3 0 0 1 6 0V${cy + 5}`} {...S} strokeWidth={1.5} />
      <circle cx={t} cy={cy + 9} r={5} fill="#E5484D" />
      <path d={`M${d} ${cy - 10}c5 7 7 10 7 13a7 7 0 0 1-14 0c0-3 2-6 7-13z`} fill="#3E63DD" fillOpacity={0.2} stroke="currentColor" strokeWidth={1.5} />
      <circle cx={p} cy={cy} r={12} {...S} strokeWidth={1.5} />
      <path d={`M${p} ${cy}l6-7`} {...S} strokeLinecap="round" />
    </>
  );
}

function Sensor({ s, vertical }: { s: SchSym; vertical: boolean }) {
  const [w, h] = vertical ? [88, 38] : [96, 56];
  const x = vertical ? spot(s, true, w + 5).x : s.x + 88;
  const y = vertical ? s.y + 40 : s.y + s.h / 2 - h / 2 + 18;
  return (
    <g data-glyph="bme280">
      <Bme x={x} y={y} w={w} h={h} />
    </g>
  );
}

/** Ultrasonic transducer: T sends (arcs bulge away), R receives (arcs bulge toward it) */
function Can({ cx, cy, r, tx }: { cx: number; cy: number; r: number; tx: boolean }) {
  const q = tx ? 1 : -1;
  const a = r + (tx ? 6 : 10);
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill="var(--surface)" stroke="currentColor" strokeWidth={2} />
      <text x={cx} y={cy + 4} textAnchor="middle" className="fill-current text-[12px] font-bold">
        {tx ? "T" : "R"}
      </text>
      <path d={`M${cx + a} ${cy - 7}q${5 * q} 7 0 14M${cx + a + 7} ${cy - 11}q${8 * q} 11 0 22`} {...S} strokeWidth={1.5} strokeLinecap="round" />
    </>
  );
}

function Sonar({ s, vertical }: { s: SchSym; vertical: boolean }) {
  const [trig, echo] = [pin(s, /^Trig$/i), pin(s, /^Echo$/i)];
  if (ordered(vertical, trig, echo)) {
    const cx = s.x + 130;
    return (
      <g data-glyph="sonar">
        {s.pins.map((p) => lead(s, p.y, p === trig || p === echo ? cx - 14 : s.x + 56))}
        <Can cx={cx} cy={trig!.y} r={14} tx />
        <Can cx={cx} cy={echo!.y} r={14} tx={false} />
      </g>
    );
  }
  const { x, y } = spot(s, vertical, 50);
  return (
    <g data-glyph="sonar">
      <Can cx={x + 11} cy={y + 4} r={11} tx />
      <Can cx={x + 11} cy={y + 32} r={11} tx={false} />
    </g>
  );
}

/** The H-33 glyph for a box, or null when the box is drawn by view.tsx */
export function PartGlyph({ s, vertical }: { s: SchSym; vertical: boolean }) {
  if (s.glyph === "pot") return <Pot s={s} vertical={vertical} />;
  if (s.glyph === "ws2812") return <Strip s={s} vertical={vertical} />;
  if (s.glyph === "bme280") return <Sensor s={s} vertical={vertical} />;
  if (s.glyph === "sonar") return <Sonar s={s} vertical={vertical} />;
  return null;
}

/** Glyphs that run leads through the pin rows on desktop, so pin names sit above the lines */
export const LEADED = new Set(["button", "buzzer", "servo", "pot", "ws2812", "sonar"]);
