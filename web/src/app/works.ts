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
  // P2-03 / P2-02 的外设台面（还不是完整作品：没有检查点、组装模版；体感小人等作品见 P2-09）
  imu: { id: 'imu', title: '倾角仪（MPU6050）', example: 's3-imu', checkpoints: [] },
  touch: { id: 'touch', title: '触摸圆屏（CST816S）', example: 's3-touch', checkpoints: [] },
};
