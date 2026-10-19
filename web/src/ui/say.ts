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

type Row = { ok: boolean | null; say?: string; text: string; tag?: string; dev?: string };

/** 一个器件一组（DESIGN_V2 §9.5）：组头写一次器件名和引脚；时间窗、数值留给原始数据 */
export interface RowGroup<R extends Row = Row> {
  dev: string;
  /** 引脚 / 地址小标签；和器件名同义（串口、USB、圆屏）时不显示 */
  pin?: string;
  rows: R[];
  bad: R[];
  /** 两条以上没过时合成的一句；一条没过就用那条的 say */
  sum?: string;
}

export function groupRows<R extends Row>(rows: R[]): RowGroup<R>[] {
  const by = new Map<string, RowGroup<R>>();
  for (const r of rows) {
    const dev = r.dev ?? r.tag ?? '其他';
    const key = `${dev}|${r.tag ?? ''}`;
    let g = by.get(key);
    if (!g) {
      g = { dev, pin: r.tag && r.tag !== dev ? r.tag : undefined, rows: [], bad: [] };
      by.set(key, g);
    }
    g.rows.push(r);
    if (r.ok === false) g.bad.push(r);
  }
  const out = [...by.values()];
  for (const g of out) {
    if (g.bad.length < 2) continue;
    // 每条都是「没响 / 没输出」就说一直没响，否则只报数，细节在下面小字
    const silent = g.bad.every((r) => /没响|没有收到|没亮|没闪|没打印/.test(r.say ?? ''));
    g.sum = silent && g.dev === '蜂鸣器' ? '蜂鸣器一直没响' : `${g.dev}${/[\x21-\x7e]$/.test(g.dev) ? ' ' : ''}有 ${g.bad.length} 处不对`;
  }
  // 没过的组排前面，组内顺序不动
  return out.sort((a, b) => Number(!a.bad.length) - Number(!b.bad.length));
}

/** 一组结果的标题（手机上不超过一行半）：全过说全过；只错一个器件就说那个器件的事；错几个器件只报数，逐条在下面 */
export function headline(rows: Row[]) {
  const judged = rows.filter((r) => r.ok !== null);
  if (!judged.some((r) => r.ok === false)) return judged.length > 1 ? `${judged.length} 项都通过了` : '通过了';
  const bad = groupRows(rows).filter((g) => g.bad.length);
  if (bad.length > 1) return `有 ${bad.length} 个器件不对`;
  return bad[0].sum ?? bad[0].bad[0].say ?? bad[0].bad[0].text;
}
