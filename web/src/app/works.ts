// 作品定义：每个作品走哪几个检查点（firmware/levels.json 的关卡 id）、首页卡片上写什么。
// 单独成文件，首页（home.ts）也读它来生成作品卡、显示检查点数，不必拉进整套实验台代码：加一个作品只要在这里加一项。
// 原则：每过一个检查点作品就多一样东西；最后一个带装配（assembly）的检查点是"合体"。
import type { WorkDef } from './types';

export const WORKS: Record<string, WorkDef> = {
  weather: { id: 'weather', title: '桌面气象站', example: 'weather', checkpoints: ['01', '02', '03', '04', '05', '06'], card: { chip: 'ESP32-S3', blurb: '屏幕显示温度、湿度、气压，舵机表盘指着温度，彩灯按冷热变色。' } },
  // 画脸 → 转身 → 合体（眼珠跟随 + 按键回头）
  spin: { id: 'spin', title: '会转身的小黄', example: 'spin', checkpoints: ['spin-1', 'spin-2', '07-spin'], card: { chip: 'ESP32-S3', blurb: '站在舵机转台上，圆屏当脸；按一下按键它转过来看你。' } },
  // 眼睛 + 眨眼 → 按键换表情 → 合体（四种表情循环）
  lens: { id: 'lens', title: '透镜里的小人', example: 'lens', checkpoints: ['lens-1', 'lens-2', '07-lens'], card: { chip: 'ESP32-S3', blurb: '圆屏上的表情被凸透镜罩放大，看起来像立在罩子里；按键换表情。' } },
  // 枚举成功 → 按键发字母 → 合体（宏键 + 装壳）。P2-12
  usbkey: { id: 'usbkey', title: 'USB 小键盘', example: 'usbkey', checkpoints: ['usbkey-1', 'usbkey-2', 'usbkey-3'], card: { chip: 'ESP32-S3', blurb: '四个键插上电脑就能打字：三个键发 a / b / c，第四个是宏键，一下打出一整句。' } },
  // P2-09 新作品：每条线都是"零件单独跑通 → 第二样东西 → 合体（带装配）"
  // 灯带点亮 → 旋钮读数 → 合体（旋钮调亮度 / 颜色，按下切换）
  lamp: { id: 'lamp', title: '旋钮台灯', example: 'lamp', checkpoints: ['lamp-1', 'lamp-2', 'lamp-3'], card: { chip: 'ESP32-S3', blurb: '转旋钮调亮度，按一下改成换颜色；8 颗 WS2812 藏在乳白灯罩里。' } },
  // 测距打印 → OLED 显示 → 合体（越近蜂鸣器越急）
  ruler: { id: 'ruler', title: '超声波尺子', example: 'ruler', checkpoints: ['ruler-1', 'ruler-2', 'ruler-3'], card: { chip: 'ESP32-S3', blurb: '对着墙一指，屏上显示距离；越近蜂鸣器响得越急，像倒车雷达。' } },
  // 读姿态 → 圆屏画小豆 → 合体（倾斜时小豆往低处滑）
  tilt: { id: 'tilt', title: '体感小人', example: 'tilt', checkpoints: ['tilt-1', 'tilt-2', 'tilt-3'], card: { chip: 'ESP32-S3', blurb: '圆盘往哪边歪，屏上的小豆就往哪边滑；碰到圆边贴着边滑。' } },
  // P2-01 / P2-04 的外设实验台（没有检查点；对应作品是上面的旋钮台灯、超声波尺子）
  knob: { id: 'knob', title: '旋钮计数（编码器 + PCNT）', example: 's3-encoder', checkpoints: [] },
  sonar: { id: 'sonar', title: '超声波测距（HC-SR04 + RMT 接收）', example: 's3-ultrasonic', checkpoints: [] },
  blank: { id: 'blank', title: '空白实验台', example: null, checkpoints: [] },
  // P2-03 / P2-02 的外设台面（不是完整作品：没有检查点、组装模版；对应作品是上面的体感小人）
  imu: { id: 'imu', title: '倾角仪（MPU6050）', example: 's3-imu', checkpoints: [] },
  touch: { id: 'touch', title: '触摸圆屏（CST816S）', example: 's3-touch', checkpoints: [] },
};

/** 首页上的作品（有卡片的），按定义顺序 */
export const HOME_WORKS = Object.values(WORKS).filter((w) => w.card);
