// 示例清单（web/public/fw/examples.json，由 tools/build_web.sh 从 firmware/examples.json 拷来）：整页只取一次。
// 工作台用它：?work=blank&example=<id> 的台面 / 芯片（session.ts）、「换固件」菜单、右栏「这个示例」说明卡（DESIGN_V2 §6.1）。
import type { SceneSpec } from '../board3d';
import { lab } from '../ui/links';

export type Chip = 'esp32c3' | 'esp32s3';

/** 模拟输入滑块（电位器接 ADC 脚） */
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
  /** 缺省 esp32c3 */
  chip?: Chip;
  scene?: SceneSpec;
  /** 'env'：环境滑块；'imu'：倾斜滑块；对象：模拟输入滑块 */
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
export const CHIP_NAME: Record<Chip, string> = { esp32c3: 'ESP32-C3', esp32s3: 'ESP32-S3' };

/** 示例在工作台里的地址 */
export const exampleHref = (id: string) => lab('blank', 'bench', { example: id });
