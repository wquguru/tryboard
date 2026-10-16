// 作品定义：每个作品走哪几个检查点（firmware/levels.json 的关卡 id）。
// 单独成文件，首页（home.ts）也读它来显示检查点数，不必拉进整套实验台代码。
// 原则：每过一个检查点作品就多一样东西；最后一个带装配（assembly）的检查点是"合体"。
import type { WorkDef } from './types';

export const WORKS: Record<string, WorkDef> = {
  weather: { id: 'weather', title: '桌面气象站', example: 'weather', checkpoints: ['01', '02', '03', '04', '05', '06'] },
  // 画脸 → 转身 → 合体（眼珠跟随 + 按键回头）
  spin: { id: 'spin', title: '会转身的小黄', example: 'spin', checkpoints: ['spin-1', 'spin-2', '07-spin'] },
  // 眼睛 + 眨眼 → 按键换表情 → 合体（四种表情循环）
  lens: { id: 'lens', title: '透镜里的小人', example: 'lens', checkpoints: ['lens-1', 'lens-2', '07-lens'] },
  blank: { id: 'blank', title: '空白实验台', example: null, checkpoints: [] },
};
