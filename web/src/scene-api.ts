// Contract between the 3D bench (implemented in board3d.ts) and the lab shell in src/app/.
// Both sides were built in parallel; if the implementation is missing the shell must degrade quietly (pins just aren't clickable).
import { locale } from './i18n';

// Canvas text gets no CSS lang-based fallback, so pick CJK fonts per locale: ja/ko must not get Chinese glyph forms.
const CJK: Record<string, string> = {
  zh: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC"',
  ja: '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", "PingFang SC", "Microsoft YaHei", "Noto Sans SC"',
  ko: '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", "PingFang SC", "Microsoft YaHei", "Noto Sans SC"',
  en: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC"',
};
/** Same stack with the self-hosted Latin slice first (R-17), for canvas text that should match the page font. */
export const PAGE_SANS = `"TB Sans", ${CJK[locale] ?? CJK.en}, sans-serif`;
/** Sans-serif stack for canvas / overlay text: Latin first, then the locale's CJK fonts. */
export const SANS = `Inter, Helvetica, ${CJK[locale] ?? CJK.en}, sans-serif`;

/** Ids: parts 'board' | 'oled' | 'bme280' | 'servo' | 'gc9a01' | 'pot' | 'led:<pin>' | 'power' | 'mpu6050' | 'qmi8658' (P2-03) | 'cst816s' (P2-02);
 *  pins = board silkscreen ('GPIO4', '3V3') or '<part>:<silk>' ('bme280:SDA'); wires 'wire:<pin>~<pin>'; buttons 'BOOT' | 'RST'. */
export type PickKind = 'part' | 'pin' | 'wire' | 'button';
export interface PickTarget {
  kind: PickKind;
  id: string;
  /** project() only: a named spot on the thing (board 'usb', LED part 'res' / 'led', wire '0' = board end) */
  anchor?: string;
  /** onPick only: which area of the board the click landed on ('usb' port, 'chip' module), for lesson 0 (H-16) */
  spot?: 'usb' | 'chip';
}

export interface ScreenPoint { x: number; y: number }

export interface PinInfo {
  id: string;
  /** Silkscreen text */
  label: string;
  /** What this pin drives, e.g. 'SG90 signal'; empty when unconnected */
  role?: string;
}

export interface ScenePickApi {
  /** Pick (null for empty space); screen is CSS px relative to the bench container's top-left */
  onPick(cb: (t: PickTarget | null, screen: ScreenPoint) => void): void;
  /** Highlight: part outline, pin ring + tag, thicker wire; null clears */
  highlight(t: PickTarget | null): void;
  /** Screen position inside the bench container (to place quick cards); null when off-screen */
  project(t: PickTarget): ScreenPoint | null;
  /** Every board pin, connected or not */
  listPins(): PinInfo[];
  /** Wiring-rule result: paint the wire red with a short message; null clears */
  setWireFault(wireId: string, msg: string | null): void;
  /** Rewire: move the board end of a wire to pin `to` ('GPIO5', '5V'…); null restores it */
  rewire?(wireId: string, to: string | null): void;
  /** Board-to-board jumper (a → b, e.g. '3V3' → 'GND'); b null removes it */
  bridge?(wireId: string, a: string, b: string | null): void;
  /** A heat source near a part (only the glow; readings come from the environment values) */
  setHeat(partId: string | null): void;
  /** Ruler between two targets (mm); null clears */
  measure(a: PickTarget | null, b?: PickTarget): number | null;
  /** Light (bench default) / dark theme */
  setTheme(theme: 'light' | 'dark'): void;
}
