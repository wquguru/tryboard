// Example list (web/public/fw/examples.json, copied from firmware/examples.json by tools/build_web.sh), fetched once per page.
// Used for ?work=blank&example=<id> bench/chip (session.ts), the firmware menu and the "This example" card (DESIGN_V2 §6.1).
import type { SceneSpec } from '../board3d';
import { lab } from '../ui/links';

export type Chip = 'esp32' | 'esp32c3' | 'esp32s3';

/** Analog input slider (potentiometer on an ADC pin). */
export interface AnalogControl {
  type: 'analog';
  pin: number;
  label: string;
  max_mv: number;
  value: number;
}

export interface Example {
  id: string;
  title: string;
  about: string;
  tags: string[];
  /** Defaults to esp32c3. */
  chip?: Chip;
  scene?: SceneSpec;
  /** 'env': environment sliders; 'imu': tilt sliders; object: analog input slider. */
  controls?: (string | AnalogControl)[];
  assembly?: boolean | string;
}

let cache: Promise<Example[]> | null = null;
export function loadExamples(): Promise<Example[]> {
  cache ??= fetch('./fw/examples.json')
    .then((r) => r.json() as Promise<Example[]>)
    .catch(() => []);
  return cache;
}

export const chipOf = (e: Example): Chip => e.chip ?? 'esp32c3';
export const CHIP_NAME: Record<Chip, string> = { esp32: 'ESP32', esp32c3: 'ESP32-C3', esp32s3: 'ESP32-S3' };

/** Lab URL of an example. */
export const exampleHref = (id: string) => lab('blank', 'bench', { example: id });
