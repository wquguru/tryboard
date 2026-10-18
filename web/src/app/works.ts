// 作品定义：每个作品走哪几个检查点（firmware/levels.json 的关卡 id）、首页卡片上写什么。
// 单独成文件，首页（home.ts）也读它来生成作品卡、显示检查点数，不必拉进整套实验台代码：加一个作品只要在这里加一项。
// 原则：每过一个检查点作品就多一样东西；最后一个带装配（assembly）的检查点是"合体"。
import type { WorkDef } from './types';

export const WORKS: Record<string, WorkDef> = {
  weather: { id: 'weather', title: '桌面气象站', example: 'weather', checkpoints: ['01', '02', '03', '04', '05', '06'], card: { chip: 'ESP32-S3', blurb: '屏幕显示温湿度和气压，舵机表盘指示温度，彩灯随冷热变色' } },
  // 画脸 → 转身 → 合体（眼珠跟随 + 按键回头）
  spin: { id: 'spin', title: '会转身的小黄', example: 'spin', checkpoints: ['spin-1', 'spin-2', '07-spin'], card: { chip: 'ESP32-S3', blurb: '舵机转台加圆屏表情，按下按键后转身面向你' } },
  // 眼睛 + 眨眼 → 按键换表情 → 合体（四种表情循环）
  lens: { id: 'lens', title: '透镜里的小人', example: 'lens', checkpoints: ['lens-1', 'lens-2', '07-lens'], card: { chip: 'ESP32-S3', blurb: '凸透镜放大圆屏表情，按键切换表情' } },
  // 枚举成功 → 按键发字母 → 合体（宏键 + 装壳）。P2-12
  usbkey: { id: 'usbkey', title: 'USB 小键盘', example: 'usbkey', checkpoints: ['usbkey-1', 'usbkey-2', 'usbkey-3'], card: { chip: 'ESP32-S3', blurb: '四键 USB 键盘：三个字母键加一个宏键，一键输入整句' } },
  // P2-09 新作品：每条线都是"零件单独跑通 → 第二样东西 → 合体（带装配）"
  // 灯带点亮 → 旋钮读数 → 合体（旋钮调亮度 / 颜色，按下切换）
  lamp: { id: 'lamp', title: '旋钮台灯', example: 'lamp', checkpoints: ['lamp-1', 'lamp-2', 'lamp-3'], card: { chip: 'ESP32-S3', blurb: '旋钮调亮度，按下切换调色；8 颗 WS2812 灯珠' } },
  // 测距打印 → OLED 显示 → 合体（越近蜂鸣器越急）
  ruler: { id: 'ruler', title: '超声波尺子', example: 'ruler', checkpoints: ['ruler-1', 'ruler-2', 'ruler-3'], card: { chip: 'ESP32-S3', blurb: '超声波测距，屏幕展示结果，蜂鸣器随距离快慢变化' } },
  // 读姿态 → 圆屏画小豆 → 合体（倾斜时小豆往低处滑）
  tilt: { id: 'tilt', title: '体感小人', example: 'tilt', checkpoints: ['tilt-1', 'tilt-2', 'tilt-3'], card: { chip: 'ESP32-S3', blurb: '小豆跟着屏幕歪斜方向运动' } },
  // P2-01 / P2-04 的外设实验台（没有检查点；对应作品是上面的旋钮台灯、超声波尺子）
  knob: { id: 'knob', title: '旋钮计数（编码器和 PCNT）', example: 's3-encoder', checkpoints: [] },
  sonar: { id: 'sonar', title: '超声波测距（HC-SR04，RMT 接收）', example: 's3-ultrasonic', checkpoints: [] },
  blank: { id: 'blank', title: '空白', example: null, checkpoints: [] },
  // P2-03 / P2-02 的外设台面（不是完整作品：没有检查点、组装模板；对应作品是上面的体感小人）
  imu: { id: 'imu', title: '倾角仪（MPU6050）', example: 's3-imu', checkpoints: [] },
  touch: { id: 'touch', title: '触摸圆屏（CST816S）', example: 's3-touch', checkpoints: [] },
};

/** 作品数据在 localStorage 里的键 */
export const wkey = (w: WorkDef) => w.key ?? w.id;

/** 首页上的作品（有卡片的），按定义顺序 */
export const HOME_WORKS = Object.values(WORKS).filter((w) => w.card);
