// 结果文案的人话层（DESIGN_V2 §9）：状态词、器件名、标题汇总。纯函数，命令行包也能引。
// 第一层只写人话；与命令行逐字一致的结论行（CheckResult.text）收进「原始数据」。

/** 状态只用四个词；颜色见 DESIGN_V2 §9.2 */
export const VERDICT = { ok: '通过', bad: '没通过', stall: '没跑完', shifted: '装壳后变了' } as const;
export type Verdict = keyof typeof VERDICT;

/** 常见 I2C 地址 → 芯片名（查不到就说「I2C 器件」） */
const CHIP_AT: Record<number, string> = { 0x76: 'BME280', 0x77: 'BME280', 0x3c: 'SSD1306 屏幕', 0x3d: 'SSD1306 屏幕', 0x68: 'MPU6050', 0x69: 'MPU6050' };
export const chipAt = (addr: number) => CHIP_AT[addr] ?? 'I2C 器件';

/** PWM 引脚上接的是什么：舵机 50 Hz，蜂鸣器在人耳频段 */
export function pwmDevice(freq: number, beeps: boolean): 'servo' | 'buzzer' | 'other' {
  if (Math.abs(freq - 50) <= 1) return 'servo';
  if (beeps || (freq >= 100 && freq <= 20000)) return 'buzzer';
  return 'other';
}

/** 舵机脉宽差折成角度：0.5–2.5 ms 对 180°（SG90 一类） */
export const servoDeg = (dms: number) => Math.round(Math.abs(dms) * 90);

/** 要求的次数说成人话：2 次 / 至少 4 次 / 2–5 次 */
export function want(min: number, max?: number) {
  if (max === undefined) return `至少 ${min}`;
  return min === max ? `${min}` : `${min}–${max}`;
}

/** 一组结果的标题（手机上不超过一行半）：全过说全过；只错一件就说那件事；错几件只报数，逐条在下面 */
export function headline(rows: { ok: boolean | null; say?: string; text: string }[]) {
  const judged = rows.filter((r) => r.ok !== null);
  const bad = judged.filter((r) => r.ok === false);
  if (!bad.length) return judged.length > 1 ? `${judged.length} 项都通过了` : '通过了';
  return bad.length > 1 ? `有 ${bad.length} 项没通过` : (bad[0].say ?? bad[0].text);
}
