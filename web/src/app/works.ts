// Work definitions: which checkpoints (firmware/levels.json level ids) each work walks, and its home card text.
// Kept separate so home.ts can build cards without pulling in the lab; each checkpoint adds one thing, the last (with assembly) is the "combine".
import type { WorkDef } from './types';
import { t } from '../i18n';

export const WORKS: Record<string, WorkDef> = {
  weather: { id: 'weather', title: t('Desk weather station'), example: 'weather', checkpoints: ['01', '02', '03', '04', '05', '06'], card: { chip: 'ESP32-S3', blurb: t('A screen shows temperature, humidity and pressure, a servo dial points at the temperature, and the RGB LED changes color with hot and cold') } },
  // Draw face → turn → combine (eyes follow + button turns it around)
  spin: { id: 'spin', title: t('Little Yellow who turns around'), example: 'spin', checkpoints: ['spin-1', 'spin-2', '07-spin'], card: { chip: 'ESP32-S3', blurb: t('A servo turntable with a round-screen face; press the button and it turns to face you') } },
  // Eyes + blink → button changes face → combine (four faces cycle)
  lens: { id: 'lens', title: t('The little figure in the lens'), example: 'lens', checkpoints: ['lens-1', 'lens-2', '07-lens'], card: { chip: 'ESP32-S3', blurb: t('A convex lens magnifies the round-screen face; the button switches faces') } },
  // Enumerate → keys send letters → combine (macro key + case). P2-12
  usbkey: { id: 'usbkey', title: t('USB mini keyboard'), example: 'usbkey', checkpoints: ['usbkey-1', 'usbkey-2', 'usbkey-3'], card: { chip: 'ESP32-S3', blurb: t('A four-key USB keyboard: three letter keys plus a macro key that types a whole sentence') } },
  // P2-09 works: each line is "part works alone → second thing → combine (with assembly)"
  // Strip lights → knob reads → combine (knob sets brightness / color, press switches)
  lamp: { id: 'lamp', title: t('Knob desk lamp'), example: 'lamp', checkpoints: ['lamp-1', 'lamp-2', 'lamp-3'], card: { chip: 'ESP32-S3', blurb: t('Turn the knob for brightness, press to switch to color; 8 WS2812 LEDs') } },
  // Range print → OLED → combine (closer = faster beeps)
  ruler: { id: 'ruler', title: t('Ultrasonic ruler'), example: 'ruler', checkpoints: ['ruler-1', 'ruler-2', 'ruler-3'], card: { chip: 'ESP32-S3', blurb: t('Ultrasonic ranging with the result on screen; the buzzer beeps faster or slower with distance') } },
  // Read attitude → draw bean on round screen → combine (bean slides downhill when tilted)
  tilt: { id: 'tilt', title: t('Tilt buddy'), example: 'tilt', checkpoints: ['tilt-1', 'tilt-2', 'tilt-3'], card: { chip: 'ESP32-S3', blurb: t('A little bean rolls toward whichever way the screen tilts') } },
  // P2-01 / P2-04 peripheral benches (no checkpoints; the matching works are the knob lamp and ultrasonic ruler)
  knob: { id: 'knob', title: t('Knob counter (encoder and PCNT)'), example: 's3-encoder', checkpoints: [] },
  sonar: { id: 'sonar', title: t('Ultrasonic ranging (HC-SR04, RMT receive)'), example: 's3-ultrasonic', checkpoints: [] },
  blank: { id: 'blank', title: t('Blank'), example: null, checkpoints: [] },
  // Board-picker result (DESIGN_V2 §8.3): BOM, bench and checkpoints come from URL params (genlevels.ts); only Shop → Lab
  custom: { id: 'custom', title: t('My project'), example: null, checkpoints: [] },
  // P2-03 / P2-02 peripheral benches (no checkpoints or assembly; the matching work is the tilt buddy)
  imu: { id: 'imu', title: t('Inclinometer (MPU6050)'), example: 's3-imu', checkpoints: [] },
  touch: { id: 'touch', title: t('Touch round screen (CST816S)'), example: 's3-touch', checkpoints: [] },
};

/** localStorage key for a work's data */
export const wkey = (w: WorkDef) => w.key ?? w.id;

/** Works shown on the home page (those with a card), in definition order */
export const HOME_WORKS = Object.values(WORKS).filter((w) => w.card);
